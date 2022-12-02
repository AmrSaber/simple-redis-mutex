const crypto = require('crypto');
const { acquireScript, releaseScript, releaseWithFifoScript, acquireWithFifoScript } = require('./lua');

async function lock(client, lockName, { retryTimeMillis = 100, timeoutMillis, failAfterMillis, fifo = false } = {}) {
  const lockValue = crypto.randomBytes(50).toString('hex');

  const lockKey = `@simple-redis-mutex:lock-${lockName}`;
  const nextIdKey = `@simple-redis-mutex:lock-${lockName}:next-id`;
  const lastOutIdKey = `@simple-redis-mutex:lock-${lockName}:last-out-id`;

  let id;
  if (fifo) {
    id = await client.incr(nextIdKey);
  }

  const acquireLock = new Promise((resolve, reject) => {
    let failTimeoutId = null;
    let attemptTimeoutId = null;

    // Try to acquire the lock, and try again after a while on failure
    function attempt() {
      let script = acquireScript;
      if (fifo) { script = acquireWithFifoScript; }

      // Try to set the lock if it does not exist, else try again later, also set a timeout for the lock so it expires
      client
        .eval(
          script,
          2, lockKey, lastOutIdKey,
          lockValue, timeoutMillis, id,
        )
        .then(response => {
          if (response === 'OK') {
            // Clear failure timer if it was set
            if (failTimeoutId != null) { clearTimeout(failTimeoutId); }
            resolve();
          } else {
            attemptTimeoutId = setTimeout(attempt, retryTimeMillis);
          }
        });
    }

    // Set time out to fail acquiring the lock if it's sent
    if (failAfterMillis != null) {
      failTimeoutId = setTimeout(
        () => {
          if (attemptTimeoutId != null) { clearTimeout(attemptTimeoutId); }

          let releasePromise = Promise.resolve();
          if (fifo) { releasePromise = client.incr(lastOutIdKey); }

          releasePromise.then(() => { reject(new Error(`Lock could not be acquire for ${failAfterMillis} millis`)); });
        },
        failAfterMillis,
      );
    }

    attempt();
  });

  function releaseLock() {
    let script = releaseScript;
    if (fifo) { script = releaseWithFifoScript; }

    // After calling the script, make sure to return void promise.
    return client.eval(script, 2, lockKey, lastOutIdKey, lockValue).then(() => { });
  }

  await acquireLock;

  return releaseLock;
}

module.exports = { lock };

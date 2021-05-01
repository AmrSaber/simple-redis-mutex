const crypto = require('crypto');

/**
 * Acquire mutex lock on the given resource name. If the lock is already acquired, wait until it's free and acquire it.
 *
 * @param {import('ioredis').Redis} client
 * @param {String} lockName
 * @param {Object} [options]
 * @param {Number} [options.retryTimeMillis=100]
 * @param {Number} [options.timeoutMillis]
 * @param {Number} [options.failAfterMillis]
 *
 * @returns {Promise<Function>} release function
 */
async function lock(client, lockName, { retryTimeMillis = 100, timeoutMillis, failAfterMillis } = {}) {
  const lockValue = crypto.randomBytes(50).toString('hex');
  const lockKey = `@simple-redis-mutex:lock-${lockName}`;

  const acquireLock = new Promise((resolve, reject) => {
    let failTimeoutId = null;
    let attemptTimeoutId = null;

    // Try to acquire the lock, and try again after a while on failure
    function attempt() {
      let clientSetPromise;

      if (timeoutMillis != null) {
        clientSetPromise = client.set(lockKey, lockValue, 'NX', 'PX', timeoutMillis);
      } else {
        clientSetPromise = client.set(lockKey, lockValue, 'NX');
      }

      // Try to set the lock if it does not exist, else try again later, also set a timeout for the lock so it expires
      clientSetPromise.then(response => {
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
          reject(new Error(`Lock could not be acquire for ${failAfterMillis} millis`));
        },
        failAfterMillis,
      );
    }

    attempt();
  });

  /**
   * Release the lock only if it has the same lockValue as acquireLock sets it.
   * This will prevent the release of an already released token.
   *
   * @returns {Promise}
   */
  function releaseLock() {
    // Script source: https://redis.io/commands/set#patterns - Redis official docs
    const luaReleaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1]
      then
          return redis.call("del", KEYS[1])
      else
          return 0
      end
    `;

    return client.eval(luaReleaseScript, 1, lockKey, lockValue);
  }

  await acquireLock;

  return releaseLock;
}

module.exports = { lock };

# Simple Redis Lock

Implements mutex lock using redis as described in [redis docs](https://redis.io/commands/set#patterns). The term **simple** is opposed to the more complex **Redlock**, that was also proposed by [redis docs](https://redis.io/topics/distlock) for use in case of distributed redis instances. 

This implementation of redis lock introduces some fine tuning features to the lock such as lock expire time, and acquire retry time, and acquire timeout (all described below).

## Install
Install the package using `npm`.

```bash
npm i simple-redis-lock
```

## Examples
```js
const { lock } = require('simple-redis-lock');
const Redis = require('ioredis');

// Connect to redis using ioredis
redis = new Redis(process.env.REDIS_URI);

async function someFunction() {
  // Acquire the lock, by passing redis client and thee resource name (all settings are optional)
  const unlock = await lock(redis, 'resource-name');
  
  // Do some operations that require mutex lock
  await doSomeCriticalOperations();
  
  // Release the lock
  await unlock();
}
```

## Usage
To acquire the lock you just call the `lock` function exported from the package, and pass to it [ioredis](https://github.com/luin/ioredis) client, and the resource name for the lock. You can also pass any optional options to fine-tune the lock as needed (see API below).

## API
The package exports one named function `lock`, that acquires the lock and returns another function that releases the lock. The API for the `lock` function is as follows ...

`lock(client, lockName, { retryTimeMillis = 100, timeoutMillis, failAfterMillis })`
- **client**: [ioredis](https://www.npmjs.com/package/ioredis) client.
- **lockName**: This is the name of the lock, and this is what distinguishes one lock from another, so that the part that needs mutual exclusion would always require a lock with the same name to be acquired by any process that attempts to enter that part. The key in redis database will be derived from this name.
- **retryTimeMillis**: (default `100`) This defines how much should a process wait before trying to acquire the same lock again, provided time is milliseconds, this time cannot be null.
- **timeoutMillis**: (default `null`) This defines the expiry time of the lock after it's acquired, so after that expiry time another process can acquire the lock even if the current holder did not release it, time provided is in milliseconds, `null` timeout value means that the lock will never expire.
- **failAfterMillis**: (default `null`) This defines the maximum time a process should wait for the lock until it can acquire it, when this time has passes and the process has not acquired the lock yet, the function will throw an Error saying that the lock could not be acquired in the given time, the provided time is in milliseconds, `null` value means that the function will not fail until it has acquired the lock.
- Return type: `Promise<Function>` returns the `unlock` function, that is an async function, and should be called to release the lock.

## Notes
- This package has **Peer Dependency** on [ioredis](https://github.com/luin/ioredis).
- It's taken into account the case that process A acquires the lock, then it expires, then process B acquires the lock. When process A try to release the lock, it will not be released, as it's now acquired by B.
- The same lock can be acquired with different options each time, so one time it can have an expiry time, and the next acquire it can lock indefinitely, the same with all the other options
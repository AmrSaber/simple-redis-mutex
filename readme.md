# Simple Redis Mutex

<p>
  <!-- NPM version badge -->
  <a href="https://www.npmjs.com/package/simple-redis-mutex">
    <img src="https://img.shields.io/npm/v/simple-redis-mutex" alt="version"/>
  </a>

  <!-- Github "Test Main" workflow status -->
  <a href="https://github.com/AmrSaber/simple-redis-mutex/actions">
    <img src="https://github.com/AmrSaber/simple-redis-mutex/workflows/Release/badge.svg?branch=master" alt="Release Status"/>
  </a>

  <!-- Github "Test Dev" workflow status -->
  <a href="https://github.com/AmrSaber/simple-redis-mutex/actions">
    <img src="https://github.com/AmrSaber/simple-redis-mutex/workflows/Test%20Dev/badge.svg?branch=dev" alt="Test Dev Status"/>
  </a>

  <!-- NPM weekly downloads -->
  <a href="https://www.npmjs.com/package/simple-redis-mutex">
    <img src="https://img.shields.io/npm/dw/simple-redis-mutex" alt="weekly downloads"/>
  </a>

  <!-- License -->
  <a href="https://github.com/AmrSaber/simple-redis-mutex/blob/master/LICENSE">
    <img src="https://img.shields.io/npm/l/simple-redis-mutex" alt="license"/>
  </a>
</p>

Implements distributed mutex lock using redis as described in [redis docs](https://redis.io/commands/set#patterns). The term **simple** is opposed to the more complex **Redlock**, that was also proposed by Redis in their [docs](https://redis.io/topics/distlock) for use in case of distributed redis instances.

Locks have timeout (expire time) and fail after options. Also, Redis Pub/Sub is used so that released lock can be immediately acquired by another waiting process instead of depending on polling. Manual polling is still supported though in case lock expires.

## Install

Install the package using `npm`.
```bash
npm i simple-redis-mutex
```

Or with bun
```bash
bun add simple-redis-mutex
```

## Examples

```js
import { lock, tryLock } from 'simple-redis-mutex';
import { createClient, RedisClientType } from 'redis';

// Connect to redis
const redis = await createClient()
  .on('error', (err) => console.log('Redis Client Error', err))
  .connect();

// Using blocking lock
async function someFunction() {
  // Acquire the lock, by passing redis client and the resource name (all settings are optional)
  const release = await lock(redis, 'resource-name');

  // Do some operations that require mutex lock
  await doSomeCriticalOperations({ fencingToken: release.fencingToken! });

  // Release the lock
  await release();
}

// Using tryLock
async function someOtherFunction() {
  const [hasLock, release] = await tryLock(redis, 'resource-name');
  if (!hasLock) return; // Lock is already acquired

  // Do some operations that require mutex lock
  await doSomeCriticalOperations({ fencingToken: release.fencingToken! });

  // Release the lock
  await release();
}
```

## Usage

There are 2 methods to acquire a lock:
- `lock`: which attempts to acquire the lock in a blocking way, if lock is already acquired, it blocks until lock is available.
- `tryLock`: which attempts to acquire the lock, if lock is already acquired it returns immediately.

## API

### `lock`
As per the code:
```typescript
/**
 * Attempts to acquire lock, if lock is already acquired it will block until it can acquire the lock.
 * Returns lock release function.
 *
 * Lock timeout is used to expire the lock if it's not been released before `timeout`.
 * This is to prevent crashed processes holding the lock indefinitely.
 *
 * When a lock is released redis Pub/Sub is used to publish that the lock has been released
 * so that other processes waiting for the lock can attempt to acquire it.
 *
 * Manual polling is also implemented to attempt to acquire the lock in case the holder crashed and did not release the lock.
 * It is controlled by `pollingInterval`.
 *
 * Application logic should not depend on lock timeout and polling interval. They are meant to be a safe net when things fail.
 * Depending on them is inefficient and an anti-pattern, in such case application logic should be revised and refactored.
 *
 * If process fails to acquire the lock before `failAfter` milliseconds, it will throw an error and call `onFail` if provided.
 * If `failAfter` is not provided, process will block indefinitely waiting for the lock to be released.
 *
 * @param redis redis client
 * @param lockName lock name
 * @param options lock options
 * @param options.timeout lock timeout in milliseconds, default: 30 seconds
 * @param options.pollingInterval how long between manual polling for lock status milliseconds, default: 10 seconds
 * @param options.failAfter time to fail after if lock is still not acquired milliseconds
 * @param options.onFail called when failed to acquire lock before `failAfter`
 * @returns release function
 */
function lock(
  redis: RedisClient,
  lockName: string,
  { timeout = DEFAULT_TIMEOUT, pollingInterval = DEFAULT_POLLING_INTERVAL, failAfter, onFail }: LockOptions = {},
): Promise<ReleaseFunc>
```

### `tryLock`
As per the code:
```typescript
/**
 * Try to acquire the lock, if failed will return immediately.
 * Returns whether or not the lock was acquired, and a release function.
 *
 * If the lock was acquired, release function is idempotent,
 * calling it after the first time has no effect.
 *
 * If lock was not acquired, release function is a no-op.
 *
 * @param redis redis client
 * @param lockName lock name
 * @param options lock options
 * @param options.timeout lock timeout in milliseconds, default: 30 seconds
 * @returns whether or not the lock was acquired and release function.
 */
function tryLock(
  redis: RedisClient,
  lockName: string,
  { timeout = DEFAULT_TIMEOUT }: TryLockOptions = {},
): Promise<[boolean, ReleaseFunc]> 
```

### `ReleaseFunc`
```typescript
export type ReleaseFunc = (() => Promise<void>) & { fencingToken?: number };
```

## Notes

### Redis Client
This package has **Peer Dependency** on [redis](https://www.npmjs.com/package/redis), the is the redis client that must be passed to lock functions.

Same client must always be provided within same process, this is because pub/sub depends on the provided client and its lifecycle.

### Lock options
The same lock can be acquired with different options each time, and it can be acquired using `lock` and `tryLock` in different places or under different circumstances (actually `lock` internally uses `tryLock` to acquire the lock). You can mix and match as you see fit, but I recommend always using the same options in same places for more consistency and to make debugging easier.

`timeout` and `pollingInterval` have default value and user is not allowed to provide nullish values for those 2. This is for encouraging best practices. If you really want your lock to lock indefinitely for whatever reason, you can force-pass `null` for `timeout` and disable `pollingInterval` by also passing `null` (note that passing `undefined` will use the default values). Typescript will complain but you can just disable it for that line, something like so...
```typescript
// @ts-ignore
await lock(redis, 'some-lock', { timeout: null, pollingInterval: null });
```
But I really advice against it. If lock-holding process crashes, there is no way to recover that lock other than removing the redis key manually from redis.

### Lock Release
Once a lock is released a pub/sub channel is used to notify any process waiting for the lock. This makes waiting for lock more efficient and removes the need for frequent polling to check the status of the lock.

A dedicated subscriber is created and managed in the background to manage subscribing to the pub/sub channel. It is created as a duplicate of provided redis client, and it stops whenever the provided client stops.

Only one subscriber is created at a time. If the client stops and reconnects for whatever reason, then subscriber will stop with it and will reconnect on next lock use.

### Fencing Token
A fencing token is an increasing number that is used to identify the order at which locks are acquired, and is used for further safety with writes in distributed systems. See "Making the lock safe with fencing" section from [this article](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) for more info about fencing tokens.

If the lock is successfully acquired then a fencing token is sure to be assigned, otherwise no fencing token will be issued if the lock is not acquired.

Fencing tokens can be access from `release` function like `release.fencingToken`, it is undefined only if lock was not acquired.

Fencing tokens are global across all locks issued and not scoped with lock name. Application logic should only depend on the fencing token increasing and not care about the exact value of the token.


### Double Releasing
Once `release` function has been called all following calls are no-op, so same function cannot release the lock again from a different holder.

It's also taken into consideration that an expired lock cannot be released so it does not release the lock from another holder. i.e. if process A acquires the lock, then it expires, then process B acquires the lock. When process A tries to release the lock, it will not be released, as it's now acquired by B.

### Migration from v1.x
Breaking Changes in v2:
- Redis client is now `redis` and not `ioredis`
- options have been renamed:
  - `timeoutMillis` -> `timeout`
  - `retryTimeMillis` -> `pollingInterval` -- and it is now only used for expired locks, other wise pub/sub is used with released locks
  - `failAfterMillis` -> `failAfter`
- FIFO option has been removed: existing implementation was wrong, it failed on lock-holder crash or failing to acquire the lock, and I could not come up with an implementation that would retain the functionality using redis only -- I sincerely apologize to anyone who have used it.
- `timeout` and `pollingInterval` have defaults. Locks are not allowed to lock indefinitely (except with work around mentioned in "Lock Options" section above).

## Contribution
You are welcome to [open a ticket](https://github.com/AmrSaber/simple-redis-mutex/issues) anytime, if you find a bug or have a feature request.

Also feel free to create a PR to **dev** branch for bug fixes or feature suggestions.

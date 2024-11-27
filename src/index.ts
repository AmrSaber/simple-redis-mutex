import { RedisClientType, RedisClusterType } from 'redis';

type RedisClient = RedisClientType<any, any, any> | RedisClusterType<any, any, any>;

type ReleaseCallbackFn = () => void;
type ReleaseCallback = { lockKey: string; callback: ReleaseCallbackFn };

export type ReleaseFunc = () => Promise<void>;
export type TryLockOptions = { timeout?: number };
export type LockOptions = TryLockOptions & {
  pollingInterval?: number;
  failAfter?: number;
  onFail?: () => void;
};

const REDIS_RELEASES_CHANNEL = '@simple-redis-mutex:locks-releases';
const REDIS_OK = 'OK';

export const DEFAULT_TIMEOUT = 30_000;
export const DEFAULT_POLLING_INTERVAL = 10_000;

let callbacks: ReleaseCallback[] = [];

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
export function lock(
  redis: RedisClient,
  lockName: string,
  { timeout = DEFAULT_TIMEOUT, pollingInterval = DEFAULT_POLLING_INTERVAL, failAfter, onFail }: LockOptions = {},
): Promise<ReleaseFunc> {
  return new Promise((resolve, reject) => {
    let pollingId: NodeJS.Timeout | undefined;
    let failId: NodeJS.Timeout | undefined;

    let attempting = true;
    function attempt() {
      if (!attempting) return;

      tryLock(redis, lockName, { timeout }).then(([hasLock, release]) => {
        if (!hasLock) return;

        clean();
        resolve(release);
      });
    }

    function clean() {
      attempting = false;

      // Remove release callback
      callbacks = callbacks.filter((cb) => cb.callback != attempt);

      // Clear timeouts
      if (pollingId != null) clearInterval(pollingId);
      if (failId != null) clearTimeout(failId);

      pollingId = failId = undefined;
    }

    callbacks.push({ lockKey: getLockKey(lockName), callback: attempt });
    if (pollingInterval != null) pollingId = setInterval(attempt, pollingInterval);

    if (failAfter != null) {
      failId = setTimeout(() => {
        clean();
        onFail?.();
        reject(new Error(`Lock "${lockName}" could not be acquired after ${failAfter} millis`));
      }, failAfter);
    }

    attempt();
  });
}

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
export async function tryLock(
  redis: RedisClient,
  lockName: string,
  { timeout = DEFAULT_TIMEOUT }: TryLockOptions = {},
): Promise<[boolean, ReleaseFunc]> {
  const lockKey = getLockKey(lockName);
  const lockValue = String(Math.random());

  await listenForUpdates(redis);

  const result = await redis.set(lockKey, lockValue, {
    NX: true,
    PX: timeout,
  });

  if (result != REDIS_OK) return [false, async () => {}];

  let released = false;
  async function release() {
    if (released) return;
    released = true;

    await redis
      .eval(releaseScript, {
        keys: [lockKey, REDIS_RELEASES_CHANNEL],
        arguments: [lockValue],
      })
      .catch((err) => console.error(`Error releasing lock ${lockName}:`, err));
  }

  return [true, release];
}

let subscriber: RedisClient | undefined;
async function listenForUpdates(redis: RedisClient) {
  // Make sure only one subscriber is created
  if (subscriber != null && subscriber.isOpen) return;

  subscriber = redis.duplicate();
  subscriber.on('error', (err) => console.error('simple-redis-mutex subscriber error:', err));
  await subscriber.connect();

  await subscriber.subscribe(REDIS_RELEASES_CHANNEL, async (message: string) => {
    const releasedLock: { key: string; value: string } = JSON.parse(message);

    // Find related callback functions
    const relatedCallbacks = callbacks.filter((cb) => cb.lockKey == releasedLock.key);

    // Run all callbacks
    await Promise.all(relatedCallbacks.map((cb) => Promise.resolve(cb.callback())));
  });

  redis.on('end', async () => {
    await subscriber?.unsubscribe(REDIS_RELEASES_CHANNEL);
    await subscriber?.quit();
    subscriber = undefined;
  });
}

function getLockKey(lockName: string): string {
  return `@simple-redis-mutex:lock-${lockName}`;
}

/**
 * Release the lock only if it has the same lockValue as acquireLock sets it.
 * This will prevent the release of an already released lock.
 *
 * Script source: https://redis.io/commands/set#patterns -- Redis official docs + with small changes
 */
const releaseScript = `
  local lockKey = KEYS[1]
  local updatesChannel = KEYS[2]
  local lockValue = ARGV[1]

  if redis.call("GET", lockKey) == lockValue then
      redis.call("DEL", lockKey)
      redis.call(
        "PUBLISH",
        updatesChannel,
        string.format('{ "key": "%s", "value": "%s" }', lockKey, lockValue)
      )
  end
`;

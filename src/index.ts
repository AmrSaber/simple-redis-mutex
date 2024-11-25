import { RedisClientType, RedisClusterType } from 'redis';
import { releaseScript } from './lua';

type RedisClient = RedisClientType<any, any, any> | RedisClusterType<any, any, any>;

type ReleaseCallbackFn = () => unknown;
type ReleaseCallback = { lockKey: string; callback: ReleaseCallbackFn };

export type ReleaseFunc = () => Promise<void>;
export type TryLockParams = {
  timeout?: number;
};

const REDIS_UPDATE_CHANNEL = '@simple-redis-mutex:locks-releases';
const REDIS_OK = 'OK';

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
 * @param lockName Lock name
 * @param options Lock options
 * @param options.timeout Lock timeout in milliseconds, default: 30 seconds
 * @returns
 */
export async function tryLock(
  redis: RedisClient,
  lockName: string,
  { timeout = 30_000 }: TryLockParams = {},
): Promise<[boolean, ReleaseFunc]> {
  const lockKey = `@simple-redis-mutex:lock-${lockName}`;
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
        keys: [lockKey, REDIS_UPDATE_CHANNEL],
        arguments: [lockValue],
      })
      .catch((err) => console.error(`Error releasing lock ${lockName}:`, err));
  }

  return [true, release];
}

let listening = false;
async function listenForUpdates(redis: RedisClient) {
  if (listening) return;
  listening = true;

  const subscriber = redis.duplicate();
  subscriber.on('error', (err) => console.error('simple-redis-mutex subscriber error:', err));
  await subscriber.connect();

  await subscriber.subscribe(REDIS_UPDATE_CHANNEL, async (message: string) => {
    const releasedLock: { key: string; value: string } = JSON.parse(message);

    // Find related callback functions and remove them from callbacks
    const relatedCallbacks = callbacks.filter((cb) => cb.lockKey == releasedLock.key);
    callbacks = callbacks.filter((cb) => cb.lockKey != releasedLock.key);

    // Run all callbacks
    await Promise.all(relatedCallbacks.map((cb) => Promise.resolve(cb.callback())));
  });

  redis.on('end', async () => {
    await subscriber.unsubscribe(REDIS_UPDATE_CHANNEL);
    await subscriber.quit();
  });
}

let callbacks: ReleaseCallback[] = [];
function addReleaseCallback(lockKey: string, callbackFn: ReleaseCallbackFn) {
  callbacks.push({ lockKey, callback: callbackFn });
}

// FIXME: is this needed?
function removeReleaseCallback(lockKey: string, callbackFn: ReleaseCallbackFn) {
  callbacks = callbacks.filter((cb) => !(cb.lockKey == lockKey && cb.callback == callbackFn));
}

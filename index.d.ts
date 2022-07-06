import { Redis, Cluster } from 'ioredis';

/**
 * Release the lock only if it has the same lockValue as acquireLock sets it.
 * This will not release an already released token.
 */
type ReleaseFunction = () => Promise<void>;

interface acquireOptions {
  /**
   * Time interval at which attempt to acquire the lock.
   *
   * @default 100
   */
  retryTimeMillis?: number;

  /**
   * Time span after which the acquired lock times out and is released.
   */
  timeoutMillis?: number;

  /**
   * Time span after which will not attempt to acquire the lock, and the `lock` function will fail.
   */
  failAfterMillis?: number;
}

/**
 * Acquire mutex lock on the given resource name.
 * If the lock is already acquired, wait until it's free and acquire it.
 *
 * @param client ioredis instance.
 * @param lockName the name of the lock to be acquired.
 * @param options lock acquire options.
 *
 * @returns a promise that resolves with release function.
 */
export function lock(
  client: Redis | Cluster,
  lockName: string,
  options: acquireOptions
): Promise<ReleaseFunction>;

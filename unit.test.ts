import delay from 'delay';
import { createClient, RedisClientType } from 'redis';
import { tryLock } from './src';

describe('Lock tests', () => {
  let redis: RedisClientType<any, any, any>;
  const lockName = '_test_lock';

  beforeAll(async () => {
    redis = await createClient()
      .on('error', (err) => console.log('Redis Client Error', err))
      .connect();
  });

  afterAll(async () => {
    await redis.quit();
  });

  afterEach(async () => {
    await redis.flushDb();
  });

  describe('tryLock', () => {
    test('it acquires the lock successfully', async () => {
      let [hasLock, release] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(true);

      [hasLock] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(false);

      await release();
    });

    test('no race conditions', async () => {
      let count = 0;
      async function safeIncrement() {
        const [hasLock, release] = await tryLock(redis, lockName);
        if (!hasLock) return;
        await delay(50);
        count = count + 1;
        await release();
      }

      await Promise.all(new Array(100).fill(null).map(safeIncrement));
      expect(count).toEqual(1);
    });

    test('lock expiration', async () => {
      const [hasLock] = await tryLock(redis, lockName, { timeout: 50 });
      expect(hasLock).toEqual(true);

      const [secondCall] = await tryLock(redis, lockName);
      expect(secondCall).toEqual(false);

      await delay(100);

      const [afterTimeout] = await tryLock(redis, lockName);
      expect(afterTimeout).toEqual(true);
    });

    test('expired owner cannot release the lock', async () => {
      let [hasLock, expiredRelease] = await tryLock(redis, lockName, {
        timeout: 50,
      });
      expect(hasLock).toEqual(true);

      let [failedLock, failedRelease] = await tryLock(redis, lockName, { timeout: 50 });
      expect(failedLock).toEqual(false);
      await failedRelease();

      await delay(100);

      let [afterTimeout, release] = await tryLock(redis, lockName, { timeout: 50 });
      expect(afterTimeout).toEqual(true);

      await expiredRelease();

      [hasLock] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(false);

      await release();

      [hasLock, release] = await tryLock(redis, lockName, { timeout: 50 });
      expect(hasLock).toEqual(true);
      await release();
    });
  });
});

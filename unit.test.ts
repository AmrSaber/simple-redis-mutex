import { createClient, RedisClientType } from 'redis';
import { lock, LockOptions, tryLock, TryLockOptions } from './src';

describe('Lock tests', () => {
  let redis: RedisClientType<any, any, any, any>;
  const lockName = '_test_lock';

  function sleep(millis?: number): Promise<void> {
    return new Promise((res) => setTimeout(res, millis));
  }

  beforeAll(async () => {
    redis = await createClient({ url: process.env.REDIS_URI })
      .on('error', (err) => console.error('Redis Client Error', err))
      .connect();

    await redis.select(7); // So that main db is not updated and later flushed
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

      expect(release.fencingToken).toBeDefined();
      expect(release.fencingToken).toBeGreaterThan(0);

      [hasLock, release] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(false);

      expect(release.fencingToken).toEqual(-1);
    });

    test('release works without script cache', async () => {
      const scriptLoad = redis.scriptLoad;
      // @ts-ignore
      redis.scriptLoad = null;

      let [hasLock, release] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(true);

      await release();

      [hasLock, release] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(true);

      // @ts-ignore
      redis.scriptLoad = scriptLoad;
    });

    test('it issues monotonic fencing tokens', async () => {
      let lastToken: number | null = null;

      for (let i = 0; i < 25; i++) {
        let [hasLock, release] = await tryLock(redis, lockName);
        expect(hasLock).toEqual(true);
        await release();

        if (lastToken != null) expect(lastToken).toBeLessThan(release.fencingToken);
        lastToken = release.fencingToken;
      }
    });

    test('it works when script is flushed', async () => {
      let [hasLock, release] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(true);
      await release();

      [hasLock, release] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(true);

      await redis.scriptFlush();

      [hasLock] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(false);

      await release();

      [hasLock] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(true);
    });

    test('no race conditions', async () => {
      let count = 0;
      async function safeIncrement() {
        const [hasLock, release] = await tryLock(redis, lockName);
        if (!hasLock) return;

        await sleep(50);
        count = count + 1;

        await release();
      }

      await Promise.all(new Array(20).fill(0).map(safeIncrement));
      expect(count).toEqual(1);
    });

    test('lock expiration', async () => {
      const options: TryLockOptions = { timeout: 25 };

      let [hasLock, release] = await tryLock(redis, lockName, options);
      expect(hasLock).toEqual(true);

      [hasLock] = await tryLock(redis, lockName, options);
      expect(hasLock).toEqual(false);

      await sleep(30);

      [hasLock] = await tryLock(redis, lockName, options);
      expect(hasLock).toEqual(true);

      await sleep(10);
      await release.refreshTimeout(); // should has no effect
      await sleep(20);

      [hasLock] = await tryLock(redis, lockName, options);
      expect(hasLock).toEqual(true);
    });

    test('expired owner cannot release the lock', async () => {
      const options: TryLockOptions = { timeout: 50 };

      let [hasLock, expiredRelease] = await tryLock(redis, lockName, options);
      expect(hasLock).toEqual(true);

      let [failedLock, failedRelease] = await tryLock(redis, lockName, options);
      expect(failedLock).toEqual(false);
      await failedRelease();

      await sleep(55);

      let [afterTimeout, release] = await tryLock(redis, lockName, options);
      expect(afterTimeout).toEqual(true);

      await expiredRelease();

      [hasLock] = await tryLock(redis, lockName, options);
      expect(hasLock).toEqual(false);

      await release();

      [hasLock, release] = await tryLock(redis, lockName, options);
      expect(hasLock).toEqual(true);
      await release();
    });

    test('refresh expire', async () => {
      const [, release] = await tryLock(redis, lockName, { timeout: 50 });

      await sleep(35);
      await release.refreshTimeout();

      let [hasLock] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(false);

      await sleep(35);
      await release.refreshTimeout();

      [hasLock] = await tryLock(redis, lockName);
      expect(hasLock).toEqual(false);
    });
  });

  describe('lock', () => {
    describe('locking functionality', () => {
      let counter = 0;
      const increments = 20;

      async function unsafeIncrement() {
        await sleep();
        const counterValue = counter;

        await sleep();
        counter = counterValue + 1;
      }

      test('unsafe function has race condition', async () => {
        counter = 0;
        await Promise.all(new Array(increments).fill(0).map(unsafeIncrement));
        expect(counter).not.toEqual(increments);
      });

      test('locks solve race conditions', async () => {
        counter = 0;

        await Promise.all(
          new Array(increments).fill(0).map(async () => {
            const release = await lock(redis, lockName);
            await unsafeIncrement();
            await release();
          }),
        );

        expect(counter).toEqual(increments);
      });

      test('lock is acquired as soon as it is released', async () => {
        const options: LockOptions = { pollingInterval: 60_000 };

        let release = await lock(redis, lockName, options);

        const startTime = Date.now();
        [, release] = await Promise.all([release(), lock(redis, lockName, options)]);

        const timeTaken = Date.now() - startTime;
        expect(timeTaken).toBeLessThan(5);

        const [hasLock] = await tryLock(redis, lockName);
        expect(hasLock).toEqual(false);

        await release();
      });
    });

    describe('options', () => {
      test('timeout and polling', async () => {
        const startTime = Date.now();
        await lock(redis, lockName, { timeout: 50 });
        const release = await lock(redis, lockName, { pollingInterval: 25 });
        const timeTaken = Date.now() - startTime;

        await release();

        expect(timeTaken).toBeGreaterThanOrEqual(50);
        expect(timeTaken).toBeLessThanOrEqual(100);
      });

      test('failAfter and onFail', async () => {
        const release = await lock(redis, lockName);

        const onFail = jest.fn();
        const startTime = Date.now();
        let timeTaken;

        try {
          await lock(redis, lockName, { failAfter: 50, pollingInterval: 25, onFail });
          fail('lock did not fail'); // eslint-disable-line no-undef
        } catch (err) {
          expect((err as Error).message).toContain(`"${lockName}"`);
          timeTaken = Date.now() - startTime;
        }

        expect(timeTaken).toBeGreaterThanOrEqual(50);
        expect(timeTaken).toBeLessThanOrEqual(100);
        expect(onFail).toBeCalledTimes(1);

        await release();
        await sleep(500);

        // Assert that the lock function is no longer attempting to acquire the lock asynchronously
        const [hasLock] = await tryLock(redis, lockName);
        expect(hasLock).toEqual(true);
      });
    });
  });
});

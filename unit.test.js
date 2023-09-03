/* eslint-disable no-await-in-loop */
const delay = require('delay');
const faker = require('faker');
const Redis = require('ioredis');

const { lock } = require('.');

describe('Lock tests', () => {
  /**
   * @type {import('ioredis').Redis}
   */
  let redis;

  // If REDIS_URI variable is null, will default to localhost
  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URI);
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  afterAll(() => {
    redis.disconnect();
  });

  describe('Locking functionality', () => {
    let counter = 0;

    async function unsafeIncrement() {
      await delay(faker.datatype.number({ min: 10, max: 50 }));
      const counterValue = counter;

      await delay(faker.datatype.number({ min: 10, max: 50 }));
      counter = counterValue + 1;
    }

    test('The unsafe function has race condition', async () => {
      counter = 0;
      await Promise.all(new Array(20).fill(0).map(unsafeIncrement));
      expect(counter).not.toEqual(20);
    });

    test('Locks handle race conditions', async () => {
      counter = 0;

      await Promise.all(
        new Array(20).fill(0).map(async () => {
          const unlock = await lock(redis, 'test');
          await unsafeIncrement();
          await unlock();
        }),
      );

      expect(counter).toEqual(20);
    });
  });

  describe('options', () => {
    test('timeout', async () => {
      const lockName = 'timeout-test';

      const timeBeforeLock = new Date().valueOf();
      await lock(redis, lockName, { timeoutMillis: 200 });
      const unlock = await lock(redis, lockName);
      const timeAfterLock = new Date().valueOf();

      await unlock();

      expect(timeAfterLock - timeBeforeLock).toBeGreaterThanOrEqual(200);
      expect(timeAfterLock - timeBeforeLock).toBeLessThanOrEqual(220);
    });

    test('retry time', async () => {
      const lockName = 'retry-test';

      await lock(redis, lockName, { timeoutMillis: 20 });

      const timeBeforeLock = new Date().valueOf();
      const unlock = await lock(redis, lockName, { retryTimeMillis: 200 });
      const timeAfterLock = new Date().valueOf();

      await unlock();

      expect(timeAfterLock - timeBeforeLock).toBeGreaterThanOrEqual(200);
      expect(timeAfterLock - timeBeforeLock).toBeLessThanOrEqual(220);
    });

    test('fail time', async () => {
      const lockName = 'fail-test';

      const unlock = await lock(redis, lockName);

      const timeBeforeLock = new Date().valueOf();
      let timeAfterLock;

      try {
        await lock(redis, lockName, { failAfterMillis: 200 });
        fail('Lock did not fail'); // eslint-disable-line no-undef
      } catch (err) {
        expect(err.message).toContain(`"${lockName}"`);
        timeAfterLock = new Date().valueOf();
      }

      await unlock();

      expect(timeAfterLock - timeBeforeLock).toBeGreaterThanOrEqual(200);
      expect(timeAfterLock - timeBeforeLock).toBeLessThanOrEqual(220);

      await delay(1000);

      // Assert that the lock function is no longer attempting to acquire the lock asynchronously
      const lockValue = await redis.get('@simple-redis-mutex:lock-fail-test');
      expect(lockValue).toBeNull();
    });
  });

  describe('fifo', () => {
    let elements = [];

    async function unsafeAppend(withLock = false) {
      const push = async (index) => {
        await delay(faker.datatype.number({ min: 10, max: 50 }));
        elements.push(index);
      };

      const lockName = 'push-lock';

      const promises = [];

      for (let i = 0; i < 20; i++) {
        await delay(5);

        let pushPromise = Promise.resolve();
        if (withLock) {
          // eslint-disable-next-line no-loop-func
          pushPromise = new Promise((resolve) => {
            lock(redis, lockName, { fifo: true })
              .then((unlock) => push(i).then(() => unlock()))
              .then(resolve);
          });
        } else {
          pushPromise = push(i);
        }

        promises.push(pushPromise);
      }

      await Promise.all(promises);
    }

    function isConsecutive(arr) {
      for (let i = 1; i < arr.length; i++) {
        if (arr[i - 1] > arr[i]) {
          return false;
        }
      }

      return true;
    }

    test('unsafeAppend is unsafe', async () => {
      elements = [];
      await unsafeAppend();
      expect(isConsecutive(elements)).toBe(false);
    });

    test('FIFO lock works', async () => {
      elements = [];
      await unsafeAppend(true);
      expect(isConsecutive(elements)).toBe(true);
    });
  });
});

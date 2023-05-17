import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  map as bufferAsyncIterable,
} from '../index.js';

import {
  isAsyncGenerator,
  promisableTimeout,
  yieldValuesOverTime,
  yieldValuesOverTimeWithPrefix,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

chai.should();

describe('bufferAsyncIterable() values', () => {
  const count = 6;

  /** @type {import('sinon').SinonFakeTimers} */
  let clock;
  /** @type {AsyncIterable<number>} */
  let baseAsyncIterable;
  /** @type {number[]} */
  let expectedResult;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);

    expectedResult = [];
    for (let i = 0; i < count; i++) {
      expectedResult.push(i);
    }
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('main', () => {
    it('should return all values from the original AsyncIterable when looped over ', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {number[]} */
        const rawResult = [];

        for await (const value of bufferAsyncIterable(baseAsyncIterable, async (item) => item)) {
          rawResult.push(value);
        }

        /** @type {[number[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.deep.equal(expectedResult);
      duration.should.equal(6300);
    });

    it('should return all values from the original AsyncIterable when accessed directly', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        const asyncIterable = bufferAsyncIterable(baseAsyncIterable, async (item) => item);
        const asyncIterator = asyncIterable[Symbol.asyncIterator]();

        /** @type {Promise<IteratorResult<number, void>>[]} */
        const iterations = [];

        for (let i = 0; i < count; i++) {
          iterations.push(asyncIterator.next());
        }

        const rawResult = await Promise.all(iterations);

        /** @type {[(number|void)[], number]} */
        const result = [
          rawResult.map(item => item.value),
          Date.now(),
        ];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.deep.equal(expectedResult);
      duration.should.equal(4300);
    });
  });

  it('should return all values from the original AsyncIterable when given as an array', async () => {
    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {number[]} */
      const rawResult = [];

      let i = 0;

      for await (const value of bufferAsyncIterable([10, 20, 30], async (item) => {
        await promisableTimeout(i++ % 2 === 1 ? 2000 : 100);
        return item;
      })) {
        rawResult.push(value);
      }

      /** @type {[number[], number]} */
      const result = [rawResult, Date.now()];

      return result;
    })();

    await clock.runAllAsync();

    const [result, duration] = await promisedResult;

    result.should.deep.equal([10, 30, 20]);
    duration.should.equal(2000);
  });

  it('should handle chained async generator values from the original AsyncIterable when looped over', async () => {
    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {string[]} */
      const rawResult = [];

      for await (const value of bufferAsyncIterable(baseAsyncIterable, async function * (item) {
        yield * yieldValuesOverTimeWithPrefix(2, (i) => i % 2 === 1 ? 2000 : 100, 'prefix-' + item + '-');
      })) {
        rawResult.push(value);
      }

      /** @type {[string[], number]} */
      const result = [rawResult, Date.now()];

      return result;
    })();

    await clock.runAllAsync();

    const [result, duration] = await promisedResult;

    result.should.be.an('array').of.length(12).with.members([
      'prefix-0-0',
      'prefix-0-1',
      'prefix-1-0',
      'prefix-1-1',
      'prefix-2-0',
      'prefix-2-1',
      'prefix-3-0',
      'prefix-3-1',
      'prefix-4-0',
      'prefix-4-1',
      'prefix-5-0',
      'prefix-5-1',
    ]);

    duration.should.equal(6400);
  });

  it('should leave nested async generators unless told to care', async () => {
    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {AsyncIterable<string>[]} */
      const rawResult = [];

      for await (const value of bufferAsyncIterable(baseAsyncIterable, async function * (item) {
        yield yieldValuesOverTimeWithPrefix(2, (i) => i % 2 === 1 ? 2000 : 100, 'prefix-' + item + '-');
      })) {
        rawResult.push(value);
      }

      /** @type {[AsyncIterable<string>[], number]} */
      const result = [rawResult, Date.now()];

      return result;
    })();

    await clock.runAllAsync();

    const [result, duration] = await promisedResult;

    result.should.be.an('array').of.length(6).which.containAll(item => isAsyncGenerator(item));
    duration.should.equal(6300);
  });

  it('should leave async generator return values alone', async () => {
    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {AsyncIterable<string>[]} */
      const rawResult = [];

      for await (const value of bufferAsyncIterable(baseAsyncIterable, async function (item) {
        return yieldValuesOverTimeWithPrefix(2, (i) => i % 2 === 1 ? 2000 : 100, 'prefix-' + item + '-');
      })) {
        rawResult.push(value);
      }

      /** @type {[AsyncIterable<string>[], number]} */
      const result = [rawResult, Date.now()];

      return result;
    })();

    await clock.runAllAsync();

    const [result, duration] = await promisedResult;

    result.should.be.an('array').of.length(6).which.containAll(item => isAsyncGenerator(item));
    duration.should.equal(6300);
  });

  it('should return all values from the original AsyncIterable when chained to itself', async () => {
    const chainedBufferedAsyncIterable = bufferAsyncIterable(baseAsyncIterable, async (item) => item);

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {number[]} */
      const rawResult = [];

      for await (const value of bufferAsyncIterable(chainedBufferedAsyncIterable, async (item) => item)) {
        rawResult.push(value);
      }

      /** @type {[number[], number]} */
      const result = [rawResult, Date.now()];

      return result;
    })();

    await clock.runAllAsync();

    const [result, duration] = await promisedResult;

    result.should.deep.equal(expectedResult);
    duration.should.equal(6300);
  });

  describe('buffering', () => {
    it('should return all values from the original AsyncIterable when looped over ', async () => {
      const count = 20;

      baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);

      expectedResult = [];
      for (let i = 0; i < count; i++) {
        expectedResult.push(i);
      }

      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {number[]} */
        const rawResult = [];

        for await (const value of bufferAsyncIterable(baseAsyncIterable, async (item) => {
          const delay = item % 3 === 0 ? 100000 : 100;
          await promisableTimeout(delay);
          return item;
        }, { queueSize: 3 })) {
          rawResult.push(value);
        }

        /** @type {[number[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.have.all.members(expectedResult).and.be.of.length(count);
      duration.should.equal(306600);
    });

    it('should not lose any values if paused', async () => {
      const count = 20;

      baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);

      expectedResult = [];
      for (let i = 0; i < count; i++) {
        expectedResult.push(i);
      }

      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {number[]} */
        const rawResult = [];

        for await (const value of bufferAsyncIterable(baseAsyncIterable, async (item) => {
          const delay = item % 3 === 0 ? 100000 : 100;
          await promisableTimeout(delay);
          return item;
        }, { queueSize: 3 })) {
          rawResult.push(value);
          if (value % 5 === 0) {
            await promisableTimeout(20000);
          }
        }

        /** @type {[number[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      for (let i = 0; i < 10000; i++) {
        await clock.tickAsync(100);
      }
      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.have.all.members(expectedResult).and.be.of.length(count);
      duration.should.equal(306600 + 20000 - 200);
    });
  });

  it('should return the value sent to it');

  it('should be able to return the values in order');

  it('should provide an AbortController in the map callback');
});

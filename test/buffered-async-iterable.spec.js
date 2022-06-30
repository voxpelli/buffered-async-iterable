import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  map as bufferAsyncIterable,
} from '../index.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

const should = chai.should();

/**
 * @param {number} delay
 * @returns {Promise<void>}
 */
// eslint-disable-next-line unicorn/consistent-function-scoping
const promisableTimeout = (delay) => new Promise(resolve => setTimeout(resolve, delay));

/**
 * @param {number} count
 * @param {number|((i: number) => number)} wait
 * @returns {AsyncIterable<number>}
 */
async function * yieldValuesOverTime (count, wait) {
  const waitCallback = typeof wait === 'number' ? () => wait : wait;
  for (let i = 0; i < count; i++) {
    yield i;
    await promisableTimeout(waitCallback(i));
  }
}

/**
 * @param {number} count
 * @param {number|((i: number) => number)} wait
 * @param {string} prefix
 * @returns {AsyncIterable<string>}
 */
async function * yieldValuesOverTimeWithPrefix (count, wait, prefix) {
  const waitCallback = typeof wait === 'number' ? () => wait : wait;
  for (let i = 0; i < count; i++) {
    yield prefix + i;
    await promisableTimeout(waitCallback(i));
  }
}

describe('bufferAsyncIterable()', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('basic', () => {
    it('should throw on falsy asyncIterable argument', () => {
      should.Throw(() => {
        // @ts-ignore
        // eslint-disable-next-line no-unused-vars, no-empty
        bufferAsyncIterable();
      }, TypeError, 'Expected input to be provided');
    });

    it('should throw when provided asyncIterable is not an asyncIterable', () => {
      should.Throw(() => {
        // @ts-ignore
        // eslint-disable-next-line no-unused-vars, no-empty
        bufferAsyncIterable(true);
      }, TypeError, 'Expected asyncIterable to have a Symbol.asyncIterator function');
    });

    it('should throw when provided callback is not a function', () => {
      should.Throw(() => {
        const asyncIterable = (async function * () {})();
        bufferAsyncIterable(
          asyncIterable,
          // @ts-ignore
          { queueSize: true }
        );
      }, TypeError, 'Expected callback to be a function');
    });

    it('should throw when provided size is not a number', () => {
      should.Throw(() => {
        const asyncIterable = (async function * () {})();
        bufferAsyncIterable(
          asyncIterable,
          async () => {},
          // @ts-ignore
          { queueSize: true }
        );
      }, TypeError, 'Expected queueSize to be a number');
    });

    it('should return an AsyncIterable when provided with required arguments', () => {
      const asyncIterable = (async function * () {})();
      const bufferedAsyncIterable = bufferAsyncIterable(
        asyncIterable,
        async () => {}
      );

      should.exist(bufferedAsyncIterable);
      bufferedAsyncIterable.should.be.an('object');

      should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
      bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
    });

    it('should return an AsyncIterable when provided with all arguments', () => {
      const asyncIterable = (async function * () {})();
      const bufferedAsyncIterable = bufferAsyncIterable(
        asyncIterable,
        async () => {},
        { queueSize: 10 }
      );

      should.exist(bufferedAsyncIterable);
      bufferedAsyncIterable.should.be.an('object');

      should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
      bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
    });

    it('should return an AsyncIterable when provided with an array value', () => {
      const bufferedAsyncIterable = bufferAsyncIterable(
        ['a', 'b', 'c'],
        async () => {}
      );

      should.exist(bufferedAsyncIterable);
      bufferedAsyncIterable.should.be.an('object');

      should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
      bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
    });

    it('should return an AsyncIterable when provided with a Set value', () => {
      const bufferedAsyncIterable = bufferAsyncIterable(
        new Set(['a', 'b', 'c']),
        async () => {}
      );

      should.exist(bufferedAsyncIterable);
      bufferedAsyncIterable.should.be.an('object');

      should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
      bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
    });
  });

  describe('values', () => {
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

    describe('test the test utility: yieldValuesOverTime()', () => {
      it('should return all values when looped over ', async () => {
        // Create the promise first, then have it be fully executed using clock.runAllAsync()
        const promisedResult = (async () => {
          const rawResult = [];

          for await (const value of baseAsyncIterable) {
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

      it('should return all values when accessed directly ', async () => {
        // Create the promise first, then have it be fully executed using clock.runAllAsync()
        const promisedResult = (async () => {
          const asyncIterator = baseAsyncIterable[Symbol.asyncIterator]();

          /** @type {Promise<IteratorResult<number>>[]} */
          const iterations = [];

          for (let i = 0; i < count; i++) {
            iterations.push(asyncIterator.next());
          }

          const rawResult = await Promise.all(iterations);

          /** @type {[number[], number]} */
          const result = [
            rawResult.map(item => item.value),
            Date.now()
          ];

          return result;
        })();

        await clock.runAllAsync();

        const [result, duration] = await promisedResult;

        result.should.deep.equal(expectedResult);
        duration.should.equal(4300);
      });
    });

    describe('main', () => {
      it('should return all values from the original AsyncIterable when looped over ', async () => {
        // Create the promise first, then have it be fully executed using clock.runAllAsync()
        const promisedResult = (async () => {
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

          /** @type {Promise<IteratorResult<number>>[]} */
          const iterations = [];

          for (let i = 0; i < count; i++) {
            iterations.push(asyncIterator.next());
          }

          const rawResult = await Promise.all(iterations);

          /** @type {[number[], number]} */
          const result = [
            rawResult.map(item => item.value),
            Date.now()
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

    it('should handle nested async generator values from the original AsyncIterable when looped over', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
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
      // TODO: Calculate whether this makes sense
      duration.should.equal(8400);
    });

    it('should leave nested async generators unless told to care', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
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

      result.should.be.an('array').of.length(6).which.containAll(item => item.should.be.an('AsyncGenerator'));
      duration.should.equal(6300);
    });

    it('should leave async generator return values alone', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
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

      result.should.be.an('array').of.length(6).which.containAll(item => item.should.be.an('AsyncGenerator'));
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
          const rawResult = [];

          for await (const value of bufferAsyncIterable(baseAsyncIterable, async (item) => {
            const delay = item % 3 === 0 ? 100000 : 100;
            await promisableTimeout(delay);
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
          const rawResult = [];

          for await (const value of bufferAsyncIterable(baseAsyncIterable, async (item) => {
            const delay = item % 3 === 0 ? 100000 : 100;
            await promisableTimeout(delay);
            return item;
          })) {
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

    describe('AsyncInterface return()', () => {
      it('should end the iterator when called', async () => {
        const iterator = bufferAsyncIterable(baseAsyncIterable, async (item) => item);

        iterator.next().should.eventually.deep.equal({ value: 0 });
        iterator.return().should.eventually.deep.equal({ done: true, value: undefined });
        iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
      });

      it('should be called when a loop breaks', async () => {
        const iterator = bufferAsyncIterable(baseAsyncIterable, async (item) => item);

        const promisedResult = (async () => {
          // eslint-disable-next-line no-unreachable-loop
          for await (const value of iterator) {
            value.should.equal(0);
            break;
          }

          return Date.now();
        })();

        await clock.runAllAsync();

        const duration = await promisedResult;

        // TODO: Do we need an await here?
        await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
        duration.should.equal(2200);
      });

      it('should be called when a loop throws', async () => {
        const iterator = bufferAsyncIterable(baseAsyncIterable, async (item) => item);
        const errorToThrow = new Error('Yet another error');

        const promisedResult = (async () => {
          // eslint-disable-next-line no-unreachable-loop
          for await (const value of iterator) {
            value.should.equal(0);
            throw errorToThrow;
          }

          return Date.now();
        })();

        await clock.runAllAsync();

        await promisedResult.should.eventually.be.rejectedWith(errorToThrow);
        await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
      });
    });

    it('should return the value sent to it');
  });
});

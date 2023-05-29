import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
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

describe('bufferedAsyncMap() values', () => {
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

        for await (const value of bufferedAsyncMap(baseAsyncIterable, async (item) => item)) {
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
        const asyncIterable = bufferedAsyncMap(baseAsyncIterable, async (item) => item);
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

      for await (const value of bufferedAsyncMap([10, 20, 30], async (item) => {
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

      for await (const value of bufferedAsyncMap(baseAsyncIterable, async function * (item) {
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

      for await (const value of bufferedAsyncMap(baseAsyncIterable, async function * (item) {
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

      for await (const value of bufferedAsyncMap(baseAsyncIterable, async function (item) {
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
    const chainedBufferedAsyncIterable = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {number[]} */
      const rawResult = [];

      for await (const value of bufferedAsyncMap(chainedBufferedAsyncIterable, async (item) => item)) {
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

        for await (const value of bufferedAsyncMap(baseAsyncIterable, async (item) => {
          const delay = item % 3 === 0 ? 100000 : 100;
          await promisableTimeout(delay);
          return item;
        }, { bufferSize: 3 })) {
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

        for await (const value of bufferedAsyncMap(baseAsyncIterable, async (item) => {
          const delay = item % 3 === 0 ? 100000 : 100;
          await promisableTimeout(delay);
          return item;
        }, { bufferSize: 3 })) {
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

  it('should handle rejected value from source', async () => {
    const rejectionError = new Error('Rejection');

    /** @returns {AsyncIterable<number>} */
    // eslint-disable-next-line unicorn/consistent-function-scoping
    async function * rejectedGeneratorValue () {
      for (let i = 0; i < count; i++) {
        yield i === 3
          ? promisableTimeout(200).then(() => { throw rejectionError; })
          : i;
        await promisableTimeout(i < 3 ? 2000 : 100);
      }
    }

    const customAsyncIterable = rejectedGeneratorValue();

    const callbackSpy = sinon.stub().returnsArg(0);

    /** @type {number[]} */
    const result = [];

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      for await (const value of bufferedAsyncMap(customAsyncIterable, callbackSpy)) {
        result.push(value);
      }
    })()
      // eslint-disable-next-line promise/prefer-await-to-then
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => {
          err.should.equal(rejectionError);
        }
      );

    await clock.runAllAsync();
    await promisedResult;

    callbackSpy.should.have.callCount(3);

    await customAsyncIterable[Symbol.asyncIterator]().next().should.eventually.deep.equal({
      done: true,
      value: undefined,
    });

    result.should.have.length(3).and.have.members([0, 1, 2]);
  });

  it('should handle rejected value from map callback', async () => {
    const bufferSize = 5;
    const rejectionError = new Error('Rejection');

    baseAsyncIterable = yieldValuesOverTime(count * 10, (i) => i % 2 === 1 ? 2000 : 100);

    const callbackSpy = sinon.stub().returnsArg(0).onSecondCall().rejects(rejectionError);

    /** @type {number[]} */
    const result = [];

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      for await (const value of bufferedAsyncMap(baseAsyncIterable, callbackSpy, { bufferSize })) {
        result.push(value);
      }
    })()
      // eslint-disable-next-line promise/prefer-await-to-then
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => {
          err.should.equal(rejectionError);
        }
      );

    await clock.runAllAsync();
    await promisedResult;

    callbackSpy.should.have.callCount(bufferSize + 1);
    result.should.be.an('array').with.members([
      0,
      2,
      3,
      4,
      5,
    ]);

    await baseAsyncIterable[Symbol.asyncIterator]().next().should.eventually.deep.equal({
      done: true,
      value: undefined,
    });
  });

  it('should handle rejected value from generator map callback', async () => {
    const bufferSize = 5;
    const rejectionError = new Error('Rejection');

    baseAsyncIterable = yieldValuesOverTime(count * 10, (i) => i % 2 === 1 ? 2000 : 100);

    /**
     * @param {number} baseIndex
     * @returns {AsyncIterable<string>}
     */
    async function * rejectedGeneratorValue (baseIndex) {
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (i === baseIndex + 1) {
          yield promisableTimeout(2150).then(() => { throw rejectionError; });
        } else {
          yield baseIndex + ':' + i;
        }
        await promisableTimeout(i ? 100 : 2000);
      }
    }

    /** @type {string[]} */
    const result = [];
    /** @type {Array<AsyncIterable<string|number>>} */
    const iterators = [baseAsyncIterable];

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      for await (const value of bufferedAsyncMap(baseAsyncIterable, (baseIndex) => {
        const subIterator = rejectedGeneratorValue(baseIndex);
        iterators.push(subIterator);
        return subIterator;
      }, { bufferSize })) {
        result.push(value);
      }
    })()
      // eslint-disable-next-line promise/prefer-await-to-then
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => {
          err.should.equal(rejectionError);
        }
      );

    await clock.runAllAsync();
    await promisedResult;

    result.should.be.an('array').with.members([
      '0:0',
      '1:0',
      '1:1',
      '2:0',
      '2:1',
      '2:2',
      '3:0',
      '3:1',
    ]);

    iterators.should.be.of.length(6);

    // Ensure all iterators has been completed

    const iteratorsNext = iterators.map(async iterator =>
      iterator[Symbol.asyncIterator]()
        .next()
        // eslint-disable-next-line promise/prefer-await-to-then
        .catch(err => ({ err }))
    );

    await clock.runAllAsync();

    await Promise.all(iteratorsNext).should.eventually.deep.equal(
      Array.from({ length: 6 })
        .fill({ done: true, value: undefined })
    );
  });

  it('should return the value sent to it');

  it('should be able to return the values in order');

  it('should provide an AbortController in the map callback');
});

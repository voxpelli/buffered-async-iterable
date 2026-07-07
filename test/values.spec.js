/* eslint-disable promise/prefer-await-to-then */

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
  mergeIterables,
} from '../index.js';
import {
  collectNextOutcomes,
  isAsyncGenerator,
  nestedYieldValuesOverTime,
  promisableTimeout,
  stubAsyncIterator,
  unwrapCapturedError,
  yieldValuesOverTime,
  yieldValuesOverTimeWithPrefix,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

chai.should();

/**
 * @param {number} item
 * @returns {AsyncGenerator<string>}
 */
async function * nestedBufferedAsyncMapCallback (item) {
  yield * nestedYieldValuesOverTime(3, (i) => i % 2 === 1 ? 2000 : 100, async function * (i) {
    yield * yieldValuesOverTimeWithPrefix(3, (i) => i % 2 === 1 ? 2000 : 100, 'prefix-' + item + '-' + i + '-');
  });
  yield * nestedYieldValuesOverTime(3, (i) => i % 2 === 1 ? 2000 : 100, async function * (i) {
    yield * yieldValuesOverTimeWithPrefix(3, (i) => i % 2 === 1 ? 2000 : 100, '2-prefix-' + item + '-' + i + '-');
  });
}

const nestedBufferedAsyncMapOrderedResult = () => /** @type {const} */ ([
  'prefix-0-0-0',
  'prefix-0-0-1',
  'prefix-0-0-2',
  'prefix-0-1-0',
  'prefix-0-1-1',
  'prefix-0-1-2',
  'prefix-0-2-0',
  'prefix-0-2-1',
  'prefix-0-2-2',
  '2-prefix-0-0-0',
  '2-prefix-0-0-1',
  '2-prefix-0-0-2',
  '2-prefix-0-1-0',
  '2-prefix-0-1-1',
  '2-prefix-0-1-2',
  '2-prefix-0-2-0',
  '2-prefix-0-2-1',
  '2-prefix-0-2-2',
  'prefix-1-0-0',
  'prefix-1-0-1',
  'prefix-1-0-2',
  'prefix-1-1-0',
  'prefix-1-1-1',
  'prefix-1-1-2',
  'prefix-1-2-0',
  'prefix-1-2-1',
  'prefix-1-2-2',
  '2-prefix-1-0-0',
  '2-prefix-1-0-1',
  '2-prefix-1-0-2',
  '2-prefix-1-1-0',
  '2-prefix-1-1-1',
  '2-prefix-1-1-2',
  '2-prefix-1-2-0',
  '2-prefix-1-2-1',
  '2-prefix-1-2-2',
  'prefix-2-0-0',
  'prefix-2-0-1',
  'prefix-2-0-2',
  'prefix-2-1-0',
  'prefix-2-1-1',
  'prefix-2-1-2',
  'prefix-2-2-0',
  'prefix-2-2-1',
  'prefix-2-2-2',
  '2-prefix-2-0-0',
  '2-prefix-2-0-1',
  '2-prefix-2-0-2',
  '2-prefix-2-1-0',
  '2-prefix-2-1-1',
  '2-prefix-2-1-2',
  '2-prefix-2-2-0',
  '2-prefix-2-2-1',
  '2-prefix-2-2-2',
  'prefix-3-0-0',
  'prefix-3-0-1',
  'prefix-3-0-2',
  'prefix-3-1-0',
  'prefix-3-1-1',
  'prefix-3-1-2',
  'prefix-3-2-0',
  'prefix-3-2-1',
  'prefix-3-2-2',
  '2-prefix-3-0-0',
  '2-prefix-3-0-1',
  '2-prefix-3-0-2',
  '2-prefix-3-1-0',
  '2-prefix-3-1-1',
  '2-prefix-3-1-2',
  '2-prefix-3-2-0',
  '2-prefix-3-2-1',
  '2-prefix-3-2-2',
  'prefix-4-0-0',
  'prefix-4-0-1',
  'prefix-4-0-2',
  'prefix-4-1-0',
  'prefix-4-1-1',
  'prefix-4-1-2',
  'prefix-4-2-0',
  'prefix-4-2-1',
  'prefix-4-2-2',
  '2-prefix-4-0-0',
  '2-prefix-4-0-1',
  '2-prefix-4-0-2',
  '2-prefix-4-1-0',
  '2-prefix-4-1-1',
  '2-prefix-4-1-2',
  '2-prefix-4-2-0',
  '2-prefix-4-2-1',
  '2-prefix-4-2-2',
  'prefix-5-0-0',
  'prefix-5-0-1',
  'prefix-5-0-2',
  'prefix-5-1-0',
  'prefix-5-1-1',
  'prefix-5-1-2',
  'prefix-5-2-0',
  'prefix-5-2-1',
  'prefix-5-2-2',
  '2-prefix-5-0-0',
  '2-prefix-5-0-1',
  '2-prefix-5-0-2',
  '2-prefix-5-1-0',
  '2-prefix-5-1-1',
  '2-prefix-5-1-2',
  '2-prefix-5-2-0',
  '2-prefix-5-2-1',
  '2-prefix-5-2-2',
]);

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

  it('should return all values from the original AsyncIterable when looped over', async () => {
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

  it('should handle nested async generator values from the original AsyncIterable when looped over', async () => {
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

      for await (const value of bufferedAsyncMap(baseAsyncIterable, async (item) => yieldValuesOverTimeWithPrefix(2, (i) => i % 2 === 1 ? 2000 : 100, 'prefix-' + item + '-'))) {
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
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => {
          const captured = unwrapCapturedError(err);
          captured.should.equal(rejectionError);
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
        .catch(err => ({ err }))
    );

    await clock.runAllAsync();

    await Promise.all(iteratorsNext).should.eventually.deep.equal(
      Array.from({ length: 6 })
        .fill({ done: true, value: undefined })
    );
  });

  it('should normalize a non-Error rejection from the callback into an Error', async () => {
    baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);

    let callCount = 0;
    /**
     * @param {number} item
     * @returns {Promise<number>}
     */
    const callback = async (item) => {
      callCount += 1;
      if (callCount === 2) {
        // Reject with a non-Error value — exercises normalizeError's fallback.
        // eslint-disable-next-line no-throw-literal
        throw 'a plain string rejection';
      }
      return item;
    };

    /** @type {number[]} */
    const drained = [];

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      for await (const value of bufferedAsyncMap(baseAsyncIterable, callback)) {
        drained.push(value);
      }
    })()
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => ({ rejectedWith: err })
      );

    await clock.runAllAsync();
    const outcome = await promisedResult;

    outcome.rejectedWith.should.be.an.instanceOf(Error);
    outcome.rejectedWith.message.should.equal('Unknown callback error');
    // The original non-Error value is preserved on .cause so callers can
    // recover the evidence (a bare 'Unknown' message is useless in a log).
    outcome.rejectedWith.cause.should.equal('a plain string rejection');
  });

  it('should not attach a `cause` for a nullish rejection from the callback', async () => {
    baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);

    let callCount = 0;
    /**
     * @param {number} item
     * @returns {Promise<number>}
     */
    const callback = async (item) => {
      callCount += 1;
      if (callCount === 2) {
        // Reject with undefined (e.g. a bare `Promise.reject()` / `throw undefined`):
        // there's no evidence worth preserving, so `cause` should be left unset
        // rather than attached as `cause: undefined` (which logs as noise).
        // eslint-disable-next-line no-throw-literal
        throw undefined;
      }
      return item;
    };

    /** @type {number[]} */
    const drained = [];

    const promisedResult = (async () => {
      for await (const value of bufferedAsyncMap(baseAsyncIterable, callback)) {
        drained.push(value);
      }
    })()
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => ({ rejectedWith: err })
      );

    await clock.runAllAsync();
    const outcome = await promisedResult;

    outcome.rejectedWith.should.be.an.instanceOf(Error);
    outcome.rejectedWith.message.should.equal('Unknown callback error');
    // No `cause` own property at all — not `cause: undefined`.
    Object.prototype.hasOwnProperty.call(outcome.rejectedWith, 'cause').should.equal(false);
  });

  it('should throw TypeError on non-object value from AsyncIterator interface', async () => {
    const {
      asyncIterable,
      asyncIterator,
    } = stubAsyncIterator();

    asyncIterator.next.returns('wow');

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {string[]} */
      const result = [];

      for await (const value of bufferedAsyncMap(asyncIterable, async item => item)) {
        result.push(value);
      }

      return result;
    })()
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => {
          const captured = unwrapCapturedError(err);
          captured.should.be.instanceOf(TypeError);
          captured.message.should.equal('Expected source iterator next() result to be an object');
        }
      );

    await clock.runAllAsync();
    await promisedResult;
  });

  it('should not emit unhandledRejection when a malformed-result slot is never consumed', async () => {
    const {
      asyncIterable,
      asyncIterator,
    } = stubAsyncIterator();

    // First .next() resolves a real value; subsequent calls return a
    // malformed result. We pull the good value and close — the malformed
    // buffer slots get spliced by markAsEnded without ever being raced.
    // Pre-fix this surfaced as a process-fatal unhandledRejection.
    asyncIterator.next.returns('wow');
    asyncIterator.next.onFirstCall().resolves({ value: 1, done: false });

    /** @type {unknown[]} */
    const unhandled = [];
    /**
     * @param {unknown} reason
     * @returns {void}
     */
    const listener = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);

    try {
      const flow = (async () => {
        const iterator = bufferedAsyncMap(asyncIterable, async item => item, { bufferSize: 4 });
        await iterator.next();
        await iterator.return();
      })();

      await clock.runAllAsync();
      await flow;
      await clock.runAllAsync();
    } finally {
      process.off('unhandledRejection', listener);
    }

    unhandled.should.be.an('array').with.length(0);
  });

  it('routes a synchronously-throwing callback through the errors mode', async () => {
    const thrown = new Error('sync-throw');

    /** @type {string[]} */
    const drained = [];

    // Plain (non-async) callback that throws synchronously — must become the
    // same {err} envelope as a rejection, not a raw bufferPromise rejection
    // that bypasses fail-eventually (pre-fix: no drain, infinite rejections).
    const flow = (async () => {
      for await (const value of bufferedAsyncMap(['a', 'b', 'c'], (item) => {
        if (item === 'b') throw thrown;
        return Promise.resolve(item);
      })) {
        drained.push(value);
      }
    })()
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => ({ rejectedWith: err })
      );

    await clock.runAllAsync();
    const outcome = await flow;

    // fail-eventually drained the in-flight siblings before throwing…
    drained.should.deep.equal(['a', 'c']);
    // …and the single captured error keeps its identity.
    chai.expect(outcome.rejectedWith).to.equal(thrown);
  });

  it('does not emit unhandledRejection when a sync-throwing callback slot is never consumed', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    /**
     * @param {unknown} reason
     * @returns {void}
     */
    const listener = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);

    try {
      const flow = (async () => {
        // Construction eagerly dispatches all three callbacks; the sync throw
        // poisons a buffer slot that return() then splices without racing.
        const iterator = bufferedAsyncMap(['a', 'b', 'c'], (item) => {
          if (item === 'b') throw new Error('poison');
          return Promise.resolve(item);
        }, { bufferSize: 3 });

        await iterator.return();
      })();

      await clock.runAllAsync();
      await flow;
      await clock.runAllAsync();
    } finally {
      process.off('unhandledRejection', listener);
    }

    unhandled.should.be.an('array').with.length(0);
  });

  it('yields values from a source whose results carry their own err property', async () => {
    // Spec-legal IteratorResults may carry extra fields — e.g. a driver that
    // reuses one result-object shape with an (unset) `err` slot. These must
    // not be mistaken for the library's internal error envelopes.
    /** @type {Array<IteratorResult<string> & { err: unknown }>} */
    const results = [
      { done: false, value: 'item0', err: undefined },
      // eslint-disable-next-line unicorn/no-null -- a null err property is exactly the foreign shape under test
      { done: false, value: 'item1', err: null },
      { done: true, value: undefined, err: undefined },
    ];
    let i = 0;
    /** @type {AsyncIterable<string>} */
    const source = {
      [Symbol.asyncIterator]: () => ({
        // Clamp: the prefetch pulls up to bufferSize results before the first
        // one resolves, so keep answering `done` past the end.
        next: async () => /** @type {IteratorResult<string>} */ (results[Math.min(i++, results.length - 1)]),
      }),
    };

    const flow = (async () => {
      /** @type {string[]} */
      const collected = [];
      for await (const value of bufferedAsyncMap(source, async item => item)) {
        collected.push(value);
      }
      return collected;
    })();

    await clock.runAllAsync();
    const collected = await flow;
    collected.should.deep.equal(['item0', 'item1']);
  });

  it('yields values from a sub-iterable whose results carry their own err property', async () => {
    /** @type {Array<IteratorResult<string> & { err: unknown }>} */
    const results = [
      { done: false, value: 'sub0', err: undefined },
      { done: false, value: 'sub1', err: undefined },
      { done: true, value: undefined, err: undefined },
    ];
    let i = 0;
    /** @type {(item: string) => AsyncIterable<string>} */
    const callback = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => /** @type {IteratorResult<string>} */ (results[Math.min(i++, results.length - 1)]),
      }),
    });

    const flow = (async () => {
      /** @type {string[]} */
      const collected = [];
      for await (const value of bufferedAsyncMap(['a'], callback)) {
        collected.push(value);
      }
      return collected;
    })();

    await clock.runAllAsync();
    const collected = await flow;
    collected.should.deep.equal(['sub0', 'sub1']);
  });

  it('should throw TypeError on non-object value from AsyncIterator interface on subIterator', async () => {
    const {
      asyncIterable,
      asyncIterator,
    } = stubAsyncIterator();

    asyncIterator.next.returns('wow');

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {string[]} */
      const result = [];

      for await (const value of bufferedAsyncMap(baseAsyncIterable, () => asyncIterable)) {
        result.push(value);
      }

      return result;
    })()
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => {
          const captured = unwrapCapturedError(err);
          captured.should.be.instanceOf(TypeError);
          captured.message.should.equal('Expected sub-iterator next() result to be an object');
        }
      );

    await clock.runAllAsync();
    await promisedResult;
  });

  it('should surface a malformed async iterable from the callback (fail-eventually)', async () => {
    const malformedError = new Error('bad iterable');

    /** @returns {AsyncIterable<string>} */
    const malformedIterable = () => ({
      [Symbol.asyncIterator]: () => {
        throw malformedError;
      },
    });

    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {string[]} */
      const result = [];

      for await (const value of bufferedAsyncMap(baseAsyncIterable, malformedIterable)) {
        result.push(value);
      }

      return result;
    })()
      .then(
        () => {
          throw new Error('Expected a rejection');
        },
        err => ({ rejectedWith: err })
      );

    await clock.runAllAsync();
    const outcome = await promisedResult;

    const captured = outcome.rejectedWith instanceof AggregateError
      ? outcome.rejectedWith.errors[0]
      : outcome.rejectedWith;
    captured.should.equal(malformedError);
  });

  it('should surface a malformed async iterable from the callback (fail-fast)', async () => {
    const malformedError = new Error('bad iterable');

    /** @returns {AsyncIterable<string>} */
    const malformedIterable = () => ({
      [Symbol.asyncIterator]: () => {
        throw malformedError;
      },
    });

    const iterator = bufferedAsyncMap(
      baseAsyncIterable,
      malformedIterable,
      { errors: 'fail-fast' }
    )[Symbol.asyncIterator]();

    const rejected = iterator.next().catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();
    const outcome = await rejected;

    outcome.should.deep.equal({ rejectedWith: malformedError });
  });

  it('should give back pressure', async () => {
    baseAsyncIterable = yieldValuesOverTime(100, (i) => i % 2 === 1 ? 2000 : 100);
    const baseAsyncIterator = baseAsyncIterable[Symbol.asyncIterator]();

    const nextSpy = sinon.spy(baseAsyncIterator, 'next');

    const asyncIterator = bufferedAsyncMap(
      baseAsyncIterable,
      async (item) => item,
      { bufferSize: 10 }
    );

    await clock.runAllAsync();
    nextSpy.should.have.callCount(10);

    await asyncIterator.next().should.eventually.be.an('object').with.property('value').that.is.a('number');

    await clock.runAllAsync();
    nextSpy.should.have.callCount(11);
  });

  describe('order', () => {
    it('should be out of order as standard', async () => {
      const asyncIterable = yieldValuesOverTime(10, i => i % 3 === 0 ? 2000 : 1);

      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {number[]} */
        const rawResult = [];

        for await (const value of bufferedAsyncMap(asyncIterable, async (item) => {
          await promisableTimeout(item % 2 === 0 ? 2000 : 1);
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

      result.should.deep.equal([0, 1, 3, 2, 5, 4, 6, 7, 9, 8]);
      duration.should.equal(8006);
    });

    it('should ensure in order when requested', async () => {
      const asyncIterable = yieldValuesOverTime(10, i => i % 3 === 0 ? 2000 : 1);

      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {number[]} */
        const rawResult = [];

        for await (const value of bufferedAsyncMap(asyncIterable, async (item) => {
          await promisableTimeout(item % 2 === 0 ? 2000 : 1);
          return item;
        }, { bufferSize: 3, ordered: true })) {
          rawResult.push(value);
        }

        /** @type {[number[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      duration.should.equal(10004);
    });

    it('should handle nested async generator values out of order when looped over', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {string[]} */
        const rawResult = [];

        for await (const value of bufferedAsyncMap(baseAsyncIterable, nestedBufferedAsyncMapCallback)) {
          rawResult.push(value);
        }

        /** @type {[string[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.be.an('array')
        .that.has.members(nestedBufferedAsyncMapOrderedResult())
        .but.does.not.deep.equal(nestedBufferedAsyncMapOrderedResult());

      duration.should.equal(21900);
    });

    it('should, when requested, handle nested async generator values in order when looped over', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {string[]} */
        const rawResult = [];

        for await (const value of bufferedAsyncMap(baseAsyncIterable, nestedBufferedAsyncMapCallback, { ordered: true })) {
          rawResult.push(value);
        }

        /** @type {[string[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.be.an('array').that.deep.equals(nestedBufferedAsyncMapOrderedResult());

      duration.should.equal(105600);
    });

    it('should be faster than ordered non-buffered iteration', async () => {
      // eslint-disable-next-line unicorn/consistent-function-scoping
      async function * nestedBaseSyncIterable () {
        yield * nestedYieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100, nestedBufferedAsyncMapCallback);
      }

      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {string[]} */
        const rawResult = [];

        for await (const value of nestedBaseSyncIterable()) {
          rawResult.push(value);
        }

        /** @type {[string[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.be.an('array').that.deep.equals(nestedBufferedAsyncMapOrderedResult());

      duration.should.equal(111900);
    });
  });

  describe('mergeIterables', () => {
    it('should process iterables in parallel', async () => {
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {string[]} */
        const rawResult = [];

        for await (const value of mergeIterables([
          yieldValuesOverTimeWithPrefix(6, (i) => i % 2 === 1 ? 2000 : 100, 'first-'),
          yieldValuesOverTimeWithPrefix(6, (i) => i % 2 === 1 ? 2000 : 100, 'second-'),
        ])) {
          rawResult.push(value);
        }

        /** @type {[string[], number]} */
        const result = [rawResult, Date.now()];

        return result;
      })();

      await clock.runAllAsync();

      const [result, duration] = await promisedResult;

      result.should.deep.equal([
        'first-0',
        'second-0',
        'second-1',
        'first-1',
        'second-2',
        'first-2',
        'second-3',
        'first-3',
        'second-4',
        'first-4',
        'second-5',
        'first-5',
      ]);
      duration.should.equal(6300);
    });

    it('forwards options.signal to the underlying bufferedAsyncMap', async () => {
      const reason = new Error('merge-aborted');
      const ac = new AbortController();

      const iterator = mergeIterables([
        yieldValuesOverTimeWithPrefix(6, 100, 'a-'),
        yieldValuesOverTimeWithPrefix(6, 100, 'b-'),
      ], { signal: ac.signal })[Symbol.asyncIterator]();

      const first = iterator.next();
      await clock.runAllAsync();
      await first;

      ac.abort(reason);

      const next = iterator.next().catch(err => ({ rejectedWith: err }));
      await clock.runAllAsync();
      chai.expect(await next).to.deep.equal({ rejectedWith: reason });
    });

    it("forwards errors: 'fail-fast' to surface the original rejection", async () => {
      const sourceError = new Error('merge-fail-fast');

      async function * throwingInput () {
        yield 'b-0';
        await promisableTimeout(100);
        throw sourceError;
      }

      const iterator = mergeIterables([
        yieldValuesOverTimeWithPrefix(6, 100, 'a-'),
        throwingInput(),
      ], { errors: 'fail-fast' })[Symbol.asyncIterator]();

      const flow = collectNextOutcomes(iterator, 6);
      await clock.runAllAsync();
      const results = await flow;

      const firstReject = results.findIndex(r => r.rejected);
      chai.expect(firstReject).to.be.greaterThan(-1);
      chai.expect(results[firstReject]?.value).to.equal(sourceError);
    });

    it('exposes Symbol.asyncDispose on the merged iterator', async () => {
      const iterator = mergeIterables([
        yieldValuesOverTimeWithPrefix(3, 100, 'a-'),
      ]);

      chai.expect(typeof iterator[Symbol.asyncDispose]).to.equal('function');

      // Calling dispose runs cleanup once and resolves to undefined.
      const promised = iterator[Symbol.asyncDispose]();
      await clock.runAllAsync();
      chai.expect(await promised).to.equal(undefined);
    });

    it('validates the input array and its elements at call time', async () => {
      // Non-array input
      chai.expect(() => {
        // @ts-ignore
        mergeIterables('abc');
      }).to.throw(TypeError, 'Expected input to be an array of iterables');

      // A bad element throws NOW, naming its index — pre-fix `yield * null`
      // surfaced minutes later as a deferred fail-eventually TypeError after
      // every healthy source drained.
      chai.expect(() => {
        // eslint-disable-next-line unicorn/no-null -- a null element is exactly the malformed input under test
        mergeIterables([(async function * () { yield 1; })(), /** @type {*} */ (null)]);
      }).to.throw(TypeError, 'Expected input[1] to have a callable Symbol.asyncIterator or Symbol.iterator');

      // Strings are iterable but char-splitting a merge element is almost
      // always a mistake — rejected with a pointer to the fix.
      chai.expect(() => {
        // @ts-ignore
        mergeIterables(['abc']);
      }).to.throw(TypeError, /Expected input\[0\].*strings are not merged char-by-char/);

      // Boxed strings too — they satisfy isObject and the iterable protocol,
      // so they used to slip past the primitive check and silently char-split.
      chai.expect(() => {
        // eslint-disable-next-line no-new-wrappers, unicorn/new-for-builtins -- a boxed String is exactly the hostile element under test
        mergeIterables([(new String('abc'))]);
      }).to.throw(TypeError, /Expected input\[0\].*strings are not merged char-by-char/);

      // Non-callable protocol members are rejected eagerly with their index —
      // pre-fix they passed the presence check and surfaced minutes later as
      // a deferred unbranded consume-time TypeError.
      chai.expect(() => {
        // @ts-ignore
        mergeIterables([{ [Symbol.iterator]: 42 }]);
      }).to.throw(TypeError, 'Expected input[0] to have a callable Symbol.asyncIterator or Symbol.iterator');
    });

    it('rejects a cross-realm boxed String element', async () => {
      const { runInNewContext } = await import('node:vm');
      const crossRealmBoxed = runInNewContext("new String('abc')");

      // An instanceof-based check would miss this value (cross-realm
      // prototype chain) — the brand check must still catch it (pre-fix it
      // silently char-split).
      // eslint-disable-next-line unicorn/no-instanceof-builtins -- asserting exactly the instanceof blind spot the brand check exists for
      chai.expect(crossRealmBoxed instanceof String).to.equal(false);
      chai.expect(() => {
        mergeIterables([crossRealmBoxed]);
      }).to.throw(TypeError, /Expected input\[0\].*strings are not merged char-by-char/);
    });

    it('forwards ordered: true to drain inputs in source order', async () => {
      // Asymmetric timing: the second source is ten times faster than the first.
      // Under the default ordered:false this would interleave (second-* would
      // arrive between first-0 and first-1); under ordered:true the first
      // iterable is drained completely before any value from the second.
      // Create the promise first, then have it be fully executed using clock.runAllAsync()
      const promisedResult = (async () => {
        /** @type {string[]} */
        const rawResult = [];

        for await (const value of mergeIterables([
          yieldValuesOverTimeWithPrefix(3, 1000, 'first-'),
          yieldValuesOverTimeWithPrefix(3, 100, 'second-'),
        ], { ordered: true })) {
          rawResult.push(value);
        }

        return rawResult;
      })();

      await clock.runAllAsync();
      const result = await promisedResult;

      result.should.deep.equal([
        'first-0',
        'first-1',
        'first-2',
        'second-0',
        'second-1',
        'second-2',
      ]);
    });
  });
});

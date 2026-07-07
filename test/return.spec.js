/* eslint-disable promise/prefer-await-to-then */

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  promisableTimeout,
  yieldValuesOverTime,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

chai.should();

describe('bufferedAsyncMap() AsyncInterface return()', () => {
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

  it('should end the iterator when called', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    await iterator.next().should.eventually.deep.equal({ value: 0 });

    const returnValue = iterator.return();
    const nextAfterReturn = iterator.next();

    await clock.runAllAsync();

    await returnValue.should.eventually.deep.equal({ done: true, value: undefined });
    await nextAfterReturn.should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('should resolve return(value) to { done: true, value } per the iterator protocol', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    await iterator.next().should.eventually.deep.equal({ value: 0 });

    // return(value) reflects the passed argument...
    const firstReturn = iterator.return('sentinel');
    await clock.runAllAsync();
    await firstReturn.should.eventually.deep.equal({ done: true, value: 'sentinel' });

    // ...and each subsequent call reflects its own argument (not "remembered").
    const secondReturn = iterator.return('other');
    await clock.runAllAsync();
    await secondReturn.should.eventually.deep.equal({ done: true, value: 'other' });

    // A no-argument return() still resolves to { done: true, value: undefined }.
    const bareReturn = iterator.return();
    await clock.runAllAsync();
    await bareReturn.should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('should await a thenable return(value) argument', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    const returnValue = iterator.return(Promise.resolve('awaited'));
    await clock.runAllAsync();

    await returnValue.should.eventually.deep.equal({ done: true, value: 'awaited' });
  });

  it('should call the source iterator return() only once across repeated return() calls', async () => {
    const source = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item
    );

    await iterator.next().should.eventually.deep.equal({ value: 0 });

    const first = iterator.return('a');
    const second = iterator.return('b');
    await clock.runAllAsync();

    await first.should.eventually.deep.equal({ done: true, value: 'a' });
    await second.should.eventually.deep.equal({ done: true, value: 'b' });
    returnSpy.should.have.been.calledOnce;
  });

  it('should still run cleanup when return(value) receives a rejecting promise', async () => {
    const source = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item
    );

    await iterator.next().should.eventually.deep.equal({ value: 0 });

    const rejection = new Error('rejecting return value');
    // Pre-attach a no-op catch so node doesn't see an unhandled rejection
    // before iterator.return() consumes the promise.
    const rejecting = Promise.reject(rejection);
    rejecting.catch(() => {});

    const returnResult = iterator.return(rejecting).catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();
    const outcome = await returnResult;

    // The rejection propagates — matching native AsyncGenerator behaviour.
    outcome.should.deep.equal({ rejectedWith: rejection });

    // ...AND cleanup ran: source.return() was called exactly once, even
    // though the awaited value rejected before reaching markAsEnded.
    returnSpy.should.have.been.calledOnce;

    // Subsequent .next() returns done — the iterator is closed.
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('should tolerate a sync-throwing source .return() during cleanup', async () => {
    const cleanupError = new Error('explode during return');
    const healthyReturn = sinon.stub().resolves({ done: true, value: undefined });

    // Two main-iter values; .return() on this source throws synchronously
    // (mimics e.g. a release() that ran some sync teardown before returning
    // a promise — or a buggy getter).
    /** @type {AsyncIterator<number>} */
    const explodingSource = {
      next: sinon.stub().resolves({ value: 1, done: false }),
      'return': sinon.stub().throws(cleanupError),
    };
    /** @type {AsyncIterable<number>} */
    const explodingIterable = { [Symbol.asyncIterator]: () => explodingSource };

    // The callback returns a healthy sub-iterator, so markAsEnded calls
    // .return() on both the main (throwing) and a sub-iterator (healthy).
    const iterator = bufferedAsyncMap(explodingIterable, () => ({
      [Symbol.asyncIterator]: () => ({
        next: sinon.stub().resolves({ value: 'a', done: false }),
        'return': healthyReturn,
      }),
    }));

    await iterator.next().should.eventually.deep.equal({ value: 'a' });
    // The consumer-facing return() must resolve cleanly even though one
    // source's .return() threw synchronously.
    await iterator.return().should.eventually.deep.equal({ done: true, value: undefined });
    healthyReturn.should.have.been.called;
  });

  it('should still close a source that produced a malformed result', async () => {
    const sourceReturn = sinon.stub().resolves({ done: true, value: undefined });

    // A source whose second next() resolves to a non-object (driver bug).
    // The malformed result surfaces as a TypeError, but the source is still
    // nominally open — an explicit return() must .return() it (pre-fix, the
    // malformed arm marked the source done and cleanup skipped it entirely).
    /** @type {AsyncIterator<number>} */
    const malformedSource = {
      next: sinon.stub()
        .resolves(/** @type {*} */ ('wow'))
        .onFirstCall().resolves({ value: 1, done: false }),
      'return': sourceReturn,
    };
    /** @type {AsyncIterable<number>} */
    const malformedIterable = { [Symbol.asyncIterator]: () => malformedSource };

    const iterator = bufferedAsyncMap(malformedIterable, async (item) => item, { bufferSize: 2 });

    await iterator.next().should.eventually.deep.equal({ value: 1 });
    await iterator.return().should.eventually.deep.equal({ done: true, value: undefined });

    sourceReturn.should.have.been.calledOnce;
  });

  it('should still close a sub-iterator that produced a malformed result', async () => {
    const subReturn = sinon.stub().resolves({ done: true, value: undefined });

    /** @type {(item: string) => AsyncIterable<string>} */
    const callback = () => ({
      [Symbol.asyncIterator]: () => ({
        next: sinon.stub()
          .resolves(/** @type {*} */ ('wow'))
          .onFirstCall().resolves({ value: 'sub-a', done: false }),
        'return': subReturn,
      }),
    });

    const iterator = bufferedAsyncMap(['x'], callback, { bufferSize: 2 });

    await iterator.next().should.eventually.deep.equal({ value: 'sub-a' });
    await iterator.return().should.eventually.deep.equal({ done: true, value: undefined });

    subReturn.should.have.been.calledOnce;
  });

  it('resolves a parked next() only after the closing cleanup has settled', async () => {
    let finallySettled = false;

    /** @returns {AsyncIterable<number>} */
    async function * source () {
      try {
        yield 0;
        await promisableTimeout(10_000);
        yield 1;
      } finally {
        await promisableTimeout(50);
        finallySettled = true;
      }
    }

    const iterator = bufferedAsyncMap(source(), async (item) => item, { bufferSize: 1 });

    const flow = (async () => {
      await iterator.next();

      // Consumer parks on the slow source; a separate task closes the
      // iterator. Native AsyncGenerator queues the requests, so the parked
      // pull must not resolve { done: true } while the source's finally is
      // still running — pre-fix the woken pull hit markAsEnded as a second
      // closer and resolved immediately, letting the consumer's scope exit
      // ~10s before cleanup settled.
      const parked = iterator.next();
      const closer = iterator.return();

      const result = await parked;
      const settledAtParkResolve = finallySettled;

      await closer;
      return { result, settledAtParkResolve };
    })();

    await clock.runAllAsync();
    const { result, settledAtParkResolve } = await flow;

    result.should.deep.equal({ done: true, value: undefined });
    settledAtParkResolve.should.equal(true);
  });

  it('should be called when a loop breaks', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item, { bufferSize: 3 });
    const returnSpy = sinon.spy(iterator, 'return');
    const throwSpy = sinon.spy(iterator, 'throw');

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

    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
    duration.should.equal(2200);

    returnSpy.should.have.been.calledOnceWithExactly();
    throwSpy.should.not.have.been.called;
  });

  it('should be called when a loop throws', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);
    const returnSpy = sinon.spy(iterator, 'return');
    const throwSpy = sinon.spy(iterator, 'throw');
    const errorToThrow = new Error('Yet another error');

    const promisedResult = (async () => {
      // eslint-disable-next-line no-unreachable-loop
      for await (const value of iterator) {
        value.should.equal(0);
        throw errorToThrow;
      }

      return Date.now();
    })()
      .then(() => false, () => true);

    await clock.runAllAsync();

    returnSpy.should.have.been.calledOnceWithExactly();
    throwSpy.should.not.have.been.called;

    await promisedResult.should.eventually.equal(true);
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });
});

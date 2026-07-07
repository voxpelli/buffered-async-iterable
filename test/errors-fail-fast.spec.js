import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  fromArray,
  promisableTimeout,
  yieldValuesOverTime,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(sinonChai);
const should = chai.should();

/**
 * @param {Error} expected
 * @returns {AsyncIterable<number>}
 */
async function * sourceThatThrows (expected) {
  yield 0;
  yield 1;
  throw expected;
}

describe('bufferedAsyncMap() errors: fail-fast', () => {
  /** @type {import('sinon').SinonFakeTimers} */
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    sinon.restore();
  });

  // --- Validation & default ---

  it("throws TypeError when errors is not 'fail-eventually'/'fail-fast'", () => {
    should.Throw(() => {
      bufferedAsyncMap(
        fromArray([0, 1]),
        async (item) => item,
        // @ts-expect-error
        { errors: 'isolate' }
      );
    }, TypeError, "Expected errors to be 'fail-eventually' or 'fail-fast'");
  });

  // --- fail-fast semantics ---

  it('first callback error rejects next .next() with that error; subsequent calls return done', async () => {
    const reason = new Error('cb-error');
    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(1).rejects(reason);

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(20, 100),
      callback,
      { errors: 'fail-fast', bufferSize: 2 }
    );

    /** @type {Array<{ rejected: boolean, value?: unknown }>} */
    const results = [];

    const flow = (async () => {
      for (let i = 0; i < 5; i += 1) {
        try {
          const r = await iterator.next();
          results.push({ rejected: false, value: r });
        } catch (err) {
          results.push({ rejected: true, value: err });
        }
      }
    })();

    await clock.runAllAsync();
    await flow;

    const firstReject = results.findIndex(r => r.rejected);
    chai.expect(firstReject).to.be.greaterThan(-1);
    chai.expect(results[firstReject]?.value).to.equal(reason);
    for (const r of results.slice(firstReject + 1)) {
      chai.expect(r).to.deep.equal({ rejected: false, value: { done: true, value: undefined } });
    }
  });

  it('a synchronously-throwing callback short-circuits with the original error and closes the source', async () => {
    const thrown = new Error('sync-fail-fast');
    const returnSpy = sinon.spy();

    /** @returns {AsyncIterable<number>} */
    async function * source () {
      try {
        yield 0;
        yield 1;
        yield 2;
        yield 3;
      } finally {
        returnSpy();
      }
    }

    // Plain (non-async) callback that throws synchronously — pre-fix this
    // rejected the raw buffer slot: every next() rejected forever and the
    // source's finally never ran.
    const iterator = bufferedAsyncMap(source(), (item) => {
      if (item === 1) throw thrown;
      return Promise.resolve(item);
    }, { errors: 'fail-fast', bufferSize: 2 });

    /** @type {Array<{ rejected: boolean, value?: unknown }>} */
    const results = [];

    const flow = (async () => {
      for (let i = 0; i < 5; i += 1) {
        try {
          const r = await iterator.next();
          results.push({ rejected: false, value: r });
        } catch (err) {
          results.push({ rejected: true, value: err });
        }
      }
    })();

    await clock.runAllAsync();
    await flow;

    const firstReject = results.findIndex(r => r.rejected);
    chai.expect(firstReject).to.be.greaterThan(-1);
    chai.expect(results[firstReject]?.value).to.equal(thrown);
    for (const r of results.slice(firstReject + 1)) {
      chai.expect(r).to.deep.equal({ rejected: false, value: { done: true, value: undefined } });
    }
    returnSpy.should.have.been.calledOnce;
  });

  it('a sub-iterator whose next() throws synchronously rejects once then closes', async () => {
    const thrown = new Error('sync-next-boom');

    let calls = 0;
    /** @type {(item: string) => AsyncIterable<string>} */
    const callback = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          calls += 1;
          if (calls === 2) throw thrown;
          return Promise.resolve(/** @type {IteratorResult<string>} */ ({ done: false, value: `sub-${calls}` }));
        },
      }),
    });

    const iterator = bufferedAsyncMap(['a'], callback, { errors: 'fail-fast', bufferSize: 2 });

    /** @type {Array<{ rejected: boolean, value?: unknown }>} */
    const results = [];

    const flow = (async () => {
      for (let i = 0; i < 5; i += 1) {
        try {
          const r = await iterator.next();
          results.push({ rejected: false, value: r });
        } catch (err) {
          results.push({ rejected: true, value: err });
        }
      }
    })();

    await clock.runAllAsync();
    await flow;

    // Exactly one rejection with the original error, then done forever — the
    // pre-fix repro leaked further sub-iterator values AFTER the rejection.
    const firstReject = results.findIndex(r => r.rejected);
    chai.expect(firstReject).to.be.greaterThan(-1);
    chai.expect(results[firstReject]?.value).to.equal(thrown);
    for (const r of results.slice(firstReject + 1)) {
      chai.expect(r).to.deep.equal({ rejected: false, value: { done: true, value: undefined } });
    }
  });

  it('drops a fail-fast error that lost the shutdown race to a synchronous abort (abort wins, once)', async () => {
    // The only reachable route to "fail-fast error with abortReason already
    // set": synchronous user re-entry — a callback result whose
    // [Symbol.asyncIterator]() body aborts the external signal and then
    // throws, between nextValue's post-race abort re-check and
    // handleStreamError. Exactly one rejection (the abort reason); the
    // re-entry error is deliberately dropped, mirroring Promise.all.
    const reason = new Error('sync-re-entry abort');
    const ac = new AbortController();

    /** @type {(item: string) => *} */
    const callback = () => ({
      [Symbol.asyncIterator] () {
        ac.abort(reason);
        throw new Error('re-entry boom');
      },
    });

    const iterator = bufferedAsyncMap(['a'], callback, { errors: 'fail-fast', signal: ac.signal, bufferSize: 1 });

    /** @type {Array<{ rejected: boolean, value?: unknown }>} */
    const results = [];
    const flow = (async () => {
      for (let i = 0; i < 3; i += 1) {
        try {
          const r = await iterator.next();
          results.push({ rejected: false, value: r });
        } catch (err) {
          results.push({ rejected: true, value: err });
        }
      }
    })();

    await clock.runAllAsync();
    await flow;

    const rejections = results.filter(r => r.rejected);
    rejections.should.have.length(1);
    chai.expect(rejections[0]?.value).to.equal(reason);
    for (const r of results.slice(results.findIndex(x => x.rejected) + 1)) {
      chai.expect(r).to.deep.equal({ rejected: false, value: { done: true, value: undefined } });
    }
  });

  it('discards the second of two racing errors (Promise.all parity)', async () => {
    const errA = new Error('first');
    const errB = new Error('second');
    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(0).rejects(errA)
      .onCall(1).rejects(errB);

    const iterator = bufferedAsyncMap(
      fromArray([0, 1, 2]),
      callback,
      { errors: 'fail-fast', bufferSize: 3 }
    );

    /** @type {Array<{ rejected: boolean, value?: unknown }>} */
    const results = [];
    const flow = (async () => {
      for (let i = 0; i < 4; i += 1) {
        try {
          const r = await iterator.next();
          results.push({ rejected: false, value: r });
        } catch (err) {
          results.push({ rejected: true, value: err });
        }
      }
    })();

    await clock.runAllAsync();
    await flow;

    // Exactly one rejection carrying the FIRST error; the second vanishes at
    // the envelope level (its slot is spliced by cleanup) — no
    // AggregateError, no second rejection.
    const rejections = results.filter(r => r.rejected);
    rejections.should.have.length(1);
    chai.expect(rejections[0]?.value).to.equal(errA);
  });

  it('source error fails fast', async () => {
    const sourceError = new Error('src-error');

    const iterator = bufferedAsyncMap(
      sourceThatThrows(sourceError),
      async (item) => item,
      { errors: 'fail-fast' }
    );

    /** @type {unknown} */
    let caught;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of iterator) {
        // drain
      }
    } catch (err) {
      caught = err;
    }

    await clock.runAllAsync();
    chai.expect(caught).to.equal(sourceError);
  });

  it('source.next not called after first error; source.return called once', async () => {
    const reason = new Error('halt');
    const source = yieldValuesOverTime(50, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const nextSpy = sinon.spy(sourceIterator, 'next');
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(0).rejects(reason);

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      callback,
      { errors: 'fail-fast', bufferSize: 1 }
    );

    /** @type {unknown} */
    let caught;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of iterator) {
        // drain
      }
    } catch (err) {
      caught = err;
    }

    await clock.runAllAsync();
    chai.expect(caught).to.equal(reason);

    const callsAfterFail = nextSpy.callCount;

    await iterator.next();
    await clock.runAllAsync();

    nextSpy.callCount.should.equal(callsAfterFail);
    returnSpy.should.have.been.calledOnce;
  });

  it('in-flight callbacks observe signal.aborted=true after fail-fast error', async () => {
    const reason = new Error('halt');
    /** @type {AbortSignal | undefined} */
    let captured;

    let callIdx = 0;
    const callback = async (
      /** @type {number} */ item,
      /** @type {{ signal: AbortSignal }} */ { signal }
    ) => {
      const i = callIdx++;
      captured = signal;
      if (i === 1) {
        // Slow second callback so the first failure has time to trigger fail-fast
        // before this one settles.
        await promisableTimeout(500);
        throw reason;
      }
      if (i === 2) {
        await promisableTimeout(2000);
        return item;
      }
      return item;
    };

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(20, 50),
      callback,
      { errors: 'fail-fast', bufferSize: 4 }
    );

    /** @type {unknown} */
    let caught;
    const flow = (async () => {
      try {
        // eslint-disable-next-line no-unused-vars
        for await (const _ of iterator) {
          // drain
        }
      } catch (err) {
        caught = err;
      }
    })();

    await clock.runAllAsync();
    await flow;
    chai.expect(caught).to.equal(reason);
    chai.expect(captured?.aborted).to.equal(true);
  });

  it('rejected error is the original (not AggregateError)', async () => {
    const reason = new Error('original');
    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(0).rejects(reason);

    /** @type {unknown} */
    let caught;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of bufferedAsyncMap(fromArray([0, 1, 2]), callback, { errors: 'fail-fast' })) {
        // drain
      }
    } catch (err) {
      caught = err;
    }

    await clock.runAllAsync();
    chai.expect(caught).to.equal(reason);
    chai.expect(caught).to.not.be.instanceOf(AggregateError);
  });

  it('fail-fast works in ordered:true mode', async () => {
    const reason = new Error('ordered-fail');
    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(1).rejects(reason);

    /** @type {unknown} */
    let caught;
    const flow = (async () => {
      try {
        for await (const v of bufferedAsyncMap(
          yieldValuesOverTime(10, 100),
          callback,
          { errors: 'fail-fast', ordered: true, bufferSize: 3 }
        )) {
          // drain — should yield 0 then fail on 1
          chai.expect(v).to.equal(0);
        }
      } catch (err) {
        caught = err;
      }
    })();

    await clock.runAllAsync();
    await flow;
    chai.expect(caught).to.equal(reason);
  });

  // --- Interaction with abort ---

  it('external abort wins over a fail-fast error not yet captured', async () => {
    const externalReason = new Error('external');
    const ac = new AbortController();

    let callIdx = 0;
    const callback = async (/** @type {number} */ item) => {
      const i = callIdx++;
      if (i === 0) return item;
      await promisableTimeout(2000);
      throw new Error('would-have-failed');
    };

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(10, 50),
      callback,
      { signal: ac.signal, errors: 'fail-fast', bufferSize: 2 }
    );

    const first = iterator.next();
    await clock.tickAsync(60);
    await first;

    ac.abort(externalReason);

    /** @type {unknown} */
    let caught;
    try {
      const n = iterator.next();
      await clock.runAllAsync();
      await n;
    } catch (err) {
      caught = err;
    }

    chai.expect(caught).to.equal(externalReason);
  });

  it('external abort wins over queued errors in fail-eventually mode', async () => {
    const externalReason = new Error('external');
    const ac = new AbortController();

    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(0).rejects(new Error('cb-error-A'))
      .onCall(1).rejects(new Error('cb-error-B'));

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(10, 100),
      callback,
      { signal: ac.signal, bufferSize: 3 }
    );

    // Let some items load and fail in the background; the errors get queued.
    await clock.tickAsync(50);
    ac.abort(externalReason);

    /** @type {unknown} */
    let caught;
    try {
      const n = iterator.next();
      await clock.runAllAsync();
      await n;
    } catch (err) {
      caught = err;
    }

    chai.expect(caught).to.equal(externalReason);
    chai.expect(caught).to.not.be.instanceOf(AggregateError);
  });
});

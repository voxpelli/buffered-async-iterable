/* eslint-disable promise/prefer-await-to-then */

import { getEventListeners } from 'node:events';

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  promisableTimeout,
  yieldValuesOverTime,
} from './utils.js';

/**
 * @param {number} delayBeforeFirstYield
 * @returns {AsyncIterable<number>}
 */
async function * slowSource (delayBeforeFirstYield) {
  await promisableTimeout(delayBeforeFirstYield);
  yield 0;
  await promisableTimeout(delayBeforeFirstYield);
  yield 1;
  await promisableTimeout(delayBeforeFirstYield);
  yield 2;
}

/**
 * Async generator whose `finally` block hangs forever — its `.return()`
 * runs through the `finally` and never settles, modelling a source stuck
 * in slow teardown.
 *
 * @returns {AsyncGenerator<number>}
 */
async function * wedgedSource () {
  try {
    yield 1;
    yield 2;
  } finally {
    await new Promise(() => {}); // hung forever
  }
}

chai.use(chaiAsPromised);
chai.use(sinonChai);
const should = chai.should();

describe('bufferedAsyncMap() options.signal', () => {
  /** @type {import('sinon').SinonFakeTimers} */
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    sinon.restore();
  });

  // --- Validation ---

  it('throws TypeError when signal is not an AbortSignal', () => {
    should.Throw(() => {
      bufferedAsyncMap(
        yieldValuesOverTime(1, 100),
        async (item) => item,
        // @ts-expect-error
        { signal: 'not-a-signal' }
      );
    }, TypeError, 'Expected signal to be an AbortSignal');
  });

  it('omitting signal behaves identically to commit 3 (no regression)', async () => {
    /** @type {number[]} */
    const result = [];
    const iterator = bufferedAsyncMap(yieldValuesOverTime(3, 100), async (item) => item);

    const flow = (async () => {
      for await (const v of iterator) result.push(v);
    })();

    await clock.runAllAsync();
    await flow;

    result.should.have.members([0, 1, 2]);
  });

  // --- Pre-aborted signal ---

  it('pre-aborted signal: source.next never called, first .next() rejects with reason, subsequent return done', async () => {
    const reason = new Error('Pre-aborted');
    const ac = new AbortController();
    ac.abort(reason);

    const source = yieldValuesOverTime(6, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const nextSpy = sinon.spy(sourceIterator, 'next');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item,
      { signal: ac.signal }
    );

    const first = iterator.next().catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();

    chai.expect(await first).to.deep.equal({ rejectedWith: reason });
    nextSpy.should.not.have.been.called;

    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('return() after pre-abort resolves done without throwing', async () => {
    const ac = new AbortController();
    ac.abort(new Error('Pre-aborted'));

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(3, 100),
      async (item) => item,
      { signal: ac.signal }
    );

    const ret = iterator.return();
    await clock.runAllAsync();
    await ret.should.eventually.deep.equal({ done: true, value: undefined });
  });

  // --- Mid-iteration abort ---

  it('parked .next() rejects with signal.reason (identity preserved)', async () => {
    const reason = { custom: 'reason-object' };
    const ac = new AbortController();

    const iterator = bufferedAsyncMap(
      slowSource(1000),
      async (item) => item,
      { signal: ac.signal }
    );

    const parkedNext = iterator.next().catch(err => ({ rejectedWith: err }));

    // Defer the abort to fire while the .next() is parked on the slow source.
    setTimeout(() => ac.abort(reason), 10);

    await clock.runAllAsync();

    chai.expect(await parkedNext).to.deep.equal({ rejectedWith: reason });
  });

  it('exactly one .next() rejects with reason; subsequent calls return done', async () => {
    const reason = new Error('Once');
    const ac = new AbortController();

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item) => item,
      { signal: ac.signal }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    ac.abort(reason);

    /** @type {Array<{ rejected: boolean, value?: unknown }>} */
    const results = [];

    const sequence = (async () => {
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
    await sequence;

    chai.expect(results[0]).to.deep.equal({ rejected: true, value: reason });
    chai.expect(results[1]).to.deep.equal({ rejected: false, value: { done: true, value: undefined } });
    chai.expect(results[2]).to.deep.equal({ rejected: false, value: { done: true, value: undefined } });
  });

  it('source.next not called after abort; source.return called once', async () => {
    const ac = new AbortController();

    const source = yieldValuesOverTime(20, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const nextSpy = sinon.spy(sourceIterator, 'next');
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item,
      { signal: ac.signal, bufferSize: 2 }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    const callsBeforeAbort = nextSpy.callCount;

    ac.abort(new Error('stop'));

    const next = iterator.next().catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();
    const r = await next;
    should.exist(r);

    // After the first rejecting .next() resolves, markAsEnded must have
    // already run: source.return is called as part of the abort-delivery
    // path, not deferred to the next consumer pull.
    returnSpy.should.have.been.calledOnce;

    // Drain any further calls (should be none).
    await iterator.next();
    await clock.runAllAsync();

    nextSpy.callCount.should.equal(callsBeforeAbort);
    returnSpy.should.have.been.calledOnce;
  });

  it('in-flight callbacks observe signal.aborted=true after external abort', async () => {
    const ac = new AbortController();
    /** @type {AbortSignal | undefined} */
    let captured;

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item, { signal }) => {
        captured = signal;
        return item;
      },
      { signal: ac.signal }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;
    chai.expect(captured?.aborted).to.equal(false);

    ac.abort(new Error('stop'));

    const n = iterator.next().catch(err => err);
    await clock.runAllAsync();
    await n;

    chai.expect(captured?.aborted).to.equal(true);
  });

  // --- Close races ---

  it('return() before abort makes subsequent .next() return done without throwing', async () => {
    const ac = new AbortController();
    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item) => item,
      { signal: ac.signal }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    const returned = iterator.return();
    await clock.runAllAsync();
    await returned;

    ac.abort(new Error('late'));

    const final = iterator.next();
    await clock.runAllAsync();
    await final.should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('return() and abort fired together: cleanup runs once, no double-throw', async () => {
    const ac = new AbortController();

    // 200 items so the source is not naturally exhausted between consuming
    // the first item and calling return() — that way markAsEnded actually
    // has work to do on the source iterator.
    const source = yieldValuesOverTime(200, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item,
      { signal: ac.signal, bufferSize: 2 }
    );

    const first = iterator.next();
    // Advance only enough for the first item to land, leaving the source live.
    await clock.tickAsync(0);
    await first;

    const ret = iterator.return();
    ac.abort(new Error('parallel'));

    await clock.runAllAsync();
    await ret;

    returnSpy.should.have.been.calledOnce;
  });

  it('throw(err) after abort delivered behaves like throw on a closed iterator', async () => {
    const ac = new AbortController();
    const reason = new Error('aborted');
    const tossed = new Error('post-abort throw');

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item) => item,
      { signal: ac.signal }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    ac.abort(reason);

    const aborted = iterator.next().catch(err => err);
    await clock.runAllAsync();
    await aborted;

    const tossedNext = iterator.throw(tossed).catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();
    chai.expect(await tossedNext).to.deep.equal({ rejectedWith: tossed });
  });

  // --- ordered:true coverage ---

  it('abort works in ordered:true mode', async () => {
    const ac = new AbortController();
    const reason = new Error('ordered-abort');

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item) => item,
      { signal: ac.signal, ordered: true }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    ac.abort(reason);

    const next = iterator.next().catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();
    chai.expect(await next).to.deep.equal({ rejectedWith: reason });

    const after = iterator.next();
    await clock.runAllAsync();
    await after.should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('delivers exactly one rejection when an abort races the drain-throw', async () => {
    // The window: fail-eventually captured an error and the buffer drained;
    // an external abort landing in the await-gap between error capture and
    // the drain-throw must not produce a second rejection (pre-fix: the
    // captured error was thrown AND the following next() rejected with the
    // abort reason). Sweep the abort across microtask offsets so the spec
    // pins the invariant at every interleaving, not one brittle hop count.
    for (let hops = 0; hops <= 10; hops++) {
      const ac = new AbortController();
      const reason = new Error(`abort-at-${hops}`);
      const cbError = new Error(`cb-${hops}`);

      const iterator = bufferedAsyncMap(['only'], async () => { throw cbError; }, {
        bufferSize: 1,
        signal: ac.signal,
      });

      // Land the abort behind `hops` microtask boundaries — varying points
      // inside nextValue's internal await chain.
      const abortTask = (async () => {
        for (let i = 0; i < hops; i++) {
          await Promise.resolve();
        }
        ac.abort(reason);
      })();

      /** @type {Array<{ rejected: boolean, value?: unknown }>} */
      const outcomes = [];
      for (let i = 0; i < 3; i++) {
        try {
          const r = await iterator.next();
          outcomes.push({ rejected: false, value: r });
        } catch (err) {
          outcomes.push({ rejected: true, value: err });
        }
      }
      await abortTask;

      const rejections = outcomes.filter(o => o.rejected);
      rejections.should.have.length(1, `offset ${hops} saw ${rejections.length} rejections`);

      const firstReject = outcomes.findIndex(o => o.rejected);
      for (const o of outcomes.slice(firstReject + 1)) {
        o.should.deep.equal({ rejected: false, value: { done: true, value: undefined } });
      }
    }
  });

  it('suppresses an undelivered abort once the consumer explicitly closes via return()', async () => {
    const ac = new AbortController();
    const iterator = bufferedAsyncMap(['a', 'b', 'c'], async (item) => item, { signal: ac.signal });

    await iterator.next();

    // Abort fires between pulls (no next() pending), but the consumer
    // reacts by closing the iterator instead of pulling again.
    ac.abort(new Error('stale'));
    await iterator.return().should.eventually.deep.equal({ done: true, value: undefined });

    // Native AsyncGenerator semantics: next() after return() is done —
    // pre-fix this rejected with the stale abort reason through a closed
    // iterator.
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('suppresses an undelivered abort once the consumer explicitly closes via throw()', async () => {
    const ac = new AbortController();
    const consumerError = new Error('consumer-throw');
    const iterator = bufferedAsyncMap(['a', 'b'], async (item) => item, { signal: ac.signal });

    await iterator.next();
    ac.abort(new Error('stale'));

    const thrown = await iterator.throw(consumerError).catch(err => ({ rejectedWith: err }));
    chai.expect(thrown).to.deep.equal({ rejectedWith: consumerError });

    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('suppresses a pre-aborted signal once the consumer closes before pulling', async () => {
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));

    const iterator = bufferedAsyncMap(['a'], async (item) => item, { signal: ac.signal });

    await iterator.return().should.eventually.deep.equal({ done: true, value: undefined });
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  // --- external-signal listener lifecycle ---

  it('detaches its external-signal abort listener when the iterator closes', async () => {
    const ac = new AbortController();

    // Several sequential short-lived iterators sharing one long-lived signal —
    // the standard server pattern. Each must remove its listener on close
    // (natural drain and early return() alike), or the signal retains every
    // closed iterator's state machine until the signal itself aborts / is GC'd.
    for (let i = 0; i < 5; i++) {
      const iterator = bufferedAsyncMap(['a', 'b'], async (item) => item, { signal: ac.signal });

      getEventListeners(ac.signal, 'abort').length.should.equal(1);

      if (i % 2 === 0) {
        // Timer-free array source, so the inline for-await is safe under fake timers
        // eslint-disable-next-line no-unused-vars, no-empty
        for await (const _value of iterator) {}
      } else {
        await iterator.return();
      }
    }

    getEventListeners(ac.signal, 'abort').length.should.equal(0);
  });

  // --- cleanupTimeout ---

  it('cleanupTimeout caps the wait for a wedged source.return()', async () => {
    const ac = new AbortController();
    const reason = new Error('abort');
    const iterator = bufferedAsyncMap(
      wedgedSource(),
      async (item) => item,
      { signal: ac.signal, bufferSize: 1, cleanupTimeout: 50 }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    ac.abort(reason);

    const next = iterator.next().catch(err => ({ rejectedWith: err }));
    // Advance past the cleanupTimeout — without it the parked .next() would
    // hang on markAsEnded forever.
    await clock.tickAsync(60);
    chai.expect(await next).to.deep.equal({ rejectedWith: reason });
  });

  it('cleanupTimeout clears its timer when cleanup wins the race', async () => {
    // A well-behaved source whose .return() settles promptly: cleanup wins the
    // race well before cleanupTimeout. The timer must be cleared, not left
    // pending — otherwise it keeps the event loop alive for the full window
    // after the iterator has already closed.
    const timersBefore = clock.countTimers();
    const iterator = bufferedAsyncMap(
      ['a', 'b', 'c'],
      async (item) => item,
      { bufferSize: 1, cleanupTimeout: 100_000 }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    // Close the iterator. The source's .return() resolves via microtasks, so
    // the race settles without the clock ever reaching cleanupTimeout.
    await iterator.return();

    // No leftover timer: the 100s cleanupTimeout was cleared in markAsEnded's
    // finally. Asserted as a delta against the pre-construction count so the
    // spec pins "close leaves no timer behind", not "nothing else in the
    // process owns a timer right now".
    (clock.countTimers() - timersBefore).should.equal(0);
  });

  it('default (no cleanupTimeout) still waits forever for a wedged source', async () => {
    // Sanity check that the unbounded default behaviour is preserved when
    // the option is left undefined.
    const ac = new AbortController();
    const iterator = bufferedAsyncMap(
      wedgedSource(),
      async (item) => item,
      { signal: ac.signal, bufferSize: 1 }
    );

    const first = iterator.next();
    await clock.runAllAsync();
    await first;

    ac.abort(new Error('abort'));

    // Race the next() against a finite tick. Without the option, the
    // parked next() never settles because markAsEnded awaits the wedged
    // source.return().
    let settled = false;
    const next = iterator.next().finally(() => { settled = true; });
    next.catch(() => {}); // attach a no-op handler — we never await it
    await clock.tickAsync(10_000);

    settled.should.equal(false);
  });
});

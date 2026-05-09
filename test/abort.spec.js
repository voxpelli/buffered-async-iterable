/* eslint-disable promise/prefer-await-to-then */

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

  it('fresh .next() after abort rejects with reason', async () => {
    const reason = new Error('Aborted');
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

    const next = iterator.next().catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();
    chai.expect(await next).to.deep.equal({ rejectedWith: reason });
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
});

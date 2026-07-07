/* eslint-disable promise/prefer-await-to-then, unicorn/no-thenable -- thenable hybrids and rejection envelopes are the hostile shapes under test */

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  collectNextOutcomes,
  expectSingleRejectionThenDone,
  unwrapCapturedError,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.should();

/**
 * A source whose n:th result object is hostile (throwing getter / Proxy
 * trap); every result before it is a plain value. All timer-free — these
 * specs run without fake timers.
 *
 * @param {number} hostileAt zero-based index of the hostile result
 * @param {() => object} makeHostile
 * @param {{ 'return'?: import('sinon').SinonStub }} [hooks]
 * @returns {AsyncIterable<string>}
 */
function sourceWithHostileResult (hostileAt, makeHostile, hooks = {}) {
  let i = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const index = i++;
        if (index === hostileAt) return /** @type {*} */ (makeHostile());
        if (index > hostileAt + 4) return { done: true, value: undefined };
        return { done: false, value: `item${index}` };
      },
      'return': hooks.return ?? (async () => ({ done: true, value: undefined })),
    }),
  };
}

describe('bufferedAsyncMap() hostile iterator results', () => {
  // Envelope pipeline contract: no foreign-object read may reject a buffer
  // slot. Native for-await parity: IteratorComplete/IteratorValue are
  // ?-propagating, so a throwing done/value getter surfaces as a consumer
  // error — never as an unhandledRejection or an infinite rejection loop.

  it('routes a throwing done-getter through fail-eventually (single identity rejection, cleanup runs)', async () => {
    const doneErr = new Error('done-getter boom');
    const sourceReturn = sinon.stub().resolves({ done: true, value: undefined });
    /** @type {AbortSignal | undefined} */
    let capturedSignal;

    const iterator = bufferedAsyncMap(
      sourceWithHostileResult(1, () => ({ get done () { throw doneErr; } }), { 'return': sourceReturn }),
      async (item, { signal }) => {
        capturedSignal = signal;
        return item;
      },
      { bufferSize: 1 }
    );

    const outcomes = await collectNextOutcomes(iterator, 4);

    // Pre-fix: EVERY next() rejected with the same error forever, the source
    // was never closed and the per-callback signal never aborted.
    expectSingleRejectionThenDone(outcomes, doneErr);
    sourceReturn.should.have.been.calledOnce;
    chai.expect(capturedSignal?.aborted).to.equal(true);
  });

  it('routes a throwing done-getter through fail-fast (identity, then done)', async () => {
    const doneErr = new Error('done-getter fail-fast');

    const iterator = bufferedAsyncMap(
      sourceWithHostileResult(1, () => ({ get done () { throw doneErr; } })),
      async (item) => item,
      { bufferSize: 1, errors: 'fail-fast' }
    );

    const outcomes = await collectNextOutcomes(iterator, 4);
    expectSingleRejectionThenDone(outcomes, doneErr);
  });

  it('does not emit unhandledRejection when a hostile slot is spliced un-raced', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    /** @type {(reason: unknown) => void} */
    const listener = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);

    try {
      // ordered:true + immediate return(): the hostile slots are spliced by
      // cleanup without ever being raced. (In unordered mode a prior next()
      // races every slot and would swallow the rejection — this is the
      // un-raced shape that crashed the process pre-fix.)
      const iterator = bufferedAsyncMap(
        sourceWithHostileResult(0, () => new Proxy({}, { has () { throw new Error('has-trap'); } })),
        async (item) => item,
        { bufferSize: 4, ordered: true }
      );
      await iterator.return();
      // Let any stray rejection reach the process listener.
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listener);
    }

    unhandled.should.be.an('array').with.length(0);
  });

  it('routes a Proxy has-trap result through the errors mode (main arm)', async () => {
    const trapErr = new Error('main has-trap');

    const iterator = bufferedAsyncMap(
      sourceWithHostileResult(1, () => new Proxy({}, { has () { throw trapErr; } })),
      async (item) => item,
      { bufferSize: 1 }
    );

    const outcomes = await collectNextOutcomes(iterator, 4);
    expectSingleRejectionThenDone(outcomes, trapErr);
  });

  it('routes a Proxy has-trap result through the errors mode (sub-iterator arm)', async () => {
    const trapErr = new Error('sub has-trap');

    /** @type {(item: string) => AsyncIterable<string>} */
    const callback = () => ({
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () => i++ === 0
            ? { done: false, value: 'sub0' }
            : /** @type {*} */ (new Proxy({}, { has () { throw trapErr; } })),
        };
      },
    });

    const flow = (async () => {
      /** @type {string[]} */
      const collected = [];
      for await (const value of bufferedAsyncMap(['a'], callback, { bufferSize: 1 })) {
        collected.push(value);
      }
      return collected;
    })()
      .then(
        () => { throw new Error('Expected a rejection'); },
        err => ({ rejectedWith: err })
      );

    const outcome = await flow;
    chai.expect(unwrapCapturedError(outcome.rejectedWith)).to.equal(trapErr);
  });

  it('attributes a throwing value-getter to the source read, not the callback, and still closes the source', async () => {
    const sourceReturn = sinon.stub().resolves({ done: true, value: undefined });
    const callback = sinon.stub().resolvesArg(0);

    const iterator = bufferedAsyncMap(
      sourceWithHostileResult(1, () => ({
        done: false,
        get value () {
          // eslint-disable-next-line no-throw-literal
          throw 'value-getter boom';
        },
      }), { 'return': sourceReturn }),
      callback,
      { bufferSize: 1 }
    );

    const outcomes = await collectNextOutcomes(iterator, 3);
    const rejection = /** @type {Error} */ (outcomes.find(o => o.rejected)?.value);

    // Pre-fix the throw was accidentally caught by the callback-dispatch try
    // and labeled 'Unknown callback error' while the source stayed open.
    rejection.message.should.equal('Failed to read source iterator next() result');
    chai.expect(rejection.cause).to.equal('value-getter boom');
    sourceReturn.should.have.been.calledOnce;
  });

  it('yields the resolution of a thenable async-iterable hybrid callback result', async () => {
    // `await callbackResult` unwraps via .then, so the awaited value is NOT
    // the iterable that was dispatched — the re-check must yield it as a
    // plain value (pinned so the throw-safe re-check can never regress this).
    const hybrid = {
      async * [Symbol.asyncIterator] () {
        yield 'never-seen';
      },
      /** @param {(v: string) => void} resolve */
      then (resolve) {
        resolve('FROM-THEN');
      },
    };
    /** @type {(item: string) => *} */
    const callback = () => hybrid;

    /** @type {string[]} */
    const collected = [];
    for await (const value of bufferedAsyncMap(['a'], callback)) {
      collected.push(value);
    }

    collected.should.deep.equal(['FROM-THEN']);
  });

  it('routes a hybrid resolving to a throwing-has Proxy through the errors mode', async () => {
    const recheckErr = new Error('recheck-has boom');
    /** @type {(item: string) => *} */
    const callback = () => ({
      async * [Symbol.asyncIterator] () {
        yield 'never-seen';
      },
      /** @param {(v: unknown) => void} resolve */
      then (resolve) {
        resolve(new Proxy({}, { has () { throw recheckErr; } }));
      },
    });

    const flow = (async () => {
      // eslint-disable-next-line no-unused-vars, no-empty
      for await (const _value of bufferedAsyncMap(['a'], callback)) {}
    })()
      .then(
        () => { throw new Error('Expected a rejection'); },
        err => ({ rejectedWith: err })
      );

    const outcome = await flow;
    chai.expect(unwrapCapturedError(outcome.rejectedWith)).to.equal(recheckErr);
  });

  it('yields a callback result whose [Symbol.asyncIterator]() returns null instead of livelocking', async () => {
    // Pre-fix a falsy iterator entered subIterators and the refill loop
    // starved the event loop permanently (process needed SIGKILL).
    const hybrid = {
      // eslint-disable-next-line unicorn/no-null -- the falsy-iterator return is exactly the hostile shape under test
      [Symbol.asyncIterator]: () => null,
    };
    /** @type {(item: string) => *} */
    const callback = () => hybrid;

    /** @type {unknown[]} */
    const collected = [];
    for await (const value of bufferedAsyncMap(['a'], callback)) {
      collected.push(value);
    }

    collected.should.deep.equal([hybrid]);
  });

  it('closes a sub-iterator exactly once when several in-flight pulls all resolve malformed', async () => {
    const subReturn = sinon.stub().resolves({ done: true, value: undefined });

    /** @type {AsyncIterable<string>} */
    const subIterable = {
      [Symbol.asyncIterator]: () => ({
        next: async () => /** @type {*} */ (42),
        'return': subReturn,
      }),
    };

    // The source's FIRST next() is delayed so its done-terminals are
    // consumed first — the buffer is then EMPTY when the sub-iterator
    // registers, and fillQueue dispatches four sub pulls in one synchronous
    // pass, before the first malformed handler can retire the sub-iterator
    // from the rotation. Pre-fix each of the four pushed a duplicate
    // pendingCloses entry → four .return() calls.
    let mainPulls = 0;
    /** @type {AsyncIterable<string>} */
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          mainPulls += 1;
          if (mainPulls === 1) {
            await new Promise(resolve => { setTimeout(resolve, 20); });
            return { done: false, value: 'x' };
          }
          return { done: true, value: undefined };
        },
      }),
    };

    // The callback returns the AsyncIterable directly (not via an async
    // wrapper) so the sub-iterator path engages.
    const iterator = bufferedAsyncMap(source, () => subIterable, { bufferSize: 4 });

    const outcomes = await collectNextOutcomes(iterator, 10);
    outcomes.some(o => o.rejected).should.equal(true);

    subReturn.should.have.been.calledOnce;
  });
});

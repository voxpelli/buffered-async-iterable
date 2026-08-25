/* eslint-disable promise/prefer-await-to-then, unicorn/no-thenable -- thenable hybrids and rejection envelopes are the hostile shapes under test */

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  callableAsyncIterable,
  collectNextOutcomes,
  expectSingleRejectionThenDone,
  promisableTimeout,
  unwrapCapturedError,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.should();

/**
 * A source whose n:th result object is hostile (throwing getter / Proxy
 * trap); every result before it is a plain value. Timer-free itself; this
 * file runs WITHOUT sinon fake timers (one spec uses a real 20 ms delay —
 * adding fake timers here would deadlock it).
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

/** @type {(item: string) => *} */
const truthyNonObjectIteratorCallback = () => ({ [Symbol.asyncIterator]: () => 42 });

/**
 * A data object that merely carries a non-callable Symbol.asyncIterator member.
 *
 * @returns {*}
 */
const nonCallableMemberShape = () => ({ [Symbol.asyncIterator]: undefined, tag: 'data' });

/**
 * An IteratorResult proxy that answers every unknown key — the private ERR
 * symbol included — with a fresh same-realm Error while forwarding the real
 * done/value reads. The strongest envelope spoof a foreign result can mount.
 *
 * @returns {object}
 */
const makeSpoofEnvelope = () => new Proxy({ done: false, value: 'real' }, {
  has: () => true,
  get: (t, k) => k in t ? t[/** @type {keyof typeof t} */ (k)] : new Error('spoofed'),
});

/** @returns {AsyncGenerator<string>} */
async function * innerPair () {
  yield 'i1';
  yield 'i2';
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

  it('is not fooled by a Proxy has-trap that lies about the internal error tag (main arm)', async () => {
    // A has-trap answering `true` for every key spoofs the private ERR
    // symbol check. Pre-fix that classified the result as an internal
    // error envelope with an `undefined` error: iteration ended silently
    // mid-stream and the still-open source was never .return()ed. The
    // brand-verify makes it fall through to the done/value reads — native
    // for-await parity: falsy `done`, yield the (undefined) `value`.
    const sourceReturn = sinon.stub().resolves({ done: true, value: undefined });

    const iterator = bufferedAsyncMap(
      sourceWithHostileResult(1, () => new Proxy({}, { has: () => true }), { 'return': sourceReturn }),
      async (item) => item,
      { bufferSize: 1 }
    );

    /** @type {unknown[]} */
    const seen = [];
    for await (const value of iterator) {
      seen.push(value);
      if (seen.length === 2) break;
    }

    seen.should.deep.equal(['item0', undefined]);
    sourceReturn.should.have.been.calledOnce;
  });

  it('is not fooled by a Proxy has-trap that lies about the internal error tag (sub-iterator arm)', async () => {
    let n = 0;
    /** @type {(item: string) => AsyncIterable<string>} */
    const callback = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          n += 1;
          if (n === 1) return { done: false, value: 'sub-1' };
          if (n === 2) return /** @type {*} */ (new Proxy({}, { has: () => true }));
          return { done: true, value: undefined };
        },
      }),
    });

    /** @type {unknown[]} */
    const seen = [];
    for await (const value of bufferedAsyncMap(['a'], callback, { bufferSize: 1 })) {
      seen.push(value);
    }

    // Pre-fix the lying proxy silently terminated the sub-iterator after
    // 'sub-1'; the spoof-proof classification yields the proxied
    // (undefined) value and keeps pulling to the real done.
    seen.should.deep.equal(['sub-1', undefined]);
  });

  it('is not fooled by a get-trap answering the error tag with a same-realm Error (main arm)', async () => {
    // Stronger spoof than a lying has-trap alone: the get-trap answers the
    // private ERR symbol with a genuine Error instance. Pre-fix the
    // instanceof brand accepted it — the real value was dropped, the
    // spoofed Error surfaced as a stream error, and (classified as a
    // protocol-closed rejection) the source was never .return()ed. The
    // WeakSet brand makes it fall through to the done/value reads, exactly
    // like native for-await: 'real' is delivered.
    /** @type {unknown[]} */
    const seen = [];
    for await (const value of bufferedAsyncMap(sourceWithHostileResult(1, makeSpoofEnvelope), async (item) => item, { bufferSize: 1 })) {
      seen.push(value);
    }

    chai.expect(seen[1]).to.equal('real');
    seen.length.should.be.greaterThan(2); // iteration continued past the spoof
  });

  it('is not fooled by a get-trap answering the error tag with a same-realm Error (sub-iterator arm)', async () => {
    let n = 0;
    /** @type {(item: string) => AsyncIterable<string>} */
    const callback = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          n += 1;
          if (n === 1) return /** @type {*} */ (makeSpoofEnvelope());
          return { done: true, value: undefined };
        },
      }),
    });

    /** @type {unknown[]} */
    const seen = [];
    for await (const value of bufferedAsyncMap(['a'], callback, { bufferSize: 1 })) {
      seen.push(value);
    }

    seen.should.deep.equal(['real']);
  });

  it('fans out a callback-result Proxy whose has-trap denies the member the get-trap provides', async () => {
    // GetMethod consults only [[Get]]; `for await` iterates this proxy. A
    // dispatch gate probing with `in` (has-trap says no) delivered the raw
    // proxy as a plain value instead — the gate must classify by [[Get]].
    const proxy = new Proxy({}, {
      has: () => false,
      get: (_t, k) => k === Symbol.asyncIterator ? () => innerPair() : undefined,
    });

    /** @type {unknown[]} */
    const seen = [];
    for await (const value of bufferedAsyncMap(['a'], () => /** @type {*} */ (proxy))) {
      seen.push(value);
    }

    seen.should.deep.equal(['i1', 'i2']);
  });

  it('reads a foreign return member once at cleanup and invokes the captured method', async () => {
    // A stateful getter (method on the first read, gone on the second) must
    // still get its cleanup: truthy-check-then-reinvoke read it twice and
    // silently invoked nothing.
    let reads = 0;
    let invoked = 0;
    const iterator = {
      next: async () => new Promise(() => {}), // wedged — close happens while open
      get 'return' () {
        reads += 1;
        if (reads === 1) {
          return async () => {
            invoked += 1;
            return { done: true, value: undefined };
          };
        }
      },
    };

    const buffered = bufferedAsyncMap({ [Symbol.asyncIterator]: () => /** @type {*} */ (iterator) }, async (/** @type {*} */ x) => x, { bufferSize: 1 });
    const pull = buffered.next().catch(() => {});
    await promisableTimeout(10);
    await buffered.return();
    await pull;

    reads.should.equal(1);
    invoked.should.equal(1);
  });

  it('returns a shared iterator exactly once when two items resolve to the same iterable', async () => {
    let returns = 0;
    const shared = /** @type {*} */ ({
      [Symbol.asyncIterator] () { return this; },
      next: async () => new Promise(() => {}), // never yields
      'return': async () => {
        returns += 1;
        return { done: true, value: undefined };
      },
    });

    const iterator = bufferedAsyncMap([0, 1], () => shared, { bufferSize: 2 });
    const pull = iterator.next().catch(() => {});
    await promisableTimeout(10);
    await iterator.return();
    await pull;

    returns.should.equal(1);
  });

  it('accepts a callable IteratorResult, matching for-await (spec Object includes functions)', async () => {
    // ECMA-262 only requires Type(result) is Object — function objects
    // qualify. Pre-fix `isObject` rejected them as malformed while native
    // for-await yields their value.
    const fnResult = /** @type {*} */ (Object.assign(() => {}, { done: false, value: 'callable-x' }));
    let n = 0;
    /** @type {AsyncIterable<string>} */
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => (++n === 1 ? fnResult : { done: true, value: undefined }),
      }),
    };

    /** @type {unknown[]} */
    const seen = [];
    for await (const value of bufferedAsyncMap(source, async (item) => item, { bufferSize: 1 })) {
      seen.push(value);
    }

    seen.should.deep.equal(['callable-x']);
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

  it('yields a hybrid resolving to a throwing-has Proxy (GetMethod: only [[Get]] is consulted)', async () => {
    // The dispatch does a single [[Get]] of the member — a has-trap is
    // never invoked (GetMethod parity). This proxy's untrapped get forwards
    // to the empty target: nullish member, so the resolution is plain data.
    const hostileProxy = new Proxy({}, { has () { throw new Error('has must not be consulted'); } });
    /** @type {(item: string) => *} */
    const callback = () => ({
      async * [Symbol.asyncIterator] () {
        yield 'never-seen';
      },
      /** @param {(v: unknown) => void} resolve */
      then (resolve) {
        resolve(hostileProxy);
      },
    });

    /** @type {unknown[]} */
    const collected = [];
    for await (const value of bufferedAsyncMap(['a'], callback)) {
      collected.push(value);
    }

    collected.should.deep.equal([hostileProxy]);
  });

  it('routes a hybrid resolving to a Proxy whose member read throws through the errors mode', async () => {
    const recheckErr = new Error('recheck-get boom');
    /** @type {(item: string) => *} */
    const callback = () => ({
      async * [Symbol.asyncIterator] () {
        yield 'never-seen';
      },
      /** @param {(v: unknown) => void} resolve */
      then (resolve) {
        resolve(new Proxy({}, { get () { throw recheckErr; } }));
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

  it('surfaces a branded TypeError when [Symbol.asyncIterator]() returns null, without livelocking', async () => {
    // The original defect: a falsy iterator entered subIterators and the
    // refill loop starved the event loop permanently (process needed
    // SIGKILL). GetMethod parity: a CALLABLE member whose invocation
    // returns a non-object is the same protocol violation it is for
    // for-await — a branded TypeError through the errors mode, never a
    // livelock and never silently treated as data.
    const hybrid = {
      // eslint-disable-next-line unicorn/no-null -- the falsy-iterator return is exactly the hostile shape under test
      [Symbol.asyncIterator]: () => null,
    };
    /** @type {(item: string) => *} */
    const callback = () => hybrid;

    const outcomes = await collectNextOutcomes(bufferedAsyncMap(['a'], callback), 3);

    const rejections = outcomes.filter(o => o.rejected);
    rejections.should.have.length(1);
    const err = unwrapCapturedError(rejections[0]?.value);
    err.should.be.instanceOf(TypeError);
    err.message.should.equal('Expected the callback result Symbol.asyncIterator method to return an object');
  });

  it('surfaces the same branded TypeError for a truthy non-object iterator', async () => {
    // Pre-fix the truthy sibling (`() => 42`) took a different path: 42
    // entered subIterators and the failure surfaced later as an unbranded
    // 'Unknown subiterator error' wrapping "iterator.next is not a
    // function". Falsy and truthy non-objects now fail identically.
    const outcomes = await collectNextOutcomes(bufferedAsyncMap(['a'], truthyNonObjectIteratorCallback), 3);

    const rejections = outcomes.filter(o => o.rejected);
    rejections.should.have.length(1);
    const err = unwrapCapturedError(rejections[0]?.value);
    err.should.be.instanceOf(TypeError);
    err.message.should.equal('Expected the callback result Symbol.asyncIterator method to return an object');
  });

  it('yields a result with a non-callable Symbol.asyncIterator member, from sync and async callbacks alike', async () => {
    // GetMethod: a nullish/non-callable member means "not async iterable" —
    // the result is plain data. Pre-fix the sync-callback path (dispatch
    // sees the raw object) threw an unbranded TypeError while the
    // async-callback path (dispatch sees the promise) yielded the object.
    for (const callback of [() => nonCallableMemberShape(), async () => nonCallableMemberShape()]) {
      /** @type {*[]} */
      const collected = [];
      for await (const value of bufferedAsyncMap(['a'], /** @type {*} */ (callback))) {
        collected.push(value);
      }

      collected.should.have.length(1);
      collected[0].should.have.property('tag', 'data');
    }
  });

  it('fans out a callable callback result carrying Symbol.asyncIterator (for-await parity)', async () => {
    // ECMA "Type(x) is Object" includes functions, so `for await (… of fn)`
    // iterates a function carrying a callable Symbol.asyncIterator. The
    // dispatch-time gate has to agree with the consume-time GetMethod read,
    // which already accepts callables — otherwise this is silently delivered
    // as a plain value instead of being fanned out.
    /** @type {*[]} */
    const collected = [];
    for await (const value of bufferedAsyncMap(['x'], () => callableAsyncIterable)) {
      collected.push(value);
    }

    collected.should.deep.equal(['a', 'b']);
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
            await promisableTimeout(20);
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

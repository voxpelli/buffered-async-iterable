import chai from 'chai';
import sinon from 'sinon';

import {
  bufferedAsyncMap,
  mergeIterables,
} from '../index.js';
import {
  collectNextOutcomes,
  expectSingleRejectionThenDone,
  promisableTimeout,
  stubAsyncIterator,
  unwrapCapturedError,
  yieldValuesOverTime,
} from './utils.js';

chai.should();

/**
 * The delivered (non-rejected, non-done) values from a collectNextOutcomes run.
 *
 * @param {Array<{ rejected: boolean, value: unknown }>} outcomes
 * @returns {unknown[]}
 */
const deliveredValues = (outcomes) => outcomes
  .filter(o => !o.rejected)
  .map(o => /** @type {{ value: unknown }} */ (o.value).value)
  .filter(v => v !== undefined);

/**
 * Builds an eager iterator over [0, 1] where item 0's generator is slow (keeps
 * the head occupied) and item 1's is unbounded, counting its steps. The callback
 * is an async generator *function* so both items actually fan out (an async arrow
 * returning a generator would be delivered as a plain value and never stepped).
 *
 * @param {import('sinon').SinonSpy} stepSpy
 * @param {number} [lookahead]
 * @returns {import('../index.js').BufferedAsyncIterableIterator<string>}
 */
function unboundedNonHeadIterator (stepSpy, lookahead) {
  /**
   * @param {number} item
   * @returns {AsyncGenerator<string>}
   */
  async function * callback (item) {
    if (item === 0) {
      await promisableTimeout(1000);
      yield 'head';
      return;
    }
    // Non-head lane: unbounded — bounded to `lookahead` steps while not head.
    while (true) {
      stepSpy();
      yield 'x';
      await promisableTimeout(1);
    }
  }

  return bufferedAsyncMap([0, 1], callback, { bufferSize: 6, ordered: 'eager', ...(lookahead === undefined ? {} : { lookahead }) });
}

// ─────────────────────────────────────────────────────────────────────────
// `ordered: 'eager'` — concurrent callback dispatch with in-order delivery
// (contract in ADVANCED.md, "Ordered mode"). The first block covers option
// handling; the second exercises delivery/concurrency/backpressure/abort/error.
// ─────────────────────────────────────────────────────────────────────────

describe("bufferedAsyncMap() ordered: 'eager'", () => {
  describe('option handling', () => {
    it("accepts ordered: 'eager' at construction", () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: 'eager' })).should.not.throw();
    });

    it("accepts ordered: 'eager' for mergeIterables", () => {
      (() => mergeIterables([[1, 2, 3]], { ordered: 'eager' })).should.not.throw();
    });

    it('rejects a non-boolean, non-"eager" ordered value', () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: /** @type {*} */ ('nope') }))
        .should.throw(TypeError, "Expected ordered to be a boolean or 'eager'");
    });

    it('still accepts the existing boolean ordered values', () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: true })).should.not.throw();
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: false })).should.not.throw();
    });

    it('accepts a positive-integer lookahead with ordered: \'eager\'', () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: 'eager', lookahead: 3 })).should.not.throw();
    });

    it('rejects a non-positive-integer lookahead', () => {
      for (const bad of [0, -1, 1.5, /** @type {*} */ ('x')]) {
        (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: 'eager', lookahead: bad }))
          .should.throw(TypeError, 'Expected lookahead to be a positive integer');
      }
    });

    it("rejects lookahead unless ordered is 'eager'", () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: true, lookahead: 2 }))
        .should.throw(TypeError, "Expected lookahead to be used only with ordered: 'eager'");
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: false, lookahead: 2 }))
        .should.throw(TypeError, "Expected lookahead to be used only with ordered: 'eager'");
    });
  });

  describe('behaviour', () => {
    const count = 6;

    /** @type {import('sinon').SinonFakeTimers} */
    let clock;

    beforeEach(() => {
      clock = sinon.useFakeTimers();
    });

    afterEach(() => {
      sinon.restore();
    });

    /**
     * Drains a generator workload whose per-item work happens before the first
     * yield, returning the collected values plus the wall-clock at completion.
     *
     * @param {'eager'|true} orderedOpt
     * @returns {Promise<[number[], number]>}
     */
    const runGeneratorWorkload = (orderedOpt) => (async () => {
      /** @type {number[]} */
      const out = [];
      for await (const value of bufferedAsyncMap(yieldValuesOverTime(count, () => 1), async function * (item) {
        await promisableTimeout(50); // work before the first yield
        yield item;
      }, { bufferSize: 6, ordered: orderedOpt })) {
        out.push(value);
      }
      /** @type {[number[], number]} */
      const result = [out, Date.now()];
      return result;
    })();

    it('runs async-generator callbacks concurrently (maxInFlight === bufferSize)', async () => {
      const source = yieldValuesOverTime(count, () => 1);

      let inFlight = 0;
      let maxInFlight = 0;

      // Unlike ordered:true (which serialises generator bodies — maxInFlight
      // stays 1), eager steps every lane toward its first yield concurrently.
      const flow = (async () => {
        /** @type {number[]} */
        const out = [];
        for await (const value of bufferedAsyncMap(source, async function * (item) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await promisableTimeout(50);
          yield item;
          inFlight--;
        }, { bufferSize: 6, ordered: 'eager' })) {
          out.push(value);
        }
        return out;
      })();

      await clock.runAllAsync();
      const out = await flow;

      out.should.deep.equal([0, 1, 2, 3, 4, 5]); // in-order delivery
      maxInFlight.should.equal(6);               // concurrent dispatch
    });

    it('delivers in strict source order despite out-of-order completion', async () => {
      // Item 0 is much slower than the rest; eager must still yield 0..5 in order.
      const flow = (async () => {
        /** @type {number[]} */
        const out = [];
        for await (const value of bufferedAsyncMap(yieldValuesOverTime(count, () => 1), async (item) => {
          await promisableTimeout(item === 0 ? 500 : 10);
          return item;
        }, { bufferSize: 6, ordered: 'eager' })) {
          out.push(value);
        }
        return out;
      })();

      await clock.runAllAsync();
      const out = await flow;
      out.should.deep.equal([0, 1, 2, 3, 4, 5]);
    });

    it('completes faster than ordered:true for the same generator workload', async () => {
      const eagerFlow = runGeneratorWorkload('eager');
      await clock.runAllAsync();
      const [eagerOut, eagerDuration] = await eagerFlow;

      const orderedFlow = runGeneratorWorkload(true);
      await clock.runAllAsync();
      const [orderedOut, orderedDuration] = await orderedFlow;

      eagerOut.should.deep.equal(orderedOut);            // identical observable order
      eagerDuration.should.be.lessThan(orderedDuration); // eager overlaps the pre-yield work
    });

    it('bounds look-ahead: an unbounded non-head generator is stepped at most once ahead (default lookahead 1)', async () => {
      const stepSpy = sinon.spy();
      const iterator = unboundedNonHeadIterator(stepSpy);

      const flow = (async () => {
        await iterator.next();
      })();

      // Advance, but not enough for the head to finish.
      await clock.tickAsync(500);
      stepSpy.callCount.should.equal(1);

      await clock.runAllAsync();
      await flow;
      await iterator.return?.();
    });

    it('respects a custom lookahead: a non-head generator buffers exactly lookahead values ahead', async () => {
      const stepSpy = sinon.spy();
      const iterator = unboundedNonHeadIterator(stepSpy, 3);

      const flow = (async () => {
        await iterator.next();
      })();

      // While the head is still occupied, the non-head lane fills to lookahead
      // (3) and then parks — proving the knob raises the bound but stays bounded.
      await clock.tickAsync(500);
      stepSpy.callCount.should.equal(3);

      await clock.runAllAsync();
      await flow;
      await iterator.return?.();
    });

    it('runs cleanup (finally) for every live lane on early return', async () => {
      /** @type {number[]} */
      const cleaned = [];

      const iterator = bufferedAsyncMap(yieldValuesOverTime(count, () => 1), async function * (item) {
        try {
          await promisableTimeout(100);
          yield item;
        } finally {
          cleaned.push(item);
        }
      }, { bufferSize: 6, ordered: 'eager' });

      const flow = (async () => {
        await iterator.next();      // pull one value
        await iterator.return?.();  // close early while later lanes are in flight
      })();

      await clock.runAllAsync();
      await flow;

      // Every lane that was admitted ran its finally exactly once.
      cleaned.should.have.members([0, 1, 2, 3, 4, 5]);
    });

    it('returns a non-head lane still holding buffered values on early close (lookahead > 1)', async () => {
      const stepSpy = sinon.spy();
      /** @type {number[]} */
      const cleaned = [];

      // Item 0's slow head keeps item 1 off the delivery head, so item 1 fills
      // its buffer to lookahead (3) and parks. Closing early must still
      // .return() that buffered non-head lane — its finally runs exactly once.
      const iterator = bufferedAsyncMap([0, 1], async function * (item) {
        try {
          if (item === 0) {
            await promisableTimeout(1000);
            yield 'head';
            return;
          }
          while (true) {
            stepSpy();
            yield 'x';
            await promisableTimeout(1);
          }
        } finally {
          cleaned.push(item);
        }
      }, { bufferSize: 6, ordered: 'eager', lookahead: 3 });

      await clock.tickAsync(500);        // item 1 fills to lookahead; head still busy
      stepSpy.callCount.should.equal(3); // the non-head lane holds K buffered values

      const flow = (async () => {
        await iterator.return?.();       // close while item 1 holds 3 buffered values
      })();
      await clock.runAllAsync();
      await flow;

      cleaned.should.have.members([0, 1]); // every live lane returned, buffered one included
    });

    it('delivers an external abort in source order like ordered:true (one rejection, then done)', async () => {
      const ac = new AbortController();
      const reason = new Error('eager-abort');

      const iterator = bufferedAsyncMap(
        yieldValuesOverTime(count, () => 1),
        async (item) => item,
        { bufferSize: 6, ordered: 'eager', signal: ac.signal }
      );

      const first = iterator.next();
      await clock.runAllAsync();
      await first; // deliver item 0

      ac.abort(reason);

      // The next pull rejects once with signal.reason (identity preserved, and
      // ahead of the still-buffered lanes); every later pull resolves done —
      // observably identical to ordered:true (ADVANCED.md, "Ordered mode").
      const outcomes = collectNextOutcomes(iterator, 3);
      await clock.runAllAsync();
      expectSingleRejectionThenDone(await outcomes, reason);
    });

    it('fail-fast surfaces the source-order-earliest error, not the chronologically-first', async () => {
      const earlyBySource = new Error('item 1 (earliest source order to fail)');
      const earlyByClock = new Error('item 3 (fails first in wall-clock)');

      const iterator = bufferedAsyncMap([0, 1, 2, 3], async (item) => {
        if (item === 1) {
          await promisableTimeout(500);
          throw earlyBySource;
        }
        if (item === 3) {
          await promisableTimeout(10); // fails first chronologically
          throw earlyByClock;
        }
        await promisableTimeout(50);
        return item;
      }, { bufferSize: 6, ordered: 'eager', errors: 'fail-fast' });

      const flow = collectNextOutcomes(iterator, 6);
      await clock.runAllAsync();
      const outcomes = await flow;

      // Item 0 delivers, then the source-order-earliest failure (item 1) owns
      // the single rejection — item 3's earlier-in-time throw does not pre-empt.
      expectSingleRejectionThenDone(outcomes.slice(1), earlyBySource);
    });

    it('fail-eventually aggregates lane errors in source order', async () => {
      const errA = new Error('item 1');
      const errB = new Error('item 3');

      const iterator = bufferedAsyncMap([0, 1, 2, 3], async (item) => {
        await promisableTimeout(item === 3 ? 10 : 100); // item 3 fails first in time
        if (item === 1) throw errA;
        if (item === 3) throw errB;
        return item;
      }, { bufferSize: 6, ordered: 'eager', errors: 'fail-eventually' });

      const flow = collectNextOutcomes(iterator, 6);
      await clock.runAllAsync();
      const outcomes = await flow;

      const rejection = outcomes.find(o => o.rejected);
      const aggregate = /** @type {AggregateError} */ (rejection?.value);
      aggregate.should.be.an.instanceOf(AggregateError);
      // Captured in source order (item 1 before item 3), regardless of timing.
      aggregate.errors.should.deep.equal([errA, errB]);
      unwrapCapturedError(aggregate).should.equal(errA);
    });
  });

  describe('error & malformed-result handling', () => {
    /** @type {import('sinon').SinonFakeTimers} */
    let clock;

    beforeEach(() => {
      clock = sinon.useFakeTimers();
    });

    afterEach(() => {
      sinon.restore();
    });

    it("delivers a generator's buffered values first, then surfaces its mid-stream error", async () => {
      const boom = new Error('mid-stream');

      const iterator = bufferedAsyncMap([0, 1], async function * (item) {
        if (item === 0) {
          yield 'a';
          yield 'b';
          throw boom; // rejects a later .next() on this sub-iterator
        }
        yield 'c';
      }, { bufferSize: 6, ordered: 'eager' });

      const flow = collectNextOutcomes(iterator, 6);
      await clock.runAllAsync();
      const outcomes = await flow;

      // item 0's yields in source order, then item 1's, then the drained error.
      deliveredValues(outcomes).should.deep.equal(['a', 'b', 'c']);
      const rejection = outcomes.find(o => o.rejected);
      unwrapCapturedError(rejection?.value).should.equal(boom);
    });

    it('surfaces a malformed async-iterable returned by the callback as a stream error', async () => {
      const iterator = bufferedAsyncMap([0], () => /** @type {*} */ ({
        [Symbol.asyncIterator]: () => 42, // method returns a non-object
      }), { bufferSize: 6, ordered: 'eager' });

      const flow = collectNextOutcomes(iterator, 2);
      await clock.runAllAsync();
      const outcomes = await flow;

      outcomes.some(o => o.rejected).should.equal(true);
      const rejection = outcomes.find(o => o.rejected);
      (unwrapCapturedError(rejection?.value) instanceof TypeError).should.equal(true);
    });

    it('surfaces a malformed sub-iterator result and still .return()s the iterator on cleanup', async () => {
      const returnSpy = sinon.spy();

      const iterator = bufferedAsyncMap([0], () => /** @type {*} */ ({
        [Symbol.asyncIterator]: () => ({
          next: async () => 42, // non-object result
          'return': returnSpy,
        }),
      }), { bufferSize: 6, ordered: 'eager' });

      const flow = collectNextOutcomes(iterator, 2);
      await clock.runAllAsync();
      const outcomes = await flow;

      outcomes.some(o => o.rejected).should.equal(true);
      returnSpy.callCount.should.equal(1); // malformed sub-iterators are still returned
    });

    it('surfaces a hostile getter on a sub-iterator result as a stream error', async () => {
      const iterator = bufferedAsyncMap([0], () => /** @type {*} */ ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ get done () { throw new Error('hostile'); } }),
        }),
      }), { bufferSize: 6, ordered: 'eager' });

      const flow = collectNextOutcomes(iterator, 2);
      await clock.runAllAsync();
      const outcomes = await flow;

      outcomes.some(o => o.rejected).should.equal(true);
    });

    it('surfaces a source next() rejection through the error mode', async () => {
      const boom = new Error('source boom');
      const { asyncIterable, asyncIterator } = stubAsyncIterator();
      asyncIterator.next.rejects(boom);
      asyncIterator.return.resolves({ done: true, value: undefined });

      const iterator = bufferedAsyncMap(asyncIterable, async (x) => x, { bufferSize: 1, ordered: 'eager' });

      const flow = collectNextOutcomes(iterator, 2);
      await clock.runAllAsync();
      const outcomes = await flow;

      outcomes.some(o => o.rejected).should.equal(true);
      const rejection = outcomes.find(o => o.rejected);
      unwrapCapturedError(rejection?.value).should.equal(boom);
    });

    it('surfaces a malformed source result and .return()s the source on cleanup', async () => {
      const { asyncIterable, asyncIterator } = stubAsyncIterator();
      asyncIterator.next.resolves(42); // non-object result
      asyncIterator.return.resolves({ done: true, value: undefined });

      const iterator = bufferedAsyncMap(asyncIterable, async (x) => x, { bufferSize: 1, ordered: 'eager' });

      const flow = collectNextOutcomes(iterator, 2);
      await clock.runAllAsync();
      const outcomes = await flow;

      outcomes.some(o => o.rejected).should.equal(true);
      asyncIterator.return.callCount.should.equal(1);
    });
  });
});

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
  unwrapCapturedError,
  yieldValuesOverTime,
} from './utils.js';

chai.should();

// ─────────────────────────────────────────────────────────────────────────
// DESIGN SPIKE. `ordered: 'eager'` is scaffolded but not implemented (see
// DESIGN-eager-mode.md). The first block pins the *current* behaviour — the
// mode throws, and the option validates — so the spike's contract is real and
// tested. The second block (skipped) pins the *intended* behaviour for the
// follow-up implementation PR to un-skip and satisfy.
// ─────────────────────────────────────────────────────────────────────────

describe("bufferedAsyncMap() ordered: 'eager'", () => {
  describe('scaffold (not yet implemented)', () => {
    it("throws a clear not-implemented error at construction for ordered: 'eager'", () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: 'eager' }))
        .should.throw("ordered: 'eager' is not yet implemented");
    });

    it("throws not-implemented for mergeIterables with ordered: 'eager'", () => {
      (() => mergeIterables([yieldValuesOverTime(3, () => 1)], { ordered: 'eager' }))
        .should.throw("ordered: 'eager' is not yet implemented");
    });

    it('validates the ordered option — rejects a non-boolean, non-"eager" value', () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: /** @type {*} */ ('nope') }))
        .should.throw(TypeError, "Expected ordered to be a boolean or 'eager'");
    });

    it('still accepts the existing boolean ordered values', () => {
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: true })).should.not.throw();
      (() => bufferedAsyncMap([1, 2, 3], async (item) => item, { ordered: false })).should.not.throw();
    });
  });

  describe.skip('intended behaviour (pending implementation)', () => {
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

    it('bounds look-ahead: an unbounded non-head generator is stepped at most K (=1) times ahead of the head', async () => {
      const stepSpy = sinon.spy();

      /** @returns {AsyncGenerator<string>} */
      async function * unbounded () {
        while (true) {
          stepSpy();
          yield 'x';
          await promisableTimeout(1);
        }
      }

      const iterator = bufferedAsyncMap([0, 1], async (item) => (
        item === 0
          // Head lane: slow, keeps the head occupied.
          ? (async function * () { await promisableTimeout(1000); yield 'head'; }())
          // Non-head lane: unbounded — stepped at most K times while not head.
          : unbounded()
      ), { bufferSize: 6, ordered: 'eager' });

      const flow = (async () => {
        await iterator.next();
      })();

      // Advance, but not enough for the head to finish.
      await clock.tickAsync(500);
      stepSpy.callCount.should.be.at.most(1);

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
});

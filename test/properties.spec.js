/**
 * fast-check property suite — an accumulating background search, not a
 * regression pin. Seeds are random on every run (fast-check's default): a
 * failure here is a DISCOVERY, and the printed seed/path replays it
 * deterministically. Anything a property finds must then be pinned as a
 * plain example spec in the relevant file — regression protection never
 * depends on run count.
 *
 * Replaying a counterexample: `FC_PATH` encodes a walk through ONE
 * property's generation/shrink tree, so replay MUST be scoped to the
 * failing test (enforced below):
 *
 *     FC_SEED=<seed> FC_PATH=<path> npx mocha test/properties.spec.js -g "<test name>"
 *
 * `FC_SEED` alone is safe to apply globally. `FC_NUM_RUNS` (default 100)
 * sets the per-property run count for deep local sweeps — budget roughly
 * ~1.1s per 10k runs for the slowest property (~2.5s per 10k for the whole
 * suite; 2-3x that under `npm test`'s coverage instrumentation). Invalid
 * values throw loudly: fast-check silently runs ZERO cases on
 * `numRuns: 0/NaN`, which would turn the suite into a green no-op.
 *
 * Hang safety: each run carries a per-run fast-check `timeout` (a hanging
 * library bug becomes a reported, shrunk failure with seed/path — a bare
 * mocha timeout would lose the report), and `interruptAfterTimeLimit` +
 * `markInterruptAsFailure` bound the whole assert well under the mocha cap.
 *
 * Conventions (mirroring the benchmark rule): sources are timer-free and
 * these specs run WITHOUT sinon fake timers, so there is nothing to
 * reconcile between fast-check's scheduler and a mocked clock.
 *
 * Conditional oracles carry vacuity counters: an oracle branch that never
 * fires is a silent no-op re-armed, so each property asserts its branches
 * actually triggered (gated on numRuns >= 100 so tiny replay runs don't
 * trip them).
 *
 * WHY THIS SUITE EXISTS — an honest ledger, written when it landed
 * (v2.0.0, 2026), so future maintainers can judge it on its record:
 *
 * fast-check found none of the bugs fixed in the 2.0.0 hardening — all
 * were found first by hand-rolled adversarial probes. The suite's value
 * is prospective: the post-done over-pull class shipped in 1.x for years
 * and survived five review waves before an expensive ad-hoc audit caught
 * it; the differential property below catches that class in 2-10 runs,
 * forever, for ~25ms per CI pass. The first ITERATION of this file was
 * itself a liability: mutation testing proved its abort property was
 * structurally blind to the bug class it was named after (five real bug
 * classes each survived 20 000 green runs). A weak property test is a
 * false-confidence machine — it reads as coverage while asserting almost
 * nothing.
 *
 * The lesson that must outlive this comment: MUTATION TESTING, not
 * property testing, was the high-value activity. It caught the vacuous
 * first iteration, validated this one (12/12 non-equivalent mutants
 * killed within 2k runs; zero false positives at 20k runs/property), and
 * exposed that the fail-fast silent-value-loss class passes the ENTIRE
 * example suite — making this file its only automated coverage. Policy:
 * no new property lands here without a mutant that dies by it, and the
 * next big confidence investment should be mutation testing the example
 * suite, not growing this file.
 *
 * TODO(mutation-testing): evaluate running Stryker
 * (https://stryker-mutator.io) over the example suite — the 2.0.0 review
 * proved at least one contract class (fail-fast silent value loss) passes
 * all 144 example specs undetected, and hand-rolled mutants won't scale
 * as an ongoing practice.
 */

import fc from 'fast-check';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  isCleanDone,
} from './utils.js';

/* eslint-disable n/no-process-env -- deliberate local knobs: deep sweeps and counterexample replay */
const numRunsRaw = process.env['FC_NUM_RUNS'];
const seedRaw = process.env['FC_SEED'];
const fcPath = process.env['FC_PATH'];
/* eslint-enable n/no-process-env */

const numRuns = (numRunsRaw === undefined || numRunsRaw === '') ? 100 : Number(numRunsRaw);
if (!Number.isSafeInteger(numRuns) || numRuns <= 0) {
  throw new Error(`Invalid FC_NUM_RUNS: ${JSON.stringify(numRunsRaw)} — fast-check silently runs zero cases on 0/NaN, so bad values must fail loudly`);
}
const seed = (seedRaw === undefined || seedRaw === '') ? undefined : Number(seedRaw);
if (seed !== undefined && !Number.isSafeInteger(seed)) {
  throw new Error(`Invalid FC_SEED: ${JSON.stringify(seedRaw)} (fast-check seeds are integers, negative included)`);
}

// ~2ms/run is ~6x the worst measured per-run cost under c8; floor 30s.
const mochaTimeoutMs = Math.max(30_000, numRuns * 2 + 10_000);

/** @type {fc.Parameters<unknown>} */
const fcParams = {
  numRuns,
  // Per-run cap: a hanging predicate becomes a reported, shrunk failure
  // (seed/path intact) instead of a bare mocha timeout losing the report.
  // Sources here are timer-free, so a legitimate run is orders of magnitude
  // faster; each hanging SHRINK candidate also costs up to this long.
  timeout: 5_000,
  // Whole-assert wall-clock backstop, safely inside the mocha cap so the
  // report is never lost; an interrupted (starved) assert fails loudly
  // rather than passing green on too few runs.
  interruptAfterTimeLimit: mochaTimeoutMs - 10_000,
  markInterruptAsFailure: true,
  ...(seed !== undefined ? { seed } : {}),
  ...(fcPath !== undefined ? { path: fcPath } : {}),
};

let fcAssertCalls = 0;

/**
 * fc.assert with the shared params, enforcing FC_PATH's one-property scope:
 * a shrink path replayed against a property with a different arbitrary tree
 * either hard-throws or silently walks meaningless cases.
 *
 * @param {fc.IAsyncPropertyWithHooks<*>} property
 * @returns {Promise<void>}
 */
async function fcAssert (property) {
  fcAssertCalls += 1;
  if (fcPath !== undefined && fcAssertCalls > 1) {
    throw new Error('FC_PATH is only meaningful for the property that produced it — scope the replay with: npx mocha test/properties.spec.js -g "<failing test name>"');
  }
  await fc.assert(property, fcParams);
}

/** @typedef {{ rejected: false, result: IteratorResult<unknown, unknown> } | { rejected: true, reason: unknown }} PullOutcome */

/**
 * Envelope a single pull so a rejection can never escape unobserved.
 *
 * @param {AsyncIterator<unknown>} iterator
 * @returns {Promise<PullOutcome>}
 */
function pullOutcome (iterator) {
  return settleOutcome(iterator.next());
}

/**
 * @param {Promise<IteratorResult<unknown, unknown>> | undefined} step
 * @returns {Promise<PullOutcome>}
 */
function settleOutcome (step) {
  // eslint-disable-next-line promise/prefer-await-to-then -- two-handler envelope: a rejection must never escape unobserved, even between awaits
  return /** @type {Promise<IteratorResult<unknown, unknown>>} */ (step).then(
    result => /** @type {PullOutcome} */ ({ rejected: false, result }),
    err => /** @type {PullOutcome} */ ({ rejected: true, reason: err })
  );
}

/**
 * A source instance for the differential property. `kind: 'defensive'`
 * models a real cursor: next() rejects if INITIATED after its done result
 * has already settled (in-flight overlap during the concurrent prefetch is
 * legitimate and allowed); 'lenient' tolerates trailing pulls like a plain
 * generator. Request-queue semantics match a native generator: an error is
 * delivered once, concurrently-initiated later pulls resolve done.
 *
 * @param {number[]} values
 * @param {number | undefined} errorPos
 * @param {'lenient' | 'defensive'} kind
 * @returns {{ iterable: AsyncIterable<number>, sourceError: Error | undefined, getPostDonePulls: () => number }}
 */
function makeDifferentialSource (values, errorPos, kind) {
  let i = 0;
  let doneSettled = false;
  let errored = false;
  let postDonePulls = 0;
  const sourceError = errorPos !== undefined && errorPos <= values.length
    ? new Error(`source-error@${errorPos}`)
    : undefined;

  /** @type {AsyncIterable<number>} */
  const iterable = {
    [Symbol.asyncIterator] () {
      return {
        next () {
          if (doneSettled) {
            postDonePulls += 1;
            return kind === 'defensive'
              ? Promise.reject(new Error('cursor already closed'))
              : Promise.resolve(/** @type {IteratorResult<number>} */ ({ done: true, value: undefined }));
          }
          const step = (async () => {
            await Promise.resolve(); // async source: body settles a microtask later
            if (errored) return /** @type {IteratorResult<number>} */ ({ done: true, value: undefined });
            if (sourceError && i === errorPos) {
              errored = true;
              throw sourceError;
            }
            return i >= values.length
              ? /** @type {IteratorResult<number>} */ ({ done: true, value: undefined })
              : { done: false, value: /** @type {number} */ (values[i++]) };
          })();
          // The source's own handler attaches BEFORE returning, so it runs
          // ahead of the consumer's classification of the same settle.
          // eslint-disable-next-line promise/prefer-await-to-then, promise/catch-or-return, promise/always-return -- model bookkeeping riding the same settle; the consumer owns the returned promise
          step.then(r => { if (r.done) doneSettled = true; }, () => { doneSettled = true; });
          return step;
        },
        return () {
          doneSettled = true;
          return Promise.resolve(/** @type {IteratorResult<number>} */ ({ done: true, value: undefined }));
        },
      };
    },
  };

  return { iterable, sourceError, getPostDonePulls: () => postDonePulls };
}

/**
 * @param {AsyncIterable<unknown>} asyncIterable
 * @returns {Promise<{ yielded: unknown[], error: unknown }>}
 */
async function drain (asyncIterable) {
  /** @type {unknown[]} */
  const yielded = [];
  /** @type {unknown} */
  let error;
  try {
    for await (const value of asyncIterable) {
      yielded.push(value);
    }
  } catch (err) {
    error = err;
  }
  return { yielded, error };
}

/**
 * @param {number[]} values
 * @returns {string}
 */
function multisetKey (values) {
  return JSON.stringify(values.toSorted((a, b) => a - b));
}

/**
 * Multiset-aware subset check: every value may appear at most as many times
 * as `allowed` contains it (`includes` would let duplicates through).
 *
 * @param {number[]} actual
 * @param {number[]} allowed
 * @returns {string | undefined} description of the first violation
 */
function multisetSubsetViolation (actual, allowed) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const value of allowed) counts.set(value, (counts.get(value) || 0) + 1);
  for (const value of actual) {
    const left = counts.get(value) || 0;
    if (left === 0) return `value ${value} yielded more times than native produced it`;
    counts.set(value, left - 1);
  }
}

/** @typedef {{ op: 'next' } | { op: 'return', value: number } | { op: 'throw' }} ProtocolOp */

const opArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant(/** @type {ProtocolOp} */ ({ op: 'next' })) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('return'), value: fc.integer() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('throw') }) }
);

/**
 * Settle each op against the iterator, producing one canonical outcome key
 * per op (undefined values keyed as the string '(undefined)' — JSON can't
 * carry undefined). `onSettle` runs synchronously on the microtask that
 * resumes after each op settles — the hook the same-tick cleanup-ordering
 * assertion needs.
 *
 * @param {AsyncIterator<unknown>} iterator
 * @param {ProtocolOp[]} ops
 * @param {Error} thrownError
 * @param {(settled: PullOutcome) => void} [onSettle]
 * @returns {Promise<string[]>}
 */
async function runOps (iterator, ops, thrownError, onSettle) {
  /** @type {string[]} */
  const trace = [];
  for (const o of ops) {
    const settled = o.op === 'next'
      ? await pullOutcome(iterator)
      : (o.op === 'return'
          ? await settleOutcome(iterator.return?.(o.value))
          : await settleOutcome(iterator.throw?.(thrownError)));
    onSettle?.(settled);
    trace.push(settled.rejected
      ? `reject:${settled.reason === thrownError ? 'thrown' : String(settled.reason)}`
      : JSON.stringify({ done: !!settled.result.done, value: settled.result.value === undefined ? '(undefined)' : settled.result.value }));
  }
  return trace;
}

describe('bufferedAsyncMap() properties', function () {
  this.timeout(mochaTimeoutMs);

  it('differential: yields the same values and error identity as native for-await', async () => {
    // Vacuity accounting: each comparison branch must actually fire.
    let statCleanFailFast = 0;
    let statErrorFailFast = 0;
    let statErrorFailEventually = 0;

    await fcAssert(fc.asyncProperty(
      fc.array(fc.integer(), { maxLength: 25 }),
      fc.integer({ min: 1, max: 12 }),
      fc.option(fc.nat(25), { nil: undefined }),
      fc.constantFrom('lenient', 'defensive'),
      fc.constantFrom('fail-eventually', 'fail-fast'),
      async (values, bufferSize, errorPos, kind, errorsMode) => {
        // Oracle: native for-await over an identical fresh source.
        const oracleSource = makeDifferentialSource(values, errorPos, kind);
        const expected = await drain(oracleSource.iterable);

        // Model tripwires (this repo's history: property failures are model
        // bugs more often than library bugs): native for-await never pulls
        // past done and never loses error identity — if the oracle does,
        // the MODEL broke, and comparing the library against it is invalid.
        if (oracleSource.getPostDonePulls() > 0) {
          throw new Error('model bug: native for-await over-pulled the oracle source');
        }
        if (expected.error !== undefined && expected.error !== oracleSource.sourceError) {
          throw new Error(`model bug: oracle lost error identity (${String(expected.error)})`);
        }

        const testSource = makeDifferentialSource(values, errorPos, kind);
        const actual = await drain(bufferedAsyncMap(testSource.iterable, async (v) => v, { bufferSize, errors: errorsMode }));

        const expectedValues = /** @type {number[]} */ (expected.yielded);
        const actualValues = /** @type {number[]} */ (actual.yielded);

        if (!expected.error || errorsMode === 'fail-eventually') {
          // No error surfaced (nothing may drop values, in fail-fast too) or
          // fail-eventually drain (every pre-error value surfaces): full
          // multiset equality.
          if (multisetKey(expectedValues) !== multisetKey(actualValues)) {
            throw new Error(`value mismatch: native ${multisetKey(expectedValues)} vs library ${multisetKey(actualValues)}`);
          }
          if (expected.error) statErrorFailEventually += 1;
          else if (errorsMode === 'fail-fast') statCleanFailFast += 1;
        } else {
          // fail-fast with an error: the error may legitimately win the
          // unordered race against slower in-flight values, so the library
          // may deliver any MULTISET SUBSET of native's values — but never
          // more copies of a value than native produced.
          const violation = multisetSubsetViolation(actualValues, expectedValues);
          if (violation) throw new Error(`fail-fast ${violation}`);
          statErrorFailFast += 1;
        }

        // Terminal error identity: a single source error must surface
        // identity-preserved (not wrapped), and only when native errored too.
        if (expected.error) {
          if (!actual.error) throw new Error('native errored but the library completed cleanly');
          if (actual.error !== testSource.sourceError) {
            throw new Error(`error identity mismatch: got ${String(actual.error)}`);
          }
        } else if (actual.error) {
          throw new Error(`library errored where native did not: ${String(actual.error)}`);
        }
      }
    ));

    if (numRuns >= 100 && (statCleanFailFast === 0 || statErrorFailFast === 0 || statErrorFailEventually === 0)) {
      throw new Error(`vacuous run: a comparison branch never fired (cleanFailFast=${statCleanFailFast}, errorFailFast=${statErrorFailFast}, errorFailEventually=${statErrorFailEventually})`);
    }
  });

  it('delivers exactly the committed rejection, at most once, under generated abort geometry', async () => {
    // Generalizes the deterministic drain-race sweep pinned at
    // test/abort.spec.js ("delivers exactly one rejection when an abort
    // races the drain-throw…") — the sweep is the regression PIN, this
    // property is the accumulating SEARCH around it. Same commit-point
    // oracle: the per-callback signal's reason is the immutable record of
    // which side committed the shutdown (requestConsumerAbort is the single
    // writer pairing it with the consumer-facing rejection; a bare
    // exhaustion-close aborts with a default AbortError matching neither).
    //
    // Measured detection power (mutation-tested): swallowed aborts,
    // swallowed callback errors, wrong-identity fail-fast delivery and
    // done-shape leaks are all caught within ~2k runs; the drain-race
    // microtask window itself only at roughly 1-in-tens-of-thousands of
    // runs — which is exactly why the deterministic sweep stays the pin.
    let unhandled = 0;
    /** @param {unknown} _reason */
    const onUnhandled = (_reason) => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);

    // Vacuity accounting: every oracle arm must actually fire across a run
    // set — a conditional oracle that never triggers asserts nothing.
    let statAbortWon = 0;
    let statFailFastWon = 0;
    let statErrObligation = 0;
    let statCleanRuns = 0;

    try {
      await fcAssert(fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.integer(), { maxLength: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.option(fc.nat(6), { nil: undefined }),
        // Abort geometry as one optional record: no dead hop/anchor
        // dimensions on no-abort runs (and no meaningless shrink steps).
        // Both anchors matter: a scheduler-released abort's microtask-hop
        // chain can only align with windows anchored at release time;
        // windows anchored at construction (the drain-race class) need the
        // other anchor.
        fc.option(fc.record({
          anchor: fc.constantFrom('scheduled', 'construction'),
          hops: fc.nat(25),
        }), { nil: undefined }),
        fc.constantFrom('fail-eventually', 'fail-fast'),
        fc.boolean(),
        async (s, values, bufferSize, cbErrorPos, abort, errorsMode, scheduleCb) => {
          const unhandledBefore = unhandled;
          const ac = new AbortController();
          const abortReason = new Error('external-abort');
          const cbError = new Error('cb-error');

          let dispatchIndex = 0;
          let dispatchedError = false;
          /** @type {AbortSignal | undefined} */
          let capturedSignal;
          // The scheduled function must NEVER reject: scheduleFunction runs it
          // eagerly and holds the original promise unhandled until release, so
          // a task never released would surface as a harness-side
          // unhandledRejection. Resolve a sentinel and rethrow after the await.
          const ERR_SENTINEL = Symbol('cb-error');
          const scheduledCb = s.scheduleFunction(
            async (/** @type {number | typeof ERR_SENTINEL} */ v) => v
          );
          /** @type {(item: number, opts: { signal: AbortSignal }) => Promise<number>} */
          const callback = async (item, opts) => {
            capturedSignal = opts.signal;
            const wantErr = cbErrorPos !== undefined && dispatchIndex++ === cbErrorPos;
            if (!scheduleCb) {
              if (wantErr) {
                dispatchedError = true;
                throw cbError;
              }
              return item;
            }
            const r = await scheduledCb(wantErr ? ERR_SENTINEL : item);
            if (r === ERR_SENTINEL) {
              dispatchedError = true;
              throw cbError;
            }
            return /** @type {number} */ (r);
          };

          const fireAbortAfterHops = async () => {
            for (let i = 0; i < (abort?.hops ?? 0); i++) await Promise.resolve();
            ac.abort(abortReason);
          };
          /** @type {Promise<void> | undefined} */
          let abortChain;
          if (abort && abort.anchor === 'scheduled') {
            // The chain is folded into the waitFor promise below, so the
            // scheduler is FORCED to release the abort task before the run
            // ends — waitFor alone only releases tasks until its awaited
            // promise settles, leaving unreleased tasks silently pending.

            abortChain = s.schedule(Promise.resolve(), 'external-abort').then(fireAbortAfterHops);
          }

          const iterator = bufferedAsyncMap(values, callback, {
            bufferSize,
            errors: errorsMode,
            signal: ac.signal,
          });

          /** @type {Promise<void> | undefined} */
          let constructionAbort;
          if (abort && abort.anchor === 'construction') {
            constructionAbort = fireAbortAfterHops();
          }

          const consumer = (async () => {
            /** @type {PullOutcome[]} */
            const collected = [];
            for (let i = 0; i < values.length + 3; i++) {
              const o = await pullOutcome(iterator);
              collected.push(o);
              if (o.rejected || o.result.done) break;
            }
            // Post-terminal probes: "reject once, then done forever".
            for (let i = 0; i < 2; i++) {
              collected.push(await pullOutcome(iterator));
            }
            return collected;
          })();

          /** @type {PullOutcome[]} */
          let outcomes;
          if (abortChain) {
            const [consumerOutcomes] = await s.waitFor(Promise.all([consumer, abortChain]));
            outcomes = consumerOutcomes;
          } else {
            outcomes = await s.waitFor(consumer);
          }
          if (constructionAbort) await constructionAbort;

          // The abort has now definitely FIRED (both anchors are awaited
          // above); two more probes guarantee a pull exists after any late
          // commit — and assert the suppression contract when the abort
          // landed after natural exhaustion (undelivered abort through a
          // closed iterator resolves done, never rejects).
          // (argument order keeps the pulls sequential)
          outcomes.push(await pullOutcome(iterator), await pullOutcome(iterator));

          // -- Commit-point oracle (see test/abort.spec.js sweep) --
          const abortWon = capturedSignal?.aborted === true && abort !== undefined && capturedSignal.reason === abortReason;
          const failFastWon = capturedSignal?.aborted === true && capturedSignal.reason === cbError;

          const rejections = outcomes.filter(o => o.rejected);
          if (rejections.length > 1) {
            throw new Error(`${rejections.length} rejections observed`);
          }

          if (abortWon) {
            // The abort committed while the iterator was open (the listener
            // is isDone-guarded), and this property never closes explicitly,
            // so suppression is unreachable: the reason MUST be delivered,
            // exactly once, identity-preserved.
            statAbortWon += 1;
            if (rejections.length !== 1 || rejections[0]?.rejected !== true || rejections[0].reason !== abortReason) {
              throw new Error(`abort committed but delivery was ${rejections.length === 0 ? 'missing' : `wrong: ${String(rejections[0]?.rejected ? rejections[0].reason : '')}`}`);
            }
          } else if (failFastWon) {
            // A fail-fast error committed the shutdown (requestConsumerAbort
            // ran with the error as reason): that error owns the rejection.
            statFailFastWon += 1;
            if (rejections.length !== 1 || rejections[0]?.rejected !== true || rejections[0].reason !== cbError) {
              throw new Error(`fail-fast committed but delivery was ${rejections.length === 0 ? 'missing' : 'wrong identity'}`);
            }
          } else if (dispatchedError) {
            // cbError entered the pipeline and no shutdown out-raced it:
            // fail-eventually owes the drain-throw (identity-preserved, or
            // AggregateError of only this error — it is the only error
            // object in play).
            statErrObligation += 1;
            const reason = rejections[0]?.rejected === true ? rejections[0].reason : undefined;
            const identityOk = reason === cbError ||
              (reason instanceof AggregateError && reason.errors.length > 0 && reason.errors.every(e => e === cbError));
            if (rejections.length !== 1 || !identityOk) {
              throw new Error(`callback error dispatched but delivery was ${rejections.length === 0 ? 'missing (swallowed)' : `wrong: ${String(reason)}`}`);
            }
          } else if (capturedSignal !== undefined) {
            // No error dispatched and no abort committed (an abort landing
            // after natural exhaustion is suppressed): a rejection here is a
            // fabrication.
            statCleanRuns += 1;
            if (rejections.length !== 0) {
              throw new Error(`unexpected rejection on a clean run: ${String(rejections[0]?.rejected === true ? rejections[0].reason : '')}`);
            }
          } else if (rejections.length === 1 && // No callback ever dispatched (empty source, or the abort
            // pre-empted the whole prefetch): the only legal rejection is
            // the generated abort's reason.
            (abort === undefined || rejections[0]?.rejected !== true || rejections[0].reason !== abortReason)) {
            throw new Error(`rejection without any committed cause: ${String(rejections[0]?.rejected === true ? rejections[0].reason : '')}`);
          }

          // Deterministic sub-case: an abort fired synchronously before the
          // first pull must reject that first pull with its reason.
          if (abort && abort.anchor === 'construction' && abort.hops === 0) {
            const first = outcomes[0];
            if (first?.rejected !== true || first.reason !== abortReason) {
              throw new Error('pre-pull abort was not delivered on the first pull');
            }
          }

          // Terminal + shape invariants: a terminal is always reached within
          // the loop bound (each non-terminal pull consumes one distinct
          // source value); every done is the clean 2-key shape (a leaked
          // internal envelope must fail even when done/value look right);
          // nothing follows the first terminal except clean dones; values
          // come from the source.
          const firstTerminal = outcomes.findIndex(o => o.rejected || o.result.done);
          if (firstTerminal === -1) {
            throw new Error('no terminal (done or rejection) observed');
          }
          for (const o of outcomes.slice(firstTerminal + 1)) {
            if (o.rejected || !isCleanDone(o.result)) {
              throw new Error(`post-terminal pull was not a clean { done: true, value: undefined }: ${JSON.stringify(o)}`);
            }
          }
          for (const o of outcomes) {
            if (o.rejected) continue;
            if (o.result.done) {
              if (!isCleanDone(o.result)) throw new Error(`done result carried extra shape: ${JSON.stringify(o.result)}`);
            } else if (!values.includes(/** @type {number} */ (o.result.value))) {
              throw new Error(`yielded a value not from the source: ${String(o.result.value)}`);
            }
          }

          await new Promise(resolve => { setImmediate(resolve); }); // let unhandledRejection detection settle
          if (unhandled > unhandledBefore) {
            throw new Error(`${unhandled - unhandledBefore} unhandled rejection(s)`);
          }
        }
      ));

      if (numRuns >= 100 && (statAbortWon === 0 || statFailFastWon === 0 || statErrObligation === 0 || statCleanRuns === 0)) {
        throw new Error(`vacuous run: an oracle arm never fired (abortWon=${statAbortWon}, failFastWon=${statFailFastWon}, errObligation=${statErrObligation}, clean=${statCleanRuns})`);
      }
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('protocol: op sequences settle like a native AsyncGenerator (documented divergences excepted)', async () => {
    await fcAssert(fc.asyncProperty(
      fc.array(fc.integer(), { maxLength: 5 }),
      fc.array(opArb, { minLength: 1, maxLength: 8 }),
      async (values, ops) => {
        const thrownError = new Error('consumer-throw');

        let nativeFinally = false;
        async function * nativeSrc () {
          try { yield * values; } finally { nativeFinally = true; }
        }
        let libFinally = false;
        async function * libSrc () {
          try { yield * values; } finally { libFinally = true; }
        }

        const expected = await runOps(nativeSrc(), ops, thrownError);
        const actual = await runOps(
          // ordered/bufferSize:1 ONLY — deliberate scope cut: native is the
          // oracle and needs deterministic interleaving to be comparable.
          // Unordered/buffered protocol behaviour is covered by example
          // specs (return.spec.js, throw.spec.js, abort.spec.js), not here.
          bufferedAsyncMap(libSrc(), async (v) => v, { ordered: true, bufferSize: 1 }),
          ops, thrownError,
          // Same-tick ordering teeth (await-idempotence contract): when a
          // terminal settles for the LIBRARY iterator, the source's finally
          // must ALREADY have run — markAsEnded awaits cleanup (including
          // source.return()) before any closer resolves. Library-side only:
          // eager construction always starts the source (even `yield * []`
          // completes, finally included, on the prefetch pull), so there is
          // no never-started carve-out on this side.
          (settled) => {
            const isTerminal = settled.rejected || settled.result.done === true;
            if (isTerminal && !libFinally) {
              throw new Error('terminal settled before the library source\'s finally ran (cleanup not awaited)');
            }
          }
        );

        for (const [i, expKey] of expected.entries()) {
          if (expKey !== actual[i]) {
            throw new Error(`op[${i}] ${JSON.stringify(ops[i])}: native=${expKey} library=${actual[i]}`);
          }
        }

        // Documented divergences, encoded: construction prefetches, so the
        // library's source may start — and even finish, finally included —
        // ahead of native's suspended generator. Finally-parity is therefore
        // one-directional, plus: any consumer-observed terminal means the
        // library closed its source.
        if (nativeFinally && !libFinally) {
          throw new Error('native ran the source finally but the library did not');
        }
        const sawTerminal = ops.some(o => o.op !== 'next') ||
          actual.some(key => key.startsWith('reject:') || key.includes('"done":true'));
        if (sawTerminal && !libFinally) {
          throw new Error('consumer observed a terminal but the library source finally never ran');
        }
      }
    ));
  });
});

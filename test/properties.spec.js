/**
 * fast-check property suite — an accumulating background search, not a
 * regression pin. Seeds are random on every run (fast-check's default): a
 * failure here is a DISCOVERY, and the printed seed/path replays it
 * deterministically (`FC_SEED` / `FC_PATH` below). Anything a property
 * finds must then be pinned as a plain example spec in the relevant file —
 * regression protection never depends on run count.
 *
 * Conventions (mirroring the benchmark rule): sources are timer-free and
 * these specs run WITHOUT sinon fake timers, so there is nothing to
 * reconcile between fast-check's scheduler and a mocked clock.
 *
 * Env knobs: `FC_NUM_RUNS` (default 100; deep local sweeps take ~1s per
 * 10k runs), `FC_SEED` + `FC_PATH` (replay a printed counterexample).
 */

import fc from 'fast-check';

import {
  bufferedAsyncMap,
} from '../index.js';

/* eslint-disable n/no-process-env -- deliberate local knobs: deep sweeps and counterexample replay */
const numRuns = Number(process.env['FC_NUM_RUNS'] || 100);

/** @type {fc.Parameters<unknown>} */
const fcParams = {
  numRuns,
  ...(process.env['FC_SEED'] ? { seed: Number(process.env['FC_SEED']) } : {}),
  ...(process.env['FC_PATH'] ? { path: process.env['FC_PATH'] } : {}),
};
/* eslint-enable n/no-process-env */

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
 * @returns {{ iterable: AsyncIterable<number>, sourceError: Error | undefined }}
 */
function makeDifferentialSource (values, errorPos, kind) {
  let i = 0;
  let doneSettled = false;
  let errored = false;
  const sourceError = errorPos !== undefined && errorPos <= values.length
    ? new Error(`source-error@${errorPos}`)
    : undefined;

  /** @type {AsyncIterable<number>} */
  const iterable = {
    [Symbol.asyncIterator] () {
      return {
        next () {
          if (doneSettled) {
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

  return { iterable, sourceError };
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

/** @typedef {{ op: 'next' } | { op: 'return', value: number } | { op: 'throw' }} ProtocolOp */

const opArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant(/** @type {ProtocolOp} */ ({ op: 'next' })) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant(/** @type {const} */ ('return')), value: fc.integer() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant(/** @type {const} */ ('throw')) }) }
);

/**
 * Settle each op against the iterator, producing one canonical outcome key
 * per op (undefined values keyed as the string '(undefined)' — JSON can't
 * carry undefined).
 *
 * @param {AsyncIterator<unknown>} iterator
 * @param {ProtocolOp[]} ops
 * @param {Error} thrownError
 * @returns {Promise<string[]>}
 */
async function runOps (iterator, ops, thrownError) {
  /** @type {string[]} */
  const trace = [];
  for (const o of ops) {
    const settled = o.op === 'next'
      ? await pullOutcome(iterator)
      : (o.op === 'return'
          ? await settleOutcome(iterator.return?.(o.value))
          : await settleOutcome(iterator.throw?.(thrownError)));
    trace.push(settled.rejected
      ? `reject:${settled.reason === thrownError ? 'thrown' : String(settled.reason)}`
      : JSON.stringify({ done: !!settled.result.done, value: settled.result.value === undefined ? '(undefined)' : settled.result.value }));
  }
  return trace;
}

describe('bufferedAsyncMap() properties', function () {
  // Deep FC_NUM_RUNS sweeps stay inside a generous cap; 100 runs take <100ms.
  this.timeout(30_000);

  it('differential: yields the same values and error identity as native for-await', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer(), { maxLength: 25 }),
      fc.integer({ min: 1, max: 12 }),
      fc.option(fc.nat(25), { nil: undefined }),
      fc.constantFrom(/** @type {'lenient' | 'defensive'} */ ('lenient'), 'defensive'),
      fc.constantFrom(/** @type {'fail-eventually' | 'fail-fast'} */ ('fail-eventually'), 'fail-fast'),
      async (values, bufferSize, errorPos, kind, errorsMode) => {
        // Oracle: native for-await over an identical fresh source.
        const oracleSource = makeDifferentialSource(values, errorPos, kind);
        const expected = await drain(oracleSource.iterable);

        const testSource = makeDifferentialSource(values, errorPos, kind);
        const actual = await drain(bufferedAsyncMap(testSource.iterable, async (v) => v, { bufferSize, errors: errorsMode }));

        // Same multiset of yielded values — except fail-fast, where an error
        // legitimately wins the unordered race against slower values, so the
        // library may yield a subset of native's values (never a superset).
        const expectedSorted = JSON.stringify(/** @type {number[]} */ (expected.yielded).toSorted((a, b) => a - b));
        const actualSorted = JSON.stringify(/** @type {number[]} */ (actual.yielded).toSorted((a, b) => a - b));
        if (errorsMode === 'fail-eventually') {
          if (expectedSorted !== actualSorted) {
            throw new Error(`value mismatch: native ${expectedSorted} vs library ${actualSorted}`);
          }
        } else {
          for (const value of actual.yielded) {
            if (!expected.yielded.includes(value)) {
              throw new Error(`fail-fast yielded a value native never produced: ${value}`);
            }
          }
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
    ), fcParams);
  });

  it('delivers at most one rejection, identity-preserved, under generated abort geometry', async () => {
    let unhandled = 0;
    /** @param {unknown} _reason */
    const onUnhandled = (_reason) => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);

    try {
      await fc.assert(fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.integer(), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.option(fc.nat(6), { nil: undefined }),
        fc.nat(25),
        fc.constantFrom(/** @type {'fail-eventually' | 'fail-fast'} */ ('fail-eventually'), 'fail-fast'),
        fc.boolean(),
        // Race geometry: a scheduler-released abort's microtask-hop chain can
        // only align with windows anchored at release time; windows anchored
        // at construction (the drain-race class) need the other anchor.
        fc.constantFrom(/** @type {'scheduled' | 'construction'} */ ('scheduled'), 'construction'),
        fc.boolean(),
        async (s, values, bufferSize, cbErrorPos, abortHops, errorsMode, doAbort, abortAnchor, scheduleCb) => {
          const unhandledBefore = unhandled;
          const ac = new AbortController();
          const abortReason = new Error('external-abort');
          const cbError = new Error('cb-error');

          let dispatchIndex = 0;
          // The scheduled function must NEVER reject: scheduleFunction runs it
          // eagerly and holds the original promise unhandled until release, so
          // a task never released (abort won) would surface as a harness-side
          // unhandledRejection. Resolve a sentinel and rethrow after the await.
          const ERR_SENTINEL = Symbol('cb-error');
          const scheduledCb = s.scheduleFunction(
            async (/** @type {number | typeof ERR_SENTINEL} */ v) => v
          );
          /** @type {(item: number, opts: { signal: AbortSignal }) => Promise<number>} */
          const callback = async (item, _opts) => {
            const wantErr = cbErrorPos !== undefined && dispatchIndex++ === cbErrorPos;
            if (!scheduleCb) {
              if (wantErr) throw cbError;
              return item;
            }
            const r = await scheduledCb(wantErr ? ERR_SENTINEL : item);
            if (r === ERR_SENTINEL) throw cbError;
            return /** @type {number} */ (r);
          };

          const fireAbortAfterHops = async () => {
            for (let i = 0; i < abortHops; i++) await Promise.resolve();
            ac.abort(abortReason);
          };
          if (doAbort && abortAnchor === 'scheduled') {
            // eslint-disable-next-line promise/catch-or-return -- scheduler task, released (and awaited) via s.waitFor below
            s.schedule(Promise.resolve(), 'external-abort').then(fireAbortAfterHops);
          }

          const iterator = bufferedAsyncMap(values, callback, {
            bufferSize,
            errors: errorsMode,
            signal: ac.signal,
          });

          /** @type {Promise<void> | undefined} */
          let constructionAbort;
          if (doAbort && abortAnchor === 'construction') {
            constructionAbort = fireAbortAfterHops();
          }

          const consumer = (async () => {
            /** @type {PullOutcome[]} */
            const outcomes = [];
            for (let i = 0; i < values.length + 3; i++) {
              const o = await pullOutcome(iterator);
              outcomes.push(o);
              if (o.rejected || o.result.done) break;
            }
            // Post-terminal probes: "reject once, then done forever".
            for (let i = 0; i < 2; i++) {
              outcomes.push(await pullOutcome(iterator));
            }
            return outcomes;
          })();

          const outcomes = await s.waitFor(consumer);
          if (constructionAbort) await constructionAbort;

          const rejections = outcomes.filter(o => o.rejected);
          if (rejections.length > 1) {
            throw new Error(`${rejections.length} rejections observed`);
          }
          for (const o of rejections) {
            const identityOk = o.reason === cbError || o.reason === abortReason ||
              (o.reason instanceof AggregateError && o.reason.errors.every(e => e === cbError));
            if (!identityOk) {
              throw new Error(`foreign rejection identity: ${String(o.reason)}`);
            }
          }
          const firstReject = outcomes.findIndex(o => o.rejected);
          if (firstReject !== -1) {
            for (const o of outcomes.slice(firstReject + 1)) {
              if (o.rejected || !o.result.done || o.result.value !== undefined) {
                throw new Error('post-rejection pull was not a clean { done: true, value: undefined }');
              }
            }
          }
          for (const o of outcomes) {
            if (!o.rejected && !o.result.done && !values.includes(/** @type {number} */ (o.result.value))) {
              throw new Error(`yielded a value not from the source: ${String(o.result.value)}`);
            }
          }

          await new Promise(resolve => { setImmediate(resolve); }); // let unhandledRejection detection settle
          if (unhandled > unhandledBefore) {
            throw new Error(`${unhandled - unhandledBefore} unhandled rejection(s)`);
          }
        }
      ), fcParams);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('protocol: op sequences settle like a native AsyncGenerator (documented divergences excepted)', async () => {
    await fc.assert(fc.asyncProperty(
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
          bufferedAsyncMap(libSrc(), async (v) => v, { ordered: true, bufferSize: 1 }),
          ops, thrownError
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
    ), fcParams);
  });
});

/* eslint-disable promise/prefer-await-to-then */

import { findLeastTargeted } from './lib/find-least-targeted.js';
import { arrayDeleteInPlace, makeIterableAsync, normalizeError } from './lib/misc.js';
import {
  isAsyncIterable, isIterable, isObject, isPartOfArray,
} from './lib/type-checks.js';

// Tags the internal catch-envelope produced when a source / sub-iterator
// next() rejects (or throws synchronously). A private symbol cannot collide
// with properties on foreign IteratorResults — discriminating on a string
// key ('err' in result) silently converted spec-legal results that happened
// to carry their own `err` property into error envelopes, dropping values.
const ERR = Symbol('bufferedAsyncMap error');

/**
 * @template T
 * @param {AsyncIterable<T> | Iterable<T> | T[]} item
 * @returns {AsyncIterable<T>}
 */
async function * yieldIterable (item) {
  yield * item;
}

/**
 * Merge several async (or sync) iterables in parallel. Items are yielded as
 * they become available. Returns the underlying `bufferedAsyncMap` iterator
 * directly so it picks up `Symbol.asyncDispose` (Node 22's native async
 * generators don't carry one) and the proper return type. Thin wrapper —
 * see `bufferedAsyncMap` for the full semantics of each option.
 *
 * Note: construction is now eager — input validation throws at call time
 * rather than at first `.next()`.
 *
 * @template T
 * @param {Array<AsyncIterable<T> | Iterable<T> | T[]>} input
 * @param {{ bufferSize?: number|undefined, cleanupTimeout?: number|undefined, errors?: 'fail-eventually'|'fail-fast'|undefined, ordered?: boolean|undefined, signal?: AbortSignal|undefined }} [options]
 * @returns {BufferedAsyncIterableIterator<T>}
 */
export function mergeIterables (input, options) {
  return bufferedAsyncMap(input, yieldIterable, options);
}

/**
 * Standalone (non-intersected) iterator type. Built deliberately without
 * `AsyncIterableIterator<R> & ...`: in an intersection the built-in
 * `any`-typed `next`/`return`/`throw` signatures win overload resolution and
 * leak `any` through the param types. The shape below is still structurally
 * assignable to `AsyncIterableIterator<R>` (its method params are `any`).
 *
 * @template R
 * @typedef {{
 *   next(): Promise<IteratorResult<R, undefined>>,
 *   return(value?: any): Promise<IteratorReturnResult<any>>,
 *   throw(err?: any): Promise<IteratorResult<R, undefined>>,
 *   [Symbol.asyncIterator](): BufferedAsyncIterableIterator<R>,
 *   [Symbol.asyncDispose](): Promise<void>,
 * }} BufferedAsyncIterableIterator
 */

/**
 * Iterates `input` concurrently, applying `callback` to each item with up to
 * `bufferSize` calls in flight. The per-callback `signal` is **always**
 * present (even when no `options.signal` is passed) and aborts on iterator
 * close — `return()`, `throw()`, `Symbol.asyncDispose`, source exhaustion,
 * external abort, or first error in `errors: 'fail-fast'` mode — so callbacks
 * can fast-path on shutdown.
 *
 * @template T
 * @template R
 * @param {AsyncIterable<T> | Iterable<T> | T[]} input
 * @param {(item: T, opts: { signal: AbortSignal }) => (Promise<R>|AsyncIterable<R>)} callback
 * @param {{ bufferSize?: number|undefined, cleanupTimeout?: number|undefined, ordered?: boolean|undefined, signal?: AbortSignal|undefined, errors?: 'fail-eventually'|'fail-fast'|undefined }} [options]
 * @returns {BufferedAsyncIterableIterator<R>}
 */
export function bufferedAsyncMap (input, callback, options) {
  /** @typedef {Promise<{ bufferPromise: BufferPromise, isSubIterator: boolean, value: R | AsyncIterable<R> | undefined, fromSubIterator?: boolean, done?: boolean, err?: Error | undefined }>} BufferPromise */
  const {
    bufferSize = 6,
    cleanupTimeout,
    errors: errorsMode = 'fail-eventually',
    ordered = false,
    signal: externalSignal,
  } = options || {};

  /** @type {AsyncIterable<T, void, void>} */
  const asyncIterable = (isIterable(input) || Array.isArray(input))
    ? makeIterableAsync(/** @type {Iterable<T> | T[]} */ (input))
    : input;

  if (!input) throw new TypeError('Expected input to be provided');
  if (!isAsyncIterable(asyncIterable)) throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (!Number.isInteger(bufferSize) || bufferSize < 1) throw new TypeError('Expected bufferSize to be a positive integer');
  if (cleanupTimeout !== undefined && (typeof cleanupTimeout !== 'number' || !Number.isFinite(cleanupTimeout) || cleanupTimeout <= 0)) {
    throw new TypeError('Expected cleanupTimeout to be a positive finite number of milliseconds');
  }
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('Expected signal to be an AbortSignal');
  if (errorsMode !== 'fail-eventually' && errorsMode !== 'fail-fast') throw new TypeError("Expected errors to be 'fail-eventually' or 'fail-fast'");

  /** @type {AsyncIterator<T, void, void>} */
  const asyncIterator = asyncIterable[Symbol.asyncIterator]();

  /** @type {AsyncIterator<R, void, void>[]} */
  const subIterators = [];

  // Iterators pulled from the rotation because they produced a malformed
  // (non-object) result. They are still nominally open — unlike a rejecting
  // .next(), which closes the iterator per protocol — so markAsEnded must
  // still .return() them; "stop pulling" and "skip cleanup" are separate
  // concerns.
  /** @type {Array<AsyncIterator<T, void, void> | AsyncIterator<R, void, void>>} */
  const pendingCloses = [];

  /** @type {BufferPromise[]} */
  const bufferedPromises = [];

  /** @type {WeakMap<BufferPromise, AsyncIterator<T>|AsyncIterator<R>>} */
  const promisesToSourceIteratorMap = new WeakMap();

  /** @type {boolean} */
  let mainReturnedDone;

  /** @type {boolean} */
  let isDone;

  /** @type {Error[]} */
  const capturedErrors = [];

  // Internal controller, minted unconditionally regardless of whether
  // options.signal or errors:'fail-fast' are used. The per-callback `signal`
  // contract (README "Cancellation" + CLAUDE.md) requires it: a `for await
  // … break` desugars to iterator.return() → markAsEnded() →
  // internalAbortController.abort(), which is what wakes a parked
  // nextValue() and lets in-flight callbacks observe signal.aborted=true.
  // Don't try to lazify this — the per-callback signal tests in
  // test/per-task-signal.spec.js (and test/abort.spec.js for the parallel
  // return()+abort case) pin the no-options case.
  const internalAbortController = new AbortController();

  /** @type {{ reason: unknown, delivered: boolean } | undefined} */
  let abortReason;

  if (externalSignal) {
    // AbortSignal.reason is typed `any` in the DOM lib; widen it to `unknown`
    // locally so callers don't inherit the `any` (and so type-coverage stays
    // honest — a JSDoc cast on each property read doesn't move the needle).
    /** @type {Omit<AbortSignal, 'reason'> & { reason: unknown }} */
    const safeSignal = externalSignal;
    if (safeSignal.aborted) {
      abortReason = { reason: safeSignal.reason, delivered: false };
      internalAbortController.abort(safeSignal.reason);
    } else {
      // `signal:` ties the listener's lifetime to the internal controller,
      // which markAsEnded always aborts — so a closed iterator detaches from
      // the (possibly long-lived) external signal instead of retaining this
      // closure (and transitively the whole state machine) until the external
      // signal fires or is GC'd. On external abort the listener runs first,
      // then the internal abort it triggers retires it — same net effect.
      safeSignal.addEventListener('abort', () => {
        // If the iterator already closed via return()/throw()/dispose, abort is too late: no-op.
        if (isDone) return;
        if (!abortReason) {
          abortReason = { reason: safeSignal.reason, delivered: false };
        }
        if (!internalAbortController.signal.aborted) {
          internalAbortController.abort(safeSignal.reason);
        }
      }, { once: true, signal: internalAbortController.signal });
    }
  }

  // Sentinel value distinguishing "abort fired" from any buffered promise's
  // resolution in nextValue()'s Promise.race.
  const ABORT_SENTINEL = Symbol('abort');

  // Per-pull "park": nextValue() creates a fresh deferred each pull and races
  // it alongside the buffered promises, so an abort can wake a parked pull
  // even when no buffered promise will ever settle. It is deliberately NOT a
  // single long-lived promise — racing the same never-settling promise on
  // every pull leaves a PromiseReaction on it per item, which accumulates
  // until it finally settles at iterator close (the documented
  // nodejs/node#51452 retention pattern). Per-pull parks are collectable, so
  // nothing accumulates. The single construction-time listener below resolves
  // whichever park is currently waiting (read at fire time via the mutable
  // `currentPark`); internalAbortController aborts at most once, so one
  // listener suffices. If the signal is already aborted (pre-aborted external
  // signal) the listener never fires — fine, because handleAbortIfPending()
  // short-circuits nextValue() via `abortReason` before it reaches the race.
  /** @type {{ resolve: (value: typeof ABORT_SENTINEL) => void } | undefined} */
  let currentPark;

  internalAbortController.signal.addEventListener(
    'abort',
    () => currentPark?.resolve(ABORT_SENTINEL),
    { once: true }
  );

  /**
   * Single cleanup path. Idempotent via `isDone`. Called from `return()`,
   * `throw()`, `Symbol.asyncDispose`, source exhaustion, and abort delivery.
   * Always fires `internalAbortController.abort()` — this is what wakes a parked
   * nextValue() and signals in-flight callbacks via the per-task signal.
   *
   * The cleanup body runs once; the resolved result still reflects *this*
   * call's `value` (so `return(v)` is spec-correct even after the iterator
   * has already closed).
   *
   * @param {boolean} [throwAnyError]
   * @returns {Promise<IteratorReturnResult<undefined>>}
   */
  const markAsEnded = async (throwAnyError) => {
    if (!isDone) {
      isDone = true;

      if (!internalAbortController.signal.aborted) {
        internalAbortController.abort();
      }

      // Source .return() rejections are intentionally swallowed: allSettled
      // keeps cleanup going even if one source's return() rejects, so a broken
      // cleanup can't mask the consumer-facing error or leave buffers uncleared.
      // Wrap as async so a sync-throwing .return getter or body becomes a
      // promise rejection that allSettled can swallow.
      const cleanup = Promise.allSettled(
        [
          // Ensure the main iterators are completed
          ...(mainReturnedDone ? [] : [asyncIterator]),
          ...subIterators,
          // Iterators dropped from the rotation for malformed results but
          // never closed — still owed a .return()
          ...pendingCloses,
        ]
          .map(async item => item.return && item.return())
      );

      // If the caller opted into a cleanup deadline, race it. A source stuck
      // in a hung await would otherwise queue .return() behind the hung
      // .next() and never settle — hanging the consumer-facing close /
      // abort forever. The timer is cleared once the race settles so a prompt
      // cleanup doesn't leave a pending setTimeout keeping the event loop
      // alive for the rest of the (possibly long) cleanupTimeout window.
      if (cleanupTimeout === undefined) {
        await cleanup;
      } else {
        /** @type {(value: void) => void} */
        let fireTimeout;
        const timeout = new Promise(resolve => { fireTimeout = resolve; });
        const timer = setTimeout(() => fireTimeout(), cleanupTimeout);
        try {
          await Promise.race([cleanup, timeout]);
        } finally {
          clearTimeout(timer);
        }
      }

      bufferedPromises.splice(0);
      subIterators.splice(0);
      pendingCloses.splice(0);

      if (throwAnyError && capturedErrors.length > 0) {
        throw capturedErrors.length === 1
          ? capturedErrors[0]
          : new AggregateError(capturedErrors, 'Multiple errors in bufferedAsyncMap');
      }
    }

    return { done: true, value: undefined };
  };

  // The two envelope shapes every buffer slot resolves to, each with a
  // single construction site so its V8 hidden class is structural, not
  // comment-enforced. The value shape is deliberately lean — the consumer's
  // hot path only reads isSubIterator/value, so it stays the 3-field object
  // it always was (bufferSize-scaling benches regress ~10-15% if the hot
  // literal grows to carry the terminal-only fields). The terminal shape
  // carries the drain bookkeeping (fromSubIterator/done/err). Two stable
  // maps keep nextValue's property loads cheaply polymorphic. Envelopes
  // never reject: the pipeline below catches rejections, sync throws and
  // malformed results alike, which is what makes nextValue's Promise.race
  // reject-proof and lets markAsEnded splice pending slots without creating
  // unhandled rejections.

  /**
   * @param {BufferPromise} bufferPromise
   * @param {boolean} isSubIterator
   * @param {R | AsyncIterable<R>} value
   * @returns {Awaited<BufferPromise>}
   */
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const valueEnvelope = (bufferPromise, isSubIterator, value) =>
    ({ bufferPromise, isSubIterator, value });

  /**
   * Terminal slot: `done` and/or `err`. All fields set (explicitly
   * `undefined` when absent) for one shared hidden class across the done,
   * error and malformed arms.
   *
   * @param {BufferPromise} bufferPromise
   * @param {boolean} fromSubIterator
   * @param {Error} [err]
   * @returns {Awaited<BufferPromise>}
   */

  const terminalEnvelope = (bufferPromise, fromSubIterator, err) =>
    ({ bufferPromise, isSubIterator: false, value: undefined, fromSubIterator, done: true, err });

  // Producer: pulls from source up to bufferSize, dispatches via callback,
  // pushes the wrapped promise into bufferedPromises. In `ordered: true`
  // mode it always feeds from subIterators[0]; in `ordered: false` mode it
  // picks the least-targeted iterator via findLeastTargeted to prevent
  // starvation — but only once a sub-iterator actually exists, since with
  // none there is nothing to balance and the main iterator is the only
  // source.
  const fillQueue = () => {
    if (capturedErrors.length > 0 || isDone || abortReason) return;

    /** @type {AsyncIterator<R, void, void>|undefined} */
    let currentSubIterator;

    if (ordered || subIterators.length === 0) {
      currentSubIterator = ordered ? subIterators[0] : undefined;
    } else {
      const iterator = findLeastTargeted(
        mainReturnedDone ? subIterators : [...subIterators, asyncIterator],
        bufferedPromises,
        promisesToSourceIteratorMap
      );

      currentSubIterator = isPartOfArray(iterator, subIterators) ? iterator : undefined;
    }

    // A sync-throwing .next() must flow through the same envelope path as a
    // rejecting one — evaluate it inside try/catch and let the adjacent
    // .catch (attached synchronously, so there is no unhandledRejection
    // window) normalize both into the ERR-tagged catch-envelope.
    //
    // Discrimination order in the .then matters: isObject first (`in` throws
    // on primitives, and a malformed next() can resolve to one), then the
    // ERR tag, then done.
    /** @type {BufferPromise} */
    let bufferPromise;

    if (currentSubIterator) {
      const subIterator = currentSubIterator;

      /** @type {Promise<IteratorResult<R, void>>} */
      let step;
      try {
        step = subIterator.next();
      } catch (err) {
        step = Promise.reject(err);
      }

      bufferPromise = Promise.resolve(step)
        .catch((/** @type {unknown} */ err) => ({
          [ERR]: normalizeError(err, 'Unknown subiterator error'),
        }))
        .then(result => {
          if (!isObject(result)) {
            // Malformed result: stop pulling from this iterator, but it is
            // still nominally open — leave it to markAsEnded to .return()
            arrayDeleteInPlace(subIterators, subIterator);
            pendingCloses.push(subIterator);
            return terminalEnvelope(bufferPromise, true, new TypeError('Expected sub-iterator next() result to be an object'));
          }
          if (ERR in result) {
            arrayDeleteInPlace(subIterators, subIterator);
            return terminalEnvelope(bufferPromise, true, result[ERR]);
          }
          if (result.done) {
            arrayDeleteInPlace(subIterators, subIterator);
            return terminalEnvelope(bufferPromise, true);
          }

          return valueEnvelope(bufferPromise, false, result.value);
        });
    } else {
      /** @type {Promise<IteratorResult<T, void>>} */
      let step;
      try {
        step = asyncIterator.next();
      } catch (err) {
        step = Promise.reject(err);
      }

      bufferPromise = Promise.resolve(step)
        .catch((/** @type {unknown} */ err) => ({
          [ERR]: normalizeError(err, 'Unknown iterator error'),
        }))
        .then(async result => {
          if (!isObject(result)) {
            // Malformed result: stop pulling (mainReturnedDone) but the
            // source is still nominally open — record it for cleanup, which
            // the mainReturnedDone exclusion in markAsEnded would skip.
            // Deduped: a refill can pull from the source again before the
            // first malformed slot is ever raced.
            mainReturnedDone = true;
            if (!pendingCloses.includes(asyncIterator)) {
              pendingCloses.push(asyncIterator);
            }
            return terminalEnvelope(bufferPromise, false, new TypeError('Expected source iterator next() result to be an object'));
          }
          if (ERR in result) {
            mainReturnedDone = true;
            return terminalEnvelope(bufferPromise, false, result[ERR]);
          }
          if (result.done) {
            mainReturnedDone = true;
            return terminalEnvelope(bufferPromise, false);
          }

          // The dispatch sits inside the try so a synchronously-throwing
          // plain (non-async) callback becomes the same {err} envelope as a
          // rejecting one — otherwise it would reject the raw bufferPromise,
          // bypassing the errors mode entirely.
          try {
            // eslint-disable-next-line promise/no-callback-in-promise
            const callbackResult = callback(result.value, { signal: internalAbortController.signal });
            const isSubIterator = isAsyncIterable(callbackResult);
            const value = await callbackResult;

            return valueEnvelope(bufferPromise, isSubIterator, value);
          } catch (err) {
            return terminalEnvelope(bufferPromise, false, normalizeError(err, 'Unknown callback error'));
          }
        });
    }

    promisesToSourceIteratorMap.set(bufferPromise, currentSubIterator || asyncIterator);

    if (ordered && currentSubIterator) {
      // Insert after any buffer slots already produced by this sub-iterator so
      // its values stay contiguous and in order. In practice consumption is
      // 1-to-1 with production in ordered mode, so the buffer never holds a
      // second slot from the same sub-iterator at insert time and the loop
      // body below stays unentered — it is kept as a guard for that invariant.
      let i = 0;

      while (i < bufferedPromises.length && promisesToSourceIteratorMap.get(/** @type {BufferPromise} */ (bufferedPromises[i])) === currentSubIterator) {
        i += 1;
      }

      bufferedPromises.splice(i, 0, bufferPromise);
    } else {
      bufferedPromises.push(bufferPromise);
    }

    if (bufferedPromises.length < bufferSize) {
      fillQueue();
    }
  };

  /**
   * Drives the "reject the next .next() once with abortReason.reason, then
   * done:true forever" contract.
   *
   * Returns a descriptor rather than throwing directly so the caller can
   * run cleanup (markAsEnded) before propagating the reason. Returns
   * `undefined` when no abort is pending — caller continues normally.
   *
   * An abort that is still undelivered when an explicit closer
   * (return/throw/dispose) has already set isDone is suppressed, not
   * delivered: the consumer chose to close, so a later next() resolves
   * { done: true } — matching native AsyncGenerator — instead of rejecting
   * through a closed iterator with a stale signal.reason. A parked next()
   * being woken BY the abort is unaffected (delivery there runs before
   * markAsEnded flips isDone).
   *
   * @returns {{ kind: 'throw', reason: unknown } | { kind: 'done' } | undefined}
   */
  const handleAbortIfPending = () => {
    if (abortReason && !abortReason.delivered) {
      abortReason.delivered = true;
      return isDone
        ? { kind: 'done' }
        : { kind: 'throw', reason: abortReason.reason };
    }
    if (abortReason && abortReason.delivered) {
      return { kind: 'done' };
    }
    // Implicit `undefined` return = "no abort pending, caller continues normally".
    // Lint rejects an explicit `return undefined` / `return` here.
  };

  /**
   * Routes a stream error — from the source, the callback, or a malformed
   * sub-iterable — through the configured error mode. In `fail-fast` mode the
   * first error short-circuits iteration via the abort machinery: this either
   * throws the reason or returns the terminal `{ done: true }`. In
   * `fail-eventually` mode it captures the error and returns `undefined`, so
   * the caller keeps draining.
   *
   * @param {Error} normalizedErr
   * @returns {Promise<{ done: true, value: undefined } | undefined>}
   */
  const handleStreamError = async (normalizedErr) => {
    // In fail-fast mode the first captured error short-circuits iteration:
    // route it through the same abort machinery so the next .next() rejects
    // with the original error and in-flight callbacks see signal.aborted=true.
    if (errorsMode === 'fail-fast' && !abortReason) {
      abortReason = { reason: normalizedErr, delivered: false };
      if (!internalAbortController.signal.aborted) {
        internalAbortController.abort(normalizedErr);
      }
      await markAsEnded();
      if (abortReason && !abortReason.delivered) {
        abortReason.delivered = true;
        throw normalizedErr;
      }
      return { done: true, value: undefined };
    }

    // fail-eventually: capture and fall through — implicit `undefined` return
    // tells the caller to keep draining. Lint rejects an explicit `return`.
    capturedErrors.push(normalizedErr);
  };

  // Consumer: races buffered promises against a fresh per-pull park promise.
  // Abort always wins over a buffered value that may have settled in the
  // same tick — the post-race code re-checks abortReason regardless of
  // which entry won the race. Typed as a plain zero-arg thunk (it never
  // reads an argument) so it can be passed straight to currentStep.then().
  /** @type {() => Promise<IteratorResult<R>>} */
  const nextValue = async () => {
    {
      const earlyAbort = handleAbortIfPending();
      if (earlyAbort) {
        await markAsEnded();
        if (earlyAbort.kind === 'throw') throw earlyAbort.reason;
        return { done: true, value: undefined };
      }
    }

    const nextBufferedPromise = bufferedPromises[0];

    if (!nextBufferedPromise) return markAsEnded(true);
    if (isDone) return { done: true, value: undefined };

    // Fresh per-pull park: the executor runs synchronously, so currentPark is
    // set before the race below. parkPromise is the last entry in the race so
    // a buffered value resolving in the same tick still gets re-checked
    // against abortReason afterwards. The park is cleared once the race
    // settles, so the construction-time abort listener becomes a no-op
    // between pulls.
    /** @type {Promise<typeof ABORT_SENTINEL>} */
    const parkPromise = new Promise(resolve => {
      currentPark = { resolve };
    });

    const raced = await Promise.race(
      ordered
        ? [nextBufferedPromise, parkPromise]
        : [...bufferedPromises, parkPromise]
    );

    // Cleared unconditionally: every buffer slot resolves to an envelope
    // (fillQueue's pipeline catches rejections, sync throws and malformed
    // results alike), so the race above cannot reject and this line is
    // always reached. Single-flight is what makes the one mutable park slot
    // safe — guaranteed structurally by next()'s currentStep chaining; the
    // other close paths (return/throw/dispose) never call nextValue().
    currentPark = undefined;

    if (raced === ABORT_SENTINEL || abortReason) {
      const handled = handleAbortIfPending();
      await markAsEnded();
      if (handled?.kind === 'throw') throw handled.reason;
      return { done: true, value: undefined };
    }

    /** @type {Awaited<BufferPromise>} */
    const resolvedPromise = raced;
    arrayDeleteInPlace(bufferedPromises, resolvedPromise.bufferPromise);

    // Wait for some of the current promises to be finished
    const {
      done,
      err,
      fromSubIterator,
      isSubIterator,
      value,
    } = resolvedPromise;

    // Refill if a sub-iterator is in play, then either close on drain or
    // recurse for the next value. Shared by the error and the
    // malformed-sub-iterable paths.
    //
    // The abortReason check matters on the drain branch: an external abort
    // can land in the microtask window of the `await handleStreamError(...)`
    // preceding this call, after the top-of-nextValue abort check already
    // ran. markAsEnded(true) would then throw the captured errors AND leave
    // the abort undelivered — two consecutive rejections, breaking both
    // "external abort wins over queued errors" and "reject exactly once".
    // Re-entering nextValue routes delivery through its top block instead.
    /** @returns {Promise<IteratorResult<R>>} */
    const drainOrContinue = () => {
      if (fromSubIterator || subIterators.length > 0) {
        fillQueue();
      }

      return (bufferedPromises.length === 0 && !abortReason)
        ? markAsEnded(true)
        : nextValue();
    };

    // We are mandated by the spec to always do this return if the iterator is done
    if (isDone) {
      return { done: true, value: undefined };
    } else if (err || done) {
      if (err) {
        const handled = await handleStreamError(normalizeError(err, 'Unknown error'));
        if (handled) return handled;
      }

      return drainOrContinue();
    } else if (isSubIterator && isAsyncIterable(value)) {
      /** @type {AsyncIterator<R, void, void>} */
      let subIterator;

      try {
        subIterator = /** @type {AsyncIterable<R, void, void>} */ (value)[Symbol.asyncIterator]();
      } catch (subIterableErr) {
        // The callback returned a malformed async iterable — the
        // Symbol.asyncIterator property exists but invoking it threw.
        // Surface it like any other stream error.
        const handled = await handleStreamError(normalizeError(subIterableErr, 'Unknown sub-iterator error'));
        if (handled) return handled;
        return drainOrContinue();
      }

      subIterators.unshift(subIterator);
      fillQueue();
      return nextValue();
    } else {
      fillQueue();

      return /** @type {IteratorYieldResult<R>} */ ({ value });
    }
  };

  /** @type {Promise<IteratorResult<R>>} */
  let currentStep;

  /** @type {BufferedAsyncIterableIterator<R>} */
  const resultAsyncIterableIterator = {
    async next () {
      // Chain via then(nextValue, nextValue) so a rejection on one .next() does
      // not poison every subsequent call — the next call still reaches
      // nextValue() which observes the post-rejection state machine.
      currentStep = currentStep
        ? currentStep.then(nextValue, nextValue)
        : nextValue();
      return currentStep;
    },
    // return() deliberately bypasses the currentStep chain: it calls
    // markAsEnded() directly (and thus internalAbortController.abort()) so a parked
    // next() awaiting a buffered promise wakes up via its per-pull park. This is
    // what lets `for await … break` work — break desugars to return() running
    // concurrently with the in-flight next().
    // `value` is awaited (matching AsyncGenerator.prototype.return) so a
    // thenable argument never lands in the IteratorResult's value field;
    // cleanup runs once but each call's result reflects its own argument.
    // If the await rejects, cleanup still runs before the rejection
    // propagates — matching the "as-if a `return value;` was inserted at the
    // suspension point" model (`finally` blocks run regardless).
    'return': async (value) => {
      /** @type {R | undefined} */
      let awaited;
      try {
        awaited = await value;
      } catch (err) {
        await markAsEnded();
        throw err;
      }

      // `false` = don't throw captured fail-eventually errors; return(value)
      // shouldn't surface earlier callback errors on top of the consumer's
      // explicit early exit. The resolved value is threaded back here so the
      // IteratorResult mirrors *this* call's argument even after the iterator
      // has already closed.
      await markAsEnded(false);
      return { done: true, value: awaited };
    },
    'throw': async (err) => {
      // Spec-correct as-is: throw(err) rejects once, markAsEnded() closes the
      // iterator, and subsequent .next() returns { done: true } — no need to
      // "remember" the throw or reject forever. Pinned by test/throw.spec.js.
      await markAsEnded();
      throw err;
    },

    [Symbol.asyncIterator]: () => resultAsyncIterableIterator,
    [Symbol.asyncDispose]: async () => {
      await markAsEnded();
    },
  };

  fillQueue();

  return resultAsyncIterableIterator;
}

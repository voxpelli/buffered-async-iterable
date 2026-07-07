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
 * Note: construction is eager — the input array AND its elements are
 * validated at call time, not at first `.next()`. A bad element would
 * otherwise surface minutes later as a deferred fail-eventually TypeError
 * (possibly wrapped in an AggregateError) after every healthy source
 * drained. Strings are deliberately rejected even though they're iterable:
 * merging 'abc' as the chars 'a','b','c' is almost always a caller mistake
 * — spread the string explicitly if chars are wanted.
 *
 * @template T
 * @param {Array<AsyncIterable<T> | Iterable<T> | T[]>} input
 * @param {{ bufferSize?: number|undefined, cleanupTimeout?: number|undefined, errors?: 'fail-eventually'|'fail-fast'|undefined, ordered?: boolean|undefined, signal?: AbortSignal|undefined }} [options]
 * @returns {BufferedAsyncIterableIterator<T>}
 */
export function mergeIterables (input, options) {
  if (!Array.isArray(input)) throw new TypeError('Expected input to be an array of iterables');

  for (const [i, item] of input.entries()) {
    // Strings fail these guards too (they're iterable but not objects) —
    // intentional, see the docblock.
    if (!isAsyncIterable(item) && !isIterable(item) && !Array.isArray(item)) {
      throw new TypeError(`Expected input[${i}] to be an (async) iterable or array${typeof item === 'string' ? ' — strings are not merged char-by-char, spread the string first if that is intended' : ''}`);
    }
  }

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

  // Async iteration is preferred when the input implements both protocols —
  // matching for-await's GetIterator(async) order; the sync-iterable wrap is
  // only for inputs with no async protocol at all.
  /** @type {AsyncIterable<T, void, void>} */
  const asyncIterable = (!isAsyncIterable(input) && (isIterable(input) || Array.isArray(input)))
    ? makeIterableAsync(/** @type {Iterable<T> | T[]} */ (input))
    : /** @type {AsyncIterable<T, void, void>} */ (input);

  if (!input) throw new TypeError('Expected input to be provided');
  // `in`-presence alone isn't enough — a non-callable Symbol.asyncIterator
  // member would otherwise escape with an unbranded TypeError at invocation.
  if (!isAsyncIterable(asyncIterable) || typeof asyncIterable[Symbol.asyncIterator] !== 'function') throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (!Number.isInteger(bufferSize) || bufferSize < 1) throw new TypeError('Expected bufferSize to be a positive integer');
  // 2147483647 = Node's TIMEOUT_MAX (2^31-1): setTimeout silently clamps
  // anything above it to 1ms, which would invert the caller's intent — a
  // "wait ~25 days" grace period becoming "abandon cleanup after 1ms".
  if (cleanupTimeout !== undefined && (typeof cleanupTimeout !== 'number' || !Number.isFinite(cleanupTimeout) || cleanupTimeout <= 0 || cleanupTimeout > 2147483647)) {
    throw new TypeError('Expected cleanupTimeout to be a positive number of milliseconds no larger than 2147483647 (2^31-1)');
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

  /**
   * Single writer for the abort pairing: records the consumer-facing
   * abortReason (first writer wins) and aborts the internal controller with
   * the same reason — keeping the per-callback signal's reason and the
   * consumer-facing rejection from ever diverging. Every abort source
   * (pre-aborted signal, external abort, first fail-fast error) goes
   * through here.
   *
   * @param {unknown} reason
   * @returns {{ reason: unknown, delivered: boolean }} the winning record
   */
  const requestConsumerAbort = (reason) => {
    if (!abortReason) {
      abortReason = { reason, delivered: false };
    }
    if (!internalAbortController.signal.aborted) {
      internalAbortController.abort(reason);
    }
    return abortReason;
  };

  if (externalSignal) {
    // AbortSignal.reason is typed `any` in the DOM lib; widen it to `unknown`
    // locally so callers don't inherit the `any` (and so type-coverage stays
    // honest — a JSDoc cast on each property read doesn't move the needle).
    /** @type {Omit<AbortSignal, 'reason'> & { reason: unknown }} */
    const safeSignal = externalSignal;
    if (safeSignal.aborted) {
      requestConsumerAbort(safeSignal.reason);
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
        requestConsumerAbort(safeSignal.reason);
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
   * The cleanup body: runs exactly once, launched by the first closer. It
   * cannot reject (allSettled + splices), so awaiting it is always safe.
   * Fires `internalAbortController.abort()` synchronously — this is what
   * wakes a parked nextValue() and signals in-flight callbacks via the
   * per-task signal.
   *
   * @returns {Promise<void>}
   */
  const doCleanup = async () => {
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
  };

  /** @type {Promise<void> | undefined} */
  let cleanupPromise;

  /**
   * Single cleanup path. Called from `return()`, `throw()`,
   * `Symbol.asyncDispose`, source exhaustion, and abort delivery.
   *
   * Await-idempotent, matching native AsyncGenerator's request queue: the
   * first closer launches doCleanup() and EVERY closer — including later
   * ones that find isDone already set — awaits the same cleanupPromise
   * before resolving. A second closer must not resolve `{ done: true }`
   * while the source's `finally` is still running (the cross-task
   * return()-while-parked case), or `await using` scopes would exit before
   * cleanup settled.
   *
   * The captured fail-eventually errors throw only for the FIRST closer
   * that asked for them (`throwAnyError`) — a later markAsEnded(true) after
   * the drain-throw (or after a swallowing return()) stays `{ done: true }`,
   * preserving "reject exactly once, then done forever".
   *
   * @param {boolean} [throwAnyError]
   * @returns {Promise<IteratorReturnResult<undefined>>}
   */
  const markAsEnded = async (throwAnyError) => {
    const firstCloser = !isDone;

    if (firstCloser) {
      isDone = true;
      cleanupPromise = doCleanup();
    }

    await cleanupPromise;

    if (firstCloser && throwAnyError && capturedErrors.length > 0) {
      throw capturedErrors.length === 1
        ? capturedErrors[0]
        : new AggregateError(capturedErrors, 'Multiple errors in bufferedAsyncMap');
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
  //
  // Iterative on purpose: the refill was previously a tail self-recursion,
  // which put O(bufferSize) frames on the stack during the construction-time
  // fill — RangeError at bufferSize ≈7000 on stock Node, while validation
  // happily accepts any positive integer.
  const fillQueue = () => {
    while (bufferedPromises.length < bufferSize) {
      if (capturedErrors.length > 0 || isDone || abortReason) return;

      fillOneSlot();
    }
  };

  const fillOneSlot = () => {
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
   * The one abort-delivery sequence, shared by nextValue's pre-race and
   * post-race sites: consume the pending descriptor, run (or await the
   * in-flight) cleanup, then throw the reason or resolve done. Also handles
   * the no-descriptor wake (a park resolved by a plain close): plain
   * cleanup-then-done.
   *
   * @returns {Promise<IteratorResult<R, undefined>>}
   */
  const deliverAbort = async () => {
    const handled = handleAbortIfPending();
    await markAsEnded();
    if (handled?.kind === 'throw') throw handled.reason;
    return { done: true, value: undefined };
  };

  /**
   * Terminal-slot follow-up shared by the error and malformed-sub-iterable
   * paths: refill if a sub-iterator is in play, then close on drain or
   * recurse for the next value. Hoisted out of nextValue — the happy path
   * never calls it, so it shouldn't cost a per-pull closure allocation;
   * `fromSubIterator` is the only per-pull input, passed as a parameter.
   *
   * The abortReason check matters on the drain branch: an external abort
   * can land in the microtask window of the `await handleStreamError(...)`
   * preceding this call, after the top-of-nextValue abort check already
   * ran. markAsEnded(true) would then throw the captured errors AND leave
   * the abort undelivered — two consecutive rejections, breaking both
   * "external abort wins over queued errors" and "reject exactly once".
   * Re-entering nextValue routes delivery through its top block instead.
   *
   * @param {boolean | undefined} fromSubIterator
   * @returns {Promise<IteratorResult<R>>}
   */
  const drainOrContinue = (fromSubIterator) => {
    if (fromSubIterator || subIterators.length > 0) {
      fillQueue();
    }

    return (bufferedPromises.length === 0 && !abortReason)
      ? markAsEnded(true)
      : nextValue();
  };

  /**
   * Routes a stream error — from the source, the callback, or a malformed
   * sub-iterable — through the configured error mode. In `fail-fast` mode
   * the first error short-circuits iteration via the abort machinery and
   * this THROWS the original error (that rejection is the exactly-once
   * delivery: nothing else can deliver during the markAsEnded await, since
   * delivery is single-flight on the currentStep chain). In
   * `fail-eventually` mode it captures the error and returns, so the caller
   * keeps draining.
   *
   * @param {Error} normalizedErr
   * @returns {Promise<void>}
   */
  const handleStreamError = async (normalizedErr) => {
    // In fail-fast mode the first captured error short-circuits iteration:
    // route it through the same abort machinery so the next .next() rejects
    // with the original error and in-flight callbacks see signal.aborted=true.
    if (errorsMode === 'fail-fast' && !abortReason) {
      const pending = requestConsumerAbort(normalizedErr);
      await markAsEnded();
      pending.delivered = true;
      throw normalizedErr;
    }

    // fail-eventually: capture and fall through — the caller keeps draining.
    capturedErrors.push(normalizedErr);
  };

  // Consumer: races buffered promises against a fresh per-pull park promise.
  // Abort always wins over a buffered value that may have settled in the
  // same tick — the post-race code re-checks abortReason regardless of
  // which entry won the race. Typed as a plain zero-arg thunk (it never
  // reads an argument) so it can be passed straight to currentStep.then().
  /** @type {() => Promise<IteratorResult<R>>} */
  const nextValue = async () => {
    if (abortReason) return deliverAbort();

    const nextBufferedPromise = bufferedPromises[0];

    if (!nextBufferedPromise) return markAsEnded(true);
    // Routed through markAsEnded (not a bare { done: true }) so a pull that
    // observes a concurrent closer's isDone still awaits that closer's
    // in-flight cleanup before resolving — the await-idempotence contract.
    if (isDone) return markAsEnded();

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
      return deliverAbort();
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

    // We are mandated by the spec to always do this return if the iterator is
    // done — via markAsEnded so the concurrent closer's cleanup is awaited too
    if (isDone) {
      return markAsEnded();
    } else if (err || done) {
      if (err) {
        // Throws in fail-fast delivery; captures and returns in fail-eventually
        await handleStreamError(normalizeError(err, 'Unknown error'));
      }

      return drainOrContinue(fromSubIterator);
    } else if (isSubIterator && isAsyncIterable(value)) {
      /** @type {AsyncIterator<R, void, void>} */
      let subIterator;

      try {
        subIterator = /** @type {AsyncIterable<R, void, void>} */ (value)[Symbol.asyncIterator]();
      } catch (subIterableErr) {
        // The callback returned a malformed async iterable — the
        // Symbol.asyncIterator property exists but invoking it threw.
        // Surface it like any other stream error.
        await handleStreamError(normalizeError(subIterableErr, 'Unknown sub-iterator error'));
        return drainOrContinue(fromSubIterator);
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
      // Close BEFORE awaiting the argument: native AsyncGenerator enqueues
      // the return request immediately, so a concurrent next() during a
      // still-pending return(thenable) resolves { done: true } and the
      // source is not pulled further. `false` = don't throw captured
      // fail-eventually errors on top of the consumer's explicit early
      // exit; with that flag markAsEnded never rejects, so capturing its
      // promise before the await is safe.
      const ended = markAsEnded(false);

      /** @type {R | undefined} */
      let awaited;
      try {
        awaited = await value;
      } catch (err) {
        await ended;
        throw err;
      }

      // The resolved value is threaded back here so the IteratorResult
      // mirrors *this* call's argument even after the iterator has already
      // closed.
      await ended;
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

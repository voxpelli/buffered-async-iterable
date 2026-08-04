/* eslint-disable promise/prefer-await-to-then */

import { findLeastTargeted } from './lib/find-least-targeted.js';
import { arrayDeleteInPlace, makeIterableAsync, normalizeError } from './lib/misc.js';
import {
  isAsyncIterable, isPartOfArray, isSpecObject,
} from './lib/type-checks.js';

// Tags the internal catch-envelope produced when a source / sub-iterator
// next() rejects (or throws synchronously). A private symbol cannot collide
// with properties on foreign IteratorResults — discriminating on a string
// key ('err' in result) silently converted spec-legal results that happened
// to carry their own `err` property into error envelopes, dropping values.
const ERR = Symbol('bufferedAsyncMap error');

// `ordered: 'eager'` look-ahead default: how many values a not-yet-at-head lane
// may buffer before it parks (backpressure). 1 captures the fan-out win — the
// expensive work is before the first yield — while keeping total buffering
// bounded at bufferSize × lookahead regardless of generator length. The caller
// can override it with the `lookahead` option (eager mode only).
const DEFAULT_LANE_LOOKAHEAD = 1;

// Hoisted rejection-normalizers for safeStep — module-level so the hot pull
// path allocates zero catch closures per slot (they close over nothing but
// module scope).

/**
 * @param {unknown} err
 * @returns {{ [ERR]: Error }}
 */
const catchSubStepErr = (err) => ({ [ERR]: normalizeError(err, 'Unknown subiterator error') });

/**
 * @param {unknown} err
 * @returns {{ [ERR]: Error }}
 */
const catchMainStepErr = (err) => ({ [ERR]: normalizeError(err, 'Unknown iterator error') });

/**
 * One pull step that can never reject: a synchronously-throwing `.next()`
 * becomes a rejection, and the rejection-normalizer is attached in the same
 * synchronous frame — so there is no window in which a rejected step could
 * surface as an unhandledRejection, and every failure flows through the
 * ERR-tagged catch-envelope.
 *
 * @template V
 * @param {AsyncIterator<V, void, void>} iterator
 * @param {(err: unknown) => { [ERR]: Error }} onNextError
 * @returns {Promise<IteratorResult<V, void> | { [ERR]: Error }>}
 */
const safeStep = (iterator, onNextError) => {
  /** @type {Promise<IteratorResult<V, void>>} */
  let step;
  try {
    step = iterator.next();
  } catch (err) {
    step = Promise.reject(err);
  }
  return Promise.resolve(step).catch(onNextError);
};

/**
 * Cross-realm-safe string detector: `instanceof String` misses boxed
 * strings from another realm (node:vm), and Symbol.toStringTag makes the
 * Object.prototype.toString brand spoofable — the String.prototype method
 * brand check is the reliable probe.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isString (value) {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  try {
    String.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

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
 * validated at call time, not at first `.next()`. A bad element (including
 * a non-callable protocol member) would otherwise surface minutes later as
 * a deferred fail-eventually TypeError (possibly wrapped in an
 * AggregateError) after every healthy source drained. Strings — primitive
 * or boxed — are deliberately rejected even though they're iterable:
 * merging 'abc' as the chars 'a','b','c' is almost always a caller mistake
 * — spread the string explicitly if chars are wanted. The protocol member
 * is read once here and re-read at iteration, so elements with exotic
 * one-shot getter members are unsupported — deliberately stricter than the
 * main input, whose member is captured on a single read and invoked.
 *
 * @template T
 * @param {Array<AsyncIterable<T> | (Iterable<T> & object) | T[]>} input array of (async) iterables to merge — validated eagerly, string elements rejected
 * @param {{ bufferSize?: number|undefined, cleanupTimeout?: number|undefined, errors?: 'fail-eventually'|'fail-fast'|undefined, lookahead?: number|undefined, ordered?: boolean|'eager'|undefined, signal?: AbortSignal|undefined }} [options] same options as `bufferedAsyncMap`; `ordered: true` drains the inputs in array order, `ordered: 'eager'` dispatches concurrently but still delivers in array order (see [Ordered mode](ADVANCED.md#ordered-mode)); `lookahead` (eager only) is the per-input buffer depth
 * @returns {BufferedAsyncIterableIterator<T>} async iterator with guaranteed `return()`, `throw()` and `[Symbol.asyncDispose]()`
 */
export function mergeIterables (input, options) {
  if (!Array.isArray(input)) throw new TypeError('Expected input to be an array of iterables');

  for (const [i, item] of input.entries()) {
    if (isString(item)) {
      throw new TypeError(`Expected input[${i}] to be an (async) iterable or array — strings are not merged char-by-char, spread the string first if that is intended`);
    }

    // GetMethod-faithful eager callability: a nullish Symbol.asyncIterator
    // member falls back to Symbol.iterator (matching for-await), a
    // non-nullish non-callable member is rejected NOW with its index instead
    // of surfacing later as an unbranded consume-time TypeError.
    // eslint-disable-next-line unicorn/no-null -- `== null` is the nullish guard (GetMethod: null and undefined mean absent)
    const asyncM = item == null ? undefined : /** @type {{ [Symbol.asyncIterator]?: unknown }} */ (item)[Symbol.asyncIterator];
    // eslint-disable-next-line unicorn/no-null -- see above
    if (asyncM == null
      // eslint-disable-next-line unicorn/no-null -- see above
      ? typeof (item == null ? undefined : /** @type {{ [Symbol.iterator]?: unknown }} */ (item)[Symbol.iterator]) !== 'function'
      : typeof asyncM !== 'function') {
      throw new TypeError(`Expected input[${i}] to have a callable Symbol.asyncIterator or Symbol.iterator`);
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
 * can fast-path on shutdown. On natural source exhaustion the abort fires
 * during end-of-stream cleanup, after in-flight work has drained — callbacks
 * will NOT observe `aborted === true` mid-flight in that case (pinned by
 * test/per-task-signal.spec.js).
 *
 * A callback result with a **callable** `Symbol.asyncIterator` member fans
 * out as a nested iterable (GetMethod semantics: one read of the member,
 * nullish or non-callable means the result is a plain value); the method
 * returning a non-object is a stream error, matching `for await`.
 *
 * @template T
 * @template R
 * @param {AsyncIterable<T> | (Iterable<T> & object) | T[]} input async iterable, sync iterable or array (strings rejected — spread first if chars are intended)
 * @param {(item: T, opts: { signal: AbortSignal }) => (Promise<R>|AsyncIterable<R>)} callback async function, or async generator whose values merge into the stream; `signal` is always present
 * @param {{ bufferSize?: number|undefined, cleanupTimeout?: number|undefined, lookahead?: number|undefined, ordered?: boolean|'eager'|undefined, signal?: AbortSignal|undefined, errors?: 'fail-eventually'|'fail-fast'|undefined }} [options] `bufferSize` (concurrency, default 6), `cleanupTimeout` (ms cap on close-time source cleanup, default unbounded), `lookahead` (positive integer, `ordered: 'eager'` only, default 1 — how many values a not-yet-at-head input may buffer ahead of delivery), `ordered` (source-order delivery, default false; `'eager'` dispatches callbacks concurrently while still delivering in source order — see [Ordered mode](ADVANCED.md#ordered-mode)), `signal` (external abort), `errors` (default 'fail-eventually')
 * @returns {BufferedAsyncIterableIterator<R>} async iterator with guaranteed `return()`, `throw()` and `[Symbol.asyncDispose]()`
 */
export function bufferedAsyncMap (input, callback, options) {
  /** @typedef {Promise<{ bufferPromise: BufferPromise, isSubIterator: boolean, value: R | AsyncIterable<R> | undefined, fromSubIterator?: boolean, done?: boolean, err?: Error | undefined }>} BufferPromise */
  // NOTE: fromSubIterator/done/err exist only on TERMINAL envelopes (the lean
  // value shape never carries them — see the factories); the two factories'
  // second positional booleans mean DIFFERENT things (isSubIterator vs
  // fromSubIterator), hence the inline arg comments at every call site.

  // The `Lane` shape backs `ordered: 'eager'` (contract in ADVANCED.md, "Ordered
  // mode"): one lane per in-flight source item, in source order, with a private
  // buffer bounded to `laneLookahead` values so non-head generators dispatch
  // concurrently without unbounded buffering.
  /**
   * @template R
   * @typedef {{
   *   iterator: AsyncIterator<R, void, void> | undefined,
   *   buffer: R[],
   *   pending: Promise<Lane<R>> | undefined,
   *   dispatched: boolean,
   *   done: boolean,
   *   terminalErr: Error | undefined,
   *   phantom: boolean,
   * }} Lane
   */

  const {
    bufferSize = 6,
    cleanupTimeout,
    errors: errorsMode = 'fail-eventually',
    lookahead,
    ordered = false,
    signal: externalSignal,
  } = options || {};

  // The falsy-input guard must precede the member reads below (reading a
  // symbol off null would throw unbranded).
  if (!input) throw new TypeError('Expected input to be provided');

  // GetMethod semantics, matching for-await's GetIterator(async) exactly:
  // ONE [[Get]] of the member (no `in` probe — a Proxy has/get trap pair can
  // desync presence from value), nullish means absent (fall back to the sync
  // protocol), a non-nullish non-callable member throws, and the CAPTURED
  // method is invoked — so a stateful getter can't swap it between
  // validation and use. String primitives are the one deliberate divergence
  // (rejected; for-await would char-split); a boxed String object passed AS
  // THE INPUT still iterates chars, matching for-await — only mergeIterables
  // ELEMENTS reject boxed strings, where heterogeneous arrays make
  // accidental strings likely.
  const asyncMethod = /** @type {{ [Symbol.asyncIterator]?: unknown }} */ (input)[Symbol.asyncIterator];
  // eslint-disable-next-line unicorn/no-null -- `!= null` is the nullish guard (GetMethod: null and undefined mean absent)
  if (asyncMethod != null && typeof asyncMethod !== 'function') throw new TypeError('Expected the Symbol.asyncIterator member to be a function');

  /** @type {unknown} */
  let syncMethod;
  if (typeof asyncMethod !== 'function') {
    if (typeof input === 'string') throw new TypeError('Expected asyncIterable to not be a string — spread it first if iterating characters is intended');
    syncMethod = /** @type {{ [Symbol.iterator]?: unknown }} */ (input)[Symbol.iterator];
    if (typeof syncMethod !== 'function') throw new TypeError('Expected asyncIterable to have a callable Symbol.asyncIterator or Symbol.iterator');
  }

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
  // `ordered` was historically boolean-only and unvalidated (just defaulted).
  // The `'eager'` value opts into concurrent dispatch with in-order delivery
  // (ADVANCED.md, "Ordered mode"); anything else that isn't a boolean is
  // rejected so a typo can't silently pick a mode.
  if (typeof ordered !== 'boolean' && ordered !== 'eager') throw new TypeError("Expected ordered to be a boolean or 'eager'");

  // Single normalization of the three delivery modes. Every dispatch/race site
  // branches on `mode`, never on `ordered`'s truthiness — `'eager'` is truthy,
  // so a bare `if (ordered)` would misroute eager through the ordered path.
  /** @type {'unordered' | 'ordered' | 'eager'} */
  const mode = ordered === 'eager' ? 'eager' : (ordered ? 'ordered' : 'unordered');

  // `lookahead` tunes the per-lane buffer depth for eager mode only — buffers
  // and step-slots are per-lane, so it trades memory (and critical-path priority
  // under shared-resource contention) for pipeline depth, not the head's own
  // concurrency. Validate the shape, then reject it outright with any non-eager
  // mode rather than silently ignoring a knob that would do nothing there.
  if (lookahead !== undefined) {
    if (!Number.isInteger(lookahead) || lookahead < 1) throw new TypeError('Expected lookahead to be a positive integer');
    if (mode !== 'eager') throw new TypeError("Expected lookahead to be used only with ordered: 'eager'");
  }
  const laneLookahead = lookahead ?? DEFAULT_LANE_LOOKAHEAD;

  // Invocation happens only after every validation above has passed — the
  // captured method (never a re-read of the input) is what gets called. The
  // sync-arm shim re-invokes the captured method too, so the input object is
  // read exactly once, same as for-await.
  /** @type {AsyncIterator<T, void, void>} */
  let asyncIterator;
  if (typeof asyncMethod === 'function') {
    const candidate = asyncMethod.call(input);
    // GetIteratorFromMethod parity: native for-await throws right here for
    // a non-object iterator; entering the pipeline instead would surface it
    // later as a deferred, unbranded stream error. The sync arm has no such
    // eager check — its captured method is invoked lazily inside the shim
    // (eager invocation would add a construction-time side effect) and for-of
    // brands its own TypeError there.
    if (!isSpecObject(candidate)) throw new TypeError('Expected the Symbol.asyncIterator method to return an object');
    asyncIterator = /** @type {AsyncIterator<T, void, void>} */ (candidate);
  } else {
    asyncIterator = makeIterableAsync({
      [Symbol.iterator]: () => /** @type {() => Iterator<T>} */ (syncMethod).call(input),
    })[Symbol.asyncIterator]();
  }

  /** @type {AsyncIterator<R, void, void>[]} */
  const subIterators = [];

  // Iterators pulled from the rotation because they produced a malformed
  // (non-object) result. They are still nominally open — unlike a rejecting
  // .next(), which closes the iterator per protocol — so markAsEnded must
  // still .return() them; "stop pulling" and "skip cleanup" are separate
  // concerns.
  /** @type {Array<AsyncIterator<T, void, void> | AsyncIterator<R, void, void>>} */
  const pendingCloses = [];

  /**
   * Queues an iterator for cleanup-time .return(). Deduped: a refill can
   * pull from the same iterator again before its first malformed slot is
   * ever raced, and one .return() per iterator is all the protocol allows
   * for. Gated on isDone: once cleanup has started (or run), pendingCloses
   * has already been handed to doCleanup — a late push would either be
   * missed by the in-flight allSettled or leak past the splice.
   *
   * @param {AsyncIterator<T, void, void> | AsyncIterator<R, void, void>} it
   */
  const recordPendingClose = (it) => {
    if (!isDone && !pendingCloses.includes(it)) pendingCloses.push(it);
  };

  /** @type {BufferPromise[]} */
  const bufferedPromises = [];

  /** @type {WeakMap<BufferPromise, AsyncIterator<T>|AsyncIterator<R>>} */
  const promisesToSourceIteratorMap = new WeakMap();

  // `ordered: 'eager'` delivery structure — one lane per in-flight source item,
  // in source order (lanes[0] is the delivery head). Empty (and untouched) in
  // the ordered/unordered modes; doCleanup still iterates it to .return() any
  // live lane iterators, which is a no-op when it is empty.
  /** @type {Lane<R>[]} */
  const lanes = [];

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
        // Belt-and-braces: the `signal:` option below already detaches this
        // listener when the internal controller aborts (which every close
        // path does, synchronously with setting isDone), so this guard is
        // believed unreachable — kept as a cheap invariant assertion should
        // the detach mechanism ever change.
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
  // signal) the listener never fires — fine, because nextValue()'s pre-race
  // `abortReason` check routes to deliverAbort() before it reaches the race.
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
      // Deliberately WITHOUT abortReason and without a reason arg: a plain
      // close has no consumer-facing reason to deliver. requestConsumerAbort
      // is the single writer for the reason-paired abort; this bare abort is
      // its one intentional exception (the pairing invariant is
      // one-directional: abortReason ⇒ aborted, never the converse).
      internalAbortController.abort();
    }

    // Live `ordered: 'eager'` lane iterators are owed a .return() too. Skip any
    // already queued in pendingCloses (a malformed lane result records the
    // iterator there) so no iterator is returned twice.
    /** @type {Array<AsyncIterator<R, void, void>>} */
    const laneIterators = [];
    for (const lane of lanes) {
      if (lane.iterator && !pendingCloses.includes(lane.iterator)) {
        laneIterators.push(lane.iterator);
      }
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
        ...laneIterators,
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
    lanes.splice(0);
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
  // it always was (bufferSize-scaling benches regress by double digits (~12-17%) if the hot
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

      if (!fillOneSlot()) return;
    }
  };

  /**
   * @returns {boolean} whether a slot was filled — `false` when the pick fell through to an already-exhausted main iterator (nothing left to pull; the buffered slots drain on their own)
   */
  const fillOneSlot = () => {
    /** @type {AsyncIterator<R, void, void>|undefined} */
    let currentSubIterator;

    if (mode === 'ordered' || subIterators.length === 0) {
      currentSubIterator = mode === 'ordered' ? subIterators[0] : undefined;
    } else {
      const iterator = findLeastTargeted(
        mainReturnedDone ? subIterators : [...subIterators, asyncIterator],
        bufferedPromises,
        promisesToSourceIteratorMap
      );

      currentSubIterator = isPartOfArray(iterator, subIterators) ? iterator : undefined;
    }

    // Once the source has reported done, never pull it again — native
    // for-await makes no post-done next() calls, and a defensive source may
    // throw (spurious errors), hang, or in fail-fast mode have its spurious
    // error win the race against a slow in-flight value and drop it.
    // Sub-iterators need no such guard: a done sub leaves the rotation in
    // its own classification arm.
    if (!currentSubIterator && mainReturnedDone) return false;

    // A sync-throwing .next() must flow through the same envelope path as a
    // rejecting one — evaluate it inside try/catch and let the adjacent
    // .catch (attached synchronously, so there is no unhandledRejection
    // window) normalize both into the ERR-tagged catch-envelope.
    //
    // Discrimination order in the .then matters: isSpecObject first (`in`
    // throws on primitives, and a malformed next() can resolve to one), then
    // the brand-verified ERR tag, then done.
    /** @type {BufferPromise} */
    let bufferPromise;

    if (currentSubIterator) {
      const subIterator = currentSubIterator;

      bufferPromise = safeStep(subIterator, catchSubStepErr)
        .then(result => {
          // Classification: 0 = value, 1 = malformed/unreadable (iterator
          // still nominally open — owed a cleanup-time .return()), 2 =
          // rejected next() (closed per protocol), 3 = done.
          let kind = 0;
          /** @type {Error | undefined} */
          let stepErr;
          /** @type {R | undefined} */
          let stepValue;

          // The try contains ONLY the foreign-object reads: `in` and the
          // done/value property loads can hit Proxy traps or throwing
          // getters, and a throw here would otherwise reject bufferPromise —
          // breaking the "envelopes never reject" invariant. All bookkeeping
          // stays outside so a throw cannot leave it half-applied.
          // KEEP IN SYNC with the twin classification in the main arm below.
          try {
            if (!isSpecObject(result)) {
              kind = 1;
              stepErr = new TypeError('Expected sub-iterator next() result to be an object');
            } else {
              // Read-once + brand-verify: a Proxy has-trap can lie about the
              // private ERR symbol, so kind 2 additionally requires the
              // same-realm Error every catch handler attaches (normalizeError
              // guarantees it). A spoofed tag falls through to the done/value
              // reads — exactly what native for-await does with that proxy.
              const maybeErr = ERR in result ? result[ERR] : undefined;
              if (maybeErr instanceof Error) {
                kind = 2;
                stepErr = maybeErr;
              } else {
                const step = /** @type {IteratorResult<R, void>} */ (result);
                if (step.done) {
                  kind = 3;
                } else {
                  stepValue = step.value;
                }
              }
            }
          } catch (err) {
            kind = 1;
            stepErr = normalizeError(err, 'Failed to read sub-iterator next() result');
          }

          if (kind === 0) return valueEnvelope(bufferPromise, /* isSubIterator */ false, /** @type {R} */ (stepValue));

          // Malformed result (kind 1): stop pulling from this iterator, but
          // it is still nominally open — leave it to markAsEnded to
          // .return(). A rejecting next() (kind 2) closed it per protocol,
          // so no pending close there.
          arrayDeleteInPlace(subIterators, subIterator);
          if (kind === 1) recordPendingClose(subIterator);
          return terminalEnvelope(bufferPromise, /* fromSubIterator */ true, stepErr);
        });
    } else {
      bufferPromise = safeStep(asyncIterator, catchMainStepErr)
        .then(async result => {
          // Classification: 0 = value, 1 = malformed/unreadable (source
          // still nominally open — owed a cleanup-time .return()), 2 =
          // rejected next() (closed per protocol), 3 = done.
          let kind = 0;
          /** @type {Error | undefined} */
          let stepErr;
          /** @type {T | undefined} */
          let stepValue;

          // The try contains ONLY the foreign-object reads: `in` and the
          // done/value property loads can hit Proxy traps or throwing
          // getters, and a throw here would otherwise reject bufferPromise —
          // breaking the "envelopes never reject" invariant. All bookkeeping
          // stays outside so a throw cannot leave it half-applied.
          // KEEP IN SYNC with the twin classification in the sub arm above.
          try {
            if (!isSpecObject(result)) {
              kind = 1;
              stepErr = new TypeError('Expected source iterator next() result to be an object');
            } else {
              // Read-once + brand-verify: a Proxy has-trap can lie about the
              // private ERR symbol, so kind 2 additionally requires the
              // same-realm Error every catch handler attaches (normalizeError
              // guarantees it). A spoofed tag falls through to the done/value
              // reads — exactly what native for-await does with that proxy.
              const maybeErr = ERR in result ? result[ERR] : undefined;
              if (maybeErr instanceof Error) {
                kind = 2;
                stepErr = maybeErr;
              } else {
                const step = /** @type {IteratorResult<T, void>} */ (result);
                if (step.done) {
                  kind = 3;
                } else {
                  stepValue = step.value;
                }
              }
            }
          } catch (err) {
            kind = 1;
            stepErr = normalizeError(err, 'Failed to read source iterator next() result');
          }

          if (kind !== 0) {
            // Stop pulling (mainReturnedDone) in every terminal case. Only
            // the malformed/unreadable source (kind 1) is still nominally
            // open — record it for cleanup, which the mainReturnedDone
            // exclusion in markAsEnded would otherwise skip; a rejecting
            // next() (kind 2) closed it per protocol.
            mainReturnedDone = true;
            if (kind === 1) recordPendingClose(asyncIterator);
            return terminalEnvelope(bufferPromise, /* fromSubIterator */ false, stepErr);
          }

          // The dispatch sits inside the try so a synchronously-throwing
          // plain (non-async) callback becomes the same {err} envelope as a
          // rejecting one — otherwise it would reject the raw bufferPromise,
          // bypassing the errors mode entirely.
          try {
            // eslint-disable-next-line promise/no-callback-in-promise
            const callbackResult = callback(/** @type {T} */ (stepValue), { signal: internalAbortController.signal });
            const isSubIterator = isAsyncIterable(callbackResult);
            const value = await callbackResult;

            return valueEnvelope(bufferPromise, /* isSubIterator */ isSubIterator, value);
          } catch (err) {
            return terminalEnvelope(bufferPromise, /* fromSubIterator */ false, normalizeError(err, 'Unknown callback error'));
          }
        });
    }

    promisesToSourceIteratorMap.set(bufferPromise, currentSubIterator || asyncIterator);

    if (mode === 'ordered' && currentSubIterator) {
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

    return true;
  };

  /**
   * The one abort-delivery sequence, shared by nextValue's pre-race and
   * post-race sites. Drives the "reject the next .next() once with
   * abortReason.reason, then done:true forever" contract: claim the pending
   * abort, run (or await the in-flight) cleanup, then throw the reason or
   * resolve done. Also handles the no-abort wake (a park resolved by a
   * plain close): plain cleanup-then-done.
   *
   * The claim (`delivered = true` plus the isDone read) is synchronous —
   * no await before it — so concurrent pulls can't both win, and it runs
   * BEFORE the `await markAsEnded()` so cleanup completes before the
   * reason propagates.
   *
   * An abort that is still undelivered when an explicit closer
   * (return/throw/dispose) has already set isDone is suppressed, not
   * delivered: the consumer chose to close, so a later next() resolves
   * { done: true } — matching native AsyncGenerator — instead of rejecting
   * through a closed iterator with a stale signal.reason. A parked next()
   * being woken BY the abort is unaffected (delivery there runs before
   * markAsEnded flips isDone).
   *
   * @returns {Promise<IteratorResult<R, undefined>>}
   */
  const deliverAbort = async () => {
    const claimed = (abortReason && !abortReason.delivered && !isDone)
      ? abortReason
      : undefined;

    if (abortReason) abortReason.delivered = true;

    await markAsEnded();

    if (claimed) throw claimed.reason;

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
   * ran. markAsEnded(true) would then throw the captured errors even
   * though the abort won the commit race — the delivered rejection's
   * IDENTITY would be wrong (the closed-iterator suppression keeps the
   * count at one either way; pinned by the signal-reason sweep in
   * test/abort.spec.js). Re-entering nextValue routes delivery through
   * its top block instead.
   *
   * @param {boolean | undefined} fromSubIterator
   * @returns {Promise<IteratorResult<R>>}
   */
  const drainOrContinue = (fromSubIterator) => {
    if (fromSubIterator || subIterators.length > 0) {
      fillQueue();
    }

    return (bufferedPromises.length === 0 && !abortReason)
      // `true` = drain: surface any captured fail-eventually errors.
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

    if (errorsMode === 'fail-eventually') {
      // Capture and fall through — the caller keeps draining.
      capturedErrors.push(normalizedErr);
    }
    // fail-fast with abortReason already set: the abort (or an earlier
    // fail-fast error) won and owns the single rejection — this error is
    // deliberately dropped, mirroring Promise.all. Ordinary abort timing
    // can't reach here (both call sites are synchronously downstream of the
    // post-race abort re-check); the only route is synchronous user
    // re-entry, e.g. a callback result whose [Symbol.asyncIterator]() body
    // aborts the external signal and then throws. Pushing it instead would
    // be dead storage: nothing can drain-throw capturedErrors in fail-fast
    // mode, and a future drain path would turn it into a second rejection.
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

    // `true` = drain: surface any captured fail-eventually errors (throws
    // only for the first closer; later calls resolve done).
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
      mode === 'ordered'
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
    } else if (isSubIterator) {
      /** @type {AsyncIterator<R, void, void> | undefined} */
      let subIterator;

      try {
        // GetMethod-aligned single [[Get]] (no `in` probe — a has-trap is
        // never consulted, matching for-await). Re-read here rather than
        // trusting dispatch time: `await callbackResult` can resolve to
        // something other than the iterable that was dispatched (a
        // thenable-hybrid). A callable member fans out; a nullish or
        // non-callable member means the resolved value is plain data. The
        // read and the call are foreign operations — a throw surfaces as a
        // stream error, and a callable member returning a non-object is the
        // same protocol violation it is for for-await.
        const method = isSpecObject(value)
          ? /** @type {{ [Symbol.asyncIterator]?: unknown }} */ (value)[Symbol.asyncIterator]
          : undefined;
        if (typeof method === 'function') {
          const candidate = method.call(value);
          if (!isSpecObject(candidate)) {
            throw new TypeError('Expected the callback result Symbol.asyncIterator method to return an object');
          }
          subIterator = /** @type {AsyncIterator<R, void, void>} */ (candidate);
        }
      } catch (subIterableErr) {
        // The callback returned a malformed async iterable — the member
        // read threw, invoking it threw, or it returned a non-object.
        // Surface it like any other stream error.
        await handleStreamError(normalizeError(subIterableErr, 'Unknown sub-iterator error'));
        return drainOrContinue(fromSubIterator);
      }

      if (!subIterator) {
        // No callable member: the value the await settled to is plain data
        // (a thenable-hybrid resolution, or a data object that merely
        // carries a non-callable Symbol.asyncIterator property).
        fillQueue();

        return /** @type {IteratorYieldResult<R>} */ ({ value });
      }

      subIterators.unshift(subIterator);
      fillQueue();
      return nextValue();
    } else {
      fillQueue();

      return /** @type {IteratorYieldResult<R>} */ ({ value });
    }
  };

  // ─── ordered: 'eager' — concurrent dispatch, in-order delivery ───────────
  // Contract in ADVANCED.md, "Ordered mode". One lane per in-flight source
  // item, in source order; lanes[0] is the delivery head. Non-head lanes step up to
  // `laneLookahead` values ahead in the background (that overlap is the
  // concurrency win) then park; the consumer only ever waits on the head.
  // Fully isolated from the ordered/unordered hot paths — reached only through
  // the `mode === 'eager'` gates at construction and in next().

  /**
   * Classifies a resolved safeStep result into value / malformed / rejected /
   * done — the same ladder the two hot arms run inline, shared here by the
   * (cold, opt-in) eager lane helpers. Kept separate from the two envelope
   * factories, which stay split for their own hidden-class reasons.
   *
   * @template V
   * @param {IteratorResult<V, void> | { [ERR]: Error }} result
   * @param {string} malformedMessage
   * @param {string} readErrorMessage
   * @returns {{ kind: 0 | 1 | 2 | 3, err: Error | undefined, value: V | undefined }} kind 0 value, 1 malformed/unreadable, 2 rejected next(), 3 done
   */
  const classifyStep = (result, malformedMessage, readErrorMessage) => {
    /** @type {0 | 1 | 2 | 3} */
    let kind = 0;
    /** @type {Error | undefined} */
    let err;
    /** @type {V | undefined} */
    let value;

    try {
      if (!isSpecObject(result)) {
        kind = 1;
        err = new TypeError(malformedMessage);
      } else {
        const maybeErr = ERR in result ? result[ERR] : undefined;
        if (maybeErr instanceof Error) {
          kind = 2;
          err = maybeErr;
        } else {
          const step = /** @type {IteratorResult<V, void>} */ (result);
          if (step.done) kind = 3;
          else value = step.value;
        }
      }
    } catch (readErr) {
      kind = 1;
      err = normalizeError(readErr, readErrorMessage);
    }

    return { err, kind, value };
  };

  /**
   * Background drainer: while a lane has an open iterator, no step in flight,
   * and fewer than `laneLookahead` buffered values, take one step. Non-head
   * lanes self-limit to `laneLookahead` and park; the head resumes as the
   * consumer drains it. Sets `lane.pending` (which never rejects) so a parked
   * nextValueEager can race it.
   *
   * @param {Lane<R>} lane
   * @returns {void}
   */
  const pumpLane = (lane) => {
    const { iterator } = lane;
    // The isDone guard also covers the re-pump from this function's own .then:
    // a step resolving after close must not pull an iterator that doCleanup
    // has already .return()ed (with lookahead > 1 the refill would otherwise
    // keep stepping a closed sub-iterator until the buffer filled).
    if (isDone || !iterator || lane.done || lane.terminalErr || lane.pending) return;
    if (lane.buffer.length >= laneLookahead) return;

    lane.pending = safeStep(iterator, catchSubStepErr).then(result => {
      lane.pending = undefined;
      const { err, kind, value } = classifyStep(
        result,
        'Expected sub-iterator next() result to be an object',
        'Failed to read sub-iterator next() result'
      );

      if (kind === 0) {
        lane.buffer.push(/** @type {R} */ (value));
        pumpLane(lane); // refill toward laneLookahead; a no-op once full
        return lane;
      }

      // Terminal: stop stepping this lane. A malformed result (kind 1) leaves
      // the iterator nominally open — owed a cleanup-time .return(); a rejected
      // next() (kind 2) closed it per protocol; done (kind 3) needs no return.
      lane.iterator = undefined;
      if (kind === 1) {
        recordPendingClose(iterator);
        lane.terminalErr = err;
      } else if (kind === 2) {
        lane.terminalErr = err;
      } else {
        lane.done = true;
      }
      return lane;
    });
  };

  /**
   * Producer: admits one placeholder lane and kicks off its source pull +
   * callback dispatch. The source's own FIFO ordering of `.next()` binds the
   * i-th placeholder to the i-th item, so lane order == source order even with
   * several pulls in flight. The pending promise never rejects — a sync throw,
   * a rejection, or a malformed async-iterable all become lane.terminalErr,
   * the same stream-error treatment the non-eager path gives them.
   *
   * @returns {void}
   */
  const admitOneLane = () => {
    /** @type {Lane<R>} */
    const lane = {
      iterator: undefined,
      buffer: [],
      pending: undefined,
      dispatched: false,
      done: false,
      terminalErr: undefined,
      phantom: false,
    };
    lanes.push(lane);

    // `lane.pending` stays set to this whole promise for the lifetime of the
    // source pull AND the callback dispatch — it must NOT be cleared before the
    // `await callbackResult` below. A parked nextValueEager races the head's
    // `pending`; clearing it mid-dispatch would leave the head with no in-flight
    // event to wait on, and the consumer would busy-loop. It is settled to
    // undefined only once the lane reaches its post-dispatch state.
    lane.pending = safeStep(asyncIterator, catchMainStepErr).then(async result => {
      const { err, kind, value } = classifyStep(
        result,
        'Expected source iterator next() result to be an object',
        'Failed to read source iterator next() result'
      );

      if (kind !== 0) {
        mainReturnedDone = true;
        lane.dispatched = true;
        lane.done = true;
        if (kind === 3) {
          lane.phantom = true; // source exhausted — a placeholder with no item
        } else {
          if (kind === 1) recordPendingClose(asyncIterator);
          lane.terminalErr = err;
        }
        lane.pending = undefined;
        return lane;
      }

      // The source pull can settle AFTER an explicit close: doCleanup has
      // already run and emptied `lanes`, so a sub-iterator built from here
      // would never be reached by cleanup and its `finally` would never run.
      // Drop the item instead of dispatching — matching the non-eager modes,
      // which only ever materialise a sub-iterator inside a `nextValue` that
      // is itself guarded by `isDone`.
      if (isDone) {
        lane.dispatched = true;
        lane.done = true;
        lane.pending = undefined;
        return lane;
      }

      try {
        // eslint-disable-next-line promise/no-callback-in-promise
        const callbackResult = callback(/** @type {T} */ (value), { signal: internalAbortController.signal });
        const maybeSub = isAsyncIterable(callbackResult);
        const resolved = await callbackResult;

        /** @type {AsyncIterator<R, void, void> | undefined} */
        let subIterator;
        if (maybeSub) {
          // GetMethod re-read (a thenable-hybrid can resolve to something other
          // than what was dispatched) — mirrors the non-eager sub-iterator arm.
          const method = isSpecObject(resolved)
            ? /** @type {{ [Symbol.asyncIterator]?: unknown }} */ (resolved)[Symbol.asyncIterator]
            : undefined;
          if (typeof method === 'function') {
            const candidate = method.call(resolved);
            if (!isSpecObject(candidate)) {
              throw new TypeError('Expected the callback result Symbol.asyncIterator method to return an object');
            }
            subIterator = /** @type {AsyncIterator<R, void, void>} */ (candidate);
          }
        }

        lane.dispatched = true;
        // Settle the placeholder promise before pumping so pumpLane can install
        // the lane's first step as the new `pending`.
        lane.pending = undefined;
        if (subIterator) {
          // Closed while the callback was in flight: cleanup has already walked
          // the lanes, so close this one here instead of leaking it. Rejections
          // are swallowed for the same reason doCleanup swallows them — a broken
          // cleanup must not mask the consumer-facing outcome.
          if (isDone) {
            lane.done = true;
            // allSettled never rejects, so awaiting it cannot throw here and
            // leaves no floating promise behind.
            await Promise.allSettled([subIterator.return?.()]);
            return lane;
          }
          lane.iterator = subIterator;
          pumpLane(lane); // start stepping toward the first yield, concurrently
        } else {
          // Plain value (or a thenable-hybrid that settled to data).
          lane.buffer.push(/** @type {R} */ (resolved));
          lane.done = true;
        }
      } catch (dispatchErr) {
        lane.dispatched = true;
        lane.done = true;
        lane.terminalErr = normalizeError(dispatchErr, 'Unknown callback error');
        lane.pending = undefined;
      }

      return lane;
    });
  };

  /**
   * Producer loop: admit placeholder lanes up to bufferSize, honouring the same
   * stop conditions as fillQueue (plus mainReturnedDone, to stop pulling a
   * source that has already reported done).
   *
   * @returns {void}
   */
  const admitLanes = () => {
    while (lanes.length < bufferSize) {
      if (capturedErrors.length > 0 || isDone || abortReason || mainReturnedDone) return;
      admitOneLane();
    }
  };

  /**
   * Consumer: delivers lanes[0]'s buffered values in strict source order, only
   * ever waiting on the head lane while the rest drain in the background. Reuses
   * the same currentPark / ABORT_SENTINEL machinery and abort re-checks as
   * nextValue, so the exactly-once rejection and memory contracts are identical.
   *
   * @returns {Promise<IteratorResult<R>>}
   */
  const nextValueEager = async () => {
    // Iterative, not self-recursive: advancing past a lane re-enters from the
    // top via `continue`. A long run of already-settled heads — thousands of
    // phantom lanes from a big bufferSize over an exhausted source, or of done
    // lanes from empty-generator callbacks — is walked with no `await` in
    // between, so recursion here grew the stack by O(bufferSize) frames and
    // crashed exactly like the pre-loop fillQueue did.
    while (true) {
      if (abortReason) return deliverAbort();

      admitLanes();

      const head = lanes[0];

      // No lanes and the source is drained → close, surfacing any captured
      // fail-eventually errors for the first closer.
      if (!head) return markAsEnded(true);
      if (isDone) return markAsEnded();

      if (head.dispatched) {
        // A placeholder whose source pull resolved to done: drop and advance.
        if (head.phantom) {
          lanes.shift();
          continue;
        }

        // Head has a buffered value → deliver it (the in-order guarantee),
        // resume stepping the head, and top up admission.
        if (head.buffer.length > 0) {
          const value = /** @type {R} */ (head.buffer.shift());
          pumpLane(head);
          admitLanes();
          return /** @type {IteratorYieldResult<R>} */ ({ value });
        }

        // Head drained of buffered values and terminally errored → surface in
        // source order (fail-fast throws; fail-eventually captures, continues).
        if (head.terminalErr) {
          const err = head.terminalErr;
          lanes.shift();
          // No admission after this: handleStreamError leaves either a
          // captured error or a pending abort behind, and admitLanes refuses
          // both — the remaining lanes drain, mirroring fillQueue's stop.
          await handleStreamError(err);
          // `true` = drain: surface any captured fail-eventually errors.
          if (lanes.length === 0 && !abortReason) return markAsEnded(true);
          continue;
        }

        // Head fully consumed → drop and advance.
        if (head.done) {
          lanes.shift();
          continue;
        }

        // Generator head with an empty buffer → make sure a step is in flight.
        pumpLane(head);
      }

      // Park on the head's in-flight event: the placeholder's dispatch (head
      // not yet dispatched) or a lane step (the pumpLane above guarantees
      // one), so there is always something to race the park against. A fresh
      // per-pull park keeps retention at ~0 (the memory invariant); abort
      // resolves it via the single construction-time listener.
      /** @type {Promise<typeof ABORT_SENTINEL>} */
      const parkPromise = new Promise(resolve => { currentPark = { resolve }; });
      const { pending } = head;
      // Always defined here (see the note above) — fail loud rather than
      // busy-loop on a resolved-instantly race if that invariant ever breaks.
      /* c8 ignore next */
      if (!pending) throw new Error('bufferedAsyncMap: eager head lane has no in-flight event to await');
      const raced = await Promise.race([pending, parkPromise]);
      currentPark = undefined;

      if (raced === ABORT_SENTINEL || abortReason) return deliverAbort();
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
      const stepFn = mode === 'eager' ? nextValueEager : nextValue;
      currentStep = currentStep
        ? currentStep.then(stepFn, stepFn)
        : stepFn();
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

  // Kick off construction-time prefetch: eager admits its lanes, the other two
  // modes fill the shared buffer. Same "start work immediately" contract.
  if (mode === 'eager') {
    admitLanes();
  } else {
    fillQueue();
  }

  return resultAsyncIterableIterator;
}

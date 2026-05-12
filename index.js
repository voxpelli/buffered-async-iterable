/* eslint-disable promise/prefer-await-to-then */

// TODO: Check docs here https://tc39.es/ecma262/#sec-operations-on-iterator-objects
// TODO: Look into https://tc39.es/ecma262/#sec-iteratorclose / https://tc39.es/ecma262/#sec-asynciteratorclose
// TODO: See "iteratorKind" in https://tc39.es/ecma262/#sec-runtime-semantics-forin-div-ofbodyevaluation-lhs-stmt-iterator-lhskind-labelset – see how it loops and validates the returned values
// TODO: THERE'S ACTUALLY A "throw" method MENTION IN https://tc39.es/ecma262/#sec-generator-function-definitions-runtime-semantics-evaluation: "NOTE: Exceptions from the inner iterator throw method are propagated. Normal completions from an inner throw method are processed similarly to an inner next." THOUGH NOT SURE HOW TO TRIGGER IT IN PRACTICE, SEE yield.spec.js

import { findLeastTargeted } from './lib/find-least-targeted.js';
import { arrayDeleteInPlace, makeIterableAsync, normalizeError } from './lib/misc.js';
import {
  isAsyncIterable, isIterable, isObject, isPartOfArray,
} from './lib/type-checks.js';

/**
 * @template T
 * @param {AsyncIterable<T> | Iterable<T> | T[]} item
 * @returns {AsyncIterable<T>}
 */
async function * yieldIterable (item) {
  yield * item;
}

/**
 * Merge several async (or sync) iterables in parallel. Items are
 * yielded as they become available. Thin wrapper over
 * `bufferedAsyncMap` — see that function for the full semantics of
 * each option.
 *
 * @template T
 * @param {Array<AsyncIterable<T> | Iterable<T> | T[]>} input
 * @param {{ bufferSize?: number|undefined, errors?: 'fail-eventually'|'fail-fast'|undefined, ordered?: boolean|undefined, signal?: AbortSignal|undefined }} [options]
 * @returns {AsyncIterable<T>}
 */
export async function * mergeIterables (input, { bufferSize, errors, ordered, signal } = {}) {
  yield * bufferedAsyncMap(input, yieldIterable, { bufferSize, errors, ordered, signal });
}

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
 * @param {{ bufferSize?: number|undefined, ordered?: boolean|undefined, signal?: AbortSignal|undefined, errors?: 'fail-eventually'|'fail-fast'|undefined }} [options]
 * @returns {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]>, throw: NonNullable<AsyncIterableIterator<R>["throw"]>, [Symbol.asyncDispose]: () => Promise<void> }}
 */
export function bufferedAsyncMap (input, callback, options) {
  /** @typedef {Promise<IteratorResult<R|AsyncIterable<R>> & { bufferPromise: BufferPromise, fromSubIterator?: boolean, isSubIterator?: boolean, err?: unknown }>} BufferPromise */
  const {
    bufferSize = 6,
    errors: errorsMode = 'fail-eventually',
    ordered = false,
    signal: externalSignal,
  } = options || {};

  /** @type {AsyncIterable<T>} */
  const asyncIterable = (isIterable(input) || Array.isArray(input))
    ? makeIterableAsync(input)
    : input;

  if (!input) throw new TypeError('Expected input to be provided');
  if (!isAsyncIterable(asyncIterable)) throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (typeof bufferSize !== 'number') throw new TypeError('Expected bufferSize to be a number');
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new TypeError('Expected signal to be an AbortSignal');
  if (errorsMode !== 'fail-eventually' && errorsMode !== 'fail-fast') throw new TypeError("Expected errors to be 'fail-eventually' or 'fail-fast'");

  /** @type {AsyncIterator<T, unknown>} */
  const asyncIterator = asyncIterable[Symbol.asyncIterator]();

  /** @type {AsyncIterator<R, unknown>[]} */
  const subIterators = [];

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
    if (externalSignal.aborted) {
      abortReason = { reason: externalSignal.reason, delivered: false };
      internalAbortController.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', () => {
        // If the iterator already closed via return()/throw()/dispose, abort is too late: no-op.
        if (isDone) return;
        if (!abortReason) {
          abortReason = { reason: externalSignal.reason, delivered: false };
        }
        if (!internalAbortController.signal.aborted) {
          internalAbortController.abort(externalSignal.reason);
        }
      }, { once: true });
    }
  }

  // Sentinel value distinguishing "abort fired" from any buffered promise's
  // resolution in nextValue()'s Promise.race.
  const ABORT_SENTINEL = Symbol('abort');

  // Single shared promise used as the abort branch of nextValue()'s race.
  // Created once here (not per nextValue call) so listener count stays at 1
  // regardless of how many values the consumer pulls. Resolves at most once;
  // post-resolution it short-circuits Promise.race for every subsequent pull,
  // which is exactly the "abort wins forever" contract.
  // Pre-aborted external signals already ran internalAbortController.abort() above, so the
  // synchronous-aborted check below resolves the promise immediately.
  /** @type {Promise<typeof ABORT_SENTINEL>} */
  const abortPromise = new Promise(resolve => {
    if (internalAbortController.signal.aborted) {
      resolve(ABORT_SENTINEL);
    } else {
      internalAbortController.signal.addEventListener(
        'abort',
        () => resolve(ABORT_SENTINEL),
        { once: true }
      );
    }
  });

  /**
   * Single cleanup path. Idempotent via `isDone`. Called from `return()`,
   * `throw()`, `Symbol.asyncDispose`, source exhaustion, and abort delivery.
   * Always fires `internalAbortController.abort()` — this is what wakes a parked
   * nextValue() and signals in-flight callbacks via the per-task signal.
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

      // TODO: Errors from here, how to handle? allSettled() ensures they will be caught at least
      await Promise.allSettled(
        [
          // Ensure the main iterators are completed
          ...(mainReturnedDone ? [] : [asyncIterator]),
          ...subIterators,
        ]
          .map(item => item.return && item.return())
      );

      bufferedPromises.splice(0);
      subIterators.splice(0);

      if (throwAnyError && capturedErrors.length > 0) {
        throw capturedErrors.length === 1
          ? capturedErrors[0]
          : new AggregateError(capturedErrors, 'Multiple errors in bufferedAsyncMap');
      }
    }

    return { done: true, value: undefined };
  };

  // Producer: pulls from source up to bufferSize, dispatches via callback,
  // pushes the wrapped promise into bufferedPromises. In `ordered: true`
  // mode it always feeds from subIterators[0]; otherwise it picks the
  // least-targeted iterator via findLeastTargeted to prevent starvation.
  const fillQueue = () => {
    if (capturedErrors.length > 0 || isDone || abortReason) return;

    /** @type {AsyncIterator<R, unknown>|undefined} */
    let currentSubIterator;

    if (ordered) {
      currentSubIterator = subIterators[0];
    } else {
      const iterator = findLeastTargeted(
        mainReturnedDone ? subIterators : [...subIterators, asyncIterator],
        bufferedPromises,
        promisesToSourceIteratorMap
      );

      currentSubIterator = isPartOfArray(iterator, subIterators) ? iterator : undefined;
    }

    /** @type {BufferPromise} */
    const bufferPromise = currentSubIterator
      ? Promise.resolve(currentSubIterator.next())
        .catch(err => ({
          err: normalizeError(err, 'Unknown subiterator error'),
        }))
        .then(async result => {
          if (!isObject(result)) {
            throw new TypeError('Expected sub-iterator next() result to be an object');
          }
          if ('err' in result || result.done) {
            arrayDeleteInPlace(subIterators, currentSubIterator);
          }

          /** @type {Awaited<BufferPromise>} */
          const promiseValue = {
            bufferPromise,
            fromSubIterator: true,
            ...(
              'err' in result
                ? { done: true, value: undefined, ...result }
                : result
            ),
          };

          return promiseValue;
        })
      : Promise.resolve(asyncIterator.next())
        .catch(err => ({
          err: normalizeError(err, 'Unknown iterator error'),
        }))
        .then(async result => {
          if (!isObject(result)) {
            throw new TypeError('Expected source iterator next() result to be an object');
          }
          if ('err' in result || result.done) {
            mainReturnedDone = true;
            return {
              bufferPromise,
              ...(
                'err' in result
                  ? { done: true, value: undefined, ...result }
                  : result
              ),
            };
          }

          // eslint-disable-next-line promise/no-callback-in-promise
          const callbackResult = callback(result.value, { signal: internalAbortController.signal });
          const isSubIterator = isAsyncIterable(callbackResult);

          /** @type {Awaited<BufferPromise>} */
          let promiseValue;

          try {
            const value = await callbackResult;

            promiseValue = {
              bufferPromise,
              isSubIterator,
              value,
            };
          } catch (err) {
            promiseValue = {
              bufferPromise,
              done: true,
              err: normalizeError(err, 'Unknown callback error'),
              value: undefined,
            };
          }

          return promiseValue;
        });

    promisesToSourceIteratorMap.set(bufferPromise, currentSubIterator || asyncIterator);

    if (ordered && currentSubIterator) {
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
   * @returns {{ done: true, value: undefined } | undefined}
   *   `undefined` when no abort is pending (caller continues normally);
   *   `{ done: true, value: undefined }` when a previous call already
   *   delivered the abort. Throws `abortReason.reason` when an abort is
   *   pending fresh delivery.
   */
  const handleAbortIfPending = () => {
    if (abortReason && !abortReason.delivered) {
      abortReason.delivered = true;
      throw abortReason.reason;
    }
    if (abortReason && abortReason.delivered) {
      return { done: true, value: undefined };
    }
    // Implicit `undefined` return = "no abort pending, caller continues normally".
    // Lint rejects an explicit `return undefined` / `return` here.
  };

  // Consumer: races buffered promises against the shared abortPromise.
  // Abort always wins over a buffered value that may have settled in the
  // same tick — the post-race code re-checks abortReason regardless of
  // which entry won the race.
  /** @type {AsyncIterator<R>["next"]} */
  const nextValue = async () => {
    {
      const earlyAbort = handleAbortIfPending();
      if (earlyAbort) {
        await markAsEnded();
        return earlyAbort;
      }
    }

    const nextBufferedPromise = bufferedPromises[0];

    if (!nextBufferedPromise) return markAsEnded(true);
    if (isDone) return { done: true, value: undefined };

    // Single flat Promise.race: abortPromise is the last entry so a buffered
    // value resolving in the same tick still gets re-checked against
    // abortReason below.
    const raced = await Promise.race(
      ordered
        ? [nextBufferedPromise, abortPromise]
        : [...bufferedPromises, abortPromise]
    );

    if (raced === ABORT_SENTINEL || abortReason) {
      const handled = handleAbortIfPending();
      await markAsEnded();
      return handled ?? { done: true, value: undefined };
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

    // We are mandated by the spec to always do this return if the iterator is done
    if (isDone) {
      return { done: true, value: undefined };
    } else if (err || done) {
      if (err) {
        const normalizedErr = normalizeError(err, 'Unknown error');

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

        capturedErrors.push(normalizedErr);
      }

      if (fromSubIterator || subIterators.length > 0) {
        fillQueue();
      }

      return bufferedPromises.length === 0
        ? markAsEnded(true)
        : nextValue();
    } else if (isSubIterator && isAsyncIterable(value)) {
      // TODO: Handle possible error here? Or too obscure?
      subIterators.unshift(value[Symbol.asyncIterator]());
      fillQueue();
      return nextValue();
    } else {
      fillQueue();

      return /** @type {IteratorYieldResult<R>} */ ({ value });
    }
  };

  /** @type {Promise<IteratorResult<R>>} */
  let currentStep;

  /** @type {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]>, throw: NonNullable<AsyncIterableIterator<R>["throw"]>, [Symbol.asyncDispose]: () => Promise<void> }} */
  const resultAsyncIterableIterator = {
    async next () {
      // Chain via then(nextValue, nextValue) so a rejection on one .next() does
      // not poison every subsequent call — the next call still reaches
      // nextValue() which observes the post-rejection state machine.
      currentStep = currentStep
        ? currentStep.then(() => nextValue(), () => nextValue())
        : nextValue();
      return currentStep;
    },
    // TODO: Accept an argument, as in the spec. Look into what happens if one call return() multiple times + look into if the value provided to return is the one returned forever after
    // return() deliberately bypasses the currentStep chain: it calls
    // markAsEnded() directly (and thus internalAbortController.abort()) so a parked
    // next() awaiting a buffered promise wakes up via abortPromise. This is
    // what lets `for await … break` work — break desugars to return() running
    // concurrently with the in-flight next().
    'return': () => markAsEnded(),
    // TODO: Add "throw", see reference in https://tc39.es/ecma262/ ? And https://twitter.com/matteocollina/status/1392056117128306691
    /** @type {NonNullable<AsyncIterableIterator<R>["throw"]>} */
    'throw': async (err) => {
      // TODO: Should remember the throw? And return a rejected promise always?
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

/* eslint-disable promise/prefer-await-to-then */

// TODO: Get inspired by Matteos https://github.com/mcollina/hwp/blob/main/index.js, eg AbortController is nice?
// TODO: Check docs here https://tc39.es/ecma262/#sec-operations-on-iterator-objects
// TODO: Look into https://tc39.es/ecma262/#sec-iteratorclose / https://tc39.es/ecma262/#sec-asynciteratorclose
// TODO: See "iteratorKind" in https://tc39.es/ecma262/#sec-runtime-semantics-forin-div-ofbodyevaluation-lhs-stmt-iterator-lhskind-labelset – see how it loops and validates the returned values
// TODO: THERE'S ACTUALLY A "throw" method MENTION IN https://tc39.es/ecma262/#sec-generator-function-definitions-runtime-semantics-evaluation: "NOTE: Exceptions from the inner iterator throw method are propagated. Normal completions from an inner throw method are processed similarly to an inner next." THOUGH NOT SURE HOW TO TRIGGER IT IN PRACTICE, SEE yield.spec.js
// TODO: Make a proper merge for async iterables by accepting multiple input iterables, see: https://twitter.com/matteocollina/status/1392056092482576385

import { findLeastTargeted } from './lib/find-least-targeted.js';
import { arrayDeleteInPlace, makeIterableAsync } from './lib/misc.js';
import { isAsyncIterable, isIterable, isPartOfArray } from './lib/type-checks.js';

/**
 * @template T
 * @template R
 * @param {AsyncIterable<T> | Iterable<T> | T[]} input
 * @param {(item: T) => (Promise<R>|AsyncIterable<R>)} callback
 * @param {{ bufferSize?: number|undefined, ordered?: boolean|undefined }} [options]
 * @returns {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]>, throw: NonNullable<AsyncIterableIterator<R>["throw"]> }}
 */
export function bufferedAsyncMap (input, callback, options) {
  /** @typedef {Promise<IteratorResult<R|AsyncIterable<R>> & { bufferPromise: BufferPromise, fromSubIterator?: boolean, isSubIterator?: boolean, err?: unknown }>} BufferPromise */
  const {
    bufferSize = 6,
    ordered = false,
  } = options || {};

  /** @type {AsyncIterable<T>} */
  const asyncIterable = (isIterable(input) || Array.isArray(input))
    ? makeIterableAsync(input)
    : input;

  if (!input) throw new TypeError('Expected input to be provided');
  if (!isAsyncIterable(asyncIterable)) throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (typeof bufferSize !== 'number') throw new TypeError('Expected bufferSize to be a number');

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

  /** @type {Error|undefined} */
  let hasError;

  /**
   * @param {boolean} [throwAnyError]
   * @returns {Promise<IteratorReturnResult<undefined>>}
   */
  const markAsEnded = async (throwAnyError) => {
    if (!isDone) {
      isDone = true;

      // TODO: Errors from here, how to handle? allSettled() ensures they will be caught at least
      await Promise.allSettled(
        [
          // Ensure the main iterators are completed
          ...(mainReturnedDone ? [] : [asyncIterator]),
          ...subIterators,
        ]
          .map(item => item.return && item.return())
      );

      // TODO: Could we use an AbortController to improve this? See eg. https://github.com/mcollina/hwp/pull/10
      bufferedPromises.splice(0, bufferedPromises.length);
      subIterators.splice(0, subIterators.length);

      if (throwAnyError && hasError) {
        throw hasError;
      }
    }

    return { done: true, value: undefined };
  };

  const fillQueue = () => {
    if (hasError || isDone) return;

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
          err: err instanceof Error ? err : new Error('Unknown subiterator error'),
        }))
        .then(async result => {
          if (typeof result !== 'object') {
            throw new TypeError('Expected an object value');
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
          err: err instanceof Error ? err : new Error('Unknown iterator error'),
        }))
        .then(async result => {
          if (typeof result !== 'object') {
            throw new TypeError('Expected an object value');
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
          const callbackResult = callback(result.value);
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
              err: err instanceof Error ? err : new Error('Unknown callback error'),
              value: undefined,
            };
          }

          return promiseValue;
        });

    promisesToSourceIteratorMap.set(bufferPromise, currentSubIterator || asyncIterator);

    if (ordered && currentSubIterator) {
      let i = 0;

      while (promisesToSourceIteratorMap.get(/** @type {BufferPromise} */ (bufferedPromises[i])) === currentSubIterator) {
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

  /** @type {AsyncIterator<R>["next"]} */
  const nextValue = async () => {
    const nextBufferedPromise = bufferedPromises[0];

    if (!nextBufferedPromise) return markAsEnded(true);
    if (isDone) return { done: true, value: undefined };

    /** @type {Awaited<BufferPromise>} */
    const resolvedPromise = await (ordered ? nextBufferedPromise : Promise.race(bufferedPromises));
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
      if (err && !hasError) {
        hasError = err instanceof Error ? err : new Error('Unknown error');
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

      return /** @type {{ value: R }} */ ({ value });
    }
  };

  /** @type {Promise<IteratorResult<R>>} */
  let currentStep;

  /** @type {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]>, throw: NonNullable<AsyncIterableIterator<R>["throw"]> }} */
  const resultAsyncIterableIterator = {
    async next () {
      currentStep = currentStep ? currentStep.then(() => nextValue()) : nextValue();
      return currentStep;
    },
    // TODO: Accept an argument, as in the spec. Look into what happens if one call return() multiple times + look into if the value provided to return is the one returned forever after
    'return': () => markAsEnded(),
    // TODO: Add "throw", see reference in https://tc39.es/ecma262/ ? And https://twitter.com/matteocollina/status/1392056117128306691
    'throw': async (err) => {
      // TODO: Should remember the throw? And return a rejected promise always?
      await markAsEnded();
      throw err;
    },

    [Symbol.asyncIterator]: () => resultAsyncIterableIterator,
  };

  fillQueue();

  return resultAsyncIterableIterator;
}

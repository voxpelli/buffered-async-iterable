/* eslint-disable promise/prefer-await-to-then */
// TODO: Get inspired by Matteos https://github.com/mcollina/hwp/blob/main/index.js, eg AbortController is nice?
// FIXME: Check this https://twitter.com/matteocollina/status/1392056117128306691
// FIXME: Read up on https://tc39.es/ecma262/#table-async-iterator-optional and add return() and throw(). return() is called by a "for await" when eg. a "break" or a "throw" happens within it
// TODO: Have option to persist order? To not use Promise.race()?
// TODO: Make a proper merge for async iterables by accepting multiple input iterables, see: https://twitter.com/matteocollina/status/1392056092482576385

import { findLeastTargeted } from './lib/find-least-targeted.js';
import { makeIterableAsync } from './lib/misc.js';
import { isAsyncIterable, isIterable, isPartOfSet } from './lib/type-checks.js';

/**
 * @template T
 * @template R
 * @param {AsyncIterable<T> | Iterable<T> | T[]} input
 * @param {(item: T) => (Promise<R>|AsyncIterable<R>)} callback
 * @param {{ bufferSize?: number|undefined }} [options]
 * @returns {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]>, throw: NonNullable<AsyncIterableIterator<R>["throw"]> }}
 */
export function bufferedAsyncMap (input, callback, options) {
  /** @typedef {Promise<IteratorResult<R|AsyncIterable<R>> & { bufferPromise: BufferPromise, fromSubIterator?: boolean, isSubIterator?: boolean, err?: unknown }>} BufferPromise */
  const {
    // FIXME: Increase to eg 16? Like in eg https://github.com/mcollina/hwp/blob/b13d1e48f3ed656cd7b90e48b9db721cdac5c922/index.js#LL6C51-L6C53
    bufferSize = 6,
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

  /** @type {Set<AsyncIterator<R, unknown>>} */
  const subIterators = new Set();

  /** @type {Set<BufferPromise>} */
  const bufferedPromises = new Set();

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
      // TODO: Could we use an AbortController to improve this? See eg. https://github.com/mcollina/hwp/pull/10
      bufferedPromises.clear();

      // FIXME: Need to do the same for subiterators
      if (asyncIterator.return) {
        await asyncIterator.return();
      }
      if (throwAnyError && hasError) {
        throw hasError;
      }
    }
    return { done: true, value: undefined };
  };

  const fillQueue = () => {
    if (hasError || isDone) return;

    // Check which iterator that has the least amount of queued promises right now
    const iterator = findLeastTargeted(
      mainReturnedDone ? subIterators : [...subIterators, asyncIterator],
      bufferedPromises,
      promisesToSourceIteratorMap
    );

    const currentSubIterator = isPartOfSet(iterator, subIterators) ? iterator : undefined;

    // FIXME: Ensure that all subIterators are closed on errors
    // FIXME: Handle rejected promises from upstream! And properly mark this iterator as completed
    /** @type {BufferPromise} */
    const bufferPromise = currentSubIterator
      ? currentSubIterator.next()
        .catch(err => ({
          err: err instanceof Error ? err : new Error('Unknown subiterator error'),
        }))
        .then(async result => {
          if ('err' in result || result.done) {
            subIterators.delete(currentSubIterator);
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
      : asyncIterator.next()
        .catch(err => ({
          err: err instanceof Error ? err : new Error('Unknown iterator error'),
        }))
        .then(async result => {
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
    bufferedPromises.add(bufferPromise);

    if (bufferedPromises.size < bufferSize) {
      fillQueue();
    }
  };

  /** @type {AsyncIterator<R>["next"]} */
  const nextValue = async () => {
    if (bufferedPromises.size === 0) return markAsEnded(true);
    if (isDone) return { done: true, value: undefined };

    // FIXME: Handle rejected promises! We need to remove it from bufferedPromises
    // Wait for some of the current promises to be finished
    const {
      bufferPromise,
      done,
      err,
      fromSubIterator,
      isSubIterator,
      value,
    } = await Promise.race(bufferedPromises);

    bufferedPromises.delete(bufferPromise);

    // We are mandated by the spec to always do this return if the iterator is done
    if (isDone) {
      return { done: true, value: undefined };
    } else if (err || done) {
      if (err && !hasError) {
        hasError = err instanceof Error ? err : new Error('Unknown error');
      }

      if (fromSubIterator || subIterators.size !== 0) {
        fillQueue();
      }

      return bufferedPromises.size === 0
        ? markAsEnded(true)
        : nextValue();
    } else if (isSubIterator && isAsyncIterable(value)) {
      // FIXME: Handle possible error here?
      subIterators.add(value[Symbol.asyncIterator]());
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
      // eslint-disable-next-line promise/prefer-await-to-then
      currentStep = currentStep ? currentStep.then(() => nextValue()) : nextValue();
      return currentStep;
    },
    // TODO: Accept an argument, as in the spec. Look into what happens if one call return() multiple times + look into if the value provided to return is the one returned forever after
    'return': () => markAsEnded(),
    // TODO: Add "throw", see reference in https://tc39.es/ecma262/ ? And https://twitter.com/matteocollina/status/1392056117128306691
    'throw': async (err) => {
      // FIXME: Should remember the throw? And return a rejected promise always?
      await markAsEnded();
      throw err;
    },

    [Symbol.asyncIterator]: () => resultAsyncIterableIterator,
  };

  fillQueue();

  return resultAsyncIterableIterator;
}

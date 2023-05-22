// TODO: Get inspired by Matteos https://github.com/mcollina/hwp/blob/main/index.js, eg AbortController is nice?
// FIXME: Check this https://twitter.com/matteocollina/status/1392056117128306691
// FIXME: Read up on https://tc39.es/ecma262/#table-async-iterator-optional and add return() and throw(). return() is called by a "for await" when eg. a "break" or a "throw" happens within it
// TODO: Have option to persist order? To not use Promise.race()?
// TODO: Make a proper merge for async iterables by accepting multiple input iterables, see: https://twitter.com/matteocollina/status/1392056092482576385

import { findLeastTargeted } from './lib/find-least-targeted.js';
import { makeIterableAsync } from './lib/misc.js';
import { isAsyncIterable, isIterable, isPartOfSet } from './lib/type-checks.js';

// FIXME: Export using a better more unique name
/**
 * @template T
 * @template R
 * @param {AsyncIterable<T> | Iterable<T> | T[]} input
 * @param {(item: T) => (Promise<R>|AsyncIterable<R>)} callback
 * @param {{ queueSize?: number|undefined }} [options]
 * @returns {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]>, throw: NonNullable<AsyncIterableIterator<R>["throw"]> }}
 */
export function map (input, callback, options) {
  /** @typedef {Promise<IteratorResult<R|AsyncIterable<R>> & { queuePromise: QueuePromise, fromSubIterator?: boolean, isSubIterator?: boolean }>} QueuePromise */

  const {
    // FIXME: Increase to eg 16? Like in eg https://github.com/mcollina/hwp/blob/b13d1e48f3ed656cd7b90e48b9db721cdac5c922/index.js#LL6C51-L6C53
    queueSize = 6,
  } = options || {};

  /** @type {AsyncIterable<T>} */
  const asyncIterable = (isIterable(input) || Array.isArray(input))
    ? makeIterableAsync(input)
    : input;

  if (!input) throw new TypeError('Expected input to be provided');
  if (!isAsyncIterable(asyncIterable)) throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (typeof queueSize !== 'number') throw new TypeError('Expected queueSize to be a number');

  /** @type {AsyncIterator<T, unknown>} */
  const asyncIterator = asyncIterable[Symbol.asyncIterator]();

  /** @type {Set<AsyncIterator<R, unknown>>} */
  const subIterators = new Set();

  /** @type {Set<QueuePromise>} */
  const queuedPromises = new Set();

  /** @type {WeakMap<QueuePromise, AsyncIterator<T>|AsyncIterator<R>>} */
  const promisesToSourceIteratorMap = new WeakMap();

  /** @type {boolean} */
  let mainReturnedDone;

  /** @type {boolean} */
  let isDone;

  /** @returns {Promise<IteratorReturnResult<undefined>>} */
  const markAsEnded = async () => {
    if (!isDone) {
      isDone = true;
      // TODO: Could we use an AbortController to improve this? See eg. https://github.com/mcollina/hwp/pull/10
      queuedPromises.clear();

      if (asyncIterator.return) {
        await asyncIterator.return();
      }
    }
    return { done: true, value: undefined };
  };

  const fillQueue = () => {
    if (isDone) return;

    // Check which iterator that has the least amount of queued promises right now
    const iterator = findLeastTargeted(
      mainReturnedDone ? subIterators : [...subIterators, asyncIterator],
      queuedPromises,
      promisesToSourceIteratorMap
    );

    const currentSubIterator = isPartOfSet(iterator, subIterators) ? iterator : undefined;

    // FIXME: Handle rejected promises from upstream! And properly mark this iterator as completed
    /** @type {QueuePromise} */
    const queuePromise = currentSubIterator
      ? currentSubIterator.next()
        // eslint-disable-next-line promise/prefer-await-to-then
        .then(async result => {
          if (result.done) {
            subIterators.delete(currentSubIterator);
          }

          /** @type {Awaited<QueuePromise>} */
          const promiseValue = {
            queuePromise,
            fromSubIterator: true,
            ...result,
          };

          return promiseValue;
        })
      : asyncIterator.next()
        // eslint-disable-next-line promise/prefer-await-to-then
        .then(async result => {
          if (result.done) {
            mainReturnedDone = true;
            return { queuePromise, ...result };
          }

          // eslint-disable-next-line promise/no-callback-in-promise
          const callbackResult = callback(result.value);

          /** @type {Awaited<QueuePromise>} */
          const promiseValue = {
            queuePromise,
            isSubIterator: isAsyncIterable(callbackResult),
            value: await callbackResult,
          };

          return promiseValue;
        });

    promisesToSourceIteratorMap.set(queuePromise, currentSubIterator || asyncIterator);
    queuedPromises.add(queuePromise);

    if (queuedPromises.size < queueSize) {
      fillQueue();
    }
  };

  /** @type {AsyncIterator<R>["next"]} */
  const nextValue = async () => {
    if (queuedPromises.size === 0) return markAsEnded();
    if (isDone) return { done: true, value: undefined };

    // FIXME: Handle rejected promises! We need to remove it from bufferedPromises
    // Wait for some of the current promises to be finished
    const {
      done,
      fromSubIterator,
      isSubIterator,
      queuePromise,
      value,
    } = await Promise.race(queuedPromises);

    queuedPromises.delete(queuePromise);

    // We are mandated by the spec to always do this return if the iterator is done
    if (isDone) {
      return { done: true, value: undefined };
    } else if (done) {
      if (fromSubIterator || subIterators.size !== 0) {
        fillQueue();
      }

      return queuedPromises.size === 0
        ? markAsEnded()
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
      markAsEnded();
      throw err;
    },

    [Symbol.asyncIterator]: () => resultAsyncIterableIterator,
  };

  fillQueue();

  return resultAsyncIterableIterator;
}

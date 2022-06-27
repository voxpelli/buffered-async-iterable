// @ts-check
/// <reference types="node" />

// TODO: Get inspired by Matteos https://github.com/mcollina/hwp/blob/main/index.js, eg AbortController is nice?
// FIXME: Check this https://twitter.com/matteocollina/status/1392056117128306691
// FIXME: Read up on https://tc39.es/ecma262/#table-async-iterator-optional and add return() and throw(). return() is called by a "for await" when eg. a "break" or a "throw" happens within it
// TODO: Have option to persist order? To not use Promise.race()?
// TODO: Make a proper merge for async iterables by accepting multiple input iterables, see: https://twitter.com/matteocollina/status/1392056092482576385
// TODO: Look into adding setImmediate() and such to help with event loop lag

const createCompletionTracker = () => {
  let isDone = false;

  return {
    hasCompleted: () => isDone,
    markAsCompleted: () => { isDone = true; },
  };
};

/**
 * @template T
 * @template R
 * @param {AsyncIterable<T>} asyncIterable
 * @param {(item: T) => Promise<R>} callback
 * @param {number} [size]
 * @returns {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]> }}
 */
const bufferAsyncIterable = (asyncIterable, callback, size = 3) => {
  if (!asyncIterable) throw new TypeError('Expected asyncIterable to be provided');
  if (typeof asyncIterable[Symbol.asyncIterator] !== 'function') throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (typeof size !== 'number') throw new TypeError('Expected size to be a number');

  /** @typedef {Promise<IteratorResult<R> & { bufferPromise: NextLookup }>} NextLookup */

  /** @type {Set<NextLookup>} */
  const bufferedPromises = new Set();

  const completionTracker = createCompletionTracker();

  // TODO: Check if it's already an async iterator?
  const asyncIterator = asyncIterable[Symbol.asyncIterator]();

  /** @returns {Promise<IteratorReturnResult<undefined>>} */
  const markAsEnded = async () => {
    if (completionTracker.hasCompleted() === false) {
      completionTracker.markAsCompleted();
      bufferedPromises.clear();

      if (asyncIterator.return) {
        await asyncIterator.return();
      }
    }
    return { done: true, value: undefined };
  };

  const queueNext = () => {
    // console.log('😳 queueNext', Date.now());
    // FIXME: Handle rejected promises from upstream! And properly mark this iterator as completed
    /** @type {NextLookup} */
    const next = asyncIterator.next()
      // eslint-disable-next-line promise/prefer-await-to-then
      .then(async result => ({
        bufferPromise: next,
        ...(
          result.done
            ? result
            // FIXME: Handle rejected promises from callback! And properly mark this iterator as completed + the upstream one
            // eslint-disable-next-line promise/no-callback-in-promise
            : { value: await callback(result.value) }
        )
      }));

    bufferedPromises.add(next);
  };

  for (let i = 0; i < size; i++) {
    queueNext();
  }

  /** @type {AsyncIterator<R>["next"]} */
  const nextValue = async () => {
    // console.log('🤔 nextValue', Date.now());
    if (bufferedPromises.size === 0) {
      return markAsEnded();
    }

    if (completionTracker.hasCompleted()) {
      return { done: true, value: undefined };
    }

    // FIXME: Handle rejected promises! We need to remove it from bufferedPromises
    const { bufferPromise, ...result } = await Promise.race(bufferedPromises);

    bufferedPromises.delete(bufferPromise);

    // We are mandated by the spec to always return this if the iterator is done
    if (completionTracker.hasCompleted()) {
      return { done: true, value: undefined };
    }

    if (result.done) {
      if (bufferedPromises.size !== 0) return nextValue();
      return markAsEnded();
    }

    if (bufferedPromises.size !== 0) {
      queueNext();
    }

    return { value: result.value };
  };

  /** @type {Promise<IteratorResult<R>>} */
  let currentStep;

  /** @type {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]> }} */
  const resultAsyncIterableIterator = {
    async next () {
      // eslint-disable-next-line promise/prefer-await-to-then
      currentStep = currentStep ? currentStep.then(() => nextValue()) : nextValue();
      return currentStep;
    },
    // TODO: Accept an argument, as in the spec
    'return': () => markAsEnded(),

    [Symbol.asyncIterator]: () => resultAsyncIterableIterator,
  };

  return resultAsyncIterableIterator;
};

module.exports = {
  bufferAsyncIterable
};

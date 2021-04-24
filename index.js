// @ts-check
/// <reference types="node" />

// FIXME: Ensure there are no memory leaks


/**
 * @template T
 * @template R
 * @param {AsyncIterable<T>} asyncIterable
 * @param {(item: T) => Promise<R>} callback
 * @param {number} [size]
 * @returns {AsyncIterable<R>}
 */
const bufferAsyncIterable = (asyncIterable, callback, size = 3) => {
  if (!asyncIterable) throw new TypeError('Expected asyncIterable to be provided');
  if (typeof asyncIterable[Symbol.asyncIterator] !== 'function') throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (typeof size !== 'number') throw new TypeError('Expected size to be a number');

  /** @typedef {Promise<IteratorResult<R> & { bufferPromise: NextLookup }>} NextLookup */

  /** @type {Set<NextLookup>} */
  const bufferedPromises = new Set();

  const asyncIterator = asyncIterable[Symbol.asyncIterator]();

  const queueNext = () => {
    console.log('😳 queueNext', Date.now());
    /** @type {NextLookup} */
    const next = asyncIterator.next()
      // eslint-disable-next-line promise/prefer-await-to-then
      .then(async result => ({
        // FIXME: Ensure this doesn't leak memory like crazy. Preferably use WeakRef here when possible
        bufferPromise: next,
        ...(
          result.done
            ? result
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
    console.log('🤔 nextValue', Date.now());
    if (bufferedPromises.size === 0) {
      return { done: true, value: undefined };
    }

    const { bufferPromise, ...result } = await Promise.race(bufferedPromises);
    console.log('🏎 race has been won!', result, 'at time', Date.now());

    bufferedPromises.delete(bufferPromise);

    if (result.done) {
      if (bufferedPromises.size !== 0) return nextValue();
      return { done: true, value: undefined };
    } else if (bufferedPromises.size !== 0) {
      queueNext();
    }

    return { value: result.value };
  };

  /** @type {Promise<IteratorResult<R>>} */
  let currentStep;

  /** @type {AsyncIterator<R>} */
  const resultAsyncIterator = {
    async next () {
      // eslint-disable-next-line promise/prefer-await-to-then
      currentStep = currentStep ? currentStep.then(() => nextValue()) : nextValue();
      return currentStep;
    }
  };

  return {
    [Symbol.asyncIterator]: () => resultAsyncIterator
  };
};

module.exports = {
  bufferAsyncIterable
};

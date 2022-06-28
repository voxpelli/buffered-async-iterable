/* eslint-disable func-style */

// TODO: Get inspired by Matteos https://github.com/mcollina/hwp/blob/main/index.js, eg AbortController is nice?
// FIXME: Check this https://twitter.com/matteocollina/status/1392056117128306691
// FIXME: Read up on https://tc39.es/ecma262/#table-async-iterator-optional and add return() and throw(). return() is called by a "for await" when eg. a "break" or a "throw" happens within it
// TODO: Have option to persist order? To not use Promise.race()?
// TODO: Make a proper merge for async iterables by accepting multiple input iterables, see: https://twitter.com/matteocollina/status/1392056092482576385
// TODO: Look into adding setImmediate() and such to help with event loop lag

/**
 * @param {any} value
 * @returns {value is Iterable<*>}
 */
const isIterable = (value) => Boolean(value && value[Symbol.iterator]);

/**
 * @param {any} value
 * @returns {value is AsyncIterable<*>}
 */
const isAsyncIterable = (value) => Boolean(value && value[Symbol.asyncIterator]);

/**
 * @template T
 * @param {Iterable<T> | T[]} input
 * @returns {AsyncIterable<T>}
 */
async function * makeIterableAsync (input) {
  for (const value of input) {
    yield value;
  }
}

/**
 * @template T
 * @template R
 * @param {AsyncIterable<T> | Iterable<T> | T[]} input
 * @param {(item: T) => (Promise<R>|AsyncIterable<R>)} callback
 * @param {{ queueSize?: number|undefined }} [options]
 * @returns {AsyncIterableIterator<R> & { return: NonNullable<AsyncIterableIterator<R>["return"]> }}
 */
export function map (input, callback, options) {
  /** @typedef {Promise<IteratorResult<R|AsyncIterable<R>> & { queuePromise: QueuePromise, fromSubIterator?: true }>} QueuePromise */

  const {
    queueSize = 3,
  } = options || {};

  const asyncIterable = (isIterable(input) || Array.isArray(input))
    ? makeIterableAsync(input)
    : input;

  if (!input) throw new TypeError('Expected input to be provided');
  if (typeof asyncIterable[Symbol.asyncIterator] !== 'function') throw new TypeError('Expected asyncIterable to have a Symbol.asyncIterator function');
  if (typeof callback !== 'function') throw new TypeError('Expected callback to be a function');
  if (typeof queueSize !== 'number') throw new TypeError('Expected queueSize to be a number');

  // TODO: Check if it's already an async iterator?
  const asyncIterator = asyncIterable[Symbol.asyncIterator]();

  /** @type {Set<AsyncIterator<R>>} */
  const subIterators = new Set();

  /** @type {Set<QueuePromise>} */
  const queuedPromises = new Set();

  /** @type {boolean} */
  let done;

  /** @returns {Promise<IteratorReturnResult<undefined>>} */
  const markAsEnded = async () => {
    if (!done) {
      done = true;
      queuedPromises.clear();

      if (asyncIterator.return) {
        await asyncIterator.return();
      }
    }
    return { done: true, value: undefined };
  };

  const fillQueue = () => {
    if (done) return;

    const subIterator = subIterators.size && [...subIterators][0];

    // FIXME: Handle rejected promises from upstream! And properly mark this iterator as completed
    /** @type {QueuePromise} */
    const queuePromise = subIterator
      ? subIterator.next()
        // eslint-disable-next-line promise/prefer-await-to-then
        .then(async result => {
          if (result.done) {
            subIterators.delete(subIterator);
          }
          return { queuePromise, fromSubIterator: true, ...result };
        })
      : asyncIterator.next()
        // eslint-disable-next-line promise/prefer-await-to-then
        .then(async result => ({
          queuePromise,
          ...(
            result.done
              ? result
              // FIXME: Handle rejected promises from callback! And properly mark this iterator as completed + the upstream one
              // eslint-disable-next-line promise/no-callback-in-promise
              : { value: await callback(result.value) }
          )
        }));

    queuedPromises.add(queuePromise);

    if (queuedPromises.size < queueSize) {
      fillQueue();
    }
  };

  /** @type {AsyncIterator<R>["next"]} */
  const nextValue = async () => {
    if (queuedPromises.size === 0) return markAsEnded();
    if (done) return { done: true, value: undefined };

    // FIXME: Handle rejected promises! We need to remove it from bufferedPromises
    // Wait for some of the current promises to be finished
    const { fromSubIterator, queuePromise, ...result } = await Promise.race(queuedPromises);

    queuedPromises.delete(queuePromise);

    // We are mandated by the spec to always do this return if the iterator is done
    if (done) {
      return { done: true, value: undefined };
    } else if (result.done) {
      if (fromSubIterator || subIterators.size !== 0) {
        fillQueue();
      }

      return queuedPromises.size === 0
        ? markAsEnded()
        : nextValue();
    }

    if (isAsyncIterable(result.value)) {
      // FIXME: Handle possible error here?
      subIterators.add(result.value[Symbol.asyncIterator]());
    }

    fillQueue();

    return isAsyncIterable(result.value)
      ? nextValue()
      : { value: result.value };
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

  fillQueue();

  return resultAsyncIterableIterator;
}

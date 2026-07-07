import sinon from 'sinon';

/**
 * A sinon-stubbed async iterator + its wrapping iterable, for driving
 * protocol edge cases (malformed results, throwing return(), …).
 *
 * @returns {{ asyncIterable: AsyncIterable<*>, asyncIterator: AsyncIterator<*> & { next: import('sinon').SinonStub, return: import('sinon').SinonStub, throw: import('sinon').SinonStub } }}
 */
export function stubAsyncIterator () {
  const next = sinon.stub();
  const returnStub = sinon.stub();
  const throwStub = sinon.stub();

  /** @satisfies {AsyncIterator<*>} */
  const asyncIterator = {
    next,
    'return': returnStub,
    'throw': throwStub,
  };

  /** @type {AsyncIterable<*>} */
  const asyncIterable = {
    [Symbol.asyncIterator]: () => asyncIterator,
  };

  return {
    asyncIterable,
    asyncIterator,
  };
}

/**
 * @template T
 * @param {T[]} items
 * @returns {AsyncIterable<T>}
 */
export async function * fromArray (items) {
  for (const item of items) {
    yield item;
  }
}

/**
 * The fail-eventually drain-throw convention: a single captured error is
 * thrown identity-preserved, two or more arrive wrapped in an
 * AggregateError — unwrap to the first for identity assertions. Typed as
 * Error for assertion convenience; the library normalizes every captured
 * value into an Error before it ever reaches a consumer.
 *
 * @param {unknown} err
 * @returns {Error}
 */
export function unwrapCapturedError (err) {
  return /** @type {Error} */ (err instanceof AggregateError ? err.errors[0] : err);
}

/**
 * @param {unknown} item
 * @returns {boolean}
 */
export function isAsyncGenerator (item) {
  return item && typeof item === 'object'
    ? Symbol.toStringTag in item && item[Symbol.toStringTag] === 'AsyncGenerator'
    : false;
}

/**
 * @param {number} delay
 * @returns {Promise<void>}
 */
export function promisableTimeout (delay) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * @param {number} count
 * @param {number|((i: number) => number)} wait
 * @returns {AsyncIterable<number>}
 */
export async function * yieldValuesOverTime (count, wait) {
  const waitCallback = typeof wait === 'number' ? () => wait : wait;
  for (let i = 0; i < count; i++) {
    yield i;
    await promisableTimeout(waitCallback(i));
  }
}

/**
 * @param {number} count
 * @param {number|((i: number) => number)} wait
 * @param {string} prefix
 * @returns {AsyncIterable<string>}
 */
export async function * yieldValuesOverTimeWithPrefix (count, wait, prefix) {
  const waitCallback = typeof wait === 'number' ? () => wait : wait;
  for (let i = 0; i < count; i++) {
    yield prefix + i;
    await promisableTimeout(waitCallback(i));
  }
}

/**
 * @param {number} count
 * @param {number|((i: number) => number)} wait
 * @param {(i: number) => AsyncGenerator<string>} nested
 * @returns {AsyncIterable<string>}
 */
export async function * nestedYieldValuesOverTime (count, wait, nested) {
  const waitCallback = typeof wait === 'number' ? () => wait : wait;
  for (let i = 0; i < count; i++) {
    yield * nested(i);
    await promisableTimeout(waitCallback(i));
  }
}

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

// The "array → async iterable" test fixture is exactly the library's own
// sync-to-async shim — re-export it rather than maintain a twin.
export { makeIterableAsync as fromArray } from '../lib/misc.js';

/**
 * The shared throwing-source shape for the two error-mode suites — kept single
 * so fail-fast and fail-eventually keep exercising the same stream.
 *
 * @param {Error} expected
 * @returns {AsyncIterable<number>}
 */
export async function * sourceThatThrows (expected) {
  yield 0;
  yield 1;
  throw expected;
}

/**
 * A *function* object carrying a callable Symbol.asyncIterator — spec-legal as
 * an async iterable, since ECMA "Type(x) is Object" includes callables. Pins
 * the isSpecObject-based fan-out contract from both the hostile-input and the
 * eager-delivery direction.
 *
 * @type {*}
 */
export const callableAsyncIterable = () => 'never invoked as a function';
callableAsyncIterable[Symbol.asyncIterator] = async function * () {
  yield 'a';
  yield 'b';
};

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
 * Drives `iterator.next()` n times, collecting each outcome as a
 * `{ rejected, value }` record — the shared harness for exactly-once
 * delivery assertions. Framework-agnostic on purpose (plain async, no
 * runner coupling).
 *
 * @param {AsyncIterator<*>} iterator
 * @param {number} n
 * @returns {Promise<Array<{ rejected: boolean, value: unknown }>>}
 */
export async function collectNextOutcomes (iterator, n) {
  /** @type {Array<{ rejected: boolean, value: unknown }>} */
  const outcomes = [];
  for (let i = 0; i < n; i++) {
    try {
      outcomes.push({ rejected: false, value: await iterator.next() });
    } catch (err) {
      outcomes.push({ rejected: true, value: err });
    }
  }
  return outcomes;
}

/**
 * The executable form of the "reject exactly once with the given error,
 * then done forever" contract: asserts exactly one rejection, its identity,
 * and that every later outcome is `{ done: true, value: undefined }`.
 *
 * @param {Array<{ rejected: boolean, value: unknown }>} outcomes
 * @param {unknown} expectedErr
 * @returns {void}
 */
export function expectSingleRejectionThenDone (outcomes, expectedErr) {
  const rejections = outcomes.filter(o => o.rejected);
  if (rejections.length !== 1) {
    throw new Error(`Expected exactly one rejection, saw ${rejections.length}`);
  }
  if (rejections[0]?.value !== expectedErr) {
    throw new Error(`Rejection identity mismatch: got ${String(rejections[0]?.value)}`);
  }
  const firstReject = outcomes.findIndex(o => o.rejected);
  for (const o of outcomes.slice(firstReject + 1)) {
    const r = /** @type {{ done?: boolean, value?: unknown }} */ (o.value);
    // The key-count check matches the strictness of a deep-equal against
    // { done: true, value: undefined } — a leaked internal envelope with
    // extra enumerable keys must fail even when done/value look right.
    if (o.rejected || r?.done !== true || r?.value !== undefined || Object.keys(r).length !== 2) {
      throw new Error(`Expected exactly { done: true, value: undefined } after the rejection, saw ${JSON.stringify(o)}`);
    }
  }
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

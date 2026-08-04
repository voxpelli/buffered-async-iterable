/**
 * ECMA-262 "Type(value) is Object" — callables count, because every protocol
 * position this guards accepts function objects (IteratorResult objects,
 * GetIteratorFromMethod results). The truthiness check closes the
 * `typeof null === 'object'` hole.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
export const isSpecObject = (value) => Boolean(value && (typeof value === 'object' || typeof value === 'function'));

/**
 * Gates the callback-result fan-out — a GetIteratorFromMethod position, hence
 * `isSpecObject` rather than an object-only check (`for await` iterates a
 * function carrying a callable `Symbol.asyncIterator`) and a single [[Get]]
 * rather than an `in` probe: GetMethod never consults a has-trap, so a Proxy
 * whose has/get traps disagree must classify by what [[Get]] returns, exactly
 * as `for await` would. A throwing getter propagates — at the dispatch call
 * site that throw is caught and surfaces as a stream error, matching the
 * error `for await` raises from GetMethod.
 *
 * @template T
 * @param {T} value
 * @returns {value is T & AsyncIterable<unknown>}
 */
export const isAsyncIterable = (value) => isSpecObject(value) &&
  typeof (/** @type {{ [Symbol.asyncIterator]?: unknown }} */ (value)[Symbol.asyncIterator]) === 'function';

/**
 * @template Values
 * @param {unknown} value
 * @param {Values[]} list
 * @returns {value is Values}
 */
export const isPartOfArray = (value, list) => list.includes(/** @type {Values} */ (value));

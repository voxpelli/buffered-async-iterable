/**
 * Truthy non-function object (closes the `typeof null === 'object'` hole).
 * Internal building block — external consumers use the exported guards; for
 * spec-protocol positions that accept callables, use `isSpecObject`.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
const isObject = (value) => Boolean(value && typeof value === 'object');

/**
 * ECMA-262 "Type(value) is Object" — unlike `isObject`, callables count.
 * For protocol positions where the spec accepts function objects
 * (IteratorResult objects, GetIteratorFromMethod results).
 *
 * @param {unknown} value
 * @returns {value is object}
 */
export const isSpecObject = (value) => Boolean(value && (typeof value === 'object' || typeof value === 'function'));

/**
 * @template T
 * @param {T} value
 * @returns {value is T & AsyncIterable<unknown>}
 */
export const isAsyncIterable = (value) => isObject(value) && Symbol.asyncIterator in value;

/**
 * @template Values
 * @param {unknown} value
 * @param {Values[]} list
 * @returns {value is Values}
 */
export const isPartOfArray = (value, list) => list.includes(/** @type {Values} */ (value));

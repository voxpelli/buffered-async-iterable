/**
 * @param {unknown} value
 * @returns {value is object}
 */
export const isObject = (value) => Boolean(value && typeof value === 'object');

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

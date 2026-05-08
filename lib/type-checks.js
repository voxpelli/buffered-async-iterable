/**
 * @param {unknown} value
 * @returns {value is object}
 */
export const isObject = (value) => Boolean(value && typeof value === 'object');

/**
 * @param {unknown} value
 * @returns {value is Iterable<unknown>}
 */
export const isIterable = (value) => isObject(value) && Symbol.iterator in value;

/**
 * @param {unknown} value
 * @returns {value is AsyncIterable<unknown>}
 */
export const isAsyncIterable = (value) => isObject(value) && Symbol.asyncIterator in value;

/**
 * @template Values
 * @param {unknown} value
 * @param {Values[]} list
 * @returns {value is Values}
 */
export const isPartOfArray = (value, list) => list.includes(/** @type {Values} */ (value));

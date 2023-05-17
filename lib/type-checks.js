/**
 * @param {unknown} value
 * @returns {value is Iterable<unknown>}
 */
export const isIterable = (value) => Boolean(value && typeof value === 'object' && Symbol.iterator in value);

/**
 * @param {unknown} value
 * @returns {value is AsyncIterable<unknown>}
 */
export const isAsyncIterable = (value) => Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);

/**
 * @template SetValue
 * @param {unknown} value
 * @param {Set<SetValue>} set
 * @returns {value is SetValue}
 */
export const isPartOfSet = (value, set) => set.has(/** @type {SetValue} */ (value));

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
 * @template T
 * @param {unknown} value
 * @param {Set<T>} set
 * @returns {value is T}
 */
export const isPartOfSet = (value, set) => set.has(/** @type {T} */ (value));

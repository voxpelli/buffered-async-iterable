/**
 * @param {any} value
 * @returns {value is Iterable<*>}
 */
export const isIterable = (value) => Boolean(value && value[Symbol.iterator]);

/**
 * @param {any} value
 * @returns {value is AsyncIterable<*>}
 */
export const isAsyncIterable = (value) => Boolean(value && value[Symbol.asyncIterator]);

/**
 * @template T
 * @param {any} value
 * @param {Set<T>} set
 * @returns {value is T}
 */
export const isPartOfSet = (value, set) => set.has(value);

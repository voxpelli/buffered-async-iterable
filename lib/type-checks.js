/**
 * @param {any} value
 * @returns {value is Iterable<*>}
 */
// type-coverage:ignore-next-line
export const isIterable = (value) => Boolean(value && value[Symbol.iterator]);

/**
 * @param {any} value
 * @returns {value is AsyncIterable<*>}
 */
// type-coverage:ignore-next-line
export const isAsyncIterable = (value) => Boolean(value && value[Symbol.asyncIterator]);

/**
 * @template T
 * @param {any} value
 * @param {Set<T>} set
 * @returns {value is T}
 */
// type-coverage:ignore-next-line
export const isPartOfSet = (value, set) => set.has(value);

/**
 * @template T
 * @param {Iterable<T> | T[]} input
 * @returns {AsyncIterable<T>}
 */
export async function * makeIterableAsync (input) {
  for (const value of input) {
    yield value;
  }
}

/**
 * Similar to the .delete() on a set
 *
 * @template T
 * @param {T[]} list
 * @param {T} value
 */
export function arrayDeleteInPlace (list, value) {
  const index = list.indexOf(value);
  if (index !== -1) {
    list.splice(index, 1);
  }
}

/**
 * Normalizes an error to ensure it's an Error instance
 *
 * @param {unknown} err
 * @param {string} defaultMessage
 * @returns {Error}
 */
export function normalizeError (err, defaultMessage) {
  return err instanceof Error ? err : new Error(defaultMessage);
}

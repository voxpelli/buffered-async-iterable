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
 * Coerces a `throw`n value into an `Error`. Non-`Error` values
 * (`throw 42`, `throw 'oops'`, etc.) become a fresh `Error(defaultMessage)`
 * with the original value preserved on `.cause` for debuggability.
 *
 * @param {unknown} err
 * @param {string} defaultMessage
 * @returns {Error}
 */
export function normalizeError (err, defaultMessage) {
  return err instanceof Error ? err : new Error(defaultMessage, { cause: err });
}

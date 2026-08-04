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
 * A nullish thrown value (`throw undefined`, a bare `Promise.reject()`) carries
 * no information worth preserving, so `.cause` is left unset rather than
 * attached as `cause: undefined` — the latter shows up as `[cause]: undefined`
 * noise in `util.inspect` / structured loggers.
 *
 * @param {unknown} err
 * @param {string} defaultMessage
 * @returns {Error}
 */
export function normalizeError (err, defaultMessage) {
  if (err instanceof Error) return err;
  // eslint-disable-next-line unicorn/no-null -- `== null` is the nullish guard: skip `cause` for both `throw undefined` and `throw null`
  return err == null
    ? new Error(defaultMessage)
    : new Error(defaultMessage, { cause: err });
}

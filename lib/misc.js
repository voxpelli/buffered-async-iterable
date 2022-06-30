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

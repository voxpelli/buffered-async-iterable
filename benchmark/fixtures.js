// Shared fixtures for the mitata benchmark suite.
//
// IMPORTANT: benchmarks here measure *library overhead* — the bookkeeping cost
// of bufferedAsyncMap / mergeIterables per item — not simulated I/O latency.
// Fixtures therefore never use timers; every value resolves on the microtask
// queue. A `setTimeout`-based source would make every benchmark measure the
// event loop instead of the library.

/**
 * Async iterable yielding integers `0 .. count - 1` with no artificial delay.
 *
 * @param {number} count
 * @returns {AsyncGenerator<number>}
 */
export async function * asyncRange (count) {
  for (let i = 0; i < count; i++) {
    yield i;
  }
}

/**
 * Minimal-work async callback — isolates the library's per-item dispatch
 * overhead from the callback's own cost.
 *
 * @param {number} item
 * @returns {Promise<number>}
 */
export const identity = async (item) => item;

/**
 * Async-generator callback: each input item fans out into 4 values. Exercises
 * the sub-iterator path (subIterators stack + findLeastTargeted load
 * balancing).
 *
 * @param {number} item
 * @returns {AsyncGenerator<number>}
 */
export async function * fanOut (item) {
  for (let i = 0; i < 4; i++) {
    yield item * 4 + i;
  }
}

/**
 * Drains an async iterable and returns the last value seen, so callers can
 * feed it to `do_not_optimize` and keep the JIT from eliminating the loop.
 *
 * @param {AsyncIterable<unknown>} iterable
 * @returns {Promise<unknown>}
 */
export async function drain (iterable) {
  let last;
  for await (const value of iterable) {
    last = value;
  }
  return last;
}

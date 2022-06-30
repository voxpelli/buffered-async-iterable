// FIXME: Add tests for the event loop escaping

/**
 * Helps giving back control to the event loop every now and then in a promise heavy flow with little real async work
 *
 * @see https://www.nearform.com/blog/optimise-node-js-performance-avoiding-broken-promises/
 */
export class EventLoopBreather {
  /** @type {number} */
  #breathChecks = 0;

  /** @type {number|undefined} */
  #breathEvery;

  /**
   * @param {number|undefined} breathEvery
   */
  constructor (breathEvery) {
    if (breathEvery !== undefined) {
      if (typeof breathEvery !== 'number') throw new TypeError('Expected breathEvery to be a number or undefined');
      if (breathEvery < 1) throw new Error('Expected breathEvery to be above 0');
    }

    this.#breathEvery = breathEvery;
  }

  /**
   * Checks whether its time to let the event loop breathe for a bit a bit or not
   *
   * @template T
   * @param {Promise<T>} value
   * @returns {Promise<T>}
   */
  breathe (value) {
    if (!this.#breathEvery) return value;

    this.#breathChecks += 1;

    if (this.#breathChecks < this.#breathEvery) return value;

    this.#breathChecks = 0;

    return new Promise(resolve => setImmediate(() => resolve(value)));
  }
}

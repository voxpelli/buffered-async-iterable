/**
 * @param {unknown} item
 * @returns {boolean}
 */
export function isAsyncGenerator (item) {
  return item && typeof item === 'object'
    ? Symbol.toStringTag in item && item[Symbol.toStringTag] === 'AsyncGenerator'
    : false;
}

/**
 * @param {number} delay
 * @returns {Promise<void>}
 */
export function promisableTimeout (delay) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * @param {number} count
 * @param {number|((i: number) => number)} wait
 * @returns {AsyncIterable<number>}
 */
export async function * yieldValuesOverTime (count, wait) {
  const waitCallback = typeof wait === 'number' ? () => wait : wait;
  for (let i = 0; i < count; i++) {
    yield i;
    await promisableTimeout(waitCallback(i));
  }
}

/**
 * @param {number} count
 * @param {number|((i: number) => number)} wait
 * @param {string} prefix
 * @returns {AsyncIterable<string>}
 */
export async function * yieldValuesOverTimeWithPrefix (count, wait, prefix) {
  const waitCallback = typeof wait === 'number' ? () => wait : wait;
  for (let i = 0; i < count; i++) {
    yield prefix + i;
    await promisableTimeout(waitCallback(i));
  }
}

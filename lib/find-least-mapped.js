/**
 * @template T
 * @template {object} R
 * @param {Iterable<T> | T[]} target
 * @param {Set<R>} source
 * @param {WeakMap<R,T>} mapping
 * @returns {T|undefined}
 */
export function findLeastMapped (target, source, mapping) {
  /** @type {Map<T,number>} */
  const countTracker = new Map();

  for (const item of source) {
    const mappedItem = mapping.get(item);

    if (mappedItem) {
      const trackedCount = countTracker.get(mappedItem);
      countTracker.set(mappedItem, (trackedCount || 0) + 1);
    }
  }

  /** @type {number|undefined} */
  let leastCount;
  /** @type {T|undefined} */
  let matchingItem;

  for (const item of target) {
    const trackedCount = countTracker.get(item);

    if (trackedCount === undefined) {
      return item;
    }

    if (leastCount === undefined || trackedCount < leastCount) {
      leastCount = trackedCount;
      matchingItem = item;
    }
  }

  return matchingItem;
}

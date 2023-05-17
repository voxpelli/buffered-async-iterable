/**
 * @template Target
 * @template {object} Item
 * @param {Set<Item>} items
 * @param {WeakMap<Item, Target>} itemTargets
 * @returns {Map<Target, number>}
 */
function countTargets (items, itemTargets) {
  /** @type {Map<T,number>} */
  const countTracker = new Map();

  for (const item of items) {
    const target = itemTargets.get(item);

    if (target) {
      const trackedCount = countTracker.get(target);
      countTracker.set(target, (trackedCount || 0) + 1);
    }
  }

  return countTracker;
}

/**
 * @template Target
 * @template {object} Item
 * @param {Iterable<Target> | Target[]} targets
 * @param {Set<Item>} items
 * @param {WeakMap<Item, Target>} itemTargets
 * @returns {Target|undefined}
 */
export function findLeastTargeted (targets, items, itemTargets) {
  const targetCounts = countTargets(items, itemTargets);

  /** @type {number|undefined} */
  let smallestMapCount;
  /** @type {Target|undefined} */
  let leastMatched;

  for (const item of targets) {
    const targetCount = targetCounts.get(item);

    // It isn't a map target at all, so definitely one of the least used ones!
    if (targetCount === undefined) {
      return item;
    }

    // If its the first target we check or if its less targeted than the previous
    if (smallestMapCount === undefined || targetCount < smallestMapCount) {
      smallestMapCount = targetCount;
      leastMatched = item;
    }
  }

  return leastMatched;
}

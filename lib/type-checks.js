/**
 * ECMA-262 "Type(value) is Object" — callables count, because every protocol
 * position this guards accepts function objects (IteratorResult objects,
 * GetIteratorFromMethod results). The truthiness check closes the
 * `typeof null === 'object'` hole.
 *
 * @param {unknown} value
 * @returns {value is object}
 */
export const isSpecObject = (value) => Boolean(value && (typeof value === 'object' || typeof value === 'function'));

/**
 * Gates the callback-result fan-out — a GetIteratorFromMethod position, hence
 * `isSpecObject` rather than an object-only check: `for await` iterates a
 * function carrying a callable `Symbol.asyncIterator`, and the consume-time
 * GetMethod read already accepts one. Narrowing it here would silently deliver
 * such a result as a plain value instead of fanning it out.
 *
 * @template T
 * @param {T} value
 * @returns {value is T & AsyncIterable<unknown>}
 */
export const isAsyncIterable = (value) => isSpecObject(value) && Symbol.asyncIterator in value;

/**
 * @template Values
 * @param {unknown} value
 * @param {Values[]} list
 * @returns {value is Values}
 */
export const isPartOfArray = (value, list) => list.includes(/** @type {Values} */ (value));

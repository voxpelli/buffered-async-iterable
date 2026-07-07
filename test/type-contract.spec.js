import chai from 'chai';

import {
  bufferedAsyncMap,
  mergeIterables,
} from '../index.js';

chai.should();

describe('type-level contracts', () => {
  // The BufferedAsyncIterableIterator typedef deliberately does NOT extend
  // AsyncIterableIterator (an intersection would leak the lib's any-typed
  // method signatures); its structural assignability was previously a
  // comment-only claim. The @type-annotated assignments below turn it into
  // a compile-time gate: if a TypeScript lib upgrade ever tightens the
  // iterator types in a way that breaks the assignability, `npm run check`
  // fails here instead of downstream consumers finding out.
  it('returned iterators are assignable to AsyncIterableIterator', async () => {
    /** @type {AsyncIterableIterator<number>} */
    const mapped = bufferedAsyncMap([1, 2], async (n) => n);

    /** @type {AsyncIterableIterator<number>} */
    const merged = mergeIterables([[1, 2]]);

    // Runtime sanity on the same contract: the members the typedef promises
    // are actually there. (Optional-chained reads — through the
    // AsyncIterableIterator view, return/throw are optional members.)
    mapped.next.should.be.a('function');
    chai.expect(mapped.return).to.be.a('function');
    chai.expect(mapped.throw).to.be.a('function');
    // @ts-ignore — Symbol.asyncDispose is not part of AsyncIterableIterator
    chai.expect(mapped[Symbol.asyncDispose]).to.be.a('function');

    await mapped.return?.();
    await merged.return?.();
  });
});

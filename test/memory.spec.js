import chai from 'chai';

import {
  bufferedAsyncMap,
} from '../index.js';

chai.should();

/** @returns {AsyncGenerator<number>} */
async function * endlessSource () {
  for (let i = 0; ; i++) {
    yield i;
  }
}

/**
 * Drives an iterator hard and asserts per-pull heap growth stays flat — the
 * per-pull-park invariant. Before the fix, racing a single long-lived promise
 * every pull left a PromiseReaction on it per item (~530 bytes/item — ~10 MB
 * over 20k items). The cap leaves a wide margin for unrelated allocation noise.
 *
 * @param {import('../index.js').BufferedAsyncIterableIterator<number>} iterator
 * @param {() => void} gc
 * @returns {Promise<void>}
 */
async function assertNoPerPullRetention (iterator, gc) {
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      gc();
      await new Promise(resolve => { setImmediate(resolve); });
    }
  };

  // Warm up, then take a heap baseline once allocation has stabilised.
  for (let i = 0; i < 2000; i++) {
    await iterator.next();
  }
  await settle();
  const baseline = process.memoryUsage().heapUsed;

  const items = 20000;
  for (let i = 0; i < items; i++) {
    await iterator.next();
  }
  await settle();
  const growth = process.memoryUsage().heapUsed - baseline;

  await iterator.return();

  growth.should.be.below(3 * 1024 * 1024);
}

describe('bufferedAsyncMap() memory', () => {
  it('does not retain memory per pull on a long-lived unordered source', async function () {
    const { gc } = globalThis;

    if (typeof gc !== 'function') {
      // Needs --expose-gc — wired via .mocharc.json. Skip if run without it.
      this.skip();
      return;
    }

    await assertNoPerPullRetention(bufferedAsyncMap(endlessSource(), async (item) => item), gc);
  });

  it("does not retain memory per pull on a long-lived ordered: 'eager' source", async function () {
    const { gc } = globalThis;

    if (typeof gc !== 'function') {
      this.skip();
      return;
    }

    // nextValueEager races the same fresh-per-pull park as nextValue, so the
    // retention guarantee must hold for the eager path too.
    await assertNoPerPullRetention(bufferedAsyncMap(endlessSource(), async (item) => item, { ordered: 'eager' }), gc);
  });
});

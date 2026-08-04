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

describe('bufferedAsyncMap() memory', () => {
  it('does not retain memory per pull on a long-lived unordered source', async function () {
    // 22k awaited pulls plus repeated forced GC runs well inside Mocha's 2s
    // default locally (~200ms), but a loaded CI runner has no such margin —
    // and a timeout here would read as a memory regression rather than a slow
    // box. Generous enough to absorb that, tight enough to still catch a hang.
    this.timeout(30_000);

    const { gc } = globalThis;

    if (typeof gc !== 'function') {
      // Needs --expose-gc — wired via .mocharc.json. Skip if run without it.
      this.skip();
      return;
    }

    const iterator = bufferedAsyncMap(endlessSource(), async (item) => item);

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

    // Before the per-pull park fix, nextValue() raced a single long-lived
    // abortPromise every pull, leaving a PromiseReaction on it per item
    // (~530 bytes/item — ~10 MB over 20k items). The per-pull park keeps
    // this flat; the cap leaves a wide margin for unrelated allocation noise.
    growth.should.be.below(3 * 1024 * 1024);
  });
});

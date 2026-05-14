// Benchmark suite for the major design decisions in buffered-async-iterable.
//
// Run with:  npm run bench   (node --expose-gc --allow-natives-syntax)
//
// Each group guards one decision against performance regressions. The numbers
// are only meaningful relative to each other on the same machine/run — mitata
// handles JIT warmup and flags dead-code-eliminated benches with `!`. See
// CLAUDE.md "Benchmarks" for the methodology.

import {
  bench, do_not_optimize as doNotOptimize, group, run, summary,
} from 'mitata';

import { bufferedAsyncMap, mergeIterables } from '../index.js';
import {
  asyncRange, drain, fanOut, identity,
} from './fixtures.js';

// 1. The per-item "tax": how much does routing an async iterable through
//    bufferedAsyncMap cost versus a plain `for await` over the source? This is
//    the headline regression guard — if the library gets slower per item, it
//    shows up here first.
group('overhead: bufferedAsyncMap vs raw for-await', () => {
  for (const count of [100, 1000, 10000]) {
    summary(() => {
      bench(`raw for-await • ${count}`, async () => {
        doNotOptimize(await drain(asyncRange(count)));
      });
      bench(`bufferedAsyncMap • ${count}`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity)));
      });
    });
  }
});

// 2. The always-on abort wiring. internalAbortController is minted on every
//    call, the per-callback `{ signal }` object is allocated per dispatch, and
//    nextValue races a shared abortPromise. These three benches must stay
//    within noise of each other — that proves passing `options.signal` /
//    `errors: 'fail-fast'` does not add a hot-path cost over the no-options
//    case, and that the shared abortPromise did not regress per-pull overhead.
group('abort wiring: always-on cost', () => {
  const count = 5000;

  summary(() => {
    bench('no options', async () => {
      doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity)));
    });
    bench('options.signal (never aborted)', async () => {
      const controller = new AbortController();
      doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity, { signal: controller.signal })));
    });
    bench("errors: 'fail-fast' (happy path)", async () => {
      doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity, { errors: 'fail-fast' })));
    });
  });
});

// 3. The two dispatch loops. ordered:false picks the least-targeted iterator
//    via findLeastTargeted; ordered:true feeds from subIterators[0] and splices
//    new buffer slots into place. Guards both loops and the ordered-insertion
//    splice.
group('dispatch loop: ordered vs unordered', () => {
  for (const count of [1000, 10000]) {
    summary(() => {
      bench(`ordered: false • ${count}`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity, { ordered: false })));
      });
      bench(`ordered: true • ${count}`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity, { ordered: true })));
      });
    });
  }
});

// 4. bufferSize scaling. Larger buffers mean more in-flight promises and a
//    bigger Promise.race each pull — this shows the throughput/parallelism
//    trade-off curve and guards against a pathological cost at large buffers.
group('bufferSize scaling', () => {
  const count = 10000;

  summary(() => {
    for (const bufferSize of [1, 4, 16, 64]) {
      bench(`bufferSize: ${bufferSize}`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity, { bufferSize })));
      });
    }
  });
});

// 5. Nested sub-iterators. When the callback returns an AsyncIterable, each
//    result is unshifted onto the subIterators stack and drained through the
//    same buffer. Guards the sub-iterator machinery and the promisesToSource
//    WeakMap bookkeeping.
group('nested sub-iterators (async-generator callback)', () => {
  for (const count of [250, 2500]) {
    summary(() => {
      // Flat baseline producing the same number of output values (count * 4).
      bench(`flat callback • ${count * 4} values`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count * 4), identity)));
      });
      bench(`fan-out callback • ${count} × 4`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), fanOut)));
      });
    });
  }
});

// 6. mergeIterables wrapper overhead. mergeIterables is a thin wrapper over
//    bufferedAsyncMap with a `yield *` callback. This proves the wrapper adds
//    no measurable cost over calling bufferedAsyncMap with the equivalent
//    callback directly.
group('mergeIterables wrapper overhead', () => {
  const count = 2500;
  const sources = () => [asyncRange(count), asyncRange(count), asyncRange(count), asyncRange(count)];

  summary(() => {
    bench('mergeIterables([...])', async () => {
      doNotOptimize(await drain(mergeIterables(sources())));
    });
    bench('bufferedAsyncMap([...], yield *)', async () => {
      doNotOptimize(await drain(bufferedAsyncMap(sources(), async function * (iterable) {
        yield * iterable;
      })));
    });
  });
});

await run();

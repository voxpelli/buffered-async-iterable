// Throughput & overhead benchmarks. Registers benches on import — the
// run() call lives in benchmark/index.js.

import {
  bench, do_not_optimize as doNotOptimize, group, summary,
} from 'mitata';

import { bufferedAsyncMap } from '../index.js';
import {
  asyncRange, drain, identity, syncRange,
} from './fixtures.js';

// 1. The per-item "tax": how much does routing an async iterable through
//    bufferedAsyncMap cost versus a plain `for await` over the source? This is
//    the headline regression guard — if the library gets slower per item, it
//    shows up here first. .gc('inner') removes cross-iteration GC noise from
//    the heavy per-item allocation (promise envelopes, { signal } objects).
group('overhead: bufferedAsyncMap vs raw for-await', () => {
  for (const count of [100, 1000, 10000]) {
    summary(() => {
      bench(`raw for-await • ${count}`, async () => {
        doNotOptimize(await drain(asyncRange(count)));
      }).gc('inner');
      bench(`bufferedAsyncMap • ${count}`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity)));
      }).gc('inner');
    });
  }
});

// 2. bufferSize scaling. Larger buffers mean more in-flight promises and a
//    bigger Promise.race each pull — this shows the throughput/parallelism
//    trade-off curve and guards against a pathological cost at large buffers.
group('bufferSize scaling', () => {
  const count = 10000;

  summary(() => {
    for (const bufferSize of [1, 4, 16, 64]) {
      bench(`bufferSize: ${bufferSize}`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity, { bufferSize })));
      }).gc('inner');
    }
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
      }).gc('inner');
      bench(`ordered: true • ${count}`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity, { ordered: true })));
      }).gc('inner');
    });
  }
});

// 4. Input shape. A sync iterable or a plain array is wrapped by
//    makeIterableAsync before iteration — a distinct code path from feeding an
//    async generator. Guards that wrapping cost stays in line with the native
//    async-iterable case.
group('input shape: async generator vs sync iterable vs array', () => {
  const count = 10000;
  const fixedArray = [...syncRange(count)];

  summary(() => {
    bench('async generator', async () => {
      doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), identity)));
    }).gc('inner');
    bench('sync iterable', async () => {
      doNotOptimize(await drain(bufferedAsyncMap(syncRange(count), identity)));
    }).gc('inner');
    bench('array', async () => {
      doNotOptimize(await drain(bufferedAsyncMap(fixedArray, identity)));
    }).gc('inner');
  });
});

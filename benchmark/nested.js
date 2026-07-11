// Nested sub-iterator & mergeIterables benchmarks. Registers benches on
// import — the run() call lives in benchmark/index.js.

import {
  bench, do_not_optimize as doNotOptimize, group, summary,
} from 'mitata';

import { bufferedAsyncMap, mergeIterables } from '../index.js';
import {
  asyncRange, drain, fanOut, identity,
} from './fixtures.js';

// 1. Nested sub-iterators. When the callback returns an AsyncIterable, each
//    result is unshifted onto the subIterators stack and drained through the
//    same buffer. Guards the sub-iterator machinery and the promisesToSource
//    WeakMap bookkeeping. .gc('inner') removes GC noise from the extra
//    per-sub-iterator allocation.
group('nested sub-iterators (async-generator callback)', () => {
  for (const count of [250, 2500]) {
    summary(() => {
      // Flat baseline producing the same number of output values (count * 4).
      bench(`flat callback • ${count * 4} values`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count * 4), identity)));
      }).gc('inner');
      bench(`fan-out callback • ${count} × 4`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), fanOut)));
      }).gc('inner');
      // ordered: true serialises generator dispatch; ordered: 'eager' dispatches
      // concurrently with in-order delivery. Timerless fixtures can't show the
      // latency win, so these track eager's per-item bookkeeping overhead only.
      bench(`fan-out callback ordered • ${count} × 4`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), fanOut, { ordered: true })));
      }).gc('inner');
      bench(`fan-out callback eager • ${count} × 4`, async () => {
        doNotOptimize(await drain(bufferedAsyncMap(asyncRange(count), fanOut, { ordered: 'eager' })));
      }).gc('inner');
    });
  }
});

// 2. mergeIterables wrapper overhead. mergeIterables is a thin wrapper over
//    bufferedAsyncMap with a `yield *` callback. This proves the wrapper adds
//    no measurable cost over calling bufferedAsyncMap with the equivalent
//    callback directly.
group('mergeIterables wrapper overhead', () => {
  const count = 2500;
  const sources = () => [asyncRange(count), asyncRange(count), asyncRange(count), asyncRange(count)];

  summary(() => {
    bench('mergeIterables([...])', async () => {
      doNotOptimize(await drain(mergeIterables(sources())));
    }).gc('inner');
    bench('bufferedAsyncMap([...], yield *)', async () => {
      doNotOptimize(await drain(bufferedAsyncMap(sources(), async function * (iterable) {
        yield * iterable;
      })));
    }).gc('inner');
  });
});

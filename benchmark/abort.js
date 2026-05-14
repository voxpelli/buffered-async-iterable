// Abort & error-handling benchmarks. Registers benches on import — the
// run() call lives in benchmark/index.js.

import {
  bench, do_not_optimize as doNotOptimize, group, summary,
} from 'mitata';

import { bufferedAsyncMap } from '../index.js';
import {
  asyncRange, drain, identity, rejectingCallback,
} from './fixtures.js';

// 1. The always-on abort wiring. internalAbortController is minted on every
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

// 2. Abort & error *delivery* — the teardown paths the happy-path group above
//    never exercises. These are composite metrics (construct + partial consume
//    + teardown) and run noisier than the steady-state throughput benches; the
//    point is to catch a regression in the *shape* of the teardown cost, not a
//    precise per-item number.
group('abort & error delivery', () => {
  const count = 5000;

  summary(() => {
    // Pre-aborted signal: the source is never read, the first .next() rejects
    // with signal.reason. The construct + immediate-reject fast path.
    bench('pre-aborted signal', async () => {
      const iterator = bufferedAsyncMap(asyncRange(count), identity, { signal: AbortSignal.abort() });
      await iterator.next().catch(doNotOptimize);
    });

    // Mid-stream external abort: pull a few items, then abort and observe the
    // rejecting .next(). Measures abort delivery + markAsEnded teardown.
    bench('mid-stream external abort', async () => {
      const controller = new AbortController();
      const iterator = bufferedAsyncMap(asyncRange(count), identity, { signal: controller.signal });
      for (let i = 0; i < 10; i++) {
        doNotOptimize(await iterator.next());
      }
      controller.abort();
      await iterator.next().catch(doNotOptimize);
    });

    // fail-fast: the first settled callback error short-circuits iteration.
    bench("errors: 'fail-fast' triggering", async () => {
      await drain(bufferedAsyncMap(asyncRange(count), rejectingCallback, { errors: 'fail-fast' }))
        .catch(doNotOptimize);
    });

    // fail-eventually: every callback rejects, so every error lands in
    // capturedErrors[] and an AggregateError is built on drain.
    bench("errors: 'fail-eventually' aggregation", async () => {
      await drain(bufferedAsyncMap(asyncRange(count), rejectingCallback, { errors: 'fail-eventually' }))
        .catch(doNotOptimize);
    });
  });
});

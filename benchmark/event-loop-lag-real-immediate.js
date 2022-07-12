import {
  ITERATIONS_REFERENCE,
  promisedImmediate,
  bufferedLoopWithRealAsyncPayload,
} from './utils/loop.js';

await bufferedLoopWithRealAsyncPayload(ITERATIONS_REFERENCE, async (i) => i % 10 === 0 ? promisedImmediate(i * 2) : i * 2);

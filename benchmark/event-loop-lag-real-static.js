import {
  ITERATIONS_REFERENCE,
  bufferedLoopWithRealAsyncPayload,
} from './utils/loop.js';

await bufferedLoopWithRealAsyncPayload(ITERATIONS_REFERENCE, async (i) => i * 2);

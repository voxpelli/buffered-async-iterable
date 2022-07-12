import {
  ITERATIONS_REFERENCE,
  promisedImmediate,
  bufferedLoop,
} from './utils/loop.js';

await bufferedLoop(ITERATIONS_REFERENCE, async (i) => i % 10 === 0 ? promisedImmediate(i * 2) : i * 2);

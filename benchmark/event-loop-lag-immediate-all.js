import {
  ITERATIONS_REFERENCE,
  promisedImmediate,
  bufferedLoop,
} from './utils/loop.js';

await bufferedLoop(ITERATIONS_REFERENCE, async (i) => promisedImmediate(i * 2));

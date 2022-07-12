import {
  ITERATIONS_REFERENCE,
  bufferedLoop,
} from './utils/loop.js';

await bufferedLoop(ITERATIONS_REFERENCE, async (i) => i * 2);

/* eslint-disable unicorn/no-process-exit */
/* eslint-disable promise/always-return */
/* eslint-disable no-console */

import {
  ITERATIONS_REFERENCE,
  promisedImmediate,
  bufferedLoop,
} from './utils/loop.js';

Promise.resolve().then(async () => {
  await bufferedLoop(ITERATIONS_REFERENCE, async (i) => i % 10 === 0 ? promisedImmediate(i * 2) : i * 2);
})
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });

/* eslint-disable unicorn/no-process-exit */
/* eslint-disable promise/always-return */
/* eslint-disable no-console */

import {
  ITERATIONS_REFERENCE,
  bufferedLoopWithRealAsyncPayload,
} from './utils/loop.js';

Promise.resolve().then(async () => {
  await bufferedLoopWithRealAsyncPayload(ITERATIONS_REFERENCE, async (i) => i * 2);
})
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });

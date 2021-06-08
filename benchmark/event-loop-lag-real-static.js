/* eslint-disable unicorn/no-process-exit */
/* eslint-disable promise/always-return */
/* eslint-disable no-console */
/// <reference types="node" />

'use strict';

const {
  ITERATIONS_REFERENCE,
  bufferedLoopWithRealAsyncPayload,
} = require('./utils/loop');

Promise.resolve().then(async () => {
  await bufferedLoopWithRealAsyncPayload(ITERATIONS_REFERENCE, async (i) => i * 2);
})
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });

/* eslint-disable unicorn/no-process-exit */
/* eslint-disable promise/always-return */
/* eslint-disable no-console */
/// <reference types="node" />

'use strict';

const {
  promisedImmediate,
  bufferedLoop,
  bufferedLoopWithRealAsyncPayload,
  logLoopResult,
  bufferedLoopWithLog,
  bufferedLoopWithRealAsyncPayloadAndLog,
} = require('./utils/loop');

const ITERATIONS = 1000 * 1000;

Promise.resolve().then(async () => {
  const loopResult = await bufferedLoop(ITERATIONS, async (i) => i * 2);

  logLoopResult('plain static value async generators', undefined, loopResult);

  const referenceTime = loopResult.duration;

  await bufferedLoopWithLog('all immediates', referenceTime, ITERATIONS, async (i) => promisedImmediate(i * 2));
  await bufferedLoopWithLog('every other immediate', referenceTime, ITERATIONS, async (i) => i % 2 === 0 ? promisedImmediate(i * 2) : i * 2);
  await bufferedLoopWithLog('every third immediate', referenceTime, ITERATIONS, async (i) => i % 3 === 0 ? promisedImmediate(i * 2) : i * 2);
  await bufferedLoopWithLog('every fourth immediate', referenceTime, ITERATIONS, async (i) => i % 4 === 0 ? promisedImmediate(i * 2) : i * 2);
  // TODO: This seems to be a winner. Add an option for adding this automatically?
  await bufferedLoopWithLog('every tenth immediate', referenceTime, ITERATIONS, async (i) => i % 10 === 0 ? promisedImmediate(i * 2) : i * 2);
  await bufferedLoopWithLog('plain static value async generators again', referenceTime, ITERATIONS, async (i) => i * 2);

  const loopResultReal = await bufferedLoopWithRealAsyncPayload(ITERATIONS, async (i) => i * 2);

  logLoopResult('real: plain static value async generators', undefined, loopResultReal);

  const referenceTimeReal = loopResultReal.duration;

  await bufferedLoopWithRealAsyncPayloadAndLog('real: every tenth immediate', referenceTimeReal, ITERATIONS, async (i) => i % 10 === 0 ? promisedImmediate(i * 2) : i * 2);
})
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });

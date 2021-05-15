/* eslint-disable no-console */
/// <reference types="node" />

'use strict';

const { writeFile } = require('fs').promises;
const v8 = require('v8');
// const memwatch = require('@airbnb/node-memwatch');

const start = Date.now();

const {
  bufferAsyncIterable,
} = require('..');

const asyncIterable = (async function * () {
  for (let i = 0; i < 300000; i++) {
    yield i;
  }
})();

Promise.resolve().then(async () => {
  await writeFile(`${start}-start.heapsnapshot`, v8.getHeapSnapshot());

  // // Take first snapshot
  // const heapDiff = new memwatch.HeapDiff();

  // const baseAsyncIterable = bufferAsyncIterable(
  //   asyncIterable,
  //   async (i) => i
  // );

  const rawResult = [];

  for await (const value of asyncIterable) {
    rawResult.push(value);
  }

  /** @type {[number[], number]} */
  const result = [rawResult, Date.now()];

  global.gc();

  await writeFile(`${start}-end.heapsnapshot`, v8.getHeapSnapshot());
  // // TODO: Maybe wait for gc?
  // // Take the second snapshot and compute the diff
  // const diff = heapDiff.end();
  // console.log('diff', JSON.stringify(diff, undefined, 2));
  return result;
})
  .catch(err => {
    console.log('Error:', err);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
  });

/* eslint-disable unicorn/no-process-exit */
/* eslint-disable promise/always-return */
/* eslint-disable no-console */
/// <reference types="node" />

'use strict';

const { writeFile } = require('fs').promises;
const v8 = require('v8');
const memwatch = require('@airbnb/node-memwatch');

const {
  bufferAsyncIterable,
} = require('..');

/** @type {boolean} */
const EXPORT_HEAP_DUMPS = false;
/** @type {boolean} */
const DEBUG_LOGGING = false;

const SCRIPT_START = Date.now();
const ITERATIONS = 3 * 100 * 1000;
const EXPECTED_MAX_HEAP_BYTES_DIFF = 150 * 1000;

if (DEBUG_LOGGING) {
  memwatch.on('stats', () => { console.log('GC ran'); });
}

/**
 * @param {number} timeout
 * @returns {Promise<void>}
 */
const asyncTimeout = (timeout) => new Promise(resolve => { setTimeout(resolve, timeout); });

const asyncIterable = (async function * () {
  for (let i = 0; i < ITERATIONS; i++) {
    yield i;
  }
})();

/** @type {memwatch.HeapDiff} */
let heapDiff;

Promise.resolve().then(async () => {
  // Take first snapshot
  heapDiff = new memwatch.HeapDiff();

  EXPORT_HEAP_DUMPS && await writeFile(`${SCRIPT_START}-start.heapsnapshot`, v8.getHeapSnapshot());

  const baseAsyncIterable = bufferAsyncIterable(
    asyncIterable,
    async (i) => i * 2
  );

  const rawResult = [];

  for await (const value of baseAsyncIterable) {
    rawResult.push(value);
  }

  console.log(`Iterated over ${rawResult.length} items:`, rawResult.slice(0, 5).join(', ') + '...');
  console.log('...memory test complete!');
  console.log('Checking memory usage result...');
})
  .then(async () => {
    global.gc();
    await asyncTimeout(1000);

    EXPORT_HEAP_DUMPS && await writeFile(`${SCRIPT_START}-end.heapsnapshot`, v8.getHeapSnapshot());

    // Take the second snapshot and compute the diff
    const diff = heapDiff.end();

    if (diff.change.size_bytes > EXPECTED_MAX_HEAP_BYTES_DIFF) {
      console.error('Heap diff:', JSON.stringify(diff, undefined, 2));
      console.error(`...result is suspicious! Heap diff of ≈${Math.round(diff.change.size_bytes / 1000)}kb is larger than our set warning level of ${EXPECTED_MAX_HEAP_BYTES_DIFF / 1000}kb. Maybe we have a leak? Result needs inspection, lets consider it a failure.`);
      process.exit(1);
    } else {
      if (DEBUG_LOGGING) console.log('Heap diff:', JSON.stringify(diff, undefined, 2));
      console.log('...result is satisfactory!');
    }
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });

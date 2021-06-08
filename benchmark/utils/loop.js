'use strict';

const { getAndResetMaxLag } = require('./lag');
const { bufferAsyncIterable } = require('../..');

const ITERATIONS_REFERENCE = 1000 * 1000;

/**
 * @template T
 * @param {number} iterations
 * @param {(value: number) => Promise<T>} callback
 * @returns {AsyncGenerator<T>}
 */
const asyncGenerator = async function * (iterations, callback) {
  for (let i = 0; i < iterations; i++) {
    yield callback(i);
  }
};

/**
 * @template T
 * @param {T} value
 * @returns {Promise<T>}
 */
const promisedImmediate = (value) => new Promise(resolve => setImmediate(() => resolve(value)));

/** @typedef {{ rawResult: number[], duration: number, maxLag: number|undefined }} LoopResult */

/**
 * @param {AsyncIterable<any>} baseAsyncIterable
 * @returns {Promise<LoopResult>}
 */
const coreLoop = async (baseAsyncIterable) => {
  getAndResetMaxLag();

  const loopStarts = Date.now();
  const rawResult = [];

  for await (const value of baseAsyncIterable) {
    rawResult.push(value);
  }

  const duration = Date.now() - loopStarts;

  // eslint-disable-next-line unicorn/no-useless-undefined
  await promisedImmediate(undefined);
  const maxLag = getAndResetMaxLag();

  return {
    rawResult,
    duration,
    maxLag,
  };
};

/**
 * @param {number} iterations
 * @param {(item: number) => Promise<any>} callback
 * @returns {Promise<LoopResult>}
 */
const bufferedLoop = async (iterations, callback) => {
  return coreLoop(bufferAsyncIterable(
    asyncGenerator(iterations, async i => i * 2),
    callback
  ));
};

/**
 * @param {number} iterations
 * @param {(item: number) => Promise<any>} callback
 * @returns {Promise<LoopResult>}
 */
const bufferedLoopWithRealAsyncPayload = async (iterations, callback) => {
  return coreLoop(bufferAsyncIterable(
    asyncGenerator(iterations, i => promisedImmediate(i * 2)),
    callback
  ));
};

/**
 * @param {string} name
 * @param {number|undefined} referenceTime
 * @param {LoopResult} result
 */
const logLoopResult = (name, referenceTime, { rawResult, duration, maxLag }) => {
  console.log(`${name}: Iterated over ${rawResult.length} items:`, rawResult.slice(0, 5).join(', ')); // eslint-disable-line no-console
  console.log(`${name}: Max lag experienced: ${maxLag} ms`); // eslint-disable-line no-console

  console.log(`${name}: Done! Loop time: ${duration} ms`);// eslint-disable-line no-console
  if (referenceTime) {
    console.log(`${name}: ${Math.round(duration / referenceTime * 100 - 100)}% slower than reference time (which was ${referenceTime} ms)`); // eslint-disable-line no-console
  }
};

/**
 * @param {string} name
 * @param {number} referenceTime
 * @param {number} iterations
 * @param {(item: number) => Promise<any>} callback
 */
const bufferedLoopWithLog = async (name, referenceTime, iterations, callback) => {
  const result = await bufferedLoop(iterations, callback);
  logLoopResult(name, referenceTime, result);
};

/**
 * @param {string} name
 * @param {number} referenceTime
 * @param {number} iterations
 * @param {(item: number) => Promise<any>} callback
 */
const bufferedLoopWithRealAsyncPayloadAndLog = async (name, referenceTime, iterations, callback) => {
  const result = await bufferedLoopWithRealAsyncPayload(iterations, callback);
  if (name) {
    logLoopResult(name, referenceTime, result);
  }
};

module.exports = {
  ITERATIONS_REFERENCE,
  promisedImmediate,
  bufferedLoop,
  bufferedLoopWithRealAsyncPayload,
  logLoopResult,
  bufferedLoopWithLog,
  bufferedLoopWithRealAsyncPayloadAndLog,
};

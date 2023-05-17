import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  yieldValuesOverTime,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

chai.should();

describe('yieldValuesOverTime()', () => {
  const count = 6;

  /** @type {import('sinon').SinonFakeTimers} */
  let clock;
  /** @type {AsyncIterable<number>} */
  let baseAsyncIterable;
  /** @type {number[]} */
  let expectedResult;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);

    expectedResult = [];
    for (let i = 0; i < count; i++) {
      expectedResult.push(i);
    }
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return all values when looped over ', async () => {
    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {number[]} */
      const rawResult = [];

      for await (const value of baseAsyncIterable) {
        rawResult.push(value);
      }

      /** @type {[number[], number]} */
      const result = [rawResult, Date.now()];

      return result;
    })();

    await clock.runAllAsync();

    const [result, duration] = await promisedResult;

    result.should.deep.equal(expectedResult);
    duration.should.equal(6300);
  });

  it('should return all values when accessed directly ', async () => {
    // Create the promise first, then have it be fully executed using clock.runAllAsync()
    const promisedResult = (async () => {
      /** @type {AsyncIterator<number, void>} */
      const asyncIterator = baseAsyncIterable[Symbol.asyncIterator]();

      /** @type {Promise<IteratorResult<number, void>>[]} */
      const iterations = [];

      for (let i = 0; i < count; i++) {
        iterations.push(asyncIterator.next());
      }

      const rawResult = await Promise.all(iterations);

      /** @type {[(number|void)[], number]} */
      const result = [
        rawResult.map(item => item.value),
        Date.now(),
      ];

      return result;
    })();

    await clock.runAllAsync();

    const [result, duration] = await promisedResult;

    result.should.deep.equal(expectedResult);
    duration.should.equal(4300);
  });
});

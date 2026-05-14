/* eslint-disable promise/prefer-await-to-then */

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  yieldValuesOverTime,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

chai.should();

describe('bufferedAsyncMap() AsyncInterface return()', () => {
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

  it('should end the iterator when called', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    await iterator.next().should.eventually.deep.equal({ value: 0 });

    const returnValue = iterator.return();
    const nextAfterReturn = iterator.next();

    await clock.runAllAsync();

    await returnValue.should.eventually.deep.equal({ done: true, value: undefined });
    await nextAfterReturn.should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('should resolve return(value) to { done: true, value } per the iterator protocol', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    await iterator.next().should.eventually.deep.equal({ value: 0 });

    // return(value) reflects the passed argument...
    const firstReturn = iterator.return('sentinel');
    await clock.runAllAsync();
    await firstReturn.should.eventually.deep.equal({ done: true, value: 'sentinel' });

    // ...and each subsequent call reflects its own argument (not "remembered").
    const secondReturn = iterator.return('other');
    await clock.runAllAsync();
    await secondReturn.should.eventually.deep.equal({ done: true, value: 'other' });

    // A no-argument return() still resolves to { done: true, value: undefined }.
    const bareReturn = iterator.return();
    await clock.runAllAsync();
    await bareReturn.should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('should await a thenable return(value) argument', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    const returnValue = iterator.return(Promise.resolve('awaited'));
    await clock.runAllAsync();

    await returnValue.should.eventually.deep.equal({ done: true, value: 'awaited' });
  });

  it('should call the source iterator return() only once across repeated return() calls', async () => {
    const source = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item
    );

    await iterator.next().should.eventually.deep.equal({ value: 0 });

    const first = iterator.return('a');
    const second = iterator.return('b');
    await clock.runAllAsync();

    await first.should.eventually.deep.equal({ done: true, value: 'a' });
    await second.should.eventually.deep.equal({ done: true, value: 'b' });
    returnSpy.should.have.been.calledOnce;
  });

  it('should be called when a loop breaks', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item, { bufferSize: 3 });
    const returnSpy = sinon.spy(iterator, 'return');
    const throwSpy = sinon.spy(iterator, 'throw');

    const promisedResult = (async () => {
      // eslint-disable-next-line no-unreachable-loop
      for await (const value of iterator) {
        value.should.equal(0);
        break;
      }

      return Date.now();
    })();

    await clock.runAllAsync();

    const duration = await promisedResult;

    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
    duration.should.equal(2200);

    returnSpy.should.have.been.calledOnceWithExactly();
    throwSpy.should.not.have.been.called;
  });

  it('should be called when a loop throws', async () => {
    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);
    const returnSpy = sinon.spy(iterator, 'return');
    const throwSpy = sinon.spy(iterator, 'throw');
    const errorToThrow = new Error('Yet another error');

    const promisedResult = (async () => {
      // eslint-disable-next-line no-unreachable-loop
      for await (const value of iterator) {
        value.should.equal(0);
        throw errorToThrow;
      }

      return Date.now();
    })()
      .then(() => false, () => true);

    await clock.runAllAsync();

    returnSpy.should.have.been.calledOnceWithExactly();
    throwSpy.should.not.have.been.called;

    await promisedResult.should.eventually.equal(true);
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });
});

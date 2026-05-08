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

describe('bufferedAsyncMap() AsyncInterface throw()', () => {
  const count = 6;

  /** @type {import('sinon').SinonFakeTimers} */
  let clock;
  /** @type {AsyncIterable<number>} */
  let baseAsyncIterable;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('AC 6.1 + 6.2: throw(err) rejects with err and subsequent .next() returns done', async () => {
    const errorToThrow = new Error('thrown');

    const iterator = bufferedAsyncMap(baseAsyncIterable, async (item) => item);

    const first = iterator.next();
    await clock.runAllAsync();
    await first.should.eventually.deep.equal({ value: 0 });

    const tossed = iterator.throw(errorToThrow).catch(err => ({ rejectedWith: err }));
    await clock.runAllAsync();
    chai.expect(await tossed).to.deep.equal({ rejectedWith: errorToThrow });

    const after = iterator.next();
    await clock.runAllAsync();
    await after.should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('AC 6.2: throw(err) calls source.return() once', async () => {
    const errorToThrow = new Error('thrown');
    const source = yieldValuesOverTime(50, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item
    );

    const first = iterator.next();
    await clock.tickAsync(0);
    await first;

    const tossed = iterator.throw(errorToThrow).catch(err => err);
    await clock.runAllAsync();
    await tossed;

    returnSpy.should.have.been.calledOnce;
  });

  it('AC 6.2: in-flight callbacks observe signal.aborted=true after throw()', async () => {
    const errorToThrow = new Error('thrown');
    /** @type {AbortSignal | undefined} */
    let captured;

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(50, 100),
      async (item, { signal }) => {
        captured = signal;
        return item;
      }
    );

    const first = iterator.next();
    await clock.tickAsync(0);
    await first;
    chai.expect(captured?.aborted).to.equal(false);

    const tossed = iterator.throw(errorToThrow).catch(err => err);
    await clock.runAllAsync();
    await tossed;

    chai.expect(captured?.aborted).to.equal(true);
  });
});

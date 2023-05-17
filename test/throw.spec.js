import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  map as bufferAsyncIterable,
} from '../index.js';

import {
  yieldValuesOverTime,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

chai.should();

describe('bufferAsyncIterable() AsyncInterface throw()', () => {
  const count = 6;

  /** @type {AsyncIterable<number>} */
  let baseAsyncIterable;
  /** @type {number[]} */
  let expectedResult;

  beforeEach(() => {
    baseAsyncIterable = yieldValuesOverTime(count, (i) => i % 2 === 1 ? 2000 : 100);

    expectedResult = [];
    for (let i = 0; i < count; i++) {
      expectedResult.push(i);
    }
  });

  it('should end the iterator when called', async () => {
    const errorToThrow = new Error('Yet another error');

    const iterator = bufferAsyncIterable(baseAsyncIterable, async (item) => item);

    await iterator.next().should.eventually.deep.equal({ value: 0 });
    await iterator.throw(errorToThrow).should.eventually.be.rejectedWith(errorToThrow);
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('should be called when a loop throws', async () => {
    const iterator = bufferAsyncIterable(baseAsyncIterable, async (item) => item);
    const returnSpy = sinon.spy(iterator, 'return');
    const throwSpy = sinon.spy(iterator, 'throw');
    const errorToThrow = new Error('Yet another error');

    let caught;

    // Inspired by https://github.com/WebKit/WebKit/blob/1a09d8d95ba6085df4ef44306c4bfc9fc86fdbc7/JSTests/test262/test/language/expressions/yield/star-rhs-iter-thrw-thrw-get-err.js
    async function * g () {
      try {
        yield * iterator;
      } catch (err) {
        caught = err;
        throw err;
      }
    }

    const wrappedIterator = g();

    await wrappedIterator.next().should.eventually.deep.equal({ done: false, value: 0 });
    await wrappedIterator.throw(errorToThrow).should.eventually.be.rejectedWith(errorToThrow);
    await wrappedIterator.next().should.eventually.deep.equal({ done: true, value: undefined });
    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });

    (caught || {}).should.equal(errorToThrow);
    throwSpy.should.have.been.calledOnceWithExactly(errorToThrow);
    returnSpy.should.not.have.been.called;
  });
});

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';

import {
  bufferedAsyncMap,
} from '../index.js';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);

const should = chai.should();

describe('bufferedAsyncMap() basic', () => {
  it('should throw on falsy asyncIterable argument', () => {
    should.Throw(() => {
      // @ts-ignore
      bufferedAsyncMap();
    }, TypeError, 'Expected input to be provided');
  });

  it('should throw when provided asyncIterable is not an asyncIterable', () => {
    should.Throw(() => {
      // @ts-ignore
      bufferedAsyncMap(true);
    }, TypeError, 'Expected asyncIterable to have a Symbol.asyncIterator function');
  });

  it('should throw when provided callback is not a function', () => {
    should.Throw(() => {
      const asyncIterable = (async function * () {})();
      bufferedAsyncMap(
        asyncIterable,
        // @ts-ignore
        { bufferSize: true }
      );
    }, TypeError, 'Expected callback to be a function');
  });

  it('should throw when provided size is not a number', () => {
    should.Throw(() => {
      const asyncIterable = (async function * () {})();
      bufferedAsyncMap(
        asyncIterable,
        async () => {},
        // @ts-ignore
        { bufferSize: true }
      );
    }, TypeError, 'Expected bufferSize to be a number');
  });

  it('should return an AsyncIterable when provided with required arguments', () => {
    const asyncIterable = (async function * () {})();
    const bufferedAsyncIterable = bufferedAsyncMap(
      asyncIterable,
      async () => {}
    );

    should.exist(bufferedAsyncIterable);
    bufferedAsyncIterable.should.be.an('object');

    should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
    bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
  });

  it('should return an AsyncIterable when provided with all arguments', () => {
    const asyncIterable = (async function * () {})();
    const bufferedAsyncIterable = bufferedAsyncMap(
      asyncIterable,
      async () => {},
      { bufferSize: 10 }
    );

    should.exist(bufferedAsyncIterable);
    bufferedAsyncIterable.should.be.an('object');

    should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
    bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
  });

  it('should return an AsyncIterable when provided with an array value', () => {
    const bufferedAsyncIterable = bufferedAsyncMap(
      ['a', 'b', 'c'],
      async () => {}
    );

    should.exist(bufferedAsyncIterable);
    bufferedAsyncIterable.should.be.an('object');

    should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
    bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
  });

  it('should return an AsyncIterable when provided with a Set value', () => {
    const bufferedAsyncIterable = bufferedAsyncMap(
      new Set(['a', 'b', 'c']),
      async () => {}
    );

    should.exist(bufferedAsyncIterable);
    bufferedAsyncIterable.should.be.an('object');

    should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
    bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
  });

  it('should return an AsyncIterable when chained with itself', () => {
    const asyncIterable = (async function * () {})();
    const chainedBufferedAsyncIterable = bufferedAsyncMap(
      asyncIterable,
      async () => {}
    );
    const bufferedAsyncIterable = bufferedAsyncMap(
      chainedBufferedAsyncIterable,
      async () => {}
    );

    should.exist(bufferedAsyncIterable);
    bufferedAsyncIterable.should.be.an('object');

    should.exist(bufferedAsyncIterable[Symbol.asyncIterator]);
    bufferedAsyncIterable[Symbol.asyncIterator].should.be.a('function');
  });
});

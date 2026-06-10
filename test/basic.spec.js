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

  it('should throw when provided cleanupTimeout is not a positive finite number', () => {
    const asyncIterable = (async function * () {})();
    const invalid = [
      true,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'fast',
    ];

    for (const cleanupTimeout of invalid) {
      should.Throw(() => {
        bufferedAsyncMap(
          asyncIterable,
          async () => {},
          // @ts-ignore
          { cleanupTimeout }
        );
      }, TypeError, 'Expected cleanupTimeout to be a positive finite number of milliseconds', `cleanupTimeout=${String(cleanupTimeout)} should be rejected`);
    }
  });

  it('should throw when provided bufferSize is not a positive integer', () => {
    const asyncIterable = (async function * () {})();
    const invalid = [
      true,
      0,
      -1,
      Number.NaN,
      0.5,
      Number.POSITIVE_INFINITY,
    ];

    for (const bufferSize of invalid) {
      should.Throw(() => {
        bufferedAsyncMap(
          asyncIterable,
          async () => {},
          // @ts-ignore
          { bufferSize }
        );
      }, TypeError, 'Expected bufferSize to be a positive integer', `bufferSize=${String(bufferSize)} should be rejected`);
    }
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

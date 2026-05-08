import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  yieldValuesOverTime,
} from './utils.js';

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.should();

describe('bufferedAsyncMap() Symbol.asyncDispose', () => {
  /** @type {import('sinon').SinonFakeTimers} */
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('AC 2.1: should expose Symbol.asyncDispose as a function returning a Promise', async () => {
    const iterator = bufferedAsyncMap(yieldValuesOverTime(3, 100), async (item) => item);

    chai.expect(iterator[Symbol.asyncDispose]).to.be.a('function');
    const result = iterator[Symbol.asyncDispose]();
    chai.expect(result).to.be.a('promise');

    await clock.runAllAsync();
    await result;
  });

  it('AC 2.2: dispose should run the same cleanup as return() (source.return called)', async () => {
    const source = yieldValuesOverTime(6, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item
    );

    await iterator.next();

    const disposeResult = iterator[Symbol.asyncDispose]();
    await clock.runAllAsync();
    await disposeResult.should.eventually.equal(undefined);

    returnSpy.should.have.been.calledOnce;

    await iterator.next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  // Simulates the desugaring of `await using iterator = bufferedAsyncMap(...)` —
  // the runtime support for the syntax landed after Node 22.x, but the
  // semantics we promise (cleanup on scope exit via Symbol.asyncDispose) are
  // testable directly.
  it('AC 2.3: should run cleanup on scope exit (await using desugared)', async () => {
    const source = yieldValuesOverTime(6, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const promised = (async () => {
      const iterator = bufferedAsyncMap(
        { [Symbol.asyncIterator]: () => sourceIterator },
        async (item) => item
      );
      try {
        // eslint-disable-next-line no-unreachable-loop
        for await (const v of iterator) {
          chai.expect(v).to.equal(0);
          break;
        }
      } finally {
        await iterator[Symbol.asyncDispose]();
      }
    })();

    await clock.runAllAsync();
    await promised;

    returnSpy.should.have.been.calledOnce;
  });

  it('AC 2.4: dispose should be idempotent after return()', async () => {
    const source = yieldValuesOverTime(6, 100);
    const sourceIterator = source[Symbol.asyncIterator]();
    const returnSpy = sinon.spy(sourceIterator, 'return');

    const iterator = bufferedAsyncMap(
      { [Symbol.asyncIterator]: () => sourceIterator },
      async (item) => item
    );

    const flow = (async () => {
      await iterator.next();
      await iterator.return();
      await iterator[Symbol.asyncDispose]();
    })();

    await clock.runAllAsync();
    await flow;

    returnSpy.should.have.been.calledOnce;
  });
});

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  promisableTimeout,
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

  it('should expose Symbol.asyncDispose as a function returning a Promise', async () => {
    const iterator = bufferedAsyncMap(yieldValuesOverTime(3, 100), async (item) => item);

    chai.expect(iterator[Symbol.asyncDispose]).to.be.a('function');
    const result = iterator[Symbol.asyncDispose]();
    chai.expect(result).to.be.a('promise');

    await clock.runAllAsync();
    await result;
  });

  it('dispose should run the same cleanup as return() (source.return called)', async () => {
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
  it('should run cleanup on scope exit (await using desugared)', async () => {
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

  it('dispose should be idempotent after return()', async () => {
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

  it('dispose waits for a cleanup started by an earlier un-awaited return()', async () => {
    let finallySettled = false;

    /** @returns {AsyncIterable<number>} */
    async function * source () {
      try {
        yield 0;
        yield 1;
      } finally {
        await promisableTimeout(50);
        finallySettled = true;
      }
    }

    const iterator = bufferedAsyncMap(source(), async (item) => item, { bufferSize: 1 });

    const flow = (async () => {
      await iterator.next();

      // Fire-and-forget return() starts the cleanup; the microtask hop lets
      // it reach markAsEnded before dispose runs. Pre-fix, dispose hit the
      // isDone short-circuit and resolved while the source's finally was
      // still pending its 50ms — an `await using` scope would exit early.
      const firstCloser = iterator.return();
      await Promise.resolve();

      await iterator[Symbol.asyncDispose]();
      const settledAtDisposeResolve = finallySettled;

      await firstCloser;
      return settledAtDisposeResolve;
    })();

    await clock.runAllAsync();
    (await flow).should.equal(true);
  });
});

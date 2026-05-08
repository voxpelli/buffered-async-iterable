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

describe('bufferedAsyncMap() per-task AbortSignal', () => {
  /** @type {import('sinon').SinonFakeTimers} */
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('AC 3.1 + 3.2: invokes callback with (item, { signal }) where signal.aborted === false', async () => {
    /** @type {Array<{ item: number, signalIsAbortSignal: boolean, abortedAtCall: boolean }>} */
    const observations = [];

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(3, 100),
      async (item, opts) => {
        observations.push({
          item,
          signalIsAbortSignal: opts.signal instanceof AbortSignal,
          abortedAtCall: opts.signal.aborted,
        });
        return item;
      }
    );

    const flow = (async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of iterator) {
        // drain
      }
    })();

    await clock.runAllAsync();
    await flow;

    observations.should.have.length(3);
    for (const o of observations) {
      o.signalIsAbortSignal.should.equal(true);
      o.abortedAtCall.should.equal(false);
    }
  });

  it('AC 3.4: in-flight callbacks observe signal.aborted=true after iterator.return()', async () => {
    /** @type {AbortSignal | undefined} */
    let capturedSignal;

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item, { signal }) => {
        capturedSignal = signal;
        return item;
      }
    );

    await iterator.next();
    chai.expect(capturedSignal).to.exist;
    chai.expect(capturedSignal?.aborted).to.equal(false);

    const returned = iterator.return();
    await clock.runAllAsync();
    await returned;

    chai.expect(capturedSignal?.aborted).to.equal(true);
  });

  it('AC 3.5: in-flight callbacks observe signal.aborted=true after iterator.throw()', async () => {
    /** @type {AbortSignal | undefined} */
    let capturedSignal;

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item, { signal }) => {
        capturedSignal = signal;
        return item;
      }
    );

    await iterator.next();

    const flow = (async () => {
      try {
        await iterator.throw(new Error('boom'));
      } catch {
        // expected
      }
    })();

    await clock.runAllAsync();
    await flow;

    chai.expect(capturedSignal?.aborted).to.equal(true);
  });

  it('AC 3.6: in-flight callbacks observe signal.aborted=true after Symbol.asyncDispose', async () => {
    /** @type {AbortSignal | undefined} */
    let capturedSignal;

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(6, 100),
      async (item, { signal }) => {
        capturedSignal = signal;
        return item;
      }
    );

    await iterator.next();

    const disposed = iterator[Symbol.asyncDispose]();
    await clock.runAllAsync();
    await disposed;

    chai.expect(capturedSignal?.aborted).to.equal(true);
  });

  it('AC 3.7: in-flight callbacks do NOT observe signal.aborted=true on natural source exhaustion', async () => {
    /** @type {AbortSignal | undefined} */
    let lastSignal;

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(2, 100),
      async (item, { signal }) => {
        lastSignal = signal;
        return item;
      }
    );

    /** @type {number[]} */
    const result = [];
    const flow = (async () => {
      for await (const v of iterator) {
        result.push(v);
        // Capture the signal state *after* the callback has been invoked but
        // before the iterator finalises by reading the signal aborted state
        // before draining further.
        chai.expect(lastSignal?.aborted).to.equal(false);
      }
    })();

    await clock.runAllAsync();
    await flow;

    result.should.have.length(2);
  });

  it('AC 3.3: callbacks ignoring the second arg keep working unmodified', async () => {
    /** @type {number[]} */
    const result = [];

    const iterator = bufferedAsyncMap(
      yieldValuesOverTime(3, 100),
      async (item) => item * 10
    );

    const flow = (async () => {
      for await (const v of iterator) {
        result.push(v);
      }
    })();

    await clock.runAllAsync();
    await flow;

    result.should.have.members([0, 10, 20]);
  });
});

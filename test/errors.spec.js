import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import {
  bufferedAsyncMap,
} from '../index.js';
import {
  fromArray,
} from './utils.js';

chai.use(chaiAsPromised);
chai.should();

/**
 * @param {Error} expected
 * @returns {AsyncIterable<number>}
 */
async function * sourceThatThrows (expected) {
  yield 0;
  yield 1;
  throw expected;
}

describe('bufferedAsyncMap() errors', () => {
  /** @type {import('sinon').SinonFakeTimers} */
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should reject with the original error (identity preserved) when exactly one error is captured', async () => {
    const rejectionError = new Error('Single error');
    const callback = sinon.stub()
      .returnsArg(0)
      .onSecondCall().rejects(rejectionError);

    const promised = (async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of bufferedAsyncMap(fromArray([0, 1, 2]), callback)) {
        // drain
      }
    })();

    await clock.runAllAsync();
    await promised.should.be.rejectedWith(rejectionError);
  });

  it('should reject with AggregateError containing all errors when 2+ errors are captured', async () => {
    const errA = new Error('Error A');
    const errB = new Error('Error B');
    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(0).rejects(errA)
      .onCall(1).rejects(errB);

    /** @type {Error | undefined} */
    let caught;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of bufferedAsyncMap(fromArray([0, 1, 2]), callback, { bufferSize: 3 })) {
        // drain
      }
    } catch (err) {
      caught = /** @type {Error} */ (err);
    }

    await clock.runAllAsync();

    chai.expect(caught).to.be.instanceOf(AggregateError);
    /** @type {AggregateError} */ (caught).errors.should.deep.equal([errA, errB]);
  });

  it('should include both source and callback errors in the AggregateError', async () => {
    const sourceError = new Error('Source error');
    const callbackError = new Error('Callback error');
    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(0).rejects(callbackError);

    /** @type {Error | undefined} */
    let caught;
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of bufferedAsyncMap(sourceThatThrows(sourceError), callback, { bufferSize: 3 })) {
        // drain
      }
    } catch (err) {
      caught = /** @type {Error} */ (err);
    }

    await clock.runAllAsync();

    chai.expect(caught).to.be.instanceOf(AggregateError);
    const { errors } = /** @type {AggregateError} */ (caught);
    errors.should.include(sourceError);
    errors.should.include(callbackError);
  });

  it('should resolve cleanly when no errors are captured (no regression)', async () => {
    /** @type {number[]} */
    const result = [];

    const promised = (async () => {
      for await (const v of bufferedAsyncMap(fromArray([0, 1, 2]), async (item) => item * 2)) {
        result.push(v);
      }
    })();

    await clock.runAllAsync();
    await promised;

    result.should.have.members([0, 2, 4]);
  });

  it('should not retract values delivered before the throw', async () => {
    const rejectionError = new Error('Late error');
    const callback = sinon.stub()
      .returnsArg(0)
      .onCall(2).rejects(rejectionError);

    /** @type {number[]} */
    const delivered = [];
    /** @type {Error | undefined} */
    let caught;

    try {
      for await (const v of bufferedAsyncMap(fromArray([0, 1, 2]), callback, { bufferSize: 1 })) {
        delivered.push(v);
      }
    } catch (err) {
      caught = /** @type {Error} */ (err);
    }

    await clock.runAllAsync();

    delivered.should.deep.equal([0, 1]);
    chai.expect(caught).to.equal(rejectionError);
  });
});

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiQuantifiers from 'chai-quantifiers';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

chai.use(chaiAsPromised);
chai.use(chaiQuantifiers);
chai.use(sinonChai);

const should = chai.should();

function stubAsyncIterator () {
  const next = sinon.stub();
  const returnStub = sinon.stub();
  const throwStub = sinon.stub();

  /** @satisfies {AsyncIterator<*>} */
  const asyncIterator = {
    next,
    'return': returnStub,
    'throw': throwStub,
  };

  /** @type {AsyncIterable<*>} */
  const asyncIterable = {
    [Symbol.asyncIterator]: () => asyncIterator,
  };

  return {
    asyncIterable,
    asyncIterator,
  };
}

describe('The built in "yield *" functionality', () => {
  afterEach(() => {
    sinon.restore();
  });

  it("will throw when next isn't returning an object", async () => {
    const {
      asyncIterable,
      asyncIterator,
    } = stubAsyncIterator();

    asyncIterator.next.resolves('first');

    async function * mainGenerator () {
      yield * asyncIterable;
    }

    const mainIterator = mainGenerator();
    try {
      for await (const item of mainIterator) {
        item.should.equal('first');
      }
      throw new Error('Should nevercomplete this loop');
    } catch (err) {
      should.exist(err);
      err && err.should.be.instanceOf(TypeError);
    }

    asyncIterator.next.should.have.been.calledOnce;
    asyncIterator.return.should.not.have.been.called;
    asyncIterator.throw.should.not.have.been.called;

    await mainIterator[Symbol.asyncIterator]().next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('will not call throw when itself returns the error', async () => {
    const rejectionError = new Error('Rejection');

    const {
      asyncIterable,
      asyncIterator,
    } = stubAsyncIterator();

    asyncIterator.next.rejects(rejectionError).onFirstCall().resolves({ value: 'first' });

    async function * mainGenerator () {
      yield * asyncIterable;
    }

    const mainIterator = mainGenerator();
    try {
      for await (const item of mainIterator) {
        item.should.equal('first');
      }
      throw new Error('Should neve rcomplete this loop');
    } catch (err) {
      should.exist(err);
      if (err !== rejectionError) {
        throw err;
      }
    }

    asyncIterator.next.should.have.been.calledTwice;
    asyncIterator.return.should.not.have.been.called;
    // TODO: I thougt it should have been?
    asyncIterator.throw.should.not.have.been.called;

    await mainIterator[Symbol.asyncIterator]().next().should.eventually.deep.equal({ done: true, value: undefined });
  });

  it('will call throw?', async () => {
    const {
      asyncIterable,
      asyncIterator,
    } = stubAsyncIterator();

    asyncIterator.next.resolves({ value: undefined });

    async function * mainGenerator () {
      yield * asyncIterable;
    }

    const mainIterable = mainGenerator();
    const mainIterator = mainIterable[Symbol.asyncIterator]();

    const mainNextSpy = sinon.spy(mainIterator, 'next');
    const mainReturnSpy = sinon.spy(mainIterator, 'return');
    const mainThrowSpy = sinon.spy(mainIterator, 'throw');

    try {
      // eslint-disable-next-line no-unreachable-loop
      for await (const { item } of mainIterable) {
        throw new Error('Should hit the inside of this loop, yet got a: ' + item);
      }
      throw new Error('Should never complete this loop');
    } catch (err) {
      should.exist(err);
      if (!(err instanceof TypeError)) {
        throw err;
      }
    }

    asyncIterator.next.should.have.been.calledOnce;
    asyncIterator.return.should.have.been.calledOnce;
    asyncIterator.throw.should.not.have.been.called;

    mainNextSpy.should.have.been.calledOnce;
    mainReturnSpy.should.have.been.calledOnce;
    mainThrowSpy.should.not.have.been.called;

    // console.log(
    //   '😃 Call values',
    //   asyncIterator.next.args[0],
    //   asyncIterator.return.args[0],
    //   asyncIterator.throw.args[0],
    //   mainNextSpy.args[0],
    //   mainReturnSpy.args[0],
    //   mainThrowSpy.args[0]
    // );

    mainIterator.should.equal(mainIterable[Symbol.asyncIterator]());
    await mainIterable[Symbol.asyncIterator]().next().should.eventually.deep.equal({ done: true, value: undefined });
  });
});

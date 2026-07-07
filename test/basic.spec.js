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

  it('should throw when provided cleanupTimeout is not a positive number within the timer range', () => {
    const asyncIterable = (async function * () {})();
    const invalid = [
      true,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'fast',
      // Above Node's TIMEOUT_MAX, setTimeout silently clamps to 1ms —
      // turning a ~25-day grace period into abandon-after-1ms.
      2147483648,
      Number.MAX_SAFE_INTEGER,
    ];

    for (const cleanupTimeout of invalid) {
      should.Throw(() => {
        bufferedAsyncMap(
          asyncIterable,
          async () => {},
          // @ts-ignore
          { cleanupTimeout }
        );
      }, TypeError, 'Expected cleanupTimeout to be a positive number of milliseconds no larger than 2147483647 (2^31-1)', `cleanupTimeout=${String(cleanupTimeout)} should be rejected`);
    }

    // The exact maximum is accepted.
    should.not.Throw(() => {
      bufferedAsyncMap(
        (async function * () {})(),
        async () => {},
        { cleanupTimeout: 2147483647 }
      );
    });
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

  it('should prefer async iteration when the input implements both protocols', async () => {
    // for-await's GetIterator(async) prefers Symbol.asyncIterator; the
    // library must consume the same sequence — pre-fix the sync-iterable
    // wrap won and the sync sequence was processed instead.
    const hybrid = {
      * [Symbol.iterator] () {
        yield 'sync-a';
        yield 'sync-b';
      },
      async * [Symbol.asyncIterator] () {
        yield 'async-a';
        yield 'async-b';
      },
    };

    /** @type {string[]} */
    const collected = [];
    for await (const value of bufferedAsyncMap(hybrid, async (item) => item)) {
      collected.push(value);
    }

    collected.toSorted().should.deep.equal(['async-a', 'async-b']);
  });

  it('should fall back to sync iteration when the Symbol.asyncIterator member is nullish (GetMethod parity)', async () => {
    // for-await's GetMethod treats a null/undefined member as ABSENT and
    // falls back to Symbol.iterator — presence-based dispatch used to throw.
    const nullMember = {
      // eslint-disable-next-line unicorn/no-null -- the nullish member is exactly the GetMethod case under test
      [Symbol.asyncIterator]: null,
      * [Symbol.iterator] () {
        yield 'sync-a';
        yield 'sync-b';
      },
    };
    const undefinedMember = {
      [Symbol.asyncIterator]: undefined,
      * [Symbol.iterator] () {
        yield 'sync-c';
      },
    };

    /** @type {string[]} */
    const collected = [];
    // @ts-ignore — the nullish member is deliberately type-illegal
    for await (const value of bufferedAsyncMap(nullMember, async (item) => item)) collected.push(value);
    // @ts-ignore
    for await (const value of bufferedAsyncMap(undefinedMember, async (item) => item)) collected.push(value);

    collected.toSorted().should.deep.equal(['sync-a', 'sync-b', 'sync-c']);
  });

  it('should not fall back to sync iteration for a non-nullish non-callable member (GetMethod parity)', () => {
    // GetMethod throws for non-callable non-nullish — for-await would NOT
    // consume the sync protocol here, and neither do we.
    should.Throw(() => {
      bufferedAsyncMap(
        // @ts-ignore
        { [Symbol.asyncIterator]: 42, * [Symbol.iterator] () { yield 'never'; } },
        async () => {}
      );
    }, TypeError, 'Expected asyncIterable to have a Symbol.asyncIterator function');
  });

  it('should read the Symbol.asyncIterator member exactly once (stateful getter cannot desync validation from use)', async () => {
    let reads = 0;
    const oneShot = {
      get [Symbol.asyncIterator] () {
        reads += 1;
        // A function on the first read, garbage afterwards — pre-fix the
        // typeof check consumed the good read and the invocation crashed
        // with an unbranded TypeError.
        return reads === 1
          ? async function * () { yield 'one-shot'; }
          : 42;
      },
    };

    /** @type {string[]} */
    const collected = [];
    // @ts-ignore
    for await (const value of bufferedAsyncMap(oneShot, async (item) => item)) collected.push(value);

    collected.should.deep.equal(['one-shot']);
    reads.should.equal(1);
  });

  it('should throw the descriptive TypeError for a non-callable Symbol.asyncIterator member', () => {
    should.Throw(() => {
      bufferedAsyncMap(
        // @ts-ignore
        // eslint-disable-next-line unicorn/no-null -- a null member is exactly the malformed input under test
        { [Symbol.asyncIterator]: null },
        async () => {}
      );
    }, TypeError, 'Expected asyncIterable to have a Symbol.asyncIterator function');

    should.Throw(() => {
      bufferedAsyncMap(
        // @ts-ignore
        { [Symbol.asyncIterator]: 42 },
        async () => {}
      );
    }, TypeError, 'Expected asyncIterable to have a Symbol.asyncIterator function');
  });

  it('should support very large bufferSize values', async () => {
    // The refill loop is iterative; the previous tail self-recursion put
    // O(bufferSize) frames on the stack during the construction-time fill
    // and crashed with RangeError at bufferSize ≈7000.
    //
    // Deliberately NOT exercised here: an async-generator source (V8's
    // generator request queue makes N eagerly-enqueued next() calls
    // quadratic — external to this library) and a full for-await drain
    // (walks the exhausted-source slots one race at a time). Both are
    // pre-existing costs of huge buffers, not what this spec pins.
    //
    // 20_000 = ~3× the measured ≈7000-frame crash point at ~1/10 the
    // runtime of the original 100_000 — same regression power, cheaper.
    const values = ['a', 'b', 'c'];
    let i = 0;
    /** @type {AsyncIterable<string>} */
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => i < values.length
          ? { done: false, value: /** @type {string} */ (values[i++]) }
          : { done: true, value: undefined },
      }),
    };

    const iterator = bufferedAsyncMap(source, async (item) => item, { bufferSize: 20_000 });

    /** @type {string[]} */
    const collected = [];
    for (let j = 0; j < 3; j++) {
      const { value } = await iterator.next();
      if (value !== undefined) collected.push(value);
    }
    await iterator.return();

    collected.toSorted().should.deep.equal(['a', 'b', 'c']);
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

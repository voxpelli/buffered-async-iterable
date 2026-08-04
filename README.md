<div align="center">
  <img
    src="buffered-async-iterable.svg"
    width="650"
    height="auto"
  />
</div>


Buffered parallel processing of async iterables / generators.

**Requirements**: Node.js `^22.16.0 || >=24.0.0` (native `Symbol.asyncDispose` is required). For TypeScript consumers: TypeScript ≥5.9.

[![npm version](https://img.shields.io/npm/v/buffered-async-iterable.svg?style=flat)](https://www.npmjs.com/package/buffered-async-iterable)
[![npm downloads](https://img.shields.io/npm/dm/buffered-async-iterable.svg?style=flat)](https://www.npmjs.com/package/buffered-async-iterable)
[![Module type: ESM](https://img.shields.io/badge/module%20type-esm-brightgreen)](https://github.com/voxpelli/badges-cjs-esm)
[![Types in JS](https://img.shields.io/badge/types_in_js-yes-brightgreen)](https://github.com/voxpelli/types-in-js)
[![neostandard javascript style](https://img.shields.io/badge/code_style-neostandard-7fffff?style=flat&labelColor=ff80ff)](https://github.com/neostandard/neostandard)
[![Follow @voxpelli@mastodon.social](https://img.shields.io/mastodon/follow/109247025527949675?domain=https%3A%2F%2Fmastodon.social&style=social)](https://mastodon.social/@voxpelli)

## Why

A plain `for await` loop processes one item at a time — with an IO-bound body
each item waits for the previous one's network/database round-trip.
Array-based concurrency helpers (`p-map` and friends) run callbacks in
parallel but need the whole input materialised up front, which doesn't fit
streams, paginated APIs, database cursors or other unbounded sources.

`bufferedAsyncMap` sits in between: it maps an async callback over any
(async) iterable, keeping up to `bufferSize` items in flight at once while
pulling from the source only as fast as the buffer drains — bounded memory
and backpressure included. Results are yielded as they resolve (or in source
order with `ordered: true`), errors and cancellation follow
native-`AsyncGenerator` semantics, and cleanup is guaranteed through
`return()` / `Symbol.asyncDispose`.

Reach for something else when:

* **The input is already a reasonably-sized array** and you just want
  concurrency — an array helper like `p-map` is simpler.
* **The callback is synchronous or trivially cheap** — buffering costs more
  than it saves; a plain loop wins (see [Performance](#performance)).

## Usage

```sh
npm install buffered-async-iterable
```

### Simple

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

// A paginated source — yields ids one page at a time
async function * allUserIds () {
  let page = 1, batch;
  do {
    batch = await (await fetch(`https://api.example.com/users?page=${page++}`)).json();
    yield * batch.ids;
  } while (batch.hasMore);
}

// Look up each user, up to 6 (the default bufferSize) requests in flight
const users = bufferedAsyncMap(allUserIds(), async (id) => {
  const res = await fetch(`https://api.example.com/users/${id}`);
  return res.json();
});

for await (const user of users) {
  console.log(user.name); // Yielded as they resolve, not in source order
}
```

### Deterministic cleanup with `await using`

The returned iterator implements `Symbol.asyncDispose`, so on runtimes with [explicit resource management](https://github.com/tc39/proposal-explicit-resource-management) (Node 24+, or TypeScript ≥5.2 targeting older runtimes) it can be bound with `await using` — the source's `.return()` is then guaranteed to run when the scope exits, even if the loop is never reached:

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

await using mappedIterator = bufferedAsyncMap(source, async (item) => {
  return lookup(item);
});

const config = await loadConfig(); // throws? cleanup still runs

for await (const item of mappedIterator) {
  process(item, config);
}
```

A plain `for await … of` already closes the iterator on `break`/`throw` by itself, so `await using` is optional — see [Resource management](#resource-management) for the details.

### Collecting into an array

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

const results = await Array.fromAsync(bufferedAsyncMap(input, async (item) => {
  return lookup(item);
}));
```

### Fanning out — async generator callbacks

A callback can be an async generator; everything it yields is merged into the
main stream, load-balanced against the source and any other in-flight
generators:

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

const allFiles = bufferedAsyncMap(topLevelDirs, async function * (dir) {
  for (const entry of await readdir(dir)) {
    yield `${dir}/${entry}`;
  }
});

for await (const file of allFiles) {
  console.log(file);
}
```

The input can just as well be a plain array or any sync iterable — `bufferedAsyncMap(['a', 'b'], …)` works the same way.

### Merging iterables

```javascript
import { mergeIterables } from 'buffered-async-iterable';

const merged = mergeIterables([
  tailLogFile('a.log'),
  tailLogFile('b.log'),
  ['startup-marker'],
]);

for await (const line of merged) {
  console.log(line); // Lines from all sources, interleaved as they arrive
}
```

## API

### bufferedAsyncMap()

Applies `callback` to every item of `input`, keeping up to `bufferSize` calls in flight at once — `bufferSize` is the concurrency limit — and yielding values as they resolve.

#### Syntax

`bufferedAsyncMap(input, callback[, { bufferSize=6, cleanupTimeout, ordered=false, lookahead=1, signal, errors='fail-eventually' }]) => BufferedAsyncIterableIterator`

The returned `BufferedAsyncIterableIterator` type (exported in the type declarations) is an `AsyncIterableIterator` that additionally guarantees `return()`, `throw()` and `[Symbol.asyncDispose]()` to be present.

Two things worth knowing up front (the full contract lives in [Advanced semantics](ADVANCED.md)):

* **Construction starts work immediately.** Up to `bufferSize` items are pulled and their callbacks dispatched before the first `.next()` — that is the prefetching the library exists for. Construct close to consumption, or pair early construction with `await using` so an error before the loop doesn't strand in-flight work.
* **No two-way communication.** Values passed to `next(v)` are ignored, and `throw(err)` terminates the iterator rather than being forwarded to the source.

#### Arguments

* `input` – either an async iterable, an ordinary iterable or an array (strings — although iterable — are rejected eagerly; spread first if iterating characters is intended)
* `callback(item, { signal })` – an async function or an async generator. Values from async-generator callbacks are merged into the main stream (in the default unordered mode the buffer is refilled from whichever iterator — the input included — has the fewest items in flight; with `ordered: true` the current sub-iterator is drained first). The second argument's `signal` aborts on cancellation — see [Cancellation](#cancellation).

#### Options

* `bufferSize` – _optional_ – defaults to `6`, the max number of items processed simultaneously. Prefetching is speculative — up to `bufferSize` concurrent `next()` calls can be in flight before one resolves `done` (after which the source is never pulled again); async-generator sources serialize those natively, but a hand-rolled iterator that throws on concurrent pulls should use `bufferSize: 1`. Very large buffers pay an O(bufferSize) cost per unordered pull. Details in [Advanced semantics](ADVANCED.md#construction-and-the-prefetch-model).
* `cleanupTimeout` – _optional_ – a millisecond cap on how long close/abort waits for the source's `.return()` to settle. Defaults to no timeout (await forever), matching `AsyncGenerator`. See [Cancellation](#cancellation).
* `ordered` – _optional_ – defaults to `false`. When `true`, results are delivered in source order. For plain-value callbacks concurrency is unchanged — only the yield order; async-generator callbacks, however, run one at a time under `ordered: true` (`bufferSize` does not increase their concurrency). Use `ordered: 'eager'` to dispatch callbacks (generators included) concurrently while still delivering in source order. See [Ordered mode](ADVANCED.md#ordered-mode).
* `lookahead` – _optional_ – **`ordered: 'eager'` only** (a positive integer, default `1`; throws with any other mode). How many values a not-yet-at-head input may buffer ahead of delivery — total buffering is bounded at `bufferSize × lookahead`. It trades memory (and, under shared-resource contention, the head's critical-path priority) for pipeline depth on deep per-item generators; `bufferSize` is the lever for contention. See [Ordered mode](ADVANCED.md#ordered-mode).
* `signal` – _optional_ – an `AbortSignal`. When aborted, the next `iterator.next()` rejects with `signal.reason` exactly once and all later calls resolve `{ done: true, value: undefined }`. See [Cancellation](#cancellation).
* `errors` – _optional_ – defaults to `'fail-eventually'`. Controls how errors from the callback or the source surface to the consumer. See [Errors](#errors).

The returned iterator also implements `Symbol.asyncDispose`, so it can be used with `await using` for deterministic cleanup. See [Resource management](#resource-management).

### mergeIterables()

Merges all given (async) iterables in parallel, returning the values as they resolve. Thin wrapper over [`bufferedAsyncMap`](#bufferedasyncmap) — `mergeIterables(list)` is equivalent to `bufferedAsyncMap(list, async function * (x) { yield * x })` plus eager per-element validation; see that section for the full semantics of each option. Returns the same iterator shape (including `Symbol.asyncDispose`); validation is eager and covers the elements: a non-iterable element throws at call time with its index (`Expected input[1] to have a callable Symbol.asyncIterator or Symbol.iterator`), and string elements are rejected outright — merging `'abc'` as the characters `'a'`, `'b'`, `'c'` is almost always a mistake; spread the string first if that is genuinely intended.

#### Syntax

`mergeIterables(input[, { bufferSize=6, cleanupTimeout, ordered=false, lookahead=1, signal, errors='fail-eventually' }]) => BufferedAsyncIterableIterator`

#### Arguments

* `input` – an array of async iterables, ordinary iterables and/or arrays

#### Options

* `ordered` – _optional_ – defaults to `false`. When `false` (the default), values are interleaved as they resolve; when `true`, the merge preserves the input array order (drains the first iterable before pulling from the second, etc.); `'eager'` merges concurrently while still preserving input order.
* The remaining options (`bufferSize`, `cleanupTimeout`, `lookahead`, `signal`, `errors`) behave exactly as documented under [`bufferedAsyncMap`](#bufferedasyncmap).

## Cancellation

Pass an `AbortSignal` and abort it whenever you want to stop iteration:

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

const ac = new AbortController();
setTimeout(() => ac.abort(new Error('took too long')), 5000);

try {
  for await (const item of bufferedAsyncMap(source, async (item) => {
    return await fetchItem(item);
  }, { signal: ac.signal })) {
    console.log(item);
  }
} catch (err) {
  // err === ac.signal.reason
}
```

Aborting cancels *consumption* of the source: the next `iterator.next()` rejects with `signal.reason` exactly once (after the source's cleanup has run), and every later call resolves `{ done: true }`. In-flight callbacks continue running until they settle — to cancel network/IO inside your callback, forward the per-callback `signal` (the second argument, always present even without `options.signal`; it aborts on any iterator close) into `fetch`/`undici`/etc:

```javascript
bufferedAsyncMap(source, async (item, { signal }) => {
  const res = await fetch(`/items/${item}`, { signal });
  return res.json();
}, { signal: ac.signal });
```

If the source might hang inside its `.return()` cleanup, set `cleanupTimeout` to bound how long abort/close waits for it:

```javascript
for await (const item of bufferedAsyncMap(maybeWedgedSource, fn, {
  signal: ac.signal,
  cleanupTimeout: 1_000,
})) { /* … */ }
```

The finer points — pre-aborted signals, abort-vs-error precedence, the exactly-once contract's interaction with explicit `return()`, per-callback signal timing — are specified in [Advanced semantics](ADVANCED.md#cancellation-in-depth).

## Errors

There are two error modes:

### `'fail-eventually'` (default)

After the first error from the callback or the source, no further items are pulled from the source. Items already in flight continue to drain — their successful values still surface. When the buffer empties, the captured errors are thrown: a single error is thrown directly (identity preserved), two or more are wrapped in an [`AggregateError`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/AggregateError) (in capture order). Wrap your callback in `try/catch` if you need per-item isolation.

### `'fail-fast'`

Mirrors `Promise.all` semantics: the first error from the callback or the source short-circuits iteration. The next `iterator.next()` rejects with the original error (no `AggregateError` wrapping); subsequent calls return `{ done: true }`. The source's `.next()` is not called again, its `.return()` is called once, and in-flight callbacks observe an aborted per-callback signal.

```javascript
for await (const item of bufferedAsyncMap(source, fn, { errors: 'fail-fast' })) {
  // first thrown error halts iteration immediately
}
```

External abort takes precedence over captured-but-not-yet-thrown errors; the exact precedence rules (and how malformed source results are surfaced) are specified in [Advanced semantics](ADVANCED.md#errors-in-depth).

## Resource management

A plain `for await … of` already closes the iterator (calls its `.return()`, which runs the source's cleanup) when the loop `break`s, `return`s or throws — no extra syntax needed for the common case. On *normal* completion the language calls no `.return()` at all (that is plain `for await` semantics, not a quirk of this library); it isn't needed there, because a source that ran to exhaustion has already run its own cleanup, and this iterator runs its end-of-stream cleanup on that same path.

The returned iterator additionally implements `Symbol.asyncDispose`, so it can be bound with [`await using`](https://github.com/tc39/proposal-explicit-resource-management). That covers the gap a loop can't: the iterator being created but the loop never entered (or the iterator being handed around before it's consumed):

```javascript
await using iterator = bufferedAsyncMap(source, fn);

const config = await loadConfig(); // throws? cleanup still runs

for await (const item of iterator) {
  process(item, config);
}
```

`Symbol.asyncDispose` is equivalent to calling `iterator.return()` for cleanup and is idempotent — the double cleanup from `await using` plus a completed loop is harmless. The native `await using` *syntax* requires Node 24+ (TypeScript ≥5.2 transpiles it for older targets); where it isn't available everything works as it always has.

Both `bufferedAsyncMap` and `mergeIterables` return this same iterator shape.

## Performance

`npm run bench` runs a [mitata](https://github.com/evanwashere/mitata) suite covering the main design decisions. The findings:

* **There is a per-item buffering tax.** Routing values through `bufferedAsyncMap` costs more than a bare `for await` loop — roughly **20–25×** on synchronous-ish work. The library pays for itself when the callback is genuinely async / IO-bound and benefits from prefetching up to `bufferSize` items in parallel — for trivial synchronous transforms, a plain loop wins.
* **`bufferSize` is a throughput/overhead trade-off.** Larger buffers keep more work in flight but, in the default unordered mode, cost more per pull (the internal `Promise.race` grows with the buffer; `ordered: true` races only the head, so its per-pull cost stays flat). The default of `6` is a reasonable midpoint.
* **Async-generator callbacks are serial under `ordered: true`.** In ordered mode the buffer feeds from the current sub-iterator only, so a generator callback runs one at a time regardless of `bufferSize`. Use `ordered: 'eager'` (concurrent dispatch, in-order delivery) or return a value (e.g. an array) from the callback if you need concurrent execution with source-order delivery. See [Ordered mode](ADVANCED.md#ordered-mode).
* **The optional machinery is effectively free.** Passing `options.signal`, choosing an `errors` mode, feeding a sync iterable or array instead of an async generator, and using `mergeIterables` instead of a direct call all measure within a few percent of the base case.
* **Long streams don't accumulate memory.** Retention on unbounded streams is ~0 bytes per item, guarded by `test/memory.spec.js` — see [Advanced semantics](ADVANCED.md#memory-guarantees).

These ratios are *indicative of the shape of the cost* — measured on the maintainer's machine, not a benchmark report. `npm run bench` reproduces them locally; `npm run bench:json` captures a JSON snapshot for before/after diffing.

## Advanced semantics

The precise contracts — prefetch model, iterator-protocol details, abort
delivery, error precedence, memory guarantees — are documented in
[ADVANCED.md](ADVANCED.md). Everything there is pinned by the test
suite.

## Similar modules

* [`hwp`](https://github.com/mcollina/hwp) – iterates over an async iterable with concurrency, like this module; no nested-generator fan-out, merge helper or buffer load-balancing
* [`p-map`](https://github.com/sindresorhus/p-map) – concurrent async mapping; its `pMapIterable` accepts async-iterable input with `concurrency` + `backpressure` options, but delivers strictly in order (no yield-as-they-resolve) and has no generator fan-out, merge helper, `Symbol.asyncDispose` or abort-delivery contract
* Node's [`ReadableStream.prototype.pipeThrough`](https://nodejs.org/api/webstreams.html) / [`stream.pipeline`](https://nodejs.org/api/stream.html) – heavier-weight streaming with transforms, when you're already in stream land

<!-- ## See also

* [Announcement blog post](#)
* [Announcement tweet](#) -->

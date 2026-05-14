<div align="center">
  <img
    src="buffered-async-iterable.svg"
    width="650"
    height="auto"
  />
</div>


Buffered parallel processing of async iterables / generators.

**Requirements**: Node.js ≥22.0.0 (native `Symbol.asyncDispose` is required).

[![npm version](https://img.shields.io/npm/v/buffered-async-iterable.svg?style=flat)](https://www.npmjs.com/package/buffered-async-iterable)
[![npm downloads](https://img.shields.io/npm/dm/buffered-async-iterable.svg?style=flat)](https://www.npmjs.com/package/buffered-async-iterable)
[![Module type: ESM](https://img.shields.io/badge/module%20type-esm-brightgreen)](https://github.com/voxpelli/badges-cjs-esm)
[![Types in JS](https://img.shields.io/badge/types_in_js-yes-brightgreen)](https://github.com/voxpelli/types-in-js)
[![neostandard javascript style](https://img.shields.io/badge/code_style-neostandard-7fffff?style=flat&labelColor=ff80ff)](https://github.com/neostandard/neostandard)
[![Follow @voxpelli@mastodon.social](https://img.shields.io/mastodon/follow/109247025527949675?domain=https%3A%2F%2Fmastodon.social&style=social)](https://mastodon.social/@voxpelli)


## Usage

### Simple

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

async function * asyncGenerator() {
  yield ...
}

const mappedIterator = bufferedAsyncMap(asyncGenerator(), async (item) => {
  // Apply additional async lookup / processing
});

for await (const item of mappedIterator) {
  // Consume the buffered async iterable
}
```

### Array input

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

const mappedIterator = bufferedAsyncMap(['foo'], async (item) => {
  // Apply additional async lookup / processing
});

for await (const item of mappedIterator) {
  // Consume the buffered async iterable
}
```

### Async generator result

```javascript
import { bufferedAsyncMap } from 'buffered-async-iterable';

const mappedIterator = bufferedAsyncMap(['foo'], async function * (item) {
  // Apply additional async lookup / processing
  yield ...
  yield * ...
});

for await (const item of mappedIterator) {
  // Consume the buffered async iterable
}
```

## API

### bufferedAsyncMap()

Iterates and applies the `callback` to up to `bufferSize` items from `input` yielding values as they resolve.

#### Syntax

`bufferedAsyncMap(input, callback[, { bufferSize=6, ordered=false, signal, errors='fail-eventually' }]) => AsyncIterableIterator`

#### Arguments

* `input` – either an async iterable, an ordinary iterable or an array
* `callback(item, { signal })` – should be either an async generator or an ordinary async function. Items from async generators are buffered in the main buffer and the buffer is refilled by the one that has least items in the current buffer (`input` is considered equal to sub iterators in this regard when refilling the buffer). The second argument is an `{ signal: AbortSignal }` that aborts on cancellation — see [Cancellation](#cancellation).

#### Options

* `bufferSize` – _optional_ – defaults to `6`, sets the max amount of simultaneous items processed at once in the buffer.
* `ordered` – _optional_ – defaults to `false`, when `true` the result will be returned in order instead of unordered.
* `signal` – _optional_ – an `AbortSignal`. When aborted, iteration stops pulling from the source, the next pending or freshly-called `iterator.next()` rejects with `signal.reason` exactly once, and all subsequent calls return `{ done: true, value: undefined }`. See [Cancellation](#cancellation).
* `errors` – _optional_ – defaults to `'fail-eventually'`. Controls how errors from the callback or the source surface to the consumer. See [Errors](#errors).

The returned iterator also implements `Symbol.asyncDispose`, so it can be used with `await using` for deterministic cleanup. See [Resource management](#resource-management).

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

Aborting cancels *consumption* of the source. In-flight callbacks continue running until they settle. To cancel network/IO inside your callback, forward the per-callback `signal` (the second argument) into `fetch`/`undici`/etc:

```javascript
bufferedAsyncMap(source, async (item, { signal }) => {
  const res = await fetch(`/items/${item}`, { signal });
  return res.json();
}, { signal: ac.signal });
```

The per-callback `signal` is always present (even when no `options.signal` is passed) and aborts on iterator close (return / throw / dispose / source-exhaustion-with-cleanup), so callbacks can fast-path on shutdown. Callbacks observe `signal.aborted === true` within one microtask of iterator close — they continue running (Promises are not cancellable) until they reach the next `await` of something signal-aware (`fetch`, `undici`, etc.) or until they voluntarily exit via a check on `signal.aborted`.

If `options.signal` is already aborted at construction time, the source is never read and the first `iterator.next()` rejects with `signal.reason`. External abort always wins over queued errors.

## Errors

There are two error modes:

### `'fail-eventually'` (default)

Iteration continues after errors. Captured errors are thrown when the iterator drains:

* If exactly one error was captured, it is thrown directly (identity preserved).
* If two or more errors were captured, they are wrapped in an [`AggregateError`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/AggregateError) (in capture order).

In-flight callbacks may still complete in the background after an error is captured. Wrap your callback in `try/catch` if you need per-item isolation.

### `'fail-fast'`

Mirrors `Promise.all` semantics: the first error from the callback or the source short-circuits iteration. The next `iterator.next()` rejects with the original error (no `AggregateError` wrapping); subsequent calls return `{ done: true }`. The source's `.next()` is not called again, the source's `.return()` is called once, and in-flight callbacks observe `signal.aborted === true` on their per-callback signal within one microtask.

```javascript
for await (const item of bufferedAsyncMap(source, fn, { errors: 'fail-fast' })) {
  // first thrown error halts iteration immediately
}
```

External abort always takes precedence over either error mode: if `options.signal` aborts while errors are queued, the consumer sees `signal.reason`, not the captured errors.

## Resource management

The returned iterator implements `Symbol.asyncDispose`, so it can be used with [`await using`](https://github.com/tc39/proposal-explicit-resource-management) for deterministic cleanup:

```javascript
{
  await using iterator = bufferedAsyncMap(source, fn);
  for await (const item of iterator) {
    if (shouldStop(item)) break;
  }
} // source.return() runs here, regardless of how the block exited
```

`Symbol.asyncDispose` is equivalent to calling `iterator.return()` for cleanup and is idempotent. Native `await using` requires Node 22+ (or a transpiler).

### mergeIterables()

Merges all given (async) iterables in parallel, returning the values as they resolve. Thin wrapper over [`bufferedAsyncMap`](#bufferedasyncmap) — see that section for the full semantics of each option.

#### Syntax

`mergeIterables(input[, { bufferSize=6, ordered=false, signal, errors='fail-eventually' }]) => AsyncIterableIterator`

#### Arguments

* `input` – an array of async iterables, ordinary iterables and/or arrays

#### Options

* `bufferSize` – _optional_ – defaults to `6`, sets the max amount of simultaneous items processed at once in the buffer.
* `ordered` – _optional_ – defaults to `false`. When `false` (the default), values are interleaved as they resolve; when `true`, the merge preserves the input array order (drains the first iterable before pulling from the second, etc.).
* `signal` – _optional_ – an `AbortSignal`. Aborts the merge. See [Cancellation](#cancellation).
* `errors` – _optional_ – defaults to `'fail-eventually'`. See [Errors](#errors).

## Performance

`npm run bench` runs a [mitata](https://github.com/evanwashere/mitata) suite covering the main design decisions. The findings:

* **There is a per-item buffering tax.** Routing values through `bufferedAsyncMap` still costs more than a bare `for await` loop — roughly **20–25×** on synchronous-ish work. The library pays for itself when the callback is genuinely async / IO-bound and benefits from prefetching up to `bufferSize` items in parallel — for trivial synchronous transforms, a plain loop wins.
* **`bufferSize` is a throughput/overhead trade-off.** Larger buffers keep more work in flight but cost more per pull (the internal `Promise.race` grows with the buffer). The default of `6` is a reasonable midpoint.
* **The optional machinery is effectively free.** Passing `options.signal`, choosing an `errors` mode, feeding a sync iterable or array instead of an async generator, and using `mergeIterables` instead of a direct call all measure within a few percent of the base case.

### Changes vs. earlier 2.0.0 pre-release builds

Two optimisations during the 2.0.0 cycle, each guarded by the benchmark suite:

* **Skip the load-balancer when there are no sub-iterators.** `fillQueue` no longer runs the `findLeastTargeted` load-balancer (a `Map` allocation + a per-item scan) on the common path where the callback returns plain values — it only runs once a nested async-generator callback actually creates a sub-iterator. ~10–15% faster throughput.
* **Per-pull abort "park" instead of a long-lived race promise.** `nextValue` previously raced every pull against a single abort promise that never settled until the iterator closed — which left a `Promise` reaction record per item ([nodejs/node#51452](https://github.com/nodejs/node/issues/51452)), a real memory-retention issue on long-lived/unbounded streams. It now races a fresh, collectable per-pull "park" instead. This both removes the retention (≈0 vs ≈530 bytes/item on an unbounded stream — see `test/memory.spec.js`) and, by keeping the live-object set small during iteration, cuts GC pressure enough for a further ~20–40% throughput gain.

Net: throughput is **~25–45% faster** than the first 2.0.0 pre-release across the buffered-map, ordered/unordered, `bufferSize`, input-shape and `mergeIterables` benchmarks, with no regression in the abort/error paths and the long-stream memory retention eliminated.

These ratios are *indicative of the shape of the cost* — measured on the maintainer's machine, not a benchmark report. `npm run bench` reproduces them locally; `npm run bench:json` captures a JSON snapshot for before/after diffing. See `CLAUDE.md` for the methodology.

## Similar modules

* [`hwp`](https://github.com/mcollina/hwp) – similar module by [@mcollina](https://github.com/mcollina)

<!-- ## See also

* [Announcement blog post](#)
* [Announcement tweet](#) -->

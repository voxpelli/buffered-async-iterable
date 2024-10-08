<div align="center">
  <img
    src="buffered-async-iterable.svg"
    width="650"
    height="auto"
  />
</div>


Buffered parallel processing of async iterables / generators.

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

`bufferedAsyncMap(input, callback[, { bufferSize=6, ordered=false }]) => AsyncIterableIterator`

#### Arguments

* `input` – either an async iterable, an ordinare iterable or an array
* `callback(item)` – should be either an async generator or an ordinary async function. Items from async generators are buffered in the main buffer and the buffer is refilled by the one that has least items in the current buffer (`input` is considered equal to sub iterators in this regard when refilling the buffer)

#### Options

* `bufferSize` – _optional_ – defaults to `6`, sets the max amount of simultanoeus items that processed at once in the buffer.
* `ordered` – _optional_ – defaults to `false`, when `true` the result will be returned in order instead of unordered

### mergeIterables()

Merges all given (async) iterables in parallel, returning the values as they resolve

#### Syntax

`mergeIterables(input[, { bufferSize=6 }]) => AsyncIterableIterator`

#### Arguments

* `input` – an array of async iterables, ordinare iterables and/or arrays

#### Options

* `bufferSize` – _optional_ – defaults to `6`, sets the max amount of simultanoeus items that processed at once in the buffer.

## Similar modules

* [`hwp`](https://github.com/mcollina/hwp) – similar module by [@mcollina](https://github.com/mcollina)

<!-- ## See also

* [Announcement blog post](#)
* [Announcement tweet](#) -->

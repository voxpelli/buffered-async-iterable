# buffered-async-iterable

[![npm version](https://img.shields.io/npm/v/buffered-async-iterable.svg?style=flat)](https://www.npmjs.com/package/buffered-async-iterable)
[![npm downloads](https://img.shields.io/npm/dm/buffered-async-iterable.svg?style=flat)](https://www.npmjs.com/package/buffered-async-iterable)
[![Module type: ESM](https://img.shields.io/badge/module%20type-esm-brightgreen)](https://github.com/voxpelli/badges-cjs-esm)
[![Types in JS](https://img.shields.io/badge/types_in_js-yes-brightgreen)](https://github.com/voxpelli/types-in-js)
[![js-semistandard-style](https://img.shields.io/badge/code%20style-semistandard-brightgreen.svg)](https://github.com/voxpelli/eslint-config)
[![Follow @voxpelli@mastodon.social](https://img.shields.io/mastodon/follow/109247025527949675?domain=https%3A%2F%2Fmastodon.social&style=social)](https://mastodon.social/@voxpelli)

**WORK IN PROGRESS – early unpolished prerelease**

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

const mappedIterator = bufferedAsyncMap(['foo'], async function * (item) => {
  // Apply additional async lookup / processing
  yield ...
  yield * ...
});

for await (const item of mappedIterator) {
  // Consume the buffered async iterable
}
```

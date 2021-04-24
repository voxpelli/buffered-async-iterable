# Buffered Async Iterable

TODO: Fill in

[![js-semistandard-style](https://img.shields.io/badge/code%20style-semistandard-brightgreen.svg?style=flat)](https://github.com/standard/semistandard)

## Usage

### Simple

```javascript
const { createBufferedAsyncIterable } = require('buffered-async-iterable');

(async () => {
  const buffered = createBufferedAsyncIterable(asyncIterable, async (item) => {
    // Apply additional async lookup / processing
  });

  for await (const item of buffered) {
    // Consume the buffered async iterable
  }
})();
```

TODO: Add syntax documentation

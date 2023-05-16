# Async Iterable Prefetch

TODO: Fill in

[![js-semistandard-style](https://img.shields.io/badge/code%20style-semistandard-brightgreen.svg)](https://github.com/voxpelli/eslint-config)
[![ES Module Ready Badge](https://img.shields.io/badge/es%20module%20ready-yes-success.svg)](https://esmodules.dev/)
[![Types in JS](https://img.shields.io/badge/types_in_js-yes-brightgreen)](https://github.com/voxpelli/types-in-js)

## Usage

### Simple

```javascript
const { map } = require('buffered-async-iterable');

(async () => {
  const mappedData = map(asyncIterable, async (item) => {
    // Apply additional async lookup / processing
  });

  for await (const item of mappedData) {
    // Consume the buffered async iterable
  }
})();
```

TODO: Add syntax documentation

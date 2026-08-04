// Entry point for the mitata benchmark suite.
//
//   npm run bench                 — run everything
//   npm run bench:json            — emit JSON (for capture/diff against a
//                                   local baseline; no baseline is committed)
//   node benchmark/index.js abort — run only benches whose name matches /abort/
//
// The suite measures *library overhead* — the per-item bookkeeping cost of
// bufferedAsyncMap / mergeIterables — not simulated I/O. Theme files register
// their benches on import; this file is the only one that calls run(). See
// CLAUDE.md "Benchmarks" for the methodology and the per-group rationale.

import { run } from 'mitata';

import './throughput.js';
import './abort.js';
import './nested.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const filter = args.find((arg) => !arg.startsWith('--'));

await run({
  // Fail loudly if a bench throws instead of silently degrading the numbers.
  'throw': true,
  ...(json ? { format: 'json' } : {}),
  // The filter is a maintainer-supplied CLI arg matched against bench names.
  // eslint-disable-next-line security/detect-non-literal-regexp
  ...(filter ? { filter: new RegExp(filter) } : {}),
});

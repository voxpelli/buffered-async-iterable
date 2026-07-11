# Design: `ordered: 'eager'` — out-of-order callbacks, in-order yields

> **Status: implemented.** The mode is live in `index.js` (the `mode` plumbing,
> the `Lane` typedef, and the `classifyStep` / `admitOneLane` / `admitLanes` /
> `pumpLane` / `nextValueEager` helpers) and pinned by `test/eager.spec.js`
> (option handling, concurrency, in-order delivery, bounded look-ahead, cleanup,
> both error modes, and malformed-result handling) plus an eager retention case
> in `test/memory.spec.js`. This document is the design rationale behind that
> implementation.

## Motivation

`bufferedAsyncMap` has two delivery modes today:

| mode | delivery | plain-value callback | async-generator callback |
| --- | --- | --- | --- |
| `ordered: false` (default) | interleaved, as they resolve | concurrent up to `bufferSize` | concurrent up to `bufferSize` |
| `ordered: true` | strict source order | concurrent up to `bufferSize` | **serial — one at a time** |

The bottom-right cell is the gap. In `ordered: true`, an async-generator
callback runs strictly one at a time at any `bufferSize`: `fillOneSlot` always
feeds from `subIterators[0]`, a new sub-iterator is only created when the buffer
head yields an `isSubIterator` envelope, and stepping only ever happens against
the current sub-iterator — so exactly one generator body is live. `bufferSize`
only buffers the *undispatched* generator objects (the callback returns the
generator without running its body; the body runs on the first `.next()`, which
is the serialized stepping). A consumer that needs deterministic output *and*
fan-out concurrency (e.g. a file walk whose per-file work — open, read, parse —
happens before the first `yield`) silently loses the concurrency.

`ordered: 'eager'` fills the cell: **dispatch callbacks (including generators)
concurrently, but deliver in strict source order** — the same observable order
as `ordered: true`, with the concurrency of `ordered: false`.

## Why a third mode, not a change to `ordered: true`

`ordered: true`'s single-active-sub-iterator design makes unbounded buffering
*structurally impossible* — a real virtue. A generator maps one input to an
unknown number of outputs, and a non-head generator could be unbounded; eagerly
draining it would buffer without limit. Eager mode must therefore add a *second*
bound (per-lane look-ahead) that ordered mode does not have, and reworks the flat
delivery queue. That is a behavioural and structural change, so it is opt-in
under a new value rather than a silent change to `ordered: true`.

## API

Widen the option to `ordered?: boolean | 'eager'`:

- `false` (default) — interleaved delivery, full concurrency.
- `true` — source-order delivery; generators serial (unchanged).
- `'eager'` — source-order delivery; generators dispatched concurrently up to
  `bufferSize` with bounded look-ahead.

Normalized once at construction into a closure-scoped `mode`:

```js
/** @type {'unordered' | 'ordered' | 'eager'} */
const mode = ordered === 'eager' ? 'eager' : (ordered ? 'ordered' : 'unordered');
```

`ordered` was previously unvalidated (only defaulted); the implementation adds a
`TypeError` for anything that is not a boolean or `'eager'`. Because `'eager'` is
truthy, every existing `ordered`-as-boolean site is rewritten to an explicit
`mode === 'ordered'` check (`index.js` dispatch/race sites) so the string can
never be misread as "ordered". `mergeIterables` forwards `options` unchanged, so
`ordered: 'eager'` merges its input iterables concurrently with in-order
delivery for free.

## Architecture — the lane model

The flat `bufferedPromises` FIFO encodes delivery order as buffer index and
races either the head (ordered) or the whole array (unordered). It structurally
cannot express *"item 2's first value is waiting behind item 1's
unknown-length output, and non-head items self-drain in the background under a
bound."* Eager mode uses a **parallel structure** — an ordered list of **lanes**,
one per in-flight source item, in source order (`lanes[0]` is the delivery
head). It does not touch `bufferedPromises` / `promisesToSourceIteratorMap` /
`findLeastTargeted`, which stay exactly as-is for the other two modes.

```js
/**
 * @template R
 * @typedef {{
 *   iterator: AsyncIterator<R, void, void> | undefined, // generator lane; undefined for value lanes / undispatched
 *   buffer: R[],                                         // resolved values awaiting delivery, length <= K
 *   pending: BufferPromise | undefined,                  // in-flight event (source pull+dispatch, a step, or a value)
 *   dispatched: boolean,                                 // false while still a source-pull placeholder
 *   done: boolean,                                        // iterator reported done
 *   terminalErr: Error | undefined,                       // lane error, surfaced when the lane reaches head (source order)
 *   phantom: boolean,                                     // placeholder whose source pull resolved to done — drop it
 * }} Lane
 */
```

A plain-value callback becomes a lane with `iterator: undefined` that produces
one value then done; a generator callback becomes a lane whose `iterator`
streams then reports done. Delivery drains each lane's `buffer` head-first, so
both shapes are unified. Resolved step promises route back to their lane by
closure — each lane's `pending.then` handler closes over its own lane and
mutates it in place — so no `WeakMap` lookup is needed. Both existing envelope
factories (`valueEnvelope` / `terminalEnvelope`) are reused unchanged; lane state
lives on the `Lane`, never on the envelopes (the "exactly two envelope shapes"
invariant holds).

### Three isolated helpers

Hot-path isolation is mandatory (CLAUDE.md: the two envelope shapes and the two
race shapes are load-bearing; the benches guard them). Eager logic lives in three
helpers gated behind a single `mode === 'eager'` check at exactly two entry
points — construction and `next()`:

- **`admitLanes()`** — the producer. Analogous to `fillQueue`'s `while` loop, but
  pushes **placeholder lanes** (up to `bufferSize`) instead of buffer slots. Each
  placeholder's `pending` is `asyncIterator.next()`; when it resolves it is
  classified (done → `phantom`; malformed/reject → `terminalErr`; value →
  dispatch the callback, and if the result is async-iterable set `iterator` and
  start pumping, else it is a one-value lane). Placeholders do double duty:
  because a well-behaved async iterator answers `.next()` FIFO, the i-th
  placeholder binds the i-th source item, so **lane order == source order** even
  with several source pulls in flight; and `lanes[0]` always exists during
  admission, so the consumer always has a head to race.
- **`pumpLane(lane)`** — the background drainer, where the concurrency lives. If
  the lane has an iterator, is not done/errored, has no step in flight, and its
  `buffer` holds `< K` values, it takes one `.next()` step. On a value it buffers
  and (if not head) pumps again toward `K`; on done/malformed/reject it records
  terminal state. Every non-head lane pumps itself to `buffer.length === K` then
  parks. With **K = 1**, each lane steps exactly once — to its first yield, the
  expensive fan-out work — concurrently across all `bufferSize` lanes, then
  stops.
- **`nextValueEager()`** — the consumer. Mirrors `nextValue`'s shape and reuses
  the same `currentPark` / `ABORT_SENTINEL` machinery. It only ever waits on
  `lanes[0]`: it delivers `lanes[0]`'s buffered values in order; when `lanes[0]`
  reports done it drops the lane, admits a new one, and advances to `lanes[1]`
  (already primed in the background). If the head has no value yet it races
  `lanes[0].pending` against a fresh per-pull park — **never a long-lived
  promise** (the memory invariant; `test/memory.spec.js`).

### Backpressure and the memory bound

`K` bounds buffered values per lane; a lane only drains while it is head (only
`nextValueEager` shifts from a buffer), and draining re-invokes `pumpLane`, so
pause/resume is automatic. At most `bufferSize` lanes exist, each holding
`buffer.length <= K` and `<= 1` in-flight step; during ramp there are at most
`bufferSize` concurrent source pulls. Therefore **buffered values `<= bufferSize
* K` and in-flight steps `<= bufferSize`, independent of how unbounded any
non-head generator is.** An infinite non-head generator is stepped exactly `K`
times, then blocked until it becomes head.

**K = 1 is fixed for v1** (a module constant). The expensive fan-out cost is
before the first yield, so `K = 1` captures essentially the whole win;
delivery (one value at a time) cannot exploit deeper per-lane pipelining for the
head, and `K > 1` only inflates memory for non-head lanes. A future
`lookahead?: number` option can expose it if a real need appears — the typedef
and `pumpLane` already parameterize on `K`.

### Abort, cleanup, and errors

Eager has multiple live sub-iterators simultaneously — the situation unordered
mode already handles — so the abort/cleanup machinery generalizes:

- `doCleanup` adds live lane iterators to its `Promise.allSettled` set and
  `lanes.splice(0)` to its buffer clears, **deduping** any malformed-lane
  iterator already recorded in `pendingCloses` so it is `.return()`ed exactly
  once.
- `markAsEnded` (await-idempotence), `deliverAbort` / `requestConsumerAbort` (the
  exactly-once rejection contract), `cleanupTimeout` (races, never cancels), the
  per-callback `{ signal }`, `return(value)` / `Symbol.asyncDispose` — all
  structural and unchanged, since `nextValueEager` reuses the same park and abort
  re-check.
- **Errors surface in source order** (latent on the lane until it reaches head),
  so eager's observable order is identical to `ordered: true`, including
  fail-fast selecting the *source-order-earliest* error and fail-eventually's
  `AggregateError` accumulating in source order. The honest cost: eager fail-fast
  cannot short-circuit the pipeline before the earliest error reaches head (later
  in-flight lanes keep running until then) — exactly ordered mode's behaviour,
  and the price of identical observable order.

The user-facing contract lives in [`ADVANCED.md`](ADVANCED.md#ordered-mode)
under "Ordered mode".

## An implementation subtlety worth remembering

`admitOneLane`'s pending promise wraps *both* the source pull and the callback
dispatch (which includes an `await callbackResult`). `lane.pending` must stay
set for that whole span and be cleared only once the lane reaches its
post-dispatch state — **not** at the top of the handler. A parked
`nextValueEager` races the head lane's `pending`; if `pending` were cleared
during the `await`, the head would have `dispatched: false` and no in-flight
event, the park would race an instantly-resolving `undefined`, and the consumer
would busy-loop (an early implementation OOMed exactly this way on a fast array
source). `pumpLane`'s handler is synchronous after its step resolves, so it can
clear `pending` at the top without the same hazard.

## Possible follow-ups (not required)

- **Benchmarks**: eager rows in `benchmark/nested.js` / `benchmark/throughput.js`.
  Timerless fixtures measure bookkeeping overhead only (eager ≈ ordered, plus
  the lane objects); the *speedup* is proven by the fake-timer duration asserts
  in `test/eager.spec.js`, not the benches.
- **`lookahead?: number`**: expose `K` (currently the fixed `LANE_LOOKAHEAD = 1`
  module constant) if a workload with expensive *between-yield* work appears. The
  `Lane` typedef and `pumpLane` already parameterize on it.

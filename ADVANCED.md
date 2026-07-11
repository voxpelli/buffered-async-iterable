# Advanced semantics

The precise contracts behind the summaries in the [README](README.md).
Everything on this page is pinned by the test suite — section notes point at
the relevant spec files where it helps.

## Construction and the prefetch model

**Construction starts work immediately.** Up to `bufferSize` items are pulled
from the source and their callbacks dispatched before the first `.next()` —
that is the prefetching the library exists for. Construct close to
consumption, and pair early construction with `await using` (or an explicit
`return()`) so an error thrown between construction and the loop doesn't
strand in-flight work.

**Prefetching is speculative.** Up to `bufferSize` concurrent `next()` calls
can be in flight before an earlier one has resolved `done`. Once a
`{ done: true }` result *has* resolved, the source is never pulled again
(native `for await` parity — pinned by `test/basic.spec.js`). Async-generator
sources handle the speculation natively: their request queue serializes the
calls, and they answer trailing pulls with `done` forever. A hand-rolled
iterator object that *throws* on concurrent or trailing `next()` calls should
use `bufferSize: 1` or be wrapped in an async generator (which restores the
serializing queue).

**Very large buffers work but don't scale linearly.** Any positive integer is
accepted for `bufferSize`, but each unordered pull races the whole buffer, so
the per-pull cost is O(bufferSize). Sizes in the tens of thousands are
exercised in the test suite (the regression spec pins 20 000) — they're just
increasingly poor trade-offs.

## Iterator-protocol details

**No two-way communication.** Values passed to `next(v)` are ignored —
buffering decouples consumer pulls from source pulls, so there is no
suspension point to resume with a value. `throw(err)` always terminates the
iterator; it is never forwarded to the source, so a source generator cannot
`try/catch` around its `yield` and recover.

**`return(value)` matches `AsyncGenerator.prototype.return`.** It resolves to
`{ done: true, value }`, awaits a thenable `value` so the result never holds
a pending promise, and still runs cleanup if that await rejects. The iterator
closes *synchronously* when `return()` is called — a concurrent `next()`
resolves `{ done: true }` and the source is not pulled during the await
window.

**Concurrent `next()` calls are queued.** Overlapping `next()` calls are
chained — native AsyncGenerator's request-queue behaviour — so each call
resolves a distinct result in pull order, which is what makes the iterator
safe to share between concurrent consumers. A rejected pull does not poison
later calls: the next call observes the post-rejection state (usually
`{ done: true }`).

**Same-realm instances are assumed, and non-`Error` throws are normalized.**
`options.signal` must be an `AbortSignal` from the current realm
(`instanceof` check), and error identity (fail-fast, single-error
fail-eventually) assumes errors are same-realm `Error` instances. Anything
else — a cross-realm error (`node:vm`, some worker setups), `throw 'oops'`,
`throw 42`, a bare `Promise.reject()` — is normalized into a fresh `Error`
with a context-specific message (`Unknown callback error`,
`Unknown iterator error`, …) and the original value preserved on `.cause`
(omitted when the thrown value was nullish, which carries no information).
A consumer matching on a non-`Error` sentinel should check `.cause`.

## Ordered mode

`ordered: true` changes *delivery* order, not *dispatch* — **for plain-value
callbacks.** Their callbacks still run concurrently up to `bufferSize`, and
each result is delivered once every earlier item's result has been delivered,
so a slow first item head-of-line blocks the *results*, not the *work* (the
timing spec in `test/values.spec.js` pins that a full ordered run of
plain-value callbacks completes in roughly the longest item's time plus the
tail, not the serial sum).

**Async-generator callbacks are the exception.** In ordered mode the buffer
always feeds from the current sub-iterator rather than load-balancing, so a
generator callback runs strictly one at a time — `bufferSize` buffers the
undispatched generators but does not step them concurrently, and a slow first
item blocks the *work*, not just the results (the serial timing is pinned by
the nested-ordered spec in `test/values.spec.js`). Values are still delivered
contiguously and in source order: everything item N's generator yields comes
before anything from item N+1. If you need concurrent execution *and*
source-order delivery, use `ordered: 'eager'` (below), or return a value (such
as an array) from the callback rather than yielding from a generator.

Abort delivery and both error modes behave identically in ordered and
unordered mode (pinned by `test/abort.spec.js` and
`test/errors-fail-fast.spec.js`).

### `ordered: 'eager'` — concurrent dispatch, in-order delivery

`ordered: 'eager'` delivers in strict source order like `ordered: true`, but
dispatches callbacks — **including async-generator callbacks** — concurrently
up to `bufferSize`. It is the mode to reach for when you need deterministic
output *and* fan-out concurrency (e.g. a generator callback whose expensive
work happens before its first `yield`). `test/eager.spec.js` pins that a
generator workload reaches `bufferSize` concurrent callback bodies here while
`ordered: true` stays serial, and that both deliver the identical ordered
sequence.

Concurrency is bounded twice: at most `bufferSize` source items are in flight,
and each not-yet-at-head item is stepped at most once ahead of delivery (a
fixed look-ahead of one value). A non-head generator — even an unbounded one —
is therefore stepped once to its first value and then paused until it reaches
the delivery head, so total buffering stays bounded regardless of generator
length. Values are streamed one at a time as the head lane produces them; the
mode never buffers a whole generator's output.

Ordering, abort delivery, and both error modes are observably identical to
`ordered: true`. In particular a `fail-fast` error surfaces in source order —
the *source-order-earliest* error wins, not the chronologically-first — and a
generator's already-buffered values are delivered before its own later error.
Lane ordering relies on the source answering `.next()` in FIFO order; a
hand-rolled iterator that does not should use `bufferSize: 1` or be wrapped in
an async generator (the same caveat as the prefetch model above).

The trade-off versus unordered `fail-fast`: because delivery is head-first,
eager cannot short-circuit the pipeline before the earliest error reaches the
head, so later in-flight lanes keep running until then. That is the cost of
identical observable order, and it matches `ordered: true`.

## Cancellation in depth

**The exactly-once rejection contract.** When `options.signal` aborts, the
next pending or freshly-called `iterator.next()` rejects with `signal.reason`
— exactly once, identity preserved. Every later call resolves
`{ done: true, value: undefined }`. One exception: if the consumer has
already closed the iterator via `return()` / `throw()` /
`Symbol.asyncDispose` before the abort was delivered, the abort is
*suppressed* — a later `next()` resolves done instead of rejecting through an
iterator the consumer already chose to close. This matches native
`AsyncGenerator` behaviour. (Pinned by `test/abort.spec.js`.)

**Pre-aborted signals.** If `options.signal` is already aborted at
construction time the source is never read, and the first `next()` rejects
with `signal.reason` (subject to the same explicit-close suppression).

**Delivery waits for cleanup.** The rejecting `next()` only settles after the
source's `.return()` — its `finally` blocks — has run, the same guarantee
`for await` / `await using` give you on normal completion. If the source
might hang inside `.return()` (a `finally` awaiting an unsettled promise),
set `cleanupTimeout` to bound the wait. The timeout *races* the cleanup, it
does not cancel it: the pending source promises are abandoned (promises are
not cancellable), but the consumer unblocks. The internal timer is cleared as
soon as cleanup wins, so a prompt close doesn't keep the event loop alive for
the rest of the window.

**Abort/error precedence.** External abort takes precedence over queued /
not-yet-captured errors: if the signal aborts while fail-eventually errors
sit captured, the consumer sees `signal.reason`, not the captured errors. The
one exception is a fail-fast error already *committed* as the shutdown reason
— once fail-fast has begun closing the iterator its error owns the single
rejection, and an abort landing mid-cleanup is a no-op (first event wins).
(Pinned by `test/errors-fail-fast.spec.js`.)

**Per-callback signal timing.** The `{ signal }` passed to every callback is
always present — an internal `AbortController` is minted per call even with
no `options.signal` — and aborts on iterator close: `return()`, `throw()`,
`Symbol.asyncDispose`, external abort, first fail-fast error, or
end-of-stream cleanup after natural exhaustion. Callbacks observe
`signal.aborted === true` within one microtask of the close. They continue
running (promises are not cancellable) until they reach an `await` of
something signal-aware (`fetch`, `undici`, …) or voluntarily exit on a
`signal.aborted` check. (Pinned by `test/per-task-signal.spec.js`.)

## Errors in depth

**`'fail-eventually'` drain mechanics.** After the first captured error no
new items are pulled. Items already in flight drain: their successful values
still surface, and further errors among them are captured too. When the
buffer empties, one captured error is thrown directly (identity preserved);
two or more are wrapped in an `AggregateError` in capture order. In-flight
callbacks may still complete in the background after capture — wrap the
callback in `try/catch` for per-item isolation.

**`'fail-fast'` mechanics.** Mirrors `Promise.all`: the first error
short-circuits, the next `next()` rejects with the original error (no
wrapping), the source's `next()` is not called again and its `.return()` runs
exactly once. Also like `Promise.all`, exactly one error owns the rejection —
a second error racing the first, or an error that lost the shutdown race to a
synchronous abort, is discarded rather than delivered twice.

**Malformed results are stream errors.** A source or sub-iterator `next()`
that resolves to a non-object — or a result object whose `done`/`value` reads
throw (hostile getters, Proxy traps) — surfaces through the configured error
mode like any other stream error, identity preserved where an `Error` was
thrown. The offending iterator is still `.return()`ed during cleanup, exactly
once. (Pinned by `test/hostile-results.spec.js`.)

## Memory guarantees

Long-lived / unbounded streams retain ~0 bytes per item: each pull races a
fresh, collectable "park" promise instead of one long-lived abort promise
(the [nodejs/node#51452](https://github.com/nodejs/node/issues/51452)
retention pattern), and exactly one abort listener exists per iterator,
detached on close. `test/memory.spec.js` is the regression guard.

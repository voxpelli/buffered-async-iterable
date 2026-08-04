# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build, test, lint

The project is pure ESM JavaScript with **types written in JSDoc** (no TypeScript source files). `.d.ts` declarations are emitted from JSDoc by `tsc -p declaration.tsconfig.json` at publish time only — do not commit them.

- `npm test` — full check chain (lint, tsc, knip, type-coverage, installed-check) followed by mocha + c8 coverage. This is what the pre-push husky hook runs; if it fails, fix the cause rather than `--no-verify`.
- `npm run check` — only the static checks (lint + tsc + knip + type-coverage + installed-check), no tests.
- `npx mocha test/<name>.spec.js` — run a single spec file.
- `npx mocha test/<name>.spec.js -g "<pattern>"` — filter to specific `it()` blocks within a file.
- `npm run build` — clean and emit `.d.ts` declarations.
- `npm run bench` — run the mitata benchmark suite (see "Benchmarks" below).

Type-coverage is enforced at **≥99% strict** (excluding `test/**/*.js` and `benchmark/**/*.js` — test code is still tsc-strict checked). Lint is `@voxpelli/eslint-config` (neostandard). Knip's "unused devDependency" findings are treated as errors by `npm test`. `benchmark/index.js` is the knip entry point for the benchmark dir; `benchmark/*.js` is still tsc-checked (it's in `tsconfig.json`'s `include`) but excluded from `.d.ts` emit and type-coverage.

Commits must follow Conventional Commits (validated by the `commit-msg` husky hook via `validate-conventional-commit`); `release-please` cuts releases automatically from `main`, so `feat:` bumps minor and `fix:` bumps patch.

Engines: Node `^22.16.0 || >=24.0.0` (the well-known `Symbol.asyncDispose` is required natively; Node 20 and the non-LTS 23 are out). The CI matrix in `.github/workflows/nodejs.yml` should match.

## Architecture

The library is one core function (`bufferedAsyncMap`) plus a thin wrapper (`mergeIterables`). Everything lives in `index.js`; `lib/` contains three small helpers worth knowing about.

`mergeIterables` is a direct-return wrapper (not an async generator) — it returns the underlying `bufferedAsyncMap` iterator so consumers get `Symbol.asyncDispose` at runtime (Node 22's native async-generator prototypes don't carry one) and the proper `BufferedAsyncIterableIterator<R>` return type. Construction is eager: the input array AND its elements are validated at call time (string elements rejected — char-splitting a merge element is a caller mistake), and prefetching starts immediately.

### `bufferedAsyncMap(input, callback, options)` — the state machine

The function returns a stateful `AsyncIterableIterator` with these closure variables forming the state machine:

- **`bufferedPromises[]`** — in-flight promises (size capped at `bufferSize`). Every slot resolves to one of exactly two envelope shapes (a lean 3-field value envelope on the hot path, one shared terminal envelope for done/error/malformed — two stable hidden classes) and **can never reject**: the pipeline catches rejections, sync throws (from the callback or a `.next()` body) and malformed results alike. Internal catch-envelopes are tagged with a module-local `ERR` symbol so foreign IteratorResults carrying their own `err` property can't be mistaken for them — and the tag is brand-verified (`result[ERR] instanceof Error`, guaranteed by `normalizeError`) so a Proxy `has`-trap lying about the symbol can't spoof a terminal envelope either.
- **`subIterators[]`** — stack of nested iterators spawned when `callback` returns an `AsyncIterable<R>` (async-generator callbacks).
- **`promisesToSourceIteratorMap`** — WeakMap tracking which iterator produced each buffer slot; consulted by `findLeastTargeted` (`lib/find-least-targeted.js`) for load-balancing.
- **`internalAbortController`** — an `AbortController` minted per call. Its signal is **always** the second arg to `callback`, regardless of whether the consumer passed `options.signal`. It fires from `markAsEnded()` on iterator close, from `options.signal` aborting (linked via `addEventListener('abort', …)`), and from the first error in `errors: 'fail-fast'` mode. This is what lets in-flight callbacks fast-path on shutdown.
- **`abortReason: { reason, delivered: boolean } | undefined`** — drives the "reject the next `.next()` once with `signal.reason`, then `done:true` forever" contract. Set by external abort, pre-aborted signal, or first fail-fast error.
- **`capturedErrors[]`** — accumulates errors in `'fail-eventually'` mode; on drain, throws the single error directly (identity-preserved) or wraps in `AggregateError` for ≥2.
- **`isDone`** — set once by `markAsEnded()` to make all close paths idempotent.
- **`pendingCloses[]`** — iterators dropped from the pull rotation because they produced a malformed (non-object) result; still nominally open, so cleanup `.return()`s them ("stop pulling" and "skip cleanup" are separate concerns).

### Two pull/dispatch loops

`fillQueue()` is the **producer**: an iterative `while` loop (deliberately not recursion — O(bufferSize) stack frames crashed construction at bufferSize ≈7000) that pulls from source up to `bufferSize`, dispatches via `callback(item, {signal})` — inside a try/catch so sync throws become `{err}` envelopes — and pushes the wrapped promise into `bufferedPromises`. In `ordered: true` mode it always feeds from `subIterators[0]`; in `ordered: false` it picks the least-targeted iterator via `findLeastTargeted` to prevent starvation — but **only once a sub-iterator actually exists**. With none there is nothing to balance, so the fast-path falls straight through to the main iterator and `findLeastTargeted` is skipped entirely. This is the default-mode hot path; do not regress it.

`nextValue()` is the **consumer**: in a single flat `Promise.race`, races `bufferedPromises[0]` (ordered) or all of `bufferedPromises` (unordered) against a **fresh per-pull park promise**. The park is a `{ resolve }` deferred created each pull, stored in the mutable `currentPark`, and cleared once the race settles. The single construction-time `{ once: true }` listener on `internalAbortController.signal` resolves whatever park is currently waiting. It is deliberately *not* a single long-lived promise: racing the same never-settling promise every pull leaves a `PromiseReaction` on it per item (the nodejs/node#51452 retention pattern). Abort always wins over a buffered value resolving in the same tick — the post-race code re-checks `abortReason` regardless of which entry won the race.

`markAsEnded(throwAnyError)` is the **single cleanup path** and is **await-idempotent**, matching native AsyncGenerator's request queue: the first closer launches `doCleanup()` (stored as `cleanupPromise`) and EVERY closer — including later ones that find `isDone` already set, and pulls that observe a concurrent closer's `isDone` in `nextValue` — awaits that same promise before resolving, so no scope exits while the source's `finally` is still running. It always resolves `{ done: true, value: undefined }`; the caller owns the result value (`return(v)` starts `markAsEnded(false)` synchronously — so a pending `return(thenable)` still closes the iterator immediately, like native's queued request — then awaits its argument and returns `{ done: true, value: awaited }`). `doCleanup()` itself: fires `internalAbortController.abort()`, calls `Promise.allSettled(…)` over the main iterator + `subIterators` + `pendingCloses` (source `.return()` rejections are intentionally swallowed — a broken cleanup must not mask the consumer-facing error), clears buffers. The captured fail-eventually errors throw only for the FIRST closer that passed `throwAnyError` — a later `markAsEnded(true)` stays `{ done: true }`, preserving "reject exactly once". Called from `return()`, `throw()`, `Symbol.asyncDispose`, source-exhaustion, and abort delivery.

`deliverAbort()` and `handleStreamError()` are the error/abort dispatchers `nextValue` consults. `deliverAbort` is the ONE delivery sequence, shared by the pre-race and post-race sites: it claims the pending abort synchronously (`delivered = true` plus the `isDone` read, no `await` before the claim so concurrent pulls can't both win), then `await markAsEnded()` *before* the claimed reason propagates. An abort still undelivered when an explicit closer already set `isDone` is suppressed (later `next()` resolves done, matching native) rather than rejected through a closed iterator. `requestConsumerAbort(reason)` is the single writer pairing `abortReason` with `internalAbortController.abort(reason)` for every abort source (pre-aborted signal, external abort, first fail-fast error) — the per-callback signal's reason and the consumer-facing rejection can't diverge. `handleStreamError(normalizedErr)` centralises the fail-fast-vs-`capturedErrors.push` decision — it throws (fail-fast delivery) or captures and returns (fail-eventually) — and is shared by the buffered-promise `{err}` envelope path and the malformed-async-iterable catch (a callback returning `{ [Symbol.asyncIterator]() { throw … } }` is surfaced as a stream error, identical to a callback rejection). `drainOrContinue(fromSubIterator)` (hoisted, not per-pull) refills and either drain-throws via `markAsEnded(true)` — only when no abort is pending, else it re-enters `nextValue` so delivery stays exactly-once — or recurses.

### Iterator chaining via `currentStep`

`next()` chains each call's promise via `currentStep.then(nextValue, nextValue)` (both fulfilled and rejected handlers are `nextValue`) so that one rejection doesn't poison every subsequent call — the next call still re-enters `nextValue`, which then observes the post-rejection state machine (most often returning `{done:true}`).

### Lib helpers (reuse these, don't reimplement)

- `lib/find-least-targeted.js` — load-balancing: given a list of iterators and the current buffer, picks the iterator with fewest in-flight slots.
- `lib/misc.js` — `makeIterableAsync(input)` (sync iterable → async iterable), `arrayDeleteInPlace(list, value)` (in-place splice by value), and `normalizeError(err, defaultMessage)` (coerce non-`Error` rejections at every catch site — reuse this rather than open-coding `err instanceof Error ? err : new Error(...)`).
- `lib/type-checks.js` — `isSpecObject` (ECMA "Type(x) is Object" — callables included; closes the `typeof null === 'object'` hole; for IteratorResult/GetIteratorFromMethod positions), `isAsyncIterable` (built on `isSpecObject`, since the callback-result fan-out is itself a GetIteratorFromMethod position — a callable carrying `Symbol.asyncIterator` must fan out, matching `for await`), and `isPartOfArray`.

### Public-API contracts worth preserving

- Callback receives `(item, { signal })` where `signal` is **always present** (the internal one) even when no `options.signal` is provided.
- Aborts cancel **consumption**, not in-flight callback work. Promises cannot be cancelled — the library propagates the signal so user code can voluntarily exit; it does not race-and-discard. The README documents this explicitly.
- `errors: 'fail-eventually'` (default) keeps the historical "drain then throw" semantics; `'fail-fast'` mirrors `Promise.all`. External abort wins over queued/not-yet-captured errors — but once fail-fast has COMMITTED an error as the shutdown reason (requestConsumerAbort ran), that error owns the single rejection and a later external abort is a no-op (first event wins; pinned by test/errors-fail-fast.spec.js).
- Existing one-arg callbacks (`async (item) => …`) keep working — JS ignores extra args, so the second-arg widening is non-breaking.
- `iterator.return(value)` matches `AsyncGenerator.prototype.return` semantics: resolves to `{ done: true, value }`, awaits a thenable `value` so the result never holds a pending promise, and **still runs cleanup** if that await rejects (matching the "as-if a `return value;` was inserted at the suspension point — `finally` blocks run regardless" model). Pinned by `test/return.spec.js` and verified empirically against native `AsyncGenerator` on the current Node.

## Implementation invariants worth preserving

- **Zero runtime dependencies.** `package.json` has no `dependencies` block; keep it that way unless a new feature genuinely cannot be implemented without one. The harden branch's `@voxpelli/typed-utils` import was reverted for this reason.
- **One abort listener per call; never race a long-lived promise.** The only `addEventListener` against `internalAbortController.signal` or `externalSignal` is the construction-time linkage. Do not add per-pull listeners and do not reintroduce a single long-lived "abort promise" into `nextValue`'s `Promise.race` — racing the same never-settling promise every pull retains a `PromiseReaction` per item (nodejs/node#51452). The per-pull park is collectable; keep it that way. `test/memory.spec.js` guards this. (If a shared abort promise ever becomes genuinely necessary, the ecosystem answer is a subscription/completion-queue wrapper à la [@watchable/unpromise](https://www.npmjs.com/package/@watchable/unpromise) — not a bare long-lived promise in the race.)
- **`internalAbortController` is unconditional — do not lazify.** It is minted on every call regardless of whether `options.signal` or `errors: 'fail-fast'` are used. `iterator.return()` deliberately bypasses the `currentStep` chain (so it can run concurrently with a parked `next()`) and fires `markAsEnded()` → `internalAbortController.abort()`; that abort is what wakes the parked `nextValue()` by resolving its per-pull park. The per-callback signal tests (`test/per-task-signal.spec.js`) and the parallel-return+abort test (`test/abort.spec.js`) pin this in the no-options case, and the README / CLAUDE.md promise the per-callback `{signal}` is always present.
- **`cleanupTimeout` only races, never cancels.** When `options.cleanupTimeout` is set, `doCleanup` (the once-only cleanup body `markAsEnded` launches and awaits) races `Promise.allSettled(...returns)` against a `setTimeout` — the pending `.return()` promises are *abandoned*, not cancelled (promises aren't cancellable). That's the trade-off for unblocking a wedged source. The `setTimeout` is cleared in a `finally` once the race settles, so a prompt cleanup (the common case) doesn't leave a pending timer keeping the event loop alive for the rest of the window (pinned by the `clock.countTimers()` assertion in `test/abort.spec.js`). The default `undefined` keeps the unbounded `await` to match native `AsyncGenerator`. Don't make it default-to-a-number — silent behaviour shifts on close paths are how people get bitten.
- **Exactly two buffer-envelope shapes — don't merge the factories.** Every buffer slot resolves via `valueEnvelope` (lean 3-field hot shape) or `terminalEnvelope` (fat done/error shape); each has a single construction site so its V8 hidden class is structural. A unification into one fat factory was tried and regressed the bufferSize-scaling benches by double digits (~12-17%) before being redesigned — the split is load-bearing, not an inconsistency to clean up. The pipeline guarantees envelopes NEVER reject (sync throws, rejections, malformed results and hostile property reads all become envelopes — `test/hostile-results.spec.js` pins this).

## Style notes

- Helpers and exports use American spelling (`normalizeError`, `lib/misc.js`); local variables follow the helper they wrap (e.g. `normalizedErr`).
- Two TODO breadcrumbs from earlier development are intentionally gone — the iterator-protocol behaviours they pointed at are implemented and tested. **Don't reintroduce "go read the spec" TODOs in `index.js`**: every reachable behaviour is either covered by a spec file under `test/` or documented in this file. If you find an edge case worth chasing, write the test first.
- `markAsEnded(throwAnyError)` takes a single boolean — `true` only at source-exhaustion / drain (`markAsEnded(true)`, which surfaces captured fail-eventually errors), `false` or omitted everywhere else. The call sites carry an inline comment explaining the boolean; keep that convention.

## Test conventions

Mocha + chai + sinon. Tests use `sinon.useFakeTimers()` plus `clock.runAllAsync()` / `clock.tickAsync(ms)` for deterministic timing. The standard pattern for an async flow that needs the clock to advance is:

```js
const flow = (async () => { for await (...) { ... } })();
await clock.runAllAsync();
await flow;
```

Inline `for await` blocks **without** the IIFE wrapper will deadlock under fake timers when the source uses real `setTimeout`. Test helpers in `test/utils.js` (`yieldValuesOverTime`, `nestedYieldValuesOverTime`, `promisableTimeout`) are the source of truth — reuse them.

For testing rejections, prefer the `.catch(err => ({ rejectedWith: err }))` envelope pattern (see `test/abort.spec.js`) over chai-as-promised's `should.be.rejectedWith` when asserting identity-equality on non-Error reasons; for exactly-once-delivery assertions across several pulls, use `collectNextOutcomes` + `expectSingleRejectionThenDone` from `test/utils.js` (the accumulator idiom used across `test/errors-fail-fast.spec.js`).

`test/memory.spec.js` is the heap-retention regression guard for the per-pull park invariant. It runs under `--expose-gc` (wired via `.mocharc.json`'s `node-option: ["expose-gc"]`) and self-skips if `globalThis.gc` is unavailable (so `npx mocha test/memory.spec.js` directly still works — it picks up `.mocharc.json`). The other specs are unaffected by the flag.

## Benchmarks

`npm run bench` runs the [mitata](https://github.com/evanwashere/mitata) suite (`node --expose-gc --allow-natives-syntax`). `benchmark/fixtures.js` holds the shared helpers; three theme files register benches on import and `benchmark/index.js` is the only one that calls `run()`:

- `benchmark/throughput.js` — overhead vs raw `for await`, `bufferSize` scaling, ordered vs unordered dispatch, input shape (async generator / sync iterable / array).
- `benchmark/abort.js` — always-on abort-wiring cost, plus abort & error *delivery* (pre-aborted signal, mid-stream external abort, `fail-fast` triggering, `fail-eventually` `AggregateError` aggregation).
- `benchmark/nested.js` — nested sub-iterators, `mergeIterables` wrapper overhead.

`npm run bench:json` emits JSON — capture it before and after a change for a local diff (no baseline is committed; the numbers are machine-specific). `node benchmark/index.js <regex>` passes a filter to `run()`, matched against **bench names** (so `… abort` runs every bench with "abort" in its name, not a whole group). `run({ throw: true })` makes a broken bench fail the process loudly.

The non-negotiable rule, enforced by `benchmark/fixtures.js`: **benchmark fixtures never use timers.** `asyncRange` / `syncRange` yield with no artificial delay, so the numbers reflect the library's per-item bookkeeping overhead and not simulated I/O. A `setTimeout`-based source would make every benchmark measure the event loop instead. `do_not_optimize` wraps the drained result so the JIT cannot eliminate the loop; mitata handles warmup and flags dead-code-eliminated results with a `!`. The allocation-heavy groups (overhead, `bufferSize`, input shape, nested) use `.gc('inner')` — GC before each iteration — to remove cross-iteration GC noise; this makes those benches slower but their distribution tighter. The abort & error *delivery* benches are deliberately left on the default `.gc('once')`: they are composite metrics (construct + partial consume + teardown) and run noisier than the steady-state throughput benches — read them for the *shape* of the teardown cost, not a precise number. Re-run before/after any change to `fillQueue`, `nextValue`, or the abort wiring.

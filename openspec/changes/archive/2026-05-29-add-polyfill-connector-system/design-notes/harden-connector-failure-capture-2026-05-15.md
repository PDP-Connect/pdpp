# Harden connector failure capture — 2026-05-15

**Status:** implemented
**Trigger:** Audit `tmp/workstreams/audit-connector-fixture-capture-worker-report.md` (2026-05-15) flagged that automatic browser-connector capture only works when `PDPP_CAPTURE_FIXTURES=1` was enabled before failure, that Playwright traces can be lost on SIGTERM, and that trace finalization throws noisy `Target page, context or browser has been closed` errors after CDP transport drops even on successful runs.

## What changed

Three small, independently revertable hardenings landed in
`packages/polyfill-connectors/src/`.

### 1. `PDPP_CAPTURE_ON_FAILURE=1` mode

`createCaptureSession()` (`src/fixture-capture.ts`) now activates on
either `PDPP_CAPTURE_FIXTURES=1` (always retain — pre-existing behavior)
or `PDPP_CAPTURE_ON_FAILURE=1` (retain-on-failure).

In failure-only mode:

- The same DOM/ARIA/screenshot/locator/trace-chunk artifacts are written
  during the run as before.
- `CaptureSession.markSucceeded()` is called when `collect()` returns
  cleanly.
- `CaptureSession.finalize()` is called from the runtime's `finally`
  block after browser release. It deletes the entire raw run directory
  iff `markSucceeded()` was called; otherwise it retains it.

This gives a no-cost "first failure already has artifacts" guarantee
without paying storage on successful runs.

If both env vars are set, `PDPP_CAPTURE_FIXTURES` wins (always retain) —
explicit developer intent trumps the conditional mode.

**This is a capability, not a default.** Nothing in the Docker compose
files or the scheduler sets `PDPP_CAPTURE_ON_FAILURE=1` automatically.
Wiring it into a specific environment (devcontainer, docker compose,
scheduler) is a separate, deliberate step that should ship with the
environment's docs.

### 2. SIGTERM-aware trace finalization

`withShutdownRelease()` (`src/shutdown-hook.ts`) now accepts an optional
`finalize` callback. The runtime's `runInBrowser()` passes a callback
that runs `tracer.stop()` (flushes the in-flight chunk and writes the
final chunk path) before `release()` tears down the browser.

Behavior contract:

- The finalize callback runs at most once. The runtime also calls the
  same path from its own `finally`, guarded by a local `traceFinalized`
  flag so a SIGTERM during normal shutdown does not double-stop.
- Errors in `finalize()` are caught and logged to stderr; they never
  block `release()` and never flip a successful run's success status.
- Without this, a Docker stop / scheduler restart killed the trace
  entirely: chunks before the last checkpoint survived, but the
  in-flight chunk and final boundary did not.

### 3. Page-closed / browser-disconnected guards

- `captureBrowserPage()` (`src/connector-runtime.ts`) now early-returns
  with a bounded `[capture] page already closed at <label>; skipping
  dom snapshot` stderr line when `page.isClosed()` is true. This is
  the common shape of the `runtime-error` checkpoint when the failure
  cause is the page itself being torn down.
- `makeTracer().stop()` (`src/connector-runtime.ts`) probes
  `isContextDisconnected(context)` before calling `tracing.stop()` and
  `tracing.stopChunk()`. When the browser is already disconnected,
  the buffered Playwright events on the server side are unreachable;
  attempting to retrieve them throws the noisy "Target page, context
  or browser has been closed" exception. The guard writes a single
  `.error.json` diagnostic and retains the chunks that were already
  written to disk.
- `makeTracer().stop()` is now idempotent: a second call is a no-op,
  which lets both the SIGTERM finalize path and the normal `finally`
  block call it safely.

## Why a design note, not a spec section

The polyfill runtime spec already says capture is best-effort and
never failure-amplifying (the run-DONE is the source of truth for
success/failure). These changes preserve that contract — they just
narrow the failure modes where the contract leaks. Operator-facing
artifacts and env var docs do not need to move into the spec body.

If a future change wires `PDPP_CAPTURE_ON_FAILURE=1` into the reference
runtime / scheduler default, that surface — what the operator can
expect by default in a Docker deploy — belongs in spec text.

## Honest scope limits

- Non-browser (API-only) connectors still receive zero automatic
  capture calls. The runtime exposes `capture` on `BaseCollectContext`,
  but only `runInBrowser` invokes `captureBrowserPage()` at the five
  lifecycle checkpoints. Closing this gap for HTTP-only connectors is
  out of scope here and tracked in the audit (§2.4).
- Connector-author instrumentation (per-connector probe sets) is
  unchanged — the audit's Tier-3 suggestions remain open.
- Trace finalization runs SIGTERM-aware **inside** `runInBrowser()`.
  Connectors that complete without entering the browser branch are
  unaffected because no tracer exists for them.

## Verification

Unit tests under `packages/polyfill-connectors/src/*.test.ts`:

- `fixture-capture.test.ts` — `PDPP_CAPTURE_ON_FAILURE` activation,
  retain-on-failure semantics, success cleanup, idempotent finalize,
  `PDPP_CAPTURE_FIXTURES` precedence.
- `shutdown-hook.test.ts` — finalize callback runs before release,
  finalize rejection does not block release, listener accounting is
  preserved.
- `connector-runtime.test.ts` — `captureBrowserPage` page-closed skip,
  `isContextDisconnected` semantics, `makeTracer.stop()` disconnect
  short-circuit, tracer idempotence.

No live browser, scheduler, or credentials touched.

## Cross-cutting

- `debugging-leverage-open-question.md` — this tranche addresses item
  (P0) "first failure already has artifacts" for browser connectors.
  Items (3)/(4) fixture-driven smoke tests + offline replay remain
  open as a separate worker task.
- `raw-provenance-capture-open-question.md` — orthogonal. This note
  is about diagnostic capture (transient, local-only). Provenance
  capture is about owner-facing raw artifacts.

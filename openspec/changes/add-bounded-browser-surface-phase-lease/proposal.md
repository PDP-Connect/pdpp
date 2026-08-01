## Why

`BrowserSurfaceManager.acquireManagedBrowserSurfaceForRun` is pre-spawn only.
A running connector subprocess has no way to ask for a managed surface
mid-run, so a connector that only needs a browser for a bounded phase must
reserve one for its whole run. Slack's archive run is ~1h but only ~4 short
gap-page streams inside it actually need the browser, so Slack currently
either holds a surface for the full hour or cannot join
`PDPP_NEKO_MANAGED_CONNECTORS` at all.

The lease layer (`BrowserSurfaceLeaseManager`) is already connector-neutral —
capacity, fairness, queueing, promotion, fencing, idle-TTL and restart
reconciliation are implemented there and never inspect connector identity.
What is missing is a lifecycle wrapper that lets a connector request and
release a lease mid-run instead of only at spawn.

## What Changes

- Add a bounded connector<->controller round-trip
  (`BROWSER_SURFACE_REQUEST`/`BROWSER_SURFACE_RESPONSE`) to the connector
  runtime protocol, mirroring the existing `DETAIL_GAPS_PAGE` request/response
  pair. The round-trip has an explicit timeout, rejects on stdin close, and
  cleans up its listener on every exit path — the two existing round-trips
  (`sendInteraction`, `requestDetailGapPage`) have none of these and must not
  be used as the template for hang behavior.
- Add `BaseCollectContext.requestBrowserSurfacePhase()` on the connector side,
  returning a handle (`remoteCdpUrl`, `leaseId`, an `env` overlay shaped like
  `browserSurfaceLeaseEnv`, and an idempotent `release()`). The env overlay
  composes with the existing `resolveBrowserLaunchSource(visibility, env)`
  seam — no `process.env` mutation.
- Add `acquireManagedBrowserSurfaceForPhase(ctx)` /
  `releaseManagedBrowserSurfaceForPhase(runId)` to `BrowserSurfaceManager`.
  A phase lease uses the derived session id `${runId}#browser-phase`, never
  the run's own `run_id` — the lease layer's `#findNonTerminalRunLease`
  keys on `runId`, so reusing it would collide with the run's own lease and
  make run-level `cancel(runId)` terminate the phase lease too.
- A phase lease is NOT retained (`retainSurfaceProcess` omitted): it consumes
  an ordinary transient slot and is subject to the same cap, fair queue, and
  timeout as any other lease. No new capacity math.
- Add a fenced ownership map (`Map<runId, {leaseId, fencingToken}>`) in
  `BrowserSurfaceManager` so a release is a no-op unless the fencing token
  still matches the tracked lease — a stale or duplicate release message
  cannot free a lease it no longer owns.
- Add `BrowserSurfacePolicy.surfaceScope?: "run" | "phase"` to
  `packages/polyfill-connectors/src/browser-surface-policy.ts`. `"run"`
  (default, unchanged) keeps today's pre-spawn whole-run lease. `"phase"`
  means the controller does NOT reserve a run-level surface for that
  connector; it must request one mid-run instead. Slack declares
  `surfaceScope: "phase"`; ChatGPT stays `"run"` (retained,
  credential-boundary, unaffected by this change).
- Wire `releaseManagedBrowserSurfaceForPhase(runId)` as an idempotent backstop
  on process exit, run cancellation, and `finalizeRunCleanup`, alongside the
  existing spawn-time `browserSurfaceLease` release — same fenced release
  call, no second release authority.
- Fix boot/restart reconciliation to include each active run's derived phase
  session id (`${runId}#browser-phase`) in `activeRunIds` wherever that set
  is built for `reconcileAfterRestart` and `windowSettleReconciliation`, so a
  controller restart mid-phase cannot release a still-live phase lease
  (verified defect: `activeRunIds` today is built only from
  `listPersistedActiveRuns()`, which returns real DB `run_id`s and never the
  derived phase id).
- Slack's `runGapStreamsIfRequested` acquires a phase lease immediately before
  the four gap streams and releases it in the existing `finally` block. On
  `unavailable`, Slack does NOT fall back to a default/local acquire — it
  surfaces the existing honest failure handle (transport rejects, per-stream
  skips). No local Chromium fallback under a required managed surface.

## Capabilities

- Modified: `polyfill-runtime`
- Modified: `reference-implementation-architecture`

## Impact

- `packages/polyfill-connectors/src/connector-runtime-protocol.ts`: two new
  message kinds.
- `packages/polyfill-connectors/src/connector-runtime.ts`:
  `requestBrowserSurfacePhase()` on `BaseCollectContext`.
- `packages/polyfill-connectors/src/browser-surface-policy.ts`:
  `surfaceScope` field.
- `reference-implementation/runtime/browser-surface/*` (`BrowserSurfaceManager`
  and its controller wiring), `run-coordinator.ts` / `controller.ts` cleanup
  paths, and the `activeRunIds` construction site(s) consumed by
  `reconcileAfterRestart` / `windowSettleReconciliation.reconcileAtBoot`.
- `connectors/slack/index.ts`: `runGapStreamsIfRequested` acquires/releases a
  phase lease instead of relying on a run-level reservation.
- No new subsystems. No manifest schema field. No change to
  `assertRetainedManagedConnectorReserve`, `scheduler-readiness.ts`'s
  presence-only readiness check, or any run-scoped connector's (e.g. ChatGPT)
  existing pre-spawn acquire path — `surfaceScope` defaults to `"run"`, so
  unmodified connectors are byte-for-byte unaffected.
- This is a docs/spec-only change. No runtime code is implemented in this
  slice.

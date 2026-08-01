## 1. Protocol

- [ ] Add `BROWSER_SURFACE_REQUEST` (connector -> controller,
  `{type, request_id, action: "acquire" | "release", reference_only: true}`)
  and `BROWSER_SURFACE_RESPONSE` (controller -> connector,
  `{type, request_id, status: "granted" | "released" | "unavailable",
  remote_cdp_url?, lease_id?, profile_key?, stream_base_url?, surface_id?,
  reason?}`) to `connector-runtime-protocol.ts`, mirroring the
  `DETAIL_GAPS_PAGE` pair's shape.

## 2. Connector side

- [ ] `BaseCollectContext.requestBrowserSurfacePhase()` returning
  `{remoteCdpUrl, leaseId, env, release()}`.
- [ ] Explicit timeout (default 120s, aligned with
  `DEFAULT_NEKO_READINESS_TIMEOUT_MS`); rejects on stdin close; removes its
  `rl` listener on resolve, reject, timeout, and close.
- [ ] `release()` is idempotent and never throws.
- [ ] `env` composes directly with `resolveBrowserLaunchSource(visibility, env)`
  — no `process.env` mutation anywhere in the path.

## 3. Controller side

- [ ] `BrowserSurfaceManager.acquireManagedBrowserSurfaceForPhase(ctx)` /
  `releaseManagedBrowserSurfaceForPhase(runId)`, session id
  `${runId}#browser-phase`.
- [ ] Fenced `Map<runId, {leaseId, fencingToken}>` ownership tracking; release
  is a no-op on fencing mismatch.
- [ ] Queue-full / lease-wait-timeout resolves `unavailable`, never blocks the
  run.
- [ ] Process exit, run cancellation, and `finalizeRunCleanup` all call
  `releaseManagedBrowserSurfaceForPhase(runId)` as an idempotent backstop
  alongside the existing spawn-time `browserSurfaceLease` release.
- [ ] Fix `activeRunIds` construction (`run-coordinator.ts`) and its
  consumption (`windowSettleReconciliation.reconcileAtBoot`) to include the
  derived phase session id for every active run (AM-1 fix).

## 4. Phase-aware capability

- [ ] `BrowserSurfacePolicy.surfaceScope?: "run" | "phase"` in
  `browser-surface-policy.ts`; `"run"` default, unchanged behavior.
- [ ] Slack declares `surfaceScope: "phase"`; ChatGPT stays `"run"`.
- [ ] Confirm (no code change expected) `scheduler-readiness.ts`'s
  presence-only check treats a phase-scoped connector as ready without
  regression.

## 5. Slack

- [ ] `runGapStreamsIfRequested` acquires a phase lease immediately before
  the four gap streams and releases in the existing `finally` block.
- [ ] On `unavailable`, no fallback to a default/local acquire — existing
  honest failure handle (transport rejects, per-stream skips) only.

## 6. Acceptance-test map (I1-I8, AM-1..AM-3)

- [ ] I1 — Phase lease uses `${runId}#browser-phase`, distinct from the run's
  own lease: unit test on `BrowserSurfaceManager` asserting no collision when
  both a run-level and a phase lease exist concurrently for the same
  `runId`.
- [ ] I1 — Reacquiring a phase lease for the same run while one is already
  held returns/reuses the same tracked lease (one phase lease per run at a
  time), not a second independent lease.
- [ ] I2 — Timeout: connector-side test that `requestBrowserSurfacePhase()`
  rejects (or resolves `unavailable`, per final control-flow decision) when
  the controller never replies, within the configured timeout, and removes
  its listener.
- [ ] I2 — Stdin close: connector-side test that a pending phase request
  settles when stdin closes mid-wait, with listener cleanup verified (no
  accumulation across repeated calls).
- [ ] I3 — Fencing: acquire a phase lease, release it, acquire a new one for
  the same `runId`, then replay the first lease's stale `fencingToken` in a
  release call; assert the second lease remains held and the manager reports
  the stale release as a no-op.
- [ ] I4 — Cleanup idempotency: for each of process-exit, run-cancellation,
  and `finalizeRunCleanup`, assert a single release occurs and a second call
  from any other path is a no-op (no leaked lease, no double-release error,
  no double-release of the run's own `browserSurfaceLease`).
- [ ] I5 — Cap fairness: with the managed-surface cap fully consumed by
  ordinary leases, assert a phase-lease request queues in fair order and is
  granted only when a slot frees, never ahead of an earlier-queued ordinary
  lease.
- [ ] I6 — Run-scoped regression guard: existing ChatGPT (`surfaceScope:
  "run"`, retained) acquire/cleanup test suite passes unmodified; add an
  explicit assertion that `acquireManagedBrowserSurfaceForPhase` /
  `releaseManagedBrowserSurfaceForPhase` are never called for a `"run"`-scope
  connector's run.
- [ ] I7 — No local fallback: simulate a phase acquire resolving
  `unavailable` for a connector requiring a managed surface; assert
  `resolveBrowserLaunchSource` is never reached with an
  `isolated_local`-permitting env, and Slack's existing per-stream skip path
  fires instead.
- [ ] I8 (AM-1 regression guard) — Boot-restart test: persist an active run
  with a live phase lease, restart the controller/reconciliation path with
  `activeRunIds` built the fixed way, and assert
  `reconcileAfterRestart`/`windowSettleReconciliation.reconcileAtBoot` do
  NOT release that phase lease; a companion test with the OLD
  (unfixed) `activeRunIds` construction demonstrates the lease WOULD have
  been released, to prove the fix is load-bearing.
- [ ] AM-2 — Regression guard only (no new guard code): assert Slack emits no
  `INTERACTION` message anywhere in `slack/index.ts` (grep-backed test or
  static assertion), so the pre-existing type-agnostic
  `failPendingInteraction` guard cannot overlap a phase request in the
  shipped path. Document as a residual, not a fix, in the test's comment/
  description.
- [ ] AM-3 — Explicit unavailable-handling test: Slack's gap-stream runner
  under `unavailable` produces the four-stream-skip outcome with zero calls
  into any local-browser acquire path, distinct from the general I7 case,
  covering the exact Slack call site (`slack/index.ts:2556` acquisition
  point plus its `finally { transport.release() }` shape).

## 7. Validation

- [ ] `openspec validate add-bounded-browser-surface-phase-lease --strict`.
- [ ] `openspec validate --all --strict`.

## 8. Explicitly out of scope for this slice

- [ ] No runtime code implementation — this slice is docs/spec only.
- [ ] No fix to `failPendingInteraction`'s message-type-agnostic guard
  (AM-2) — recorded as a residual for the protocol owner.
- [ ] No change to `assertRetainedManagedConnectorReserve`,
  `scheduler-readiness.ts` internals, or any `surfaceScope: "run"`
  connector's existing pre-spawn path.

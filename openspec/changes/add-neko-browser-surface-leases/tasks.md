## 1. Lease Model And Policy

- [x] 1.1 Define `BrowserSurface`, `BrowserSurfaceLease`, `BrowserSurfaceRunProjection`, and allowed lease-state transitions in a runtime-owned module.
- [x] 1.2 Add validated configuration for `PDPP_NEKO_MANAGED_CONNECTORS`, `PDPP_NEKO_SURFACE_CAP`, `PDPP_NEKO_STATIC_PROFILE_KEY`, lease wait timeout, idle TTL, and priority defaults.
- [x] 1.3 Implement atomic acquire/queue/promote/release semantics with fencing tokens and store-enforced invariants for cap, one active lease per surface, and one non-terminal lease per run.
- [x] 1.4 Add deterministic lease-manager tests for compatible idle lease, static incompatible profile defer, capacity-full queue, duplicate pending run handling, cancellation, timeout/defer, release, stale release fencing, concurrent final-slot acquisition, and priority/FIFO pump ordering.

## 2. Controller Integration

- [x] 2.1 Detect when a connector run requires a managed n.eko surface before connector spawn.
- [x] 2.2 Acquire or queue a lease before the controller persists a spawned active run, and return queued/deferred run results from the run-start route without spawning a child.
- [x] 2.3 Keep queued runs out of `controller_active_runs`, `activeRuns`, `activeRunPromises`, `activeRunInteractions`, streaming nonce state, and `run.started` emission until lease promotion.
- [ ] 2.4 Add the controller-owned queue pump that promotes the next eligible queued lease on release, cancellation, timeout, and boot reconciliation.
- [ ] 2.5 Release leases idempotently on connector completion, failure, cancellation, pre-spawn failure after lease acquisition, child cleanup, and shutdown/restart reconciliation.

## 3. Connector Launch Environment

- [x] 3.1 Thread `PDPP_BROWSER_SURFACE_REQUIRED=neko`, lease-scoped CDP URL, profile key, and lease id into connector child env.
- [x] 3.2 Centralize polyfill browser launch resolution so managed lease env wins, required-without-lease fails closed, unmanaged per-profile remote-CDP remains dev-only, and local isolated launch remains the default.
- [x] 3.3 Add tests proving a required n.eko run never silently falls back to headless/local/per-profile remote-CDP launch when no lease is available.
- [ ] 3.4 Ensure manual-action streaming registration uses leased n.eko surface metadata for the n.eko backend descriptor without exposing CDP details to the browser client.

## 4. Persistence And Restart Reconciliation

- [x] 4.1 Persist enough lease/surface state to recover queued, starting, and leased rows after restart.
- [x] 4.2 Implement a dedicated browser-surface lease store rather than overloading `controller_active_runs`.
- [ ] 4.3 Reconcile persisted leases with active runs and live/static n.eko surfaces on boot after storage initialization and before routes/schedules launch new runs.
- [ ] 4.4 Preserve profile volumes/directories while releasing healthy stale leases, expiring missing-surface leases, and marking unhealthy surfaces failed.
- [ ] 4.5 Add restart tests for active leased run, stale leased run, missing surface, unhealthy surface, queued run within wait policy, queued run past wait policy, incompatible static profile, and queued-but-not-started run not being marked abandoned.

## 5. Operator Surfaces

- [ ] 5.1 Expose `pending_run_id`, `browser_surface_status`, `browser_surface_wait_reason`, and `browser_surface_lease_id` in reference-only run/operator views without overloading `active_run_id`.
- [ ] 5.2 Add clear copy distinguishing browser-surface resource backpressure from connector auth/protocol failure.
- [ ] 5.3 Emit redacted run timeline or diagnostic events for `run.browser_surface_requested`, `queued`, `starting`, `leased`, `released`, `deferred`, `expired`, `cancelled`, and `failed`.
- [ ] 5.4 Add tests or route smoke coverage proving queued/deferred statuses appear in run list/detail responses and do not appear as connector failures.

## 6. Docker And Follow-Up Boundary

- [ ] 6.1 Update the static n.eko Compose overlay to configure managed connectors and surface cap through the controller instead of injecting `PDPP_<PROFILE>_REMOTE_CDP_URL` as the managed path.
- [ ] 6.2 Keep static single-surface mode honest: compatible second run queues, incompatible profile defers, and no multi-surface concurrency claim.
- [ ] 6.3 Record the dynamic multi-container follow-up: per-surface container allocation, per-profile volumes, health checks, warm pool, and idle TTL shutdown.

## 7. Validation

- [ ] 7.1 Run targeted reference runtime/controller tests.
- [ ] 7.2 Run targeted polyfill connector launch tests.
- [ ] 7.3 Run `openspec validate add-neko-browser-surface-leases --strict`.
- [ ] 7.4 Run a Docker n.eko smoke proving cap `N=1` queues a second required run instead of spawning it.

## 1. Lease Model And Policy

- [ ] 1.1 Define `BrowserSurface` and `BrowserSurfaceLease` types and the allowed lease-state transitions.
- [ ] 1.2 Add configuration for n.eko surface cap, lease wait timeout, idle TTL, and priority class defaults.
- [ ] 1.3 Add deterministic tests for compatible idle lease, lazy start, capacity-full queue, cancellation, timeout/defer, and release.

## 2. Controller Integration

- [ ] 2.1 Detect when a connector run requires a managed n.eko surface before connector spawn.
- [ ] 2.2 Acquire or queue a lease before the controller persists a spawned active run.
- [ ] 2.3 Ensure queued runs are represented as waiting/deferred runtime artifacts rather than active connector children.
- [ ] 2.4 Release leases on connector completion, failure, cancellation, and child cleanup.

## 3. Connector Launch Environment

- [ ] 3.1 Thread lease-scoped CDP URL, profile key, and lease id into connector child env.
- [ ] 3.2 Update polyfill browser launch resolution so managed lease env wins over per-profile remote-CDP dev overrides.
- [ ] 3.3 Add tests proving a required n.eko run never silently falls back to headless/local launch when no lease is available.

## 4. Persistence And Restart Reconciliation

- [ ] 4.1 Persist enough lease/surface state to recover queued, starting, and leased rows after restart.
- [ ] 4.2 Reconcile persisted leases with active runs and live/static n.eko surfaces on boot.
- [ ] 4.3 Preserve profile volumes/directories while expiring stale leases.
- [ ] 4.4 Add restart tests for active leased run, stale leased run, missing surface, and queued run.

## 5. Operator Surfaces

- [ ] 5.1 Expose waiting/deferred browser-surface status in reference-only run/operator views.
- [ ] 5.2 Add clear copy distinguishing browser-surface resource backpressure from connector auth/protocol failure.
- [ ] 5.3 Emit redacted run timeline or diagnostic events for lease requested, queued, leased, released, deferred, and expired.

## 6. Docker And Follow-Up Boundary

- [ ] 6.1 Keep the first tranche compatible with the current static n.eko Compose overlay.
- [ ] 6.2 Document that static single-surface mode proves queue semantics only and does not claim multi-surface concurrency.
- [ ] 6.3 Record the dynamic multi-container follow-up: per-surface container allocation, per-profile volumes, health checks, warm pool, and idle TTL shutdown.

## 7. Validation

- [ ] 7.1 Run targeted reference runtime/controller tests.
- [ ] 7.2 Run targeted polyfill connector launch tests.
- [ ] 7.3 Run `openspec validate add-neko-browser-surface-leases --strict`.
- [ ] 7.4 Run a Docker n.eko smoke proving cap `N=1` queues a second required run instead of spawning it.

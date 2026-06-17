## 1. Runtime Projection

- [x] Add connection-aware run summary matching for browser profile keys and explicit connection ids.
- [x] Surface browser-surface failure reason evidence for `surface_failed` summaries.
- [x] Reuse connector run pages per connector/status within one summary projection.
- [x] Add a short-lived Postgres single-flight cache for repeated full-list reads.
- [x] Preload retained-size stream/connection projection rows once for the full-list path.
- [x] Add a committed real-browser performance harness with RSC fetch timing and RS/API probes.
- [x] Keep the full connector-summary list shallow for run summaries while retaining deep run summaries on scoped connection/detail reads.
- [x] Add the Postgres source/run spine summary index to bootstrap/migration code.

## 2. Tests

- [x] Add a sibling browser-run regression test for `listConnectorSummaries()`.
- [x] Run targeted connection-summary projection tests.
- [x] Run affected spine/control-plane tests.
- [x] Run reference and console type checks.
- [x] Smoke the browser harness against a known-fast live route without true failed requests.

## 3. Live Verification

- [x] Deploy in a live-stack window.
- [x] Verify `/_ref/connectors` repeated-call latency before/after.
- [x] Verify `/dashboard/runs` real-browser RSC fetch count/timing before/after.
- [x] Verify `/dashboard` and `/dashboard/runs` cold browser document time after retained-size preloading.
- [x] Verify `/dashboard` and `/dashboard/runs` cold browser document time after shallow-list projection.
- [x] Verify Amazon/Chase row state no longer reflects sibling draft-shell run evidence.
- [x] Verify scoped connection detail/diagnostics still exposes deep run evidence after shallow-list projection.

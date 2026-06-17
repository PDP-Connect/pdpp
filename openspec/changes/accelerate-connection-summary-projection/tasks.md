## 1. Runtime Projection

- [x] Add connection-aware run summary matching for browser profile keys and explicit connection ids.
- [x] Surface browser-surface failure reason evidence for `surface_failed` summaries.
- [x] Reuse connector run pages per connector/status within one summary projection.
- [x] Add a short-lived Postgres single-flight cache for repeated full-list reads.

## 2. Tests

- [x] Add a sibling browser-run regression test for `listConnectorSummaries()`.
- [x] Run targeted connection-summary projection tests.
- [x] Run affected spine/control-plane tests.
- [x] Run reference and console type checks.

## 3. Live Verification

- [ ] Deploy in a live-stack window.
- [ ] Verify `/_ref/connectors` repeated-call latency before/after.
- [ ] Verify `/dashboard/runs` real-browser RSC fetch count/timing before/after.
- [ ] Verify Amazon/Chase row state no longer reflects sibling draft-shell run evidence.

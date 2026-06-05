# Tasks — add-provider-budget-run-control

This is a proposal-only lane. No product code is written here. The tasks below
define the implementation work that must follow.

## 1. Spec delta (this lane — proposal only)

- [x] Write `proposal.md` — change rationale, scope, capability targets.
- [x] Write `design.md` — design decisions, tradeoffs, acceptance checks.
- [x] Write `tasks.md` — this file.
- [x] Write `specs/polyfill-runtime/spec.md` — normative requirement deltas.
- [x] `openspec validate add-provider-budget-run-control --strict`.
- [x] `openspec validate --all --strict`.

## 2. Implementation (future lanes)

The following tasks are stubs for implementation lanes. Each should be a
separate lane or tranche with its own acceptance checks.

### 2.1 Per-provider token-bucket pacing

- [ ] Implement a per-provider token bucket in the polyfill-runtime base.
  - [ ] Fill rate and burst depth configurable per connector; unset → conservative default.
  - [ ] AIMD adaptive fill-rate adjustment: additive increase on success,
        multiplicative decrease on 429/503/elevated-latency.
  - [ ] One-way ratchet: error responses may only increase delay, never decrease.
  - [ ] Conservative starting delay before first response signal.
  - [ ] Per-provider isolation: slow or rate-limited provider does not stall other providers.
- [ ] Unit-test the token bucket with an injectable clock (no live provider required).
- [ ] Verify that a run with no budget configured behaves byte-for-byte unchanged.

### 2.2 Retry budget (ratio-based token bucket)

- [ ] Implement a run-scoped retry budget token bucket.
  - [ ] Capacity ≈ 20% of per-run request cap (or a configurable minimum).
  - [ ] Tokens consumed on retry; refilled proportionally to successes.
  - [ ] Full jitter backoff: `sleep = random(0, min(cap, base × 2^attempt))`.
  - [ ] Retry only on 429, 408, 5xx. Non-retryable 4xx logs and skips (no budget consumed).
  - [ ] When bucket empty: defer run as resumable gap with reason not in source-pressure set.
- [ ] Unit-test retry budget exhaustion path.

### 2.3 Circuit breaker integration

- [ ] Integrate a circuit breaker above the retry layer.
  - [ ] Composition order: Request → Retry → Circuit Breaker → Rate Limiter → Timeout → Bulkhead.
  - [ ] Closed → Open on failure-rate threshold over a sliding window.
  - [ ] Open → Half-Open after configurable reset timeout.
  - [ ] Half-Open: probe request; success → Closed; failure → Open.
  - [ ] Minimum-throughput guard: breaker cannot open before a minimum request count.
  - [ ] When Open: propagate error immediately, do not consult retry budget.
- [ ] Expose circuit breaker state transitions to operator health view.
- [ ] Unit-test all three state transitions.

### 2.4 Run budget envelope (request cap + wall-clock deadline)

- [ ] Implement run-scoped request cap and wall-clock deadline.
  - [ ] Default off (unset → no cap; run behavior unchanged).
  - [ ] Wall-clock checked between fetch attempts, never mid-fetch.
  - [ ] On exhaustion: emit resumable gap record; checkpoint reflects last durable write only.
  - [ ] Gap reason is not in source-pressure reason set.
  - [ ] Does not arm source-pressure cooldown governor.
- [ ] Unit-test with injectable clock (request cap trip, wall-clock trip, default-off).

### 2.5 Commit-gated monotonic checkpoint

- [ ] Audit all connectors: checkpoint advancement must follow, not precede, durable write confirmation.
- [ ] Enforce opaque cursor storage: no reconstructed offset cursors in any first-party connector.
- [ ] Add a CI assertion or test that fails when a connector advances its checkpoint before durable write.

### 2.6 Catch-up vs. steady-state separation (where applicable)

- [ ] For connectors with a historical backfill phase, implement separate bookmarks for
      catch-up and steady-state modes.
- [ ] Verify that catch-up runs do not advance the steady-state incremental cursor.
- [ ] Document the mode-switching predicate (when to shift from catch-up windows to
      steady-state incremental).

### 2.7 Operator progress/visibility

- [ ] Expose circuit breaker state (Closed/Open/Half-Open) in the connector health view.
- [ ] Distinguish budget-exhaustion deferrals from source-pressure deferrals in display copy.
- [ ] Ensure run-progress reporting distinguishes: pages fetched this run, pages deferred,
      retry events, circuit breaker state changes.

## 3. Owner closeout

- [ ] Per-provider live calibration: run at least one connector under the new control model
      against a real provider, confirm pacing converges, retry budget is not exhausted on
      a healthy run, and wall-clock/request-cap deferrals do not arm source-pressure cooldown.
- [ ] Archive this change once all §2 implementation tranches land and the per-provider
      calibration is recorded.

## Acceptance Checks (proposal validation)

```sh
openspec validate add-provider-budget-run-control --strict
openspec validate --all --strict
git diff --check
```

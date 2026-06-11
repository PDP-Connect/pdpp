# Tasks — converge-provider-rate-governance

## 1. Spec artifacts

- [x] Write `proposal.md`.
- [x] Write `design.md` (layer doctrine, GCRA disposition, double-pay finding,
      old-change disposition, out-of-scope rationale, acceptance checks).
- [x] Write `tasks.md` (this file).
- [x] Write `specs/polyfill-runtime/spec.md` (single-send-governor doctrine with
      a negative stacking scenario; Retry-After double-pay; retry budget;
      connector migration; budget/source-pressure reason disjointness).
- [x] `openspec validate converge-provider-rate-governance --strict`.
- [x] `openspec validate --all --strict`.

## 2. Send-governor boundary

- [x] Add `SendGovernor` (`src/send-governor.ts`): `acquire()` is the only
      sanctioned pre-flight wait; no two-governor combinator (incorrect
      composition is not expressible).
- [x] Add `SendDelayHint` (`nextDelayMs()`) — a pre-flight delay signal a
      decision layer hands to the single governor instead of sleeping.
- [x] Add `PreflightWaitProbe` — counts non-zero pre-flight wait sources.
- [x] Stacking regression: exactly one pre-flight wait source per request in the
      converged ChatGPT-shaped path (`src/send-governor.test.ts`).
- [x] Stacking detector: prove the probe catches the two-gate anti-pattern
      (legacy preflight mode + lane launch delay reads two waits).

## 3. GCRA demoted to a signal (not retired)

- [x] `ProviderPacing.nextDelayMs()` — pure delay computation that advances GCRA
      state without sleeping; `admit()` becomes `sleep(nextDelayMs())`
      (byte-identical, pacing suite unchanged).
- [x] `ProviderBudgetController.pacingMode` — `"preflight"` (default,
      byte-identical) | `"signal"` (no pre-flight wait; exposes
      `pacingDelayHint()`).
- [x] `AdaptiveLane.launchDelayHint` — folds the pacing delay into the single
      launch wait as `max(launchDelay, cooldown, hint)`, never a sum.

## 4. Retry layer

- [x] Retry-After honor retained in `retryHttp` (server interval slept once).
- [x] Double-pay guard at the new governor call site: a retry feeds the pacing
      bucket the throttle signal only, never the Retry-After override (caught by
      a test that observed a `[7000, 7000]` double wait, then fixed).
- [x] Finagle-style ratio-based retry budget hook (`HttpRetryBudget`) in
      `retryHttp` (opt-in; absent → attempt-count-only, unchanged).
- [x] Shared `createConnectorHttpGovernor` (`src/connector-http-governor.ts`):
      one `SendGovernor` + `retryHttp`, preserving `<name>_rate_limited` terminal.

## 5. Connector migration

- [x] Oura → shared governor (`maxAttempts: 1`, byte-identical throw).
- [x] YNAB → shared governor (integration suite green).
- [x] GitHub → shared governor (403-quota mapped to 429; pagination preserved).
- [x] Strava → shared governor.
- [x] Notion → shared governor.
- [x] Spotify → shared governor.
- [x] Adoption smoke: each migrated connector's terminal matches its
      `retryablePattern`; `maxAttempts: 1` makes exactly one provider call on 429
      (`src/connector-governor-adoption.test.ts`).
- [ ] **OUT OF SCOPE — Reddit**: browser-transport (`page.evaluate`) + injected
      `RedditListingFetch` test seam; rate-limit is a parsed-status branch in
      `paginate`, not a `fetch` call. Deferred (rationale in `design.md`); the
      shared governor is transport-agnostic so a later lane can adopt it.
- [ ] **OUT OF SCOPE — Amazon**: `p-retry` + year-partition cursor-safety state;
      migration risks cursor invariants for low rate-governance gain (its
      null-detail paths are nav/parse failures, not 429s). Deferred per the
      "migrate if low-risk, else document why" instruction.

## 6. ChatGPT convergence (default-off, parity-proven)

- [x] `PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE` flag (default off):
      `resolveChatGptConvergedGovernance`.
- [x] Flag ON → controller `pacingMode: "signal"`, lane gets `launchDelayHint`,
      lane launch window retained (not zeroed).
- [x] Flag OFF (default) → byte-identical (controller-owned pacing wait, lane
      delay zeroed); full chatgpt suite green.
- [x] Parity golden tests (`connectors/chatgpt/convergence-parity.test.ts`):
      same decisions (fetched IDs + coverage), exactly one pre-flight wait
      source, total wait ≥ legacy and < 2× legacy (no stacking).

## 7. Discrimination regression

- [x] Pin that provider-budget defer reasons (`max_requests`, `max_wall_clock`,
      `circuit_open`, `retry_budget`) are disjoint from `SOURCE_PRESSURE_GAP_REASONS`
      (`src/provider-budget-reason-discrimination.test.ts`). The scheduler-side
      discrimination remains pinned by
      `reference-implementation/test/scheduler-source-pressure-cooldown.test.js`.

## 8. Disposition of `add-provider-budget-run-control`

- [x] Mark `add-provider-budget-run-control` superseded by this change (only one
      change carries the `polyfill-runtime` rate deltas to archive).
- [x] Absorb its 8 rate-governance tasks (pacing §2.1, retry budget §2.2,
      circuit breaker §2.3, run budget §2.4, drain loop §2.8, circuit evidence
      §2.7, live calibration §3, archive §3 — already implemented; calibration
      is the one open terminal task below).
- Independent (3, NOT in this lane): checkpoint commit-gating + opaque cursor +
  CI assertion (its §2.5) and catch-up/steady-state bookmark separation (its
  §2.6) — cursor durability, orthogonal to send-velocity governance.
- Straddles (1, NOT in this lane): operator display copy distinguishing
  budget-exhaustion from source-pressure deferrals (its §2.7) lives in
  `apps/console` (forbidden here). The data-layer discrimination it depends on is
  pinned by task 7 above; only the UI copy is deferred.

## 9. Live calibration (owner-gated) — COMPLETE

- [x] **Live ChatGPT calibration of the converged path.**
      Calibration run: `run_1781139968889` (2026-06-11 01:06–01:15 UTC).
      Run with `PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE=1`.
      Results:
      - 14,721 records committed.
      - 86 detail gaps recorded as `rate_limited` / `upstream_pressure`.
      - 170 gaps recovered.
      - Upstream-pressure circuit opened and deferred the tail; run completed
        cleanly (`run.completed`).
      - Zero wait stacking observed.

      EQUIVALENCE AND PRESSURE-SAFETY are proven. The converged path is now the
      only code path; the flag and legacy branch are deleted in this commit.

      **Explicit follow-up (owner-pending, NOT part of this closure):** the
      launch-jitter floor caps AIMD discovery at approximately 19 conversations/
      min. Raising throughput (lowering the jitter floor or tuning the AIMD
      parameters) is a separate owner decision — it was out of scope for this
      closure and is recorded here as an explicit next step, not a gap in the
      calibration result.

## Acceptance Checks

```sh
# In packages/polyfill-connectors:
node --test --test-timeout=30000 --import tsx \
  'src/send-governor.test.ts' 'src/connector-http-governor.test.ts' \
  'src/connector-governor-adoption.test.ts' \
  'src/provider-budget-reason-discrimination.test.ts' \
  'src/provider-budget.test.ts' 'src/provider-pacing.test.ts' \
  'src/run-budget.test.ts' 'src/http-retry.test.ts' 'src/adaptive-lane.test.ts' \
  'connectors/chatgpt/convergence-parity.test.ts'
node --test --test-timeout=60000 --import tsx \
  'connectors/chatgpt/integration.test.ts' 'connectors/chatgpt/cursor.test.ts' \
  'connectors/chatgpt/parsers.test.ts'
npx tsc --noEmit
npx ultracite check <touched files>

# From repo root:
openspec validate converge-provider-rate-governance --strict
openspec validate --all --strict
```

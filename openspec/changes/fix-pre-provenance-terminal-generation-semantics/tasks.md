## 1. Fold Fix A — pre-provenance generation semantics

- [x] 1.1 Replace the terminal-fact generation gate in
      `connector-summary-read-model.ts`: an unstamped event is accepted only
      while the connection has never advanced beyond generation 0; a stamped
      event still requires an exact generation match.
- [x] 1.2 Bump `STREAM_FACTS_FOLD_LOGIC_VERSION` from 3 to 4 so stored
      terminal maps replay under the corrected acceptance rule through the
      existing version-behind self-heal.
- [x] 1.3 Preserve refusal of unattributable events and mismatched non-NULL
      generation stamps; recovery-only fact-less events bypass the fact gate.

## 2. Recovery-decision Fix B — forward-evidence debt bound

- [x] 2.1 Add `forwardEvidenceDebt?: boolean` to
      `RecoveryFirstWorkSelectionInputs`. For implicit, unscoped work, debt
      selects forward collection over eligible non-pressure recovery; explicit
      `requestedRecoveryOnly` and scoped-resource precedence remain unchanged.
- [x] 2.2 Derive the maximum evidence age as
      `max(4 * scheduleIntervalMs, 1h)`. Debt is true when terminal facts are
      not current, have no usable per-stream fact map, or the newest
      `stream_latest_facts[*].evidence_as_of` is older than that bound;
      `terminal_facts.as_of` is only an observation timestamp and is not used
      as evidence age.
- [x] 2.3 Wire the debt probe through the scheduler dispatch governor and
      `scheduler-manager-factory.js`. A debt-true tick selects forward only
      when forward dispatch is otherwise eligible; otherwise independent
      recovery cadence proceeds so the governor cannot produce a do-nothing
      tick. Probe failure fails closed to no debt and logs the error.
- [x] 2.4 Wire the same durable evidence shape through the controller
      `runNow` seam, which has no separate forward-eligibility gate.

## 2A. Read-side Fix C — Collection Report monotonic durable-proof floor

- [x] 2A.1 Add the monotonic durable-proof floor to `resolveEffectiveStreamFacts`
      (`ref-control.ts`): a classifying fact cannot shadow a stored fact that
      proves durable coverage unless the classifying fact also proves it.
- [x] 2A.2 Update the `resolveEffectiveStreamFacts` documentation to describe
      the floor.
- [x] 2A.3 Prove forward progress, the never-proven case, and committed/
      disabled checkpoint parity.

## 2B. Incidental P3 — undefined `considered` denominator normalization

- [x] 2B.1 Normalize `considered: undefined` to `null` in
      `deriveGapFreeStreamCoverageCondition` so an invalid denominator never
      reads as complete; add a direct regression test.

## 3. Tests

- [x] 3.1 Cover generation-0 acceptance and the permanent post-transition
      refusal of unstamped or stale-stamped history in SQLite and Postgres
      backfill/generation tests.
- [x] 3.2 Cover SQLite generation-0 rebuild, post-mutation refusal,
      v3-to-v4 replay, and the pre-provenance fact plus later recovery-only
      straddle shape.
- [x] 3.3 Add `recovery-decision.ts` debt truth-table cases, including
      explicit recovery-only and scoped-run precedence.
- [x] 3.4 Add dispatch-governor evidence-aging, forward-diversion, recovery
      resumption, and forward-ineligible fallback cases.
- [x] 3.5 Run the discriminating SQLite and isolated real-Postgres parity
      lanes, including the official per-file Postgres runner contract.
- [x] 3.6 Add the four Collection Report durable-proof-floor regressions and
      update the prior buggy-shadowing expectations.
- [x] 3.7 Add the direct undefined-`considered` regression.

## 4. Verification

- [x] 4.1 Run focused fold, recovery-decision, governor, wired-probe,
      Collection Report, and generation/backfill tests.
- [x] 4.2 Run reference-implementation and connector typechecks.
- [x] 4.3 Run `openspec validate fix-pre-provenance-terminal-generation-semantics --strict`.
- [x] 4.4 Run `git diff --check`.

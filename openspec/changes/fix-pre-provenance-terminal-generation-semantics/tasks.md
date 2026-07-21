## 1. Fold Fix A — pre-provenance generation semantics

- [ ] 1.1 Replace the fold's generation-match gate in
      `connector-summary-read-model.ts` (`foldTerminalEventFacts`): a NULL
      stamped `manifest_generation` matches iff the connection's current
      durable generation is 0; a non-NULL stamp still requires exact
      equality.
- [ ] 1.2 Bump `STREAM_FACTS_FOLD_LOGIC_VERSION` from 3 to 4 so every stored
      terminal map — including rows currently `current` — replays from
      source under the new acceptance rule via the existing
      version-behind self-heal machinery (`seedFoldState`,
      `rowIsFoldLogicVersionBehind`).
- [ ] 1.3 Confirm unattributable events (no connection identity) and
      mismatched non-NULL stamps remain refused; confirm recovery-only
      (fact-less) events still bypass the gate entirely.

## 2. Recovery-Decision Fix B — forward-evidence-debt bound

- [ ] 2.1 Add `forwardEvidenceDebt?: boolean` to
      `RecoveryFirstWorkSelectionInputs`; `resolveRecoveryFirstMode` returns
      `nonPressureRecoveryEligible && !forwardEvidenceDebt` in the
      implicit-unscoped branch. Explicit `requestedRecoveryOnly` and
      `scopedToResources` precedence unchanged.
- [ ] 2.2 Add `FORWARD_EVIDENCE_MAX_AGE` derivation
      (`max(4 * scheduleIntervalMs, 1h)`) and a pure debt predicate over a
      connection's terminal-facts evidence component (`state !== 'current'`
      OR `as_of` older than the bound).
- [ ] 2.3 Thread the debt input through the scheduler seam
      (`dispatch-governor.ts` `evaluateBackoffDispatch`) via a new injected
      probe, wired in `scheduler-manager-factory.js`.
- [ ] 2.4 Thread the debt input through the controller seam
      (`resolveEffectiveRecoveryOnly` in `controller.ts`), reading the same
      evidence the scheduler probe reads.

## 3. Tests

- [ ] 3.1 Flip the two pinned "keeps pre-generation terminal facts
      historical" assertions in
      `test/spine-events-connector-instance-id-backfill.test.js` (SQLite +
      Postgres) to assert `current` for the generation-0 case; add a
      post-transition case (mutate the manifest to advance generation, then
      confirm both NULL and stale-stamped history stay refused). The
      cross-connection non-attribution case stays passing unchanged.
- [ ] 3.2 Split
      `test/reconcile-active-summary-evidence-oracle.test.js`'s
      "SQLite rebuild refuses pre-generation terminal facts and accepts a
      post-mutation terminal" into a gen-0-accepts case and a
      post-mutation-refuses case; re-point the v2-invalidation test at
      v3->v4; add the live-shape straddle case (pre-provenance fact event +
      later stamped recovery-only fact-less events -> facts current, sourced
      from the pre-provenance run).
- [ ] 3.3 Add `recovery-decision.ts` unit cases: `forwardEvidenceDebt` truth
      table (false -> unchanged; true + eligible recovery -> forward;
      explicit `recoveryOnly` and scoped runs unaffected by debt).
- [ ] 3.4 Add a dispatch-governor case: N consecutive recovery-only ticks
      with aged terminal evidence -> next tick dispatches forward
      (`recoveryOnly: false`); dispatches recovery again once fresh evidence
      lands.
- [ ] 3.5 Run both-backend parity lanes for 3.1/3.2 against the dedicated
      Postgres test database.

## 4. Verification

- [ ] 4.1 Run the focused test files touched above plus any file importing
      `resolveRecoveryFirstMode`/`foldTerminalEventFacts` transitively.
- [ ] 4.2 Typecheck and lint the touched files.
- [ ] 4.3 `openspec validate fix-pre-provenance-terminal-generation-semantics
      --strict`.
- [ ] 4.4 `git diff --check` (no whitespace errors).

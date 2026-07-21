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

## 2A. Read-side Fix C — Collection Report monotonic durable-proof floor

- [x] 2A.1 Add the monotonic durable-proof floor to `resolveEffectiveStreamFacts`
      (`ref-control.ts`): a classifying run's own fact for a stream may
      shadow the durable latest-attempt store's fact for that stream unless
      the stored fact proves durable coverage
      (`checkpointProvesStreamCoverage`) and the classifying fact does not —
      in that case keep the stored fact and its own provenance
      (`evidence_as_of`, `run_id`). Reuse the existing
      `checkpointProvesStreamCoverage` boundary; do not invent a new
      predicate.
- [x] 2A.2 Update the misleading doc comment above
      `resolveEffectiveStreamFacts` ("The classifying run wins for streams
      it attempted") to describe the floor.
- [x] 2A.3 Confirm a newer classifying fact that itself proves durable
      coverage still replaces the stored fact (forward progress unaffected),
      and a stream with no durably-proven stored fact is unaffected by the
      floor (never-proven streams keep surfacing their newest attempt).

## 2B. Incidental P3 — undefined `considered` denominator normalization

- [x] 2B.1 `deriveGapFreeStreamCoverageCondition`
      (`connector-coverage-policy.ts`) treats `considered: undefined` as a
      known denominator (`undefined !== null`), which can read a
      zero-collected fact as `complete`. Unreachable via the typed read path
      (`readRuntimeCollectionFact` always normalizes to `number | null`) but
      worth a one-line defensive `?? null` normalization at the top of the
      function, with a direct unit test that bypasses the type contract to
      exercise it.

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
- [x] 3.6 `test/collection-report-projection.test.js`: add the four
      discriminating cases for the read-side floor — (a) the exact
      failed-preprogress ChatGPT shape (classifying `not_staged` shadowing a
      stored `committed` fact -> `complete`, stored provenance kept); (b)
      forward progress (a newer classifying fact that itself proves durable
      coverage still replaces the stored fact); (c) never-proven stream (an
      unresolved classifying attempt still replaces an unresolved stored
      fact — the floor is not a green-wash); (d) proof-predicate parity (a
      stored `disabled` checkpoint proves durable coverage exactly like
      `committed` at this third site, mirroring the store-layer fold guard
      and `checkpointProvesCoverage`). Update the two pre-existing tests
      that pinned the pre-fix shadowing behavior
      ("an attempted-but-unresolved classifying fact ..." and "a
      non-recovery-only classifying run still fully replaces the stored
      fact ...") to assert the corrected floor behavior instead.
- [x] 3.7 `test/connector-coverage-policy.test.js`: add a direct case for
      2B.1 — an `undefined` (not `null`) `considered` denominator still
      reads `unknown`, never `complete`.

## 4. Verification

- [ ] 4.1 Run the focused test files touched above plus any file importing
      `resolveRecoveryFirstMode`/`foldTerminalEventFacts` transitively.
- [ ] 4.2 Typecheck and lint the touched files.
- [ ] 4.3 `openspec validate fix-pre-provenance-terminal-generation-semantics
      --strict`.
- [ ] 4.4 `git diff --check` (no whitespace errors).

# Tasks: Connector Progress Evidence Contract

## 1. Spec (this change)

- [x] 1.1 Add `reference-implementation-architecture` requirement: per-run,
  per-stream Collection Report derived by the runtime from existing signals.
- [x] 1.2 Add requirement: per-stream forward disposition
  (`complete | resumable | awaiting_owner | owner_refresh_due | terminal`).
- [x] 1.3 Add requirement: absence of a `considered` denominator is `unknown`,
  never inferred `complete` (and never an inferred-`complete` disposition).
- [x] 1.4 Add requirement: report is a reference-only projection; reuses but does
  not promote `DETAIL_GAP` / `DETAIL_COVERAGE`; secret-redacted and bounded.
- [x] 1.6 Close the manual-refresh freshness seam in the disposition: coverage
  completeness and freshness stay distinct axes; a complete-coverage,
  manual-refresh-stale stream is `owner_refresh_due` (not `complete`, not
  `awaiting_owner`); a retryable gap stays visible even when stale; a schedulable
  stale stream is not `owner_refresh_due`. Add the four seam scenarios.
- [x] 1.5 `openspec validate define-connector-progress-evidence-contract --strict`.

## 2. Smallest safe runtime tranche (additive only)

- [ ] 2.1 Accept an optional connector-declared `considered` count on
  `DETAIL_COVERAGE` and inside `SKIP_RESULT.diagnostics`; bound and redact it on
  the same path as existing diagnostics. No existing field changes.
- [ ] 2.2 In `buildRunTerminalData()`, derive a per-stream Collection Report block
  (`considered` axis, `collected`, coverage condition, checkpoint status,
  `forward_disposition`) from `RECORD` counts, `SKIP_RESULT`, `DETAIL_GAP` /
  `DETAIL_COVERAGE`, committed `STATE`, open attention evidence, and the
  connection's freshness axis + refresh-policy evidence
  (`connection-health.ts` `FreshnessAxis` / `isManualRefreshOnly`). Attach to the
  terminal event payload alongside the existing `known_gaps` block.
- [x] 2.3 Forward-disposition derivation is a pure function of (coverage
  condition, gap retryability, attention presence, freshness axis, refresh policy).
  Unit-test all five branches, including `owner_refresh_due` for manual-refresh
  stale and the schedulable-stale negative case. Gaps are evaluated before
  freshness so a retryable gap is never masked by staleness.
  Landed as `deriveForwardDisposition()` + `ForwardDisposition` /
  `ForwardDispositionInput` in `reference-implementation/runtime/connection-health.ts`,
  reusing the existing `CoverageAxis` / `FreshnessAxis` vocabulary and
  `isManualRefreshOnly()`. Covers all five dispositions (`complete`,
  `owner_refresh_due`, `resumable`, `awaiting_owner`, `terminal`) plus the
  unknown-denominator (`unknown` coverage is never `complete`), schedulable-stale
  negative, and gap-before-freshness cases in
  `reference-implementation/test/forward-disposition.test.js` (25 cases). Pure +
  additive: no terminal-event wiring yet (that is 2.2), so no existing field,
  status code, or commit semantic changed.
- [ ] 2.4 `considered: unknown` when no connector-declared value exists; prove a
  collected-records, no-gaps, no-considered run is NOT projected `complete`.
- [ ] 2.5 Prove the report is absent from grant-scoped `/v1` reads (records,
  search, schema, blobs).
- [ ] 2.6 Prove a portable `RECORD`/`STATE`/`DONE`-only connector still yields a
  valid report with `unknown` axes.
- [ ] 2.7 Run the reference-implementation runtime test suite; confirm no existing
  terminal-event field, status code, or commit semantic changed.

## 3. Validation

- [ ] 3.1 `openspec validate --all --strict`.
- [ ] 3.2 Confirm composition with `derive-local-collector-coverage-from-diagnostics`
  and `add-local-device-collection-verdict`: the Collection Report is the per-run
  source those projections consume; no axis is redefined.

## 4. Follow-up lanes (NOT this change — sequenced for green-page value)

- [ ] 4.1 Connector honesty lane: GitHub declares a `considered` value (issues /
  repos / starred inventory) so partial-vs-complete is real, not gap-only.
- [ ] 4.2 Connector honesty lane: Slack declares considered for collected streams
  and a `terminal` disposition for its known unsupported streams.
- [ ] 4.3 Dashboard consumes per-stream report + forward disposition directly;
  deprecate per-connector freshness/gap reconstruction heuristics.

## Notes

- Tranche 2 is the only code in this change and is strictly additive. If 2.1–2.7
  cannot all land green, ship the spec (section 1) and record tranche 2 as the
  next implementation lane rather than landing a partial runtime change.
- Tranche-2 increment landed so far: 2.3 only — the pure `deriveForwardDisposition`
  helper and its tests. This is the safest possible slice of tranche 2: it adds a
  new exported pure function plus unit tests and emits nothing new on any spine
  event, so it cannot perturb an existing terminal-event field, status code, or
  commit semantic (the 2.7 invariant). It de-risks the wiring lane by proving the
  disposition logic in isolation. The remaining tranche-2 tasks (2.1 considered
  input, 2.2 `buildRunTerminalData()` Collection Report block consuming this helper,
  2.4–2.7 honesty/absence/portability proofs) are the next implementation lane.
- The detail-gap reference-only constraint is preserved: this change reuses
  `DETAIL_GAP` / `DETAIL_COVERAGE` but does not promote them to portable protocol.

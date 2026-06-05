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

- [x] 2.1 Accept an optional connector-declared `considered` count on
  `DETAIL_COVERAGE` and inside `SKIP_RESULT.diagnostics`; bound and redact it on
  the same path as existing diagnostics. No existing field changes.
  Landed in `reference-implementation/runtime/index.js`: a shared
  `boundConsideredCount()` normalizes the value to a trusted safe non-negative
  integer or to `null` (= `unknown`, field omitted). The precision bound is
  JavaScript's native `Number.isSafeInteger` boundary, not a product-specific
  stream-size cap. `DETAIL_COVERAGE.considered` is normalized at emission and
  added as an optional `considered` on the existing `run.detail_coverage_declared`
  spine event (no existing field changed). `SKIP_RESULT.diagnostics.considered`
  rides the existing `boundGapDiagnostics` redaction/bounding path and is then
  re-validated by `normalizeConsideredInDiagnostics()` so a malformed/unsafe value
  is dropped while sibling diagnostics keys survive — flowing through to the `run.stream_skipped`
  spine event and the terminal `known_gaps[].diagnostics`. Drop-don't-reject (mirrors
  the non-object-diagnostics posture): a malformed `considered` never fails the run and
  never fabricates a denominator; absence stays `unknown` (never inferred from
  collected). Strictly additive: no `collection_report` / `coverage_axis` /
  `forward_disposition` is emitted on terminal events. Tests:
  `reference-implementation/test/collection-profile.test.js` adds seven focused cases
  (valid preserve, malformed/unsafe drop, 0-and-max-safe boundary, absence-stays-
  unknown for DETAIL_COVERAGE; valid preserve and malformed-drop for
  SKIP_RESULT.diagnostics; and a 2.7 layer-boundary guard asserting no
  collection_report/coverage_axis/forward_disposition appears on `run.completed`).
  NOTE: "redact" in this task is exercised only for `SKIP_RESULT.diagnostics`
  (free-text path); `DETAIL_COVERAGE.considered` is a pure integer with no string to
  redact, so it is bounded-only — no spec wording change needed.
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
- [x] 2.3a Wire the pure disposition helper into its first consumer at the
  connection level: surface a `forward_disposition` field on
  `ConnectionHealthSnapshot`, derived inside `computeConnectionHealth()` from the
  evidence it already holds (coverage axis -> `gapRetryable`, the `AttentionClear`
  condition -> `attentionOpen`, freshness axis, refresh policy). This is the
  smallest valuable wiring after 2.3: it makes the previously-unconsumed
  `deriveForwardDisposition()` live on the owner-facing health projection that
  `ref-control.listConnectorSummaries` already returns, and answers the dashboard
  question "what is the next run expected to do on this connection?" without a new
  ledger, a protocol change, or a per-run terminal-event field. The disposition
  reads attention from the SAME condition the headline does, so it never disagrees
  with the `needs_attention` pill (attention-blocked gap -> `awaiting_owner`).
  Landed via a new private `deriveConnectionForwardDisposition()` + additive
  `forward_disposition` on the snapshot in
  `reference-implementation/runtime/connection-health.ts`, with
  `reference-implementation/test/connection-forward-disposition.test.js` (12 cases)
  proving the input mapping, the manual-refresh seam end to end, the
  gap-before-freshness ordering, the headline/disposition consistency, the
  expired-attention negative case, and that an unknown denominator is never
  projected `complete`. Strictly additive: 79/79 + 41/41 existing connection-health
  tests stay green, RI typecheck clean, the `connection_health` summary is an
  internal server type (not a contract schema with `additionalProperties: false`),
  and the `OwnerConnectionDiagnostics` contract surface is untouched. NOTE: this
  is the disposition CONSUMER at connection granularity, not the full per-run
  per-stream Collection Report block (still 2.2). See the v1 report for why 2.2 is
  not yet objectively narrow (the runtime `index.js` terminal builder has no
  access to freshness / refresh-policy evidence — that lives in the
  connection-health projection downstream — so the full per-stream block would
  require a layering change beyond this tranche).
- [x] 2.3b Make the connection-level `forward_disposition` visible to the owner
  in the console — the smallest valuable surface after 2.3a, which surfaced the
  field on the snapshot but left it unrendered. No new server contract was
  needed: `listConnectorSummaries` already returns the full `connection_health`
  snapshot and `GET /_ref/connectors` passes it through verbatim
  (`ref-connectors-list` carries `connection_health: unknown`), so the field is
  already on the wire. The console (a) mirrors the field as an optional
  `forward_disposition?: RefForwardDisposition` on `RefConnectionHealthSnapshot`
  + a `RefForwardDisposition` union in `apps/console/.../lib/ref-client.ts`;
  (b) adds a pure `formatForwardDisposition()` + `ForwardDispositionSummary` to
  `apps/console/.../lib/connection-evidence.ts` mapping each disposition to
  connector-agnostic, protocol-accurate copy and a tone (no hosted-service
  promise, no connector name); (c) renders one short "Next run: <disposition>
  (needs you)" line in the diagnostics "Projected state" block
  (`connection-diagnostics.tsx`), inside the already-collapsed diagnostics
  `<details>` so it adds no headline-row noise. It answers "what is the next run
  expected to do?" as a forward statement distinct from the coverage / freshness
  / outbox / attention axis chips (current state) and the headline pill. The
  field is optional on the mirror, so a reference predating it renders nothing
  rather than an invented disposition; an unrecognized value is surfaced
  honestly as neutral. Tests: `apps/console/.../lib/forward-disposition.test.ts`
  (10 cases — five-disposition mapping, complete-only-success honesty,
  owner-action set, aged-vs-missing seam copy, unknown-value honesty, and a
  voice-and-framing guard rejecting hosted-service / connector-name copy) and a
  new structural assertion in `connection-diagnostics.test.ts` pinning the
  shared-formatter wiring + absence guard. The narrow `OwnerConnectionDiagnostics`
  REST/owner-agent projection is intentionally NOT widened here — that picked
  field set is a separately-reviewable owner-agent contract change and is not
  needed for the dashboard surface. Strictly additive: RI untouched; console
  typecheck clean, 271/271 dashboard-lib + 27/27 diagnostics tests green.
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
- Tranche-2 increments landed so far: 2.3 (the pure `deriveForwardDisposition`
  helper and its tests), 2.3a (wiring that helper into `computeConnectionHealth`
  so a connection-level `forward_disposition` is surfaced on the health snapshot),
  and 2.3b (rendering that connection-level disposition in the console so the
  owner can actually see it). All three are strictly additive and emit nothing new
  on any spine event, so none perturbs an existing terminal-event field, status
  code, or commit semantic (the 2.7 invariant): 2.3 adds a pure function + unit
  tests; 2.3a adds one optional snapshot field consumed only by the internal
  `ConnectorSummary` server type, not by any `additionalProperties: false` contract
  schema; 2.3b adds a console-only formatter + one diagnostics line, reading the
  field already passed through `GET /_ref/connectors` — no new server contract.
  2.3a + 2.3b together deliver the first real, owner-VISIBLE dashboard value — the
  "what will the next run do?" answer rendered on the connection detail page —
  while staying inside the existing health projection and surface. The
  remaining tranche-2 tasks (2.1 considered input; 2.2 the per-run, per-stream
  `buildRunTerminalData()` Collection Report block; 2.4–2.7 honesty / absence /
  portability proofs) are the next implementation lane. 2.2 specifically is NOT yet
  objectively narrow: the runtime `index.js` terminal builder has no access to the
  freshness / refresh-policy evidence the per-stream `forward_disposition` needs
  (that evidence is assembled downstream in `ref-control` for the connection-health
  projection), so a faithful per-stream block requires either threading
  connection-health evidence into the runtime or deriving the per-stream
  disposition in the projection layer — a layering decision for the owner, not a
  mechanical wiring step.
- The detail-gap reference-only constraint is preserved: this change reuses
  `DETAIL_GAP` / `DETAIL_COVERAGE` but does not promote them to portable protocol.

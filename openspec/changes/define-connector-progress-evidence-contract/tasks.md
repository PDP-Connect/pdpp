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
- [x] 2.2a (Tranche B — runtime facts half) In `buildRunTerminalData()`, attach a
  per-stream runtime collection-fact block to the terminal event payload alongside
  the existing `known_gaps` block, carrying only objective run-local facts:
  per-stream `collected` count (track per-stream emitted in the run loop; today only
  aggregate `totalEmitted` exists), `considered` value or `unknown`, committed
  checkpoint status (from `committedStateStreams` / `newState`), `SKIP_RESULT`
  reason, and pending-`DETAIL_GAP` count. Compose from `RECORD` counts,
  `SKIP_RESULT`, `DETAIL_GAP` / `DETAIL_COVERAGE`, and committed `STATE`. Do NOT
  stamp a coverage condition or `forward_disposition` on the terminal event — the
  per-connector run subprocess has no freshness, refresh-policy, attention, or
  cross-stream rollup evidence (that lives downstream in the connection-health
  projection). Strictly additive; same redaction/bounding policy as
  `SKIP_RESULT.diagnostics`. Pin the layer boundary with a golden-payload
  regression so no existing terminal-event field, status code, or commit semantic
  changes (2.7 invariant).
  Landed in `reference-implementation/runtime/index.js`: a new pure
  `buildCollectionFacts({...})` returns `{ reference_only: true, schema_version: 1,
  streams: [...] }`, attached as an additive `collection_facts` block in
  `buildRunTerminalData()` (so it rides all three terminal events: `run.completed`,
  `run.failed`, `run.cancelled`). The block is named `collection_facts` to keep it
  distinct from the projection-derived `collection_report` the spec reserves for the
  control-plane layer (Tranche C). Two small run-local additions feed it: a
  per-stream `emittedByStream` Map (seeded to 0 for every in-scope stream, so a
  zero-record stream is an honest `collected: 0` entry, incremented next to
  `totalEmitted++` in the RECORD case), and a retained normalized `considered` on
  each `trackDetailCoverage()` entry. Per entry: `collected` (raw per-stream emitted
  count), `considered` (declared `DETAIL_COVERAGE.considered` > `required_keys.length`
  > OMITTED = `unknown`; never inferred from collected), `checkpoint`
  (`committed | not_committed | not_staged | disabled`, mapped `stream → state_stream`
  so list+detail checkpoints resolve correctly), `pending_detail_gaps` (count of
  pending durable detail gaps by stream — locators stay in the existing `detail_gaps`
  block, not restated), and `skipped` (`{ reason, recovery_action }` from the
  `SKIP_RESULT` known-gap, or `null`). NO `coverage` / `coverage_axis` /
  `forward_disposition` / `freshness` / `refresh` key on the block or any entry.
  Tests: `reference-implementation/test/collection-profile.test.js` adds nine focused
  cases (sharpened layer-boundary golden guard asserting `collection_facts` present
  facts-only with no derived axis on block OR entry and `collection_report` still
  absent; one-entry-per-in-scope-stream; zero-record honest `collected:0`; skip fact
  with no verdict; pending-detail-gap by count; considered honesty incl.
  never-equals-collected; declared-vs-required_keys priority; required_keys fallback;
  RECORD/STATE/DONE-only portability floor; and the 2.7 no-field-perturbed golden
  regression). 116/116 collection-profile + 46/46 event-spine + 5/5
  ref-run-timeline-terminal-status green; RI `tsc --noEmit` exit 0.
- [x] 2.2b (Tranche C — control-plane projection half) In
  `reference-implementation/server/ref-control.ts`, key the existing coverage
  rollup (`mapCoverageAxis`) and the already-tested pure
  `deriveForwardDisposition()` per stream: read the runtime collection-fact block
  (and the per-stream `run.detail_coverage_declared` / `run.stream_skipped` spine
  evidence) plus the freshness axis, manifest refresh policy, and open attention
  evidence that layer already assembles, and derive each Collection Report entry's
  coverage condition and `forward_disposition`. Surface on the owner/control-plane
  projection only; derive on read (never frozen at run completion). This extends the
  connection-level `forward_disposition` (2.3a/2.3b) from connection scope to stream
  scope using the same pure helper.
  Landed in `reference-implementation/server/ref-control.ts`: `extractKnownGapsForRun`
  generalized to a shared `readRunTerminalEventData()` so `known_gaps` and the new
  `collection_facts` block ride ONE terminal-event read; `readCollectionFactsFromTerminalData()`
  parses the block defensively (a malformed/out-of-bounds `considered` re-reads to
  `null` = `unknown`, never a fabricated denominator) and attaches it as an optional
  `collection_facts` on `ConnectorRunSummary`. A new pure, exported
  `buildCollectionReport({collectionFacts, manifestStreams, freshness, attentionOpen,
  refresh})` derives one `CollectionReportEntry` per in-scope stream (manifest streams
  ∪ fact streams) with `{stream, collected, considered|"unknown", checkpoint,
  pending_detail_gaps, skipped, coverage_condition, forward_disposition}`. The
  per-stream coverage gate (`deriveStreamCoverageCondition`) is the load-bearing new
  logic: precedence is contradictory-manifest accepted axis → skip (manifest accepted
  axis, else skip-derived non-`complete` axis) → pending detail gap (`retryable_gap`)
  → known considered (`partial` if short, else accepted/`complete`) → UNKNOWN
  CONSIDERED ⇒ accepted/`unknown` (NEVER `complete`). `forward_disposition` reuses the
  already-live pure `deriveForwardDisposition()` verbatim (no forked taxonomy); the
  `unknown` → `resumable` honesty back-stop is unchanged. Derived on read at the two
  assembly points (`listConnectorSummaries` + `getConnectorDetail`) via a shared
  `projectCollectionReport()` that reads `freshness`/`attentionOpen` from the SAME
  `connection_health` snapshot the headline uses (`axes.freshness`, `axes.attention !==
  "none"`) so a stream entry never disagrees with the connection-level disposition or
  the `needs_attention` pill. Attached as additive `collection_report` on
  `ConnectorSummary` and `ConnectorDetail`; both routes forward it opaquely (no
  `additionalProperties:false` contract schema covers these internal projections — the
  2.3a/2.3b passthrough precedent), so NO new server contract and NO `/v1` exposure.
  The runtime (`index.js` / `buildRunTerminalData`) is byte-untouched — the 2.7
  invariant holds; this lane adds zero fields to the terminal event. Tests:
  `reference-implementation/test/collection-report-projection.test.js` (24 pure
  cases over `buildCollectionReport` — the 2.4 honesty gate, considered satisfied/short,
  the five skip→coverage mappings, detail-gap precedence, the manual-refresh seam at
  stream scope, attention, the 2.6 portability floor, manifest accepted-coverage, and
  the three absence tolerances) and
  `reference-implementation/test/collection-report-projection-e2e.test.js` (5 e2e cases
  driving a real `runConnector` run then reading `GET /_ref/connectors/:id` — 2.2b
  two-stream, 2.4 honesty end-to-end, 2.6 portable, 2.5 `/v1` isolation negative,
  derive-on-read). 24/24 + 5/5 green; 117/117 collection-profile + 79/79
  connection-health + 41/41 acceptance regression green; RI `tsc --noEmit` exit 0.
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
- [x] 2.4 (with Tranche C) Runtime collection-fact block records `considered:
  unknown` when no connector-declared value exists (the runtime never infers it from
  collected count); prove the projection does NOT derive `complete` for a
  collected-records, no-gaps, no-considered run (the pure helper already returns
  `resumable` for `unknown` coverage — pin it end-to-end through the per-stream
  path).
  Pinned both at unit scope (`collection-report-projection.test.js`: a fact entry
  with `collected > 0`, no gaps, `considered` absent → `coverage_condition ===
  "unknown"` and `forward_disposition === "resumable"`, NOT `complete`) and
  end-to-end (`collection-report-projection-e2e.test.js` "2.4": a real run that
  collected one record with no declared considered, read back through
  `GET /_ref/connectors/:id`, asserts the `items` entry is `unknown`/`resumable`
  and explicitly `!== "complete"` on both axes). The per-stream coverage gate
  feeds the pure helper `unknown`, and the helper's back-stop refuses `complete`
  on `unknown` coverage — both guards proven.
- [x] 2.5 (with Tranche C) Prove neither the runtime collection-fact block nor the
  projection-derived Collection Report appears in grant-scoped `/v1` reads (records,
  search, schema, blobs).
  Proven by construction + regression: `collection_report` / `collection_facts`
  live only on the owner-surface `ConnectorSummary` / `ConnectorDetail` types
  (`ref-control.ts`), never on any `/v1` route. `collection-report-projection-e2e.test.js`
  "2.5" first asserts the OWNER detail surface DOES carry the report (so the
  negative is non-vacuous), then reads grant-scoped `/v1/streams/.../records`
  (×2 shapes), `/v1/schema`, and `/v1/streams` with the bearer token and asserts
  the raw response body contains NEITHER the substring `collection_report` NOR
  `collection_facts`, and that no report identifier is returned.
- [x] 2.6 (with Tranche C) Prove a portable `RECORD`/`STATE`/`DONE`-only connector
  still yields a valid Collection Report with `unknown` axes.
  Proven at unit scope (a `collected > 0`, no-considered, no-gap, no-skip entry →
  `considered: "unknown"`, `coverage_condition: "unknown"`, `forward_disposition:
  "resumable"`, checkpoint preserved) and end-to-end
  (`collection-report-projection-e2e.test.js` "2.6": a manifest emitting only
  `RECORD`/`STATE`/`DONE` run through `runConnector`, read back through the detail
  route, yields a VALID report entry with `unknown` axes — not an error, not
  `complete`).
- [x] 2.7 (with Tranche B) Run the reference-implementation runtime test suite;
  confirm no existing terminal-event field, status code, or commit semantic changed
  by the runtime collection-fact block.
  A golden-payload regression in `collection-profile.test.js` asserts a
  representative success run keeps every pre-existing terminal field
  (`records_emitted`, `records_flushed`, `buffered_records_dropped`, `persist_state`,
  `checkpoint_mode`, `checkpoint_commit_status`, `state_streams_staged`,
  `state_streams_committed`, and the conditional `known_gaps` / `detail_gaps` blocks)
  with its prior presence/shape, the only addition being `collection_facts`.
  Confirmed against 116/116 collection-profile + 46/46 event-spine + 5/5
  ref-run-timeline-terminal-status, all green; the block is strictly additive (a
  conditional spread) and no status code or commit semantic was touched.

## 3. Validation

- [x] 3.1 `openspec validate --all --strict`.
  `openspec validate define-connector-progress-evidence-contract --strict` passes
  ("is valid") and `openspec validate --all --strict` reports 40 passed / 0 failed.
  Tranche C is code-only in `ref-control.ts` + tests; no spec artifact text changed,
  so the contract stays valid.
- [x] 3.2 Confirm composition with `derive-local-collector-coverage-from-diagnostics`
  and `add-local-device-collection-verdict`: the Collection Report is the per-run
  source those projections consume; no axis is redefined.
  Confirmed: `buildCollectionReport` reuses the existing `CoverageAxis` /
  `FreshnessAxis` vocabulary and the pure `deriveForwardDisposition()` verbatim — it
  introduces NO new coverage taxonomy. The local-collector coverage path
  (`buildCoverageEvidence` → `deriveLocalCoverageAxis`) and the local-device
  collection verdict (`localDeviceCollection` in `projectConnectorSummaryConnectionHealth`)
  are untouched; the per-stream report is an additive read over the same axes, so no
  axis is redefined and the local-collector projections still consume the same
  vocabulary.

## 4. Follow-up lanes (NOT this change — sequenced for green-page value)

- [x] 4.1 Connector honesty lane: GitHub declares a `considered` value (issues /
  repos / starred inventory) so partial-vs-complete is real, not gap-only.
  Mechanism: a list stream with no detail-hydration phase declares its enumerated
  inventory by emitting a DETAIL_COVERAGE for the list stream itself
  (`state_stream === stream`) with EMPTY `required_keys`/`hydrated_keys` and an
  explicit `considered` (the optional count accepted in 2.1). Empty key arrays
  mean `assertDetailCoverageSatisfiedBeforeCommit` has nothing to mark missing
  (the committed STATE still commits) and the terminal collection-fact block
  reads `considered` via `declaredConsideredForStream`. The SDK
  `buildDetailCoverageMessage`/`DetailCoverageParams` gained an optional
  `considered` (dropped at the builder unless a non-negative integer); the
  protocol `DetailCoverageMessage` gained the optional field. `considered` is the
  count enumerated from the source within the run's boundary (`totalSeen` /
  `fetched`), measured at the pagination site — NEVER aliased to the emitted
  count — so `collected < considered` (an `until` filter, a dropped malformed
  starred entry) reads a real `partial`. Streams wired: `repositories`,
  `starred`, `issues`, `gists`, and `pull_requests` (the last only when no search
  window was cap-truncated, so an unknowable inventory stays `unknown` and relies
  on its existing `pr_search_cap_truncated` terminal gap). No runtime contract
  change — the runtime already accepts `DETAIL_COVERAGE.considered`. Proven by a
  runtime integration test (list-level coverage carries the denominator without
  blocking commit) plus connector unit tests for each stream's honest count.
- [x] 4.2 Connector honesty lane: Slack declares considered for collected streams
  and a `terminal` disposition for its known unsupported streams.
  Mechanism (no runtime contract change — same as 4.1): the connector emits a
  self-coverage `DETAIL_COVERAGE` (`state_stream === stream`, EMPTY
  `required_keys`/`hydrated_keys`) carrying an explicit `considered` measured at
  the enumeration site, never aliased to the emitted count. Wired stream:
  `canvases` ONLY. It is the one Slack stream where `considered` is objectively
  honest — it full-syncs every run (NOT in `FINGERPRINTED_STREAMS`, so unchanged
  records are never suppressed) and every enumerated `MODE='quip'` row is emitted
  unconditionally, so `collected` equals the deduped quip inventory
  (`canvasRows.length`) rather than a churn-reduced subset. `collected ===
  considered` reads a real `complete`; a canvas weighed but dropped (e.g. by
  record-shape validation) reads an honest `partial`. The connector gained a
  narrow `emit` side-channel on `StreamDeps` (typed to the single
  `DETAIL_COVERAGE` kind) and a `declareListConsidered` helper mirroring GitHub's.
  Streams DELIBERATELY NOT wired, each because declaring `considered` would
  FABRICATE a false coverage verdict (the precise blocker the GitHub precedent
  warns against): `workspace` / `users` / `files` / `channels` /
  `channel_memberships` suppress unchanged records via `emitWithFingerprint`, so
  on any incremental run `collected` ≪ the enumerated row count — declaring the
  row count would read a FALSE `partial` of a run that fully covered the source;
  `messages` is incrementally windowed by `WHERE TS > last_ts` and has a
  documented cursor-finality gap (thread replies on pre-cursor parents are never
  enumerated), so `considered === collected` would assert a FALSE `complete` for a
  boundary the run structurally cannot see in full (the GitHub
  `pr_search_cap_truncated` "unknowable inventory → leave unknown" rule);
  `reactions` / `message_attachments` are co-emitted per parent with no own
  enumeration site; `channel_stats` is an append-keyed daily observation, not an
  inventory. The `terminal` disposition for the four unsupported streams
  (`stars` / `user_groups` / `reminders` / `dm_read_states`) needs NO new code:
  they already emit `SKIP_RESULT { reason: "not_available" }`, which the shipped
  Tranche-C projection maps `not_available` → `unavailable` coverage →
  `terminal` forward disposition by construction. Proven by Slack connector unit
  tests (`connectors/slack/canvases-considered.test.ts`: 4 cases — honest
  enumerated denominator, quip-only filtering not the whole FILE table, empty
  inventory declares `considered: 0`, coverage emitted after the last RECORD)
  plus projection tests (`reference-implementation/test/slack-collection-report.test.js`:
  6 cases — canvases `complete`/`partial`/empty, non-canvas streams stay
  `unknown`/`resumable` when undeclared, unsupported `not_available` →
  `terminal`, and a mixed-connection shape). The runtime half (a list-level
  `DETAIL_COVERAGE.considered` carried to the terminal facts block without
  blocking commit) is already proven connector-agnostically by 4.1's
  `collection-profile.test.js` integration case. slack 68/68 + github 27/27 + SDK
  runtime 46/46 + collection-report-projection 30/30; RI + polyfill-connectors
  `tsc --noEmit` exit 0; biome clean on changed files.
- [x] 4.4 Steady-state semantics: an optional `covered` denominator unblocks
  `considered` for fingerprint-suppressed full-sync list streams.
  Problem: the per-stream coverage gate compares `considered` (pre-suppression
  enumerated count) against `collected` (post-fingerprint emitted count), so a
  full-sync stream that re-enumerates its whole boundary and suppresses the
  unchanged records reads a FALSE `partial` on a steady-state run (`collected: 0`,
  `considered: N`). This is exactly why tasks 4.1/4.2 held back `considered` on
  every fingerprint-suppressed stream (Slack `workspace`/`users`/`files`/
  `channels`/`channel_memberships`, and the YNAB/Chase/USAA full-sync streams):
  declaring the enumerated count would have false-partialed a fully-covered run.
  Mechanism (additive, no existing field changed): a new optional `covered` count
  rides the SAME path `considered` already rides — `DETAIL_COVERAGE.covered` on the
  protocol message and SDK `buildDetailCoverageMessage`/`DetailCoverageParams`,
  normalized by the runtime's existing `boundConsideredCount` (drop-don't-reject:
  unsafe/negative/fractional → omitted), tracked in `trackDetailCoverage`, carried
  on the `run.detail_coverage_declared` spine event, surfaced on the terminal
  `collection_facts` block by `declaredCoveredForStream` (mirrors
  `declaredConsideredForStream`, first declared wins, never inferred from
  collected), parsed defensively in `ref-control.ts` (`covered: number | null`),
  and read by the gate `deriveStreamCoverageCondition`. Gate change: when `covered`
  is non-null the gate compares `considered` against `covered`
  (`covered < considered → partial`, else accepted/`complete`); when `covered` is
  null the prior `considered`-vs-`collected` comparison is byte-unchanged — so
  every shipped 4.1/4.2 declarer (none emit `covered`) is unaffected.
  `covered` = emitted + suppressed-because-unchanged, measured at the enumeration
  site from objective per-record outcomes; a weighed-but-dropped record is in
  NEITHER `collected` NOR `covered`, so it still reads `partial` (the Slack-canvas
  drop guardrail). Connector wired: Slack `FINGERPRINTED_STREAMS` — `emitWithFingerprint`
  now reports, per stream, whether each record emitted or suppressed-unchanged, and
  each requested fingerprinted stream declares `considered = covered = enumerated
  rows` via the existing `declareListConsidered` extended with an optional `covered`
  argument. A steady-state Slack `users`/`channels`/… run now reads `complete`;
  a run that drops a malformed row reads `partial` (covered < considered).
  Tests: `connectors/slack/fingerprint-considered.test.ts` (steady-state covered ===
  considered; one-changed still covered === considered; dropped row covered <
  considered; covered measured not aliased), runtime
  `collection-profile.test.js`/`connector-runtime.test.js` (covered carried through
  the fact block + builder), and `collection-report-projection.test.js` (gate:
  covered satisfies considered → `complete`; covered short → `partial`; covered
  null falls back to collected → prior behavior). GitHub cursor-stop semantics
  (`considered = page totalSeen`, below-cursor item reads `partial`) are
  DELIBERATELY UNCHANGED — that is an incremental window, not a full-sync boundary,
  and its `partial` is the shipped, tested intent (`github/index.test.ts:556`).
- [x] 4.5 Extend `covered` adoption to the remaining high-confidence
  fingerprint-suppressed full-sync streams named (and held back) in task 4.4.
  Each adopter re-enumerates its whole in-scope boundary every run and suppresses
  unchanged rows via a per-record fingerprint cursor (`shouldEmit` + `pruneStale`),
  so `collected` is a churn-reduced subset on a steady-state run. Each now declares
  a self-coverage `DETAIL_COVERAGE` (`stream === state_stream`, empty
  required/hydrated keys, so it passes `assertDetailCoverageSatisfiedBeforeCommit`
  with no missing keys) carrying `considered = enumerated boundary` and an
  objective `covered = emitted + suppressed-because-unchanged`, tallied at the
  enumeration loop from per-record outcomes and never aliased to the emit count.
  No runtime/SDK/projection change — these ride the task-4.4 plumbing verbatim.
  Adopted streams:
  - YNAB `budgets` (`/budgets` is a full-collection endpoint with no
    `server_knowledge` delta). Budgets enumeration extracted from `collect()` into
    an exported `emitBudgetsStream` so the declaration is unit-testable. YNAB's
    `server_knowledge`-delta streams (`accounts`, `categories`, `payees`,
    `transactions`, `scheduled_transactions`, `months`) are incremental and are
    NOT adopted; `account_stats` is an append-keyed observation, not an inventory.
    `payee_locations` is a full-sync fingerprint stream but enumerated PER BUDGET,
    so a multi-budget owner would emit several same-stream declarations and the
    runtime's first-declared-wins lookup would under-count the boundary — deferred.
  - Chase `accounts` (full dashboard scan) in `emitAccountsStream`, gated on the
    fingerprint cursor (the legacy no-cursor path declares none). Distinct from the
    existing transactions→accounts `DETAIL_COVERAGE` (`stream === "transactions"`),
    so no collision in the per-stream considered/covered lookup. Chase `statements`
    (full-scan fingerprint with hydration carry-forward) is plausible but its
    carried-but-unhydrated rows complicate the covered definition — deferred.
  - USAA `accounts` entity stream (full dashboard scan) in `emitAccountsStream`,
    gated on `emitEntity && fingerprintCursor`; `account_stats` declares none.
    USAA `statements` already emits a genuine hydration `DETAIL_COVERAGE` and is
    left as-is. USAA `transactions` is a partial export window (never pruned) — not
    a full-sync boundary, NOT adopted. USAA `inbox_messages` / `credit_card_billing`
    match the shape (and `inbox_messages` has a real pre-gate drop that would make
    covered < considered) — strong next-slice candidates, deferred to keep this
    tranche to the three named candidates.
  Tests: `connectors/ynab/budgets-considered.test.ts`,
  `connectors/chase/accounts-considered.test.ts`,
  `connectors/usaa/accounts-considered.test.ts` — each pins fresh (covered ===
  considered, all emitted), steady-state (covered === considered, collected 0),
  one-changed (covered === considered, collected 1), covered-not-aliased, and the
  no-coverage paths (legacy no-cursor; USAA stats-only). polyfill-connectors
  `tsc --noEmit` exit 0; biome clean on changed files; ynab/chase/usaa 328/0
  (+13 new); runtime `collection-report-projection.test.js` +
  `collection-profile.test.js` 149/149 unchanged.
- [ ] 4.3 Dashboard consumes per-stream report + forward disposition directly;
  deprecate per-connector freshness/gap reconstruction heuristics.

## Notes

- Tranche 2 is the only code in this change and is strictly additive. If the
  remaining tranche-2 tasks cannot all land green, ship the spec (section 1) and the
  landed increments and record the rest as the next implementation lane rather than
  landing a partial runtime change.
- The per-run Collection Report is a **two-layer construction** (the accepted
  layering decision; see
  `tmp/workstreams/ri-progress-evidence-terminal-layering-v1-report.md`): the
  runtime attaches an objective per-stream collection-fact block to the terminal
  event (Tranche B / task 2.2a), and the control-plane projection (`ref-control` →
  `connection-health`) derives the per-stream coverage condition and
  `forward_disposition` on read (Tranche C / task 2.2b + 2.4–2.7). The runtime never
  stamps a coverage condition or `forward_disposition` on the terminal event,
  because the per-connector run subprocess holds no freshness, refresh-policy,
  attention, or cross-stream rollup evidence — that is assembled downstream. This
  resolves the prior open layering question; the old single-step "derive the whole
  report in `buildRunTerminalData()`" framing is superseded.
- Tranche-2 increments landed so far: 2.1 (accept the optional connector-declared
  `considered` count on `DETAIL_COVERAGE` and inside `SKIP_RESULT.diagnostics`,
  riding the existing spine events; the `Number.isSafeInteger` boundary is the only
  numeric trust bound), 2.3 (the pure `deriveForwardDisposition` helper and its
  tests), 2.3a (wiring that helper into `computeConnectionHealth` so a
  connection-level `forward_disposition` is surfaced on the health snapshot), and
  2.3b (rendering that connection-level disposition in the console so the owner can
  actually see it). All four are strictly additive and emit nothing new on any spine
  event beyond the optional `considered` value, so none perturbs an existing
  terminal-event field, status code, or commit semantic (the 2.7 invariant): 2.1
  adds an optional bounded/redacted input on an existing event; 2.3 adds a pure
  function + unit tests; 2.3a adds one optional snapshot field consumed only by the
  internal `ConnectorSummary` server type, not by any `additionalProperties: false`
  contract schema; 2.3b adds a console-only formatter + one diagnostics line,
  reading the field already passed through `GET /_ref/connectors` — no new server
  contract. 2.3a + 2.3b together deliver the first real, owner-VISIBLE dashboard
  value — the "what will the next run do?" answer rendered on the connection detail
  page — while staying inside the existing health projection and surface. The
  remaining tranche-2 tasks (2.2a the runtime collection-fact block; 2.2b the
  projection-derived per-stream coverage condition + `forward_disposition`; 2.4–2.7
  honesty / absence / portability proofs) are the next implementation lane,
  sequenced runtime-facts-first then projection.
- The detail-gap reference-only constraint is preserved: this change reuses
  `DETAIL_GAP` / `DETAIL_COVERAGE` but does not promote them to portable protocol.

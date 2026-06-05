## Why

A connector run can already emit rich evidence — `SKIP_RESULT`, `DETAIL_GAP`,
`DETAIL_COVERAGE`, `STATE` cursors, and a `run.completed`/`run.failed` terminal
event that stamps `records_emitted`, `records_flushed`, `checkpoint_commit_status`,
`known_gaps`, and reference-only `detail_gaps`. The reference runtime's
`CoverageAxis` (in `reference-implementation/runtime/connection-health.ts`, the
projection the connection-health spec governs) already classifies coverage into
`complete | partial | gaps | retryable_gap | terminal_gap | unsupported |
unavailable | deferred | inventory_only | unknown` (freshness lives on a separate
`FreshnessAxis`, so `stale` is not a coverage value).

But there is no single requirement that says **every** connector run SHALL produce
a per-stream evidence envelope that answers the SLVP freshness questions:

- what source range or inventory was **considered**,
- what was **collected**,
- what was **skipped** (and why),
- what remains **retryable**,
- what is **terminal/unsupported**,
- what **checkpoint** was committed,
- and whether the **next run is expected to fill the gap**.

Today this is emergent and connector-by-connector. ChatGPT answers most of these
(detail gaps, detail coverage, density-stop). GitHub now emits a bounded
`SKIP_RESULT` for dropped starred entries but declares no "considered" denominator,
so a partial run is indistinguishable from a complete one except through gaps.
Slack declares unsupported streams but no forward disposition. The dashboard then
has to reconstruct freshness and gap honesty from heterogeneous heuristics — the
exact connector-by-connector fragility the refresh doc warns against.

The missing piece is not more storage or a new wire protocol. It is a **durable
per-run, per-stream collection-report contract** the reference implementation
builds from signals it already receives, with a small required core and an explicit
forward disposition. It is a two-layer construction: the runtime emits objective
per-stream facts on the terminal event, and the control-plane projection — the only
layer that holds freshness, refresh-policy, attention, and rollup evidence — derives
the coverage condition and forward disposition from those facts. The contract makes
the existing fields a guarantee instead of a coincidence, and names the one
genuinely-missing-but-derivable field (`considered`) so `partial` can be told from
`complete` without inference.

## What Changes

- Add a `reference-implementation-architecture` requirement defining a **per-run
  Collection Report** built as a two-layer construction: (a) the reference runtime
  attaches a per-stream **collection-fact block** to the terminal event carrying
  only objective, run-local facts — considered-or-`unknown`, collected, skip
  reason, pending-detail-gap count, checkpoint status — composed from the
  connector's already-emitted `RECORD`, `SKIP_RESULT`, `DETAIL_GAP`,
  `DETAIL_COVERAGE`, and `STATE` signals plus the runtime's own terminal
  accounting; and (b) the **control-plane projection** derives the per-stream
  **coverage condition** and **forward disposition** from that fact block plus the
  freshness, refresh-policy, attention, and cross-stream rollup evidence only it
  holds. The runtime SHALL NOT stamp a coverage condition or forward disposition on
  the terminal event.
- Add a requirement that the derived report carries a **forward disposition** per
  stream (`complete` | `resumable` | `awaiting_owner` | `owner_refresh_due` |
  `terminal`) so an owner surface can state what the next run is expected to do.
  The disposition is derived in the control-plane projection from coverage
  condition, gap retryability, attention evidence, and the connection's freshness /
  refresh-policy evidence rather than prose, and is never carried on the runtime
  terminal event (the same construction the connection-level `forward_disposition`
  already uses). The `owner_refresh_due`
  value closes the manual-refresh seam: a manual-refresh-only connection (such as
  Reddit) can have **complete coverage** yet **stale freshness**, and the
  disposition SHALL surface that owner-initiated refresh is due instead of
  collapsing to `complete` and hiding the refresh work. Coverage and freshness stay
  distinct axes — staleness is never re-encoded as a coverage gap, and
  `awaiting_owner` stays reserved for an actual outstanding coverage gap so missing
  data is never confused with merely aged data.
- Add a requirement that **absence of a considered denominator is itself honest**:
  when a connector does not declare what it considered, the runtime SHALL record the
  stream's considered value as `unknown`, and neither the runtime nor the
  control-plane projection SHALL infer `complete` from collected count alone.
- Keep the contract a **reference-implementation projection**, not a new portable
  Collection Profile wire message: it reuses the reference-only `DETAIL_GAP` /
  `DETAIL_COVERAGE` signals under their existing reference-only constraint and the
  already-public `SKIP_RESULT` / `STATE` / terminal-event surfaces. Portable
  connectors and protocol readers SHALL NOT be required to emit a new message.
- Implement the runtime input plumbing as the first, smallest, strictly-additive
  code tranche: accept an optional connector-declared `considered` count on
  `DETAIL_COVERAGE` (already carries `required_keys`) and inside
  `SKIP_RESULT.diagnostics`, bounded and redacted on the existing diagnostics path,
  riding the existing `run.detail_coverage_declared` / `run.stream_skipped` spine
  events — without changing any existing field, status code, or commit semantics
  (landed; see tasks 2.1/2.3/2.3a/2.3b). The per-stream collection-fact block on
  the terminal event (runtime half) and the projection-derived coverage condition +
  forward disposition (control-plane half) are the next implementation tranches,
  sequenced below; this change does not claim they are implemented.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Reference implementation and operator/owner surfaces only. Does not change the
  public record/query/search/schema/blob `/v1` API.
- Does not promote `DETAIL_GAP` / `DETAIL_COVERAGE` to a normative portable wire
  contract; the reference-only constraint at
  `reference-implementation-architecture` ("Detail-gap state SHALL remain
  reference-only until promoted") is preserved.
- Composes with the in-flight coverage-derivation changes
  (`derive-local-collector-coverage-from-diagnostics`,
  `add-local-device-collection-verdict`): the Collection Report is the per-run
  source those projections already consume; this change names the contract they
  depend on rather than redefining their axes.
- The first code tranche is additive (one derived field + two optional inputs).
  Broad per-connector `considered` declaration is sequenced as follow-up lanes,
  starting with the connectors whose dashboard rows are least honest today.

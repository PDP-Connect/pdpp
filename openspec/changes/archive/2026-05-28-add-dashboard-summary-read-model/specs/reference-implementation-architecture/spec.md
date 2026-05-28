## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit
Debugging, replay, trace, dashboard summary, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

#### Scenario: A trace or timeline endpoint is exposed
- **WHEN** the implementation exposes trace, timeline, or similar introspection surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only artifacts rather than as core PDPP protocol requirements

#### Scenario: The current `_ref` read surface is treated as stable substrate
- **WHEN** the implementation exposes the current reference-designated event-spine readers
- **THEN** the durable `_ref` read surface SHALL stay limited to:
  - `GET /_ref/traces/:traceId`
  - `GET /_ref/grants/:grantId/timeline`
  - `GET /_ref/runs/:runId/timeline`
  - `GET /_ref/traces` (list, filter, paginate)
  - `GET /_ref/grants` (list, filter, paginate)
  - `GET /_ref/runs` (list, filter, paginate)
  - `GET /_ref/search?q=...` (id-aware read-only jump helper)
  - `GET /_ref/dataset/summary` (dashboard overview dataset summary)

#### Scenario: The dashboard summarizes dataset credibility
- **WHEN** the reference dashboard renders a dataset summary or credibility overview
- **THEN** it MAY consume `GET /_ref/dataset/summary`
- **AND** that route SHALL remain documented as a reference-only read surface rather than as a public PDPP API

#### Scenario: The dashboard summary uses a derived read model
- **WHEN** the reference implementation serves `GET /_ref/dataset/summary`
- **THEN** it SHALL serve the dashboard overview from a derived dataset-summary read model rather than from per-request unbounded scans of canonical records, record changes, blobs, timelines, or JSON payload fields
- **AND** the derived read model SHALL remain rebuildable from durable reference state
- **AND** the hot read path SHALL be bounded by read-model rows rather than by corpus size

#### Scenario: The dashboard summary reports freshness honestly
- **WHEN** the derived dashboard summary read model is stale, rebuilding, or failed
- **THEN** `GET /_ref/dataset/summary` SHALL expose machine-readable projection metadata with summary state, computation time, stale status, rebuild status, and sanitized error details sufficient for the dashboard to avoid presenting old aggregate values as fresh truth
- **AND** existing summary fields SHALL remain present for compatibility when a last-known summary exists

#### Scenario: The dashboard summary is maintained from durable writes
- **WHEN** record, record-change, or blob writes change values represented in the dashboard summary
- **THEN** the reference implementation SHALL update or invalidate the derived dataset-summary read model transactionally or idempotently where possible
- **AND** exact cheap counters SHALL NOT depend on a later connector rerun
- **AND** values that cannot be updated safely, such as record-time extrema removed by overwrite or delete, SHALL be marked stale or dirty for reconciliation

#### Scenario: The dashboard summary is rebuilt safely
- **WHEN** an operator or maintenance process rebuilds the derived dashboard summary read model
- **THEN** the rebuild SHALL regenerate summary data from durable reference state without requiring connector reruns, credential access, or destructive changes to canonical evidence
- **AND** rebuild failures SHALL preserve canonical evidence and surface sanitized failure metadata

#### Scenario: The dashboard does not block on summary recomputation
- **WHEN** the owner opens the reference dashboard while the dataset summary is refreshing, stale, rebuilding, or failed
- **THEN** the dashboard SHALL render shell/header and honest placeholders or last-known summary values without waiting for a live corpus-wide summary recomputation
- **AND** it SHALL NOT render `0 records` as a loading, stale, or error fallback unless the returned summary was successfully computed with `record_count === 0`

#### Scenario: A later control-plane phase widens `_ref` mutation narrowly
- **WHEN** a later control-plane phase needs a truthful operator mutation surface for a live bounded collection run
- **THEN** the reference MAY add an owner-only `_ref` mutation endpoint limited to:
  - `POST /_ref/runs/:runId/interaction`
- **AND** that route SHALL be documented as reference-only control-plane behavior rather than as a public PDPP API
- **AND** the reference SHALL NOT widen `_ref` into broader mutation/control endpoints in the same tranche without a further explicit OpenSpec change

#### Scenario: Run timelines expose checkpoint staging separately from checkpoint commit
- **WHEN** the reference runtime receives `STATE` during a bounded collection run
- **THEN** the `_ref` run timeline SHALL distinguish checkpoint staging from checkpoint commit so the checkpointed-streaming model is visible in reference artifacts rather than implied only by runtime internals

#### Scenario: Runtime validation failures remain inspectable in the reference substrate
- **WHEN** a bounded collection run fails because the runtime rejects connector output or an interaction handler response before `DONE`
- **THEN** the durable `_ref` run timeline SHALL still record `run.failed` with an explicit machine-readable reason instead of leaving that failure visible only as a thrown local error

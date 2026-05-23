## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit

The reference implementation SHALL explicitly mark debugging, replay, trace,
dashboard summary, retained-size, and operator-control surfaces as
reference-only when those surfaces are useful to the reference implementation
but are not part of core PDPP.

#### Scenario: A trace or timeline endpoint is exposed

- **WHEN** the implementation exposes trace, timeline, or similar introspection
  surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only
  artifacts rather than as core PDPP protocol requirements.

#### Scenario: The current `_ref` read surface is treated as stable substrate

- **WHEN** the implementation exposes the current reference-designated
  event-spine, dataset summary, or retained-size readers
- **THEN** the durable `_ref` read surface SHALL stay limited to documented
  reference-only operator and diagnostic reads
- **AND** retained-size reads SHALL remain owner-only reference surfaces rather
  than public PDPP resource-server APIs.

#### Scenario: The dashboard summarizes dataset credibility

- **WHEN** the reference dashboard renders a dataset summary, retained-size, or
  credibility overview
- **THEN** it MAY consume reference-only `_ref` dataset summary and retained
  size reads
- **AND** those routes SHALL remain documented as reference-only read surfaces
  rather than as public PDPP APIs.

#### Scenario: The dashboard summary uses a derived read model

- **WHEN** the reference implementation serves dataset summary or retained-size
  operator reads
- **THEN** it SHALL serve the hot read path from derived read-model rows rather
  than from per-request unbounded scans of canonical records, record changes,
  blobs, timelines, or JSON payload fields
- **AND** the derived read model SHALL remain rebuildable from durable
  reference state
- **AND** the hot read path SHALL be bounded by read-model rows rather than by
  corpus size.

#### Scenario: The dashboard summary reports freshness honestly

- **WHEN** the derived dashboard summary or retained-size read model is stale,
  rebuilding, or failed
- **THEN** reference dataset reads SHALL expose machine-readable projection
  metadata with summary state, computation time, stale status, rebuild status,
  and sanitized error details sufficient for the dashboard to avoid presenting
  old aggregate values as fresh truth
- **AND** existing summary fields SHALL remain present for compatibility when a
  last-known summary exists.

#### Scenario: The dashboard summary is maintained from durable writes

- **WHEN** record, record-change, or blob writes change values represented in
  the dashboard summary or retained-size read model
- **THEN** the reference implementation SHALL update or invalidate the derived
  read model transactionally or idempotently where possible
- **AND** exact cheap counters SHALL NOT depend on a later connector rerun
- **AND** values that cannot be updated safely SHALL be marked stale or dirty
  for reconciliation.

#### Scenario: The dashboard summary is rebuilt safely

- **WHEN** an operator or maintenance process rebuilds the derived dashboard
  summary or retained-size read model
- **THEN** the rebuild SHALL regenerate summary data from durable reference
  state without requiring connector reruns, credential access, or destructive
  changes to canonical evidence
- **AND** rebuild failures SHALL preserve canonical evidence and surface
  sanitized failure metadata.

#### Scenario: The dashboard does not block on summary recomputation

- **WHEN** the owner opens the reference dashboard while the dataset summary or
  retained-size read model is refreshing, stale, rebuilding, or failed
- **THEN** the dashboard SHALL render shell/header and honest placeholders or
  last-known values without waiting for a live corpus-wide recomputation
- **AND** it SHALL NOT render `0 records` as a loading, stale, or error
  fallback unless the returned summary was successfully computed with
  `record_count === 0`.

### Requirement: Retained-size reads SHALL expose bounded logical-byte measures

The reference implementation SHALL expose owner-only retained-size reads as
typed logical-byte measures over finite, bounded grains.

#### Scenario: Retained-size measures are explicit

- **WHEN** a retained-size row is returned
- **THEN** it SHALL label current record JSON bytes, record-history JSON bytes,
  blob bytes, total retained bytes, record count, and blob count separately
- **AND** `total_retained_bytes` SHALL be the server-computed sum of the
  logical retained-byte categories for that row.

#### Scenario: Physical storage is not confused with retained data size

- **WHEN** the implementation exposes database physical storage metrics
- **THEN** those metrics SHALL be labeled separately from retained logical
  bytes
- **AND** retained-size reads SHALL NOT use physical table or index size as the
  owner-facing retained data measure.

#### Scenario: Retained-size grains are finite

- **WHEN** retained-size rows are requested
- **THEN** supported grains SHALL be limited to global dataset, connection, and
  stream unless a later capability adds a manifest-authored record-family
  classifier
- **AND** the implementation SHALL NOT accept arbitrary JSON-path group-bys or
  ad hoc dimensions in this capability
- **AND** it SHALL NOT advertise a record-family grain until rebuild and
  incremental maintenance populate that grain from a real bounded
  classification source.

#### Scenario: Connection grain uses connector instance identity

- **WHEN** a retained-size row represents an owner-facing connection
- **THEN** the row SHALL be keyed by `connector_instance_id`
- **AND** stream and record-family rows SHALL remain attributable to that
  connection.

#### Scenario: Future record-family values are bounded

- **WHEN** a connector emits or classifies a record-family value for
  retained-size grouping
- **THEN** the value SHALL be drawn from a bounded connector-authored or
  manifest-authored set
- **AND** unauthored free-form record content SHALL NOT become a retained-size
  dimension label.

### Requirement: Retained-size top-N rows SHALL be bounded drill-down aids

The reference implementation SHALL support bounded top-N retained-size rows for
owner introspection without introducing an ad hoc query engine.

#### Scenario: Top-N rows are capped

- **WHEN** an owner requests retained-size top-N rows
- **THEN** the response SHALL cap the result count server-side
- **AND** it SHALL reject or clamp unsupported limits, scopes, measures, and
  bucket kinds.

#### Scenario: Top-N rows contain identifiers not payloads

- **WHEN** a retained-size top-N row identifies a large connection, stream,
  record, or blob
- **THEN** it SHALL contain the identifiers needed for drill-down
- **AND** it SHALL NOT include raw connector payloads, credentials, cookies,
  interaction answers, or arbitrary record text.

#### Scenario: Top-N freshness is honest

- **WHEN** top-N rows are stale, approximate, rebuilding, or failed
- **THEN** the response SHALL expose metadata sufficient for the dashboard to
  avoid presenting those rows as fresh exact truth.

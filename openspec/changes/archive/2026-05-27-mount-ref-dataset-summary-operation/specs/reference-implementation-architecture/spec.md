## ADDED Requirements

### Requirement: `ref.dataset.summary` SHALL be operation-owned

The reference implementation SHALL serve the reference-only `/_ref/dataset/summary` operator-console surface through a canonical `ref.dataset.summary` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, sandbox modules, and process environment.

The operation is reference/operator surface, not PDPP protocol. It SHALL NOT be promoted into PDPP-stable wire semantics by this requirement, and the field-level constraint that `record_json_bytes` is adapter-native operator data (per `define-reference-operation-environments` contract correction (4)) SHALL be preserved by the operation.

#### Scenario: Native dataset-summary route

- **WHEN** the native reference server handles `GET /_ref/dataset/summary`
- **THEN** it SHALL execute the canonical `ref.dataset.summary` operation for envelope assembly
- **AND** route-specific code SHALL be limited to owner authentication, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `ref.dataset.summary` operation is implemented
- **THEN** it SHALL depend on capability-shaped count, retained-bytes, record-time-bound, ingest-time-bound, and top-connector-candidate dependencies
- **AND** it SHALL NOT import Fastify, Express, Next, SQLite, Postgres, a raw SQL handle, sandbox modules, `reference-implementation/server/records.js`, `reference-implementation/server/index.js`, or `process` / `process.env`

#### Scenario: Existing dataset-summary semantics are preserved

- **WHEN** the native `GET /_ref/dataset/summary` route is migrated to the operation
- **THEN** the response envelope SHALL preserve `object: 'dataset_summary'`, `connector_count`, `stream_count`, `record_count`, `record_json_bytes`, `record_changes_json_bytes`, `blob_bytes`, `total_retained_bytes`, `earliest_record_time`, `latest_record_time`, `earliest_ingested_at`, `latest_ingested_at`, and `top_connectors` (each `dataset_connector_summary`) bit-for-bit equivalent to the previous native route response
- **AND** the migration SHALL NOT change the public JSON envelope of the route response

#### Scenario: Operation owns top-connector sort and limit

- **WHEN** the operation receives top-connector candidates from its dependency
- **THEN** it SHALL sort the candidates by `record_count` descending with a tiebreak on `connector_id` ascending
- **AND** it SHALL emit at most three entries
- **AND** it SHALL wrap each entry as `{object: 'dataset_connector_summary', connector_id, record_count}`

#### Scenario: Operation owns empty-corpus collapse

- **WHEN** the dependency-supplied `record_count` is `0`
- **THEN** the operation SHALL emit `earliest_record_time`, `latest_record_time`, `earliest_ingested_at`, and `latest_ingested_at` as `null`
- **AND** it SHALL NOT call the time-bound dependencies for those fields

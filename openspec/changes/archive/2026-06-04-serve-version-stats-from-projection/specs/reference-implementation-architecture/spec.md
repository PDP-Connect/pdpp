## ADDED Requirements

### Requirement: Version-churn observability SHALL serve the unfiltered hot path from the maintained projection without an unbounded history scan

The owner-only `GET /_ref/records/version-stats` read SHALL produce its bounded
top-churn diagnostic for an **unfiltered** request without running an unbounded
aggregate over the entire `record_changes` table. The reference implementation
SHALL source the per-stream churn facts from the maintained retained-size
projection for streams the projection can classify, and SHALL compute the
ground-truth aggregate (`COUNT(*)`, `COUNT(DISTINCT record_key)`,
`MAX(emitted_at)`) only for a bounded candidate set of streams.

This requirement governs how the row facts are SOURCED for the unfiltered hot
path. It SHALL NOT alter what a row contains, the numeric churn thresholds, the
`risk_level` / `risk_reasons` classification, or the derived
`version_disposition`. A row whose facts are sourced from ground truth SHALL be
byte-identical to the row the prior full scan would have produced.

The reference implementation SHALL treat the projection's `record_history_count`
and current `record_count` as authoritative for a stream ONLY when that
projection row is not dirty. It SHALL NOT treat the projection's
`record_history_count` as authoritative for a dirty row, and SHALL NOT
incrementally maintain `COUNT(DISTINCT record_key)` or `MAX(emitted_at)` from
write-time deltas.

The candidate set SHALL be derived conservatively so that no stream which
ground truth would classify above `normal` is omitted from the ground-truth
computation. A stream SHALL be a candidate when its projection row is dirty, or
when its non-dirty projection facts could place it at or above the `watch`
threshold under the denominator that maximizes versions-per-record. Over-
inclusion of a stream that proves `normal` SHALL be acceptable; omission of a
non-`normal` stream SHALL NOT occur.

When the global retained-size projection is dirty (never built or rebuild
pending), the reference implementation SHALL fall back to the full ground-truth
computation for the unfiltered request rather than serve a candidate-narrowed
diagnostic.

#### Scenario: Unfiltered request avoids the unbounded scan

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
  with no `connector_instance_id` and no `stream` filter, and the global
  retained-size projection is not dirty
- **THEN** the reference implementation SHALL NOT run an aggregate over
  `record_changes` that is unbounded by stream
- **AND** it SHALL compute the ground-truth `COUNT(*)`,
  `COUNT(DISTINCT record_key)`, and `MAX(emitted_at)` only for the bounded
  candidate set of streams (candidates plus any dirty projection rows).

#### Scenario: Candidate facts are byte-identical to the full scan

- **WHEN** the unfiltered request classifies a stream as `watch` or `high` from
  the candidate ground-truth computation
- **THEN** that row's `record_history_count`, `record_key_count`,
  `last_history_at`, `versions_per_record`, `risk_level`, `risk_reasons`, and
  `version_disposition` SHALL equal the values the prior full
  `record_changes` scan would have produced for the same stream.

#### Scenario: A non-candidate normal stream is classified without a scan

- **WHEN** a stream's non-dirty projection facts are below the candidate
  threshold under the versions-per-record-maximizing denominator
- **THEN** the reference implementation SHALL classify the row from projection
  facts alone, reporting `projection_authority` as the projection (not ground
  truth), and SHALL report `record_key_count` and `last_history_at` as null
- **AND** it SHALL NOT issue a `record_changes` aggregate for that stream.

#### Scenario: A dirty projection row is always verified against ground truth

- **WHEN** a stream's projection row is dirty
- **THEN** the reference implementation SHALL include that stream in the bounded
  ground-truth computation regardless of the stream's apparent projection risk,
  so a stale projection count cannot cause a non-normal row to be omitted or
  downgraded.

#### Scenario: A cold or rebuilding projection falls back to the full computation

- **WHEN** an unfiltered request arrives while the global retained-size
  projection is dirty
- **THEN** the reference implementation SHALL compute the diagnostic from the
  full ground-truth aggregate rather than the candidate-narrowed path, so a cold
  or rebuilding instance is never served a thinned diagnostic.

#### Scenario: Filtered requests are unchanged

- **WHEN** an owner passes an exact `connector_instance_id` or exact `stream`
  filter
- **THEN** the reference implementation SHALL apply that filter to the
  ground-truth computation as before
- **AND** result size SHALL remain capped by the server-enforced limit.

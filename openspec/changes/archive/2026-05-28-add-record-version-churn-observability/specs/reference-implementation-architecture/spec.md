## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit

The reference implementation SHALL explicitly mark debugging, replay, trace,
dashboard summary, retained-size, record-version observability, and
operator-control surfaces as reference-only when those surfaces are useful to
the reference implementation but are not part of core PDPP.

#### Scenario: A trace or timeline endpoint is exposed

- **WHEN** the implementation exposes trace, timeline, version-churn, or similar introspection surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only
  artifacts rather than as core PDPP protocol requirements.

## ADDED Requirements

### Requirement: Record-version churn observability SHALL be bounded and reference-only

The reference implementation SHALL expose owner-only record-version observability
for detecting streams whose retained history grows disproportionately to current
records. This observability SHALL remain a reference-only operator diagnostic
and SHALL NOT change PDPP Core record read semantics, Collection Profile
messages, or public `/v1` resource-server contracts.

#### Scenario: Owner lists version churn stats

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
- **THEN** the response SHALL contain bounded aggregate rows keyed by
  `connector_instance_id` and `stream`
- **AND** each row SHALL include current record count, retained record-history
  count, versions-per-record, projection freshness when projection-backed,
  recent write timestamps when known, and a reference-only risk classification
- **AND** the response SHALL NOT include raw `record_json`, raw
  `record_changes.record_json`, credentials, or connector payload bodies.

#### Scenario: Non-owner caller attempts to read version churn stats

- **WHEN** a caller without owner authorization requests
  `GET /_ref/records/version-stats`
- **THEN** the reference implementation SHALL reject the request using the same
  owner-auth policy as other `_ref` operator reads.

#### Scenario: Version-churn stats are filtered

- **WHEN** an owner passes exact `connector_instance_id`, exact `stream`, or
  `risk` filters
- **THEN** the route SHALL apply those filters before returning rows
- **AND** result size SHALL remain capped by a server-enforced limit.

#### Scenario: Version-churn stats do not imply compaction

- **WHEN** a stream is classified as high churn
- **THEN** the reference implementation SHALL surface that classification as
  operator evidence only
- **AND** it SHALL NOT automatically compact, delete, merge, or rewrite
  `record_changes` history.

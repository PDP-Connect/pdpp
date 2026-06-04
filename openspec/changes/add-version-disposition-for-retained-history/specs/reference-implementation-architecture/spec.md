## MODIFIED Requirements

### Requirement: Record-version churn observability SHALL be bounded and reference-only

The reference implementation SHALL expose owner-only record-version observability
for detecting streams whose retained history grows disproportionately to current
records. This observability SHALL remain a reference-only operator diagnostic
and SHALL NOT change PDPP Core record read semantics, Collection Profile
messages, or public `/v1` resource-server contracts.

Each version-churn row SHALL additionally carry a reference-derived
`version_disposition` that classifies why the row's retained history exists. The
disposition SHALL be one of:

- `active_defect_or_unclassified` — a non-normal row with no recognized
  disposition. This SHALL be the only disposition that counts toward an operator
  "needs review" signal.
- `reviewed_historical_residue` — a stream with a registered compaction policy
  that the owner has reviewed as expected pre-fix accumulation, whose most recent
  history write is at or before the recorded review evidence.
- `point_in_time_retained_history` — genuine real-field movement whose sampled
  observation has been split into an append-keyed stream; the retained entity
  history is real history that SHALL NOT be compacted.
- `lossless_compaction_candidate` — a stream with a registered compaction policy
  whose redundant adjacent versions remain removable, OR a reviewed-residue
  stream whose history grew after the review (re-alarm).
- `recurring_point_in_time_snapshot` — a stream that legitimately re-versions on
  each real-growth pass, is gated against byte-identical no-op re-emits, and
  cannot be append-split or compacted (the whole record is the evolving
  observation). This is expected retained history.

The `version_disposition` SHALL be **derived by the reference implementation**
from signals it controls — the manifest stream `semantics`, the presence of a
registered compaction policy, the presence of an append-keyed split sibling
stream, the owner-maintained reviewed-residue evidence, and the recurring
real-growth rule. A connector SHALL NOT be able to set, override, or suppress a
row's `version_disposition` through any manifest field or emitted payload.

The `version_disposition` SHALL be a label only. It SHALL NOT alter the numeric
`risk_thresholds`, the computed `risk_level`, or the `risk_reasons`. An
undeclared high-churn stream SHALL still surface as `active_defect_or_unclassified`
at its real `risk_level`. The envelope SHALL make the threshold-independence
explicit so a reader cannot mistake disposition for a threshold override.

#### Scenario: Owner lists version churn stats

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
- **THEN** the response SHALL contain bounded aggregate rows keyed by
  `connector_instance_id` and `stream`
- **AND** each row SHALL include current record count, retained record-history
  count, versions-per-record, projection freshness when projection-backed,
  recent write timestamps when known, a reference-only risk classification, and a
  reference-derived `version_disposition`
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

#### Scenario: Disposition does not change the risk thresholds

- **WHEN** the reference derives a `version_disposition` for a row
- **THEN** the row's `risk_level`, `risk_reasons`, and `versions_per_record`
  SHALL be computed exactly as they are without disposition
- **AND** the envelope's `risk_thresholds` SHALL be unchanged
- **AND** the envelope SHALL assert that disposition does not affect the
  thresholds.

#### Scenario: An unrecognized high-churn stream needs review

- **WHEN** a `watch` or `high` row is on a `(connector_id, stream)` that has no
  registered compaction policy, is not an append-split residual stream, is not in
  the reviewed-residue evidence, and is not a recurring point-in-time snapshot
- **THEN** the reference SHALL classify the row `active_defect_or_unclassified`
- **AND** it SHALL be the only disposition counted toward an operator
  "needs review" signal.

#### Scenario: A connector cannot self-declare its disposition

- **WHEN** a connector manifest or emitted record payload contains a field that
  attempts to assert a stream's churn disposition
- **THEN** the reference SHALL ignore that field when deriving
  `version_disposition`
- **AND** the derived disposition SHALL depend only on reference-controlled
  signals (manifest `semantics`, registered compaction policy presence,
  append-split sibling presence, owner reviewed-residue evidence, and the
  recurring real-growth rule).

#### Scenario: Reviewed residue re-alarms when history grows after review

- **WHEN** a stream classified `reviewed_historical_residue` writes new history
  whose most recent timestamp is after the recorded review evidence
- **THEN** the reference SHALL classify the row `lossless_compaction_candidate`
- **AND** the row SHALL count as actionable rather than reviewed.

#### Scenario: A recurring point-in-time snapshot stream is expected retained history

- **WHEN** a `mutable_state` stream that re-versions only on real growth, has no
  registered compaction policy, and has no append-keyed split sibling (for
  example an evolving local agent `sessions` stream) crosses a churn threshold
- **THEN** the reference SHALL classify the row `recurring_point_in_time_snapshot`
- **AND** the row SHALL NOT count toward the operator "needs review" signal
- **AND** an advance in the row's most recent history timestamp SHALL NOT
  re-alarm the row, because growth is its expected, non-removable signal.

#### Scenario: A split residual entity stream is never compactable

- **WHEN** an entity stream whose sampled metric has been moved to an
  append-keyed sibling stream (for example `github/user`, `slack/channels`, or
  `ynab/accounts`) crosses a churn threshold on its retained pre-split history
- **THEN** the reference SHALL classify the row `point_in_time_retained_history`
- **AND** the reference SHALL NOT offer a compaction remediation for the row,
  because compacting it would delete real history.

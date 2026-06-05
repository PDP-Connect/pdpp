## ADDED Requirements

### Requirement: Record-version churn rows SHALL carry a reference-derived remediation disposition

Each row of the owner-only `GET /_ref/records/version-stats` envelope SHALL carry
a reference-derived `version_remediation` that names the operator's available
next action for the row's retained history. This is orthogonal to
`version_disposition` (which classifies *why* the history exists);
`version_remediation` classifies *what the operator does about it*. The
remediation SHALL be one of:

- `none` — no operator action is available or warranted from this surface. The
  retained history is already minimal, is an actionable compaction candidate
  whose read-only dry-run command is the action, or is expected recurring history
  with no pending owner decision.
- `content_fingerprint_pending` — the stream is fingerprint-correct on its
  run-clock field but its retained history remains non-minimal until the
  connector emits a stable content fingerprint that lets the volatile
  acquisition or blob-identity fields be excluded losslessly. Running the
  existing compaction dry-run frees nothing; the durable remediation is connector
  work tracked by a separate change.
- `owner_migration_pending` — the retained history is the sole surviving copy of
  real observations that SHALL be migrated into their canonical append-keyed
  stream before the entity history could be collapsed. Compaction is not the
  remediation, and collapsing the row before the migration would destroy real
  history; the row carries a pending owner-gated data migration.
- `owner_retention_policy` — expected recurring history whose only open lever is
  an owner retention-policy decision (for example, whether to bound an
  unbounded-growth snapshot stream). This is not a defect and the owner MAY
  decline it.

The `version_remediation` SHALL be **derived by the reference implementation**
from signals it controls — the row's already-derived `version_disposition` and
reference-maintained `(connector, stream)` lists naming the
content-fingerprint-pending streams, the owner-migration-pending streams, and the
owner-retention-policy streams. A connector SHALL NOT be able to set, override,
or suppress a row's `version_remediation` through any manifest field or emitted
payload.

The derivation SHALL be consistent with the row's `version_disposition`: a row
classified `owner_retention_policy` SHALL also be classified
`recurring_point_in_time_snapshot`; a row classified
`active_defect_or_unclassified` or `lossless_compaction_candidate` SHALL be
classified `none`. A row SHALL NOT receive a `version_remediation` that
contradicts its `version_disposition`.

The `version_remediation` SHALL be a label only. It SHALL NOT alter the numeric
`risk_thresholds`, the computed `risk_level`, the `risk_reasons`, or the
`version_disposition`. The envelope SHALL make this threshold- and
disposition-independence explicit so a reader cannot mistake remediation for a
threshold or disposition override.

#### Scenario: Owner lists version churn stats with remediation

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
- **THEN** each returned row SHALL include a reference-derived
  `version_remediation` that is one of `none`, `content_fingerprint_pending`,
  `owner_migration_pending`, or `owner_retention_policy`
- **AND** the response SHALL NOT include raw `record_json`, raw
  `record_changes.record_json`, credentials, or connector payload bodies.

#### Scenario: A fingerprint-pending residue stream names the connector fix

- **WHEN** a stream on the reference-maintained content-fingerprint-pending list
  (a statement stream whose blob-identity churn is run/acquisition noise but
  whose connector does not yet emit a content fingerprint — for example
  `chase/statements` or `usaa/statements`) crosses a churn threshold and is
  classified `reviewed_historical_residue`
- **THEN** the reference SHALL classify the row `content_fingerprint_pending`
- **AND** the row's `version_disposition` SHALL remain `reviewed_historical_residue`
  (remediation does not change disposition).

#### Scenario: A migration-pending residue stream is not offered compaction as the fix

- **WHEN** a stream on the reference-maintained owner-migration-pending list
  (an entity stream whose retained history is the sole surviving copy of
  pre-split real observations — for example `usaa/accounts`) crosses a churn
  threshold
- **THEN** the reference SHALL classify the row `owner_migration_pending`
- **AND** the row SHALL be distinguishable from a content-fingerprint-pending
  residue row even when both share the `reviewed_historical_residue` disposition.

#### Scenario: A recurring snapshot stream names the owner retention decision

- **WHEN** a stream classified `recurring_point_in_time_snapshot` is on the
  reference-maintained owner-retention-policy list (`claude-code/sessions` or
  `codex/sessions`)
- **THEN** the reference SHALL classify the row `owner_retention_policy`
- **AND** the row SHALL NOT count toward the operator "needs review" signal,
  because the only open lever is a decline-able owner retention-policy decision.

#### Scenario: A row with no available action is remediation none

- **WHEN** a row is classified `lossless_compaction_candidate`,
  `active_defect_or_unclassified`, or `point_in_time_retained_history` and is not
  named on any remediation list
- **THEN** the reference SHALL classify the row `version_remediation` `none`
- **AND** `none` SHALL mean this surface offers no further action for the row,
  not that the retained history is absent.

#### Scenario: A connector cannot self-declare its remediation

- **WHEN** a connector manifest or emitted record payload contains a field that
  attempts to assert a stream's churn remediation
- **THEN** the reference SHALL ignore that field when deriving
  `version_remediation`
- **AND** the derived remediation SHALL depend only on reference-controlled
  signals (the row's `version_disposition` and the reference-maintained
  remediation lists).

#### Scenario: Remediation does not change the risk thresholds or disposition

- **WHEN** the reference derives a `version_remediation` for a row
- **THEN** the row's `risk_level`, `risk_reasons`, `versions_per_record`, and
  `version_disposition` SHALL be computed exactly as they are without remediation
- **AND** the envelope's `risk_thresholds` SHALL be unchanged
- **AND** the envelope SHALL assert that remediation does not affect the
  thresholds.

## ADDED Requirements

### Requirement: Gmail SHALL terminally settle a served too-large attachment gap

When Gmail is served a pending `attachments` detail gap and the matching
current attachment record is accepted with `hydration_status: "too_large"`,
the connector SHALL emit one terminal policy outcome on the existing detail
gap wire family. The outcome SHALL preserve the served `gap_id` and
`lease_id`, the exact bounded terminal evidence, the attachment's
`optional_skip_keys` coverage fact, and the error reason/class `too_large`.
It SHALL be non-retryable and SHALL NOT be represented as a recovery.

#### Scenario: The four diagnosed policy rows leave the pending queue

- **WHEN** the served Gmail attachment page contains the four diagnosed
  `too_large` attachment rows
- **THEN** each matching durable gap SHALL become terminal/policy-skipped
- **AND** no `DETAIL_GAP_RECOVERED` or `DETAIL_GAP_ATTEMPTED` message SHALL be
  emitted for those rows
- **AND** their exact gap and lease identities and terminal evidence SHALL be
  preserved
- **AND** smaller/retryable siblings SHALL be admitted on a later run.

#### Scenario: A transient provider failure remains retryable

- **WHEN** a served Gmail attachment hydration fails with `Connection not
  available` or another transient provider failure
- **THEN** Gmail SHALL emit its ordinary retryable `DETAIL_GAP` outcome
- **AND** the durable row SHALL remain pending and eligible for a later run.

#### Scenario: A later upsert cannot revive a policy terminal

- **WHEN** a later forward pass re-upserts the same attachment identity
- **AND** the durable row is already terminal with reason/class `too_large`
- **THEN** the row SHALL remain terminal with its original terminal evidence.

### Requirement: Planned recovery deferral SHALL remain non-attempting

When Gmail leaves a served gap unadmitted because of its bounded run cap and
settles it as `run_cap_deferred`, the connector/runtime SHALL keep it pending,
SHALL NOT increment provider `attempt_count`, and SHALL NOT terminalize or
quarantine it.

#### Scenario: The unadmitted suffix remains eligible

- **WHEN** the Gmail recovery byte budget admits a prefix and defers a sibling
  with `run_cap_deferred`
- **THEN** the sibling SHALL remain pending with unchanged `attempt_count` and
  prior real-attempt timestamp
- **AND** a later run SHALL be able to admit it.

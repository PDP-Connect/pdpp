## ADDED Requirements

### Requirement: Connection health SHALL project acquisition coverage without conflating it with scheduler failure

The reference connection-health projection SHALL treat acquisition-batch coverage
as evidence separate from scheduler policy, credential readiness, runtime
readiness, and collection success. Expected manual staleness, partial owner
artifacts, duplicate uploads, and declared missing media SHALL be surfaced as
coverage facts or advisories rather than generic failures unless the connector
declares them blocking.

#### Scenario: Manual artifact source becomes stale

- **WHEN** a connection's latest owner-artifact acquisition covers data only up
  to an older event timestamp
- **THEN** owner surfaces SHALL show the covered-through timestamp and a
  re-export or add-artifact action when available
- **AND** the projection SHALL NOT label the connection as failed solely because
  the source requires owner action for newer data.

#### Scenario: Import succeeds with missing media

- **WHEN** an acquisition batch accepts records but reports missing optional
  media
- **THEN** owner surfaces SHALL show the missing-media coverage gap and the next
  action to add media when known
- **AND** the connection SHALL NOT be projected as a generic runtime or
  scheduler failure.

#### Scenario: Import produces no new records because it is duplicate

- **WHEN** an owner-artifact acquisition is entirely duplicate of a previous
  accepted batch
- **THEN** owner surfaces SHALL show that no new records were added because the
  artifact was already known
- **AND** the projection SHALL NOT report a failed import.

### Requirement: Owner surfaces SHALL provide coverage receipts for acquisition batches

When the reference accepts an acquisition batch, owner-facing surfaces SHALL be
able to render a receipt with safe counts, event-time coverage, duplicate/skipped
facts, and actionable gaps. The receipt SHALL avoid source-specific UI logic by
consuming connector/runtime-provided acquisition-batch facts.

#### Scenario: Owner artifact is parsed before commit

- **WHEN** the reference can parse an owner artifact before durable import
- **THEN** owner surfaces SHOULD preview accepted, duplicate, skipped, failed,
  event-time range, and gap facts before commit
- **AND** the preview SHALL be generated from the same connector/runtime facts
  used by the eventual receipt.

#### Scenario: Acquisition batch is committed

- **WHEN** an acquisition batch commits records
- **THEN** owner surfaces SHALL be able to show a receipt naming the source,
  acquisition method, event-time range, count summary, and any advisory gaps
- **AND** the receipt SHALL NOT claim full-source completeness unless the batch
  evidence supports that claim.

### Requirement: Dashboard, CLI, and owner API SHALL share acquisition coverage projection

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same
connection-health and acquisition-coverage projection for owner-visible coverage
states. They SHALL NOT independently infer whether owner-artifact, device-sync,
device-backup, or browser-polyfill coverage is complete.

#### Scenario: Same source is viewed in dashboard and CLI

- **WHEN** the owner views a manual/exported-data source in the dashboard and CLI
- **THEN** both surfaces SHALL derive covered-through timestamp, partial
  coverage, duplicate-import, and missing-media status from the same projection
- **AND** differences in copy or layout SHALL NOT change the underlying state.

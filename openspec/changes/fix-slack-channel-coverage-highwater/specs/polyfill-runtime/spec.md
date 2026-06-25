## ADDED Requirements

### Requirement: Connectors SHALL surface previously observed source partitions that disappear from the current collection boundary

When a connector collects an append-only stream from source partitions that can appear independently, the connector SHALL NOT report a clean successful run when a previously observed partition is absent from the current source inventory. The connector SHALL emit an explicit bounded diagnostic identifying the missing partition and affected stream.

#### Scenario: Previously observed partition disappears

- **WHEN** a connector's prior state records that a source partition was observed
- **AND** the current run can enumerate the source partition inventory
- **AND** that partition is absent from the current inventory
- **THEN** the connector SHALL emit a bounded diagnostic for the affected stream
- **AND** the diagnostic SHALL identify the partition key without exposing record content
- **AND** the run SHALL NOT be indistinguishable from a clean complete run with no coverage gaps

#### Scenario: Prior partition remains present

- **WHEN** a connector's prior state records that a source partition was observed
- **AND** the current run enumerates that same partition in the source inventory
- **THEN** the connector SHALL NOT emit a missing-partition diagnostic for that partition

### Requirement: Append-only partitioned streams SHALL use partition-aware high-water state

When an append-only stream is collected from multiple source partitions whose histories can resume, backfill, or reappear independently, the connector SHALL track high-water state per partition. A connector MAY retain a legacy global high-water cursor as a compatibility fallback, but SHALL NOT rely on a single global high-water as the only cursor for future runs.

#### Scenario: Partition has its own cursor

- **WHEN** a connector has prior high-water state for a source partition
- **THEN** the connector SHALL use that partition's high-water when deciding which records from that partition are new
- **AND** another partition's higher timestamp SHALL NOT cause this partition's records to be skipped

#### Scenario: Legacy global cursor exists without a partition cursor

- **WHEN** prior state contains a legacy global high-water
- **AND** no high-water exists for the current source partition
- **THEN** the connector MAY use the legacy global high-water as a fallback
- **AND** it SHALL persist partition-aware high-water state for observed partitions on completion

### Requirement: Owner-triggered connector runs SHALL preserve stream resource scopes

When an owner-triggered connector run supplies per-stream resource identifiers, the reference runtime SHALL preserve those identifiers in the connector `START.scope`. The run SHALL NOT widen a resource-scoped request into an unscoped connector run.

#### Scenario: Targeted stream resource run

- **WHEN** an owner-triggered run is requested with a stream resource list
- **THEN** the controller SHALL pass those resources to the runtime scope for that stream
- **AND** the runtime SHALL include those resources in the connector `START.scope`
- **AND** the connector SHALL collect only records within that resource boundary for streams that implement resource filtering

#### Scenario: Resource boundary is a manifest-declared record field

- **WHEN** a stream declares `selection.resource_field`
- **AND** an owner-triggered run supplies resources for that stream
- **AND** the connector emits a record whose key is not one of those resources but whose declared resource field is one of those resources
- **THEN** the runtime SHALL accept the record as inside the declared resource boundary
- **AND** the runtime SHALL continue rejecting records that match neither the key nor the declared resource field

#### Scenario: Invalid or empty resource shape

- **WHEN** an owner-triggered run request supplies resources that are not an object keyed by stream with non-empty string-array values
- **THEN** the run request SHALL be rejected
- **AND** the connector SHALL NOT start

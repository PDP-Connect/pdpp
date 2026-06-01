## ADDED Requirements

### Requirement: Dashboard health summaries SHALL expose degraded work

Owner dashboard summaries that roll up connection health SHALL include degraded or cooling-off connection projections in an attention-visible summary bucket. A dashboard SHALL NOT present a zero attention-relevant summary while visible connection cards are degraded, cooling off, or have stalled local-device work.

#### Scenario: Degraded card appears in the list

- **WHEN** a connection card renders with dominant state `degraded`
- **THEN** the dashboard summary SHALL include that connection in an attention-visible count or a distinct degraded count
- **AND** the summary SHALL NOT imply that no operator-relevant work exists

#### Scenario: Local outbox is stalled

- **WHEN** a local-device connection projects stalled outbox work
- **THEN** the dashboard summary SHALL make that stalled/degraded state visible without reclassifying it as a scheduler failure

### Requirement: Dashboard connection counts SHALL name their population

Owner dashboard connection count labels SHALL identify whether they count all registered connections or only connections with durable progress. Registered connections with no data SHALL remain visible as their own population when they are excluded from the primary count.

#### Scenario: Registered no-data connections exist

- **WHEN** the owner has connections with durable progress and registered connections with no durable records
- **THEN** the dashboard summary SHALL avoid labeling only the durable-progress subset as all `Connections`
- **AND** the no-data population SHALL remain separately visible or included in a clear total/breakdown

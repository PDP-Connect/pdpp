## ADDED Requirements

### Requirement: ChatGPT connector SHALL prefer bounded batch detail hydration with per-id fallback

The ChatGPT connector SHALL hydrate listed conversation detail by using the provider batch conversation-detail endpoint when available. A batch request SHALL include at most 10 conversation ids. The connector SHALL preserve the existing per-id `GET /conversation/{id}` detail path as a fallback for ids omitted from the batch response and for batch endpoint unavailability.

This is a first-party connector implementation requirement, not a PDPP Core or Collection Profile protocol requirement.

#### Scenario: Batch detail hydrates all listed conversations

- **WHEN** the ChatGPT connector lists conversations that require detail hydration
- **AND** the batch endpoint returns detail objects for all requested ids
- **THEN** the connector SHALL process those detail objects through the same parser used by the per-id detail path
- **AND** it SHALL NOT call the per-id detail endpoint for those ids

#### Scenario: Batch response omits some ids

- **WHEN** the batch endpoint returns detail objects for only a subset of the requested ids
- **THEN** the connector SHALL fetch each omitted id through the existing per-id detail endpoint
- **AND** it SHALL NOT treat omission from the batch response as a terminal record loss

#### Scenario: Batch endpoint is unavailable

- **WHEN** the batch endpoint fails in a way that makes the batch result unavailable for a chunk
- **THEN** the connector SHALL fall back to the existing per-id detail endpoint for that chunk
- **AND** existing retry, run-budget, source-pressure, and DETAIL_GAP handling SHALL remain the correctness boundary

#### Scenario: Batch requests respect the provider cap

- **WHEN** more than 10 conversation ids require detail hydration
- **THEN** the connector SHALL split them into chunks of at most 10 ids per batch request
- **AND** it SHALL NOT send a batch request containing more than 10 ids

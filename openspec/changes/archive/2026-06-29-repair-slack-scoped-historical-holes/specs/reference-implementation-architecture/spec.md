## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit

Debugging, replay, trace, projection, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

Slack `messages.resources` scoped runs SHALL treat the scoped Slack source archive as a repair boundary. For those scoped repair runs, the Slack connector SHALL NOT filter scoped archive message rows by the saved `messages.channel_last_ts` cursor. Normal unscoped Slack runs SHALL continue to use per-channel message cursors for incremental emission.

#### Scenario: Scoped Slack repair emits historical holes

- **WHEN** a Slack `messages.resources` scoped run reads a scoped source archive containing a message row older than that channel's saved `channel_last_ts`
- **THEN** the connector SHALL emit that message row for retained-record ingest
- **AND** it SHALL advance the channel cursor to the maximum timestamp seen in the scoped archive

#### Scenario: Normal Slack incremental runs keep cursor filtering

- **WHEN** an unscoped Slack messages run has saved per-channel message cursors
- **THEN** the connector SHALL filter message rows using those per-channel cursors
- **AND** it SHALL NOT replay historical rows below the cursor as part of the normal incremental path

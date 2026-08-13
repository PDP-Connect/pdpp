## MODIFIED Requirements

### Requirement: Checkpoints are destination-confirmed for retryable work
The reference implementation SHALL commit connection progress only when the records, gaps, blobs, and other effects that justify that progress have been durably accepted by the destination or represented as durable accepted gaps or recoverable permanent-rejection quarantine entries. Source-observed cursors and connector-emitted state SHALL be staged progress until that condition holds. A counter, log line, timeline event, or hash without the recoverable rejected input SHALL NOT justify progress past a permanently rejected record.

#### Scenario: Records are queued but not acknowledged
- **WHEN** records for a connection are queued or emitted but not yet acknowledged by the reference server
- **THEN** the committed checkpoint for the related boundary SHALL NOT advance past those unacknowledged records

#### Scenario: Required detail cannot be collected but gap is durable
- **WHEN** required detail cannot be collected and the connector records a durable retryable gap that is accepted by reference policy
- **THEN** the reference implementation MAY advance the list-level or boundary checkpoint only according to the accepted gap semantics
- **AND** the operator console SHALL continue to show the outstanding gap until recovered, accepted, or terminal

#### Scenario: Submitted record is permanently rejected
- **WHEN** the hosted destination classifies a submitted record as permanently invalid
- **THEN** connection progress MAY advance past that record only after the exact bounded input is durably retained as an owner-bound recoverable quarantine entry
- **AND** the owner inspection surface SHALL continue to expose the pending recovery item until a later accepted resolution change or connection deletion removes it

#### Scenario: Rejection evidence is not recoverable
- **WHEN** the destination has only a rejected count, error message, event, or payload digest for a permanently rejected record
- **THEN** the committed checkpoint SHALL NOT advance past that record

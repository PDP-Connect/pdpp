## ADDED Requirements

### Requirement: Bounded runs SHALL record recoverable detail gaps before committing list progress
The reference implementation SHALL NOT durably advance list-level cursor progress past required connector detail whose content is unknown unless the missing detail is durably recorded as an explicit recoverable detail gap or backlog entry. The gap record SHALL include enough safe targeting information for a later run to retry the missing detail without replaying the full committed list tranche.

#### Scenario: Required detail exhausts recoverable pressure
- **WHEN** a connector enumerates a list cursor tranche and a required detail fetch for one listed item exhausts recoverable upstream pressure
- **THEN** the run MAY commit list-level cursor progress only if the missing detail is durably recorded as a pending recoverable detail gap before checkpoint commit
- **AND** the connector SHALL NOT emit a placeholder record that represents the required detail as complete

#### Scenario: Required detail is missing without a durable gap
- **WHEN** a bounded run reaches checkpoint commit with list-level progress that covers an item whose required detail was neither emitted nor durably recorded as a recoverable gap
- **THEN** the runtime SHALL reject the commit or fail the run
- **AND** the main cursor SHALL NOT advance past that item

#### Scenario: Optional detail is skipped
- **WHEN** a connector skips detail that the stream semantics treat as optional
- **THEN** the skip SHALL be explicit in connector output or reference observability
- **AND** the runtime SHALL NOT treat that optional skip as a required-detail recoverable gap

### Requirement: Detail-gap recovery SHALL target backlog before full-tranche replay
The reference implementation SHALL use durable detail-gap backlog entries to recover missing required detail for already-committed list cursor boundaries without requiring ordinary forward collection to replay the entire original list tranche.

#### Scenario: A future run sees pending gaps
- **WHEN** a future run starts for the same source and scope as pending detail gaps
- **THEN** the reference runtime or connector orchestration SHALL make those gaps available for targeted recovery before or alongside ordinary forward list collection
- **AND** recovery SHALL use the connector's normal retry, adaptive lane, pacing, and cancellation controls for that upstream detail bucket

#### Scenario: Gap recovery succeeds
- **WHEN** targeted recovery fetches the missing required detail
- **THEN** the connector SHALL emit the real hydrated record
- **AND** the reference implementation SHALL mark the corresponding gap as recovered only after the record is durably accepted

#### Scenario: Gap recovery exhausts retry again
- **WHEN** targeted recovery again exhausts recoverable upstream pressure
- **THEN** the reference implementation MAY keep the gap pending with updated attempt metadata and a bounded next-attempt time
- **AND** it SHALL NOT fabricate complete data or clear the backlog entry without successful recovery or explicit terminal evidence

### Requirement: Detail-gap state SHALL remain reference-only until promoted
Connector detail-gap backlog storage, recovery scheduling, and observability SHALL be treated as reference-only behavior for the first implementation tranche. This behavior SHALL NOT be presented as a Collection Profile protocol requirement unless a later OpenSpec change and root protocol update promote a standard wire contract.

#### Scenario: Reference observability exposes gaps
- **WHEN** `_ref` timelines, summaries, or diagnostics expose detail-gap state
- **THEN** those artifacts SHALL be labeled reference-only
- **AND** they SHALL distinguish pending, recovered, and terminal gaps from fully collected records

#### Scenario: A protocol reader reviews Collection Profile semantics
- **WHEN** a reviewer asks whether detail-gap backlog entries are required Collection Profile messages or fields
- **THEN** the reference documentation SHALL state that they are not normative Collection Profile protocol in this tranche
- **AND** it SHALL identify any connector/runtime reporting mechanism as internal reference behavior
- **AND** portable connectors and protocol readers SHALL NOT rely on the reference `DETAIL_GAP` signal, backlog schema, or cursor interpretation unless a later root protocol change promotes an explicit wire contract

#### Scenario: Gap metadata is stored or displayed
- **WHEN** the reference stores or displays detail-gap locators, reasons, or errors
- **THEN** it SHALL avoid bearer tokens, cookies, secret-bearing URLs, request bodies, and raw private payloads
- **AND** it SHALL store only the safe targeting information needed for recovery and auditability

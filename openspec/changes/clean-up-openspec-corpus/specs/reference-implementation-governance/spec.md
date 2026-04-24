## ADDED Requirements

### Requirement: The OpenSpec corpus is periodically auditable
The repository SHALL maintain enough OpenSpec corpus hygiene that contributors can determine current active work, durable requirements, and non-canonical design questions without reconstructing chat history.

#### Scenario: A contributor lists active OpenSpec changes
- **WHEN** a contributor runs `openspec list`
- **THEN** every active change SHALL have a clear next action
- **AND** completed, superseded, or parked work SHALL NOT appear active without an explicit status explanation

#### Scenario: A contributor reviews canonical specs
- **WHEN** a contributor opens `openspec/specs/`
- **THEN** those specs SHALL represent durable accepted requirements rather than a partial archive of whichever changes happened to be archived

#### Scenario: A cleanup pass finds stale OpenSpec content
- **WHEN** an audit finds stale tasks, superseded proposals, missing purpose text, or design notes that conflict with code/tests/specs
- **THEN** the cleanup SHALL either correct the artifact, mark it superseded/deferred, or create a follow-up OpenSpec change

### Requirement: Design-note triage produces actionable status
Design-note cleanup SHALL classify notes or coherent note clusters by lifecycle status before moving, deleting, or promoting them.

#### Scenario: A design-note cluster is still important
- **WHEN** a design-note cluster still informs a future durable behavior decision
- **THEN** the cleanup SHALL classify it as `promote`, `sprint-needed`, or `defer`
- **AND** it SHALL record the promotion trigger or reason for deferral

#### Scenario: A design-note cluster is historical
- **WHEN** a design-note cluster has been absorbed by code, tests, canonical specs, or archived changes
- **THEN** the cleanup SHALL classify it as `superseded`, `historical`, or `connector-background`
- **AND** it SHALL stop being referenced as current execution truth

### Requirement: Corpus cleanup does not hide implementation work
OpenSpec corpus cleanup SHALL not silently implement runtime behavior, change protocol semantics, or delete useful historical context without a replacement reference.

#### Scenario: A cleanup task discovers required runtime work
- **WHEN** cleanup discovers that code behavior must change
- **THEN** that work SHALL be split into a separate implementation task or OpenSpec change before code is modified

#### Scenario: A cleanup task removes or archives a note
- **WHEN** cleanup archives, supersedes, or moves a design note
- **THEN** important decisions or links from that note SHALL remain discoverable through an index, canonical spec, archived change, or replacement design note

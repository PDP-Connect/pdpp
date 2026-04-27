## ADDED Requirements

### Requirement: Agent assistants SHALL use scoped client grants instead of owner tokens

The reference implementation SHALL provide a documented agent access workflow in which coding agents request and use scoped PDPP client grants rather than owner bearer tokens for routine data access.

#### Scenario: Agent requests data access
- **WHEN** an agent needs PDPP data for a user task
- **THEN** it SHALL request a client grant scoped to the needed source, streams, fields/views, time range, retention, and access mode
- **AND** it SHALL NOT ask the user for an owner bearer token as the default path

#### Scenario: Agent needs broader access later
- **WHEN** an existing grant is insufficient for a later task
- **THEN** the agent SHALL request an explicit upgrade or additional grant
- **AND** it SHALL NOT silently broaden access or fall back to owner authority

### Requirement: The CLI SHALL make owner approval link-based and inspectable

The reference CLI SHALL let an agent create a pending grant request and communicate an owner approval URL and/or verification code that the owner can complete in a browser.

#### Scenario: Approval is needed
- **WHEN** an agent starts a grant request from a terminal or coding-agent session
- **THEN** the CLI SHALL display an approval URL and the requested access summary
- **AND** the CLI MAY open a browser when configured
- **AND** the agent SHALL be able to relay that URL to the user without receiving the owner credential

#### Scenario: Approval is denied or expires
- **WHEN** the owner denies the request or the pending request expires
- **THEN** the CLI SHALL report a non-secret failure reason
- **AND** it SHALL NOT write a usable token cache entry

### Requirement: Agent grant credentials SHALL be cached locally with least-surprise safety

The reference CLI SHALL store agent grant credentials in a project-local ignored cache by default and SHALL keep secret values out of prompts, logs, tracked files, and status output.

#### Scenario: Grant is approved
- **WHEN** the owner approves a grant request for an agent client
- **THEN** the CLI SHALL persist token metadata and the client token in the project-local cache
- **AND** the persisted metadata SHALL include enough non-secret scope information for status and renewal decisions

#### Scenario: Status is printed
- **WHEN** the agent or user inspects grant status
- **THEN** the CLI SHALL show the grant's source, streams, fields/views, time range, purpose, expiry, and revocation state
- **AND** it SHALL NOT print bearer token material

### Requirement: The agent-facing skill SHALL teach effective PDPP data consumption

The repository SHALL provide an agent-facing skill that teaches agents how to discover, request, cache, use, renew, and revoke PDPP grants while consuming data efficiently and safely.

#### Scenario: A fresh agent uses the skill
- **WHEN** an agent starts from only AS/RS URLs and no token
- **THEN** the skill SHALL direct it to discover metadata and `/v1/schema` before guessing endpoints
- **AND** it SHALL direct it to request a narrow client grant when data access is needed

#### Scenario: A grant-bound agent queries data
- **WHEN** an agent has a client token
- **THEN** the skill SHALL prefer declared capabilities such as filtered retrieval, `changes_since`, record pagination, blobs via `blob_ref.fetch_url`, and aggregations
- **AND** it SHALL warn against broad unbounded scans when narrower capability-backed queries can answer the task

### Requirement: The reference SHALL publish agent skill discovery surfaces

The reference web app SHALL expose stable, machine-readable discovery surfaces for the `pdpp-data-access` skill so third-party coding agents can find the skill without receiving an owner bearer token or guessing repo paths.

#### Scenario: Agent discovers the skill catalog
- **WHEN** an agent fetches `/.well-known/skills/index.json`
- **THEN** the response SHALL list the `pdpp-data-access` skill and every served skill file
- **AND** each file entry SHALL include an allowlisted path, repository path, media type, byte length, SHA-256 digest, and absolute URL
- **AND** the file-serving route SHALL NOT expose arbitrary repository files outside the allowlist

#### Scenario: Agent reads LLM discovery files
- **WHEN** an agent fetches `/llms.txt`
- **THEN** the response SHALL point at the skill catalog and primary `SKILL.md`
- **AND** when an agent fetches `/llms-full.txt`
- **THEN** the response SHALL include the full `pdpp-data-access` skill and reference content

#### Scenario: Agent follows the distributed skill
- **WHEN** an agent uses the distributed `pdpp-data-access` skill
- **THEN** the skill SHALL prefer the `pdpp agent` CLI workflow over raw HTTP
- **AND** it SHALL describe that `pdpp agent wait` polls only the local cache and does not contact the AS
- **AND** it SHALL describe that `pdpp agent use` rejects missing, expired, and locally revoked grants

### Requirement: Protocol-candidate semantics SHALL remain explicitly proposed

Agent access workflow behavior that would change PDPP core authorization, grant semantics, or any companion spec SHALL be labeled proposed or experimental until separately accepted by the normative spec process.

#### Scenario: A reference implementation field becomes necessary
- **WHEN** implementation requires a new request or response field beyond the current public contract
- **THEN** the change SHALL identify whether the field is reference-only, experimental, or a candidate for a root PDPP/companion spec
- **AND** it SHALL NOT present that field as finalized PDPP normativity in this OpenSpec change

# reference-implementation-governance Specification

## Purpose
Define how this repository uses OpenSpec relative to the normative PDPP protocol specs, executable reference code, and temporary planning artifacts.
## Requirements
### Requirement: Authority order stays explicit
This repository SHALL treat the root PDPP spec files as normative for protocol behavior, code and tests as authoritative for current reference implementation behavior, and OpenSpec as the project layer for reference architecture and change planning.

#### Scenario: Protocol semantics are in question
- **WHEN** a contributor needs to determine the normative meaning of grants, queries, authorization metadata, collection behavior, or other PDPP protocol semantics
- **THEN** they SHALL use the root PDPP spec files as the authority rather than OpenSpec or ad hoc planning notes

#### Scenario: Current implementation behavior is in question
- **WHEN** a contributor needs to determine what the reference implementation currently does
- **THEN** they SHALL treat code and executable tests as authoritative and SHALL update planning artifacts if those artifacts lag behind the implementation

### Requirement: OpenSpec does not compete with the PDPP protocol specs
OpenSpec artifacts in this repository SHALL describe reference-implementation architecture, project-scoped boundaries, and active changes without restating PDPP core semantics as competing normative text.

#### Scenario: A protocol change is proposed
- **WHEN** a change alters normative PDPP protocol behavior
- **THEN** the change SHALL update the relevant root PDPP spec file and OpenSpec SHALL reference that source instead of becoming a second normative protocol specification

#### Scenario: OpenSpec needs protocol context
- **WHEN** an OpenSpec artifact depends on PDPP protocol semantics
- **THEN** it SHALL cite the relevant root PDPP spec file or section instead of duplicating that normative content in full

### Requirement: OpenSpec is reserved for durable project work
OpenSpec SHALL be used for cross-cutting architectural work, public/reference contract changes, and multi-step implementation tranches, while scratch notes, transient debugging output, and tiny obvious fixes SHALL not require OpenSpec artifacts.

#### Scenario: Cross-cutting reference work
- **WHEN** work changes the reference implementation architecture, native-versus-polyfill boundaries, provider-connect profile, CLI contract, event spine, or another cross-cutting reference surface
- **THEN** that work SHALL be captured through OpenSpec specifications or changes

#### Scenario: Narrow local fix
- **WHEN** work is a tiny obvious local fix that does not materially change a public/reference contract or durable project decision
- **THEN** it MAY proceed without a dedicated OpenSpec change

### Requirement: Temporary planning notes are not authoritative
Inbox memos, scratch notes, and other temporary planning artifacts MAY exist during exploration, but they SHALL not become an authoritative source once the relevant decision is captured in OpenSpec, code, tests, or the root PDPP specs.

#### Scenario: A working memo and OpenSpec disagree
- **WHEN** an inbox memo or other temporary planning artifact conflicts with OpenSpec, executable behavior, or the root PDPP specs
- **THEN** contributors SHALL treat the memo as stale and correct or ignore it rather than steering implementation from that stale note

#### Scenario: A working memo has been absorbed
- **WHEN** the substance of a temporary planning note has been incorporated into OpenSpec, code, tests, or the root PDPP specs
- **THEN** contributors SHOULD stop extending that temporary note as an active source of execution truth

#### Scenario: Active execution planning continues
- **WHEN** work continues on a cross-cutting implementation tranche after an OpenSpec change exists for that tranche
- **THEN** contributors SHALL extend the relevant OpenSpec change rather than creating new inbox memos as the primary execution-planning layer

### Requirement: Supplemental project notes stay clearly non-canonical
This repository MAY surface change-local supplemental notes to help contributors and partners review the project, but those notes SHALL be clearly distinguished from official OpenSpec artifacts.

#### Scenario: The website renders change-local notes
- **WHEN** `apps/web` or another repository surface renders markdown from `openspec/changes/*/design-notes/`
- **THEN** that surface SHALL label those documents as supplemental project notes rather than as official change artifacts
- **AND** it SHALL continue to distinguish official change artifacts (`proposal.md`, `design.md`, `tasks.md`, and `specs/**`) from the supplemental note layer

#### Scenario: A supplemental note conflicts with canonical artifacts
- **WHEN** a supplemental project note conflicts with an official OpenSpec artifact, executable behavior, or the root PDPP specs
- **THEN** contributors SHALL treat the supplemental note as stale context rather than as execution truth

### Requirement: OpenSpec changes follow a complete lifecycle
The repository SHALL treat OpenSpec changes as lifecycle artifacts that move from proposal, to implementation, to archival or explicit retirement. Active changes SHALL NOT be left ambiguous about whether they are proposed, in implementation, ready to archive, parked, or superseded.

#### Scenario: A non-trivial durable change starts
- **WHEN** work changes a public or reference contract, architecture boundary, new dependency, durable behavior, or multi-step implementation plan
- **THEN** contributors SHALL create or update an OpenSpec change before treating implementation as approved
- **AND** that change SHALL include a proposal, tasks, and requirement deltas unless the work is explicitly tooling-only and uses `--skip-specs` on archive

#### Scenario: Implementation discovers new facts
- **WHEN** implementation changes the intended design, risk model, or acceptance criteria of an active OpenSpec change
- **THEN** contributors SHALL update the active OpenSpec artifacts instead of relying only on chat history, commit messages, or supplemental notes

#### Scenario: A change is accepted
- **WHEN** an OpenSpec change has been implemented, verified, and accepted by the owner
- **THEN** contributors SHOULD archive it promptly so `openspec/specs/` reflects the durable source of truth

#### Scenario: A change is superseded or parked
- **WHEN** an OpenSpec change is no longer the intended path or is intentionally deferred
- **THEN** contributors SHALL mark that state clearly in the change artifacts or remove/archive it through an explicit cleanup action

### Requirement: Design notes are disciplined requirements-discovery artifacts
Design notes SHALL be used only for discovery, research, options, unresolved questions, and decision records that are not yet ready to become official OpenSpec deltas or root PDPP spec changes. Design notes SHALL remain non-canonical supplemental artifacts.

#### Scenario: A question is discovered during implementation
- **WHEN** a contributor discovers a potentially important design question that should not interrupt the current implementation
- **THEN** they MAY capture it in a design note with status, owner, question, context, stakes, current leaning, promotion trigger, and decision log
- **AND** they SHALL NOT treat that note as permission to implement a durable behavior before the question is promoted or decided

#### Scenario: A design question controls durable behavior
- **WHEN** a design note's answer would change a protocol surface, reference contract, architecture boundary, security posture, storage model, user-facing behavior, or multi-step implementation tranche
- **THEN** the question SHALL be promoted into an OpenSpec change or root PDPP spec change before implementation proceeds

#### Scenario: A design note becomes stale
- **WHEN** code, tests, canonical OpenSpec specs, or root PDPP specs resolve or contradict a design note
- **THEN** contributors SHALL treat the note as stale context and update its status or link to the artifact that supersedes it

#### Scenario: A design note is created or next touched
- **WHEN** a contributor creates a design note or materially edits an existing active-intake design note
- **THEN** the note SHALL use the canonical header shape defined by `design-notes/README.md`
- **AND** legacy ad-hoc headers SHALL be normalized at next touch when the note remains active intake

### Requirement: Official OpenSpec artifacts remain concise and parseable
Official OpenSpec artifacts SHALL stay focused on the role OpenSpec expects: proposals state why and what, design documents state rationale and tradeoffs, tasks track implementation and validation, and spec files define normative requirements with scenarios.

#### Scenario: A spec file is edited
- **WHEN** a contributor edits `openspec/specs/**/spec.md` or a change delta under `openspec/changes/*/specs/**/spec.md`
- **THEN** each requirement SHALL use normative language
- **AND** each requirement SHALL include at least one scenario
- **AND** the spec file SHALL NOT contain implementation journals, task lists, scratch notes, or unresolved brainstorming

#### Scenario: A task list is handed off
- **WHEN** a contributor hands off or reports completion of an OpenSpec-backed implementation
- **THEN** `tasks.md` SHALL reflect actual progress
- **AND** incomplete items SHALL be either still actionable, explicitly deferred, or moved to a follow-up change rather than left as stale unchecked history

#### Scenario: Supplemental notes are rendered or linked
- **WHEN** a repository UI, documentation page, or agent prompt references `design-notes/` content
- **THEN** it SHALL label those notes as supplemental non-canonical context
- **AND** it SHALL direct readers to OpenSpec specs, active changes, root PDPP specs, code, and tests for execution truth

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

### Requirement: Releases are created by semantic-release

The repository SHALL use semantic-release to create durable public releases from
the default branch using Conventional Commits.

#### Scenario: A release-worthy commit reaches the default branch
- **WHEN** CI runs release automation for `main` and semantic-release determines
  that commits since the last release require a new version
- **THEN** CI SHALL create a GitHub release
- **AND** CI SHALL create a `v${version}` git tag for that release

#### Scenario: No release-worthy commit reaches the default branch
- **WHEN** CI runs release automation for `main` and semantic-release determines
  that no new version is required
- **THEN** CI SHALL complete without creating a GitHub release
- **AND** CI SHALL NOT publish release image tags

#### Scenario: A repository release version is published
- **WHEN** semantic-release publishes a repository version
- **THEN** that version SHALL NOT imply a new PDPP protocol version unless a
  protocol-version change is explicitly included in the relevant protocol
  artifacts

### Requirement: Release Docker images are published from the release workflow

The repository SHALL publish stable public Docker image tags as part of the
successful semantic-release workflow rather than relying on a second workflow
being triggered by the semantic-release-created tag.

#### Scenario: Semantic-release publishes a release
- **WHEN** semantic-release publishes a new release version
- **THEN** CI SHALL publish the supported reference Docker image targets to GHCR
- **AND** the published tags SHALL include the exact version tag, a moving
  major-minor tag, `latest`, and a commit SHA tag

#### Scenario: Release image validation fails
- **WHEN** the Docker targets do not build successfully before the release job
  runs
- **THEN** CI SHALL fail before semantic-release creates the GitHub release
- **AND** CI SHALL NOT publish release image tags

#### Scenario: Pull request CI builds Docker targets
- **WHEN** Docker-relevant files change in a pull request
- **THEN** CI SHALL build the supported Docker targets for validation
- **AND** CI SHALL NOT run semantic-release or publish Docker images from the
  pull request

### Requirement: Release automation keeps secrets out of source and images

Release automation SHALL use CI-provided credentials for GitHub release and GHCR
publication and SHALL NOT require release secrets to be committed or baked into
Docker layers.

#### Scenario: A release workflow runs
- **WHEN** CI creates a GitHub release or publishes Docker images
- **THEN** the workflow SHALL use GitHub Actions credentials or repository
  secrets scoped to CI
- **AND** committed files SHALL NOT contain release tokens, registry passwords,
  owner passwords, connector credentials, SQLite data, embedding cache contents,
  or browser profile state

#### Scenario: A maintainer checks release behavior locally
- **WHEN** a maintainer runs the documented semantic-release dry run
- **THEN** the command SHALL preview release calculation without publishing a
  GitHub release or Docker images

### Requirement: Connector fixtures SHALL be privacy-scrubbed before commit
First-party connector fixtures derived from real owner captures SHALL be scrubbed before they are committed. Raw captures SHALL remain ignored or otherwise excluded from version control.

#### Scenario: A worker captures a real connector response
- **WHEN** a worker captures DOM, API JSON, JSONL, screenshots, or exported files from a real owner account
- **THEN** the raw capture SHALL NOT be committed
- **AND** any committed fixture derived from it SHALL pass the project scrubber pipeline or an equivalent reviewed redaction process

### Requirement: Scrubbed fixtures SHALL preserve parser-relevant structure
Scrubbed fixtures SHALL preserve the structural fields, selectors, object shapes, and non-sensitive values needed for parser regression tests while replacing private owner data with stable placeholders.

#### Scenario: A parser depends on a DOM selector
- **WHEN** a scrubbed HTML fixture is generated
- **THEN** the selector structure needed by the parser SHALL remain intact
- **AND** sensitive text content SHALL be replaced without breaking the parser's traversal path


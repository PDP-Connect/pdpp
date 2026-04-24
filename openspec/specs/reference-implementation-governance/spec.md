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


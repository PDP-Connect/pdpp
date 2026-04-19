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

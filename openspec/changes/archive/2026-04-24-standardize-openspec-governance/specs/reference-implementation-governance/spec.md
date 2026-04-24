## ADDED Requirements

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

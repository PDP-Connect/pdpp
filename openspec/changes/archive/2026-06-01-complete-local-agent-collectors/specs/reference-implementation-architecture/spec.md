## MODIFIED Requirements

### Requirement: The Collection boundary stays explicit
The reference implementation SHALL keep the Collection boundary explicit across core semantics, Collection Profile semantics, and runtime-only behavior.

#### Scenario: Shared collection semantics are classified
- **WHEN** behavior concerns RECORD envelopes, streams, scope, tombstones, or state/checkpoint semantics shared across collection and disclosure paths
- **THEN** those semantics SHALL be treated as core/shared semantics rather than as ad hoc runtime details

#### Scenario: Bounded-run collection behavior is classified
- **WHEN** behavior concerns START, INTERACTION, RECORD, STATE, DONE, binding matching, or run-scoped lifecycle rules for collected/polyfill sources
- **THEN** that behavior SHALL be treated as Collection Profile behavior rather than as native-provider contract surface

#### Scenario: Orchestrator behavior is classified
- **WHEN** behavior concerns scheduling, retry, credential storage, webhook adaptation, batch import, or multi-connector coordination
- **THEN** it SHALL be treated as runtime/orchestrator behavior unless and until a concrete interoperability need justifies a new profile

#### Scenario: Local collector completeness is classified
- **WHEN** behavior concerns local Claude Code or Codex source-home inventory, privacy classification, coverage diagnostics, auth-adjacent exclusions, or multi-device source-home binding
- **THEN** it SHALL be treated as reference runtime/orchestrator behavior unless and until a concrete interoperability need promotes it into Collection Profile vocabulary
- **AND** the reference SHALL NOT describe 100% local Claude Code or Codex collection as a PDPP Core Resource Server requirement

#### Scenario: Local source homes require connector instances
- **WHEN** the reference accepts local collector data from a Claude Code or Codex source home
- **THEN** the source home SHALL resolve to a connector instance before records, blobs, state, schedules, run leases, diagnostics, or owner actions are written
- **AND** `connector_id` alone SHALL NOT be used as the durable runtime key for local collection from multiple devices or source homes

#### Scenario: The reference makes an optimistic collection choice before the spec is fully frozen
- **WHEN** the reference implementation enforces a strong Collection Profile behavior before the PDPP spec is fully settled
- **THEN** that behavior SHALL be labeled as either an interoperability requirement to be pushed into the Collection Profile spec or as a reference-only choice that does not yet claim normative status

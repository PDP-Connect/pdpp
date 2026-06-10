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

#### Scenario: Multi-instance connector orchestration is classified
- **WHEN** the reference distinguishes two configured accounts, devices, or local bindings that share the same connector implementation
- **THEN** connector instance identity SHALL be treated as reference runtime/orchestrator identity unless and until a concrete interoperability need promotes it into a Collection Profile or PDPP protocol surface
- **AND** the reference SHALL NOT use `connector_id` alone as the durable runtime key for state, records, schedules, active-run leases, diagnostics, or owner actions

#### Scenario: Default connector-only compatibility has been migrated away
- **WHEN** the reference needs a default configured connection for a connector-only historical deployment
- **THEN** it SHALL represent that default as a normal connector instance with `source_kind = "account"` and `source_binding.kind = "default_account"`
- **AND** it SHALL NOT create, expose, or require connector instances with `source_kind = "legacy"` or `source_binding.kind = "legacy_default"`
- **AND** migrations SHALL rewrite existing direct `connector_instance_id` references from the old compatibility id to the deterministic default account connection id without dropping records, state, schedules, search rows, blobs, gaps, or attention records

#### Scenario: The reference makes an optimistic collection choice before the spec is fully frozen
- **WHEN** the reference implementation enforces a strong Collection Profile behavior before the PDPP spec is fully settled
- **THEN** that behavior SHALL be labeled as either an interoperability requirement to be pushed into the Collection Profile spec or as a reference-only choice that does not yet claim normative status

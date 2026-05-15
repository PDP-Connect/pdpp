## MODIFIED Requirements

### Requirement: The Collection boundary stays explicit
The reference implementation SHALL keep the Collection boundary explicit across core semantics, Collection Profile semantics, and runtime-only behavior.

#### Scenario: Orchestrator behavior is classified
- **WHEN** behavior concerns scheduling, retry, credential storage, webhook adaptation, batch import, or multi-connector coordination
- **THEN** it SHALL be treated as runtime/orchestrator behavior unless and until a concrete interoperability need justifies a new profile

#### Scenario: Unsafe connector refresh policy is not scheduled
- **WHEN** the reference controller or scheduler manager evaluates an enabled connector schedule
- **THEN** it SHALL NOT enable or auto-run that schedule when the connector manifest recommends manual or paused refresh
- **AND** it SHALL NOT enable or auto-run that schedule when the connector manifest declares `capabilities.refresh_policy.background_safe: false`
- **AND** disabled schedule rows MAY remain stored for operator intent without becoming eligible for automatic execution

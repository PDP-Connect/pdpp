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

#### Scenario: Not-ready runtime prerequisites are skipped automatically
- **WHEN** the scheduler evaluates an automatic connector run whose current deployment cannot satisfy required runtime prerequisites
- **THEN** it SHALL NOT start the connector process for that automatic run
- **AND** it SHALL record a skipped scheduler history entry with a clear not-ready reason
- **AND** it SHALL NOT convert that automatic skip into a failed run
- **AND** manual on-demand runs SHALL continue to surface normal connector or runtime failures instead of being hidden by the automatic scheduler readiness gate

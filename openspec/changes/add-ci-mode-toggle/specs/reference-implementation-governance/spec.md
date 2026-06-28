## ADDED Requirements

### Requirement: Repository CI mode is explicit and reversible

The repository SHALL provide an auditable switch between hosted CI enforcement and local signoff enforcement for the main-branch reference-implementation merge gate.

#### Scenario: Hosted CI is the active mode
- **WHEN** hosted CI mode is active
- **THEN** the main-branch ruleset SHALL require the hosted reference-implementation status context
- **AND** local signoff status contexts SHALL NOT be required for merge

#### Scenario: Local signoff is the active mode
- **WHEN** hosted CI is unavailable for infrastructure reasons and local CI mode is active
- **THEN** the main-branch ruleset SHALL require a distinct local signoff status context
- **AND** that context SHALL NOT reuse the hosted CI status name
- **AND** pull-request and non-fast-forward protections SHALL remain in force

#### Scenario: A maintainer signs off locally
- **WHEN** a maintainer posts a local CI signoff status
- **THEN** the status SHALL be attached to a specific commit SHA
- **AND** the status description or linked evidence SHALL identify that local verification, not hosted CI, produced the signoff

#### Scenario: Hosted CI is available again
- **WHEN** the hosted CI outage or local-only need has passed
- **THEN** maintainers SHALL be able to restore hosted CI mode through the same documented interface

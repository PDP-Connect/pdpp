## ADDED Requirements

### Requirement: Browser-surface substrate SHALL be isolated from reference-owned runtime integrations

The reference implementation SHALL consume backend-agnostic remote-surface lease/state-machine substrate from a private internal package. That package SHALL own remote-surface types, browser-surface lease state transitions, capacity policy, fencing tokens, queue ordering, restart reconciliation policy, and backend allocator interfaces. The package SHALL NOT import reference implementation, server, Docker, dashboard, or connector modules.

Reference-owned code SHALL continue to own persistence adapters, spine and run events, connector launch integration, Docker Compose wiring, and allocator sidecar process implementation.

#### Scenario: Reference runtime acquires a browser-surface lease

- **WHEN** reference controller code needs browser-surface lease policy
- **THEN** it SHALL use the package-backed substrate implementation
- **AND** reference-specific storage, event emission, and connector launch env assembly SHALL remain outside the package

#### Scenario: Dynamic allocator work adds backend lifecycle support

- **WHEN** dynamic n.eko allocation adds allocator lifecycle behavior
- **THEN** allocator contracts MAY be defined in the substrate package
- **AND** Docker Engine access, Compose wiring, and the allocator sidecar process SHALL remain reference-owned

#### Scenario: Package dependency boundaries are checked

- **WHEN** `packages/remote-surface` is inspected
- **THEN** it SHALL NOT import from `reference-implementation`, server modules, Docker implementation code, `apps/web`, or connector modules

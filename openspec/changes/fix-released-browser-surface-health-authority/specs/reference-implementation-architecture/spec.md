## MODIFIED Requirements

### Requirement: n.eko browser surfaces SHALL be leased before connector launch

When a connector run requires an n.eko-backed browser surface, the reference implementation SHALL acquire or queue a browser-surface lease before spawning the connector child process. The connector SHALL receive the selected surface through controller-owned launch metadata rather than discovering an arbitrary unmanaged browser surface as the production path.

Released browser-surface rows SHALL remain durable history after lease release, but that history SHALL NOT be treated as current health authority once the lease is no longer backing the surface. Current lease-backed failures and live ready-surface evidence MAY still fail closed; retired or released unleased rows SHALL NOT become the operative connection-health signal on their own.

#### Scenario: A connector run needs a browser surface

- **WHEN** a connector run requires a browser surface before connector spawn
- **THEN** the reference SHALL acquire or queue a lease before launch
- **AND** the connector SHALL receive the browser surface through controller-owned launch metadata

#### Scenario: Released browser-surface history stays historical

- **WHEN** a browser surface lease is released and the retained surface row is later marked unhealthy
- **THEN** that historical row SHALL NOT become the current authority for connection health
- **AND** the projection SHALL not use it to fail the connection unless some current lease-backed or allocatability evidence still exists

#### Scenario: Current leased failure still fails closed

- **WHEN** a browser surface has a current non-terminal lease and the live surface is unhealthy
- **THEN** the reference SHALL continue to fail closed and surface the live failure

#### Scenario: Current ready evidence outranks older unhealthy history

- **WHEN** a connector has older unhealthy browser-surface history and newer ready surface evidence
- **THEN** the projection SHALL prefer the ready current evidence
- **AND** the older history SHALL remain diagnostic only

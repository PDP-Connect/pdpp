## MODIFIED Requirements

### Requirement: Live owner-console surfaces SHALL be stateful owner/operator surfaces

The live owner-console route family SHALL be treated as stateful live-instance operation. It SHALL be owner-authenticated when owner authentication is configured, SHALL avoid static caching of live state, SHALL avoid search-engine indexing, SHALL be safe to disable on hosted public documentation deployments, and SHALL be owned by the operator-console deployable rather than the public-site deployable. Clean owner routes SHALL be the normal navigation topology. The removed `/dashboard/*` prefix SHALL NOT be preserved as a redirect, repair surface, or normal content route.

#### Scenario: Owner auth is configured

- **WHEN** owner authentication is configured for the reference instance
- **THEN** owner-console routes SHALL require owner access before exposing live records, grants, traces, runs, deployment diagnostics, or interactions

#### Scenario: Public hosted documentation is deployed

- **WHEN** the public-site deployable is deployed without an intended live reference instance
- **THEN** owner-console routes SHALL NOT be reachable from the public-site origin
- **AND** the public-site deployable SHALL build and serve without including operator-console code or a BFF to an AS/RS

#### Scenario: Operator deployment runs the console

- **WHEN** an operator runs the operator-console deployable alongside the reference-implementation AS/RS service
- **THEN** clean owner routes and the BFF/proxy routes (`/_ref/**`, `/v1/**`, `/oauth/**`, `/.well-known/**`, `/consent`, `/device`, `/owner/**`, `/__pdpp/**`, `/connectors/**`, `/neko/**`, `/agent-connect`) SHALL be owned by the operator-console deployable
- **AND** the BFF/proxy SHALL terminate at the co-deployed AS/RS over the internal operator network rather than over the public internet

#### Scenario: Removed dashboard prefix is requested

- **WHEN** a request arrives for `/dashboard` or `/dashboard/*`
- **THEN** the operator-console deployable SHALL NOT route it to an owner-console compatibility surface
- **AND** generated owner links SHALL continue to use clean owner routes directly.

## MODIFIED Requirements

### Requirement: Live dashboard surfaces SHALL be stateful owner/operator surfaces

The live owner-console route family SHALL be treated as stateful live-instance operation. It SHALL be owner-authenticated when owner authentication is configured, SHALL avoid static caching of live state, SHALL avoid search-engine indexing, SHALL be safe to disable on hosted public documentation deployments, and SHALL be owned by the operator-console deployable rather than the public-site deployable. Clean owner routes SHALL be the normal navigation topology. The removed `/dashboard/*` prefix MAY render only a bounded stale-installed-PWA repair surface and SHALL NOT be used as a normal content route.

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

#### Scenario: Stale installed PWA opens the old dashboard prefix

- **WHEN** an installed PWA opens `/dashboard` or `/dashboard/*`
- **THEN** the operator-console deployable MAY render a bounded repair page for stale launch metadata
- **AND** that repair page SHALL point to clean owner routes rather than reintroducing `/dashboard/*` as a normal route family.

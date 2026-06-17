## ADDED Requirements

### Requirement: An active account connection SHALL resolve a refresh contract from its manifest, NOT a credential

The reference implementation SHALL require every active `account` connector
instance to resolve a refresh contract from its connector manifest, derived from the
manifest's `recommended_mode` and `background_safe` refresh-policy fields. The
refresh contract SHALL be the creation/lifecycle invariant that keeps impossible
refresh configurations un-constructable. The reference implementation SHALL NOT
require an active `account` connection to hold a stored credential as a creation
invariant: an account connection MAY be active, scheduled, and collecting through
owner-assisted browser sessions with zero stored credentials, so an
`account` ⇒ `credential` invariant SHALL NOT be imposed and SHALL NOT brand such a
connection impossible.

When the resolved refresh contract is `automatic` — the manifest declares the
connector schedulable (`recommended_mode` is not `manual` or `paused` and
`background_safe` is not false) — a schedule row SHALL be attached at activation, so
an "automatic but unscheduled" account connection is un-constructable. When the
resolved refresh contract is `manual` — the manifest declares the connector
manual, paused, or background-unsafe — schedule absence SHALL NOT be treated as a
defect, but the connection SHALL be typed manual so that the connection-health
projection routes its stale freshness to an owner-refresh advisory
(`owner_refresh_due` / `stale_manual_refresh`). Stale freshness alone SHALL NOT
downgrade an otherwise healthy collection-health pill.

The refresh contract SHALL be resolved generically from the manifest refresh-policy
fields and SHALL NOT be keyed on a per-connector name branch or on credential
presence.

#### Scenario: An account connection is active with zero credentials

- **WHEN** an `account` connector instance is active, scheduled, and collecting
  through owner-assisted browser sessions with no stored credential
- **THEN** the reference SHALL treat the connection as a valid active account
  connection that resolves a refresh contract from its manifest
- **AND** it SHALL NOT require a stored credential as a creation invariant and SHALL
  NOT brand the connection impossible for lacking one.

#### Scenario: An automatic account connection has a schedule at activation

- **WHEN** an `account` connector whose manifest resolves an `automatic` refresh
  contract is activated
- **THEN** the reference SHALL attach a schedule row at activation
- **AND** an active `automatic` account connection with no attached schedule SHALL
  be un-constructable.

#### Scenario: A manual account connection is typed manual and routes stale to an advisory

- **WHEN** an `account` connector whose manifest resolves a `manual` refresh
  contract is active and its retained data has aged past its freshness window
- **THEN** schedule absence SHALL NOT be reported as a defect
- **AND** the connection SHALL be typed manual so its stale freshness routes to an
  owner-refresh advisory while the collection-health pill remains driven by
  collection health rather than by freshness alone.

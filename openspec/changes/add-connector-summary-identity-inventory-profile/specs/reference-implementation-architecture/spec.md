## MODIFIED Requirements

### Requirement: Connection-summary route supports single-connection scoping

The `GET /_ref/connectors` connection-summary route SHALL accept an optional connection-selector query parameter. When the selector is present, the route SHALL project and return only the connection the selector resolves; when it is absent, the route SHALL return summaries for all configured connections exactly as before. The scoped projection SHALL be the same per-connection projection used to build the unscoped list, so a single-connection summary cannot diverge from the connection's entry in the full list.

The selector SHALL resolve an exact match on a connection's stable connection identity (`connection_id` / `connector_instance_id`) first. If no exact identity matches, connector-id fallback MAY resolve only when exactly one configured connection uses that `connector_id`. When multiple configured connections share the connector id, the route SHALL return no scoped summary rather than silently selecting one. The route SHALL NOT introduce a new addressing scheme for connections.

The route SHALL remain owner-session-gated for both the scoped and unscoped forms, and the scoped read SHALL NOT persist a connection.

The route SHALL additionally accept an optional named `profile` query parameter selecting which dependency families the single, shared connector-summary projection loads and which fields it synthesizes for this request; the parameter SHALL compose with the connection selector, cursor, and `limit`/`connector_id` exactly as documented for each. Omitting `profile` SHALL preserve the exact full (`detail`-shaped) response documented above and elsewhere in this capability. A named profile is option-gating within the one existing projection implementation, never a second projection or a second route.

#### Scenario: Unscoped request returns all connections

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with no connection selector
- **THEN** the route SHALL return a `{object: "list", data}` envelope containing a summary for every configured connection
- **AND** the response SHALL be equivalent to the prior unscoped behavior

#### Scenario: Scoped request returns only the exact connection

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a connection selector matching a configured `connection_id` or `connector_instance_id`
- **THEN** the route SHALL return a list containing only that connection's summary
- **AND** the summary SHALL be projected through the same per-connection projector used by the unscoped list

#### Scenario: Connector-id fallback is unambiguous

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a connection selector matching a `connector_id`
- **AND** exactly one configured connection uses that connector id
- **THEN** the route MAY return a list containing that one connection's summary

#### Scenario: Connector-id fallback is ambiguous

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a connection selector matching a `connector_id`
- **AND** two or more configured connections use that connector id
- **THEN** the route SHALL return an empty list
- **AND** it SHALL NOT silently select the first matching configured connection

#### Scenario: The `identity_inventory` profile returns the pinned identity field set

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with `profile=identity_inventory` (with or without a connection selector)
- **THEN** each returned row SHALL contain exactly `connection_id`, `connector_id`, `connector_instance_id`, `display_name`, `connector_display_name`, `streams`, and `membership_state`
- **AND** the route SHALL NOT execute a spine-event, browser-surface/runtime, or run-history read to serve this profile
- **AND** the route SHALL NOT perform a write

#### Scenario: `identity_inventory` streams reflect stored evidence membership

- **WHEN** a connection has a `connector_summary_evidence` row
- **THEN** the `identity_inventory` profile's `streams` SHALL equal that row's stored declared∪observed stream-membership union, read as stored
- **AND** `membership_state` SHALL be `"complete"`

#### Scenario: `identity_inventory` before the first evidence sweep

- **WHEN** a connection has no `connector_summary_evidence` row yet
- **THEN** the `identity_inventory` profile SHALL serve `streams` from the registered connector manifest's declared streams only
- **AND** `membership_state` SHALL be `"pending"`

#### Scenario: `identity_inventory` view model matches the full profile

- **WHEN** the same connection is projected once under `profile=identity_inventory` and once under the default full profile
- **THEN** every field present in the `identity_inventory` response SHALL be bit-identical between the two responses for the same observed instant

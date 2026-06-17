## MODIFIED Requirements

### Requirement: Connection-summary route supports single-connection scoping

The `GET /_ref/connectors` connection-summary route SHALL accept an optional connection-selector query parameter. When the selector is present, the route SHALL project and return only the connection the selector resolves; when it is absent, the route SHALL return summaries for all configured connections exactly as before. The scoped projection SHALL be the same per-connection projection used to build the unscoped list, so a single-connection summary cannot diverge from the connection's entry in the full list.

The selector SHALL resolve an exact match on a connection's stable connection identity (`connection_id` / `connector_instance_id`) first. If no exact identity matches, connector-id fallback MAY resolve only when exactly one configured connection uses that `connector_id`. When multiple configured connections share the connector id, the route SHALL return no scoped summary rather than silently selecting one. The route SHALL NOT introduce a new addressing scheme for connections.

The route SHALL remain owner-session-gated for both the scoped and unscoped forms, and the scoped read SHALL NOT persist a connection.

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

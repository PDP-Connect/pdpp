# reference-implementation-architecture (delta)

## ADDED Requirements

### Requirement: Connection-summary route supports single-connection scoping

The `GET /_ref/connectors` connection-summary route SHALL accept an optional
connection-selector query parameter. When the selector is present, the route
SHALL project and return only the connection(s) the selector resolves; when it is
absent, the route SHALL return summaries for all configured connections exactly
as before. The scoped projection SHALL be the same per-connection projection used
to build the unscoped list, so a single-connection summary cannot diverge from
the connection's entry in the full list.

The selector SHALL resolve a connection by the same precedence the operator
console uses to route a record subpage: an exact match on a connection's stable
connection identity (`connection_id` / `connector_instance_id`) is preferred;
otherwise the first configured connection whose `connector_id` matches. The route
SHALL NOT introduce a new addressing scheme for connections.

The route SHALL remain owner-session-gated for both the scoped and unscoped
forms, and the scoped read SHALL NOT persist a connection.

#### Scenario: Unscoped request returns all connections

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with
  no connection selector
- **THEN** the route SHALL return a `{object: "list", data}` envelope containing a
  summary for every configured connection
- **AND** the response SHALL be equivalent to the prior unscoped behavior

#### Scenario: Scoped request returns only the resolved connection

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a
  connection selector that resolves to a configured connection
- **THEN** the route SHALL return a `{object: "list", data}` envelope containing
  exactly the one resolved connection's summary
- **AND** the route SHALL NOT run the per-connection projection fan-out for
  non-matching connections

#### Scenario: Scoped request that resolves nothing returns an empty list

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a
  connection selector that matches no configured connection
- **THEN** the route SHALL return a `{object: "list", data}` envelope with an
  empty `data` array
- **AND** the response SHALL NOT silently scope to a single connector and SHALL
  NOT fall back to returning all connections

#### Scenario: Selector precedence prefers stable connection identity

- **WHEN** a selector value exactly matches one connection's
  `connection_id` / `connector_instance_id` and also matches the `connector_id`
  of other connections
- **THEN** the route SHALL resolve the connection whose stable identity matches
- **AND** a selector that matches only a `connector_id` SHALL resolve the first
  configured connection with that `connector_id`

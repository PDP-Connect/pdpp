## ADDED Requirements

### Requirement: Connection detail SHALL expose confirmed revoke and delete controls

The operator dashboard connection-detail surface SHALL expose owner-visible controls to revoke and to delete the configured connection it is displaying. Both controls SHALL be rendered only on a surface that has resolved a concrete configured connection; a catalog-only connector, an unavailable or fallback catalog row, or a connector type with no configured connection SHALL NOT present revoke or delete controls. Each control SHALL address exactly the resolved `connection_id` (connector instance), never an ambiguous connector-only selector.

The revoke control SHALL request the action over an owner-session reference route that stops future collection for that one connection while preserving its already-collected records, grants, and audit. Its copy SHALL state that records and grants are retained and that only future collection stops, and SHALL NOT claim that records or grants are erased or otherwise altered.

The delete control SHALL request the action over an owner-session reference route that erases exactly that one connection's source-of-truth records and configured state per the already-shipped connection delete contract. Its copy SHALL state that this connection's records are erased, SHALL distinguish delete from revoke, and SHALL state that the action may be refused for a connection with an active run or for a default-account binding. The delete control SHALL require a deliberate confirmation in which the operator reproduces the connection identity before the destructive request can be issued, enforced on the server and not on the client alone.

#### Scenario: A resolved connection shows revoke and delete controls

- **WHEN** an operator opens the connection-detail page for a configured connection
- **THEN** the page SHALL render a revoke control and a delete control for that connection
- **AND** each control SHALL address the resolved `connection_id` of that connection

#### Scenario: A catalog-only row shows no destructive controls

- **WHEN** a surface has not resolved a configured connection (a catalog-only connector, an unavailable or fallback catalog row, or a connector type with no configured connection)
- **THEN** that surface SHALL NOT render a revoke or delete control

#### Scenario: Revoke copy retains records and stops only future collection

- **WHEN** an operator views the revoke control for a connection
- **THEN** its copy SHALL state that already-collected records and grants are retained and that only future collection stops
- **AND** its copy SHALL NOT claim that records or grants are erased

#### Scenario: Delete copy erases this connection and distinguishes itself from revoke

- **WHEN** an operator views the delete control for a connection
- **THEN** its copy SHALL state that this connection's records are erased
- **AND** its copy SHALL distinguish delete from revoke
- **AND** its copy SHALL state that delete may be refused for a connection with an active run or a default-account binding

#### Scenario: Delete requires reproducing the connection identity

- **WHEN** an operator activates the delete control
- **THEN** the dashboard SHALL require the operator to reproduce the connection identity before issuing the request
- **AND** a delete request that does not carry the matching confirmation SHALL be refused on the server and SHALL NOT erase any data

#### Scenario: A shared typed refusal is shown in place

- **WHEN** an operator confirms revoke or delete but the shared control surface refuses with a typed outcome (an already-revoked connection, an in-flight run, a default-account binding, or an unknown connection)
- **THEN** the dashboard SHALL reflect that typed outcome in place rather than presenting a generic error boundary
- **AND** it SHALL refresh the connection detail so the resulting connection state is shown

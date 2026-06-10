## ADDED Requirements

### Requirement: Owner-agent connection delete SHALL be a typed, connection-scoped, audited control action

The owner-agent control surface SHALL model connection delete as a connection-scoped owner-agent action that, when implemented, removes one connection's configuration and erases its collected data, and that until implemented is advertised as a typed unsupported action with a reason pointing at the defined cascade contract. The delete action SHALL be authorized by an owner-agent bearer over the REST control plane only, SHALL NOT be reachable over `/mcp`, and SHALL be distinct from the `revoke_connection` action.

#### Scenario: Control catalog advertises delete honestly

- **WHEN** a trusted owner agent reads the owner-agent control capability document and each connection's supported actions
- **THEN** the `delete_connection` action SHALL appear with a typed status
- **AND** while delete is unsupported the action SHALL be marked `unsupported` with a reason naming the defined cascade contract rather than being silently omitted
- **AND** the catalog SHALL NOT advertise a `delete_connection` method or URL while the action is unsupported

#### Scenario: Owner agent deletes a connection by connection_id

- **WHEN** the `delete_connection` action is supported and a trusted owner agent deletes a connection by `connection_id` over the owner-agent REST control plane
- **THEN** the reference SHALL resolve and verify owner ownership of that `connection_id` before erasing any data
- **AND** it SHALL erase exactly that connection's data and configured row and clear its device back-reference, affecting no sibling connection
- **AND** it SHALL record a non-secret delete audit event including actor kind, client identity, target connection identity, operation, outcome, and deletion summary, without logging bearer tokens, provider credentials, or record contents

#### Scenario: Connector-only delete is ambiguous

- **WHEN** the `delete_connection` action is supported and a trusted owner agent requests a delete using only `connector_id` while more than one active connection exists for that connector type
- **THEN** the reference SHALL reject the request with a typed ambiguity error including the available `connection_id` values and retry guidance
- **AND** it SHALL NOT delete an arbitrarily chosen connection

#### Scenario: Owner bearer cannot delete over MCP

- **WHEN** a client presents an owner-agent bearer to `/mcp`
- **THEN** the reference SHALL reject the bearer for MCP tool access
- **AND** defining a `delete_connection` REST control action SHALL NOT make any delete capability reachable over `/mcp` with an owner bearer

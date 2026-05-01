## ADDED Requirements

### Requirement: Authorization-server metadata SHALL declare agent connect endpoint

The reference public contract SHALL include the agent connect endpoint that the authorization server emits.

#### Scenario: AS metadata is fetched

- **WHEN** a caller fetches `/.well-known/oauth-authorization-server`
- **THEN** the metadata SHALL include `agent_connect_endpoint`
- **AND** the public contract schema and generated docs SHALL describe the field as a URI.

## MODIFIED Requirements

### Requirement: Hosted MCP Authorization Challenges SHALL Use A Stable Resource Identity

The reference hosted MCP endpoint SHALL return HTTP 401 for missing or invalid bearer credentials with a `WWW-Authenticate` Bearer challenge whose `resource_metadata` parameter points at the canonical provider protected-resource metadata URL. The response body SHALL report the same URL. The path-specific hosted MCP protected-resource metadata document MAY remain available for clients that request the path-derived well-known URI directly, but anonymous hosted MCP challenges SHALL NOT switch a client from the provider-origin resource identity to a path-specific resource identity.

#### Scenario: Anonymous hosted MCP request is challenged

- **WHEN** a client calls hosted MCP without a bearer token
- **THEN** the response SHALL be HTTP 401
- **AND** the `WWW-Authenticate` Bearer challenge SHALL include the canonical provider protected-resource metadata URL
- **AND** the JSON error body SHALL include the same `error.resource_metadata` value

#### Scenario: Path-specific metadata remains discoverable

- **WHEN** a client fetches the hosted MCP path-specific protected-resource metadata URL
- **THEN** the response SHALL advertise the hosted MCP endpoint
- **AND** it SHALL advertise hosted MCP token kinds.

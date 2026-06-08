## MODIFIED Requirements

### Requirement: MCP Errors Preserve PDPP Authorization Semantics

The MCP adapter SHALL preserve resource-server error meaning. Authentication, authorization, invalid cursor, expired cursor, unsupported query, and needs-broader-grant conditions SHALL be surfaced as MCP errors without retrying through broader credentials. Hosted MCP package ambiguity metadata SHALL identify only child grants that are usable or SHALL mark unusable children distinctly so clients do not repeatedly select a broken child grant as if it were healthy.

#### Scenario: Package child grant is unusable

- **WHEN** a hosted MCP package contains a child grant that returns a grant authorization error during package read discovery
- **THEN** the adapter SHALL NOT present that child as a normal usable option in `available_connections`
- **AND** the adapter SHALL surface an authorization-preserving error that directs the client to reapprove or choose another connection.

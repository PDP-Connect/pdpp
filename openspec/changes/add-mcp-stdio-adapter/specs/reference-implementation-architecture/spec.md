## ADDED Requirements

### Requirement: MCP Adapter Remains Outside the Reference Control Plane
The reference implementation SHALL package the MCP adapter as a client-side adapter over the existing PDPP resource-server API, not as a new reference-server control plane or collection runtime. The adapter package SHALL NOT import from `reference-implementation/` server internals and SHALL NOT require a PDPP monorepo checkout to run after publication.

#### Scenario: Package boundary is inspected
- **WHEN** maintainers inspect the MCP adapter package imports and package metadata
- **THEN** the package SHALL depend only on published/workspace packages and public PDPP HTTP surfaces, and SHALL NOT import reference server modules or connector runtime internals

#### Scenario: Reference server behavior is compared before and after adapter installation
- **WHEN** the MCP adapter package is added to the workspace
- **THEN** existing AS, RS, grant, connector, scheduler, and collection-profile routes SHALL remain wire-compatible because the adapter consumes those routes instead of modifying them

## ADDED Requirements

### Requirement: Hosted MCP initialize metadata SHALL advertise the reference icon

The hosted MCP endpoint SHALL include MCP `serverInfo.icons` in initialize responses when the reference implementation can derive a public same-origin icon URL. The icon metadata SHALL use the existing `/icon.svg` asset and SHALL NOT require non-standard OAuth protected-resource metadata fields.

#### Scenario: Hosted MCP client initializes

- **WHEN** a hosted MCP client sends an initialize request to `/mcp` with a valid scoped client or MCP package bearer
- **THEN** the initialize response SHALL include `serverInfo.icons[]` with the public `/icon.svg` URL, `image/svg+xml` MIME type, and scalable size metadata

#### Scenario: Hosted MCP challenge advertises icon link

- **WHEN** a client reaches `/mcp` before presenting a valid bearer token
- **THEN** the response SHALL include an HTTP `Link` header that identifies the same public `/icon.svg` asset with `rel="icon"` and `image/svg+xml` type metadata

#### Scenario: Client reads protected-resource metadata

- **WHEN** a client fetches hosted MCP protected-resource metadata
- **THEN** the metadata SHALL remain limited to standard protected-resource fields and approved PDPP extensions
- **AND** it SHALL NOT advertise a speculative OAuth `logo_uri` field

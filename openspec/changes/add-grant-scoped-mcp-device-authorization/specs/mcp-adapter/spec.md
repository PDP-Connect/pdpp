## ADDED Requirements

### Requirement: Hosted MCP SHALL accept grant-scoped device-flow client tokens only
The hosted MCP endpoint SHALL treat access tokens issued by grant-scoped MCP device authorization as ordinary scoped PDPP client tokens. It SHALL continue to reject owner-agent device-flow tokens and SHALL NOT provide an owner-token fallback for MCP setup.

#### Scenario: MCP request has grant-scoped device-flow client token
- **WHEN** a request reaches `/mcp` with a bearer token issued by grant-scoped MCP device authorization and introspection reports `pdpp_token_kind = "client"`
- **THEN** `/mcp` SHALL authorize it exactly as it authorizes other scoped client bearers
- **AND** every tool result SHALL remain bounded by the approved PDPP grant or grant package.

#### Scenario: MCP request has owner-agent device-flow token
- **WHEN** a request reaches `/mcp` with a bearer token issued by trusted owner-agent device authorization and introspection reports `pdpp_token_kind = "owner"`
- **THEN** `/mcp` SHALL reject it with the existing owner-token error
- **AND** it SHALL direct the caller to owner-agent REST/control-plane use rather than widening MCP.

### Requirement: Hosted MCP setup guidance SHALL distinguish callback and device setup
Hosted MCP metadata, docs, and tool-facing setup copy SHALL distinguish browser-capable authorization-code + PKCE setup from headless grant-scoped device authorization. The guidance SHALL NOT present owner-agent onboarding as normal MCP setup.

#### Scenario: Client reads hosted MCP setup guidance
- **WHEN** a client or operator reads hosted MCP setup guidance
- **THEN** the guidance SHALL identify authorization-code + PKCE as the baseline browser-capable flow
- **AND** identify grant-scoped device authorization as the headless/sandbox flow when advertised
- **AND** state that owner-agent device authorization creates owner-level REST credentials, not MCP credentials.

## ADDED Requirements

### Requirement: MCP client setup SHALL prefer standards-based OAuth identity

The reference SHALL present local MCP client setup as a standards-based OAuth flow: pre-registered client identity when known, Client ID Metadata Document (CIMD) identity when the client can supply a URL-shaped `client_id`, Dynamic Client Registration (DCR) as fallback, and manual bearer/API credential setup only for explicit owner-agent or headless API use. The normal Claude Code and Codex MCP setup SHALL NOT ask the operator to paste an owner/control-plane bearer token.

#### Scenario: MCP client uses CIMD identity for setup
- **WHEN** an operator has created a client metadata document for Claude Code, Codex, or a custom MCP client
- **THEN** the setup command presented to the operator SHALL include the stable PDPP-hosted `client_id` URL
- **AND** the AS SHALL accept that URL as a valid CIMD client_id without prior DCR
- **AND** the owner SHALL approve a scoped PDPP grant in the browser before the client receives a grant-scoped token

#### Scenario: MCP client falls back to DCR when no CIMD document exists
- **WHEN** no operator-created CIMD document is available for the MCP client
- **THEN** the client SHALL proceed through the existing DCR path when the client supports it
- **AND** the DCR path SHALL remain functional and unmodified

#### Scenario: Headless API credential is selected
- **WHEN** an operator chooses a headless owner-agent or API credential path instead of normal MCP OAuth setup
- **THEN** the UI SHALL label that path as owner-level or API-level automation
- **AND** it SHALL distinguish that path from grant-scoped MCP client access

### Requirement: The operator dashboard SHALL surface CIMD identity management for local MCP clients

The operator dashboard SHALL provide a "Client Identities" panel where the operator can create, inspect, and revoke PDPP-hosted CIMD documents for local MCP clients (Claude Code, Codex, and custom clients). For each client identity, the dashboard SHALL present copy-paste setup commands.

#### Scenario: Operator creates a client identity
- **WHEN** the operator creates a new client identity in the dashboard
- **THEN** the operator SHALL receive a stable `https://<pdpp-host>/oauth/client-metadata/<uuid>` URL
- **AND** the dashboard SHALL immediately render copy-paste setup commands for that identity

#### Scenario: Dashboard renders Claude Code setup commands
- **WHEN** the operator views a client identity in the dashboard
- **THEN** the dashboard SHALL display a default-discovery command: `claude mcp add --transport http pdpp https://<pdpp-host>/mcp`
- **AND** it SHALL display an explicit CIMD identity command: `claude mcp add --transport http --client-id https://<pdpp-host>/oauth/client-metadata/<uuid> pdpp https://<pdpp-host>/mcp`

#### Scenario: Dashboard renders Codex setup commands
- **WHEN** the operator views a client identity in the dashboard
- **THEN** the dashboard SHALL display a default-discovery command: `codex mcp add pdpp --url https://<pdpp-host>/mcp`
- **AND** it SHALL display an explicit CIMD identity command: `codex mcp add pdpp --url https://<pdpp-host>/mcp --oauth-resource https://<pdpp-host>/mcp --oauth-client-id https://<pdpp-host>/oauth/client-metadata/<uuid>`

#### Scenario: Operator revokes a client identity
- **WHEN** the operator deletes a client identity in the dashboard
- **THEN** the CIMD document SHALL no longer be served at its URL
- **AND** all grants and tokens issued to that `client_id` SHALL be revoked server-side

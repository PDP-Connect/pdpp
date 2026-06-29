## MODIFIED Requirements

### Requirement: Headless MCP setup SHALL use grant-scoped client authorization
The reference agent access workflow SHALL direct headless or sandboxed MCP clients to a grant-scoped client authorization path. The workflow SHALL NOT tell external MCP clients or routine task-scoped agents to obtain or present an owner bearer token.

#### Scenario: MCP client cannot receive a loopback callback
- **WHEN** an MCP client runs in a sandbox, container, SSH session, or other environment where a loopback callback is not reachable
- **THEN** the workflow SHALL direct it to grant-scoped MCP device authorization when available
- **AND** it SHALL show a verification URL, user code, expiry, polling state, and retry guidance.

#### Scenario: Browser-capable native MCP client uses a runtime loopback port
- **WHEN** a public native MCP client metadata document registers an HTTP loopback redirect URI without a port
- **AND** the client starts authorization-code + PKCE with the same loopback host and path using a runtime-selected port
- **THEN** the authorization server SHALL accept the redirect URI as registered for authorization
- **AND** it SHALL bind the issued authorization code to the exact redirect URI used in the authorization request.

#### Scenario: Loopback redirect changes path
- **WHEN** a public native MCP client metadata document registers an HTTP loopback redirect path
- **AND** the client starts authorization-code + PKCE with a different loopback path
- **THEN** the authorization server SHALL reject the redirect URI.

#### Scenario: Device authorization is unavailable
- **WHEN** grant-scoped MCP device authorization is not advertised by the deployment
- **THEN** setup guidance SHALL recommend a browser-capable authorization-code + PKCE client path or a repo-owned adapter path that prints/copies the authorization URL and fails with a bounded timeout
- **AND** it SHALL NOT fall back to owner-agent credentials for `/mcp`.

#### Scenario: Trusted owner-agent is selected
- **WHEN** the owner explicitly chooses trusted owner-agent onboarding
- **THEN** the workflow SHALL label the resulting credential as owner-level local automation for `/v1/**` owner-agent REST/control-plane use
- **AND** it SHALL state that `/mcp` rejects that owner bearer by design.

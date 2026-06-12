## ADDED Requirements

### Requirement: Headless MCP setup SHALL use grant-scoped client authorization
The reference agent access workflow SHALL direct headless or sandboxed MCP clients to a grant-scoped client authorization path. The workflow SHALL NOT tell external MCP clients or routine task-scoped agents to obtain or present an owner bearer token.

#### Scenario: MCP client cannot receive a loopback callback
- **WHEN** an MCP client runs in a sandbox, container, SSH session, or other environment where a loopback callback is not reachable
- **THEN** the workflow SHALL direct it to grant-scoped MCP device authorization when available
- **AND** it SHALL show a verification URL, user code, expiry, polling state, and retry guidance.

#### Scenario: Device authorization is unavailable
- **WHEN** grant-scoped MCP device authorization is not advertised by the deployment
- **THEN** setup guidance SHALL recommend a browser-capable authorization-code + PKCE client path or a repo-owned adapter path that prints/copies the authorization URL and fails with a bounded timeout
- **AND** it SHALL NOT fall back to owner-agent credentials for `/mcp`.

#### Scenario: Trusted owner-agent is selected
- **WHEN** the owner explicitly chooses trusted owner-agent onboarding
- **THEN** the workflow SHALL label the resulting credential as owner-level local automation for `/v1/**` owner-agent REST/control-plane use
- **AND** it SHALL state that `/mcp` rejects that owner bearer by design.

### Requirement: Repo-owned setup clients SHALL fail fast when callback completion is unreachable
Any repo-owned CLI or adapter setup path that launches a browser or waits for a callback SHALL provide a bounded timeout, a copyable authorization or verification URL, and a clear recovery path. It SHALL NOT wait indefinitely for a loopback callback that may be unreachable from the user's browser context.

#### Scenario: Browser launch or callback wait fails
- **WHEN** a repo-owned setup client cannot open a usable browser or does not receive the callback before timeout
- **THEN** it SHALL print a copyable URL or verification URI, explain the timeout, and exit or continue polling according to the advertised flow
- **AND** it SHALL NOT silently keep waiting forever.

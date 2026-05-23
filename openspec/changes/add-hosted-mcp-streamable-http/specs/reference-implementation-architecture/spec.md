## ADDED Requirements

### Requirement: Authorization Server Supports Public OAuth Code With PKCE For Hosted MCP
The reference authorization server SHALL support OAuth `authorization_code` with PKCE S256 for public hosted MCP clients. The flow SHALL bridge to existing PDPP pending-consent approval and SHALL issue the same kind of grant-scoped client bearer tokens already enforced by the resource server.

#### Scenario: Public client registers for authorization code
- **WHEN** dynamic client registration receives public-client metadata with `grant_types: ["authorization_code"]`, `response_types: ["code"]`, redirect URIs, and `token_endpoint_auth_method: "none"`
- **THEN** the reference AS SHALL register the client if all metadata is valid

#### Scenario: Client starts authorization
- **WHEN** a registered public client calls `/oauth/authorize` with `response_type=code`, an exact registered `redirect_uri`, `code_challenge_method=S256`, and a code challenge
- **THEN** the AS SHALL stage or bind a PDPP pending-consent request and present the owner consent flow

#### Scenario: Owner approves hosted MCP consent
- **WHEN** the owner approves a pending authorization-code consent request
- **THEN** the AS SHALL issue a PDPP grant and client token, mint a short-lived single-use authorization code bound to client, redirect URI, and PKCE challenge, and redirect the browser with `code` and optional `state`

#### Scenario: Client exchanges code
- **WHEN** the client posts `/oauth/token` with `grant_type=authorization_code`, the authorization code, matching client id, matching redirect URI, and a valid PKCE verifier
- **THEN** the AS SHALL return the scoped client bearer token and mark the code consumed

#### Scenario: Code is reused or verifier is wrong
- **WHEN** a client reuses an authorization code or supplies the wrong PKCE verifier
- **THEN** the AS SHALL reject the exchange and SHALL NOT issue a token

### Requirement: Authorization Metadata Advertises Hosted MCP OAuth Capabilities
The authorization server metadata SHALL truthfully advertise OAuth code-flow support needed by hosted MCP clients.

#### Scenario: Client discovers authorization server metadata
- **WHEN** a client fetches `/.well-known/oauth-authorization-server`
- **THEN** the response SHALL include `authorization_endpoint`, `authorization_code` in `grant_types_supported`, `code` in `response_types_supported`, and `S256` in `code_challenge_methods_supported`

### Requirement: Hosted MCP OAuth Does Not Leak Bearers
The hosted MCP OAuth approval path SHALL NOT place access tokens in browser-rendered HTML, redirect URLs, logs intended for users, or consent exchange codes.

#### Scenario: Approval redirects to client
- **WHEN** owner approval completes for an authorization-code request
- **THEN** the browser redirect SHALL include only the authorization code and optional state, and SHALL NOT include the access token or grant JSON

#### Scenario: Token endpoint returns bearer
- **WHEN** the registered client exchanges the authorization code successfully
- **THEN** the bearer SHALL be returned only from `/oauth/token` in the JSON response body

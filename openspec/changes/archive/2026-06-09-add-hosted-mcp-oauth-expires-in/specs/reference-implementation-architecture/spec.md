## MODIFIED Requirements

### Requirement: Authorization Server Supports Public OAuth Code With PKCE For Hosted MCP
The reference authorization server SHALL support OAuth `authorization_code` with PKCE S256 for public hosted MCP clients. The flow SHALL bridge to existing PDPP pending-consent approval and SHALL issue the same kind of grant-scoped client bearer tokens already enforced by the resource server.

#### Scenario: Public client registers for authorization code
- **WHEN** dynamic client registration receives public-client metadata with `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`, redirect URIs, and `token_endpoint_auth_method: "none"`
- **THEN** the reference AS SHALL register the client if all metadata is valid

#### Scenario: Client starts authorization
- **WHEN** a registered public client calls `/oauth/authorize` with `response_type=code`, an exact registered `redirect_uri`, `code_challenge_method=S256`, and a code challenge
- **THEN** the AS SHALL stage or bind a PDPP pending-consent request and present the owner consent flow

#### Scenario: Owner approves hosted MCP consent
- **WHEN** the owner approves a pending authorization-code consent request
- **THEN** the AS SHALL issue a PDPP grant and client token, mint a short-lived single-use authorization code bound to client, redirect URI, and PKCE challenge, and redirect the browser with `code` and optional `state`

#### Scenario: Client exchanges code
- **WHEN** the client posts `/oauth/token` with `grant_type=authorization_code`, the authorization code, matching client id, matching redirect URI, and a valid PKCE verifier
- **THEN** the AS SHALL return the scoped client bearer token, return `expires_in` as a positive integer lifetime hint, return an opaque grant-scoped refresh token when the registered client requested `refresh_token`, and mark the code consumed

#### Scenario: Client refreshes hosted MCP access
- **WHEN** the client posts `/oauth/token` with `grant_type=refresh_token`, the opaque refresh token, and the matching public client id
- **THEN** the AS SHALL issue a new scoped client bearer for the same PDPP grant without widening source, stream, subject, purpose, retention, or storage-binding scope
- **AND** the token response SHALL include `expires_in` as a positive integer lifetime hint

#### Scenario: Refresh token no longer matches an active grant
- **WHEN** the client posts `/oauth/token` with an unknown refresh token, a mismatched client id, or a token tied to a revoked or invalid grant
- **THEN** the AS SHALL reject the exchange and SHALL NOT issue a new bearer

#### Scenario: Code is reused or verifier is wrong
- **WHEN** a client reuses an authorization code or supplies the wrong PKCE verifier
- **THEN** the AS SHALL reject the exchange and SHALL NOT issue a token

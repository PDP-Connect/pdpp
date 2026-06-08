## MODIFIED Requirements

### Requirement: The reference authorization server SHALL support hosted MCP OAuth authorization-code clients

The reference authorization server SHALL support OAuth `authorization_code` with PKCE S256 for public hosted MCP clients. The flow SHALL bridge to existing PDPP pending-consent approval and SHALL issue the same kind of grant-scoped client bearer tokens already enforced by the resource server.

#### Scenario: Client exchanges code

- **WHEN** the client posts `/oauth/token` with `grant_type=authorization_code`, the authorization code, matching client id, matching redirect URI, and a valid PKCE verifier
- **THEN** the AS SHALL return the scoped client bearer token, return `expires_in` as a positive integer lifetime hint, return an opaque grant-scoped refresh token when the registered client requested `refresh_token`, and mark the code consumed

#### Scenario: Client refreshes hosted MCP access

- **WHEN** the client posts `/oauth/token` with `grant_type=refresh_token`, the opaque refresh token, and the matching public client id
- **THEN** the AS SHALL issue a new scoped client bearer for the same PDPP grant without widening source, stream, subject, purpose, retention, or storage-binding scope
- **AND** the token response SHALL include `expires_in` as a positive integer lifetime hint

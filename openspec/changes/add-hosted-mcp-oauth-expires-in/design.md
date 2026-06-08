## Context

The deployed failure evidence shows Claude registered a dynamic client, completed the consent redirect, and received HTTP 200 responses from `/oauth/token`, but did not send an authenticated `POST /mcp`. The local route audit found one concrete mismatch with interoperable OAuth token responses: the hosted MCP `authorization_code` and `refresh_token` branches omit `expires_in`, while the device-code branch already returns it.

Claude Code documentation describes remote MCP OAuth tokens as stored and refreshed automatically. Anthropic's OAuth token-response reference documents `expires_in` as the standard field clients use to derive expiry. RFC 6749 also recommends `expires_in` in successful token responses and says omitted lifetimes should be provided by other means or documented.

## Decision

Return a numeric `expires_in` from the hosted MCP `authorization_code` and `refresh_token` token-response branches. Use the same long reference lifetime already used by the owner device-token path when the grant-bound client token has no explicit expiry.

This keeps the fix at the HTTP response boundary where the incompatibility appears. It does not change grant issuance, refresh-token storage, token validation, revocation, package fan-out, or `/mcp` authorization.

## Alternatives

- Change hosted MCP access tokens to short-lived tokens. Rejected for this patch because it changes token-storage behavior and expiry semantics beyond the compatibility gap.
- Add `expires_in` only for `authorization_code`. Rejected because Claude may immediately exercise refresh behavior; the refresh response must carry the same lifetime hint.
- Add a non-standard expiry field. Rejected because OAuth clients expect `expires_in`.

## Acceptance Checks

- `authorization_code` exchange responses include `expires_in` as a positive integer.
- `refresh_token` exchange responses include `expires_in` as a positive integer.
- Existing token identity fields remain unchanged.
- Focused hosted MCP OAuth tests pass.
- `openspec validate add-hosted-mcp-oauth-expires-in --strict` passes.

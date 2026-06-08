## Why

Claude can complete hosted MCP OAuth registration, consent, and token exchange, but it may not proceed to authenticated `/mcp` calls when the token response omits an access-token lifetime. The reference already returns `expires_in` for owner device-code tokens; hosted MCP `authorization_code` and `refresh_token` exchanges need the same standards-aligned lifetime hint.

## What Changes

- Add `expires_in` to successful hosted MCP OAuth `authorization_code` token responses.
- Add `expires_in` to successful hosted MCP OAuth `refresh_token` token responses.
- Keep the existing access-token, refresh-token, `grant_id`, and `grant_package_id` semantics unchanged.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: hosted MCP OAuth token responses include an access-token lifetime hint for client compatibility.

## Impact

- Affected code: `reference-implementation/server/routes/as-oauth.ts`.
- Affected tests: hosted MCP OAuth token-exchange coverage.
- No new dependencies, routes, grant shapes, token storage tables, or authorization rewrites.

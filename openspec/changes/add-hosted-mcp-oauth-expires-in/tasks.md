## 1. Token Response

- [x] 1.1 Add `expires_in` to hosted MCP `authorization_code` token responses.
- [x] 1.2 Add `expires_in` to hosted MCP `refresh_token` token responses.
- [x] 1.3 Preserve existing access-token, refresh-token, `grant_id`, and `grant_package_id` response fields.

## 2. Validation

- [x] 2.1 Add focused hosted MCP OAuth assertions for `expires_in` on code and refresh exchanges.
- [x] 2.2 Run the focused hosted MCP OAuth test file.
- [x] 2.3 Run `openspec validate add-hosted-mcp-oauth-expires-in --strict`.

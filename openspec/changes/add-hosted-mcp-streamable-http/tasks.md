## 1. OpenSpec And Design

- [x] 1.1 Create and validate the hosted MCP Streamable HTTP OpenSpec change.
- [x] 1.2 Fold current ChatGPT/OpenAI MCP compatibility requirements into the design.

## 2. MCP Package

- [x] 2.1 Add hosted Streamable HTTP transport helper to `@pdpp/mcp-server` without duplicating tool definitions.
- [x] 2.2 Add ChatGPT-compatible `fetch` and update `search` structured output while preserving existing PDPP-native tool behavior.
- [x] 2.3 Add package tests for Streamable HTTP initialize/tools/list/call behavior.

## 3. Reference Hosted Endpoint

- [x] 3.1 Mount `GET|POST|DELETE /mcp` in the reference server.
- [x] 3.2 Require active client bearer tokens for `/mcp` and reject owner/missing/invalid tokens.
- [x] 3.3 Advertise hosted MCP in protected-resource metadata using public-origin-safe URLs.

## 4. OAuth Code + PKCE

- [x] 4.1 Add short-lived authorization-code persistence for SQLite and Postgres.
- [x] 4.2 Relax dynamic client registration for public `authorization_code` clients while preserving strict rejection of unsupported/confidential metadata.
- [x] 4.3 Add `/oauth/authorize` with redirect URI, response type, client, and PKCE validation.
- [x] 4.4 Bridge owner consent approval to OAuth authorization-code redirect without exposing bearers.
- [x] 4.5 Extend `/oauth/token` to exchange authorization codes once with PKCE validation while preserving device-code behavior.
- [x] 4.6 Update authorization-server metadata for code+PKCE support.

## 5. Reference Tests

- [x] 5.1 Add tests for hosted `/mcp` authorization boundaries and successful tool calls under a scoped client token.
- [x] 5.2 Add tests for protected-resource metadata and authorization-server metadata.
- [x] 5.3 Add tests for DCR authorization-code metadata acceptance and rejection.
- [x] 5.4 Add tests for OAuth authorize/approve/token success and security failures.
- [x] 5.5 Add tests proving the OAuth approval redirect never leaks the bearer.

## 6. Validation And Deployment

- [x] 6.1 Run `openspec validate add-hosted-mcp-streamable-http --strict`.
- [x] 6.2 Run MCP package tests and targeted reference tests.
- [ ] 6.3 Run broader relevant verification if targeted checks pass.
- [ ] 6.4 Commit the tranche.
- [ ] 6.5 Build/deploy to `pdpp.vivid.fish` and verify public metadata plus `/mcp` behavior.
- [ ] 6.6 Re-check the interrupted reference/web image publish closeout and leave deployment in a known state.

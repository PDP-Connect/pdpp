## Why

Headless or sandboxed MCP clients can fail the normal loopback OAuth callback flow by opening a browser the user cannot operate and then waiting indefinitely. Prior-art review shows that the SLVP path for browserless setup is an explicit, bounded device-authorization flow, but PDPP's existing RFC 8628 endpoint currently issues owner-agent credentials and `/mcp` must reject owner bearers.

## What Changes

- Add a grant-scoped MCP device-authorization path that issues `pdpp_token_kind=client` credentials bound to a PDPP grant and the `/mcp` resource.
- Keep trusted owner-agent device authorization separate from the new MCP device path; owner device codes SHALL NOT redeem into normal MCP setup.
- Make AS and protected-resource metadata token-kind honest: generic device-code discovery must not imply that owner bearers are valid MCP credentials.
- Add client/CLI/adapter guidance for headless setup: show verification URL/code, expiry, polling state, denial/expiry errors, and retry instructions instead of waiting forever on loopback.
- Preserve the existing authorization-code + PKCE path for browser-capable MCP clients, CIMD/pre-registered/DCR client registration, and owner-agent REST onboarding.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: AS metadata, device authorization, token exchange, and consent approval SHALL distinguish owner-agent and grant-scoped MCP device flows.
- `reference-agent-access-workflow`: agent setup guidance SHALL direct headless MCP clients to a grant-scoped device flow rather than owner-agent credentials.
- `mcp-adapter`: hosted MCP SHALL remain client-token-only while treating grant-scoped device-flow tokens as ordinary scoped client credentials.

## Impact

- Affected server areas: `reference-implementation/server/routes/as-oauth.ts`, owner/device auth stores, consent approval routes, authorization-server metadata, protected-resource metadata, token introspection, and tests.
- Affected client/docs areas: `packages/cli`, `packages/mcp-server`, agent skills, hosted MCP setup docs, and console connect guidance.
- Security impact: strengthens owner/client token separation and avoids accidental owner-bearer use on MCP.
- No connector, ChatGPT run-control, or live-stack changes are in scope.

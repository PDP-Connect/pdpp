## Context

The stdio MCP adapter proves the package boundary: MCP is an adapter over grant-scoped RS reads, not a second PDPP data plane. ChatGPT and similar hosted clients cannot use a local stdio process; they need a remote MCP server over HTTPS and a web OAuth flow.

OpenAI's current MCP guidance says remote MCP servers can be connected in ChatGPT Apps/Connectors, and data-only/deep-research compatibility should expose read-only `search` and `fetch` tools. Developer-mode full MCP can use arbitrary tools, but `search`/`fetch` are the broadest compatibility path. OAuth is recommended for private remote MCP servers, and ChatGPT users receive an OAuth flow when connecting a custom remote MCP server.

## Goals

- Host a public-origin-correct `/mcp` endpoint using MCP Streamable HTTP.
- Preserve one MCP tool implementation source in `@pdpp/mcp-server`.
- Support broad modern MCP clients: ChatGPT remote MCP, Claude/Codex local MCP, and generic MCP clients.
- Keep MCP read-only and grant-scoped.
- Add OAuth authorization-code + PKCE as a transport for obtaining existing PDPP client grants.
- Add grant-scoped OAuth refresh tokens because current hosted MCP clients can require durable OAuth connections during dynamic client registration.
- Avoid exposing owner tokens, reference control-plane routes, connector execution, schedules, or collection internals through MCP.

## Non-Goals

- No write/modify MCP tools.
- No connector execution or scheduler control through MCP.
- No owner-token MCP mode.
- No owner-wide multi-source MCP grant mode; this tranche remains one approved PDPP source per grant.
- No MCP prompts, sampling, roots, subscriptions, elicitation, or long-lived server-initiated events.
- No publication-policy change for `@pdpp/mcp-server`.

## Decisions

### Hosted MCP Is A Stateless Disclosure Adapter

Use Streamable HTTP in stateless-per-request mode for hosted `/mcp`. Each request creates a fresh MCP server and transport, and the reference server introspects the supplied bearer before handing the request to the MCP transport.

This keeps revocation and grant scope fresh and avoids treating MCP session state as an authorization cache. Stateful/resumable MCP can be added later if a concrete client requires it, but it would need explicit token/session invalidation design.

### One Tool Definition Source

Keep tool registration in `@pdpp/mcp-server`. The reference server mounts transport glue and supplies provider URL plus access token. The package remains reusable by stdio clients and hosted servers.

### ChatGPT Compatibility Means `search` And `fetch`

The current `search` tool returns the RS search envelope. Add a compatibility shape for `search` structured content and add a `fetch` tool that retrieves one previously indexed result or direct PDPP record reference and returns `{ id, title, text, url, metadata }`.

PDPP-native tools remain available for full MCP clients: `schema`, `list_streams`, `query_records`, and `fetch_blob`.

### OAuth Code Flow Bridges To PDPP Consent

Add `/oauth/authorize` and `authorization_code` token exchange for public clients using PKCE S256. The authorize route validates the registered client, redirect URI, response type, and PKCE challenge, then stages a PDPP pending consent request. When the owner approves the same consent page, the AS issues the normal grant-scoped client token and redirects with a short-lived OAuth authorization code. `/oauth/token` validates client, redirect URI, single-use code, and PKCE verifier, then returns that token.

The bearer is never placed in a redirect URL or HTML response.

### Refresh Tokens Stay Bound To The PDPP Grant

Dynamic client registration accepts `refresh_token` only alongside `authorization_code`. When a registered public client requests it, successful authorization-code exchange returns a high-entropy opaque refresh token stored server-side only as a hash. Refresh exchange accepts the refresh token only at `/oauth/token`, requires the same public `client_id`, and issues a new client bearer for the same existing PDPP grant. It does not create a new grant, widen access, expose owner credentials, or bypass revocation; revoking the grant revokes its refresh tokens.

This is essential compatibility, not owner/admin access. A future owner-wide or operator/admin MCP surface would need its own grant shape and UI because today's wildcard stream selection expands all streams for one approved source, not all owner connections.

### Metadata Is Truthful And Public-Origin Safe

Authorization-server metadata advertises code+PKCE only when the route exists. Protected-resource metadata advertises `/mcp` as an adapter endpoint and keeps `pdpp_core_query_base` pointed at `/v1`.

Composed/proxied deployments must rebase metadata to the trusted forwarded public origin.

## Alternatives Considered

- **Expose owner-token MCP for convenience.** Rejected because it turns MCP into a self-export bypass and violates the stdio adapter invariant.
- **Duplicate MCP tools inside the reference server.** Rejected because it fractures behavior between stdio and hosted clients.
- **Require clients to use PAR before `/oauth/authorize`.** Deferred because ChatGPT-style OAuth clients expect a normal authorization endpoint. The implementation can still accept a `request_uri` when a client supplies one.
- **Implement hosted MCP without OAuth first.** Rejected because private personal data needs a standard user authorization path for ChatGPT and similar clients.
- **Only expose generic PDPP tools, not `fetch`.** Rejected because it would work for developer-mode clients but fail the broad ChatGPT data-only/deep-research compatibility path.

## Risks / Trade-Offs

- **Client capability variance:** Some clients need `search`/`fetch`, others can use richer PDPP tools. The solution exposes both without broadening data scope.
- **Authorization complexity:** OAuth code flow adds storage and validation, but the complexity is essential for hosted MCP clients and remains tied to existing PDPP consent.
- **Refresh-token retention:** Refresh tokens add durable credential state. The implementation bounds that state to an existing PDPP grant, stores only token hashes, and revokes refresh tokens when the grant is revoked.
- **Stateless transport limitations:** Stateless MCP does not support server-initiated notifications or resumability. The current surface is read-only request/response, so this is the simpler and safer default.

## Acceptance Checks

- `/.well-known/oauth-authorization-server` advertises `authorization_endpoint`, `authorization_code`, `refresh_token`, `response_types_supported: ["code"]`, and `code_challenge_methods_supported: ["S256"]`.
- `/.well-known/oauth-protected-resource` advertises hosted MCP under a discovery hint while preserving `/v1` as the core query base.
- `/mcp` rejects missing, invalid, and owner bearers; accepts scoped client bearers.
- MCP `tools/list` includes PDPP-native read tools plus ChatGPT-compatible `search` and `fetch`.
- OAuth dynamic registration accepts public authorization-code clients that request refresh tokens and still rejects unsupported confidential or unsafe metadata.
- OAuth authorize/approve/token exchange returns scoped client credentials only from `/oauth/token`, never in HTML or redirect URLs.
- OAuth refresh-token exchange returns a new bearer for the same grant and rejects mismatched clients or revoked grants.
- Existing stdio MCP tests still pass.

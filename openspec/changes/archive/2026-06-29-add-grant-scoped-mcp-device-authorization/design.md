## Context

The reference AS currently advertises RFC 8628 device authorization in authorization-server metadata and serves `POST /oauth/device_authorization`. That endpoint is wired to `ownerDeviceAuthStore` and its token exchange produces owner-agent credentials. Separately, hosted `/mcp` is intentionally grant-scoped and rejects owner bearers.

The triggering report was a Pi/Daisy-style MCP OAuth hang: an adapter opened a browser from a sandbox and waited on a localhost callback the user could not complete. Repo inspection found no PDPP-owned `pi-mcp-adapter`, `waitForCallback`, or `runSdkAuth` implementation. The immediate adapter bug is external, but the prior-art review found a real reference-design gap: a first-class headless MCP setup path should not rely on loopback, and PDPP must not let the existing owner device flow look like normal MCP authorization.

Research corpus: `docs/research/mcp-oauth-headless-auth-prior-art-2026-06-12.md`.

## Goals / Non-Goals

**Goals:**

- Provide a standards-shaped headless setup path for grant-scoped MCP clients using RFC 8628 device authorization semantics.
- Preserve strict separation between owner-agent credentials and grant-scoped MCP client credentials.
- Keep AS metadata honest for generic OAuth/MCP clients.
- Keep browser-capable MCP clients on authorization code + PKCE, with CIMD preferred for no-prior-relationship client identity and DCR as fallback.
- Make CLI/adapter UX bounded and copyable: URL/code/expiry/status/errors/retry, not indefinite callback waits.

**Non-Goals:**

- Do not use owner bearers as normal MCP setup.
- Do not make device authorization mandatory for all MCP clients.
- Do not solve external Pi adapter code inside this repo unless that adapter is later brought under repo ownership.
- Do not touch connector run pacing, ChatGPT concurrency, safe-frontier logic, or live stack deployment in this change.

## Decisions

### Decision 1: Add a grant-scoped MCP device path instead of reusing owner device auth

The existing owner-agent device flow remains owner-level local automation. It is appropriate for Daisy-style owner REST/control-plane work and inappropriate for `/mcp`. Reusing it would collapse the owner/client boundary and violate existing MCP behavior that rejects owner bearers.

The new path SHALL persist a device authorization request kind. Owner-agent requests redeem owner tokens. MCP device requests redeem client tokens tied to an approved PDPP grant or grant package.

### Decision 2: Require MCP device requests to carry resource and PDPP authorization details

Grant-scoped device authorization must have enough information to present meaningful owner consent and later enforce disclosure. The request therefore needs `client_id`, `resource` for the MCP protected resource, and PDPP `authorization_details` equivalent to the hosted MCP authorization-code path. The AS validates the client through CIMD, pre-registration, or DCR and validates the requested details through the same consent/grant machinery used by hosted MCP.

### Decision 3: Keep one standards endpoint, but make mode explicit

RFC 8628 clients discover one `device_authorization_endpoint`. The reference can keep `/oauth/device_authorization`, but it must not treat every device request as owner-agent onboarding. MCP device requests are selected by the presence of MCP `resource` plus PDPP `authorization_details`. Owner-agent requests are selected by the owner-agent onboarding profile and remain documented under `pdpp_owner_agent_onboarding`.

During migration, the implementation MAY keep legacy owner-agent bare requests working for the current CLI, but metadata and docs must no longer teach bare device authorization as normal MCP setup.

### Decision 4: Metadata must be token-kind honest

Authorization-server metadata may advertise device authorization only when the endpoint supports a grant-scoped client-token path suitable for the public OAuth client class being discovered, or when accompanying PDPP metadata makes the owner-only nature unambiguous. Protected-resource metadata remains the clearer place to advertise `pdpp_owner_agent_onboarding` for owner tokens and `pdpp_agent_discovery` for normal grant-scoped access.

### Decision 5: Approval UX must show provenance and scope

The approval page for MCP device authorization must show client identity provenance, the MCP resource, requested streams/sources, expiry, and explicit approve/deny controls. Client-authored display claims remain separate from verified client id/origin and PDPP grant scope.

## Risks / Trade-offs

- **Risk: generic clients see device support but omit PDPP authorization details.** Mitigation: reject MCP device requests without `resource` and PDPP `authorization_details` using RFC-shaped errors; owner-agent fallback must be explicit in docs and UI.
- **Risk: owner/device code storage becomes ambiguous.** Mitigation: persist request kind and token-kind target; tests assert an owner device code never redeems into an MCP-usable token.
- **Risk: duplicating consent/grant logic.** Mitigation: delegate validation and approval to existing pending-consent/grant issuance code; device auth should be a transport into the same grant machinery, not a parallel grant engine.
- **Risk: MCP core does not require device authorization.** Mitigation: keep it additive and standards-shaped; authorization-code + PKCE remains the baseline.

## Migration Plan

1. Add tests that prove current owner device flow returns owner tokens and `/mcp` rejects them.
2. Add metadata honesty tests for AS and protected-resource metadata.
3. Add grant-scoped MCP device request storage and token exchange using existing pending-consent/grant issuance.
4. Update CLI/adapter/docs to present device flow only for headless setup and never as owner-token MCP setup.
5. Deploy only after local tests and a live smoke prove: device request → owner approval → token polling → `/mcp` tools/list succeeds; owner device token → `/mcp` still fails.

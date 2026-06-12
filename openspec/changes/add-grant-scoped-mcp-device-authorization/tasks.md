## 1. Spec And Research Grounding

- [x] 1.1 Keep `docs/research/mcp-oauth-headless-auth-prior-art-2026-06-12.md` in the durable research corpus with URLs, access date, and conclusion.
- [x] 1.2 Validate `add-grant-scoped-mcp-device-authorization` with `openspec validate add-grant-scoped-mcp-device-authorization --strict`.
- [x] 1.3 Re-run `openspec validate --all --strict` before owner gate.

## 2. Metadata Honesty

- [x] 2.1 Add AS metadata tests proving device authorization advertisement is token-kind honest and does not imply owner-agent device codes are normal MCP setup.
- [x] 2.2 Update protected-resource metadata so owner-agent onboarding and grant-scoped MCP setup remain visibly distinct.
- [x] 2.3 Update docs/skills to say headless MCP device authorization issues grant-scoped client tokens; owner-agent device authorization issues owner tokens and `/mcp` rejects them.

## 3. Grant-Scoped MCP Device Authorization

- [x] 3.1 Add a persisted device authorization request kind for owner-agent versus grant-scoped MCP requests.
- [x] 3.2 Implement MCP device authorization initiation for `client_id`, MCP `resource`, and PDPP `authorization_details`, reusing the existing client registration and pending-consent validation machinery.
- [x] 3.3 Implement token polling so approved MCP device requests return `pdpp_token_kind=client` access tokens bound to the approved grant/package and resource.
- [x] 3.4 Preserve RFC 8628 error behavior: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, `invalid_grant`, and `invalid_client`.
- [x] 3.5 Preserve owner-agent device authorization and prove owner tokens still fail against `/mcp`.

## 4. Client And Setup UX

- [x] 4.1 Update CLI/adapter setup guidance to show verification URL, user code, expiry, polling state, denial/expiry errors, and retry command for headless MCP setup.
- [x] 4.2 Add bounded timeout behavior to repo-owned setup clients that poll device authorization.
- [x] 4.3 Update hosted MCP setup docs and console connect guidance to recommend authorization-code + PKCE for browser-capable clients and grant-scoped device authorization for headless clients.

## 5. Verification

- [x] 5.1 Add unit tests for owner-device and MCP-device token-kind separation.
- [x] 5.2 Add integration smoke: device request → owner approval → token polling → `/mcp` `tools/list` succeeds with a client token.
- [x] 5.3 Add negative smoke: owner-agent device token → `/mcp` rejects with the existing owner-token error.
- [x] 5.4 Run focused AS/MCP/CLI tests.
- [x] 5.5 Deploy only under the live-stack mutex and verify the live AS metadata, protected-resource metadata, device-flow smoke, and owner-token rejection.

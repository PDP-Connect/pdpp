## 1. OpenSpec

- [x] 1.1 Create proposal, design, spec delta, and tasks for CIMD consumption.
- [x] 1.2 Validate with `openspec validate add-mcp-cimd-client-identity --strict`.

## 2. Authorization-endpoint CIMD consumption

- [x] 2.1 Detect `https://`-URL `client_id` values in the authorize handler (`auth.js`).
- [x] 2.2 Validate the `client_id` URL before fetching: scheme, userinfo-absent, path
       non-empty/no-dot-segments/no-fragment, host not loopback/link-local/private/multicast.
- [x] 2.3 Resolve same-origin `/oauth/client-metadata/:id` client IDs from local storage instead of issuing an outbound self-fetch.
- [x] 2.4 Fetch external CIMD documents with redirects disabled, a 5-second timeout, and a 5 KB response-size cap.
- [x] 2.5 Cache only valid fetched documents: respect HTTP cache headers within a 60-second minimum and 24-hour maximum TTL, keyed on the exact URL.
- [x] 2.6 Validate `redirect_uri` against same-origin constraint with localhost/127.0.0.1/[::1] exception.
- [x] 2.7 On security-relevant metadata change (`redirect_uris`, `token_endpoint_auth_method`, `jwks`, or `jwks_uri`), revoke existing grants/tokens and invalidate cache.
- [x] 2.8 On fetch/validation failure, abort the authorize flow with a recoverable error and hostname context; do not issue a grant from hostname-only metadata.

## 3. Discovery advertisement

- [x] 3.1 Add `"client_id_metadata_document"` to `pdpp_registration_modes_supported` in
       `root-and-discovery.ts` / `metadata.ts`.
- [x] 3.2 Set `client_id_metadata_document_supported: true` only when behavior is implemented.

## 4. Client metadata document service

- [x] 4.1 Add `GET /oauth/client-metadata/:id` route (`server/routes/client-metadata.ts`).
       Serve `application/json`, `Cache-Control: max-age=3600`. 404 for unknown IDs.
- [x] 4.2 Add operator-side storage for client metadata documents (name, logo_uri,
       redirect_uris, allowed client types).
- [x] 4.3 Ensure each served document includes `client_id` equal to its URL, `redirect_uris`,
       and public-client `token_endpoint_auth_method: "none"`; reject shared-secret metadata.
- [x] 4.4 Wire document creation/deletion into the operator dashboard.

## 5. Operator dashboard — Connect Agents setup

- [x] 5.1 Add a single "Connect Agents" page or panel to the operator console. Keep the
       recommended hosted MCP OAuth path primary; keep CLI, agent skill / `llms.txt`,
       local stdio adapter, and owner-agent/API credentials as concise secondary or advanced paths.
- [x] 5.2 List operator-created CIMD documents and their stable URLs inside the Connect
       Agents flow rather than as a separate OAuth administration surface.
- [x] 5.3 Render one client-specific command set at a time for Claude Code and Codex
       (default OAuth and explicit CIMD identity variants) for each client identity.
- [x] 5.4 Include revocation action (deletes the document; tokens issued to that client_id
       are revoked server-side).

## 6. Verification

- [x] 6.1 Unit: CIMD URL validation rejects loopback, link-local, private, userinfo,
       fragments, dot-segments.
- [x] 6.2 Unit: redirect_uri same-origin constraint allows localhost exception, rejects
       cross-origin.
- [x] 6.3 Unit: fetch status/redirect/size-over-5-KB/timeout/malformed-document failures abort authorization and never issue a grant.
- [x] 6.4 Unit: security-relevant metadata changes trigger grant/token revocation.
- [x] 6.5 Unit: same-origin `/oauth/client-metadata/:id` client IDs resolve through local lookup, not network self-fetch.
- [x] 6.6 Integration: authorize with a CIMD client_id pointing to `/oauth/client-metadata/:id`
       on the same host yields a grant-scoped token and a successful `POST /mcp` call.
- [x] 6.7 Discovery: `/.well-known/oauth-authorization-server` includes
       `"client_id_metadata_document"` in `pdpp_registration_modes_supported`.
- [x] 6.8 Dashboard: Connect Agents page shows one recommended setup path by default,
       does not ask for owner/control-plane bearer tokens, and keeps advanced/headless
       credentials separate from normal MCP setup.
- [x] 6.9 Run `openspec validate add-mcp-cimd-client-identity --strict` and
       `openspec validate --all --strict` green.

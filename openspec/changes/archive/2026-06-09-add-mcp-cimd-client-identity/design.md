## Context

The reference AS supports three client registration paths today:
`pre_registered_public` (opaque IDs for PDPP CLI and dashboard, PKCE, no
secret), `dynamic` (RFC 7591 DCR), and the MCP adapter which rejects owner
tokens and requires grant-scoped client tokens. The existing discovery
vocabulary (`pdpp_registration_modes_supported`) is already reference-scoped.

CIMD (`draft-ietf-oauth-client-id-metadata-document-01`) eliminates the
registration handshake: the `client_id` is a URL; the AS fetches it on demand.
The MCP draft currently ranks CIMD above DCR and deprecates DCR as
backwards-compatible fallback. No deployed PDPP conformance claim is at risk,
but the reference becomes dated as MCP clients ship CIMD support.

## Goals / Non-Goals

**Goals:**

- Accept `https://`-URL `client_id` values at the authorize endpoint without
  prior DCR or pre-registration.
- Fetch, validate, cache, and surface the CIMD document for consent.
- Advertise the mode in AS discovery once the behavior is implemented.
- Provide an operator-managed `/oauth/client-metadata/:id` service for local
  clients that cannot self-host HTTPS metadata documents.
- Apply all CIMD §6 security safeguards as hard requirements, not
  best-effort mitigations.
- Preserve DCR and pre-registered-public paths unchanged.

**Non-Goals:**

- Publishing PDPP's own first-party clients (CLI, dashboard) as CIMDs. That is
  a follow-on after consumption lands.
- Changing Core, Collection Profile, or connector semantics.
- Removing DCR or pre-registered public clients.

## Decisions

### Detect CIMD client_id by URL scheme

Decision: if `client_id` at the authorize endpoint has an `https` scheme, treat
it as a CIMD client_id. Otherwise apply existing DCR / pre-registered logic.

Rationale: CIMD §3 and §6.9 define `https://` as the CIMD namespace. PDPP's
generated opaque IDs never start with `https://`, so the two namespaces cannot
collide.

Alternative considered: a separate `registration_type` parameter. Rejected as
non-standard; CIMD does not require one.

### Validate client_id URL before fetching

Decision: before any outbound fetch, validate that the `client_id` URL:
1. scheme is exactly `https`;
2. userinfo is absent;
3. path is non-empty and has no dot-segments (`/.` or `/..`) or fragment;
4. resolved host is not a loopback (`127.0.0.0/8`, `::1`), link-local
   (`169.254.0.0/16`, `fe80::/10`), private (`10.0.0.0/8`, `172.16.0.0/12`,
   `192.168.0.0/16`, `fc00::/7`), or multicast address;
5. port, if present, is accepted only after the same DNS/IP validation and
   fetch-time guardrails apply.

Rationale: the `client_id` URL is attacker-influenced (supplied in the
authorization request). Failing closed on all non-public targets is the minimum
SSRF control (CIMD §6.5).

PDPP-hosted client metadata documents are not fetched over the network. If the
`client_id` origin equals the AS issuer and the path matches
`/oauth/client-metadata/:id`, the AS resolves the document from local operator
storage. This avoids both an outbound self-fetch and a special SSRF bypass.

### Cap fetched document size and timeout

Decision: abort the CIMD fetch if the response body exceeds 5 KB or the fetch
takes longer than 5 seconds. Parse only the first 5 KB if a streaming decode is
used. Do not automatically follow HTTP redirects. Return an authorization error
to the caller if any fetch, status, timeout, size, or validation check fails
(CIMD §4.3, §6.6).

Rationale: an oversized or slow response is a resource-exhaustion vector. The
5 KB cap follows CIMD-01's recommended maximum for client metadata documents;
local MCP client documents should remain tiny JSON metadata, not a general
payload channel.

### Cache fetched documents

Decision: cache a successfully fetched and validated CIMD document for at least
60 seconds and no more than 24 hours. Cache key is the exact `client_id` URL.
Respect HTTP cache headers within those bounds. Re-fetch on a cache miss; do not
serve stale documents past the cache TTL; never cache failed, invalid, or
malformed responses.

Rationale: CIMD §4 notes that ASes may cache the document. Per-request fetches
to an external server on the hot authorize path are not acceptable in production.

### redirect_uri trust: same-origin default, localhost exception

Decision: require that all `redirect_uris` in the fetched CIMD document share
the same origin (scheme + host + port) as the `client_id` URL, OR are
`http://localhost:*/*`, `http://127.0.0.1:*/*`, or `http://[::1]:*/*`
(localhost development exception).
Reject authorize requests from a CIMD client that presents a `redirect_uri` not
in the fetched document (CIMD §6.1).

Rationale: restricting redirects to the same origin prevents a client from
impersonating a better-known client by registering a superior redirect. The
localhost exception preserves usability for local development tools (CIMD §4.2).

Alternative considered: no redirect_uri validation, rely on exact-match alone.
Rejected: exact-match without origin scoping is insufficient when the AS accepts
arbitrary URL client IDs.

### Security-relevant metadata change posture

Decision: when a re-fetched CIMD document changes security-relevant metadata
(`redirect_uris`, `token_endpoint_auth_method`, `jwks`, or `jwks_uri`), revoke
all existing grants/tokens issued to that `client_id` and invalidate the cache
entry. Log the event as a security audit record. Display-only changes such as
`client_name` or `logo_uri` may update without revocation.

Rationale: these changes can alter where codes are returned or how the client
authenticates. Failing closed (revoke + re-consent) is the conservative posture
for a reference that handles personal data grants (CIMD §6.3, §6.3.1).

### Abort on metadata discovery failure and display hostname

Decision: if the CIMD fetch fails (network error, non-200 status, validation
error, redirect, malformed document, or size/timeout limit), abort the authorize
flow with a recoverable authorization error and log the failure at WARN. The
owner-facing error UI SHALL display the `client_id` hostname so the owner can
understand which client failed, but the AS SHALL NOT issue a code, grant, token,
or consent prompt from hostname-only metadata.

Rationale: CIMD §4.3 says metadata discovery failures should abort. CIMD §6.4
requires hostname display to reduce phishing risk; it does not make hostname-only
identity sufficient for authorization.

### Client metadata document service at /oauth/client-metadata/:id

Decision: add a `GET /oauth/client-metadata/:id` route that serves operator-
created CIMD documents. An operator creates a client identity in the dashboard,
receives a stable URL (e.g.
`https://pdpp.vivid.fish/oauth/client-metadata/<uuid>`), and that URL is used
as the `client_id` when configuring Claude Code or Codex.

Rationale: local MCP clients (Claude Code, Codex) cannot host their own HTTPS
metadata URLs. Providing a PDPP-hosted document removes the only bootstrap gap
for these clients while keeping full CIMD semantics in the AS.

The route serves `application/json` with `Cache-Control: max-age=3600`. The
document MUST contain `client_id` equal to its own URL and `redirect_uris`. It
MAY contain `client_name`, `logo_uri`, and `token_endpoint_auth_method: "none"`
for public clients. The initial reference tranche supports public-client CIMD
only: shared-secret methods are rejected, `client_secret` fields are forbidden,
and `private_key_jwt` is deferred until the token endpoint implements that
client-authentication method.

### Connect Agents setup page

Decision: the operator dashboard exposes a single low-cognitive-tax "Connect
Agents" page or panel for recommended agent entrypoints. The page defaults to
hosted MCP OAuth setup, shows one client-specific command at a time, and keeps
advanced paths collapsed. It manages operator-created client identities as part
of that flow rather than presenting a separate OAuth administration surface.

Rationale: agent setup already carries cognitive tax from OAuth, client
identity, grant scope, local callbacks, CLI caches, and owner-token boundaries.
The reference should make the recommended path obvious and avoid turning setup
into a docs portal or a multi-layer component maze.

The page should present entrypoints in this order:

1. Hosted MCP OAuth (recommended): one MCP URL or command, browser approval, and
   grant-scoped token storage by the client.
2. PDPP CLI: terminal workflow for scoped grant setup, status, and
   troubleshooting.
3. Agent skill / `llms.txt`: discovery material for agents that should learn
   the workflow without guessing endpoints.
4. Local stdio MCP adapter: secondary path when a local scoped grant token is
   already available.
5. Owner-agent/API credentials: advanced/headless path, explicitly labeled as
   owner-level or API-level automation and not normal MCP setup.

For each operator-created client identity, the page shows copy-paste setup
commands. Templates:

Claude Code (default OAuth discovery):
```
claude mcp add --transport http pdpp https://pdpp.vivid.fish/mcp
```

Claude Code (explicit CIMD identity):
```
claude mcp add --transport http \
  --client-id https://pdpp.vivid.fish/oauth/client-metadata/<id> \
  pdpp https://pdpp.vivid.fish/mcp
```

Codex (default OAuth discovery):
```
codex mcp add pdpp --url https://pdpp.vivid.fish/mcp
```

Codex (explicit CIMD identity):
```
codex mcp add pdpp \
  --url https://pdpp.vivid.fish/mcp \
  --oauth-resource https://pdpp.vivid.fish/mcp \
  --oauth-client-id https://pdpp.vivid.fish/oauth/client-metadata/<id>
```

### Owner / control-plane token rejection remains unchanged

Decision: `/mcp` continues to reject owner and control-plane bearer tokens
(`mcp.no_owner_token: true`). This change adds no new bearer-token acceptance.
The normal MCP setup path does not involve the owner token; it uses the OAuth
authorize flow.

## Risks / Trade-offs

- Outbound fetch on the authorize hot path: mitigated by caching (60 s – 24 h),
  5 s timeout, and 5 KB cap. A blocking fetch on cache miss adds latency; this
  is acceptable given infrequent first-connects.
- CIMD is an early Internet-Draft (expires 2026-09-03): field names in AS
  metadata may change. Mitigation: the PDPP-specific vocabulary
  (`pdpp_registration_modes_supported`) is stable; the current draft field
  (`client_id_metadata_document_supported`) is added only when the implementation
  actually supports the behavior and can be renamed if the draft changes.
- SSRF residual: DNS rebinding during the TTL window could reroute a fetch.
  Mitigation: resolve and validate the IP at fetch time, not just at URL parse
  time; PDPP-hosted metadata documents are resolved from local storage rather
  than fetched over HTTP.

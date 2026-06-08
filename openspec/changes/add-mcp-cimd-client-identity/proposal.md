## Why

The MCP authorization draft now ranks OAuth Client ID Metadata Documents (CIMD,
`draft-ietf-oauth-client-id-metadata-document-01`) above Dynamic Client
Registration: an `https://`-URL `client_id` is the SHOULD-level registration
mechanism; DCR is retained only for backwards compatibility. As MCP clients
adopt CIMD, a reference AS that cannot accept URL-shaped client identifiers is
conformant-but-dated.

CIMD is also architecturally consistent with PDPP's existing design: PDPP
connector manifests are fetched, verifiable documents that travel with the
artifact, not pre-arranged identities. Applying that same model to the OAuth
client — identity is a fetchable document at a stable URL — lets the reference
present one coherent "fetched, verifiable, artifact-borne identity" model
end-to-end.

The change also adds an operator-managed CIMD document service for local MCP
clients (Claude Code, Codex) that cannot host their own stable HTTPS metadata
URLs, and hardens the resulting outbound-fetch path against SSRF.

## What Changes

- Accept an `https://`-URL `client_id` at the authorization endpoint. Fetch,
  validate, and cache the Client ID Metadata Document; drive consent surfaces
  from the fetched client name, logo, and hostname. Abort the authorization
  request on metadata discovery failure; hostname-only display is supporting
  error/consent context, not a substitute for validated metadata.
- Advertise the new capability in authorization-server discovery:
  `pdpp_registration_modes_supported` gains `"client_id_metadata_document"`;
  the standard AS metadata field is set once its name stabilizes in the draft.
- Preserve existing modes: `dynamic` (DCR) and `pre_registered_public` remain
  active. Generated/opaque client IDs do not start with `https://` and do not
  collide with the CIMD namespace (CIMD §6.9).
- Apply SSRF, response-size, redirect_uri trust, and metadata-change safeguards
  as first-class requirements (CIMD §4.3, §6.1, §6.3.1, §6.4, §6.5, §6.6).
- Add a `GET /oauth/client-metadata/:id` route serving operator-created stable
  CIMD documents for local MCP clients. The operator dashboard surfaces
  copy-paste setup commands for Claude Code, Codex, and custom clients.
- Reject owner and control-plane bearer tokens at `/mcp` (already enforced;
  this change does not alter that posture but documents it normatively).

## Capabilities

### New Capabilities

- `reference-implementation-architecture`: CIMD consumption at the authorization
  endpoint; CIMD document service at `/oauth/client-metadata/:id`.

### Modified Capabilities

- `reference-implementation-architecture`: AS discovery advertisement extended
  with `client_id_metadata_document` registration mode.
- `reference-agent-access-workflow`: local MCP client setup commands updated to
  reflect PDPP-managed CIMD identity as the preferred path.

## Impact

- Affects `reference-implementation/server/auth.js` (authorize endpoint,
  CIMD fetch/cache), `server/routes/root-and-discovery.ts` / `metadata.ts`
  (discovery advertisement), and a new `server/routes/client-metadata.ts` route.
- Affects `apps/console` operator dashboard (client metadata document management
  UI and copy-paste command templates).
- Introduces one new outbound-fetch code path guarded by SSRF controls.
- No Core, Collection Profile, or connector wire changes.

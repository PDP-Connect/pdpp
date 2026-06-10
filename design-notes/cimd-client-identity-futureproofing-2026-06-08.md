# OAuth Client ID Metadata Documents (CIMD) and PDPP Client Identity

Status: captured
Owner: project owner (the owner) + RI owner
Created: 2026-06-08
Updated: 2026-06-08
Related: `openspec/specs/reference-implementation-architecture/spec.md`,
  `openspec/specs/reference-agent-access-workflow/spec.md`,
  `openspec/specs/mcp-adapter/spec.md`,
  `reference-implementation/server/routes/root-and-discovery.ts`,
  `reference-implementation/server/metadata.ts`,
  `design-notes/client-metadata-decision.md` (client_display / client_claims),
  `design-notes/ref-read-auth-posture-2026-04-27.md`

## Question

The OAuth ecosystem and the MCP authorization specification are moving client
identification away from Dynamic Client Registration (DCR) toward **OAuth Client
ID Metadata Documents (CIMD)**, in which the `client_id` is itself an HTTPS URL
that hosts a JSON document describing the client. What does this mean for the
PDPP reference authorization server if it is to remain conformant, futureproof,
and exemplary as the trust model evolves — and is there work to do beyond what
the reference already ships?

## Context

### What PDPP already does (verified against the live reference)

The reference deployment at `https://pdpp.vivid.fish` is already a
standards-compliant OAuth protected resource. Observed live:

- `POST /mcp` without a token returns `401` with
  `WWW-Authenticate: Bearer resource_metadata="https://pdpp.vivid.fish/.well-known/oauth-protected-resource"`.
- `/.well-known/oauth-protected-resource` returns RFC 9728 Protected Resource
  Metadata naming `authorization_servers: ["https://pdpp.vivid.fish"]`.
- `/.well-known/oauth-authorization-server` returns RFC 8414 Authorization
  Server Metadata advertising `authorization_endpoint`, `token_endpoint`,
  `device_authorization_endpoint`, `registration_endpoint`,
  `pushed_authorization_request_endpoint`, `code_challenge_methods_supported:
  ["S256"]`, and `grant_types_supported` including `authorization_code`,
  `refresh_token`, and the device-code grant.
- It advertises `pdpp_registration_modes_supported: ["dynamic",
  "pre_registered_public"]` and ships a list of `pdpp_pre_registered_public_clients`
  (e.g. `pdpp_cli`, `pdpp-web-dashboard`), all with
  `token_endpoint_auth_method: "none"` (public PKCE clients).
- The `/mcp` resource explicitly rejects owner bearer tokens
  (`mcp.no_owner_token: true`; `mcp_owner_bearer_rejected: true`): MCP access
  requires a grant-scoped client token, not the owner/control-plane token.

In short, PDPP already satisfies the two server-side `MUST`s of the current MCP
authorization specification (RFC 9728 Protected Resource Metadata; an RFC 8414 /
OIDC discovery document) and supports a non-DCR client path today via
pre-registered public clients. Nothing below is a conformance defect.

### What is changing in the specs

- The MCP authorization specification is transport-conditional: authorization is
  OPTIONAL overall, but HTTP-based transports SHOULD conform, while STDIO
  transports SHOULD NOT and instead read credentials from the environment. The
  authorization mechanism is built on OAuth 2.1 [MCP-AUTH-2025-06-18].
- The MCP **draft** authorization spec now ranks the client-registration
  mechanisms explicitly [MCP-AUTH-DRAFT]:
  - Authorization servers and MCP clients **SHOULD** support OAuth Client ID
    Metadata Documents (CIMD).
  - They **MAY** support OAuth 2.0 Dynamic Client Registration (RFC 7591), and
    "Dynamic Client Registration is deprecated and retained for backwards
    compatibility with authorization servers that do not support Client ID
    Metadata Documents."
- CIMD is `draft-ietf-oauth-client-id-metadata-document-01` (Parecki & Smith,
  2 March 2026, expires 3 September 2026) [CIMD-01]. The MCP draft currently
  references `-00`. It is an active IETF Internet-Draft, i.e. a moving target.

### How CIMD works (from CIMD-01)

- The `client_id` is a URL with an `https` scheme that MUST contain a path
  component, MUST NOT contain dot-segments or a fragment, MUST NOT carry
  userinfo, SHOULD NOT carry a query string, and MAY contain a port. A short,
  stable URL is RECOMMENDED because it may be shown to the user (CIMD-01 §3).
- The authorization server SHOULD fetch the document at the `client_id` URL; a
  successful response MUST be `200 OK` and is parsed as the client's metadata
  (e.g. `client_name`, `logo_uri`, `redirect_uris`, optionally `jwks`/`jwks_uri`)
  (CIMD-01 §4).
- There is no prior registration handshake: "an OAuth client can identify itself
  to authorization servers, without prior dynamic client registration or other
  existing registration" (CIMD-01 Abstract).
- Confidential-client authentication is still possible without shared secrets:
  clients MAY publish a public key (`jwks`/`jwks_uri`) and authenticate with the
  matching private key (CIMD-01 §6.2). If the published keys change, the AS MAY
  revoke that client's tokens or the user's consent (CIMD-01 §6.3.1).

### Why the ecosystem is moving (problem CIMD solves)

DCR required the AS to accept registrations from arbitrary clients; in practice
few authorization servers implemented it, which pushed many remote MCP servers
toward proxy patterns that produced real one-click account-takeover
vulnerabilities [OBSIDIAN-2025]. CIMD removes the registration handshake while
giving the AS a verifiable, stable, fetchable identity for the client (its
domain), which it can show to the user and re-check over time. The 2026 ecosystem
consensus is not that OAuth is the wrong fit for MCP, but that DCR-era
implementation friction was; CIMD is the direct response [SPEAKEASY-2026].

### Provider patterns to emulate

The SLVP target should emulate current high-quality remote MCP provider shape,
not a bespoke bearer-token setup:

- **Linear** is the closest end-to-end pattern. Its normal remote MCP setup is a
  hosted Streamable HTTP endpoint plus an OAuth flow initiated by the MCP client.
  Linear documents simple commands for both Claude Code and Codex, and the
  normal path does not require the user to paste a bearer token or API key
  [LINEAR-MCP-2026].
- **Sentry** is the clearest Claude Code command pattern: add one hosted HTTP MCP
  URL, then let the client drive OAuth. PDPP should match that "one endpoint,
  then browser approval" feel for Claude Code [SENTRY-MCP-2026].
- **Notion** is the relevant personal/workspace data precedent: a hosted MCP
  endpoint with owner authorization through OAuth, plus a separate token/server
  option for automation. PDPP should copy the OAuth-first owner experience, not
  the headless fallback as the default [NOTION-MCP-2026].
- **Stripe** is useful only as a fallback analogue: OAuth for normal MCP clients,
  bearer/API-key access for explicit agentic or headless software. PDPP should
  retain bearer-style paths only for deliberate owner-agent/API use, never as the
  normal MCP setup [STRIPE-MCP-2026].

The resulting target UX is: an operator gives the client one MCP URL, the client
discovers OAuth, the owner approves a scoped PDPP grant in the browser, and the
client stores a grant-scoped token locally. Owner/control-plane tokens are not
part of the normal MCP connection path.

## Stakes

Medium, with a high narrative payoff specific to PDPP.

- **Conformance:** nothing is broken today, and CIMD support is a `SHOULD`, not a
  `MUST`. Doing nothing keeps PDPP conformant with the current published spec.
- **Futureproofing:** as MCP clients adopt CIMD, the most frictionless way for a
  new third-party agent to connect to a PDPP provider — with no pre-registration
  and no DCR — is to present an `https://` `client_id`. A reference that cannot
  consume that is conformant-but-dated.
- **Thesis alignment (the reason this is worth more to PDPP than to a typical
  SaaS):** CIMD is the same architectural move PDPP already made for source
  identity. PDPP's connector manifests and `client_display` establish that an
  identity travels with the artifact and is fetched and verified, not
  pre-arranged (`design-notes/client-metadata-decision.md`). CIMD applies exactly
  that idea to the OAuth client: identity is a fetched, verifiable document at a
  stable URL. Supporting CIMD lets the reference present one coherent
  "fetched, verifiable, artifact-borne identity" model end-to-end — the consent
  surface could render a CIMD-fetched client the same way it renders a
  manifest-authored connector. That is a depth-and-honesty result an engineer or
  standards reviewer can verify against real HTTP, not prose.

## Current Leaning

Treat CIMD as additive futureproofing, not a migration, and design the seam now
while implementing against a stabilizing target. The smallest correct-by-
construction tranche, in priority order:

1. **Consume an `https://`-URL `client_id` at the authorization endpoint.** When
   `client_id` has an `https` scheme, fetch and validate the Client ID Metadata
   Document and drive consent (client name, logo, hostname) from it, rather than
   requiring DCR or a pre-registered id. This is the single change that makes
   PDPP first-class in the post-DCR world. The AS SHOULD also display the
   `client_id` hostname on the consent interface regardless of fetch success
   (CIMD-01 §6.4).

2. **Advertise the capability in discovery.** Add a CIMD mode to the existing
   `pdpp_registration_modes_supported` vocabulary (e.g.
   `"client_id_metadata_document"`) and set the standard authorization-server
   metadata flag once its name stabilizes in the draft, served from
   `root-and-discovery.ts` / `metadata.ts`. This lets spec-aware clients skip
   registration entirely.

3. **Keep existing modes for backwards compatibility.** Retain `dynamic` and
   `pre_registered_public`. CIMD explicitly supports mixed deployments: an AS
   that also generates its own client_ids SHOULD ensure those generated ids do
   not start with `https://` so the two namespaces never collide (CIMD-01 §6.9).
   PDPP's generated/opaque client_ids already satisfy this.

4. **Apply the CIMD security safeguards as first-class requirements**, because a
   server that fetches a URL supplied in an authorization request is exposed to
   new risks the draft enumerates:
   - SSRF: the fetch targets an attacker-influenced URL; restrict schemes to
     `https`, block internal/loopback/link-local targets, and disallow
     credentialed URLs (CIMD-01 §6.5).
   - Response-size bound: cap the fetched document size to avoid resource
     exhaustion (CIMD-01 §6.6).
   - redirect_uri trust: consider restricting `redirect_uris` to the same origin
     as the `client_id` to prevent a client impersonating a better-known one
     (CIMD-01 §6.1), while providing a development exemption path so localhost
     development is still possible (CIMD-01 §4.2).
   - Metadata change handling: on a `jwks`/`jwks_uri` change, decide a revocation
     posture (CIMD-01 §6.3.1).

5. **Provide a PDPP client-metadata document service for local MCP clients.**
   Local clients such as Codex and Claude Code often cannot host their own stable
   HTTPS metadata URL. The reference should provide an operator-created stable
   HTTPS Client ID Metadata Document for these clients, with templates for
   Claude Code, Codex, and custom clients. The dashboard should display the
   copy-paste command for each client and manage the generated client identity,
   active grants, and revocation. The normal commands should look like:

   - Claude Code, default OAuth discovery:
     `claude mcp add --transport http pdpp https://pdpp.vivid.fish/mcp`
   - Claude Code, explicit PDPP-managed CIMD identity:
     `claude mcp add --transport http --client-id https://pdpp.vivid.fish/oauth/client-metadata/<client-id> pdpp https://pdpp.vivid.fish/mcp`
   - Codex, default OAuth discovery:
     `codex mcp add pdpp --url https://pdpp.vivid.fish/mcp`
   - Codex, explicit PDPP-managed CIMD identity:
     `codex mcp add pdpp --url https://pdpp.vivid.fish/mcp --oauth-resource https://pdpp.vivid.fish/mcp --oauth-client-id https://pdpp.vivid.fish/oauth/client-metadata/<client-id>`

   If a client does not yet support URL-shaped client IDs, the fallback remains
   DCR. If a client cannot perform OAuth at all, the fallback is an explicitly
   configured owner-agent/API credential, not the default MCP UX.

This work belongs to the reference authorization-server surface
(`reference-implementation-architecture` and `reference-agent-access-workflow`
specs), not to PDPP Core: how a reference AS identifies OAuth clients is
reference/operator behavior, and the existing discovery vocabulary
(`pdpp_registration_modes_supported`) is already reference-scoped. If a portable
provider-connect requirement is later wanted, it can be promoted through a
companion spec, mirroring how other reference-only discovery hints are scoped.

## Options

1. **No-op (stay on DCR + pre-registered public clients).** Conformant with the
   published spec today; becomes dated as clients adopt CIMD and as DCR's
   deprecation hardens. Lowest effort, lowest futureproofing.
2. **Advertise-only.** Add the CIMD mode string to discovery without implementing
   the authorize-endpoint fetch. Rejected: dishonest — it would advertise a
   capability the server does not enforce, which contradicts the reference's
   "demonstrated, not mentioned" bar.
3. **Full CIMD consumption + advertisement + safeguards (the leaning).** The AS
   accepts URL client_ids, fetches/validates the document, drives consent from
   it, and advertises the mode. Highest futureproofing and the strongest
   thesis-alignment payoff; contained to the AS surface.
4. **Also publish PDPP's own first-party clients as CIMDs** (e.g. host a Client
   ID Metadata Document for the PDPP CLI / dashboard so they identify by URL).
   Optional follow-on once consumption lands; makes PDPP a CIMD client as well as
   a CIMD-accepting server, completing the symmetry. Deferred.
5. **Client metadata document service for local clients.** Generate stable
   operator-managed HTTPS client metadata URLs and copy-paste setup commands for
   Claude Code, Codex, and custom local clients. This is the SLVP UX layer on top
   of option 3: it preserves OAuth/CIMD semantics while removing the need for
   local tools to host their own HTTPS metadata documents.

## Non-Goals

- Changing PDPP Core or Collection Profile wire semantics. This is
  reference-implementation authorization-server behavior.
- Removing DCR or pre-registered public clients. Futureproofing here is additive.
- Implementing CIMD before the demo. Current OAuth (PRM + AS metadata + PKCE +
  pre-registered public clients) is already conformant and demonstrable; CIMD is
  post-demo work against a still-moving draft.

## Promotion Trigger

Promote to an OpenSpec change when the owner decides to implement option 3,
because it adds an authorization-server capability (URL-as-client_id fetch),
introduces new security-relevant server behavior (outbound fetch of an
attacker-influenced URL), and extends a publicly advertised discovery vocabulary
— each of which crosses the promotion rule. A reasonable trigger to wait for is
CIMD reaching IETF stability beyond an early Internet-Draft, or an MCP client PDPP
cares about (Claude / ChatGPT / Codex / Gemini) shipping CIMD client support,
whichever comes first. The change should specify: the authorize-endpoint
acceptance of `https://` client_ids, the fetch/validate/cache rules, the SSRF and
response-size and redirect_uri safeguards, the discovery advertisement, and an
end-to-end proof (a URL-client_id authorization that yields a grant-scoped token
and a successful `/mcp` call).

## Decision Log

- 2026-06-08: Captured after researching the MCP authorization spec
  (2025-06-18 and draft), CIMD-01, and 2026 ecosystem commentary while
  evaluating how to wire PDPP's `/mcp` into the dotfiles agent fleet. Established
  three facts: (1) PDPP's `/mcp` is already a spec-conformant OAuth protected
  resource and intentionally rejects owner tokens; (2) CIMD is a `SHOULD` in the
  MCP draft and DCR is now deprecated-but-retained, so no current PDPP behavior
  is at risk; (3) the futureproof/ideal addition is server-side CIMD consumption
  at the authorize endpoint plus discovery advertisement, governed by the
  draft's SSRF/size/redirect_uri safeguards. Noted the thesis alignment with
  PDPP's existing fetched-verifiable-identity model for connectors/`client_display`.
- 2026-06-08: Left as `captured` (not `decided-promote`) because CIMD is an early
  Internet-Draft and no MCP client PDPP targets has shipped CIMD client support
  yet; implementing now would track a moving target. Recorded the promotion
  trigger above.

## References

- [MCP-AUTH-2025-06-18] Model Context Protocol — Authorization (2025-06-18).
  https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- [MCP-AUTH-DRAFT] Model Context Protocol — Authorization (draft).
  https://modelcontextprotocol.io/specification/draft/basic/authorization
- [CIMD-01] Parecki, A. and E. Smith, "OAuth Client ID Metadata Document",
  draft-ietf-oauth-client-id-metadata-document-01, 2 March 2026.
  https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
- [RFC 9728] OAuth 2.0 Protected Resource Metadata.
  https://datatracker.ietf.org/doc/html/rfc9728
- [RFC 8414] OAuth 2.0 Authorization Server Metadata.
  https://datatracker.ietf.org/doc/html/rfc8414
- [RFC 7591] OAuth 2.0 Dynamic Client Registration Protocol.
  https://datatracker.ietf.org/doc/html/rfc7591
- [RFC 8707] Resource Indicators for OAuth 2.0.
  https://www.rfc-editor.org/rfc/rfc8707.html
- [OBSIDIAN-2025] Obsidian Security, "When MCP Meets OAuth: Common Pitfalls
  Leading to One-Click Account Takeover".
  https://www.obsidiansecurity.com/blog/when-mcp-meets-oauth-common-pitfalls-leading-to-one-click-account-takeover
- [SPEAKEASY-2026] Speakeasy, "Authenticating MCP servers".
  https://www.speakeasy.com/mcp/securing-mcp-servers/authenticating-mcp-servers
- [LINEAR-MCP-2026] Linear, "MCP server".
  https://linear.app/docs/mcp
- [SENTRY-MCP-2026] Sentry MCP.
  https://mcp.sentry.dev/
- [NOTION-MCP-2026] Notion, "Connecting to Notion MCP".
  https://developers.notion.com/docs/get-started-with-mcp
- [STRIPE-MCP-2026] Stripe, "Model Context Protocol (MCP)".
  https://docs.stripe.com/mcp
- Live PDPP discovery (observed 2026-06-08):
  `https://pdpp.vivid.fish/.well-known/oauth-protected-resource`,
  `https://pdpp.vivid.fish/.well-known/oauth-authorization-server`.

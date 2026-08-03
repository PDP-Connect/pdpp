# SECURITY-CONTRACT audit: MCP `resource` parameter / RFC 8707 audience binding

Date: 2026-08-02
Scope: reference-implementation AS OAuth `resource` parameter — parsed, validated, discarded.
Decision: **SPEC-PACKET, not implementation.**

## 1. What RFC 8707 requires

RFC 8707 "Resource Indicators for OAuth 2.0" (https://www.rfc-editor.org/rfc/rfc8707.html):

- **§2 (parameter definition):** `resource` is an absolute URI, MUST NOT include a fragment,
  SHOULD NOT include a query component. Clients MAY send it at the authorization endpoint
  (§2.1) and/or the token endpoint (§2.2), including on refresh (§2.2 covers refresh_token
  grant re-declaration). Multiple `resource` values MAY be sent to request a token valid at
  several resources.
- **§2 (AS obligation — the only MUST-adjacent language toward the AS is a SHOULD):**
  "The authorization server SHOULD audience-restrict issued access tokens to the resource(s)
  indicated by the `resource` parameter." The AS MAY map the raw `resource` value to a
  different/abstract audience identifier communicated via the `aud` claim — the mapping is
  implementation-defined.
- **§2.1.4 / error handling:** if the AS can't parse or doesn't accept a resource value, it
  SHOULD reject with `invalid_target`.
- **§3.3:** using a single `resource` parameter is "encouraged"; multi-audience tokens require
  a high degree of mutual trust among the named resources, because any one of them could
  replay the token at another.
- **Resource-server verification: RFC 8707 imposes NO normative requirement here.** It defines
  how a token *can* be audience-restricted at issuance; it says nothing about what a resource
  server must check on receipt. That is the RFC's explicit scope boundary, confirmed by
  direct reading of the full RFC text (WebFetch of rfc-editor.org, 2026-08-02).

## 2. What the current MCP specification requires

Fetched directly, 2026-08-02:
- Current/latest revision: **2026-07-28** (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) — confirmed via https://modelcontextprotocol.io/specification/versioning ("The current protocol version is 2026-07-28").
- Also fetched the prior revision 2025-11-25 (https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) for comparison.

The load-bearing clauses are **byte-for-byte identical** across both revisions:

> "MCP clients **MUST** implement Resource Indicators for OAuth 2.0 as defined in RFC 8707... The `resource` parameter: 1. MUST be included in both authorization requests and token requests. 2. MUST identify the MCP server that the client intends to use the token with. 3. MUST use the canonical URI of the MCP server..."
> "MCP clients **MUST** send this parameter regardless of whether authorization servers support it."

> "MCP servers, acting in their role as an OAuth 2.1 resource server, MUST validate access tokens... MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience, according to RFC 8707 Section 2. If validation fails, servers MUST respond [with] ... Invalid or expired tokens MUST receive a HTTP 401 response... MCP servers **MUST** only accept tokens that are valid for use with their own resources. MCP servers **MUST NOT** accept or transit any other tokens."

> Security Considerations / Access Token Privilege Restriction: "When an MCP server doesn't verify that tokens were specifically intended for it (for example, via the audience claim...), it may accept tokens originally issued for other services. This breaks a fundamental OAuth security boundary... MCP servers **MUST** only accept tokens specifically intended for themselves and **MUST** reject tokens that do not include them in the audience claim or otherwise verify that they are the intended recipient of the token."

**This is the crux: the MCP spec, independent of RFC 8707's own permissiveness, converts audience
binding into a hard bilateral MUST** — client MUST send `resource`, server MUST validate audience
on every request and 401 on mismatch. RFC 8707 alone would not have obligated PDPP to do anything
on the resource-server side; the MCP spec does. This has been stable since at least 2025-11-25;
2026-07-28's changes in this area are additive (RFC 9207 `iss` mix-up protection, refresh-token
guidance) and do not touch the resource/audience clauses.

Full research capture, with exact quotes and both revision URLs: `~/code/dotfiles/ai/research/oauth-mcp-auth/mcp-spec-mandates-rfc-8707-resource-parameter-and-server-side-audience-validation.md`, indexed in `~/code/dotfiles/ai/research/INDEX.md`.

## 3. What PDPP currently specifies vs. implements

**Specifies:** Nothing. Searched exhaustively:
- `spec-auth-design.md` (78 lines, root of reference-implementation) — the only "resource" hits
  are generic OAuth "resource server" terminology (line 8, 12, 31, 41: RFC 6750 bearer format,
  `pdpp_token_kind` discriminator). Zero mentions of RFC 8707, the `resource` parameter, `aud`,
  or audience binding.
- `openspec/specs/mcp-adapter/spec.md` — every "resource" hit is either "resource server" (the
  RS role generally) or "protected-resource metadata" (RFC 9728 discovery). No mention of the
  RFC 8707 `resource` request parameter or audience binding.
- `openspec/specs/reference-agent-access-workflow/spec.md` — same pattern; one CIMD example
  even shows `--oauth-resource https://<pdpp-host>/mcp` as a CLI flag example, but the spec
  never defines what the AS/RS do with that value once received.
- Full-repo grep for `RFC 8707`, `8707`, `resource indicator`, `audience`, `\baud\b` (outside
  the terminology above) returns nothing across `reference-implementation/` docs and `openspec/`.

**Conclusion: the contract is genuinely undefined by PDPP, not merely unimplemented.** This is
not a case of "spec says X, code doesn't do X" — there is no X.

**Implements (confirmed by direct code read, file:line):**
- `reference-implementation/server/routes/as-oauth.ts:118-127` (`handleMcpDeviceAuthorization`):
  parses `resource` from the device-authorization request body; **400s with `invalid_request` if
  absent** (`"resource is required for MCP device authorization"`).
- `reference-implementation/server/index.js:3030-3070` (`initiateMcpDeviceAuth`): re-validates
  `resource` as an absolute URL (`new URL(resource)`) and requires `resourceUrl.pathname === '/mcp'`
  exactly, else throws `invalid_request`. **After this validation, `resource` is never referenced
  again** — the call to `consentStore.initiateGrant(...)` at index.js:3045-3054 passes only
  `client_id` and `authorization_details`.
- `reference-implementation/server/auth.js:2742` (`initiateGrant`): the `normalized` request
  object built here (via `normalizePendingGrantRequest`) has no `resource` field anywhere in its
  shape; it is not stored on the `pending_consents` row, not carried into `grants.grant_json`,
  and not present in the `request.submitted` spine event payload (auth.js:2772-2792).
- Both token-table schemas have no resource/audience column:
  - SQLite: `reference-implementation/server/db.js:324-333` (`tokens` table: `token_id, grant_id,
    package_id, subject_id, client_id, token_kind, expires_at, revoked, created_at` — no
    resource/aud column).
  - Postgres: `reference-implementation/server/postgres-storage.js:568-578` (identical column set).
- The `/mcp` route's own access gate, `requireClientOrMcpPackage`
  (`reference-implementation/server/index.js:1255-1266`), checks only
  `req.tokenInfo.pdpp_token_kind` (`'client'` or `'mcp_package'`) — **it has no concept of
  audience/resource at all.** A client token minted for an entirely different intended use would
  pass this gate identically to one that correctly declared `resource=.../mcp`.
- Refresh: `exchangeOAuthRefreshToken` (`reference-implementation/server/auth.js:5263`) has no
  `resource` parameter handling whatsoever — confirmed by grep, zero `resource` references in
  the function. RFC 8707 §2.2 expects `resource` to be re-declarable (and, per the AS's own
  issuance policy, potentially re-validated) on every refresh; this path doesn't touch the
  concept at all.

## 4. The precise gap

PDPP's AS **performs exactly one check that looks like audience enforcement** — the hardcoded
`pathname === '/mcp'` string comparison — but that check is: (a) not persisted anywhere, so it
cannot be re-verified at request time by the resource server; (b) not general (it hardcodes a
single literal path rather than validating against a configured canonical resource-server URI,
so it would not detect a same-path-different-host resource confusion in a multi-origin
deployment); (c) performed once, at issuance, and never again — the MCP spec requires validation
"before processing the request," i.e., on every `/mcp` call, which nothing in this codebase does.

The code *implies* a real audience check (it 400s if you omit `resource`, it validates URL shape,
it validates the path) — but delivers none of the security property RFC 8707 + MCP actually ask
for (a token minted under this flow cannot currently be distinguished, at request time, from a
token that would have been minted for any other purpose, because nothing about `resource` survives
past the point where the check runs).

## 5. Decision, against the bar

**Bar:** implement only if the complete audience-binding contract is unambiguous from RFC 8707 +
current MCP spec + PDPP's existing spec/model — exact storage, exact check, exact failure mode,
per path, without inventing policy.

**RFC 8707 + MCP clear the WHAT:** client MUST send canonical-URI `resource`; server MUST validate
audience on every request; MUST 401 with no data returned on mismatch; SHOULD single-audience,
not multi.

**They do NOT clear the HOW, and neither does PDPP's own spec — three unresolved policy questions
that would require me to invent rather than read off a contract:**

1. **Which token kinds get an audience, and what audience?** PDPP has three `pdpp_token_kind`
   values (`owner`, `client`, `mcp_package` — index.js:1237/1244/1255) plus REST `/v1` routes that
   a `client` token also serves. RFC 8707/MCP's model assumes one resource server per audience
   value; PDPP's `client` tokens are used for both `/v1` REST and (per `requireClientOrMcpPackage`)
   potentially `/mcp`. Does a `client` token need an audience distinguishing REST-only from
   MCP-capable, or is `/mcp` simply an additional accepted audience value alongside implicit
   REST access? `mcp_package` tokens are a PDPP-specific extension (hosted MCP grant packages)
   with no RFC 8707/MCP-spec analog at all — what audience semantics apply to them is a PDPP
   product decision, not something derivable from either spec.
2. **What happens on refresh?** `exchangeOAuthRefreshToken` (auth.js:5263) has zero `resource`
   handling. RFC 8707 §2.2 expects resource re-declaration at refresh. Does PDPP bind the
   audience permanently to the grant at issuance (simpler, arguably matches PDPP's existing
   grant-scoped model) or re-validate/re-accept `resource` on every refresh (matches the RFC
   more literally, but is unspecified for PDPP's refresh-token semantics elsewhere)? This is a
   design choice with real behavioral consequences (can a refreshed token silently change
   audience?) that neither RFC 8707 nor PDPP's spec resolves for me.
3. **Is single-deployment, single-`/mcp`-path validation (what exists today) an acceptable
   permanent design, or does PDPP intend future multi-origin/multi-tenant MCP deployments where
   the audience must be a full canonical URI comparison rather than a path literal?**
   spec-auth-design.md and the mcp-adapter spec are silent on deployment topology assumptions.
   Building the "complete" contract now means picking one of these, and picking wrong either
   over-engineers a single-tenant deployment or under-specifies a future multi-tenant one.

Implementing a schema + check now would require me to silently resolve all three in code —
exactly the "inventing policy" the bar forbids. Per the brief's own reasoning: a partial
audience-binding check that answers only "does `resource` look like an absolute URL ending in
`/mcp`" **is worse than the current honest 400-if-missing stub**, because it would read, to any
future reviewer, as "audience binding: done" while leaving every one of the three questions above
silently unresolved and untested. That is precisely the "appearance of a security control that
does not hold" the brief warns against.

**Decision: SPEC-PACKET.** One-line reason: *RFC 8707 + MCP give an unambiguous WHAT (bind and
validate audience on every `/mcp` request) but zero guidance on PDPP's HOW across three
independent-token-kind, refresh, and topology axes that PDPP's own spec has never resolved —
implementing now would mean inventing product policy under the banner of "spec compliance."*

## 6. Proposed contract (for the spec-packet / next change proposal)

This section is the deliverable content for a follow-up `openspec/changes/...` proposal — not
something implemented in this audit.

**Schema change (both backends, additive, non-breaking):**
- Add `resource TEXT` (nullable) to `grants` (both `server/db.js` grants table and
  `server/postgres-storage.js` grants table), following the existing guarded-`ALTER TABLE`
  migration pattern already used in this file (see e.g. the migration transactions around
  db.js:1706, 1862, 2060 and the `version_counter` table at db.js:1011/2119) — additive nullable
  column needs no backfill, existing rows stay `NULL` (unbound / no audience claim, matches
  today's actual security posture honestly rather than retroactively claiming compliance).
- Do NOT add a column to `tokens` directly; store audience once on `grants` and resolve it via
  the existing `grant_id` foreign key at introspection time (avoids duplicating the value and
  avoids a second place that could drift from the grant's actual binding).

**Storage location:** `resource` is captured in `initiateGrant` (auth.js:2742) alongside
`client_id`/`authorization_details`, persisted on the `grants` row created in
`createPendingConsent`, and copied forward wherever a `grants` row becomes a `tokens` row
(the redemption path that currently sets `token_kind`).

**Validation points:**
1. At issuance (`initiateMcpDeviceAuth`, index.js:3030): keep existing URL-shape and path
   validation, but resolve "what `/mcp` paths are legal" against a **configured** canonical
   resource-server URI (e.g. `AS_PUBLIC_URL` + `/mcp`) rather than a bare pathname literal —
   this is what makes the check mean something in a future multi-origin deployment and is a
   direct instance of RFC 8707's "canonical URI" requirement, not new policy.
2. At token-issuance/redemption time: copy the grant's stored `resource` onto the resulting
   token record (or resolve via `grant_id` join at read time — either satisfies the requirement;
   picking one is part of the change proposal, not this audit).
3. At `/mcp` request time, inside `requireClientOrMcpPackage` (index.js:1255) or immediately
   after it: compare `req.tokenInfo`'s resolved audience against the server's own canonical
   `/mcp` resource URI. Reject (401, per MCP spec — not 403) on mismatch or absence-with-required
   policy, mirroring the existing `pdpp_token_kind` gate's shape exactly.

**Failure modes (per MCP spec, not invented):**
- Audience present but mismatched → HTTP 401 (MCP spec: "Invalid or expired tokens MUST receive
  a HTTP 401 response" — audience failure is treated the same as any other token-validation
  failure), reusing the existing `setProtectedResourceMetadataChallenge` + `pdppError(res, 401,
  'authentication_error', ...)` pattern already used at index.js:1229-1230 for other
  invalid-token cases.
- Audience absent on a legacy/pre-migration token (`NULL` column) → policy decision for the
  proposal: fail closed (safer, but breaks any token issued before the migration ships) vs.
  grandfather `NULL` as "no restriction" (matches today's de facto behavior, but never actually
  closes the gap for tokens issued under the old code path). This is exactly the kind of binary
  policy call this audit is not authorized to make silently.

**Migration implications:** additive nullable column, no backfill required, no breaking change
to existing grants/tokens rows. Existing rows are honestly `NULL` (never had an audience bound)
rather than backfilled with a guessed value.

**Test plan (for the eventual implementation PR):**
- Positive: MCP device-auth grant with `resource=https://host/mcp` issues a token whose stored
  audience round-trips correctly through redemption.
- Negative: token minted under one audience presented at `/mcp` when server's canonical resource
  URI differs → 401, verified against the exact error shape MCP spec requires.
- Negative: token with `NULL`/absent audience under whichever failure-mode policy is chosen —
  test the chosen policy explicitly, not both, once the proposal resolves the ambiguity in §6
  above.
- Refresh: whatever refresh policy is chosen (permanent grant-bound audience vs. re-declared) —
  test that `exchangeOAuthRefreshToken` either preserves or re-validates audience per that policy,
  since today it silently ignores the concept entirely.
- Regression: confirm `pdpp_token_kind`-only gating (owner/client/mcp_package distinction)
  continues to work unchanged — this change is additive to that gate, not a replacement.

## 7. What the RI owner most needs to know

**The single most important fact:** in the current single-tenant deployment there is exactly one
legal `resource` value, so this gap has no known live exploit today — but the code's existing
validation (URL-shape check, exact-`/mcp`-pathname check, 400-if-missing) reads exactly like a
real audience check to any future reader, security reviewer, or agent extending this code. It
is not: nothing computed here survives past index.js:3043. If PDPP ever runs multiple resource
servers, allows a client to hold both a REST-scoped and an MCP-scoped token, or is audited
against the MCP spec's explicit "Access Token Privilege Restriction" security-considerations
section, this gap goes from theoretical to load-bearing. Treat the fix as "convert an
implied-but-absent control into a real one," not as "add a nice-to-have."

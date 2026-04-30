# Design — harden-reference-auth-surfaces

## Context

The 2026-04-27 audit (`tmp/workstreams/worktree-bughunt-security-privacy-report.md`) ranked thirteen findings. This change implements the four "no-regret" fixes the owner accepted as urgent and leaves everything else for later, capture-and-park style. The four fixes share one theme: the AS reference-only surfaces and the AS hosted UI are reachable without proper authentication checks, and at least one of them returns the live bearer string.

## Decisions

### Redact `token_id` at the read boundary, not in storage

The audit notes that `spine_events.token_id` *is* the live bearer string. The right long-run fix is to store a SHA-256 of the token, which gives spine consumers a stable correlation handle without a credential. That requires:

- a schema migration on every existing `pdpp.sqlite`,
- a fix-up of in-flight reference instances that already carry `token_id` rows,
- a contract change for any spine consumer that reads `token_id` (introspection paths, the CLI, downstream telemetry the project has not yet locked down).

That is too large for the urgent-patch scope. Redacting `token_id` at the response boundary closes the remote-extraction path immediately — the storage change can land in a separate, careful tranche. The redaction lives next to the existing `summaryToGrant` / `buildTimelineEnvelope` helpers in `server/index.js` so it is visible to readers of the route handlers, not buried inside `lib/spine.ts` where someone could re-introduce the field by adding a new caller.

The shipped projection is intentionally narrow and only covers the two top-level fields that are known today to carry the live bearer string: it strips `token_id` from every event, and replaces `object_id` with `<redacted-token-id>` whenever `object_type === 'token'` (because `auth.js::issueToken` and `auth.js::issueOwnerTokenRecord` use the bearer string as both `token_id` and `object_id` on `token.issued` events). We do not traverse `data_json`, do not pattern-match field names, and do not redact by value shape. Adding a wider redaction (name-ends-in-`_token`, 64-hex-bearer-shape, deep `data` traversal) is deferred to the storage-migration tranche where we will instead remove the bearer from spine storage entirely; see `design-notes/spine-token-id-storage-2026-04-27.md`.

The audit also flagged that `interaction_response` could carry secrets. That field is already in the Pino redact list and is not surfaced from `data_json` on read because spine event `data` payloads never contain `interaction_response` keys (`auth.js` uses it only as the in-process variable name); we do not extend the boundary projection to traverse `data` JSON in this change.

### Revoke auth: owner bearer **or** grant-scoped client bearer

The reference's only public way to revoke today is "tell the AS the grant id." We tighten that without breaking either of the two legitimate callers:

- the dashboard-side owner-token flow, which can present an owner bearer issued via the device flow.
- the agent / client itself, which already holds the grant's client bearer.

We accept either of these. We do **not** accept the placeholder owner-session cookie on its own: the placeholder gate is `PDPP_OWNER_PASSWORD`-driven and the audit showed it is silently a no-op in default docker-compose. Requiring a real bearer means the auth state of the request is locally verifiable, and it preserves the symmetry with every other AS / RS auth check.

A client bearer that is valid but bound to a different grant SHALL fail. This is the cross-grant case the owner brief calls out explicitly. The check is "introspect the bearer, compare resolved `grant_id` to URL `grantId`, exact-match." Token kind `owner` skips the grant-id comparison.

We reject before any state mutation, before any trace_id correlation, and before any spine event is written for the rejection. (We do still emit `grant.revoke_rejected` on grant-malformed and on auth failure so the substrate's existing observability story holds; the audit-trail value of "an unauth attempt was made" is real.)

### Subject-id default

`apps/web/src/app/dashboard/lib/owner-token.ts:19` reads `process.env.PDPP_SUBJECT_ID || "the owner"`. The canonical default already lives in `reference-implementation/server/owner-session.ts:5` as `OWNER_SESSION_DEFAULT_SUBJECT_ID = "owner_local"`. The dashboard fallback should import that constant (the dashboard already imports from the same module). One-line change.

### Clickjacking headers

We set `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` on every AS response in the existing global `app.use` middleware. Both headers are framework-agnostic and harmless on JSON responses. We do not set CSP `default-src` or `script-src` here because the hosted UI is statically server-rendered with no inline scripts and no third-party assets — adding a richer CSP is its own design exercise, and the audit only flagged the framing axis as exploitable.

### Scope guards we keep

- ~~We do **not** add CSRF tokens on POST forms in this patch.~~ **Status (2026-04-27, follow-up):** the P2 CSRF follow-up has now landed in this same change as a signed double-submit token (`pdpp_owner_csrf` cookie + `_csrf` form field, both `<nonce>.<hmac>` over the owner-auth-derived secret). See "CSRF for hosted owner forms (P2 follow-up, now implemented)" below.
- We do **not** narrow `_ref/*` reads beyond the two timeline routes. The current spec explicitly says reads stay open. Touching that is a wider conversation about whether `_ref` is operator-only.
- We do **not** extend `requireRevokeAuth` semantics to other AS endpoints in this patch. It is built as a private helper in `server/index.js`; if other routes need it, the caller chooses.

### CSRF for hosted owner forms (P2 follow-up, now implemented)

The original change deferred CSRF as a P2 follow-up because the session cookie carried `SameSite=Lax`. SameSite-only is a partial defense — it does not protect against subdomain cookie injection, it does not bind the form submission to a specific render, and it does nothing for top-level POSTs from `<form target="_top">` on attacker pages with the same eTLD+1 in some browsers. Owner review of the v1 attempt asked for the higher-confidence default, so this change adds the fix here rather than spinning a new OpenSpec change for a tightly related scope.

**Mechanism: signed double-submit.** On every hosted-form GET (`/owner/login`, `/consent`, `/device`) the server mints a token `<base64url-nonce>.<base64url-hmac>` where the HMAC is computed over the nonce with a server-side CSRF secret. The token is set in a `pdpp_owner_csrf` cookie (`HttpOnly`, `SameSite=Lax|Strict`, `Path=/`, `Secure` per posture) and embedded as a hidden `_csrf` field. On every form-encoded POST we require both copies to be present, both signatures to verify, and the cookie value to match the field byte-for-byte under a constant-time comparison.

**Secret choice (P1 owner-review correction, 2026-04-27).** The first iteration of this follow-up derived the CSRF HMAC secret from `PDPP_OWNER_PASSWORD` (`sha256("pdpp-owner-csrf:" + password)`). That was wrong: `GET /owner/login` is unauthenticated and returns one signed `(nonce, sig)` sample to any anonymous fetcher, which lets an attacker brute-force a weak password offline by checking HMAC candidates. The runtime now mints a fresh random 32-byte secret per process when owner-auth is enabled (`crypto.randomBytes(32)` via `generateOwnerCsrfSecret()`). The secret never leaves the server and is unrelated to any user input, so a captured token leaks nothing about the password.

`createOwnerAuthPlaceholder` accepts an optional explicit `csrfSecret` for tests and for the rare deployment that needs a stable secret across restarts; operators that take that path SHOULD pass a high-entropy value and SHALL NOT pass anything derived from `PDPP_OWNER_PASSWORD`. `deriveOwnerCsrfSecretFromString` is exported for tests and forging helpers and is documented as not-the-runtime-default; the prior name `deriveOwnerCsrfSecret` is kept as a deprecated alias so existing forging tests still compile, but the runtime never calls it.

The signed half is what defends against cookie injection: an attacker on a sibling subdomain (or any party that can write the cookie via a `Set-Cookie` from an unrelated origin) cannot compute a valid HMAC without the random server-side secret, so any "matching pair" they fabricate is rejected. A naive double-submit-without-signature would accept that pair.

We deliberately keep the CSRF cookie *separate* from the owner session cookie so we can rotate the CSRF cookie on auth-state change (login success, logout) without disturbing the session, and so the same mechanism works pre- and post-login — `/owner/login` is the form most worth protecting and there is no session yet at that point.

**JSON exemption (P1 owner-review correction, 2026-04-27).** The first cut of `requireCsrf` exempted everything that wasn't `application/x-www-form-urlencoded` or `multipart/form-data`. That left a real bypass: HTML forms accept `text/plain` as a third valid `enctype` and a browser can submit it cross-origin without a CORS preflight. An attacker could craft `<form enctype="text/plain" action="…/consent/approve?request_uri=…" method="POST"><input name="x" value="x"></form>` on an attacker site and bypass CSRF entirely.

The corrected rule inverts the heuristic: `requireCsrf` exempts a request only when its `Content-Type` is exactly `application/json` (with optional `; charset=…` parameters). The same `shouldRequireCsrf(req)` gate is applied to `POST /owner/login` so a programmatic JSON login (no `_csrf` field, `Content-Type: application/json`) reaches the password branch — keeping `/owner/login` consistent with the rest of the hosted-form CSRF surface and preserving the JSON contract that CLIs and dashboards rely on. Every other content-type — including `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`, an empty `Content-Type` header, a Buffer-shaped body, or anything else a browser can send cross-origin — requires a valid CSRF pair when owner-auth is enabled. The same `shouldRequireCsrf(req)` helper drives the `requireCsrf` middleware on the `/consent/*` and `/device/*` routes *and* the inline check on `/owner/logout`, so the rule is unified.

We deliberately do **not** extend the JSON exemption to `+json` structured-syntax variants (e.g. `application/problem+json`). The reference's Fastify body parser only decodes `application/json`; exempting `+json` from CSRF would mean the security gate accepts a content-type that the route handler does not actually parse as JSON, which is a divergence we do not want. If a future change adds `+json` parsing, the exemption can widen at the same time.

Pure JSON callers stay exempt because browsers cannot forge a cross-origin JSON POST without a CORS preflight, so CLIs and server-to-server clients keep their existing programmatic contract.

**Cookie posture knobs.** Two new env knobs make the existing P1 cookie concerns operable without code changes:

- `PDPP_OWNER_FORCE_SECURE_COOKIES=1` adds `Secure` to every owner cookie even when the Node process sees plain HTTP. Behind a TLS-terminating proxy the proxy is responsible for enforcing TLS; this knob lets the operator declare that posture without trusting `req.secure` or `X-Forwarded-Proto` introspection.
- `PDPP_OWNER_SAMESITE=strict` upgrades both the session and CSRF cookies to `SameSite=Strict`. Default stays `Lax` because the placeholder login flow redirects from `/owner/login` back to `/consent`, and SameSite=Strict drops cookies on cross-site top-level navigation in some flows; opt-in keeps existing local-dev navigation patterns working.

**Local HTTP development.** None of the above breaks plain-HTTP local dev. With `PDPP_OWNER_PASSWORD` unset, owner-auth is disabled and CSRF middleware is a no-op (`requireCsrf` calls `next()` when disabled). With `PDPP_OWNER_PASSWORD` set, cookies omit `Secure` by default unless `PDPP_OWNER_FORCE_SECURE_COOKIES=1` is also set, so the browser still accepts and sends them on `http://localhost:*`.

**Set-Cookie multiplexing.** Login responses set both the session cookie and a clear-out for the prior pre-login CSRF cookie. The `appendSetCookie` helper preserves prior `Set-Cookie` values on the Fastify reply so both headers reach the client, and there is an explicit regression test asserting that.

### Consent risk disclosure invariants (P1 follow-up, 2026-04-28)

The consent page is the owner-trust boundary for third-party access. The 2026-04-28 ledger reconciliation found three remaining P1 bugs with the same root: the hosted UI renders requested authorization details too literally, without showing what the owner is actually approving.

**Wildcard streams.** A wildcard stream request (`streams: [{ name: "*" }]`) must not render as a bare `*`. The page must expand it against the requested source manifest, or at minimum render an explicit "all streams" disclosure with the resolved count and stream names. The owner must see the effective scope, not the protocol shorthand.

**Continuous grants.** `access_mode: "continuous"` must receive a distinct risk affordance, especially when no expiry or retention bound is present. A neutral `Access mode: continuous` metadata row is not enough for long-lived owner data access.

**AI-training consent failures.** An `ai_training` request that lacks explicit affirmative consent must fail with a typed PDPP error envelope. A generic thrown `Error` makes a consent-policy rejection look like an internal server fault.

This follow-up does not change the authorization-details format, token issuance, grant storage, revocation semantics, or the broader question of fast/broad multi-source consent.

## AS/RS metadata Host trust (2026-04-29 follow-up)

Production posture: configured public origins remain the preferred and authoritative deployment mode. When `AS_PUBLIC_URL`, `AS_ISSUER`, `RS_PUBLIC_URL`, `PDPP_REFERENCE_ORIGIN`, or equivalent startup options provide a non-loopback public origin, the AS/RS metadata documents are pinned to that origin and ignore hostile `Host` / `X-Forwarded-Host` values.

Unconfigured Host-derived metadata remains supported only for local and private-network discovery: localhost, loopback, `.local`, RFC1918 IPv4, IPv4 link-local, IPv6 unique-local, and IPv6 link-local hosts. This preserves local-device, Docker, and LAN workflows without requiring a pre-baked public hostname.

Public Host-derived metadata requires an operator allowlist via `PDPP_TRUSTED_HOSTS` or the equivalent startup option. Entries are comma/whitespace separated. Bare hostnames and URL entries match exact hostnames; `host:port` entries also require the request port; `*.example.com` matches subdomains but not the apex. Rejected requests return HTTP `421` with a PDPP error envelope and `error.code = "misdirected_request"`.

## Alternatives considered

- **Hash `token_id` in storage now.** Rejected: out-of-scope schema/migration churn. Captured as `design-notes/spine-token-id-storage-2026-04-27.md`.
- **Revoke via consent exchange-code, not bearer.** Rejected: that is a real protocol design question (replacing token-copy with one-time-use codes everywhere). Captured as `design-notes/consent-result-token-rendering-2026-04-27.md`.
- **Refuse to start in default docker-compose without `PDPP_OWNER_PASSWORD`.** Rejected here: ops change, separate tranche; would also break local dev defaults that hundreds of test runs and the existing CI rely on.
- **Use the placeholder owner session as the revoke credential.** Rejected: the cookie gate is no-op when password is unset; using it would mean revoke is unauth in default mode again.
- **Fail startup whenever public origins are omitted.** Rejected for this tranche: it would break local-device, Docker, LAN, and tunnel workflows that intentionally self-discover request origins. The safer narrowed control is to reject only public Host-derived metadata unless the host is allowlisted.

## Acceptance checks

- `node --test reference-implementation/test/security-auth-surfaces.test.js` passes locally and on CI.
- The full reference test suite (`pnpm --filter pdpp-reference-implementation test`) passes, with revoke-using tests updated to send the grant's bearer.
- `node --test reference-implementation/test/provider-metadata.test.js` covers explicit-origin pinning, local/LAN discovery, `PDPP_TRUSTED_HOSTS`, and hostile Host / `X-Forwarded-Host` rejection.
- `openspec validate harden-reference-auth-surfaces --strict` passes.
- `openspec validate --all --strict` passes.
- `git grep -nE '"the owner"' apps/ packages/ reference-implementation/ openspec/specs/` returns nothing under non-archive paths.
- A live AS instance: `curl -X POST $AS/grants/<id>/revoke` (no Authorization header) returns 401 with `error.code === 'authentication_error'`. With `Authorization: Bearer <other-grant-token>` returns 403 with `error.code === 'permission_error'`. With the grant's own client bearer or an owner bearer returns 200.
- `curl $AS/_ref/grants/<id>/timeline` response payload contains no `token_id` field on any event.
- `curl -I $AS/owner/login` returns both `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.

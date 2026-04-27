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

- We do **not** add CSRF tokens on POST forms in this patch. The cookie is already `SameSite=Lax`. The audit rates that P2; we capture it as a follow-up.
- We do **not** narrow `_ref/*` reads beyond the two timeline routes. The current spec explicitly says reads stay open. Touching that is a wider conversation about whether `_ref` is operator-only.
- We do **not** extend `requireRevokeAuth` semantics to other AS endpoints in this patch. It is built as a private helper in `server/index.js`; if other routes need it, the caller chooses.

## Alternatives considered

- **Hash `token_id` in storage now.** Rejected: out-of-scope schema/migration churn. Captured as `design-notes/spine-token-id-storage-2026-04-27.md`.
- **Revoke via consent exchange-code, not bearer.** Rejected: that is a real protocol design question (replacing token-copy with one-time-use codes everywhere). Captured as `design-notes/consent-result-token-rendering-2026-04-27.md`.
- **Refuse to start in default docker-compose without `PDPP_OWNER_PASSWORD`.** Rejected here: ops change, separate tranche; would also break local dev defaults that hundreds of test runs and the existing CI rely on.
- **Use the placeholder owner session as the revoke credential.** Rejected: the cookie gate is no-op when password is unset; using it would mean revoke is unauth in default mode again.

## Acceptance checks

- `node --test reference-implementation/test/security-auth-surfaces.test.js` passes locally and on CI.
- The full reference test suite (`pnpm --filter pdpp-reference-implementation test`) passes, with revoke-using tests updated to send the grant's bearer.
- `openspec validate harden-reference-auth-surfaces --strict` passes.
- `openspec validate --all --strict` passes.
- `git grep -nE '"the owner"' apps/ packages/ reference-implementation/ openspec/specs/` returns nothing under non-archive paths.
- A live AS instance: `curl -X POST $AS/grants/<id>/revoke` (no Authorization header) returns 401 with `error.code === 'authentication_error'`. With `Authorization: Bearer <other-grant-token>` returns 403 with `error.code === 'permission_error'`. With the grant's own client bearer or an owner bearer returns 200.
- `curl $AS/_ref/grants/<id>/timeline` response payload contains no `token_id` field on any event.
- `curl -I $AS/owner/login` returns both `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.

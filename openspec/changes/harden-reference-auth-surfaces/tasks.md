# Tasks — harden-reference-auth-surfaces

## 1. Spec delta

- [x] 1.1 Draft `specs/reference-implementation-architecture/spec.md` MODIFY for "Reference-only surfaces are explicit" — timeline reads SHALL scrub live-bearer fields.
- [x] 1.2 Draft ADDED requirement: "The reference SHALL gate `POST /grants/:grantId/revoke` on a valid owner or grant-scoped client bearer."
- [x] 1.3 Draft ADDED requirement: "AS hosted UI responses SHALL set `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`."

## 2. Implementation

- [x] 2.1 Add `redactSpineEventForPublic(event)` helper in `reference-implementation/server/index.js`. Strips the top-level `token_id` field. Replaces `object_id` with `<redacted-token-id>` when `object_type === 'token'` (because `token.issued` events use the bearer string as both `token_id` and `object_id`). Does NOT traverse `data_json` and does NOT pattern-match field names.
- [x] 2.2 Apply the helper at `/_ref/grants/:grantId/timeline` and `/_ref/runs/:runId/timeline` before `buildTimelineEnvelope`.
- [x] 2.3 Add `requireRevokeAuth` middleware in `server/index.js` and apply it to `POST /grants/:grantId/revoke`. Owner bearer accepted; client bearer accepted iff resolved `grant_id` matches the URL parameter.
- [x] 2.4 Add the AS clickjacking headers to the existing global `app.use` middleware in `buildAsApp(...)`.
- [x] 2.5 Replace the literal `"the owner"` default in `apps/web/src/app/dashboard/lib/owner-token.ts:19` with `OWNER_SESSION_DEFAULT_SUBJECT_ID`.

## 3. Tests

- [x] 3.1 New file `reference-implementation/test/security-auth-surfaces.test.js`:
  - revoke without auth → 401 `authentication_error`.
  - revoke with mismatched-grant client bearer → 403 `permission_error`.
  - revoke with the grant's own client bearer → 200 + `revoked: true`.
  - revoke with an owner bearer → 200 + `revoked: true`.
  - `/_ref/grants/<id>/timeline` response contains no `token_id` on any event.
  - `/_ref/runs/<id>/timeline` response contains no `token_id` on any event.
  - `/owner/login` response carries both clickjacking headers.
- [x] 3.2 Update existing revoke-using tests (`event-spine`, `cli`, `agent-cli`, `pdpp`) to send the grant's bearer in `Authorization`.

## 4. Skill / docs

- [x] 4.1 Update `skills/pdpp-data-access/references/security.md` and `docs/agent-skills/pdpp-data-access/references/security.md` so the "When a token is compromised" recipe sends the grant's bearer in the revoke call.

## 5. Followups (design notes)

- [x] 5.1 `design-notes/spine-token-id-storage-2026-04-27.md` — propose hashing or removing `token_id` from `spine_events` storage.
- [x] 5.2 `design-notes/consent-result-token-rendering-2026-04-27.md` — propose an exchange-code flow to replace HTML token-copy on `/consent/approve`.

## 6. P2 follow-up: CSRF + cookie posture for hosted owner forms (2026-04-27)

The original change deferred CSRF as a P2. Owner review of v1 asked for the higher-confidence default before moving on. The follow-up lands here rather than in a new change because the surface (hosted owner forms) and threat model (browser cross-origin POSTs at the AS) are tightly co-located with the surfaces this change already covers.

- [x] 6.1 Add `reference-implementation/server/owner-csrf.ts` with a signed double-submit token (`<base64url-nonce>.<base64url-hmac>` over an HKDF-style password-derived secret). HMAC-SHA256 over the nonce; `validateOwnerCsrfPair` verifies cookie signature, field signature, and constant-time equality.
- [x] 6.2 Wire CSRF issue/verify into `owner-auth.ts`: `ensureCsrfToken` on every hosted-form GET; `requireCsrf` middleware (no-op when owner-auth disabled or when `Content-Type` is not form-encoded); inline checks at `POST /owner/login` (CSRF-before-password) and `POST /owner/logout` (form-only). Rotate the CSRF cookie on auth-state change.
- [x] 6.3 Embed the hidden `_csrf` field in the rendered consent (`renderPendingGrantConsentHtml`), device approval, owner login, and signed-in-owner pages. Add CSRF middleware to `POST /consent/approve`, `POST /consent/deny`, `POST /device/approve`, `POST /device/deny`.
- [x] 6.4 Add `OwnerSessionSameSite` mode to `owner-session.ts` (`lax`|`strict`) and a `forceSecureCookies` controller option. Wire `PDPP_OWNER_SAMESITE` and `PDPP_OWNER_FORCE_SECURE_COOKIES=1` env knobs through `resolveOwnerAuthPlaceholderConfig` so deployments behind TLS-terminating proxies can enforce `Secure` and `SameSite=Strict` without code changes.
- [x] 6.5 Implement `appendSetCookie` so login responses can carry both the session Set-Cookie and the CSRF rotation Set-Cookie through the Fastify transport without one overwriting the other.
- [x] 6.6 New `reference-implementation/test/owner-csrf.test.js` covering: form POST without CSRF → 403 + no session; valid CSRF + wrong password → 401 + no session; valid CSRF + correct password → 302 + session; consent/approve, consent/deny, device/approve, device/deny form POST without CSRF → 403; matching CSRF from rendered consent/device pages allows the positive path; JSON `/consent/approve` remains compatible without CSRF; forged cookie/field pair without valid signature is rejected; token signed with a different secret is rejected; GET `/owner/login` issues exactly one CSRF Set-Cookie; `ownerAuthSameSite='strict'` produces `SameSite=Strict`; `ownerAuthForceSecureCookies=true` adds `Secure` even on plain HTTP; default plain HTTP omits `Secure` and still works.
- [x] 6.7 Update existing helpers in `test/owner-auth.test.js` to fetch a CSRF token from `GET /owner/login` (and from `GET /device?...`) before submitting form-encoded POSTs. Tighten the wrong-password test to assert "valid CSRF + wrong password → 401" rather than the prior pattern that accidentally probed both checks together.
- [x] 6.8 Add CSRF + cookie-posture requirements and scenarios to `specs/reference-implementation-architecture/spec.md` so the OpenSpec delta reflects the implemented behavior.

## Acceptance checks

- [x] `openspec validate harden-reference-auth-surfaces --strict`
- [x] `openspec validate --all --strict`
- [x] `node --test reference-implementation/test/security-auth-surfaces.test.js` (added file)
- [x] `node --test reference-implementation/test/owner-auth.test.js test/owner-csrf.test.js test/owner-session.test.js test/security-consent-token-handoff.test.js` (CSRF follow-up)
- [x] `git grep -nE '"the owner"' apps/ packages/ reference-implementation/ openspec/specs/` — empty (excluding archive)
- [x] Targeted re-run of every test that touches `/grants/<id>/revoke`.

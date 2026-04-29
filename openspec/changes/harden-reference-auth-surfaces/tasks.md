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

- [x] 6.1 Add `reference-implementation/server/owner-csrf.ts` with a signed double-submit token (`<base64url-nonce>.<base64url-hmac>`). HMAC-SHA256 over the nonce; `validateOwnerCsrfPair` verifies cookie signature, field signature, and constant-time equality.
- [x] 6.1.1 (P1 owner review, 2026-04-27) The runtime CSRF HMAC secret SHALL NOT be password-derived. `createOwnerAuthPlaceholder` mints a random 32-byte secret per process via `generateOwnerCsrfSecret()` when owner-auth is enabled, and accepts an optional explicit `csrfSecret` override for tests / stable-across-restart deployments. `deriveOwnerCsrfSecretFromString` is exported for forging helpers only and explicitly documented as not the runtime default; the legacy `deriveOwnerCsrfSecret` name is kept as a deprecated alias so existing tests still compile.
- [x] 6.2 Wire CSRF issue/verify into `owner-auth.ts`: `ensureCsrfToken` on every hosted-form GET; `requireCsrf` middleware; inline checks at `POST /owner/login` (CSRF-before-password) and `POST /owner/logout`. Rotate the CSRF cookie on auth-state change.
- [x] 6.2.1 (P1 owner review, 2026-04-27) The exemption rule SHALL be JSON-only, not "form-encoded only." Replace the prior `isFormEncodedRequest` (`application/x-www-form-urlencoded` or `multipart/form-data`) with `shouldRequireCsrf(req) = !isJsonRequest(req)`, where `isJsonRequest` matches exactly `application/json` (with optional `; charset=…`). Apply the same helper to the inline `/owner/logout` check. Closes the `text/plain` enctype bypass that HTML forms can submit cross-origin without a CORS preflight. The exemption is intentionally narrow — `+json` structured-syntax variants are NOT exempt because the Fastify body parser only decodes `application/json` and the security gate must not accept a content-type the route handler will not actually parse.
- [x] 6.2.2 (P1 owner review, 2026-04-27) `POST /owner/login` SHALL apply the same `shouldRequireCsrf(req)` gate so a programmatic JSON login (`Content-Type: application/json`, no `_csrf`) reaches the password branch. Browser-submittable login posts (form-encoded, multipart, text/plain, no Content-Type) SHALL still 403 *before* the password check.
- [x] 6.3 Embed the hidden `_csrf` field in the rendered consent (`renderPendingGrantConsentHtml`), device approval, owner login, and signed-in-owner pages. Add CSRF middleware to `POST /consent/approve`, `POST /consent/deny`, `POST /device/approve`, `POST /device/deny`.
- [x] 6.4 Add `OwnerSessionSameSite` mode to `owner-session.ts` (`lax`|`strict`) and a `forceSecureCookies` controller option. Wire `PDPP_OWNER_SAMESITE` and `PDPP_OWNER_FORCE_SECURE_COOKIES=1` env knobs through `resolveOwnerAuthPlaceholderConfig` so deployments behind TLS-terminating proxies can enforce `Secure` and `SameSite=Strict` without code changes.
- [x] 6.5 Implement `appendSetCookie` so login responses can carry both the session Set-Cookie and the CSRF rotation Set-Cookie through the Fastify transport without one overwriting the other.
- [x] 6.6 New `reference-implementation/test/owner-csrf.test.js` covering: form POST without CSRF → 403 + no session; valid CSRF + wrong password → 401 + no session; valid CSRF + correct password → 302 + session; consent/approve, consent/deny, device/approve, device/deny form POST without CSRF → 403; matching CSRF from rendered consent/device pages allows the positive path; JSON `/consent/approve` remains compatible without CSRF; forged cookie/field pair without valid signature is rejected; token signed with a different secret is rejected; **token signed with `deriveOwnerCsrfSecret(PDPP_OWNER_PASSWORD)` is rejected and the rendered CSRF token does not equal it** (P1 owner review); GET `/owner/login` issues exactly one CSRF Set-Cookie; `ownerAuthSameSite='strict'` produces `SameSite=Strict`; `ownerAuthForceSecureCookies=true` adds `Secure` even on plain HTTP; default plain HTTP omits `Secure` and still works; **owner-auth disabled + form-encoded POST `/owner/logout` does not 403** (P1 owner review); **`text/plain` POST `/consent/approve` and `/device/approve` without CSRF → 403 and the underlying pending request remains pending** (P1 owner review, text/plain enctype bypass); **POST with no `Content-Type` is rejected (browser-fetch shape)**; **JSON POST `/owner/login` without `_csrf` reaches the password branch (wrong → 401, correct → 302 + session)** and **text/plain / no-Content-Type / form-encoded POST `/owner/login` without `_csrf` 403 before the password check** (P1 owner review, /owner/login JSON consistency).
- [x] 6.7 Update existing helpers in `test/owner-auth.test.js` to fetch a CSRF token from `GET /owner/login` (and from `GET /device?...`) before submitting form-encoded POSTs. Tighten the wrong-password test to assert "valid CSRF + wrong password → 401" rather than the prior pattern that accidentally probed both checks together.
- [x] 6.8 Add CSRF + cookie-posture requirements and scenarios to `specs/reference-implementation-architecture/spec.md` so the OpenSpec delta reflects the implemented behavior.

## Acceptance checks

- [x] `openspec validate harden-reference-auth-surfaces --strict`
- [x] `openspec validate --all --strict`
- [x] `node --test reference-implementation/test/security-auth-surfaces.test.js` (added file)
- [x] `node --test reference-implementation/test/owner-auth.test.js test/owner-csrf.test.js test/owner-session.test.js test/security-consent-token-handoff.test.js` (CSRF follow-up)
- [x] `git grep -nE '"the owner"' apps/ packages/ reference-implementation/ openspec/specs/` — empty (excluding archive)
- [x] Targeted re-run of every test that touches `/grants/<id>/revoke`.

## 7. P0 follow-up: device-code / user-code exposure on read surfaces (2026-04-27)

The 2026-04-27 P0/P1 audit identified two P0 leaks the §2 redactor and the in-flight owner-auth gating do not close:

- P0-1: `/_ref/approvals` projects the live `device_code` as `approval_id`, and the consent entry's `request_uri` embeds the device_code verbatim. The owner-device flow's `device_code` is the literal bearer for `POST /oauth/token`. Owner-gating reduces the blast radius but the operator console still SHALL NOT see the live bearer.
- P0-2: The §2 redactor whitelists `object_type === 'token'` but the `request.submitted` events for `pending_consent` and `owner_device_auth` carry the `device_code` as `object_id` and the `user_code` in `data`. Spine timeline reads echoed those bearer-equivalents back.

The fix lives inside this change because the surface (live-bearer redaction at the `_ref` read boundary) and the rationale ("the projection is the read-time guarantee") are the ones already covered by §2.

- [x] 7.1 Add an `approval_id` column to `pending_consents` and `owner_device_auth` (random opaque, generated per row at create time). Idempotent `ALTER TABLE ADD COLUMN` migration in `db.js::initDb` covers pre-existing DBs.
- [x] 7.2 Project `approval_id` on `/_ref/approvals` instead of `device_code`. `request_uri` is `null` for both kinds (the canonical request_uri embeds the device_code; clients that legitimately hold a request_uri got it from PAR, not from the operator console). `user_code` is `null` on both kinds.
- [x] 7.3 Extend `redactSpineEventForPublic` to also redact:
  - `object_id` when `object_type` is `pending_consent` or `owner_device_auth` (literal `<redacted-device-code>`)
  - `data.device_code`, `data.user_code`, `data.request_uri` keys (literal `<redacted-bearer>`) when present in the event's top-level `data` object
  Stays narrow: still doesn't traverse arrays or nested objects, still doesn't pattern-match by string shape.
- [x] 7.4 Accept `approval_id` (alongside `request_uri`/`user_code`) on `POST /consent/approve`, `POST /consent/deny`, `POST /device/approve`, `POST /device/deny`. The AS resolves the approval_id to the device_code/user_code internally behind the existing owner-session + CSRF gate.
- [x] 7.5 Update the dashboard's `operator-approvals.ts` to send `approval_id` for both consent and owner-device approve/deny. Drop the user_code hidden form field from the pending-approvals row.
- [x] 7.6 New file `reference-implementation/test/security-device-code-exposure.test.js` pinning:
  - `/_ref/approvals` does not include `device_code` or `user_code` for any kind.
  - `/_ref/approvals` consent entries have `request_uri: null`.
  - `/_ref/traces/:traceId` for a pending consent does not echo the device_code as `object_id` or in `data`.
  - `/_ref/traces/:traceId` for an owner_device flow does not echo the device_code, user_code, or request_uri.
  - The dashboard approve flow with `approval_id` succeeds end-to-end and the device_code is not redeemable from any public read surface during the flow.
- [x] 7.7 Append the §7 scenarios to `specs/reference-implementation-architecture/spec.md` so the redactor's new coverage and the `/_ref/approvals` shape are pinned.

## 8. P1 follow-up: consent-risk disclosure invariants (2026-04-28)

The owner bug-hunt reconciliation found three remaining P1 consent-surface issues on current main:

- wildcard stream requests render as a literal `*`, hiding the effective stream set;
- `continuous` grants render as a plain key/value row, without an explicit long-lived-access warning;
- `ai_training` requests without affirmative consent throw an untyped `Error`, which can surface as a generic server failure rather than a typed PDPP error.

- [x] 8.1 Render wildcard stream requests as an explicit "all streams" disclosure with the resolved stream names/count for the requested source.
- [x] 8.2 Add a distinct continuous-access risk affordance, including the missing-expiry/no-retention case.
- [x] 8.3 Replace the untyped AI-training consent failure with a typed PDPP error envelope.
- [x] 8.4 Add black-box tests for wildcard rendering, continuous-risk copy, and AI-training error shape.
- [x] 8.5 Validate `harden-reference-auth-surfaces` and `--all` strictly.

## 9. Follow-up: AS/RS metadata Host trust (2026-04-29)

The 2026-04-29 P0/P1 surface bug hunt found that live AS/RS metadata is Host-derived when no explicit public origin is configured. The bounded follow-up fixed `/sandbox` advertising `0.0.0.0`, but intentionally did not drive-by change live AS/RS metadata semantics.

- [ ] 9.1 Decide and specify production posture for unconfigured public origins: fail startup, emit deployment diagnostics only, or accept Host-derived metadata behind a trusted-host allowlist.
- [ ] 9.2 If allowlisting is selected, define `PDPP_TRUSTED_HOSTS` matching semantics and rejection shape (`421 Misdirected Request` vs PDPP error envelope).
- [ ] 9.3 Add tests covering explicit-origin pinning, unconfigured local/LAN discovery, and hostile Host/`X-Forwarded-Host` requests in the chosen deployment mode.
- [x] 9.4 Capture current policy and tradeoffs in `design-notes/metadata-origin-host-trust-2026-04-29.md`.

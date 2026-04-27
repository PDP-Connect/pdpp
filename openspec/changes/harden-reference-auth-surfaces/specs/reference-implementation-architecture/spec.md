## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit
Debugging, replay, trace, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

The reference implementation SHALL NOT expose live bearer-token material on any reference-only read surface, even when that surface is otherwise unauthenticated. Every event projected from `spine_events` onto `_ref` timeline responses SHALL satisfy two narrow projection rules before the response is serialized:

1. The top-level `token_id` field SHALL be removed from the event.
2. When the event's `object_type` equals `'token'`, the event's `object_id` SHALL be replaced with the literal string `<redacted-token-id>` (because `token.issued` events use the bearer string as both `token_id` and `object_id`).

The projection SHALL NOT traverse the event's `data` payload, SHALL NOT pattern-match field names, and SHALL NOT redact by value shape. Storage of `token_id` and `object_id` in `spine_events` is unchanged by this requirement; the projection is a read-time guarantee. A wider name- or shape-based projection, and removal of the bearer from spine storage entirely, are deferred to a separate change.

#### Scenario: A trace or timeline endpoint is exposed
- **WHEN** the implementation exposes trace, timeline, or similar introspection surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only artifacts rather than as core PDPP protocol requirements

#### Scenario: The current `_ref` read surface is treated as stable substrate
- **WHEN** the implementation exposes the current reference-designated event-spine readers
- **THEN** the durable `_ref` read surface SHALL stay limited to:
  - `GET /_ref/traces/:traceId`
  - `GET /_ref/grants/:grantId/timeline`
  - `GET /_ref/runs/:runId/timeline`
  - `GET /_ref/traces` (list, filter, paginate)
  - `GET /_ref/grants` (list, filter, paginate)
  - `GET /_ref/runs` (list, filter, paginate)
  - `GET /_ref/search?q=...` (id-aware read-only jump helper)
  - `GET /_ref/dataset/summary` (dashboard overview dataset summary)

#### Scenario: The dashboard summarizes dataset credibility
- **WHEN** the reference dashboard renders a dataset summary or credibility overview
- **THEN** it MAY consume `GET /_ref/dataset/summary`
- **AND** that route SHALL remain documented as a reference-only read surface rather than as a public PDPP API

#### Scenario: A later control-plane phase widens `_ref` mutation narrowly
- **WHEN** a later control-plane phase needs a truthful operator mutation surface for a live bounded collection run
- **THEN** the reference MAY add an owner-only `_ref` mutation endpoint limited to:
  - `POST /_ref/runs/:runId/interaction`
- **AND** that route SHALL be documented as reference-only control-plane behavior rather than as a public PDPP API
- **AND** the reference SHALL NOT widen `_ref` into broader mutation/control endpoints in the same tranche without a further explicit OpenSpec change

#### Scenario: Run timelines expose checkpoint staging separately from checkpoint commit
- **WHEN** the reference runtime receives `STATE` during a bounded collection run
- **THEN** the `_ref` run timeline SHALL distinguish checkpoint staging from checkpoint commit so the checkpointed-streaming model is visible in reference artifacts rather than implied only by runtime internals

#### Scenario: Runtime validation failures remain inspectable in the reference substrate
- **WHEN** a bounded collection run fails because the runtime rejects connector output or an interaction handler response before `DONE`
- **THEN** the durable `_ref` run timeline SHALL still record `run.failed` with an explicit machine-readable reason instead of leaving that failure visible only as a thrown local error

#### Scenario: A grant timeline event carries `token_id` in storage
- **WHEN** a caller requests `GET /_ref/grants/:grantId/timeline` for a grant whose stored spine events carry `token_id` values
- **THEN** the response payload SHALL NOT contain a `token_id` field on any event
- **AND** every other documented event field (`event_id`, `event_type`, `occurred_at`, `actor_*`, `subject_*`, `grant_id`, `client_id`, `data`, `trace_id`, etc.) SHALL be returned unchanged

#### Scenario: A grant timeline includes a `token.issued` event
- **WHEN** the timeline includes an event whose `object_type` is `'token'`
- **THEN** that event's `object_id` SHALL be the literal string `<redacted-token-id>`
- **AND** the bearer string the event carried in storage SHALL NOT appear anywhere in the serialized response body

#### Scenario: A run timeline event carries `token_id` in storage
- **WHEN** a caller requests `GET /_ref/runs/:runId/timeline` for a run whose stored spine events carry `token_id` values
- **THEN** the response payload SHALL NOT contain a `token_id` field on any event

#### Scenario: The projection does not traverse `data` payloads or match by field-name shape
- **WHEN** a stored spine event carries fields other than `token_id` and the `object_type === 'token'` ⇒ `object_id` pair (for example, application-level keys inside `data`)
- **THEN** the projection SHALL NOT remove or rename those other fields
- **AND** the projection SHALL NOT inspect string values for bearer-like shape

## ADDED Requirements

### Requirement: The reference SHALL gate grant revocation on a valid owner or grant-scoped client bearer
`POST /grants/:grantId/revoke` SHALL require an `Authorization: Bearer <token>` header and SHALL accept the request only when the introspected token is one of:

- an owner bearer (`pdpp_token_kind === 'owner'`) whose token row is real and is not token-level-revoked (`inactive_reason === 'token_revoked'`) or token-level-expired (`inactive_reason === 'token_expired'`); or
- a client bearer (`pdpp_token_kind === 'client'`, or an inactive introspection that still resolves to a `grant_id` because the inactive reason is grant-state-only) whose introspection-resolved `grant_id` exactly equals the URL `:grantId` parameter.

A client bearer whose grant has become malformed (`grant_invalid`), already revoked (`grant_revoked`), or expired (`grant_expired`) SHALL still authenticate the holder for the purpose of revoking that grant — the bearer string itself is authentic and the only legitimate use of such a token is to revoke the grant the client holds.

The reference SHALL perform this check before any grant lookup, before any state mutation, and before any `grant.revoke_*` spine event is emitted on the success path. A request that fails the check SHALL NOT mutate `grants.status` or `tokens.revoked`.

#### Scenario: Revoke without an Authorization header
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with no `Authorization` header
- **THEN** the response status SHALL be `401`
- **AND** the response body SHALL be a PDPP error envelope with `error.code === 'authentication_error'`
- **AND** the grant's `status` and the grant's tokens' `revoked` columns SHALL remain unchanged

#### Scenario: Revoke with an unknown bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with an `Authorization: Bearer …` whose value does not match any row in the tokens table
- **THEN** the response status SHALL be `401`
- **AND** the grant SHALL remain unchanged

#### Scenario: Revoke with a token-level revoked or expired bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a bearer whose introspection returns `active: false` with `inactive_reason` of `token_revoked` or `token_expired`
- **THEN** the response status SHALL be `401`
- **AND** the grant SHALL remain unchanged

#### Scenario: Revoke with a client bearer bound to a different grant
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a client bearer whose introspected `grant_id` differs from `:grantId`
- **THEN** the response status SHALL be `403`
- **AND** the response body SHALL be a PDPP error envelope with `error.code === 'permission_error'`
- **AND** the targeted grant SHALL remain unchanged

#### Scenario: Revoke with the grant's own client bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a valid client bearer whose introspected `grant_id` equals `:grantId`
- **THEN** the response status SHALL be `200`
- **AND** the response body SHALL be `{ "revoked": true }`
- **AND** subsequent introspection of the same token SHALL return `active: false`

#### Scenario: Revoke with the grant's own client bearer for a malformed grant
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a client bearer whose introspection returns `active: false` with `inactive_reason: 'grant_invalid'` and whose introspection-resolved `grant_id` equals `:grantId`
- **THEN** the request SHALL pass the auth gate
- **AND** the response SHALL be the existing PDPP `grant_invalid` error envelope produced by the revoke handler (status `403`)
- **AND** the auth gate SHALL NOT short-circuit to `401`

#### Scenario: Revoke with an owner bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a valid owner bearer
- **THEN** the response status SHALL be `200`
- **AND** the response body SHALL be `{ "revoked": true }`
- **AND** the grant's `status` SHALL be `'revoked'` regardless of which client originally held it

### Requirement: AS hosted-UI responses SHALL carry clickjacking-defense headers
Every response from the reference Authorization Server's HTTP application SHALL include the headers `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. The reference SHALL set both headers (the modern CSP form for current browsers and the legacy header for older browsers and embedded webviews).

#### Scenario: A browser fetches the owner-login page
- **WHEN** a browser issues `GET /owner/login`
- **THEN** the response SHALL carry `X-Frame-Options: DENY`
- **AND** the response SHALL carry `Content-Security-Policy: frame-ancestors 'none'`

#### Scenario: A browser fetches the consent shell with a request_uri
- **WHEN** a browser issues `GET /consent?request_uri=…`
- **THEN** the response SHALL carry `X-Frame-Options: DENY`
- **AND** the response SHALL carry `Content-Security-Policy: frame-ancestors 'none'`

#### Scenario: A non-HTML JSON endpoint is requested
- **WHEN** a caller issues a JSON request such as `POST /introspect`
- **THEN** the response SHALL still carry both clickjacking-defense headers
- **AND** the headers SHALL NOT change the response body or content type

### Requirement: Hosted owner forms SHALL be protected by a signed double-submit CSRF token

When the reference owner-auth placeholder is enabled (`PDPP_OWNER_PASSWORD` set), every state-changing form POST originating from a server-rendered hosted owner page SHALL be rejected unless the caller submits a CSRF token that:

1. is present both in the `pdpp_owner_csrf` cookie and in an `_csrf` form field;
2. has a valid HMAC signature over its nonce when verified with the server-side CSRF secret;
3. matches the cookie value byte-for-byte under a constant-time comparison.

The server-side CSRF secret SHALL NOT be derived from `PDPP_OWNER_PASSWORD` or any other user-supplied authentication credential. The reference SHALL default to a fresh random 32-byte secret minted per process when owner-auth is enabled. Implementations MAY accept an explicit deployment-supplied CSRF secret (high-entropy and unrelated to any password) for use cases that require a stable secret across restarts, but SHALL NOT use a password-derived value.

The CSRF cookie SHALL be marked `HttpOnly`, `Path=/`, `SameSite=Lax` (or `Strict` when `PDPP_OWNER_SAMESITE=strict`), and `Secure` whenever the request is observed over TLS (`req.secure` or `X-Forwarded-Proto: https`) **or** when `PDPP_OWNER_FORCE_SECURE_COOKIES=1` is set. The hidden field name is `_csrf`. Tokens have the shape `<base64url-nonce>.<base64url-hmac>` and are issued on every hosted-form GET that does not already carry a verifying cookie.

The protected POST surfaces SHALL include at least:

- `POST /owner/login`
- `POST /owner/logout`
- `POST /consent/approve`
- `POST /consent/deny`
- `POST /device/approve`
- `POST /device/deny`

Pure JSON callers SHALL remain exempt: a request whose `Content-Type` is exactly `application/json` (parameters such as `; charset=utf-8` permitted) SHALL pass through `requireCsrf` without a CSRF check, because browsers cannot forge a cross-origin JSON POST without a CORS preflight. The exemption SHALL NOT extend to structured-syntax variants such as `application/problem+json` until the reference body parser actually decodes them as JSON. CLIs and server-to-server clients keep their existing programmatic contract.

Every other browser-submittable POST — including `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`, and a request with no `Content-Type` header — SHALL require a valid CSRF pair when owner-auth is enabled. The exemption SHALL NOT be defined as "form-encoded only," because the HTML form spec admits `text/plain` as a third valid `enctype`, which a browser can submit cross-origin without a CORS preflight; exempting only the two strict form encodings would leave a `text/plain` bypass.

The CSRF cookie SHALL be rotated on auth-state change (login success and logout) so a token captured before sign-in cannot be reused after it.

The owner session cookie (`pdpp_owner_session`) SHALL also honor the `PDPP_OWNER_SAMESITE` and `PDPP_OWNER_FORCE_SECURE_COOKIES` knobs so deployments behind TLS-terminating proxies can force `Secure` and stricter SameSite without code changes.

This requirement supersedes the prior "P2 follow-up" deferral noted in the original `harden-reference-auth-surfaces` design.

#### Scenario: A browser-form POST `/owner/login` arrives without a CSRF cookie or `_csrf` field
- **WHEN** a browser submits `POST /owner/login` with `Content-Type: application/x-www-form-urlencoded` and no `pdpp_owner_csrf` cookie or `_csrf` body field
- **THEN** the response status SHALL be `403`
- **AND** the response SHALL NOT issue a `pdpp_owner_session` Set-Cookie
- **AND** the response body SHALL NOT leak whether the submitted password would have been correct

#### Scenario: A text/plain POST `/owner/login` is rejected before the password check
- **WHEN** a caller submits `POST /owner/login` with `Content-Type: text/plain` and no CSRF pair
- **THEN** the response status SHALL be `403`
- **AND** the response SHALL NOT issue a `pdpp_owner_session` Set-Cookie even when the body would have carried a correct password

#### Scenario: A JSON POST `/owner/login` reaches the password branch without a CSRF token
- **WHEN** a programmatic JSON caller submits `POST /owner/login` with `Content-Type: application/json` and a JSON body containing `password` but no `_csrf` field
- **THEN** the request SHALL not be rejected by the CSRF gate because JSON callers cannot be cross-origin-forged from a browser without a CORS preflight
- **AND** an incorrect password SHALL produce a `401`
- **AND** a correct password SHALL produce a `302` redirect to `return_to` and SHALL issue a `pdpp_owner_session` Set-Cookie

#### Scenario: A browser-form POST `/owner/login` arrives with a valid CSRF pair and a wrong password
- **WHEN** a browser submits `POST /owner/login` with a `pdpp_owner_csrf` cookie and matching `_csrf` field that both verify against the server secret, but the submitted password is incorrect
- **THEN** the response status SHALL be `401`
- **AND** the response SHALL NOT issue a `pdpp_owner_session` Set-Cookie

#### Scenario: A browser-form POST `/owner/login` arrives with a valid CSRF pair and the correct password
- **WHEN** a browser submits `POST /owner/login` with a verifying CSRF pair and the correct password
- **THEN** the response status SHALL be `302`
- **AND** the response SHALL issue a `pdpp_owner_session` Set-Cookie
- **AND** the response SHALL also issue a rotation Set-Cookie that clears the prior `pdpp_owner_csrf` cookie

#### Scenario: A browser-form POST `/consent/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /consent/approve` with `Content-Type: application/x-www-form-urlencoded` and no verifying CSRF pair
- **THEN** the response status SHALL be `403`
- **AND** the pending consent request SHALL remain pending

#### Scenario: A browser-form POST `/device/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /device/approve` with `Content-Type: application/x-www-form-urlencoded` and no verifying CSRF pair
- **THEN** the response status SHALL be `403`
- **AND** the device authorization SHALL remain pending

#### Scenario: A text/plain POST `/consent/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /consent/approve?request_uri=…` with `Content-Type: text/plain`, `Accept: text/html`, a session cookie, a non-empty body, and no `pdpp_owner_csrf` cookie or `_csrf` field
- **THEN** the response status SHALL be `403`
- **AND** the pending consent request SHALL remain pending (a subsequent JSON `POST /consent/approve` for the same `request_uri` SHALL still succeed)

#### Scenario: A text/plain POST `/device/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /device/approve` with `Content-Type: text/plain`, a session cookie, and no CSRF token
- **THEN** the response status SHALL be `403`
- **AND** the device authorization SHALL remain pending

#### Scenario: A POST with no Content-Type arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits a state-changing POST with a session cookie, no `Content-Type` header (a "browser fetch with no body" shape), and no CSRF token
- **THEN** the response status SHALL be `403`

#### Scenario: A JSON POST `/consent/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /consent/approve` with `Content-Type: application/json` and no `_csrf` field
- **THEN** the response SHALL be processed as before
- **AND** the response status SHALL be `200`
- **AND** the response body SHALL still return `{ grant_id, token, grant }`

#### Scenario: A CSRF token signed with a password-derived secret is rejected
- **WHEN** an attacker fetches `GET /owner/login` to capture one (nonce, signature) sample, derives `sha256("pdpp-owner-csrf:" + PDPP_OWNER_PASSWORD)` (or any other password-derived helper), forges a `<nonce>.<sig>` token with that secret, and submits it as both the `pdpp_owner_csrf` cookie and the `_csrf` form field on an authenticated POST `/consent/approve`
- **THEN** the response status SHALL be `403`
- **AND** the rendered CSRF token in `GET /consent` SHALL NOT equal the password-derived token

#### Scenario: A forged CSRF cookie/field pair without a valid signature is rejected
- **WHEN** a caller submits `POST /consent/approve` (form-encoded) with a `pdpp_owner_csrf` cookie and `_csrf` form field that match each other byte-for-byte but whose signature does not verify against the server secret
- **THEN** the response status SHALL be `403`
- **AND** no grant SHALL be issued

#### Scenario: An operator opts into stricter cookie posture
- **WHEN** the server starts with `PDPP_OWNER_SAMESITE=strict`
- **THEN** every owner session and CSRF Set-Cookie SHALL carry `SameSite=Strict`

#### Scenario: An operator forces `Secure` cookies behind a TLS-terminating proxy
- **WHEN** the server starts with `PDPP_OWNER_FORCE_SECURE_COOKIES=1`
- **THEN** every owner session and CSRF Set-Cookie SHALL carry `Secure` even when the inbound request appears as plain HTTP to the Node process

#### Scenario: Local plain-HTTP development still works without configuration
- **WHEN** the server runs over plain HTTP without `PDPP_OWNER_FORCE_SECURE_COOKIES`
- **THEN** owner cookies SHALL omit `Secure` so a browser will accept and send them
- **AND** the hosted owner form flows SHALL still issue and validate CSRF tokens normally

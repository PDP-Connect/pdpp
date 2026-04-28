# Tasks

## 1. AS — stamp and persist `issuer_subject_id` on owner-authed DCR

- [x] In the owner-authed `POST /oauth/register` route, stamp top-level client metadata `issuer_subject_id` from the owner session subject. Do not accept a caller-supplied subject value.
- [x] Persist via existing `metadata_json` slot; no schema migration required.
- [x] In `server/index.js POST /oauth/register`, pass the `req.ownerSession?.sub` (when present) into `registerDynamicClient`. Document that anonymous registrations cannot tag themselves to a subject.

## 2. AS — `GET /_ref/clients?owner=true`

- [x] New SQL query `server/queries/auth/oauth-clients/list-by-issuer-subject.sql` filtered to `registration_mode = 'dynamic'` and `json_extract(metadata_json, '$.issuer_subject_id') = ?`.
- [x] New `server/auth.js listOwnerIssuedClients(subjectId)` returning `[{ client_id, client_name, created_at, active_token_count }]`. The token count uses a bounded query over active `tokens` rows for the client.
- [x] New route `GET /_ref/clients`, `ownerAuth.requireOwnerSession`. Reads `?owner=true` (other values reserved). Returns `{ object: 'list', data: [...] }`.

## 3. AS — `DELETE /oauth/register/{client_id}`

- [x] New `server/auth.js deleteRegisteredClient(clientId, { actingSubjectId, requestId, traceId })` that:
  - looks up the client, returns `not_found` if absent
  - returns `forbidden` if `registration_mode !== 'dynamic'`
  - returns `forbidden` if the persisted client `issuer_subject_id` does not match `actingSubjectId`
  - lists all `grants WHERE client_id = ?` and calls `revokeGrant` on each
  - marks owner self-export token rows for the same `client_id` revoked
  - deletes the `oauth_clients` row
  - emits a `client.deleted` spine event with the cascade summary
- [x] New route `app.delete('/oauth/register/:clientId', ownerAuth.requireOwnerSession, ...)` wiring the above. JSON-only response.

## 4. Dashboard BFF — issue via per-token DCR

- [x] In `apps/web/src/app/dashboard/lib/operator-bootstrap.ts`, change `startOwnerBootstrapFlow` to:
  - require a non-empty `name` argument (default refused — operator UX requires a label)
  - first call `POST /oauth/register` with `{ client_name: name, token_endpoint_auth_method: 'none' }` and the owner session cookie so the AS can stamp `issuer_subject_id`
  - then run the existing device flow against the returned `client_id`
  - record the new `client_id` on `OwnerBootstrapFlow` (it already has `clientId`; just stop defaulting to the bootstrap one)
- [x] In `apps/web/src/app/dashboard/deployment/tokens/actions.ts issueOwnerTokenAction`, require `formData.get('name')`. Return an error and redirect with `?error=name_required` if absent.

## 5. Dashboard — Tokens list view + Revoke

- [x] New typed wrapper in `apps/web/src/app/dashboard/lib/ref-client.ts listOwnerIssuedClients(): Promise<{ data: OwnerIssuedClient[] }>` calling `GET /_ref/clients?owner=true`.
- [x] New section on `/dashboard/deployment/tokens` titled "Your tokens" that lists operator-issued clients with `name`, `created_at`, active-grants count, and a Revoke button. Empty state when none.
- [x] New Server Action `revokeOwnerTokenAction(formData)` that calls `DELETE /oauth/register/{client_id}` with the owner session cookie. Surface success/error via redirect with `?notice=revoked` / `?error=...`.

## 6. Tests

- [x] `reference-implementation/test/dcr-per-owner-token.test.js`:
  - Register a dynamic client with `client_name` while owner-session-authed → 201 with returned `client_name` and AS-stamped `issuer_subject_id`.
  - Attempt to register `issuer_subject_id` anonymously → succeeds but `issuer_subject_id` is silently dropped.
  - `GET /_ref/clients?owner=true` returns only the operator-issued client(s); does not include `pdpp-web-dashboard`.
  - Run device flow against a per-token client to issue a bearer; introspect returns active.
  - `DELETE /oauth/register/{client_id}` with matching owner session → 204; subsequent introspect of that owner bearer returns `{ active: false, inactive_reason: 'token_revoked' }`.
  - `DELETE` for a different operator's client → 403.
  - `DELETE` for a pre-registered client (e.g. `pdpp-web-dashboard`) → 403.
  - `DELETE` for an unknown id → 404.

## 7. Validation

- [x] `openspec validate dcr-per-owner-token-with-revoke --strict` passes.
- [x] `openspec validate --all --strict` passes.
- [ ] Manual: issue token "laptop-export", refresh page → still listed; revoke → list empties; introspect the old bearer string → inactive.

## ADDED Requirements

### Requirement: The reference AS SHALL support RFC 7592 client deletion for dynamic clients

The reference AS SHALL expose `DELETE /oauth/register/{client_id}` to delete a dynamically-registered OAuth client. The endpoint SHALL be authenticated by the owner session cookie (the dashboard is the operator-facing caller; PDPP does not issue RFC 7592 registration access tokens). Deletion SHALL cascade-revoke every `grants` row tied to the deleted client and every owner self-export token row tied to the deleted client so that bearer tokens issued against it become inactive on subsequent introspect.

#### Scenario: Owner deletes a client they registered

- **WHEN** an operator with a valid owner session POSTs to `DELETE /oauth/register/{client_id}` for a `registration_mode = 'dynamic'` client whose `metadata.issuer_subject_id` matches the operator's session subject
- **THEN** the AS SHALL revoke every grant where `client_id = {client_id}` via the existing `revokeGrant` codepath
- **AND** SHALL revoke every owner self-export token where `client_id = {client_id}`
- **AND** SHALL delete the `oauth_clients` row
- **AND** SHALL emit a `client.deleted` spine event with the cascade summary
- **AND** SHALL respond 204

#### Scenario: Owner attempts to delete a different operator's client

- **WHEN** an operator's owner session subject does not match the target client's `metadata.issuer_subject_id`
- **THEN** the AS SHALL respond 403 `forbidden`
- **AND** SHALL NOT delete the client or revoke any grants

#### Scenario: Owner attempts to delete a pre-registered client

- **WHEN** the target client's `registration_mode` is not `'dynamic'`
- **THEN** the AS SHALL respond 403 `forbidden`
- **AND** SHALL NOT delete the client or revoke any grants

#### Scenario: Idempotent delete

- **WHEN** the operator deletes the same `client_id` twice
- **THEN** the second call SHALL respond 404 `not_found`
- **AND** SHALL NOT 5xx

#### Scenario: Bearers issued against a deleted client introspect as inactive

- **WHEN** a bearer was issued via the device flow against a now-deleted dynamic client
- **THEN** subsequent `POST /introspect` for that owner self-export bearer SHALL return `{ active: false, inactive_reason: 'token_revoked' }`

#### Scenario: Grant-bound client bearers issued against a deleted client introspect as grant-revoked

- **WHEN** a grant-bound client bearer was issued against a now-deleted dynamic client
- **THEN** subsequent `POST /introspect` for that grant-bound bearer SHALL return `{ active: false, inactive_reason: 'grant_revoked' }`

### Requirement: The reference AS SHALL stamp `issuer_subject_id` metadata on DCR registrations from owner-authed callers

The reference AS SHALL stamp and persist `issuer_subject_id` on `POST /oauth/register` requests when the request carries a valid owner session cookie. The persisted value SHALL equal the requesting owner session's subject. The AS SHALL NOT trust a caller-supplied `issuer_subject_id`; anonymous DCR requests SHALL silently drop `issuer_subject_id` if present in the body.

#### Scenario: Owner-authed DCR with issuer_subject_id

- **WHEN** the dashboard POSTs `/oauth/register` with `{ client_name, token_endpoint_auth_method: 'none' }` while carrying a valid owner session cookie
- **THEN** the AS SHALL persist `client_name` and AS-stamped `issuer_subject_id` on the new `oauth_clients` row
- **AND** SHALL return the registered client metadata in the response

#### Scenario: Anonymous DCR cannot set issuer_subject_id

- **WHEN** an anonymous caller POSTs `/oauth/register` with `issuer_subject_id` in the body
- **THEN** the AS SHALL register the client without persisting `issuer_subject_id`
- **AND** the registered client SHALL NOT appear in any operator's `GET /_ref/clients?owner=true` listing

### Requirement: The reference AS SHALL expose an operator-issued client listing under `/_ref/clients`

The reference AS SHALL expose `GET /_ref/clients?owner=true`, owner-session-gated, returning the dynamic clients whose `metadata.issuer_subject_id` matches the requesting owner session's subject. Each list entry SHALL include `client_id`, `client_name`, `created_at`, and the count of currently-active bearer tokens tied to the client.

#### Scenario: Operator lists their own dashboard-issued clients

- **WHEN** an operator with a valid owner session GETs `/_ref/clients?owner=true`
- **THEN** the AS SHALL return `{ object: 'list', data: [{ client_id, client_name, created_at, active_token_count }, ...] }`
- **AND** the data SHALL contain only clients with `registration_mode = 'dynamic'` and `metadata.issuer_subject_id` equal to the operator's session subject
- **AND** SHALL NOT include pre-registered clients (e.g. `pdpp-web-dashboard`, `cli_longview`)

#### Scenario: Owner-session-gated

- **WHEN** a caller GETs `/_ref/clients?owner=true` without a valid owner session
- **THEN** the AS SHALL respond 401 `owner_session_required`

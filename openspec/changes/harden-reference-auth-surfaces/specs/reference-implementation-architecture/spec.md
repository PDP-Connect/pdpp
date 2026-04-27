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

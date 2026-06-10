## 1. OpenSpec

- [x] 1.1 Promote the client-event-subscriptions design-note into an OpenSpec change.
- [x] 1.2 Define the minimal reference-only authorization, projection, signing, retry, and lifecycle boundaries.
- [x] 1.3 Revise spec/design to mount under `/v1/event-subscriptions`, advertise via protected-resource metadata, and require Postgres parity.

## 2. Storage

- [x] 2.1 Add `client_event_subscriptions`, `client_event_queue`, `client_event_attempts` tables (SQLite via registered queries).
- [x] 2.2 Add helpers for creating, reading, updating, claiming, and dead-lettering subscriptions and queue rows.
- [x] 2.3 Add the matching Postgres DDL in `postgres-storage.js` and a Postgres-backed store; backend-aware resolver picks the active store.

## 3. Operations

- [x] 3.1 `as-client-event-subscription-create` — authorize against client grant, validate callback URL, persist subscription, enqueue verification event.
- [x] 3.2 `as-client-event-subscription-read` / `-list` / `-update` / `-delete`.
- [x] 3.3 `as-client-event-subscription-test-event` — enqueue a deterministic `subscription.test` event for E2E.
- [x] 3.4 `rs-client-event-derive` — pure function from `record_changes` row + subscriptions list to envelopes.
- [x] 3.5 `rs-client-event-deliver` — HMAC sign, POST callback, classify outcome, schedule retry, attempt log.
- [x] 3.6 Convert the operation interface and the store contract to a uniformly-awaited Promise shape so SQLite (sync) and Postgres (async) backends are interchangeable.

## 4. Wiring

- [x] 4.1 Hook `enqueueClientEventsForRecordChange` into `ingestRecord` after `outcome.kind === 'changed'`.
- [x] 4.2 Hook grant-revoke flow to enqueue `grant.revoked` and mark subscriptions `disabled_revoked`.
- [x] 4.3 Mount the six route handlers on the resource server under `/v1/event-subscriptions` with `requireToken` + `requireClient`. Drop the `_ref` alias.
- [x] 4.4 Start the in-process delivery worker on `startServer`, with all worker-facing store helpers awaited.
- [x] 4.5 Advertise the surface in the RS protected-resource metadata document via a new `client_event_subscriptions` capability builder + composition rule.

## 5. Tests And Validation

- [x] 5.1 Pure derivation tests: projection-safety, narrowed scope, revoked-grant filter.
- [x] 5.2 Operation tests: create/read/list/update/delete authorization, verification handshake, signing/idempotency, retry classification. Tests run against an async store contract.
- [x] 5.3 Route + delivery integration test against a local Node HTTP receiver: create via canonical `/v1/event-subscriptions`, verify, test event, real record ingest, HMAC verify, read via `changes_since`.
- [x] 5.4 Discovery test: `/.well-known/oauth-protected-resource` advertises `client_event_subscriptions` with endpoint, signing, event types, delivery, verification, hint cursor, callback URL, and limits.
- [x] 5.5 Postgres parity test: a dedicated test exercises create → verify → list → rotate → test-event enqueue → claim queue → attempt log → grant revoke against a live Postgres backend when `PDPP_TEST_POSTGRES_URL` is set.
- [x] 5.6 Run targeted tests.
- [x] 5.7 Run OpenSpec validation (`openspec validate add-client-event-subscriptions --strict`).

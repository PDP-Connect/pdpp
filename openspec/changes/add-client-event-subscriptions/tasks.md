## 1. OpenSpec

- [x] 1.1 Promote the client-event-subscriptions design-note into an OpenSpec change.
- [x] 1.2 Define the minimal reference-only authorization, projection, signing, retry, and lifecycle boundaries.

## 2. Storage

- [x] 2.1 Add `client_event_subscriptions`, `client_event_queue`, `client_event_attempts` tables.
- [x] 2.2 Add helpers for creating, reading, updating, claiming, and dead-lettering subscriptions and queue rows.

## 3. Operations

- [x] 3.1 `as-client-event-subscription-create` — authorize against client grant, validate callback URL, persist subscription, enqueue verification event.
- [x] 3.2 `as-client-event-subscription-read` / `-list` / `-update` / `-delete`.
- [x] 3.3 `as-client-event-subscription-test-event` — enqueue a deterministic `subscription.test` event for E2E.
- [x] 3.4 `rs-client-event-derive` — pure function from `record_changes` row + subscriptions list to envelopes.
- [x] 3.5 `rs-client-event-deliver` — HMAC sign, POST callback, classify outcome, schedule retry, attempt log.

## 4. Wiring

- [x] 4.1 Hook `enqueueClientEventsForRecordChange` into `ingestRecord` after `outcome.kind === 'changed'`.
- [x] 4.2 Hook grant-revoke flow to enqueue `grant.revoked` and mark subscriptions `disabled_revoked`.
- [x] 4.3 Mount the six AS routes under `/_ref/client-event-subscriptions` with `requireToken` + `requireClient`.
- [x] 4.4 Start the in-process delivery worker on `startServer`.

## 5. Tests And Validation

- [x] 5.1 Pure derivation tests: projection-safety, narrowed scope, revoked-grant filter.
- [x] 5.2 Operation tests: create/read/list/update/delete authorization, verification handshake, signing/idempotency, retry classification.
- [x] 5.3 Route + delivery integration test against a local Node HTTP receiver: create, verify, test event, real record ingest, HMAC verify, read via `changes_since`.
- [x] 5.4 Run targeted tests.
- [x] 5.5 Run OpenSpec validation.

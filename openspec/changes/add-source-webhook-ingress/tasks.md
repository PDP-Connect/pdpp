## 1. OpenSpec

- [x] 1.1 Promote the source-webhooks design-note decision into an OpenSpec change.
- [x] 1.2 Define the minimal reference-only security, idempotency, ingest, and scheduler boundaries.

## 2. Implementation

- [x] 2.1 Add source webhook signature verification and envelope execution as an operation-level module.
- [x] 2.2 Add durable source webhook event idempotency storage.
- [x] 2.3 Add the reference-only `POST /_ref/source-webhooks/:sourceId` route.
- [x] 2.4 Wire record pushes through `rs.records.ingest`.
- [x] 2.5 Wire run triggers as scheduler input only.

## 3. Tests And Validation

- [x] 3.1 Add operation tests for signature, replay, ingest mapping, and scheduler mapping.
- [x] 3.2 Add route tests against the running reference server.
- [x] 3.3 Run targeted tests.
- [x] 3.4 Run OpenSpec validation.

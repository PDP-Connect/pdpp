## Context

`design-notes/source-webhooks-and-event-driven-collection-2026-05-15.md` deferred generic source webhooks because the broad version needs subscription lifecycle, ordering, retries, renewal, source account binding, and cross-implementation payload agreement. This tranche deliberately avoids that scope.

The implementation target is a minimal secure reference-ingress substrate:

- source-specific callback credentials configured by the reference operator;
- signed callback verification at the HTTP boundary;
- durable replay/idempotency guard keyed by `(source_id, event_id)`;
- accepted record pushes routed through the existing record ingest semantics;
- accepted run triggers recorded as scheduler input and not executed inline.

## Boundary

The endpoint is reference-only: `POST /_ref/source-webhooks/:sourceId`. It does not appear in PDPP protected-resource metadata and does not create `event_driven` grants or manifest capabilities.

Each source credential is operator configured through `PDPP_SOURCE_WEBHOOK_SECRETS`, a comma-separated list of `source_id:secret` entries or `source_id:secret:connector_id` entries. The optional connector id lets operators use URL-safe callback source ids while binding the callback to the registered connector/source that receives the ingest or scheduler signal.

The signed envelope uses:

- `PDPP-Webhook-Timestamp`: Unix seconds.
- `PDPP-Webhook-Event-Id`: idempotency key.
- `PDPP-Webhook-Signature`: `sha256=<hex hmac>`.
- HMAC input: `<timestamp>.<raw request body>`.

The body supports only:

- `{"action":"ingest_records","stream":"...","records":[...]}`.
- `{"action":"schedule_run"}`.

`ingest_records` serializes records to NDJSON and calls the existing `executeRecordsIngest` operation with the bound connector id. This preserves stream lookup, record validation, primary-key behavior, tombstones, projection, and grant-visible reads.

`schedule_run` updates the persisted scheduler last-run signal for the connector to the callback time. It intentionally does not spawn a connector process, bypass non-overlap, or override backoff/owner-attention policy. A fuller event-trigger queue can replace this marker later.

## Alternatives

- Generic `/v1/push/...`: rejected because it would look like PDPP protocol support without interoperable producers.
- Source-triggered immediate connector execution: rejected because it bypasses scheduler non-overlap and backoff semantics.
- Bearer owner tokens or client grants on source callbacks: rejected because internet callbacks need source-specific credentials and must not reuse owner/client authorization.

## Acceptance Checks

- `openspec validate add-source-webhook-ingress --strict`
- `openspec validate --all --strict`
- Operation tests cover signature verification, stale timestamps, malformed signatures, idempotency, record-ingest mapping, and scheduler-trigger mapping.
- Route tests cover unauthenticated rejection, duplicate-event idempotency, and successful record ingestion through the running reference server.

## Residual Risks

- Subscription creation, challenge verification, renewal, retry, dead-letter, ordering, and source-account lifecycle remain out of scope.
- Secret rotation is operator-managed by replacing env configuration.
- `schedule_run` is only a persisted scheduler input marker, not a complete event-trigger queue.

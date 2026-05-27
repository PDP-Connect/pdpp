## Context

`changes_since` already gives clients a projection-safe pull cursor. What is missing is a low-cost way for a client to learn that *something it can see* has changed, so it can fetch via the existing read path without polling on a schedule. The design note enumerated the load-bearing constraints; this change converts them into a durable surface.

The construction goal is one event-derivation and authorization seam that can plug into multiple transports later (HTTPS callbacks now, SSE/WebSocket/MCP `notifications/resources/updated` later) without duplicating grant projection logic.

## Boundary

The endpoints are reference-only, on the AS host:

- `POST   /_ref/client-event-subscriptions` — client bearer required. Creates a subscription bound to the bearer's grant.
- `GET    /_ref/client-event-subscriptions` — client bearer; lists the bearer's own subscriptions.
- `GET    /_ref/client-event-subscriptions/:subscriptionId` — client bearer; same grant only.
- `PATCH  /_ref/client-event-subscriptions/:subscriptionId` — client bearer; toggle `enabled`, rotate `secret`.
- `DELETE /_ref/client-event-subscriptions/:subscriptionId` — client bearer; tombstones the subscription.
- `POST   /_ref/client-event-subscriptions/:subscriptionId/test-event` — client bearer; enqueues a deterministic `subscription.test` event for end-to-end verification without requiring a real record mutation.

The reference does not advertise these routes in PDPP protected-resource metadata. A future durable cross-implementation contract would require its own OpenSpec change.

### Authorization

Subscription creation, read, modify, and delete are scoped to the *same client + grant* as the bearer token. The persisted row stores `(grant_id, client_id, subject_id)` lifted from the bearer's grant. A bearer whose grant is revoked or expired cannot create or modify subscriptions, and existing subscriptions are auto-disabled when the bound grant transitions to non-active state.

The subscription's *effective scope* is a snapshot of the grant's `(source, streams[].name, streams[].resources, streams[].connection_id, streams[].time_range)`. The event-derivation step uses this snapshot to decide which events are visible. The client cannot widen the scope beyond its grant; it can only narrow it via the optional `filters` object (a subset of stream names from the grant).

### Subscription lifecycle and verification

On `POST /_ref/client-event-subscriptions` the reference issues an opaque `subscription_id`, generates a random delivery `secret` returned **once** in the create response, and persists the subscription in state `pending_verification`. Before delivering any record-driven events the reference performs a one-shot verification:

- The reference POSTs a `subscription.verify` event whose body contains a server-issued `challenge` string.
- The callback must return HTTP 2xx with `{ "challenge": "<same string>" }` within the verification window.
- On success the subscription transitions to `active`. On failure it stays `pending_verification` and may be retried by the client via `POST .../verify`.

This follows the WebSub / MS Graph handshake pattern. It is cheap, has no separate URL-confirmation step, and prevents accidental delivery to URLs the client mistyped.

### Event envelope

Events are CloudEvents-flavored but reference-defined:

```json
{
  "specversion": "1.0-pdpp",
  "id": "evt_<base32 ulid>",
  "type": "pdpp.records.changed" | "pdpp.subscription.verify" | "pdpp.subscription.test" | "pdpp.grant.revoked",
  "source": "/_ref/client-event-subscriptions/<subscription_id>",
  "subscription_id": "sub_<...>",
  "client_id": "<client>",
  "grant_id": "<grant>",
  "occurred_at": "<ISO-8601 UTC>",
  "data": {
    "stream": "<stream-name>",            // records.changed only; null for non-stream events
    "connection_id": "<conn>",            // included only when grant binds it
    "changes_since": "<opaque cursor>",   // monotonic high-water hint the client can pass to /v1/streams/:s/records
    "change_count_hint": 1                // coalesced batch size, may be > 1
  }
}
```

No record bodies. No field values. No resource ids unless they are already part of the grant scope (e.g. a single explicitly granted resource id). The client treats the event as a hint and calls the existing `rs.records.list` / `rs.records.detail` reads to fetch projected data.

### Signing

Every callback request carries:

- `PDPP-Event-Timestamp`: Unix seconds.
- `PDPP-Event-Id`: same as envelope `id`; idempotency key for the client.
- `PDPP-Subscription-Id`: subscription id (informational; do not rely on for auth).
- `PDPP-Event-Signature`: `sha256=<hex hmac>` over `<timestamp>.<raw body>` using the per-subscription `secret`.

Receivers must verify the signature, then check the timestamp is within an accepted skew, then dedupe by `id`. The signature scheme matches the source-webhook ingress so PDPP only carries one signing convention.

### Delivery semantics

- At-least-once. Receivers must be idempotent on `id`.
- After-commit enqueue. The records pipeline calls `enqueueClientEvent` only after `ingestRecord` returns `outcome.kind === 'changed'`. The change is therefore already in `record_changes` and queryable when the event ships.
- Retries: exponential backoff with jitter at 30s, 2m, 10m, 1h, 6h, 24h (six attempts). After the final failure the attempt log records `final_failure` and the subscription transitions to `disabled_failure`. The client may re-enable via PATCH.
- HTTPS only. The create endpoint rejects non-HTTPS callbacks except for `http://localhost` / `http://127.0.0.1` / `http://[::1]` to support local dev receivers (tests rely on this).
- Coalescing: while a queued event for the same `(subscription_id, stream)` is still pending, additional changes update `change_count_hint` and `changes_since` rather than enqueueing duplicates. This preserves "hint, not record" semantics and prevents callback amplification.
- Dead-letter: the attempt log records all 6 attempts with status code, latency, request id, and response snippet (≤512 bytes). After `final_failure` the row is retained for owner inspection; the live event queue moves on.

### Grant revocation / change behavior

- Grant revoked: a `pdpp.grant.revoked` event fires once, the subscription transitions to `disabled_revoked`, and no more events ship for it. Already-queued events for that subscription are dropped.
- Grant scope narrowed (future): the snapshot in the subscription is *not* widened automatically. If a future change narrows the grant, the snapshot is intersected on the next event derivation. We do not retro-leak.

### Event derivation seam

`derivClientEventsFromRecordChange(change, subscriptions[])` is a pure function: it takes a record-change descriptor `{ connector_id, connection_id, stream, version, emitted_at }` and the list of active subscriptions, intersects against each subscription's scope snapshot, and emits a list of `{subscription_id, type, data}` envelopes. The same function will back SSE/WebSocket transports later. It must not depend on Fastify, SQLite, or `process.env`.

### Storage

Three new tables. Names mirror existing reference conventions.

- `client_event_subscriptions(subscription_id PK, grant_id, client_id, subject_id, callback_url, secret_hash, scope_json, status, verification_challenge, verification_attempts, last_event_id, created_at, updated_at, disabled_at, disabled_reason)`.
- `client_event_queue(queue_id PK auto, subscription_id, event_id UNIQUE, event_type, payload_json, enqueued_at, next_attempt_at, attempt_count, status, last_error)`.
- `client_event_attempts(attempt_id PK auto, queue_id, attempted_at, status_code, ok, latency_ms, error, response_snippet)`.

All three are owner-local; they do not appear in client-visible reads outside the subscription surface.

## Alternatives

- **Generic `/v1/events`**: rejected. The point of this tranche is to prove the construction in the reference, not to define a cross-implementation contract.
- **Include record bodies in events**: rejected. Bodies require the same projection enforcement as `rs.records.list`, defeating the "minimal hint" property and forcing duplicate grant logic in delivery.
- **Synchronous in-request delivery from `ingestRecord`**: rejected. Couples write latency to receiver liveness, violates the "after durable commit" requirement, and makes retry impossible.
- **Reuse owner web push (`web_push_subscriptions`)**: rejected. That is owner-only, browser push, and has different security properties (VAPID). Client subscriptions must be grant-scoped and HMAC-signed.
- **Confirm via 200 to a GET handshake (WebSub-style)**: considered. A POST-with-challenge-in-body is simpler for testers, reuses the signing path, and avoids two callback shapes.

## Acceptance Checks

- `openspec validate add-client-event-subscriptions --strict`
- `openspec validate --all --strict`
- Operation tests cover: create authorization, projection-safety (event must not name a stream outside the grant), verification handshake (success / wrong-challenge / non-2xx), signature verification, idempotent re-delivery, retry/backoff schedule, coalescing, dead-letter transition, grant-revoked auto-disable.
- Route tests cover: client-bearer enforcement, owner cannot list another client's subscriptions, post-commit enqueue ordering against `record_changes.version`, end-to-end signed delivery to a local HTTP receiver.
- Real-client proof: a Node HTTP receiver in a test creates a subscription, completes the verification handshake, triggers `subscription.test` plus a real record ingest, receives both signed callbacks, verifies HMAC, and reads the changed record via `/v1/streams/:s/records?changes_since=...` using the cursor from the event hint.

## Residual Risks

- Coalescing means clients cannot count exact change events. They use `changes_since` to enumerate. The `change_count_hint` is a hint, not a guarantee.
- The reference does not advertise a cross-implementation protocol. Other PDPP implementations are free to expose a different surface until a Core change promotes one.
- Subscription `secret` is shown once; lost secrets require a `PATCH .../rotate-secret` which invalidates outstanding signatures.
- Dead-letter retention is unbounded in this slice. A later change can add a TTL or operator dashboard. Owner can inspect `client_event_attempts` directly.
- Verification handshake assumes the callback URL stays stable. Changing the callback URL via PATCH re-enters `pending_verification`.

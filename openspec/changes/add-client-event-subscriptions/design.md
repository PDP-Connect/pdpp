## Context

`changes_since` already gives clients a projection-safe pull cursor. What is missing is a low-cost way for a client to learn that *something it can see* has changed, so it can fetch via the existing read path without polling on a schedule. The design note enumerated the load-bearing constraints; this change converts them into a durable surface.

The construction goal is one event-derivation and authorization seam that can plug into multiple transports later (HTTPS callbacks now, SSE/WebSocket/MCP `notifications/resources/updated` later) without duplicating grant projection logic.

## Boundary

The endpoints live on the **resource server** (same host that serves `/v1/streams/...`), under the canonical `/v1` namespace, with the same client-bearer authorization shape as the existing reads:

- `POST   /v1/event-subscriptions` — client bearer required. Creates a subscription bound to the bearer's grant.
- `GET    /v1/event-subscriptions` — client bearer; lists the bearer's own subscriptions.
- `GET    /v1/event-subscriptions/:subscriptionId` — client bearer; same grant only.
- `PATCH  /v1/event-subscriptions/:subscriptionId` — client bearer; toggle `enabled`, rotate `secret`.
- `DELETE /v1/event-subscriptions/:subscriptionId` — client bearer; tombstones the subscription.
- `POST   /v1/event-subscriptions/:subscriptionId/test-event` — client bearer; enqueues a deterministic `subscription.test` event for end-to-end verification without requiring a real record mutation.

The reference advertises these endpoints in the RS protected-resource metadata document as a `client_event_subscriptions` capability with `stability: "reference_extension"`, `scope: "reference_implementation"`, and an `endpoint: "/v1/event-subscriptions"` pointer. The advertisement also carries the signing scheme, supported event types, delivery semantics, verification handshake, hint cursor location, and client-visible limits so callers can use the feature without out-of-band docs. The Core PDPP query base, schema, and search hints are unchanged. A future durable cross-implementation contract would require its own OpenSpec change to promote the capability into Core.

There is **no** legacy `_ref` alias. The earlier `/_ref/client-event-subscriptions` surface used by rev1 has been removed; clients use the canonical `/v1/event-subscriptions` path.

### Authorization

Subscription creation, read, modify, and delete are scoped to the *same client + grant* as the bearer token. The persisted row stores `(grant_id, client_id, subject_id)` lifted from the bearer's grant. A bearer whose grant is revoked or expired cannot create or modify subscriptions, and existing subscriptions are auto-disabled when the bound grant transitions to non-active state.

The subscription's *effective scope* is a snapshot of the grant's `(source, streams[].name, streams[].resources, streams[].connection_id, streams[].time_range)`. The event-derivation step uses this snapshot to decide which events are visible. The client cannot widen the scope beyond its grant; it can only narrow it via the optional `filters` object (a subset of stream names from the grant).

### Subscription lifecycle and verification

On `POST /v1/event-subscriptions` the reference issues an opaque `subscription_id`, generates a random delivery `secret` returned **once** in the create response, and persists the subscription in state `pending_verification`. Before delivering any record-driven events the reference performs a one-shot verification:

- The reference POSTs a `subscription.verify` event whose body contains a server-issued `challenge` string.
- The callback must return HTTP 2xx with `{ "challenge": "<same string>" }` within the verification window.
- On success the subscription transitions to `active`. On failure it stays `pending_verification` and may be retried by the client.

This follows the WebSub / MS Graph handshake pattern. It is cheap, has no separate URL-confirmation step, and prevents accidental delivery to URLs the client mistyped.

### Event envelope

Events are CloudEvents-flavored but reference-defined:

```json
{
  "specversion": "1.0-pdpp",
  "id": "evt_<base32 ulid>",
  "type": "pdpp.records.changed" | "pdpp.subscription.verify" | "pdpp.subscription.test" | "pdpp.grant.revoked",
  "source": "/v1/event-subscriptions/<subscription_id>",
  "subscription_id": "sub_<...>",
  "occurred_at": "<ISO-8601 UTC>",
  "data": {
    "stream": "<stream-name>",            // records.changed only; null for non-stream events
    "connection_id": "<conn>",            // included only when grant binds it
    "changes_since": "<opaque cursor>",   // monotonic high-water hint the client can pass to /v1/streams/:s/records
    "change_count_hint": 1                // coalesced batch size, may be > 1
  }
}
```

The `source` field is the canonical RS path of the subscription, which the client can dereference at `GET /v1/event-subscriptions/:id` to inspect current state.

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

### Discovery

The capability advertisement composed by `rs.protected-resource-metadata` and emitted at `/.well-known/oauth-protected-resource` carries the full client-visible contract: endpoint, signing scheme + header names, supported event types, retry schedule and max attempts, verification handshake shape, hint cursor field, callback-URL HTTPS requirement, and byte-level limits (callback URL max, response snippet capture). The advertisement is shaped by `buildClientEventSubscriptionsCapability` in `server/metadata.ts`; the operation layer only decides *whether* to advertise (default on, suppressible via `clientEventSubscriptionsSupported: false`).

The metadata schema's `capabilities` field is `additionalProperties: true`, so emitting a new top-level entry does not break the public OpenAPI document. Clients that don't recognize the key simply ignore it; clients that do can use the feature without docs.

### Grant revocation / change behavior

- Grant revoked: a `pdpp.grant.revoked` event fires once, the subscription transitions to `disabled_revoked`, and no more events ship for it. Already-queued events for that subscription are dropped.
- Grant scope narrowed (future): the snapshot in the subscription is *not* widened automatically. If a future change narrows the grant, the snapshot is intersected on the next event derivation. We do not retro-leak.

### Event derivation seam

`derivClientEventsFromRecordChange(change, subscriptions[])` is a pure function: it takes a record-change descriptor `{ connector_id, connection_id, stream, version, emitted_at }` and the list of active subscriptions, intersects against each subscription's scope snapshot, and emits a list of `{subscription_id, type, data}` envelopes. The same function will back SSE/WebSocket transports later. It must not depend on Fastify, SQLite, Postgres, or `process.env`.

### Storage — SQLite and Postgres parity

Three new tables. Names mirror existing reference conventions. Both reference storage backends carry identical schemas; the runtime resolves the active store via `isPostgresStorageBackend()`.

- `client_event_subscriptions(subscription_id PK, grant_id, client_id, subject_id, callback_url, secret_hash, secret_text, scope_json, status, verification_challenge, created_at, updated_at, disabled_at, disabled_reason)`.
- `client_event_queue(queue_id PK auto, subscription_id, event_id UNIQUE, event_type, payload_json, enqueued_at, next_attempt_at, attempt_count, status, last_error)`.
- `client_event_attempts(attempt_id PK auto, queue_id, attempted_at, status_code, ok, latency_ms, error, response_snippet)`.

The `store.ts` module exports `createSqliteClientEventSubscriptionStore()` and `createPostgresClientEventSubscriptionStore()` plus a `getDefaultClientEventSubscriptionStore()` resolver that picks based on the active storage backend. The same resolver also covers worker-facing helpers (`claimDueQueue`, `updateQueueAttempt`, `insertAttempt`, `listAttemptsForQueue`, `listActiveSubscriptions`), all of which are backend-aware and return Promises. The operation layer awaits the store interface uniformly.

All three tables are owner-local; they do not appear in client-visible reads outside the subscription surface.

## Alternatives

- **Generic `/v1/events`**: rejected for this tranche. The point is to prove the construction in the reference. Once the shape stabilizes, a Core change can promote a generic event surface.
- **Hide behind `/_ref/...`**: rejected. The route is a real client-facing surface; `_ref` is reserved for operator/admin paths that PDPP clients do not consume. Hiding the route here would require clients to read out-of-band docs and would not match the runtime authorization shape (client bearer, grant-scoped).
- **Include record bodies in events**: rejected. Bodies require the same projection enforcement as `rs.records.list`, defeating the "minimal hint" property and forcing duplicate grant logic in delivery.
- **Synchronous in-request delivery from `ingestRecord`**: rejected. Couples write latency to receiver liveness, violates the "after durable commit" requirement, and makes retry impossible.
- **Reuse owner web push (`web_push_subscriptions`)**: rejected. That is owner-only, browser push, and has different security properties (VAPID). Client subscriptions must be grant-scoped and HMAC-signed.
- **SQLite-only with Postgres deferred**: rejected on revision. The RI ships against both backends in the Docker target; storage parity is part of the closeout, not a follow-up.

## Acceptance Checks

- `openspec validate add-client-event-subscriptions --strict`
- `openspec validate --all --strict`
- Operation tests cover: create authorization, projection-safety (event must not name a stream outside the grant), verification handshake (success / wrong-challenge / non-2xx), signature verification, idempotent re-delivery, retry/backoff schedule, coalescing, dead-letter transition, grant-revoked auto-disable.
- Route tests cover: client-bearer enforcement, owner cannot list a client's subscriptions, post-commit enqueue ordering against `record_changes.version`, end-to-end signed delivery to a local HTTP receiver via the canonical `/v1/event-subscriptions` route, discovery advertisement at `/.well-known/oauth-protected-resource`.
- Postgres parity: dedicated test (`client-event-subscription-store-postgres.test.js`) drives subscription create → verify → list → secret rotation → test-event enqueue → claim queue with subscription join → attempt log → grant-revoke side-effects against a real Postgres server when `PDPP_TEST_POSTGRES_URL` is set.
- Real-client proof: a Node HTTP receiver in a test creates a subscription via the canonical route, completes the verification handshake, triggers `subscription.test` plus a real record ingest, receives both signed callbacks, verifies HMAC, and reads the changed record via `/v1/streams/:s/records` after seeing the hint cursor.

## Residual Risks

- Coalescing means clients cannot count exact change events. They use `changes_since` to enumerate. The `change_count_hint` is a hint, not a guarantee.
- The reference advertises this as a reference-implementation extension. Other PDPP implementations are free to expose a different surface until a Core change promotes one.
- Subscription `secret` is shown once; lost secrets require a `PATCH .../rotate-secret` which invalidates outstanding signatures.
- Dead-letter retention is unbounded in this slice. A later change can add a TTL or operator dashboard. Owner can inspect `client_event_attempts` directly.
- Verification handshake assumes the callback URL stays stable. Changing the callback URL via PATCH re-enters `pending_verification`.

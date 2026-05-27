## Why

`design-notes/client-event-subscriptions-and-freshness-2026-04-26.md` captured the need for an outbound, grant-scoped notification channel from the personal server to authorized clients. Today clients must poll `changes_since` for every stream they care about, which is wasteful when collection is scheduled or manual. A narrow, projection-safe subscription primitive lets clients react quickly without leaking record existence or fields outside the grant.

This is distinct from source-platform webhooks (`add-source-webhook-ingress`), PWA owner notifications, and local device exporter push. Those are inbound or owner-only. This change is outbound, client-facing, and bound by the same grant model that already governs reads.

## What Changes

- Add an outbound client event-subscription surface on the resource server at `POST/GET/PATCH/DELETE /v1/event-subscriptions[/:id]` plus `POST /v1/event-subscriptions/:id/test-event`. Same client-bearer authorization as the existing `/v1/streams/...` reads.
- Advertise the surface as a `client_event_subscriptions` capability in the RS protected-resource metadata document (`/.well-known/oauth-protected-resource`), marked `stability: "reference_extension"` and `scope: "reference_implementation"`. The advertisement carries endpoint, supported event types, signing algorithm and headers, delivery semantics, verification handshake shape, hint-cursor field, and client-visible limits — so callers can discover and use it without out-of-band docs. Core/cross-implementation standardization remains future work.
- Define the subscription lifecycle: create, get, list, disable, delete, with a verification handshake on first activation.
- Define the event envelope as projection-safe hints: subscription id, event id, type, occurred_at, source/stream/connection hints already in the grant, and a stream high-water `changes_since` cursor. No record bodies.
- Enqueue events only after the underlying durable mutation commits and is readable.
- Add a delivery worker with HMAC-SHA256 signing, monotonic timestamp, at-least-once delivery, exponential backoff retry, attempt logs, and durable dead-lettering after a configured failure budget.
- Persist subscription / queue / attempt state across **both** reference storage backends (SQLite and Postgres) using the same backend-aware store pattern as other RI surfaces.
- Generalize the event-derivation and authorization seam so future SSE/WebSocket/MCP `resources/updated` transports can reuse it without duplicating grant enforcement.
- Mark `design-notes/client-event-subscriptions-and-freshness-2026-04-26.md` as promoted for this tranche.

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None

Removed:

- None

## Impact

- Affected code: `reference-implementation/operations` (new `as-client-event-subscriptions-*` and `rs-client-event-delivery`), `reference-implementation/server/index.js` (RS app routes + protected-resource-metadata composition + post-commit hook), `reference-implementation/server/db.js`, `reference-implementation/server/postgres-storage.js` (Postgres DDL), `reference-implementation/server/stores/client-event-subscription-store.ts` (SQLite + Postgres backends), `reference-implementation/server/metadata.ts` (`buildClientEventSubscriptionsCapability`), `reference-implementation/operations/rs-protected-resource-metadata` (compose the new capability), `reference-implementation/server/records.js` (post-commit enqueue hook), tests.
- Affected behavior: deployments may register HTTPS callbacks for authorized clients and receive signed grant-scoped hint events. The new endpoint is discoverable via the RS metadata document.
- Protocol impact: none for Core PDPP. The new capability is advertised as a reference-implementation extension (`stability: "reference_extension"`) in the protected-resource metadata document; the metadata schema already permits additional capability entries (`additionalProperties: true`). A future cross-implementation contract for outbound event subscriptions would require its own OpenSpec change.

## Why

`design-notes/client-event-subscriptions-and-freshness-2026-04-26.md` captured the need for an outbound, grant-scoped notification channel from the personal server to authorized clients. Today clients must poll `changes_since` for every stream they care about, which is wasteful when collection is scheduled or manual. A narrow, projection-safe subscription primitive lets clients react quickly without leaking record existence or fields outside the grant.

This is distinct from source-platform webhooks (`add-source-webhook-ingress`), PWA owner notifications, and local device exporter push. Those are inbound or owner-only. This change is outbound, client-facing, and bound by the same grant model that already governs reads.

## What Changes

- Add a reference-only outbound event-subscription surface that lets an authorized client register an HTTPS callback bound to its grant.
- Define the subscription lifecycle: create, get, list, disable, delete, with a verification handshake on first activation.
- Define the event envelope as projection-safe hints: subscription id, event id, type, occurred_at, source/stream/connection hints already in the grant, and a stream high-water `changes_since` cursor. No record bodies.
- Enqueue events only after the underlying durable mutation commits and is readable.
- Add a delivery worker with HMAC-SHA256 signing, monotonic timestamp, at-least-once delivery, exponential backoff retry, attempt logs, and durable dead-lettering after a configured failure budget.
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

- Affected code: `reference-implementation/operations` (new `as-client-event-subscriptions-*` and `rs-client-event-delivery`), `reference-implementation/server/index.js`, `reference-implementation/server/db.js`, `reference-implementation/server/records.js` (post-commit enqueue hook), tests.
- Affected behavior: deployments may register HTTPS callbacks for authorized clients and receive signed grant-scoped hint events.
- Protocol impact: none. Endpoints live on the AS host under reference-only routes; the public PDPP protected-resource metadata is unchanged. A future cross-implementation contract would require its own promotion.

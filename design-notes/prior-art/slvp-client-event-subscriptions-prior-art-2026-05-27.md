# Client Event Subscriptions — Prior-Art Deep Dive

Status: captured
Owner: RI prior-art right-hand
Created: 2026-05-27
Updated: 2026-05-27
Companion to: `slvp-reference-implementation-prior-art-2026-05-27.md`
Related: `design-notes/client-event-subscriptions-and-freshness-2026-04-26.md`, `design-notes/source-webhooks-and-event-driven-collection-2026-05-15.md`, `openspec/changes/add-client-event-subscriptions`

All URLs accessed 2026-05-27.

## TL;DR for PDPP

| Decision | Recommendation | Confidence |
|---|---|---|
| Payload shape | Hint-only, grant-scoped (event + cursor + counts; no record bodies) | High |
| Envelope | CloudEvents 1.0 binary HTTP binding | High |
| Signing | Separate per-subscription HMAC secret (Stripe model), not the bearer client token | High |
| Delivery (v1) | Webhook POST with at-least-once + exponential retry | High |
| Delivery (v2) | SSE stream as optional pull-mode for clients that cannot expose an endpoint | Medium |
| Idempotency | Server-generated `event.id` + monotonic `since_cursor`; client dedupes | High |
| Replay window | 5-minute timestamp tolerance; `since_cursor` for catch-up | High |
| Subscription resource | Explicit object with `expires_at` ≤ grant TTL; emits `subscription.expiring` event | High |
| Skip in v1 | Embedded encrypted payload, dead-letter UI, WebSub hub indirection, MCP stdio carrier | High |

## Per-platform findings

### Stripe — gold standard for the hybrid model

- **Payload model.** Stripe historically embedded the full resource snapshot. Stripe now offers *Thin Events* (hint only: `id`, `type`, `related_object` URL) alongside legacy Snapshot Events; recommendation for new integrations is thin events when "you always need the latest state or want to reduce payload size."
- **Signing.** `Stripe-Signature: t=…,v1=HMAC_SHA256(t + "." + raw_body, whsec_…)`. Default 5-minute timestamp tolerance. Per-endpoint secret (`whsec_…`), not the API key.
- **Retry.** Up to 3 days, ~25 attempts, exponential backoff. Endpoint disabled after 3 days of failure; manual "Resend" up to 15 days.
- **Idempotency.** Stripe re-sends the same `event.id` on retry; client dedupes by storing seen IDs.
- **Filtering.** `enabled_events` array on the endpoint resource; supports `*` wildcards.
- **Scoping.** Connect uses `account` field on the event + separate Connect endpoints.

URLs: https://docs.stripe.com/webhooks, https://docs.stripe.com/webhooks/signature

PDPP take: copy Thin Event pattern, HMAC-with-timestamp signing, retry+dedup. Skip Connect-style multi-account (PDPP grants already define audience).

### Plaid — JWT-signed hint webhooks

- Hint-only. `DEFAULT_UPDATE` / `HISTORICAL_UPDATE` carry `new_transactions` count + `item_id`. Client calls `/transactions/sync` (cursor) to materialize. `ITEM_LOGIN_REQUIRED` is a status signal. `WEBHOOK_VERIFICATION` is the handshake.
- Signing: `Plaid-Verification` JWT, ES256, `kid` resolved via `/webhook_verification_key/get` (authenticated, not public JWKS). Body integrity via `request_body_sha256` in JWT claims; replay window 5 minutes from `iat`.

URL: https://plaid.com/docs/api/webhooks/webhook-verification/

PDPP take: hint+cursor pattern maps 1:1 onto PDPP's existing query API. Use Stripe's HMAC over Plaid's JWT — simpler, and PDPP doesn't have Plaid's offline-verification constraint.

### Google Workspace push channels

- Hint-only, hard. Drive push carries headers (`X-Goog-Channel-ID`, `X-Goog-Resource-State`: `sync|add|remove|update|trash`), never the resource body. Client calls `changes.list(pageToken)`.
- Channel expiry. Channels TTL out (typically 1–24h); client must `channels.stop` + re-`watch`. Verification is a one-time `sync` POST after creation.
- Scope-projection safety. Notification body intentionally minimal precisely because the channel was created under one OAuth scope but might fan out to a process with broader access — Google refuses to embed data and forces a scoped re-fetch.

URL: https://developers.google.com/drive/api/guides/push

PDPP take: strongest argument for hint-only. The second the server embeds anything, every downstream system that handles the notification effectively gets that data. Hints force re-fetch through the grant-scoped query API where projection is centralized.

### Microsoft Graph — the embedded-payload counter-example

- Two-mode model. Default = hint-only (`resourceData`-less notification + lifecycle events). Opt-in via `includeResourceData: true` requires the subscriber to supply an `encryptionCertificate` (RSA public key). Graph then encrypts a symmetric key with the cert and the resource data with the symmetric key, sending both inline.
- Lifecycle. `expirationDateTime` (max varies by resource: 60min presence, 4230min mail), separate `lifecycleNotificationUrl` for `subscriptionRemoved`, `missed`, `reauthorizationRequired`.
- Validation handshake. On subscription create, MS Graph POSTs a `validationToken` that the endpoint must echo within 10s.

URLs: https://learn.microsoft.com/en-us/graph/webhooks, https://learn.microsoft.com/en-us/graph/change-notifications-with-resource-data, https://learn.microsoft.com/en-us/graph/api/resources/subscription

PDPP take: embedded-payload-with-encryption is defer for v1. The lifecycle separation is good — adopt distinct event family (`subscription.expiring`, `grant.revoked`).

### GitHub Webhooks

- Embedded payload. Full resource inline. `X-GitHub-Event`, `X-GitHub-Delivery` UUID, `X-Hub-Signature-256: sha256=HMAC(secret, body)`.
- Retry. Effectively single-attempt; failed deliveries surface in the UI for manual redelivery (8 days).

URL: https://docs.github.com/en/webhooks/about-webhooks

PDPP take: do not copy. PDPP audience is closer to fintech (Plaid/Stripe) than dev-tooling (GitHub).

### MCP `notifications/resources/updated` (spec 2025-06-18)

- Hint-only by design. Client sends `resources/subscribe` with a URI; server emits `notifications/resources/updated` with only the URI; client follows up with `resources/read`.
- List-change is separate (`notifications/resources/list_changed`).
- Reconnect/missed events: spec is silent. Transport does not preserve missed notifications across disconnects — open gap.
- Capability negotiation: `resources.subscribe: true` in `initialize` handshake.

URL: https://modelcontextprotocol.io/specification/2025-06-18/server/resources

PDPP take: adopt capability-handshake pattern. Solve MCP's gap by emitting a monotonic `since_cursor` on every event so a reconnecting client can `GET /events?since=<cursor>` and replay.

### WebSub / SSE / WebPush

- WebSub (W3C REC). Hub-mediated pub/sub. Subscriber POSTs to hub with `hub.callback`, `hub.topic`, `hub.secret`; hub verifies intent with `hub.challenge`; deliveries signed `X-Hub-Signature: sha256=…`. Hub indirection is overkill for PDPP; no third-party fan-out story.
- SSE (WHATWG). One-way HTTP stream, `text/event-stream`, built-in `Last-Event-ID` reconnect. Good fit for clients behind NAT or browser-resident receivers.
- WebPush (RFC 8030 + 8291 VAPID). Strict e2e content encryption; not architecturally relevant unless PDPP wants browser push — defer.

URLs: https://www.w3.org/TR/websub/, https://datatracker.ietf.org/doc/html/rfc8030, https://html.spec.whatwg.org/multipage/server-sent-events.html

### CloudEvents 1.0

- Required attrs: `id`, `source` (URI ref), `specversion`, `type`. Optional: `time`, `subject`, `datacontenttype`, `dataschema`, `data`.
- HTTP binding: binary mode puts attrs in `ce-*` headers, body = data (lets PDPP HMAC-sign the body exactly like Stripe while staying conformant). Structured mode puts everything in JSON body.
- Extensions: namespaced attrs.

URL: https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md

PDPP take: adopt binary HTTP binding. Free interoperability with Knative, Azure Event Grid, AWS EventBridge, Argo Events.

## Cross-cutting verdict

Open tradeoffs for the owner:

1. **SSE as primary vs supplemental.** Forces long-lived connection but eliminates the "client must expose a public HTTPS endpoint" cliff — a real bar for personal-data clients (mobile, desktop, agentic). Recommend webhook v1, SSE v1.1.
2. **`grant.revoked` channel.** Same channel as data events with distinct `type` namespace (`pdpp.grant.*` vs `pdpp.records.*`), so a misconfigured filter cannot silently miss revocation.
3. **Cursor semantics.** Per-grant monotonic `uint64` event cursor vs (timestamp, id) tuple. Recommend monotonic uint64 — trivial to reason about, dedupe, replay.

Anti-patterns to avoid:

- GitHub-style single-delivery + manual-redelivery UI (does not scale to autonomous AI clients).
- Embedding record bodies (Microsoft `includeResourceData`) before there is a real volume/latency problem.
- Reusing the bearer client token as the webhook signing key — different lifecycle, different threat model.
- Bespoke envelope when CloudEvents binary-HTTP costs nothing.
- Hub indirection (WebSub) for a v1 with no third-party fan-out.

## Concrete v1 wire shape (recommendation)

Subscription create (under grant-scoped client token):

```
POST /v1/subscriptions
Authorization: Bearer <client-grant-token>
Content-Type: application/json

{
  "delivery": { "kind": "webhook", "url": "https://client.example/webhook/pdpp" },
  "event_types": ["pdpp.records.changed", "pdpp.grant.revoked", "pdpp.subscription.expiring"],
  "streams": ["messages", "purchases"]
}
```

Subscription create response:

```
201 Created
{
  "subscription_id": "sub_…",
  "signing_secret": "whsec_…",    // returned once, never again
  "expires_at": "<= grant.expires_at>",
  "since_cursor": 0
}
```

Webhook delivery (CloudEvents binary HTTP binding):

```
POST https://client.example/webhook/pdpp
ce-specversion: 1.0
ce-id: evt_01H...
ce-source: https://owner.example/pdpp
ce-type: pdpp.records.changed
ce-time: 2026-05-27T15:00:00Z
ce-subject: messages
ce-pdppgrantid: grant_…
ce-pdppsubscriptionid: sub_…
ce-pdppcursor: 1234
content-type: application/json
PDPP-Signature: t=1748358000,v1=<hex_hmac>

{
  "stream": "messages",
  "since_cursor": 1230,
  "approximate_new_count": 3
}
```

Catch-up endpoint:

```
GET /v1/subscriptions/sub_…/events?since=1230
```

Returns the same CloudEvents JSON shape (structured-mode for replay).

## Decision log

- 2026-05-27: Captured client event subscription deep dive. Companion to the SLVP RI synthesis. PDPP first tranche adopts Stripe HMAC + Plaid hint-only + CloudEvents binary HTTP binding + per-grant monotonic cursor.

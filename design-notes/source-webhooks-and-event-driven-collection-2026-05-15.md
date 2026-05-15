# Source Webhooks And Event-Driven Collection

Status: promoted-partial
Owner: Lane E / protocol architecture
Created: 2026-05-15
Updated: 2026-05-15
Related: `spec-deferred.md`, `spec-core.md`, `docs/research/collection-method-matrix.md`, `docs/archive/2026-04-inbox-retired/webhook-adapter-experiment-memo.md`, `openspec/changes/add-connector-refresh-policy-controls`, `openspec/changes/wire-reference-scheduler-loop`, `openspec/changes/add-source-webhook-ingress`

## Question

Should PDPP add source-platform webhooks or event-driven collection triggers now, either as an OpenSpec change or as runtime implementation work for SLVP?

## Context

The current protocol and reference posture is pull-first:

- `spec-core.md` lists webhook / push ingestion and event-driven collection triggers as out of scope for v0.1.
- `spec-deferred.md` explicitly defers event-driven collection triggers because they require subscription lifecycle management, callback delivery, replay, retry, ordering guarantees, expiry, and renewal.
- `docs/research/collection-method-matrix.md` classifies webhook / push ingestion as runtime-only adaptation when a platform-specific adapter receives events and writes through the existing RS ingest endpoint.
- The archived webhook adapter experiment concluded that the adapter's contract was platform-to-adapter, not PDPP-to-PDPP, and therefore did not warrant a Push Delivery Profile.
- `openspec/changes/add-connector-refresh-policy-controls` and `openspec/changes/wire-reference-scheduler-loop` already give the reference a non-speculative path for freshness: connector-declared refresh posture plus persisted schedules and a server-owned scheduler loop.

There are three distinct push-like directions that should not be conflated:

- Source-to-personal-server webhooks: a source platform notifies the personal server, and the server either ingests pushed records or starts a connector run.
- Personal-server-to-client subscriptions: the personal server notifies an authorized client that grant-visible records, freshness, or grants changed. This is tracked separately in `design-notes/client-event-subscriptions-and-freshness-2026-04-26.md`.
- Owner-device-to-personal-server push: an enrolled local device or collector uploads records, blobs, run events, diagnostics, and heartbeats through reference/control-plane routes. This is already covered by the local device exporter and local collector work; it is not a source-platform webhook and should keep using device-scoped credentials rather than source webhook signatures.

## Stakes

- A generic event-driven collection system would introduce new security and reliability surfaces before there is a real interoperable producer: endpoint authentication, signature verification, replay protection, event idempotency, ordering, retry policy, dead-letter handling, subscription renewal, source account binding, and owner/grant revocation behavior.
- Triggering connector runs from source events is not equivalent to ingesting pushed records. It changes scheduler semantics, non-overlap policy, rate-limit posture, and owner-attention handling.
- A platform-specific adapter can be useful runtime code, but standardizing it prematurely would create a protocol surface around imaginary common webhook payloads.
- For SLVP, the freshness gap is better served by the existing scheduler and refresh-policy work because the current first-party collection reality is browser/API pull, not cooperative PDPP-formatted push.

If source webhooks are ever implemented, the minimum safe boundary is source-specific until proven otherwise:

- Authenticate each source callback with the source's native mechanism, such as HMAC signatures, mTLS, or source-issued bearer credentials. Do not reuse owner tokens, client grant tokens, or local collector device credentials for unauthenticated internet callbacks.
- Bind each callback secret or credential to an owner, connector/source account, stream mapping, and subscription id so one source account cannot write as another.
- Reject stale callbacks with timestamp or nonce replay checks, and persist processed event ids or idempotency keys before record mutation.
- Normalize accepted events into the existing record ingest path so stream schemas, primary keys, projection, blob handling, tombstones, and grant-visible query behavior remain unchanged.
- Treat source-triggered connector runs as scheduler input, not as direct run execution, so existing schedule state, non-overlap, backoff, rate limits, owner-attention, and run diagnostics remain the source of truth.

## Current Leaning

Do not add webhooks or event-driven collection triggers now. This should remain a design note, not an OpenSpec change, because the decision does not yet identify an implementation-ready PDPP contract.

Acceptable near-term work:

- Keep using scheduled/manual connector runs for SLVP freshness.
- Build platform-specific webhook adapters only as local experiments if a concrete source platform requires one, and route accepted records through the existing RS ingest path.
- Treat source-triggered connector runs as scheduler input only after the scheduler has explicit event-trigger semantics, dedupe, non-overlap, backoff, and owner-attention behavior.

Not acceptable without promotion:

- Adding a generic `/v1/push/...` or webhook endpoint to the reference contract.
- Adding `event_driven` grant access mode behavior.
- Advertising source webhooks as PDPP protocol support.
- Letting webhook events bypass existing grant, owner-token, projection, revocation, or ingest validation checks.

## Promotion Trigger

Promote this to OpenSpec before implementing any of the following:

- A PDPP receiver endpoint for source push events, including endpoint path, authentication, payload envelope, idempotency keys, replay protection, ordering, or retry behavior.
- A source subscription lifecycle model, including subscribe, renew, expire, unsubscribe, callback verification, or source account binding.
- A source-triggered scheduler/run policy, including dedupe, non-overlap, priority, backoff, owner-attention, and rate-limit semantics.
- A durable grant or manifest contract for event-driven collection, including `access_mode: "event_driven"` or connector-declared webhook capabilities.
- Any client-visible claim that a connector/source is event-driven rather than scheduled or manually refreshed.

Promotion should require at least one concrete implementation target and an interoperability reason: either a source platform willing to send PDPP-shaped push payloads to independent PDPP servers, or multiple PDPP server implementations that need to agree on how to receive, authenticate, and replay-protect pushed records.

## Decision Log

- 2026-05-15: Audited active specs, OpenSpec changes, design notes, and archived webhook/scheduler research. Decision: design-note only. Webhooks are not next for SLVP; scheduled/manual connector refresh remains the implementation-ready path.
- 2026-05-15: Promoted a narrow reference-only tranche to `openspec/changes/add-source-webhook-ingress`: signed source callback ingress, replay/idempotency guard, record-push mapping into existing ingest semantics, and run-trigger mapping as scheduler input only. Generic PDPP webhook/event-driven collection support remains deferred.

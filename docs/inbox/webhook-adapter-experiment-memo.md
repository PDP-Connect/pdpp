# Webhook-to-Pull Adapter Experiment: Findings

**Date:** 2026-04-12
**Artifact:** `reference-implementation/runtime/webhook-adapter.js`
**Status:** Experiment complete — push delivery fits as runtime architecture

---

## Bottom Line

Push delivery via webhooks fits cleanly as runtime/reference architecture. It does NOT warrant a companion spec today.

The adapter receives webhook POSTs from a cooperating platform and ingests records directly to the RS via `POST /v1/ingest/{stream}` with an owner token. This is the same ingest endpoint the connector runtime uses after receiving RECORD messages from a connector process. The RS treats webhook-ingested records identically to connector-ingested records: same field projection, same incremental sync, same revocation enforcement.

---

## What the experiment showed

**1. Did this fit cleanly as runtime/reference architecture?**

Yes. The adapter is a ~150-line HTTP server that:
- Receives webhook POST
- Validates signature (HMAC-SHA256, shared secret)
- Maps event type to PDPP stream name
- Transforms payload to RECORD format
- Calls `POST /v1/ingest/{stream}` with owner token
- Returns 200 on success

No Collection Profile machinery is involved. No START/DONE lifecycle, no binding matching, no INTERACTION protocol, no state checkpointing. The adapter is a thin translation layer between an external event format and the RS ingest endpoint.

**2. Did it expose a real interoperability contract?**

No — not yet. The webhook contract (event format, signature scheme, stream mapping) is between the cooperating platform and this specific adapter instance. It is NOT a contract between two independently-built PDPP implementations. Different adapters for different platforms will have different webhook formats.

**3. What would make push need a companion spec?**

A Push Delivery Profile becomes warranted when:
- A platform says "I will send PDPP-formatted records to any PDPP server" — then the webhook payload format, endpoint path, authentication, replay protection, and ordering become an interoperability surface.
- Multiple PDPP server implementations need to agree on how to receive pushed records.
- Neither condition is true today. No platform offers PDPP-formatted webhooks.

**4. What is the smallest profile boundary if one is ever needed?**

Define: (a) the webhook payload format (RECORD envelope over HTTP POST), (b) the endpoint path convention (e.g., `/v1/push/{connector_id}/{stream}`), (c) authentication (mutual TLS, bearer token, or HMAC), (d) replay protection (idempotency keys), (e) event ordering guarantees. Model after WebSub Section 4 + IETF SET push delivery (RFC 8935).

---

## Recommendation

Keep the webhook adapter as a reference runtime module. Do not draft a Push Profile. The interoperability test from the boundary note ("does it affect wire-level interop between independent implementations?") returns NO for the current state.

Revisit this if a platform announces PDPP-compatible webhook support.

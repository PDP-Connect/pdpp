# Webhook / Event-Subscription Envelope Standards Review

**Status:** Final — research only, no implementation  
**Owner:** Research worker (Gemini-audit follow-up)  
**Created:** 2026-06-11  
**Sources:**
- CloudEvents 1.0.2 spec — https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
- Standard Webhooks spec — https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- Standard Webhooks homepage — https://www.standardwebhooks.com/
- Stripe webhooks docs — https://stripe.com/docs/webhooks (fetched 2026-06-11)
- GitHub webhook events and payloads — https://docs.github.com/en/webhooks/webhook-events-and-payloads (fetched 2026-06-11)
- PDPP reference implementation source: `reference-implementation/server/client-event-delivery-worker.ts`, `reference-implementation/operations/rs-client-event-deliver/index.ts`, `reference-implementation/operations/as-client-event-subscriptions/index.ts`
- PDPP OpenSpec (archived): `openspec/changes/archive/2026-05-28-align-client-event-subscriptions-with-webhook-standards/` (all tasks checked)
- PDPP OpenSpec (archived): `openspec/changes/archive/2026-05-27-add-client-event-subscriptions/`
- PDPP OpenSpec prior art: `openspec/changes/archive/2026-05-27-add-client-event-subscriptions/design-notes/prior-art-2026-05-27.md`

---

## 1. Executive Summary

**The Gemini-audit questions are substantially answered already.** The `2026-05-28-align-client-event-subscriptions-with-webhook-standards` OpenSpec was fully implemented (all tasks checked) and archived. PDPP's current wire shape is CloudEvents 1.0 JSON structured mode + Standard Webhooks v1 signing — the two most interoperable choices in each category. No remediation is needed for the five audit questions.

The open research questions are:
1. Whether the thin-payload (hint-only) decision is well-justified vs an opt-in inline-data mode.
2. Whether the retry schedule and disable policy match ecosystem conventions closely enough.
3. Whether a future OpenSpec change should formalize these as a Core (cross-implementation) contract vs. continuing as a `reference_extension`.

---

## 2. PDPP Current State Inventory

### 2.1 Subscription Routes (Resource Server)

All routes live under `/v1/event-subscriptions` with client-bearer authorization, grant-scoped:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/event-subscriptions` | Create subscription |
| GET | `/v1/event-subscriptions` | List caller's subscriptions |
| GET | `/v1/event-subscriptions/:id` | Get one subscription |
| PATCH | `/v1/event-subscriptions/:id` | Toggle enabled / rotate secret |
| DELETE | `/v1/event-subscriptions/:id` | Tombstone subscription |
| POST | `/v1/event-subscriptions/:id/test-event` | Enqueue test event |

Operator-only `/_ref/event-subscriptions/:id/disable` also exists for dashboard use.

### 2.2 Envelope Shape (current as-built)

```json
{
  "specversion": "1.0",
  "pdppversion": "1",
  "id": "evt_…",
  "type": "pdpp.records.changed",
  "source": "/v1/event-subscriptions/sub_…",
  "time": "2026-05-27T15:00:00Z",
  "data": {
    "subscription_id": "sub_…",
    "stream": "messages",
    "changes_since": "<opaque cursor>",
    "change_count_hint": 1
  }
}
```

HTTP transport: `content-type: application/cloudevents+json; charset=utf-8` (CloudEvents JSON structured mode). No record bodies, field values, or resource identifiers outside the bound grant.

Source: `operations/as-client-event-subscriptions/index.ts` — `buildEventPayload()`, `CLOUDEVENTS_SPECVERSION = "1.0"`, `PDPP_EVENTS_PROFILE_VERSION = "1"`.

### 2.3 Signing (current as-built)

Standard Webhooks v1 HMAC-SHA256:

```
signed string = "{webhook-id}.{webhook-timestamp}.{raw body}"
webhook-signature = "v1,<base64(hmac_sha256(key, signed_string))>"
```

Headers on every delivery POST:
- `webhook-id`: stable event id (idempotency key)
- `webhook-timestamp`: unix seconds
- `webhook-signature`: `v1,<base64>` token(s) space-separated for rotation

Secret prefix: `whsec_<base64-of-32-random-bytes>`. Any off-the-shelf Standard Webhooks library verifies without PDPP-specific code.

Source: `operations/rs-client-event-deliver/index.ts` — `signEvent()`, `verifySignatureHeader()`, `DELIVERY_CONTENT_TYPE`.

### 2.4 Retry / Disable Policy (current as-built)

Backoff schedule (seconds): `[30, 120, 600, 3600, 21600, 86400]` — six attempts with jitter factor ±20%.

Outcome states:
- `pending_verification` → `active` (after successful handshake)
- `active` → `disabled_failure` (after 6th delivery failure; queue dropped)
- `active` → `disabled_revoked` (grant revoked; final `pdpp.grant.revoked` event attempted)
- `disabled_*` → `active` (client PATCH `enabled: true`)

Attempt log: all 6 attempts persisted with status code, latency, and bounded response snippet (≤512 bytes). Operator-visible via dashboard.

Source: `operations/rs-client-event-deliver/index.ts` — `DEFAULT_BACKOFF_SECONDS`, `executeDelivery()`.

### 2.5 Delivery Modes

**Hint-only (current, the only mode).** The `data` block carries:
- `subscription_id` — routing
- `stream` — which stream changed
- `changes_since` — opaque cursor positioned immediately before the notified change
- `change_count_hint` — advisory count

Receivers call `GET /v1/streams/{stream}/records?changes_since=<cursor>` to retrieve the actual changed records. No field values, record bodies, or resource identifiers transit the delivery wire.

**Inline-data mode (explicitly deferred, no spec.)** The OpenSpec design notes argue against it: the read API is the single enforcer of stream membership, view, field projection, time-range, tombstone, and cursor-expiry semantics. Inlining would require either (a) duplicating that enforcer in the delivery worker, or (b) calling `changes_since` at enqueue time, which breaks session-horizon anchoring for paginated reads.

### 2.6 Discovery Advertisement

`/.well-known/oauth-protected-resource` → `capabilities.client_event_subscriptions`:

```json
{
  "supported": true,
  "stability": "reference_extension",
  "endpoint": "/v1/event-subscriptions",
  "envelope": {
    "format": "cloudevents+json",
    "specversion": "1.0",
    "pdppversion": "1",
    "content_type": "application/cloudevents+json; charset=utf-8",
    "subscription_id_location": "data.subscription_id"
  },
  "signing": {
    "profile": "standard-webhooks",
    "algorithm": "HMAC-SHA256",
    "id_header": "webhook-id",
    "timestamp_header": "webhook-timestamp",
    "signature_header": "webhook-signature",
    "signed_payload": "{webhook-id}.{webhook-timestamp}.{body}",
    "signature_encoding": "v1,<base64>",
    "secret_prefix": "whsec_"
  }
}
```

---

## 3. Standards Reference

### 3.1 CloudEvents 1.0 (v1.0.2)

**Required attributes:** `specversion`, `id`, `source`, `type`.  
**Optional standard attributes:** `time`, `subject`, `datacontenttype`, `dataschema`.  
**Extension attributes:** custom, lowercase alphanumeric, ≤20 chars, no underscores.

**HTTP bindings (two modes):**
- **Structured mode** — entire event JSON in body; `content-type: application/cloudevents+json`. SDK-parseable from content-type alone.
- **Binary mode** — `data` raw in body; CloudEvents attributes as `ce-<name>` headers. Better for log inspection and webhook UIs that expect a recognizable JSON body.

**Dedupe rule (normative):** `source + id` uniquely identifies an occurrence.

**`specversion` rule:** `"1.0"` is the correct value for the 1.x family. Profile/extension versioning belongs in extension attributes or `type`, not in a forked `specversion` string like `"1.0-pdpp"`.

CloudEvents is an envelope spec, not a transport spec. It does not define signing, retry, or disable conventions.

### 3.2 Standard Webhooks

**Headers (required on every delivery):**
- `webhook-id` — stable unique message identifier, idempotency key
- `webhook-timestamp` — integer unix seconds
- `webhook-signature` — space-delimited list of `v1,<base64>` tokens (list supports zero-downtime rotation)

**Signing (symmetric, HMAC-SHA256):**
```
signed_string = "{webhook-id}.{webhook-timestamp}.{body}"
key = base64_decode(secret.removePrefix("whsec_"))
signature = hmac_sha256(key, signed_string)
header = "v1," + base64_encode(signature)
```
Key size: 24–64 bytes random. Secret prefix: `whsec_`.

**Asymmetric alternative:** ed25519 with `whsk_` / `whpk_` prefixes — out of scope for v1.

**Payload structure:**
- `type` — dot-delimited hierarchical type string
- `timestamp` — ISO 8601 occurrence time
- `data` — event-specific payload

**Thin vs full payload:** Standard Webhooks explicitly describes both. Recommends thin payloads for large datasets; notes the trade-off that thin payloads require a follow-up API call to retrieve the full resource. Payload size recommendation: <20 KB.

**Retry / disable conventions:**
- At-least-once; retry with exponential backoff + jitter over multiple days.
- Reference schedule: 0s, 5s, 5m, 30m, 2h, 5h, 10h, 14h, 20h, 24h (10 attempts, ~75 hours total).
- `2xx` = success; `3xx` = failure (no redirect following); `410 Gone` = auto-disable endpoint; `429` / `502` / `504` = throttle.
- `retry-after` header should be respected.
- After persistent failure: notify consumers via other channels AND disable future delivery.

**Idempotency:** Consumers MUST use `webhook-id` as idempotency key.

### 3.3 Stripe Webhooks

- **Envelope:** `{id, type, created, livemode, data: {object: {...}}}` — full snapshot of the changed resource at event time.
- **Signing:** `Stripe-Signature: t=<unix_ts>,v1=<hmac_hex>,...`. Signed over `"{t}.{body}"`. Multiple `v1=` tokens during rotation. Legacy `v0=` SHA-1 token also emitted (deprecated, do not ship for new systems).
- **Thin events (v2 API):** Strategic direction. `{type, object: "v2.event", related_object: {type, url}, reason}`. SDK `fetchRelatedObject()` retrieves current state. Aligns with PDPP's hint approach.
- **Retry:** Exponential, up to 3 days.
- **No specversion or CloudEvents fields** — Stripe predates CloudEvents and does not conform.

### 3.4 GitHub Webhooks

- **Headers:** `X-GitHub-Event`, `X-GitHub-Delivery` (GUID), `X-Hub-Signature-256: sha256=<hmac_hex>` (body only, no event-id in signed string), legacy `X-Hub-Signature` SHA-1 still emitted.
- **Payload:** Full JSON object, no envelope envelope wrapper — the payload IS the resource state at event time.
- **Retry:** No automatic retry. Operators must use the GitHub UI to redeliver.
- **No specversion or CloudEvents fields.**

---

## 4. Gap Matrix

### 4.1 `specversion`

| Dimension | PDPP (current) | CloudEvents 1.0 req | Status |
|-----------|----------------|---------------------|--------|
| `specversion` value | `"1.0"` | MUST be `"1.0"` for 1.x | **Compliant** |
| Profile versioning | `pdppversion: "1"` extension attribute | Extension attribute, lowercase alphanumeric | **Compliant** |
| Attribute naming guard | No top-level underscores; `subscription_id` in `data` | Lowercase alphanumeric, ≤20 chars | **Compliant** |
| `time` attribute | Standard `time` | Standard optional attribute | **Compliant** |

Historical note: rev1 shipped `specversion: "1.0-pdpp"` — a non-conformant fork that broke interoperability with Knative, EventBridge, Azure Event Grid, and Argo Events. The `align-with-webhook-standards` OpenSpec corrected this before any external consumers existed.

### 4.2 HTTP Headers

| Header | PDPP (current) | Standard Webhooks | GitHub | Stripe | Status |
|--------|----------------|-------------------|--------|--------|--------|
| `webhook-id` | Present | Required | `X-GitHub-Delivery` | Not sent | **SW-compliant** |
| `webhook-timestamp` | Present (unix seconds) | Required (unix seconds) | Not sent | `t=` in signature | **SW-compliant** |
| `webhook-signature` | `v1,<base64>` space-list | Required, space-list of `v1,` tokens | `sha256=<hex>` | `v1=<hex>` | **SW-compliant** |
| `content-type` | `application/cloudevents+json; charset=utf-8` | `application/json` (implied) | `application/json` | `application/json` | **CE-compliant, beyond SW** |

Historical note: rev1 used `PDPP-Event-Id`, `PDPP-Event-Timestamp`, `PDPP-Subscription-Id`, `PDPP-Event-Signature: sha256=<hex>` — bespoke, incompatible with any off-the-shelf library.

### 4.3 Signed Payload Shape

| Dimension | PDPP (current) | Standard Webhooks | Status |
|-----------|----------------|-------------------|--------|
| Signed string | `{webhook-id}.{webhook-timestamp}.{raw body}` | `{msg_id}.{timestamp}.{payload}` | **Compliant** |
| Key derivation | `base64_decode(secret.removePrefix("whsec_"))` | Same | **Compliant** |
| Encoding | `v1,<base64>` | `v1,<base64>` | **Compliant** |
| Rotation | Multiple space-separated tokens accepted in verify | Space-delimited list | **Compliant** |
| Timing-safe comparison | `timingSafeEqual` used | Recommended | **Compliant** |

Historical note: rev1 signed `"{ts}.{body}"` and encoded `sha256=<hex>` — omitting the event-id from the signed string allowed a captured `{ts}.{body}` to be replayed under a different event id within the timestamp tolerance window.

### 4.4 Retry / Disable Policy

| Dimension | PDPP (current) | Standard Webhooks recommendation | Status |
|-----------|----------------|----------------------------------|--------|
| Max attempts | 6 | 10 (recommendation, not requirement) | **Within spec, shorter** |
| Schedule | 30s, 2m, 10m, 1h, 6h, 24h | 0s, 5s, 5m, 30m, 2h, 5h, 10h, 14h, 20h, 24h | **Within spirit; PDPP = 31h total vs ~75h** |
| Jitter | ±20% on each step | Recommended | **Compliant** |
| After failure | `disabled_failure`; queue dropped; attempt log retained | Disable endpoint, notify via other channel | **Compliant (disable done; out-of-band notification not shipped)** |
| Client re-enable | PATCH `enabled: true` | Not specified | **Beyond spec** |
| `410 Gone` auto-disable | Not implemented | Recommended | **Gap (P3)** |
| `429` / `502` / `504` throttle | Not differentiated (all non-2xx = failure) | Throttle vs. fail distinction | **Gap (P3)** |
| `retry-after` header | Not inspected | Should respect | **Gap (P3)** |
| Attempt log | All 6 attempts with status/latency/snippet | Not specified | **Beyond spec** |
| Grant-revoke auto-disable | `disabled_revoked` | Not in SW (PDPP-specific) | **Beyond spec** |

### 4.5 Payload Delivery Mode: Thin Pointer vs Inline Data

| Dimension | PDPP (current) | Standard Webhooks guidance | Stripe (v2) analogy | Status |
|-----------|----------------|---------------------------|---------------------|--------|
| Mode | Hint-only (thin pointer) | Thin or full — explicit tradeoff described | Thin events = strategic direction | **Best practice alignment** |
| What's in the hint | `stream`, `changes_since`, `change_count_hint`, `subscription_id` | Identifiers + metadata about the change | `type`, `related_object.url` | **Compliant and well-reasoned** |
| Why not inline | Read API is sole enforcer of grant scope, projections, tombstones, cursor-expiry | Payload should not need duplication of business rules | SDK re-fetches current state | **Strong rationale** |
| Inline opt-in | Not available; explicitly deferred | Not prohibited | N/A | **Gap? (see §5.3)** |

---

## 5. Analysis and Findings

### 5.1 Current Compliance Summary

PDPP's current wire shape fully satisfies the five Gemini-audit questions:

1. **`specversion`:** `"1.0"` — correct CloudEvents 1.x value; PDPP profile version travels in `pdppversion` extension attribute, not by forking `specversion`.
2. **Header names:** `webhook-id`, `webhook-timestamp`, `webhook-signature` — exact Standard Webhooks header names; no `PDPP-*` headers remain.
3. **Signed payload shape:** `{webhook-id}.{webhook-timestamp}.{body}` keyed by `base64_decode(whsec_…)`, emitted `v1,<base64>` — byte-identical to Standard Webhooks v1.
4. **Retry/disable policy:** Six-attempt exponential backoff with jitter; `disabled_failure` state with operator-visible attempt log; PATCH re-enable — satisfies Standard Webhooks' MUST requirements; slightly shorter total window (31h vs. recommended 75h) and three minor gaps (410 auto-disable, 429/5xx throttle, retry-after) that are P3.
5. **Payload delivery mode:** Hint-only (thin pointer) is an intentional, well-documented choice. Standard Webhooks explicitly describes this approach and notes it is appropriate when payload data is available via a follow-up API call. The `changes_since` cursor makes that follow-up self-contained and grant-scoped.

The changes needed to get from rev1 to the current state were done, documented, and archived in `2026-05-28-align-client-event-subscriptions-with-webhook-standards`.

### 5.2 Thin-Payload Alignment with Data Minimization

PDPP's thin-pointer mode is not merely a performance optimization — it is a data-minimization requirement in disguise. Arguments for this as the correct permanent architecture:

**Grant scope enforcement is centralized.** The read API (`GET /v1/streams/{s}/records`) is the single choke point for grant-scoped projection, stream membership checks, view filtering, field-capability enforcement, tombstone handling, and cursor-expiry semantics. Inlining record data in the delivery worker would require duplicating this enforcement logic or importing the full read pipeline into an async background process, both of which create a second enforcement point that can drift.

**Skinny events minimize PII surface.** A financial personal-data system like PDPP (bank accounts, transaction history, statements) has a significant PII exposure surface. The hint envelope carries no PII: it carries a stream name (a schema concept), an opaque cursor (an implementation detail), and a subscription ID (a routing key). A full-payload event would carry financial record data — account numbers, transaction amounts, merchant names — in signed HTTP POST bodies sent to arbitrary consumer endpoints. The `changes_since` cursor model keeps PII exclusively in responses to authenticated `GET` requests, where TLS, grant validation, field projection, and audit logging are applied uniformly.

**Alignment with Plaid, Google, and MCP:** Plaid webhooks carry pure identifiers (`item_id`, `account_id`, `transaction_id`) and route receivers to the Plaid read API. Google push notifications carry a `resourceId` and `resourceUri`. MCP `notifications/resources/updated` carries a URI. These are production systems processing sensitive data at scale. The common pattern: the notification proves an event happened and provides a cursor/handle; the read API delivers the data under full authorization.

**Stripe thin events (v2) as leading-edge validation.** Stripe is converging toward the same pattern with their `fetchRelatedObject()` SDK method on thin events. The difference is that Stripe ships both full and thin modes for backward compatibility — a burden PDPP has not yet accumulated and should avoid accumulating.

### 5.3 Inline-Data Mode: The Case For and Against

The OpenSpec design notes explicitly rejected inline-data mode for this tranche. The research confirms this is the right call for a v1, but the question of whether an opt-in inline mode should ever be offered deserves examination.

**Arguments for an opt-in inline mode:**
- Reduces latency for simple receivers that only care about one or two fields (e.g., "is this transaction a debit > $1000?")
- Standard Webhooks describes full payloads as a legitimate choice
- Some AI agent patterns benefit from not needing a second HTTP call (context window economy)

**Arguments against (and why they win):**
- The inline enforcer problem remains regardless of whether the mode is opt-in: the delivery worker must either import the full read pipeline or re-implement projection logic.
- Signed large bodies are operationally hazardous. The Standard Webhooks spec recommends payloads <20KB; a PDPP `changes_since` read for a busy stream can return many records. Signing a variable-size paginated payload has no clean boundary.
- Encryption-at-rest implications are not trivially satisfied. The delivery worker would serialize financial record data to the `client_event_queue` table; that table currently holds only routing metadata and cursors.
- The receiver side's `changes_since` call is already one HTTP request. The marginal cost is low for any non-trivial receiver.

**Verdict on inline mode:** Defer indefinitely. If ever introduced, it requires its own OpenSpec change covering: projection equivalence with `rs.records.list`, signing of large/paginated bodies, queue storage implications, and grant-scope enforcement audit. The thin pointer is the right permanent default, not just a v1 simplification.

---

## 6. Three Minor Open Gaps (P3, no immediate action needed)

These are gaps between PDPP's current implementation and Standard Webhooks guidance. None break interoperability; all are refinements.

### 6.1 `410 Gone` Auto-Disable (P3)

Standard Webhooks recommends: if the receiver responds `410 Gone`, the sender SHOULD disable the endpoint without further retries. PDPP currently treats all non-2xx responses uniformly (retry until max attempts, then `disabled_failure`).

Impact: a receiver that has deliberately shut down its endpoint will receive up to 5 more delivery attempts (31h total) before PDPP stops. Low impact because the client controls the subscription and can DELETE it.

Suggested fix: in `executeDelivery()`, classify `410` as a `permanent_failure` outcome that triggers `disabled_failure` immediately rather than scheduling a retry.

### 6.2 `429` / `502` / `504` Differentiated Throttle (P3)

Standard Webhooks recommends throttling (not failing) on `429 Too Many Requests`, `502 Bad Gateway`, and `504 Gateway Timeout`. PDPP's current `isHttp2xx` branch treats all non-2xx as equivalent failures that consume a retry slot.

Impact: a receiver experiencing a transient load spike would burn all 6 retry slots within 31 hours. A throttle-aware path would reset the backoff on `429`/`502`/`504` instead of incrementing `attemptCount`.

Suggested fix: introduce a `throttle` outcome kind that resets `nextAttemptAt` based on `retry-after` header (or a fixed 60s default) but does NOT increment `attemptCount`.

### 6.3 `retry-after` Header Inspection (P3)

Standard Webhooks SHOULD inspect `retry-after` when present. Currently ignored. Fix is straightforward: parse the header in `executeDelivery()` and use its value as `nextAttemptAt` when the outcome is `throttle`.

---

## 7. Recommendation

### 7.1 Short Term (no OpenSpec needed)

**Accept the current state.** The five Gemini-audit questions are fully resolved. The `align-with-webhook-standards` change implemented and archived the correct solution. No further work is needed on `specversion`, headers, signed payload shape, or thin vs inline.

The three P3 gaps (§6) are worth a future one-off fix commit — they do not need an OpenSpec because they are implementation refinements, not contract changes.

### 7.2 Medium Term: Promote to a Core PDPP Contract

**Motivation.** The capability is currently advertised as `stability: "reference_extension"` with `scope: "reference_implementation"`. This means the envelope and signing are not a cross-implementation contract. If PDPP gains other reference implementations or if Core clients begin depending on event subscriptions, the lack of a Core contract becomes a liability.

**What a Core promotion would specify:**
- The CloudEvents 1.0 JSON structured mode envelope shape (required attributes, `pdppversion` extension, `data.*` hint fields, `changes_since` cursor).
- The Standard Webhooks v1 signing profile as the mandatory signing scheme.
- The subscription CRUD surface (`/v1/event-subscriptions`) as a Core endpoint.
- The verification handshake (challenge/response before record-driven events).
- The retry and disable lifecycle states (`pending_verification`, `active`, `disabled_failure`, `disabled_revoked`).

**Migration cost:** Low. The reference implementation already implements all of this. A Core promotion is primarily a documentation and spec-layer change, not a code change.

**OpenSpec outline for a promotion change:**

```
openspec/changes/promote-client-event-subscriptions-to-core/
  proposal.md   — why, business rationale, stability upgrade
  design.md     — no behavior changes; spec layer promotion; Core spec additions
  tasks.md      — update spec-core.md §event-subscriptions; update capability
                  stability to "core"; update discovery doc schema; remove
                  "reference_implementation" scope annotation; add P3 gap fixes
                  as sub-tasks; openspec validate --all --strict
  specs/
    reference-implementation-architecture/spec.md
      — MODIFIED: remove reference_extension/reference_implementation annotations;
        confirm all existing scenarios pass without change
```

**Prerequisite:** At least one successful production use of the event-subscription surface by a client that is not the reference e2e test (proves the wire shape is stable enough to freeze).

### 7.3 Thin vs Inline: Definitive Recommendation

**Never ship inline-data mode by default.** The thin-pointer model is the correct permanent architecture for a grant-scoped personal-data platform. The hint + `changes_since` cursor already provides a self-contained fetch path; the marginal cost to the receiver is negligible; and avoiding inline mode eliminates a class of grant-scope enforcement drift and PII-in-queue risks permanently.

**If a future opt-in inline mode is ever warranted**, it requires a separate OpenSpec change with the following mandatory acceptance checks:
1. Projection equivalence: inline payload MUST be byte-equivalent to the result of `GET /v1/streams/{s}/records?changes_since=<cursor>` for the same change.
2. Signed body boundary: the entire inline payload (including any pagination wrapper) MUST be included in the Standard Webhooks signed string.
3. Queue storage encryption: the `client_event_queue.payload_json` column MUST be encrypted at rest if it contains record field values (it currently does not).
4. Token budget: the inline payload size MUST be capped (suggested 20KB per Standard Webhooks guidance) and the receiver MUST be notified when the cap is reached (fall back to hint-only for that delivery).

---

## 8. Gap Matrix Summary Table

| Audit Question | PDPP Current | Standard | Status | Action Needed |
|---------------|--------------|----------|--------|---------------|
| `specversion` value | `"1.0"` | `"1.0"` | Compliant | None |
| Profile versioning method | `pdppversion` extension attr | Extension attr, lowercase | Compliant | None |
| Header names | `webhook-id`, `webhook-timestamp`, `webhook-signature` | Same | Compliant | None |
| Signed string construction | `{id}.{ts}.{body}` | `{id}.{ts}.{body}` | Compliant | None |
| Signature encoding | `v1,<base64>` | `v1,<base64>` | Compliant | None |
| Secret prefix/format | `whsec_<base64>` | `whsec_<base64>` | Compliant | None |
| Secret rotation | Space-list, verify any | Space-list | Compliant | None |
| Retry schedule | 6 attempts, 31h total | 10 attempts, 75h recommended | Within spec | P3 if extended |
| `410` auto-disable | Not implemented | Recommended | P3 gap | One-off fix |
| `429`/`5xx` throttle | Not differentiated | Recommended | P3 gap | One-off fix |
| `retry-after` respect | Not inspected | Recommended | P3 gap | One-off fix |
| Thin vs inline | Hint-only (cursor) | Both described; thin = best practice | Best practice | None (defer inline indefinitely) |
| Envelope content type | `application/cloudevents+json` | `application/json` (implied) | Beyond spec | None |
| Discovery advertisement | Full capability at `/.well-known/oauth-protected-resource` | Not specified by SW | Beyond spec | None |
| Grant-revoke auto-disable | `disabled_revoked` + final event | Not specified | Beyond spec | None |

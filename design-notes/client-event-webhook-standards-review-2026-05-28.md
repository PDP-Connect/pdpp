# Client Event Webhook Standards Review

Status: decided-defer
Owner: reference implementation owner
Created: 2026-05-28
Updated: 2026-05-28
Related: `design-notes/external-gemini-flash-promises-audit-triage-2026-05-28.md`, `design-notes/prior-art/slvp-client-event-subscriptions-prior-art-2026-05-27.md`, `design-notes/client-event-subscriptions-and-freshness-2026-04-26.md`, `openspec/changes/archive/2026-05-28-align-client-event-subscriptions-with-webhook-standards`, `openspec/specs/reference-implementation-architecture/spec.md`

## Question

Is the reference implementation's client event-subscription / webhook envelope
and management contract already the 95%+ SLVP-ideal shape, or does it need an
owner-level standards review against CloudEvents 1.0 and Standard Webhooks
before it can be declared SLVP-ideal?

The external Gemini Flash audit triage (2026-05-28) preserved this as a real
follow-up: "Webhook/event-subscription envelope standards need owner-level
review against CloudEvents and Standard Webhooks before declaring the event
system SLVP-ideal. The specific questions are `specversion`, header names,
signed payload shape, retry/disable policy, and whether payload delivery modes
are event pointers, inline data, or both."

## Context

This note is the verification pass that the triage asked for. It was produced by
independently reading current code, tests, and merged OpenSpec - not by trusting
prior agents' summaries.

Finding: the owner-level standards review the triage asked for already happened
and shipped. The triage item was stale on this point. The questions it lists
were each decided in an owner-reviewed OpenSpec change that is now archived:
`2026-05-28-align-client-event-subscriptions-with-webhook-standards` (built on
rev1, `2026-05-27-add-client-event-subscriptions`). The rev1 envelope and
signing scheme that the Gemini history reflected were corrected the same day
the triage was written.

### Current-code facts (verified 2026-05-28, branch `workstream/ri-webhook-standards-review`)

Envelope - `reference-implementation/operations/as-client-event-subscriptions/index.ts:276` (`buildEventPayload`):

- CloudEvents 1.0 JSON **structured mode**. `specversion: "1.0"`, PDPP profile
  version travels in the `pdppversion: "1"` CloudEvents extension attribute.
- Top-level keys are CloudEvents context attributes only (`id`, `type`,
  `source`, `time`); PDPP fields live in `data` (no underscores at top level, so
  the envelope is literally CloudEvents-conformant).
- `source` is the dereferenceable `/v1/event-subscriptions/<sub>`; the same id
  is mirrored in `data.subscription_id`.
- Content type `application/cloudevents+json; charset=utf-8`.
- Event types: `pdpp.records.changed`, `pdpp.subscription.verify`,
  `pdpp.subscription.test`, `pdpp.grant.revoked`
  (`reference-implementation/operations/rs-client-event-derive/index.ts:50`).

Signing/headers - `reference-implementation/operations/rs-client-event-deliver/index.ts`:

- Standard Webhooks v1: `webhook-id`, `webhook-timestamp`,
  `webhook-signature: v1,<base64(HMAC-SHA256(key, "{id}.{ts}.{body}"))>`.
  The event id is part of the signed string (defeats cross-event replay).
- Per-subscription secret `whsec_<base64-32-bytes>` (not the bearer client
  token); SHA-256 hash stored, raw secret returned once on create.
- Rotation: verifier accepts any space-separated `v1,<sig>` token.

Retry/disable - `rs-client-event-deliver/index.ts:29` + `server/client-event-delivery-worker.ts`:

- Exponential backoff with 80-120% jitter, 6 stages
  `[30, 120, 600, 3600, 21600, 86400]` (30 s to 1 day).
- Outcomes: `delivered`, `verified`, `retry`, `final_failure`.
- After max attempts the subscription transitions to `disabled_failure`
  (`as-client-event-subscriptions/index.ts`); grant revoke ->
  `disabled_revoked`; states: `pending_verification`, `active`, `disabled`,
  `disabled_failure`, `disabled_revoked`, `deleted`.
- Verification handshake: a `subscription.verify` event must be echoed with the
  matching `challenge` to move `pending_verification` to `active`.

Payload mode - hint-only, grant-scoped. `data` carries `stream`,
`changes_since` (opaque cursor), `change_count_hint`; the e2e test asserts no
`record` / `record_json` body. Clients re-fetch through the grant-scoped read
API.

Management surfaces (all present, all grant-scoped):

- Client REST: `POST/GET/PATCH/DELETE /v1/event-subscriptions[/:id]`,
  `POST /v1/event-subscriptions/:id/test-event`.
- Operator REST: `GET /_ref/event-subscriptions[/:id]`,
  `POST /_ref/event-subscriptions/:id/disable` (safety valve; secrets never
  returned on `/_ref`).
- CLI: `pdpp ref event-subscriptions list|show|disable`
  (`packages/cli/src/ref/commands/event-subscriptions.js`).
- MCP: `create/list/get/update/delete_event_subscription`, `send_test_event`,
  `discover_event_subscription_capabilities`
  (`packages/mcp-server/src/tools.js`).
- Dashboard: `apps/console/src/app/dashboard/event-subscriptions/`.
- Discovery: advertised in `/.well-known/oauth-protected-resource` as a
  `client_event_subscriptions` RI extension with `stability:
  "reference_extension"`, naming the CloudEvents and Standard Webhooks profiles.

Spec state: the normative contract is **merged** into
`openspec/specs/reference-implementation-architecture/spec.md` (around lines
1495-1600 client surface; 2033+ operator disable; 2897+ MCP tools). It is a
`reference_extension`, not PDPP Core.

## Stakes

Reopening a settled, merged, tested standards decision as fresh design work
would add noise and re-litigate tone, exactly the failure mode the Gemini triage
note itself warns about. The correct move is to record that the review is done,
cite the evidence, and isolate the genuine residual deltas so they are not lost.

## Current Leaning

The shipped contract **is** the 95%+ SLVP-ideal shape. No implementation is
warranted in this lane. Each triage question is answered by merged code+spec:

| Triage question | Decision (shipped) |
|---|---|
| `specversion` | `"1.0"` (CloudEvents), profile in `pdppversion: "1"` extension |
| Header names | Standard Webhooks `webhook-id` / `webhook-timestamp` / `webhook-signature` |
| Signed payload shape | `v1,base64(HMAC-SHA256(key, "{id}.{ts}.{body}"))`, `whsec_` per-sub secret |
| Retry/disable policy | 6-stage jittered backoff to `disabled_failure`; revoke to `disabled_revoked` |
| Payload mode | Hint-only, grant-scoped (event + opaque `changes_since` + count); client re-fetches |
| Core vs reference | `reference_extension`, not Core |

Strongest counterargument: the 2026-05-27 prior-art note recommended CloudEvents
**binary** HTTP binding (`ce-*` headers, body = data) with **high** confidence;
the shipped contract uses **structured** mode. The alignment change's `design.md`
addresses this directly and defers binary as a non-goal: structured-mode JSON is
still literally CloudEvents 1.0 conformant, the only in-tree receiver parses the
structured body today, and the binary/structured trade-off deserves its own
change "once a receiver case actually needs `ce-*` headers (e.g., a
Knative-native consumer)." That reasoning holds - there is no out-of-tree
receiver, so binary would be speculative coupling. The deferral is sound, not a
gap.

### Genuine residual deltas (deferred, not bugs)

These prior-art v1 recommendations are not implemented. They are correctly out
of scope for the standards-alignment tranche but should not be silently lost:

1. **Subscription lifecycle events / expiry.** Prior art (High confidence)
   recommended `expires_at` at or before grant TTL and a `subscription.expiring` event
   (Stripe/Graph/Google channel-expiry pattern). The shipped subscription has no
   `expires_at` and emits no expiring event; lifecycle today is verify to active
   to disabled. For autonomous AI clients this is the most load-bearing gap:
   a subscription whose grant lapses goes silent rather than signalling.
2. **Catch-up / replay endpoint.** Prior art recommended
   `GET /v1/event-subscriptions/:id/events?since=<cursor>` so a reconnecting or
   briefly-down receiver can replay missed events (the explicit fix for MCP's
   missed-notification gap). Not implemented; a receiver that misses the
   delivery + 6 retries over ~28 h loses the hint. The opaque `changes_since`
   cursor in each event partially mitigates this (a client that ever sees one
   later event can still pull all changes), but there is no event-stream
   catch-up.
3. **SSE pull-mode** for clients that cannot expose a public HTTPS endpoint
   (mobile/desktop/agentic). Prior art already rated this v1.1/v2 and the
   deferral is correct; recording for completeness.
4. **Cursor type.** Shipped cursor is an opaque `changes_since` string reusing
   the read API's cursor, not the prior-art's monotonic `uint64`. Opaque is
   defensible (single source of truth with the read contract) and is **not** a
   delta worth closing.

Of these, only (1) and (2) are candidate future tranches; (3) and (4) are
already-correct calls.

## Promotion Trigger

Promote to an OpenSpec change before implementing subscription expiry/lifecycle
events (1) or a catch-up/replay endpoint (2): both add a durable wire contract
(new event `type`, new subscription field, or new client-facing endpoint). Do
not fold them into a connector or read-plane lane. Until a concrete client need
surfaces, they stay deferred here.

## Decision Log

- 2026-05-28: Verified the client event webhook envelope, signing, retry/disable
  policy, payload mode, and management surfaces against current code, tests, and
  merged OpenSpec. Conclusion: the SLVP standards review the Gemini triage asked
  for is already done and merged (CloudEvents 1.0 structured mode + Standard
  Webhooks, hint-only grant-scoped payloads, `reference_extension`). No
  implementation warranted. Closing the triage's webhook follow-up as
  decided-defer. Recorded two genuine residual deltas (subscription
  expiry/lifecycle events; catch-up/replay endpoint) as future OpenSpec
  candidates. Note: `reference-implementation/test/client-event-subscriptions-e2e.test.js`
  has one failing assertion (line 315, `404 !== 200`) on the downstream
  `/v1/streams/:stream/records?changes_since=` read, not on webhook delivery -
  the webhook envelope/signature/hint assertions in that same test pass. The
  failure is in the read-contract / route-family area (out of this lane, active
  work) and is identical to baseline `main` (no webhook-code diff vs `main`).

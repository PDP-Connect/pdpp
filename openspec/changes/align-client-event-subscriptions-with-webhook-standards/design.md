## Context

`design-notes/prior-art/slvp-client-event-subscriptions-prior-art-2026-05-27.md` recommended "CloudEvents 1.0 binary HTTP binding" and "separate per-subscription HMAC secret (Stripe model)" with **high** confidence. The shipped rev1 envelope and signing scheme deviate from that recommendation in two ways that are not load-bearing for any PDPP-specific constraint:

1. `specversion: "1.0-pdpp"`. CloudEvents §required-attributes constrains `specversion` to identify the **CloudEvents specification version**, not the producer's profile. The CNCF-maintained validators, libraries (`@cloudevents/sdk`, `cloudevents-go`, `cloudevents-python`), and event-mesh integrations (Knative, Argo Events, EventBridge schema registry, Azure Event Grid) all reject envelopes whose `specversion` is anything but `"1.0"` for the 1.x family. CloudEvents §extension-context-attributes is the documented surface for producer-specific versioning; we use it via a `pdppversion` extension attribute.
2. `PDPP-Event-*` headers and `sha256=<hex>` signature encoding. Standard Webhooks (https://www.standardwebhooks.com) defines an interoperable signing profile that off-the-shelf libraries implement: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` signed as `HMAC-SHA256(secret, "{id}.{ts}.{body}")` against a `whsec_`-prefixed base64 key. The differences from the rev1 scheme are cosmetic (header names, signature encoding) and one substantive (the event id is part of the signed string, defeating a class of cross-event replay attacks where a captured `{ts}.{body}` could be replayed under a different event id).

The rev1 archive (`2026-05-27-add-client-event-subscriptions`) shipped today. The only consumer in the repository is `reference-implementation/test/client-event-subscriptions-e2e.test.js`. No external clients exist. Aligning now costs one change-day; aligning later costs a deprecation cycle that we explicitly do not need.

## Goals

- The reference's outbound event delivery is CloudEvents 1.0 conformant by construction.
- Receivers can verify deliveries with any off-the-shelf Standard Webhooks library without PDPP-specific code.
- The discovery document (`/.well-known/oauth-protected-resource`) names the standards a receiver should reach for.
- The change does not perturb any non-envelope/non-signing behavior: hint-only payloads, per-subscription secrets, grant scoping, verification handshake, retry/dead-letter semantics, Postgres parity, all stand.

## Non-goals

- Migrating to CloudEvents **binary HTTP binding** (the prior-art recommendation). Structured-mode JSON is what rev1 ships and it remains CloudEvents 1.0 conformant. A future change can promote the binary binding when there is a receiver case that needs `ce-*` headers (e.g., a Knative-native consumer).
- Carrying both header schemes for a compatibility window. See "No dual-emit" below.
- Promoting `client_event_subscriptions` from `reference_extension` to a Core PDPP capability. That requires its own change.

## Envelope decision: CloudEvents 1.0 with `pdppversion` extension

```json
{
  "specversion": "1.0",
  "pdppversion": "1",
  "id": "evt_…",
  "type": "pdpp.records.changed",
  "source": "/v1/event-subscriptions/sub_…",
  "subscription_id": "sub_…",
  "occurred_at": "2026-05-27T15:00:00Z",
  "data": {
    "stream": "messages",
    "changes_since": "<opaque cursor>",
    "change_count_hint": 1
  }
}
```

`pdppversion` is a CloudEvents extension attribute (lowercase, alphanumeric, ≤ 20 chars — `pdppversion` satisfies §extension-context-attributes-naming-conventions). The value `"1"` represents the PDPP event-subscription profile version that owns the meaning of `type`, `subscription_id`, `occurred_at`, and `data.*` shape. The PDPP profile evolves independently of CloudEvents `specversion`.

`subscription_id` and `occurred_at` are not CloudEvents standard attributes — they were chosen because the rev1 envelope already had them, no receivers depend on their CloudEvents-attribute status, and rewording them as `subject` (`subscription_id`) and `time` (`occurred_at`) is a separate question whose answer should follow whether we eventually move to the binary HTTP binding. Recording the question; not solving it here.

## Signing decision: Standard Webhooks v1

```
webhook-id:        evt_…
webhook-timestamp: 1748358000
webhook-signature: v1,<base64(hmac_sha256(decode(whsec_…), "{id}.{ts}.{body}"))>
```

Properties:

- The signed string includes the event id. A captured `{ts}.{body}` from one event cannot be replayed as a different event id, even within the timestamp tolerance window.
- The secret is `whsec_<base64-of-32-random-bytes>`. The `whsec_` prefix is the Standard Webhooks convention; receivers that use any compliant library will base64-decode the suffix to obtain the HMAC key. The reference also accepts an unprefixed UTF-8 secret as a compatibility shim for tests that mint synthetic secrets directly.
- Header order: lowercase, hyphenated. HTTP/1.1 and HTTP/2 are case-insensitive but Standard Webhooks libraries expect the literal lowercase forms — emitting them lowercased reduces friction.
- Rotation: the receiver-side verifier accepts any space-separated `v1,<sig>` token, mirroring Standard Webhooks' rotation guidance.

## No dual-emit

The rev1 archive shipped 2026-05-27. The only callers exercising the wire are inside this repo. Dual-emitting both header schemes would:

- Increase header size on every delivery by ~120 bytes for no real receiver benefit;
- Force receivers that adopt either scheme to deal with both for the rest of time once one example in the wild reaches for one and one reaches for the other;
- Conceal the wire change behind a header alias — a "polite cruft" pattern that the project's standing principle ("Good Construction Before Feature Lists") explicitly rejects.

If a real out-of-tree client surfaces after this change lands, we add the compat shim under that named pressure, not preemptively.

## Alternatives considered

- **Leave it.** The rev1 surface is internally self-consistent. Rejected because the SLVP claim depends on real interop with CloudEvents 1.0 and Standard Webhooks ecosystems; a forked `specversion` makes both claims literally false.
- **Adopt CloudEvents binary HTTP binding now.** Cleanest CloudEvents posture (`ce-*` headers + body = data). Rejected as out of scope for this tranche — the structured-mode body the existing receiver code parses today still validates as CloudEvents 1.0, and the structured/binary trade-off deserves its own decision once a receiver case actually needs binary.
- **Custom `PDPP-Event-*` headers but with `specversion: "1.0"`.** Half-measure that fixes the literal CloudEvents-conformance defect but leaves PDPP shipping a bespoke signing scheme when a standard with multi-language library support already exists. Rejected.
- **`signature_encoding: "sha256=<hex>"` like GitHub.** GitHub's scheme has reach but uses raw secrets and does not include the event id in the signed string, so it carries the same replay surface as the rev1 scheme. Standard Webhooks is strictly better and is the active SLVP-direction convention.

## Acceptance Checks

- `openspec validate align-client-event-subscriptions-with-webhook-standards --strict`
- `openspec validate --all --strict`
- Operation tests (`reference-implementation/test/rs-client-event-deliver-operation.test.js`) cover: signature construction matches the Standard Webhooks `{id}.{ts}.{body}` canonical form; the delivery worker emits `webhook-id`, `webhook-timestamp`, `webhook-signature` and emits no `PDPP-Event-*` headers; rotated headers carrying multiple `v1,` tokens still verify.
- Subscription-create tests (`reference-implementation/test/as-client-event-subscriptions-operation.test.js`) cover: the issued secret carries the `whsec_` prefix; the persisted envelope carries `specversion: "1.0"` and `pdppversion: "1"`.
- End-to-end test (`reference-implementation/test/client-event-subscriptions-e2e.test.js`) verifies deliveries with both the in-tree helper and an independent recompute of the Standard Webhooks signature.
- Discovery test verifies the capability advertisement publishes the Standard Webhooks profile names and CloudEvents 1.0 envelope.

## Residual Risks

- `pdppversion` is an extension attribute name we own; a future CloudEvents revision that reserves the same name would force a rename. Mitigation: CNCF reserves only attributes added to the spec body, and `pdppversion` is sufficiently producer-namespaced that collision is unlikely. Recording the risk; no mitigation needed today.
- Standard Webhooks is a community spec, not an IETF RFC. The library matrix is large but the governance is lighter than an RFC. The signing construction is simple enough that PDPP can pin to the current v1 indefinitely even if upstream evolves.
- Receivers built against the rev1 scheme between archive (2026-05-27) and this change will need a one-line wire change. No such receivers are known; the e2e test is the only one in tree and is migrated in this change.
- The reference also accepts a UTF-8 secret without the `whsec_` prefix as an HMAC key. This is a test-only compatibility shim. Production-issued secrets always carry the prefix; tampering with a stored secret to drop the prefix would degrade interop with off-the-shelf libraries but does not weaken the cryptographic property of the signature.

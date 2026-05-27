## Why

The just-archived `2026-05-27-add-client-event-subscriptions` change introduced an outbound client-event surface whose envelope and signing scheme do not match the prior-art SLVP recommendation it cites:

- The envelope sets `specversion: "1.0-pdpp"` — a fork of CloudEvents 1.0. The CloudEvents 1.0 specification reserves `specversion: "1.0"` for the 1.x family; profile/extension versioning belongs in CloudEvents extension attributes, the event `type`, or `dataschema`. Forking `specversion` breaks the interoperability story (Knative, EventBridge, Argo Events, Azure Event Grid) the prior-art note explicitly used to justify CloudEvents.
- The delivery signing uses bespoke `PDPP-Event-*` headers and a `sha256=<hex>` encoding. Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`; signing `{id}.{ts}.{body}` keyed by a `whsec_`-prefixed secret) is the live ecosystem convention with off-the-shelf libraries across Node, Python, Go, Rust, Java, and PHP. The PDPP scheme is byte-equivalent HMAC-SHA256 but trivially incompatible.

The reference's first real receiver is its own e2e test; there are no third-party clients depending on the rev1 wire shape. Aligning now is cheap, prevents a one-day-old custom scheme from becoming a load-bearing migration surface, and preserves the SLVP claim that PDPP composes with established standards instead of forking them.

## What Changes

- Set the CloudEvents envelope `specversion` to `"1.0"` (CloudEvents 1.0 conformant). Carry the PDPP profile version in the `pdppversion` CloudEvents extension attribute. Keep the existing JSON body shape (CloudEvents structured-mode).
- Replace `PDPP-Event-Timestamp` / `PDPP-Event-Id` / `PDPP-Subscription-Id` / `PDPP-Event-Signature` with Standard Webhooks headers `webhook-id`, `webhook-timestamp`, `webhook-signature`. Drop the `PDPP-Subscription-Id` header entirely — the subscription id already appears in the envelope `subscription_id` field and is recoverable from the `source` URL.
- Replace the signing construction `{ts}.{body}` with the Standard Webhooks construction `{webhook-id}.{webhook-timestamp}.{body}`. Encode the signature as `v1,<base64>` (Standard Webhooks v1 scheme) instead of `sha256=<hex>`.
- Rename the per-subscription secret prefix from `pess_` to `whsec_` and treat the bytes following the prefix as a base64-encoded HMAC key, so off-the-shelf Standard Webhooks libraries verify deliveries unchanged.
- Update the `client_event_subscriptions` capability advertisement at `/.well-known/oauth-protected-resource` to declare `envelope.specversion: "1.0"`, `envelope.pdppversion: "1"`, `envelope.format: "cloudevents+json"`, `signing.profile: "standard-webhooks"`, `signing.id_header`, `signing.timestamp_header`, `signing.signature_header`, `signing.signed_payload: "{webhook-id}.{webhook-timestamp}.{body}"`, `signing.signature_encoding: "v1,<base64>"`, and `signing.secret_prefix: "whsec_"`.
- Do not dual-emit the legacy `PDPP-Event-*` headers. The rev1 surface shipped today and has no external consumers; carrying both schemes would create cruft from day one and conceal the wire change behind a compatibility shim.

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None

Removed:

- None

## Impact

- Affected code: `reference-implementation/operations/rs-client-event-deliver/index.ts` (signing primitives + delivery headers), `reference-implementation/operations/as-client-event-subscriptions/index.ts` (envelope writer factored to `buildEventPayload`, secret prefix), `reference-implementation/server/index.js` (delete inline envelope; import `buildEventPayload`), `reference-implementation/server/metadata.ts` (`buildClientEventSubscriptionsCapability` advertisement shape), affected tests under `reference-implementation/test/`.
- Affected behavior: any client implementing the rev1 wire shape from a freshly-built worktree would need to switch to Standard Webhooks header names and the CloudEvents 1.0 `specversion`. No external clients are known; the reference e2e test is the only consumer in tree and is updated in this change.
- Protocol impact: none for Core PDPP. The capability is still a `reference_extension`. A future cross-implementation contract would inherit the now-conformant CloudEvents 1.0 envelope and the Standard Webhooks signing profile for free.

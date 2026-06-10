## Why

A trusted owner agent (Daisy/Simon-style) can already initiate a local-collector
connection through `POST /v1/owner/connections/intents`, but a browser-bound
connector such as a second Amazon account returns `unsupported`. The reason is
honest: the reference has no enrollment primitive that lets a local collector
drive a real browser session and ingest through the device-exporter path. The
enroll route hardcodes `source_kind: "local_device"` and does no binding-aware
validation, so there is no way to record that a collected binding is
browser-collected rather than filesystem-read.

The `add-owner-agent-control-surface` design already named this exact gap and
its three-part shape. This change turns that named gap into a reviewable
construction packet so browser-bound enrollment becomes correct by construction
for Amazon, Chase, ChatGPT, and future browser-bound connectors — without leaking
browser automation into PDPP Core and without faking success before proof exists.

## What Changes

- Add a `browser_collector` source kind to the reference connector-instance
  source-binding vocabulary, distinct from `local_device`. A `browser_collector`
  binding records that the binding is collected by a local collector driving a
  browser session, not by reading the device filesystem.
- Make device-exporter enrollment **binding-aware**: the enrollment-code and
  enroll routes SHALL derive the source kind from the connector manifest
  `runtime_requirements.bindings` (a `browser` binding → `browser_collector`; a
  `filesystem` binding → `local_device`) and SHALL reject a source-kind that
  contradicts the manifest.
- Require committed proof — a test plus a scrubbed fixture — that a local
  collector runs a browser-bound connector (Amazon) end-to-end through the
  device-exporter ingest path **before** any route flips Amazon from
  `unsupported` to a real next step.
- Define the owner-mediated initiation contract for browser-bound connectors:
  the intent route MAY return a typed `enroll_browser_collector` next step that
  carries an enrollment code but SHALL keep `connection_active: false` until the
  owner's collector enrolls, completes provider login locally, and ingests.
- Keep boundaries explicit: this is reference / Collection Profile
  implementation vocabulary, not PDPP Core. The bare `browser` binding name
  mismatch with the spec-defined `browser_automation` / `browser_profile`
  registry is acknowledged and deferred to its existing design note, not
  silently absorbed.

## Capabilities

### Modified Capabilities

- `local-device-exporter-collection`: add binding-aware enrollment gating, the
  `browser_collector` source kind, and a proof gate before browser-bound
  connectors advertise a real next step.
- `reference-connector-instances`: extend the durable source-binding identity to
  carry `browser_collector` as a peer of `local_device` so browser-collected and
  filesystem-collected bindings for the same connector type remain distinct.

## Impact

- OpenSpec / design only in this lane. No primitive implementation here.
- Future implementation areas: `reference-implementation/server/routes/ref-device-exporters.ts`
  (enrollment-code + enroll), `reference-implementation/server/routes/owner-connection-intent.ts`
  (the `browser_bound` branch), the connector-instance source-binding types, and
  a committed Amazon browser-collector proof test + scrubbed fixture.
- Downstream: `add-owner-agent-control-surface` task 5.3 / 8.5 (Amazon
  second-account acceptance) unblocks only after the proof gate in this change is
  satisfied.

# Backend Boundary Inventory

Status: decided
Owner: remote-surface streaming architecture
Date: 2026-05-13
Absorbed by: tasks 0.1, 4.4, 4.5, and 6.1-6.5 in `extract-remote-surface-streaming-architecture`

## Decision

The current implementation already has the package boundary needed for this
tranche. No reference route, auth, connector, dashboard, or Docker code needs to
move into `@pdpp/remote-surface` for tasks 0.1, 4.4, or 4.5.

The reference-integration tranche is complete by host-adapter proof rather than
by moving PDPP-owned code into the package:

- `reference-implementation/server/streaming/sessions.js` is a compatibility
  shim over `@pdpp/remote-surface/server`, so existing `_ref` route imports and
  envelopes are preserved while session lifecycle behavior is package-backed.
- `reference-implementation/server/streaming/routes.js` consumes
  `@pdpp/remote-surface/protocol` helpers for reference wire payloads and input
  parsing, while route URLs, owner auth, token-only route auth, and response
  envelopes remain reference-owned.
- `run.stream_session_requested`, `run.stream_session_opened`, and
  `run.stream_session_resolved` are still emitted by the reference route
  adapter. Package diagnostics and protocol helpers feed those sinks, but the
  package does not own run timelines or spine events.
- `runTargetRegistry`, connector `browser-handoff.ts`, and
  `streaming-target-registration.ts` remain reference/connector orchestration.
  They do not import `@pdpp/remote-surface`; a later host-adapter extraction
  would need a separate OpenSpec change.
- Dynamic n.eko allocation consumes `@pdpp/remote-surface/leases` through the
  reference lease store and lease manager seams. Docker/Compose/sidecar
  lifecycle, operator config, and profile storage remain reference-owned and in
  the separate `add-dynamic-neko-surface-allocation` change.

## Inventory

- Reference streaming routes remain host-owned under
  `/_ref/run-interaction-streams/<token>` and related input, viewport,
  clipboard, diagnostics, n.eko proxy, and n.eko session endpoints.
- Streaming session store behavior remains host-owned for route envelopes,
  stream mint authorization, token issuance, attach/authorize/revoke
  orchestration, expiry, interaction-resolved invalidation, and run-ended
  invalidation. Package code owns only generic broker/protocol interfaces and
  pure validation helpers.
- Companion contracts remain host-owned for run timelines, spine events, per-run
  nonces, owner auth, device-exporter auth, and `_ref` route registration.
- Run-target registry behavior remains host-owned. The package may validate
  generic target descriptors, but connector target registration clients and
  registration credentials stay out of package APIs.
- Dashboard stream modules remain host-owned for React components, dashboard
  routing, copy, styling, owner-specific affordances, and URL resolution. Pure
  viewer/client/controller helpers may move behind package interfaces.
- Connector handoff paths remain host-owned through browser-binding and
  streaming-target registration code paths. The package does not own connector
  lifecycle authority or bypass host auth.
- Docker/Compose/sidecar allocation remains host-owned. Future allocator work
  may consume package lease/session seams but must not pull allocator lifecycle
  into this package in this change.

## Verification Proofs

- `reference-implementation/test/remote-surface-reference-boundary.test.js`
  asserts that reference streaming routes use package session/protocol APIs
  while preserving `_ref` route strings, `run_interaction_stream_session`
  envelopes, and stream timeline event emission.
- The same test asserts `run-target-registry.js`, connector
  `browser-handoff.ts`, and `streaming-target-registration.ts` remain free of
  package imports, which keeps target registration and browser handoff
  reference-owned.
- The same test asserts reference lease storage imports
  `@pdpp/remote-surface/leases` while Compose remains the owner of the n.eko
  service lifecycle.

## Backend Seams

`RemoteSurfaceBackendKind` already includes `vnc`, `kasm`, and `custom`.
`packages/remote-surface/src/backends/types.ts` now exposes future-backend
adapter and descriptor types plus `REMOTE_SURFACE_FUTURE_BACKEND_KINDS` so a
future VNC/Kasm-like adapter can satisfy the same lifecycle contract without a
concrete implementation in this tranche.

## n.eko Dependency Boundary

Concrete n.eko client details are adapter-local. Browser-visible descriptors are
limited to token-scoped same-origin proxy/session paths, and tests reject raw
upstream authority or allocator metadata. Product architecture should refer to
`NekoClientApi`, `NekoBackendAdapter`, and safe descriptors rather than concrete
n.eko package internals.

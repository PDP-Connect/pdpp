## 0. Boundary Map And Fixtures

- [x] 0.1 Inventory current reference streaming routes, session store behavior, companion contracts, run-target registry behavior, dashboard stream modules, and connector handoff paths.
- [x] 0.2 Define the package export map for `protocol`, `server`, `client`, `backends/neko`, `backends/cdp`, `diagnostics`, `leases`, and `testing`.
- [x] 0.3 Capture fixture cases from current SSE events, n.eko client config, input payloads, viewport payloads, clipboard events, target descriptors, and diagnostics records.
- [x] 0.4 Update `packages/remote-surface/README.md` so it reflects implemented exports and no longer describes implemented controllers as scaffold-only.

## 1. API And Type Extraction

- [x] 1.1 Add package exports for remote-surface session IDs, backend descriptors, target descriptors, scoped token descriptors, event/input/viewport/clipboard channel payloads, and revocation reasons.
- [x] 1.2 Define `RemoteSurfaceSessionBroker` and host-adapter interfaces for create, register, attach, authorize, revoke, event channel, input channel, viewport channel, clipboard channel, and diagnostics.
- [x] 1.3 Define client viewer interfaces for mount/unmount, input dispatch, keyboard/IME lifecycle, clipboard capabilities, viewport reporting, lifecycle state, and telemetry subscriptions.
- [x] 1.4 Define backend adapter capability and lifecycle interfaces for n.eko, CDP fallback, and future CDP/VNC/Kasm-like adapters.
- [x] 1.5 Add package documentation that states PDPP reference routes, run timelines, owner auth, persistence, and connector handoff are host-owned.
- [x] 1.6 Verify no new package type imports from `reference-implementation`, `apps/web`, or `packages/polyfill-connectors`.
- [x] 1.7 Keep connector target registration HTTP clients and Docker allocator lifecycle out of the package API.

## 2. Server Broker Extraction

- [x] 2.1 Move pure streaming session token/store behavior behind the package broker interface while preserving reference route URLs and response envelopes.
- [x] 2.2 Move input, viewport, clipboard, event-channel, and diagnostics payload parsing/validation into package-owned protocol helpers.
- [x] 2.3 Keep owner auth, device-exporter auth, per-run nonce auth, `_ref` route registration, and spine event emission in the reference host adapter.
- [x] 2.4 Preserve token expiry, attach, authorize, revoke, interaction-resolved invalidation, and run-ended invalidation behavior through focused tests.
- [x] 2.5 Verify raw CDP target URLs and n.eko upstream origins are never returned in browser-visible descriptors except through token-scoped proxy/session config.
- [x] 2.6 Add package broker conformance tests before switching reference routes to package-backed broker behavior.

## 3. Client And Viewer Extraction

- [x] 3.1 Move pure stream viewer protocol, viewport classification, visual-settle, geometry, clipboard-policy, pointer mapping diagnostics, and media-quality logic into package modules where they do not depend on React or dashboard routes.
- [x] 3.2 Move DOM controllers for n.eko mounting, pointer dispatch, keyboard/IME handling, and explicit clipboard actions behind the package client API.
- [x] 3.3 Keep React components, dashboard copy, server actions, URL resolution, styling, and owner-specific affordances in `apps/web`.
- [x] 3.4 Preserve existing dashboard stream tests or add package-backed equivalents for keyboard, clipboard, viewport, media settle, visual quality, and n.eko client behavior.
- [x] 3.5 Verify mobile keyboard and IME paths still route through the package client API rather than ad hoc dashboard-only handlers.

## 4. Backend Adapter Hardening

- [x] 4.1 Normalize n.eko adapter descriptors so client-visible config contains only token-scoped same-origin proxy/session details.
- [x] 4.2 Normalize CDP fallback descriptors so raw CDP WebSocket and HTTP URLs remain server-side.
- [x] 4.3 Add adapter capability tests for event channel support, input modes, clipboard modes, viewport modes, diagnostics, and owner-browser mode.
- [x] 4.4 Add future-backend seams without implementing VNC/Kasm-like backends in this tranche.
- [x] 4.5 Verify n.eko client dependency details are wrapped behind adapter interfaces and not exposed as product architecture.

## 5. Telemetry And Diagnostics

- [x] 5.1 Define a redacted package diagnostics schema for input pipeline, viewport transitions, clipboard actions, event channel, adapter lifecycle, backend readiness, and media settle.
- [x] 5.2 Provide bounded diagnostics buffers or hooks that hosts can bridge into existing reference input telemetry and dashboard debug sinks.
- [x] 5.3 Add redaction tests proving clipboard contents, raw target URLs, auth metadata, CDP bearer paths, and allocator credentials are not logged by default.
- [x] 5.4 Preserve replayability for viewport and input classification decisions.

## 6. Reference Integration

- [x] 6.1 Replace direct reference streaming-session and protocol helper use with package broker/client APIs while preserving current `_ref` route behavior.
- [x] 6.2 Keep `runTargetRegistry`, connector `browser-handoff.ts`, and `streaming-target-registration.ts` as reference-owned host orchestration unless a later change extracts a host adapter.
- [x] 6.3 Wire package telemetry hooks into current `run.stream_session_*` events and diagnostics without moving timeline ownership into the package.
- [x] 6.4 Ensure dynamic n.eko allocation consumes package lease/session/allocator interfaces but leaves Docker/Compose/sidecar implementation reference-owned.
- [x] 6.5 Update package README and reference docs to describe the OSS-spinnable boundary.

## 7. Verification And Smoke

- [x] 7.1 Run `pnpm --filter @pdpp/remote-surface typecheck`, package tests, and package lint/check commands available in the workspace.
- [x] 7.2 Run reference streaming route, session, run-target registry, n.eko adapter, CDP allowlist, and browser-surface lease tests.
- [x] 7.3 Run dashboard stream viewer tests for protocol, keyboard, clipboard, viewport, visual quality, media settle, and n.eko client behavior.
- [x] 7.4 Run import-boundary sweeps proving `packages/remote-surface` has no imports from reference, dashboard, connectors, Docker, or server modules.
- [x] 7.5 Run a gated CDP live smoke and a gated n.eko mobile smoke when the local environment supports them.
- [x] 7.6 Run `openspec validate extract-remote-surface-streaming-architecture --strict`.
- [x] 7.7 If dynamic allocation artifacts are touched during implementation, run `openspec validate add-dynamic-neko-surface-allocation --strict`.
- [x] 7.8 For each completed tranche, report remaining compatibility shims and whether the package is closer to OSS publication or only internally reorganized.

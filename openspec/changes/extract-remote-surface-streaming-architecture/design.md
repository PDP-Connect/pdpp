## Context

Recent substrate work moved browser-surface lease policy into `@pdpp/remote-surface` and exported `./leases`. That package also contains early client pieces: n.eko adapter shell, pointer controller, and mobile text input controller.

The remaining remote-surface streaming architecture is not yet separated:

- `reference-implementation/server/streaming/**` owns in-memory streaming sessions, token attach/authorize/revoke behavior, CDP and n.eko companion factories, event/input/viewport routes, token-scoped n.eko proxy/session routes, input telemetry, and run-target registration.
- `reference-implementation/server/index.js` wires owner/reference auth, run interaction invalidation, run timeline events, run-target nonce hooks, and browser-surface lease manager integration.
- `apps/web/src/app/dashboard/runs/[runId]/stream/**` owns dashboard-specific viewer lifecycle, n.eko client mounting, keyboard/IME/clipboard UX, viewport classification, visual settle policy, debug telemetry, and stream action URL resolution.
- `packages/polyfill-connectors/src/browser-handoff.ts` and `streaming-target-registration.ts` own connector/browser-binding handoff into the reference server.
- `add-dynamic-neko-surface-allocation` already depends on package-owned lease substrate but is scoped to reference-owned dynamic n.eko allocation, not the entire streaming architecture.

The goal of this tranche is to make the future code move obvious and reviewable before moving it. The success criterion is not "more code in `packages/remote-surface`"; it is a package boundary that could be published without carrying PDPP reference routes, owner auth, connector registration, Docker lifecycle, or dashboard product UI.

## Decision

Extend the internal `@pdpp/remote-surface` boundary from "lease substrate plus early adapters" to "generic remote-surface streaming primitives and protocol shapes." Keep it private initially, but shape it so it can become an OSS package without carrying PDPP reference runtime, dashboard, or connector assumptions.

Owner decisions for this change:

- The package SHALL ship stable interfaces and pure helpers first. A default in-memory session broker MAY be extracted only when existing session-store behavior is covered by parity tests; persistence remains host-owned.
- Connector streaming-target registration remains reference-owned for this tranche. The package may define target descriptor shapes and validation helpers, but not the reference admin registration client.
- Docker-backed n.eko allocation remains explicitly deferred to the reference-owned dynamic allocation change. A reusable Docker allocator package would require a separate OpenSpec change.
- The package export map SHALL be designed before implementation so moved code has a destination and reviewable ownership.

The package should own:

- Remote-surface session broker interfaces: create/register/attach/revoke session, event channel, input channel, viewport channel, clipboard channel, diagnostics channel, and typed session descriptors.
- Client API: mount/unmount viewer, dispatch pointer/keyboard/text/clipboard input, keyboard and IME controller lifecycle, viewport/layout reporting, clipboard capability model, telemetry hooks, and backend-neutral viewer state.
- Backend adapter API: n.eko backend adapter, CDP fallback adapter, and seams for future VNC, Kasm-like, Browserbase-like, or CDP-backed backends.
- Security and protocol shapes: scoped stream token descriptors, backend descriptors that exclude raw CDP from client-visible config, allowed-origin/proxy constraints, and capability declarations.
- Diagnostics schema: replayable input, viewport, clipboard, media-settle, event-channel, backend readiness, and adapter lifecycle events.
- Allocator/session interfaces already started in `./leases`, with additional session-descriptor seams required by streaming.

The reference implementation should own:

- Owner authentication, device-exporter authentication, and per-run nonce issuance.
- `_ref` HTTP route names, request envelopes, response envelopes, and route-level auth middleware.
- Run timelines and spine events such as `run.stream_session_requested`, `run.stream_session_opened`, and `run.stream_session_resolved`.
- Connector handoff, browser-binding registration clients, and registration credentials.
- Persistence adapters, in-memory stores, SQLite/Postgres rows, process lifecycle, and boot reconciliation.
- Dynamic n.eko Docker/Compose/sidecar implementation, operator config, and profile storage policy.

This means the package can provide a generic broker interface and default broker implementation pieces, but the reference server remains the host adapter that maps those pieces onto `_ref/run-interaction-streams/:token/...` and PDPP run interaction semantics.

## Proposed Package Interface

### Package Export Map

The intended internal export shape is:

- `@pdpp/remote-surface`: stable public facade and high-level types.
- `@pdpp/remote-surface/protocol`: JSON-safe event, frame, input, viewport, clipboard, target, capability, and session descriptor schemas/parsers.
- `@pdpp/remote-surface/server`: host-neutral broker interfaces, optional in-memory broker, token lifecycle primitives, channel dispatch helpers, and broker conformance tests.
- `@pdpp/remote-surface/client`: viewer facade, DOM controllers, viewport/control policies, clipboard policy, IME/text-input controllers, and telemetry hooks.
- `@pdpp/remote-surface/backends/neko`: n.eko adapter contracts, safe client descriptors, n.eko control abstractions, and n.eko-specific capability mapping.
- `@pdpp/remote-surface/backends/cdp`: CDP fallback companion/adapter contracts that keep raw CDP endpoints server-side.
- `@pdpp/remote-surface/diagnostics`: redacted diagnostics event schemas, bounded buffers, replay helpers, and redaction utilities.
- `@pdpp/remote-surface/leases`: existing browser-surface lease substrate.
- `@pdpp/remote-surface/testing`: fake broker, fake backend adapter, deterministic clocks, and protocol fixture helpers.

Subpaths may be introduced incrementally, but implementation SHALL avoid adding new generic streaming code to reference-only modules when an export destination has already been defined.

### Server / Session Broker

The package should expose types and interfaces similar to:

- `RemoteSurfaceSessionBroker.createSession(request)` for a host to create a scoped session descriptor after host auth has already passed.
- `registerTarget(sessionRef, targetDescriptor)` for binding a session to a backend target chosen by the host or connector handoff.
- `attachSession(tokenOrHandle)` for opening the event channel and resolving the backend companion.
- `authorizeSession(tokenOrHandle)` for input, viewport, clipboard, and diagnostics requests after attach.
- `revokeSession(sessionRef, reason)` for interaction resolved, run ended, token expired, or operator cancelled.
- `openEventChannel(session, sink)` for frame/event delivery.
- `dispatchInput(session, inputEvent)` for pointer, keyboard, touch, scroll, text, and paste input.
- `reportViewport(session, viewportReport)` for layout, visual viewport, DPR, touch, orientation, and keyboard-occlusion reports.
- `dispatchClipboard(session, clipboardAction)` for explicit local-to-remote and remote-to-local clipboard actions.
- `readDiagnostics(session, cursor)` for bounded diagnostic buffers.

The package API should use host-neutral concepts: `session_id`, `target_id`, `backend`, `capabilities`, `expires_at`, `viewport`, `diagnostics_cursor`, and `revocation_reason`. It should not name PDPP `run_id`, `interaction_id`, owner sessions, device exporter tokens, spine event types, or `_ref` paths as package requirements.

The current `reference-implementation/server/streaming/sessions.js` behavior is eligible for extraction only after tests prove token minting, idempotency replay, attach/authorize semantics, expiry, revocation, and run/interaction invalidation parity. The package may provide `createInMemoryRemoteSurfaceBroker` as a default implementation, but host adapters must be able to supply their own durable store.

### Client API

The package should expose a viewer/client facade that the dashboard can consume:

- `RemoteSurfaceViewer.mount(element, config)` and `unmount()`.
- `dispatchPointer`, `dispatchKeyboard`, `dispatchText`, `dispatchPaste`, `copyRemoteSelection`, and `focusTextInput`.
- `reportViewport(layout)` and a viewport classifier that can distinguish real remote resize from mobile keyboard/browser-chrome occlusion.
- `configureClipboard(policy)` with explicit read/write capability flags and manual fallback hooks.
- `subscribeTelemetry(handler)` for replayable diagnostics without hard-coding PDPP debug sinks.
- `getLifecycleState()` and backend capability introspection.

React components, dashboard layout, owner messaging, server actions, and visual styling remain outside the package. The package can provide DOM controllers and pure policies; PDPP decides how to render them.

Existing pure dashboard modules are the first extraction candidates because they already have focused tests and limited React coupling:

- `stream-viewer-protocol.ts` -> protocol parsers and event schemas.
- `stream-geometry.ts`, `stream-viewport-classifier.ts`, and `stream-viewer-control.ts` -> viewport and presentation policies.
- `stream-clipboard-policy.ts` -> clipboard capability and fallback policy.
- `stream-media-settle.ts` and `stream-visual-quality.ts` -> media-settle and visual diagnostics policies.
- `neko-client-api-shim.ts` and the existing package n.eko adapter -> n.eko client binding seam.

### Backend Adapter API

The backend adapter seam should normalize:

- n.eko/WebRTC/X11 control path as preferred for stealth-sensitive owner-operated browser sessions.
- CDP screencast/input as fallback, debug, and automation-friendly path.
- Future CDP/VNC/Kasm-like backends without changing client or broker contracts.

Adapters should expose capabilities: event channel mode, input modes, clipboard modes, viewport modes, diagnostics modes, owner-browser mode, and whether raw automation endpoints exist only server-side.

The current reference companion shape is the compatibility target for server extraction:

- `start(viewport)` and `stop()` lifecycle.
- `onFrame(handler)` frame subscription.
- `onEvent(handler)` for backend events such as URL, popup, clipboard, and keyboard focus.
- `input(payload)` and `setViewport(viewport)` command paths.
- n.eko-only safe proxy/session helpers exposed through token-scoped descriptors, never raw upstream authority.

### Security Model

The package boundary must preserve these rules:

- Host auth happens before package session creation; package tokens are scoped remote-surface tokens, not owner sessions, client grants, or collector credentials.
- Browser/client-visible descriptors must not include raw CDP WebSocket URLs, Docker hostnames, allocator credentials, or connector-owned lifecycle authority.
- Allowed origins and proxy targets are host-approved and normalized before the package opens proxy/session channels.
- Connector handoff may register targets but must not own backend lifecycle or bypass host auth.
- n.eko proxy/session config must be token-scoped and same-origin from the browser's perspective.
- Diagnostics must redact secrets, raw target URLs, auth metadata, clipboard contents by default, and CDP paths that function as bearer secrets.
- Package examples and test fixtures must not normalize unsafe shortcuts such as direct browser-visible CDP URLs or broad proxy allowlists.

### PDPP Integration Boundary

The reference host adapter maps PDPP-specific concepts onto generic package concepts:

- `run_id` + `interaction_id` become host metadata on a package session, not package identity requirements.
- `/_ref/run-interaction-streams/:token/events|input|viewport|...` remain reference route choices.
- Owner auth and device-exporter nonce auth remain reference middleware.
- `runTargetRegistry` and connector `streaming-target-registration.ts` remain reference orchestration until a separate host adapter package is justified.
- Timeline/spine events remain emitted by the reference after package broker hooks, not by the package itself.
- Reference `runTargetRegistry` keeps the admin registration routes and nonce verification. Package target descriptor validation may replace duplicated parsing, but the registration endpoint and registration client remain PDPP/reference concepts.

### Dynamic Allocation Relationship

Dynamic n.eko allocation should consume package-owned leases, allocator interfaces, target/session descriptors, and diagnostics shapes. The dynamic allocator sidecar, Docker Engine access, Compose wiring, image pinning, labels, networks, profile storage, readiness probes, and operator configuration remain reference-owned until a separate backend allocator package is proposed.

This prevents `add-dynamic-neko-surface-allocation` from becoming a hidden streaming architecture extraction.

## Implementation Tranches

0. Boundary map and fixtures: document existing route/client/connector seams, create protocol fixture cases from current SSE/config/input/viewport/clipboard payloads, and define the export map before moving code.
1. API/type extraction: add package types for sessions, channels, backend descriptors, client viewer controls, clipboard, viewport, diagnostics, and target registration without changing runtime behavior.
2. Server broker extraction: move pure session token/store, attach/authorize/revoke logic, input/viewport/clipboard/event-channel protocol parsing, and diagnostics buffer policy behind package interfaces while reference routes remain as host adapters.
3. Client/viewer extraction: move pure dashboard stream viewer policies and DOM controllers into package modules, leaving React/server actions/styling in `apps/web`.
4. Backend adapter hardening: normalize n.eko and CDP adapter contracts, keep raw CDP server-side, and add future-backend capability seams.
5. Telemetry/diagnostics: define a redacted schema and wire package hooks into existing dashboard/reference debug sinks.
6. Reference integration: replace direct imports/use sites with package APIs while preserving `_ref` route shapes and current owner UX.
7. Verification/smoke: run package tests, reference streaming tests, dashboard stream tests, import-boundary sweeps, and gated n.eko/CDP smoke tests.

## Risks / Trade-offs

- Over-generalizing too early: mitigate by extracting current proven shapes and naming future backends only as capability seams, not implemented adapters.
- Leaking PDPP into the package: mitigate with import sweeps and host-adapter naming; package types should not require run/interaction IDs.
- Leaking backend authority to the browser: enforce no raw CDP/client-visible allocator descriptors.
- Breaking current owner UX: preserve route and dashboard behavior until package-backed parity tests pass.
- Dynamic allocation scope creep: keep Docker/Compose/sidecar work in the dynamic allocation change and reference implementation.
- n.eko client dependency risk: wrap it behind adapter APIs so demodesk client specifics are replaceable or vendorable later.
- Shallow extraction risk: moving files without host/package contract tests would create a package in name only. Require package conformance tests and reference parity tests per tranche.

## Acceptance Checks

- `packages/remote-surface` does not import `reference-implementation`, `apps/web`, or `packages/polyfill-connectors`.
- Package API documentation names generic remote-surface concepts rather than PDPP `_ref`, run timeline, owner auth, or connector registration terms.
- `packages/remote-surface/README.md` is updated to reflect implemented exports and no longer claims implemented controllers are scaffold-only.
- Reference streaming routes remain host adapters and preserve current external behavior during extraction.
- Raw CDP URLs are server-side only and never appear in browser/client-visible stream descriptors.
- Dynamic allocation tasks depend on package allocator/session interfaces but do not absorb server broker, viewer, or telemetry extraction.
- Existing stream viewer, server streaming, and connector handoff tests have package-backed equivalents before implementation is marked complete.
- Each extraction tranche includes an import-boundary sweep and at least one before/after fixture or parity test proving behavior did not change.

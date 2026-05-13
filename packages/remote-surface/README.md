# @pdpp/remote-surface

Internal PDPP package for the generic remote-surface substrate used by manual
browser interactions. It owns host-neutral protocol shapes, viewer/controller
interfaces, backend adapter contracts, diagnostics helpers, and browser-surface
lease primitives.

This is the architectural shape recommended in:

- `docs/5-12-26-chatgpt-remote-surface-brief-response.txt` (expert brief response)
- `docs/neko-stealth-design-brief.md` (broader stealth design brief)
- `docs/mobile-ime-prior-art-research.md` (Guacamole-style mobile IME prior art)

## Boundary

`@pdpp/remote-surface` is deliberately OSS-spinnable. Package APIs use generic
concepts such as sessions, scoped tokens, targets, event/input/viewport/
clipboard channels, backend capabilities, and redacted diagnostics.

The PDPP reference implementation still owns PDPP-specific behavior:

- `_ref` route names, request/response envelopes, and route middleware.
- Owner auth, device-exporter auth, stream mint authorization, and run nonces.
- Run timelines and spine events such as stream requested/opened/resolved.
- Connector registration and browser handoff clients.
- Persistence adapters, in-memory reference stores, and boot reconciliation.
- Docker/Compose/sidecar allocation, operator config, and profile storage.

This package must not import `reference-implementation`, `apps/web`,
`packages/polyfill-connectors`, Docker implementation code, or server routes.

## Exports

- `@pdpp/remote-surface` — facade for current public types, leases, early
  adapters/controllers, and host-neutral API types.
- `@pdpp/remote-surface/protocol` — JSON-safe session, token, target,
  capability, event, input, viewport, clipboard, diagnostics, and safe backend
  descriptor shapes plus descriptor safety helpers.
- `@pdpp/remote-surface/server` — `RemoteSurfaceSessionBroker` and
  host-adapter interfaces for create/register/attach/authorize/revoke,
  channels, and diagnostics.
- `@pdpp/remote-surface/client` — viewer lifecycle, input dispatch,
  clipboard policy, viewport reporting, telemetry, and lifecycle interfaces.
- `@pdpp/remote-surface/backends/neko` — n.eko backend contracts and safe
  same-origin client descriptor shapes.
- `@pdpp/remote-surface/backends/cdp` — CDP fallback contracts that keep raw
  CDP HTTP/WebSocket authority server-side.
- `@pdpp/remote-surface/diagnostics` — redacted diagnostics event helpers and
  bounded in-memory buffers.
- `@pdpp/remote-surface/leases` — browser-surface lease substrate.
- `@pdpp/remote-surface/testing` — fake broker and deterministic test
  capabilities for package/host conformance tests.

## Adapters

- **`NekoSurfaceAdapter`** — **preferred** for stealth flows. Wraps an
  `@demodesk/neko` client and forwards interaction events over n.eko's
  WebRTC data channel.
- **`CdpSurfaceAdapter`** — fallback / legacy / debug path. Wraps the
  existing CDP-backed `BrowserSurface` for sessions that cannot use n.eko.

## Mobile IME

`MobileTextInputController` ports the Guacamole `guacTextInput.js` pattern:
hidden `<textarea>` capturing `beforeinput`, `input`, and `compositionstart`/
`compositionupdate`/`compositionend` events, then translating them into
either X11 keysym events (for ASCII keystrokes) or text-commit batches
(for IME composition results).

## Status

The package contains a working browser-surface lease substrate, early
n.eko/client controller pieces, host-neutral API/type destinations for the
streaming extraction, and pure diagnostics/protocol/testing helpers. Server
broker extraction, dashboard viewer migration, reference route adaptation, and
dynamic Docker-backed n.eko allocation remain intentionally outside this
tranche.

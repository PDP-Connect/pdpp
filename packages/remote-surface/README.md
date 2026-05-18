# @pdpp/remote-surface

Generic remote-surface substrate for browser interactions. It owns host-neutral
protocol shapes, viewer/controller interfaces, backend adapter contracts,
diagnostics helpers, browser-surface lease primitives, and an additive
`SurfaceSessionStore` wrapper for hosts that want session/action terminology
instead of reference-runtime field names.

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
- `@pdpp/remote-surface/adapters` — concrete `RemoteSurface` adapter classes
  and their dependency-injection contracts.
- `@pdpp/remote-surface/protocol` — JSON-safe session, token, target,
  capability, event, input, viewport, clipboard, diagnostics, and safe backend
  descriptor shapes plus descriptor safety helpers.
- `@pdpp/remote-surface/server` — `RemoteSurfaceSessionBroker` and
  host-adapter interfaces for create/register/attach/authorize/revoke,
  channels, diagnostics, and `createSurfaceSessionStore` for host-neutral
  session/action persistence.
- `@pdpp/remote-surface/client` — viewer lifecycle, input dispatch,
  clipboard policy, viewport reporting, telemetry, and lifecycle interfaces.
- `@pdpp/remote-surface/backends/neko` — n.eko backend contracts and safe
  same-origin client descriptor shapes.
- `@pdpp/remote-surface/backends/cdp` — CDP fallback contracts that keep raw
  CDP HTTP/WebSocket authority server-side.
- `@pdpp/remote-surface/backends/types` — generic backend
  adapter/lifecycle contracts plus future-backend seams for VNC/Kasm-like
  adapters. The package names those kinds but does not implement them in this
  tranche.
- `@pdpp/remote-surface/controllers` — pointer controller primitives shared by
  adapters.
- `@pdpp/remote-surface/diagnostics` — redacted diagnostics event helpers and
  bounded in-memory buffers.
- `@pdpp/remote-surface/ime` — mobile text-input and keysym helpers.
- `@pdpp/remote-surface/leases` — browser-surface lease substrate.
- `@pdpp/remote-surface/testing` — fake broker and deterministic test
  capabilities for package/host conformance tests.

## Package validation

The package remains `private: true` until release preparation. Maintainers can
still validate the publish shape locally:

```bash
pnpm --filter @pdpp/remote-surface verify
```

That command typechecks, lints, runs package-local tests, builds `dist`, packs
the package without publishing, checks the tarball allowlist, rejects
workspace/private dependency leakage, verifies declarations for every exported
entrypoint, and installs/imports/typechecks the packed artifact from a clean
consumer fixture.

The packed-artifact scan treats `_ref`, `run_id`, and `interaction_id` as
host-coupled terms. Any remaining matches must be pattern-allowlisted in
`scripts/validate-package.mjs` with a compatibility rationale, such as
reference wire fixtures or transitional adapters that sit behind the
host-neutral `SurfaceSessionStore` API.

Release preparation is still responsible for the final `private: false` switch,
registry metadata, polished cookbook examples, and the actual publish command.

## Adapters

- **`NekoSurfaceAdapter`** — **preferred** for stealth flows. It depends on a
  small package-owned `NekoClientApi` adapter interface rather than exposing
  concrete n.eko client package details as product architecture.
- **`CdpSurfaceAdapter`** — fallback / legacy / debug path. Wraps the
  existing CDP-backed `BrowserSurface` for sessions that cannot use n.eko.
- **Future backends** — VNC/Kasm-like backends may satisfy the generic
  `RemoteSurfaceBackendAdapter` and safe descriptor contracts later. This
  package currently provides only the seam, not concrete VNC or Kasm clients.

## Mobile IME

`MobileTextInputController` ports the Guacamole `guacTextInput.js` pattern:
hidden `<textarea>` capturing `beforeinput`, `input`, and `compositionstart`/
`compositionupdate`/`compositionend` events, then translating them into
either X11 keysym events (for ASCII keystrokes) or text-commit batches
(for IME composition results).

## Status

The package contains a working browser-surface lease substrate, early
n.eko/client controller pieces, host-neutral API/type destinations for the
streaming extraction, pure diagnostics/protocol/testing helpers, and the
default in-memory session lifecycle consumed by the reference route adapter.
The reference server still owns `_ref` routes, auth, run timelines, connector
handoff, and dynamic Docker-backed n.eko allocation. That split is intentional:
the package is closer to OSS publication because reusable remote-surface
contracts are isolated, but it is not a standalone product server.

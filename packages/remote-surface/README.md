# @opendatalabs/remote-surface

Generic remote-surface substrate for browser interactions. It owns host-neutral
protocol shapes, viewer/controller interfaces, backend adapter contracts,
diagnostics helpers, surface lease primitives, and an in-memory token session
store for hosts that want session/action terminology.

This is the architectural shape recommended in:

- `docs/5-12-26-chatgpt-remote-surface-brief-response.txt` (expert brief response)
- `docs/neko-stealth-design-brief.md` (broader stealth design brief)
- `docs/mobile-ime-prior-art-research.md` (Guacamole-style mobile IME prior art)

## Boundary

`@opendatalabs/remote-surface` is deliberately OSS-spinnable. Package APIs use generic
concepts such as sessions, scoped tokens, targets, event/input/viewport/
clipboard channels, backend capabilities, and redacted diagnostics.

The PDPP reference implementation still owns PDPP-specific behavior:

- Reference route names, request/response envelopes, and route middleware.
- Owner auth, device-exporter auth, stream mint authorization, and run nonces.
- Run timelines and spine events such as stream requested/opened/resolved.
- Connector registration and browser handoff clients.
- Persistence adapters, in-memory reference stores, and boot reconciliation.
- Docker/Compose/sidecar allocation, operator config, and profile storage.

This package must not import `reference-implementation`, `apps/site`, `apps/console`,
`packages/polyfill-connectors`, Docker implementation code, or server routes.

## Exports

- `@opendatalabs/remote-surface` — facade for current public types, leases, early
  adapters/controllers, and host-neutral API types.
- `@opendatalabs/remote-surface/adapters` — concrete `RemoteSurface` adapter classes
  and their dependency-injection contracts.
- `@opendatalabs/remote-surface/protocol` — JSON-safe session, token, target,
  capability, event, input, viewport, clipboard, diagnostics, and safe backend
  descriptor shapes plus descriptor safety helpers.
- `@opendatalabs/remote-surface/server` — `RemoteSurfaceSessionBroker` and
  host-adapter interfaces for create/register/attach/authorize/revoke,
  channels, diagnostics, and `createSurfaceSessionStore` for host-neutral
  session/action persistence.
- `@opendatalabs/remote-surface/client` — viewer lifecycle, input dispatch,
  container-fit DOM primitives, clipboard policy, viewport reporting,
  telemetry, and lifecycle interfaces.
- `@opendatalabs/remote-surface/compat/pdpp-reference` — explicit PDPP
  reference-compatibility parsers, builders, and fixtures for hosts preserving
  the reference wire shape.
- `@opendatalabs/remote-surface/backends/neko` — n.eko backend contracts and safe
  same-origin client descriptor shapes.
- `@opendatalabs/remote-surface/backends/cdp` — concrete CDP backend lifecycle,
  typed CDP transport contracts, and safe descriptors that keep raw CDP HTTP/
  WebSocket authority server-side.
- `@opendatalabs/remote-surface/backends/types` — generic backend
  adapter/lifecycle contracts plus future-backend seams for VNC/Kasm-like
  adapters. The package names those kinds but does not implement them in this
  tranche.
- `@opendatalabs/remote-surface/controllers` — pointer controller primitives shared by
  adapters.
- `@opendatalabs/remote-surface/diagnostics` — redacted diagnostics event helpers and
  bounded in-memory buffers.
- `@opendatalabs/remote-surface/ime` — mobile text-input and keysym helpers.
- `@opendatalabs/remote-surface/leases` — host-neutral surface lease substrate.
- `@opendatalabs/remote-surface/testing` — fake broker and deterministic test
  capabilities for package/host conformance tests.

## What Is Extracted

The reusable streaming architecture is extracted as package primitives, not as
a complete hosted streaming service.

| Area | Package-owned | Host-owned |
| --- | --- | --- |
| Session lifecycle | Token hashing, TTL, idempotent minting, attach/authorize/revoke semantics, and host-neutral `SurfaceSessionStore` APIs. | Auth checks, route names, persistence durability, process lifecycle, and event emission. |
| Protocol | JSON-safe event, input, viewport, clipboard, diagnostics, target, capability, and safe backend descriptors. | HTTP/SSE/WebSocket envelopes and any product-specific wire compatibility. |
| Client/viewer | DOM controllers, viewport/control policies, IME helpers, clipboard policy, media settle, visual-quality, and telemetry interfaces. | React components, URL construction, copy, styling, owner affordances, and dashboard actions. |
| Backends | n.eko/CDP capability contracts, concrete CDP frame/input lifecycle, and safe client descriptor validation that prevents raw automation endpoints from reaching the browser. | Browser processes, CDP/n.eko upstream authority, Docker/sidecar allocation, profiles, and credentials. |
| Diagnostics | Redacted event helpers and bounded buffers. | Log sinks, timelines, retention, correlation IDs, and operator dashboards. |

This means a host can build its own remote-surface route adapter around the
package, but must still provide routing, authorization, persistence, backend
process ownership, and product UX.

## Minimal Consumer Shape

Install from a packed artifact during local release validation:

```bash
pnpm add /path/to/pdpp/packages/remote-surface/opendatalabs-remote-surface-0.0.1.tgz
```

Create a host-owned session store and map it to your own routes:

```ts
import { createSurfaceSessionStore } from "@opendatalabs/remote-surface/server";

const sessions = createSurfaceSessionStore();

const issued = sessions.mint({
  surfaceSessionId: "surface-session-123",
  actionId: "owner-approval-456",
  browserSessionId: "browser-tab-789",
});

sessions.attach({
  token: issued.token,
  surfaceSessionId: "surface-session-123",
  actionId: "owner-approval-456",
});
```

Validate browser-visible backend descriptors before returning them to a client:

```ts
import { buildNekoSafeClientDescriptor } from "@opendatalabs/remote-surface/backends/neko";

const descriptor = buildNekoSafeClientDescriptor({
  proxyPath: "/remote-surface/surface-session-123/neko",
  sessionPath: "/remote-surface/surface-session-123/neko/session",
});
```

The package intentionally does not create these HTTP routes. Your host maps the
token/session/action to its own authorization model and backend process.

Run CDP through a host-owned server-side transport:

```ts
import { createCdpRemoteSurfaceBackendAdapter } from "@opendatalabs/remote-surface/backends/cdp";

const backend = createCdpRemoteSurfaceBackendAdapter({
  targetId: "surface-session-123",
  transport: {
    send: (method, params) => cdpSession.send(method, params),
    on: (eventName, handler) => {
      cdpSession.on(eventName, handler);
      return { unsubscribe: () => cdpSession.off(eventName, handler) };
    },
  },
});

const lifecycle = await backend.start({
  type: "viewport",
  width: 1280,
  height: 720,
});
```

The CDP backend emits package `frame` events from `Page.screencastFrame`,
acknowledges each frame, translates package input payloads into `Input.*`
methods, and applies viewport changes with `Emulation.setDeviceMetricsOverride`.
The host still owns Chrome/Patchright launch, profile trust, networking,
authorization, route envelopes, and the policy decision about whether CDP is
allowed for the current interaction mode.

Acquire remote-surface capacity through the host-neutral lease facade:

```ts
import { DEFAULT_NEKO_PRIORITY_RANKS, createSurfaceLeaseManager } from "@opendatalabs/remote-surface/leases";

const leases = createSurfaceLeaseManager({
  config: {
    managedSurfaceKinds: new Set(["browser"]),
    surfaceCap: 2,
    leaseWaitTimeoutMs: 60_000,
    idleTtlMs: 300_000,
    defaultPriorityClass: "scheduled_refresh",
    priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
    surfaceMode: "dynamic",
  },
});

const lease = leases.acquire({
  surfaceKind: "browser",
  sessionId: "surface-session-123",
  profileKey: "checkout-profile",
});

leases.renewLease({
  leaseId: lease.lease.leaseId,
  fencingToken: lease.lease.fencingToken,
});
```

Mount a client adapter by supplying the host-owned browser client bridge:

```ts
import { NekoSurfaceAdapter } from "@opendatalabs/remote-surface/adapters";

const adapter = new NekoSurfaceAdapter({
  config: {
    kind: "neko",
    sessionId: "surface-session-123",
    target: { id: "target-1", label: "Browser", kind: "browser" },
  },
  client: {
    start: async (container, config) => {
      // Host code starts its n.eko/WebRTC client here.
    },
    sendText: async (text) => true,
  },
});

const root = document.querySelector<HTMLElement>("#remote-surface");
if (!root) {
  throw new Error("remote surface mount target missing");
}
await adapter.mount(root);
```

Fit a stream surface to an arbitrary container and map pointer coordinates back
into the stream viewport:

```ts
import { createContainerFitStreamViewerSurface } from "@opendatalabs/remote-surface/client";

const surface = createContainerFitStreamViewerSurface(document.querySelector("#stream-shell")!, {
  width: 1280,
  height: 720,
});

surface.subscribe((geometry) => {
  console.log(geometry.displayRect, geometry.letterboxBars, geometry.isOneToOne);
});

const remotePoint = surface.mapClientPointToStream(pointerEvent.clientX, pointerEvent.clientY);
surface.setViewport({ width: 390, height: 844, mobile: true, hasTouch: true });
```

Close the loop between the fitted container and a backend-provided viewport
resize effect:

```ts
import {
  createContainerFitStreamViewerSurface,
  createViewportMatchController,
} from "@opendatalabs/remote-surface/client";

const surface = createContainerFitStreamViewerSurface(container, {
  width: 390,
  height: 844,
  mobile: true,
  hasTouch: true,
});

const controller = createViewportMatchController({
  surface,
  applyViewport: async (viewport) => {
    await backend.setViewport(viewport);
  },
  options: {
    debounceMs: 180,
    snapViewport: (viewport) => viewport,
  },
});

controller.subscribe((telemetry) => {
  console.log(telemetry.targetViewport, telemetry.actualViewport, telemetry.letterboxBars, telemetry.matched);
});
```

The controller reuses the package viewport classifier, so keyboard occlusion,
browser-chrome movement, zoom, and stable churn are held while real layout and
orientation changes are posted after debounce. CDP hosts can pass
`Emulation.setDeviceMetricsOverride` through `applyViewport`; n.eko hosts should
use the exported n.eko apply-viewport seam to add aligned modeline snapping,
window-bounds application, and gutter/crop reporting behind the same controller.

The package lifecycle is intentionally small: host code creates a session,
leases or starts backend capacity, exposes host-owned HTTP/SSE/WebRTC routes,
mounts a client adapter with token-scoped descriptors, reports viewport/input/
clipboard events through the package protocol helpers, renews leases while
long-running actions remain active, then releases or invalidates the session and
lease when the action completes. The package assumes modern ESM runtimes,
browser DOM APIs for client adapters, and host-provided routing, authorization,
persistence, process supervision, and backend network access.

### Reference Compatibility

PDPP reference wire compatibility lives under
`@opendatalabs/remote-surface/compat/pdpp-reference`. The legacy
`@opendatalabs/remote-surface/reference` subpath remains available as a
deprecated alias for the current release cycle so existing internal callers keep
compiling.

New host integrations should prefer `SurfaceSessionStore` and
`SurfaceLeaseManager`. They use host-neutral session/action/surface terminology
and do not require hosts to implement PDPP routes or timeline storage.

## Package validation

The package remains `private: true` until release preparation. Maintainers can
still validate the publish shape locally:

```bash
pnpm --filter @opendatalabs/remote-surface verify
```

That command typechecks, lints, runs package-local tests, builds `dist`, packs
the package without publishing, checks the tarball allowlist, rejects
workspace/private dependency leakage, verifies declarations for every exported
entrypoint, and installs/imports/typechecks the packed artifact from a clean
consumer fixture.

The packed-artifact scan treats PDPP reference route and record identifiers as
host-coupled terms. Any remaining matches must be pattern-allowlisted in
`scripts/validate-package.mjs` with a compatibility rationale, such as explicit
PDPP reference wire fixtures or transitional adapters that sit behind the
host-neutral `SurfaceSessionStore` API.

Release preparation is still responsible for the final `private: false` switch,
registry metadata, polished cookbook examples, and the actual publish command.

## Adapters

- **`NekoSurfaceAdapter`** — **preferred** for stealth flows. It depends on a
  small package-owned `NekoClientApi` adapter interface rather than exposing
  concrete n.eko client package details as product architecture.
- **CDP backend lifecycle** — first-class server-side backend for hosts that
  attach to Chrome/Patchright over CDP. It relays screencast frames, dispatches
  pointer/keyboard/text/clipboard input, applies viewport changes, and returns
  only safe browser-visible descriptors.
- **`CdpSurfaceAdapter`** — legacy/debug browser-side adapter for hosts that
  still wrap an existing CDP-backed remote-surface client.
- **Future backends** — VNC/Kasm-like backends may satisfy the generic
  `RemoteSurfaceBackendAdapter` and safe descriptor contracts later. This
  package currently provides only the seam, not concrete VNC or Kasm clients.

## Mobile IME

`MobileTextInputController` ports the Guacamole `guacTextInput.js` pattern:
hidden `<textarea>` capturing `beforeinput`, `input`, and `compositionstart`/
`compositionupdate`/`compositionend` events, then translating them into
either X11 keysym events (for ASCII keystrokes) or text-commit batches
(for IME composition results).

## Supported runtime assumptions

- **Node.js**: `>=24` (the 2026 Active LTS line). The package targets the
  current LTS rather than the older Node 22 floor used by sibling `@pdpp/*`
  packages.
- **Module resolution**: ESM-only. The package ships `"type": "module"` and
  does not provide a CommonJS build.
- **Browser**: client adapters require a modern DOM (Web Crypto, `MutationObserver`,
  `IntersectionObserver`, `compositionstart`/`compositionupdate`/`compositionend`
  input events, `navigator.clipboard`). They do not polyfill missing APIs.
- **TypeScript**: the package ships declarations targeting `module: NodeNext`,
  `moduleResolution: NodeNext`, and `target: ES2023` consumers.

## Reporting vulnerabilities

Security issues should go to `security@vana.org`. See
[`SECURITY.md`](./SECURITY.md) for the full disclosure policy. The same
contact covers vulnerabilities discovered in the reference implementation
that consumes this package.

## License

`@opendatalabs/remote-surface` is licensed under
[Apache-2.0](./LICENSE). The reference implementation that consumes it
shares the same license; documentation under `docs/` and `design-notes/`
is licensed under [CC-BY-4.0](../../LICENSE-docs).

## Status

The package contains a working surface lease substrate, n.eko/client
controller pieces, a first-class CDP backend lifecycle, host-neutral API/type
destinations for the streaming extraction, pure diagnostics/protocol/testing
helpers, and the default in-memory session lifecycle consumed by the reference
route adapter.
The reference server still owns auth, run timelines, connector handoff, and
dynamic Docker-backed n.eko allocation. That split is intentional: the package
is closer to OSS publication because reusable remote-surface contracts are
isolated, but it is not a standalone product server.

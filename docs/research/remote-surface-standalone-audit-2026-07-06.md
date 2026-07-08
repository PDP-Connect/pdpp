# Remote Surface Standalone Audit

Date: 2026-07-06

Scope: read-only audit of `packages/remote-surface` as a future standalone
`@opendatalabs/remote-surface` package for products beyond PDPP. Evidence is
repo-relative `file:line` unless a prior-art source is linked directly.

## Executive Finding

`packages/remote-surface` is past the "misc helper extraction" stage, but it is
not yet at the "install it and build a great viewer in a day" bar. The package
has useful protocol, adapter, lease, IME, geometry, and reducer primitives, and
the README correctly describes a host-neutral ambition
(`packages/remote-surface/README.md:3`, `packages/remote-surface/README.md:65`).
The actual public surface still leaks the reference implementation in three
ways:

- Generic lease/session implementations live under `src/reference/`, then get
  re-exported through generic-looking facades
  (`packages/remote-surface/src/leases/index.ts:1`,
  `packages/remote-surface/src/server/surface-session-store.ts:1`).
- The complete n.eko viewer and server companion are outside the package in the
  PDPP console/reference implementation
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1354`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:2084`,
  `reference-implementation/server/streaming/neko-adapter.js:443`).
- The package is still `private: true` and exports `./reference` as a first-class
  subpath (`packages/remote-surface/package.json:4`,
  `packages/remote-surface/package.json:74`).

The next stage should be decomplecting, not just moving files: make the generic
surface/session/lease/viewer core the named public core, and keep PDPP/reference
wire compatibility as an explicit compatibility layer.

## 1. PDPP Residue Inventory

### `src/reference/browser-surface-leases.ts`

Classification: generic core with PDPP/browser/neko naming residue.

Evidence:

- The file defines the real lease domain: surface statuses, wait reasons,
  priority, capacity, health, idle cleanup, allocator reconciliation, and
  reclaim planning (`packages/remote-surface/src/reference/browser-surface-leases.ts:1`,
  `packages/remote-surface/src/reference/browser-surface-leases.ts:929`,
  `packages/remote-surface/src/reference/browser-surface-leases.ts:999`,
  `packages/remote-surface/src/reference/browser-surface-leases.ts:1035`).
- It already contains host-neutral request/config/types such as
  `AcquireSurfaceLeaseRequest`, `SurfaceLeaseManagerConfig`, and `SurfaceLease`
  (`packages/remote-surface/src/reference/browser-surface-leases.ts:128`,
  `packages/remote-surface/src/reference/browser-surface-leases.ts:143`,
  `packages/remote-surface/src/reference/browser-surface-leases.ts:169`).
- The generic `SurfaceLeaseManager` is a wrapper over the real
  `BrowserSurfaceLeaseManager`
  (`packages/remote-surface/src/reference/browser-surface-leases.ts:443`,
  `packages/remote-surface/src/reference/browser-surface-leases.ts:522`).
- The legacy projection still emits names like `pending_run_id` and
  `browser_surface_*`
  (`packages/remote-surface/src/reference/browser-surface-leases.ts:331`).

Move/rename:

- Move the real implementation to `src/leases/surface-lease-manager.ts`.
- Rename internal primitives from `BrowserSurface*` to `RemoteSurface*` or
  `Surface*`, and reserve `BrowserSurface*` as compatibility aliases.
- Move allocator-facing types to either `src/backends/neko/allocator-types.ts`
  or `src/leases/allocator.ts`; the core lease manager should not make Docker or
  n.eko feel implied.
- Keep a compatibility module such as
  `src/compat/pdpp-reference/browser-surface-leases.ts` that re-exports aliases
  and old projection helpers.

### `src/reference/streaming-session-store.ts`

Classification: generic token/session store with PDPP-shaped record names.

Evidence:

- It implements token generation, token hashing, TTL, purge, attach,
  authorize, invalidate, and summary behavior
  (`packages/remote-surface/src/reference/streaming-session-store.ts:1`,
  `packages/remote-surface/src/reference/streaming-session-store.ts:96`,
  `packages/remote-surface/src/reference/streaming-session-store.ts:108`,
  `packages/remote-surface/src/reference/streaming-session-store.ts:148`,
  `packages/remote-surface/src/reference/streaming-session-store.ts:245`,
  `packages/remote-surface/src/reference/streaming-session-store.ts:281`).
- Its public record is still named around `run_id`, `interaction_id`, and
  `browser_session_id`
  (`packages/remote-surface/src/reference/streaming-session-store.ts:7`).
- The generic `createSurfaceSessionStore` wrapper translates camelCase session
  fields into this PDPP-shaped store
  (`packages/remote-surface/src/server/surface-session-store.ts:65`,
  `packages/remote-surface/src/server/surface-session-store.ts:80`).

Move/rename:

- Move the real store to `src/server/token-session-store.ts` or
  `src/sessions/token-session-store.ts`.
- Make `SurfaceSessionRecord` the canonical record. Keep `StreamingSessionRecord`
  and `createStreamingSessionStore` as reference compatibility adapters.
- Preserve behavior first by making the old `reference` module import the new
  implementation, then update callers.

### `src/reference/protocol-wire.ts`

Classification: actual reference/PDPP wire compatibility.

Evidence:

- It builds/parses `_ref` paths and reference stream messages
  (`packages/remote-surface/src/reference/protocol-wire.ts:31`,
  `packages/remote-surface/src/reference/protocol-wire.ts:100`,
  `packages/remote-surface/src/reference/protocol-wire.ts:159`).
- Payloads include `run_id`, `interaction_id`, `browser_session_id`,
  `browser_owner_mode`, and `client_config_path`
  (`packages/remote-surface/src/reference/protocol-wire.ts:31`,
  `packages/remote-surface/src/reference/protocol-wire.ts:39`).

Move/rename:

- Keep it out of the generic root. Move to `src/compat/pdpp-reference/wire.ts`
  or `src/reference/pdpp-wire.ts`.
- Do not export it from `./reference` as if every adopter should know about it.

### `src/reference/stream-viewer-protocol.ts`

Classification: actual reference stream-viewer parser.

Evidence:

- `AttachedMessage` is explicitly `run_id` / `interaction_id` /
  `browser_session_id`
  (`packages/remote-surface/src/reference/stream-viewer-protocol.ts:4`).
- `parseAttachedMessage` validates the reference attach shape
  (`packages/remote-surface/src/reference/stream-viewer-protocol.ts:69`).

Move/rename:

- Keep as compatibility parser under `src/compat/pdpp-reference/`.
- The generic viewer core should consume a host-normalized
  `RemoteSurfaceSessionAttached` event instead.

### `src/reference/reference-wire-fixtures.ts`

Classification: actual reference fixtures.

Evidence:

- Fixture IDs and paths are reference-specific, including
  `REFERENCE_WIRE_RUN_ID`, `REFERENCE_WIRE_INTERACTION_ID`,
  `REFERENCE_WIRE_BROWSER_SESSION_ID`, and `_ref/run-interaction-streams/...`
  (`packages/remote-surface/src/reference/reference-wire-fixtures.ts:5`,
  `packages/remote-surface/src/reference/reference-wire-fixtures.ts:25`,
  `packages/remote-surface/src/reference/reference-wire-fixtures.ts:38`).

Move/rename:

- Keep with compatibility tests.
- Add separate generic session/viewer fixtures once the headless viewer protocol
  is extracted.

### `src/reference/index.ts`

Classification: mixed facade that turns compatibility into an official package
surface.

Evidence:

- It exports both the generic-looking session store and reference wire helpers
  (`packages/remote-surface/src/reference/index.ts:1`,
  `packages/remote-surface/src/reference/index.ts:22`).
- It also exports `_ref` path fixtures and PDPP-shaped IDs
  (`packages/remote-surface/src/reference/index.ts:46`).

Move/rename:

- Keep `./reference` only as a deprecated compatibility subpath for one release,
  or rename to `./compat/pdpp-reference`.
- Do not export deprecated reference types from the root once standalone
  publishing starts. The current root export includes deprecated
  `BrowserSurfaceLeaseManager`
  (`packages/remote-surface/src/index.ts:38`).

### Tests under `src/reference/`

Classification: split with the code they exercise.

Evidence:

- `browser-surface-leases.test.ts` is generic lease-manager coverage despite
  importing `BrowserSurface*` names. It exercises allocator requests, surface
  caps, priorities, projection helpers, and the new `createSurfaceLeaseManager`
  facade
  (`packages/remote-surface/src/reference/browser-surface-leases.test.ts:4`,
  `packages/remote-surface/src/reference/browser-surface-leases.test.ts:18`,
  `packages/remote-surface/src/reference/browser-surface-leases.test.ts:60`).
- `streaming-session-store.test.ts` already proves both the reference store
  contract and the host-neutral `createSurfaceSessionStore` wrapper
  (`packages/remote-surface/src/reference/streaming-session-store.test.ts:26`,
  `packages/remote-surface/src/reference/streaming-session-store.test.ts:36`,
  `packages/remote-surface/src/reference/streaming-session-store.test.ts:55`).
- `reference-wire-fixtures.test.ts` is true reference-wire coverage: it locks
  `_ref` route object names, SSE event names, frame shape, and current input
  payload variants
  (`packages/remote-surface/src/reference/reference-wire-fixtures.test.ts:31`,
  `packages/remote-surface/src/reference/reference-wire-fixtures.test.ts:42`,
  `packages/remote-surface/src/reference/reference-wire-fixtures.test.ts:66`).
- `stream-viewer-protocol.test.ts` is mixed: `parseAttachedMessage` coverage is
  reference-shaped, while frame/backend/popup/clipboard parser coverage belongs
  with generic stream-viewer protocol tests
  (`packages/remote-surface/src/reference/stream-viewer-protocol.test.ts:15`,
  `packages/remote-surface/src/reference/stream-viewer-protocol.test.ts:55`,
  `packages/remote-surface/src/reference/stream-viewer-protocol.test.ts:80`).

Move/rename:

- Move generic lease/session tests with the new core files.
- Keep reference-wire fixture tests under `src/compat/pdpp-reference/`.
- Split `stream-viewer-protocol.test.ts` so reference attach-message tests stay
  with compatibility, while backend-ready/frame/popup/clipboard parser tests
  live with the generic protocol module.

## 2. Capability Gap Outside the Package

### Console viewer: `stream-viewer.tsx` (5,256 lines)

Current role: full PDPP operator-console streaming experience.

Backend-agnostic viewer core that belongs in the package:

- Attach/re-mint/reconnect lifecycle around stream tokens and server events
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1919`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:2158`).
- Control reducer use, viewport posting, keyboard-resize suppression,
  visual-viewport/orientation/resize observers, and geometry application
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:2468`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:2900`).
- Adapter-backed pointer/input dispatch, including capture-phase pointer mapping
  and IME textarea attachment
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:3405`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:3419`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:3489`).
- n.eko presentation readiness, layout polling, and media settle checks
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:3595`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:3827`).
- CDP/JPEG fallback rendering with the same input/soft-keyboard concepts
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:4052`).
- Clipboard policy/bridge logic, excluding the surrounding product UI
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1728`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1876`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:4260`).

PDPP console UI/product chrome that stays out:

- `runId`/`interactionId` server actions and routing
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1354`).
- Dialog/backdrop, wordmark, corner controls, close confirmation, trouble state,
  clipboard sheets, interaction dock, OTP/manual action/resume actions, and
  resolved/unsupported views
  (`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1601`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:3044`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:4507`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:4723`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:4983`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:5164`).

Deployment/allocator infrastructure:

- None substantial in this file. It should consume allocator/session descriptors,
  not allocate surfaces.

Extraction seam:

- First extract a framework-neutral controller:

  ```ts
  createHeadlessRemoteSurfaceViewer({
    session: RemoteSurfaceSessionClient,
    surface: RemoteSurface,
    elements: { container, media, textInput? },
    viewportPolicy,
    clipboardPolicy,
    telemetry,
  })
  ```

- Then offer a small React hook wrapper:

  ```ts
  useRemoteSurfaceViewer({ session, backend, policies, telemetry })
  ```

The core should own lifecycle state, attach/reconnect decisions, viewport
observer wiring, input dispatch, clipboard direction, media settle, presentation
state, and telemetry events. The host should own tokens/actions, chrome, copy,
styling, route transitions, and product-specific decisions.

### Console n.eko client: `neko-client.ts` (2,393 lines)

Current role: concrete `@demodesk/neko` browser client integration.

Backend-specific viewer core that belongs in the package, likely under
`./backends/neko/client`:

- Structural n.eko instance types and mount/start/stop lifecycle
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:28`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:2084`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:2326`).
- Pointer mapping and pointer telemetry
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:242`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:376`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:446`).
- Overlay textarea, mobile input guard, paste/copy/select-all bridge, and
  clipboard target guards
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:590`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:620`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:876`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:948`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:1010`).
- Video/WebRTC playback bridge and media layout application
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:1199`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:1705`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:1773`).
- Touch-scroll/control acquisition bridge
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:1283`).
- The final exported methods already match the package's `NekoClientApi`
  adapter shape
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:2361`,
  `packages/remote-surface/src/adapters/neko-surface-adapter.ts:47`).

PDPP residue that should not become core API:

- The shim is explicitly a local bridge from the console module into
  `NekoClientApi`
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client-api-shim.ts:1`,
  `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client-api-shim.ts:36`).
- Debug event names and any PDPP data attributes should become configurable
  telemetry names, not package constants.

Deployment/allocator infrastructure:

- None substantial. The client consumes `serverPath`, `statusPath`, and `login`
  (`apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:19`).

Extraction seam:

- Add `createNekoWebClientApi(config): NekoClientApi`.
- Make the existing console shim import that function and delete local
  duplicate logic.
- Keep `@demodesk/neko` as an optional peer dependency or a lazy dynamic import
  behind the n.eko subpath.

### Server n.eko companion: `reference-implementation/server/streaming/neko-adapter.js` (1,191 lines)

Current role: n.eko server companion that polls frames/status and dispatches
viewport/input/copy/paste.

Backend/server core that belongs in the package, likely under
`./backends/neko/server`:

- `createNekoCompanion` target/fetch/auth lifecycle
  (`reference-implementation/server/streaming/neko-adapter.js:443`,
  `reference-implementation/server/streaming/neko-adapter.js:549`,
  `reference-implementation/server/streaming/neko-adapter.js:987`).
- Screen configuration, status, frame polling, viewport application, paste/copy,
  and input dispatch
  (`reference-implementation/server/streaming/neko-adapter.js:249`,
  `reference-implementation/server/streaming/neko-adapter.js:826`,
  `reference-implementation/server/streaming/neko-adapter.js:891`,
  `reference-implementation/server/streaming/neko-adapter.js:942`,
  `reference-implementation/server/streaming/neko-adapter.js:975`,
  `reference-implementation/server/streaming/neko-adapter.js:1017`).
- Optional browser-control assist for viewport/focus/copy/insertText when CDP is
  available
  (`reference-implementation/server/streaming/neko-adapter.js:607`,
  `reference-implementation/server/streaming/neko-adapter.js:652`,
  `reference-implementation/server/streaming/neko-adapter.js:752`,
  `reference-implementation/server/streaming/neko-adapter.js:785`,
  `reference-implementation/server/streaming/neko-adapter.js:803`).

PDPP/reference code that stays out:

- Target resolution by `run_id` / `interaction_id`
  (`reference-implementation/server/streaming/neko-adapter.js:1086`).
- Default factory binding to the reference target resolver
  (`reference-implementation/server/streaming/neko-adapter.js:1162`).
- Names like `__pdppNekoFocusChanged` and `__pdppPlaygroundEvents` should be
  configurable if the focus/page-metric assist moves into the package
  (`reference-implementation/server/streaming/neko-adapter.js:206`,
  `reference-implementation/server/streaming/neko-adapter.js:353`).

Deployment/allocator infrastructure:

- Minimal. It expects a target/origin/endpoints and does not itself create
  containers.

Extraction seam:

- `createNekoCompanion(target, options)` should be package-owned.
- The reference implementation should provide only `resolveTarget(session)` and
  route/event plumbing.

### Docker allocator: `reference-implementation/server/neko-surface-allocator-server.ts` (1,159 lines)

Current role: reference Docker service that creates, health-checks, exposes, and
removes n.eko surfaces.

Backend-agnostic viewer core:

- None. This is not viewer code.

PDPP/reference code that stays out or becomes defaults only:

- Label namespace/default owner strings, env names, profile paths, and route
  request shapes are reference-specific today
  (`reference-implementation/server/neko-surface-allocator-server.ts:15`,
  `reference-implementation/server/neko-surface-allocator-server.ts:641`,
  `reference-implementation/server/neko-surface-allocator-server.ts:662`,
  `reference-implementation/server/neko-surface-allocator-server.ts:853`,
  `reference-implementation/server/neko-surface-allocator-server.ts:1081`).

Deployment/allocator infrastructure that could be an optional module:

- Docker transport/client, container creation/removal, health/readiness checks,
  profile directory preparation, port allocation, route server, and CLI main
  (`reference-implementation/server/neko-surface-allocator-server.ts:73`,
  `reference-implementation/server/neko-surface-allocator-server.ts:127`,
  `reference-implementation/server/neko-surface-allocator-server.ts:269`,
  `reference-implementation/server/neko-surface-allocator-server.ts:480`,
  `reference-implementation/server/neko-surface-allocator-server.ts:565`,
  `reference-implementation/server/neko-surface-allocator-server.ts:579`,
  `reference-implementation/server/neko-surface-allocator-server.ts:714`,
  `reference-implementation/server/neko-surface-allocator-server.ts:1147`).

Extraction seam:

- Do not put this in the browser bundle or default package import path.
- If it moves, make it an optional server-only subpath such as
  `./backends/neko/docker-allocator`, with configurable label namespace,
  profile filesystem, image, network, port policy, and URL templates.

## 3. API Critique Against Prior Art

Prior-art sources checked:

- Apache Guacamole `guacamole-common-js` manual and JSDoc:
  https://guacamole.apache.org/doc/gug/guacamole-common-js.html and
  https://guacamole.apache.org/doc/guacamole-common-js/
- m1k1o/n.eko v3 docs and API direction:
  https://neko.m1k1o.net/docs/v3/introduction,
  https://neko.m1k1o.net/docs/v3/release-notes, and
  https://github.com/m1k1o/neko/issues/371
- demodesk n.eko client component:
  https://github.com/demodesk/neko-client
- Browserbase session and live-view APIs:
  https://docs.browserbase.com/platform/browser/getting-started/create-browser-session,
  https://docs.browserbase.com/reference/api/session-live-urls, and
  https://docs.browserbase.com/platform/browser/long-sessions/overview
- Steel browser/session positioning:
  https://steel.dev/ and
  https://docs.steel.dev/cookbook/playwright#typescript

### Compared with Guacamole

Guacamole exposes deep, directly usable browser-side modules: a full client,
tunnels, display, keyboard, mouse, touchpad/touchscreen, on-screen keyboard, and
recording primitives. Its package boundary makes the hard remote-display parts
available as named concepts; an adopter wires auth/connection choice but does
not reimplement the client.

Remote Surface currently has the right nouns in pieces. The root exports
`RemoteSurface`, lease managers, adapters, client helpers, IME helpers, and
backend adapters (`packages/remote-surface/src/index.ts:9`,
`packages/remote-surface/src/index.ts:38`,
`packages/remote-surface/src/index.ts:97`,
`packages/remote-surface/src/index.ts:111`). The actual concrete viewer is not
there. `RemoteSurfaceViewer` is an interface, and `client/index.ts` exports
policies, geometry, control reducers, media helpers, and classifiers
(`packages/remote-surface/src/client/index.ts:18`,
`packages/remote-surface/src/client/index.ts:24`). A senior adopter will ask:
"Where is the thing equivalent to `new Guacamole.Client(tunnel)`?"

### Compared with n.eko / demodesk-neko-client

n.eko is a deployable remote browser/desktop system. Its v3 direction explicitly
calls for a framework-independent client library with connection, media, and
control interfaces. The demodesk client went the other way for usability: it
published a self-contained Vue component whose methods/state/events can be used
directly.

Remote Surface sits awkwardly between those two. It defines `NekoClientApi` and
`NekoSurfaceAdapter`, but the adapter asks the host to supply the hard client
bridge (`packages/remote-surface/src/adapters/neko-surface-adapter.ts:47`,
`packages/remote-surface/src/adapters/neko-surface-adapter.ts:148`). If
`sendText` is not supplied, it logs and returns `false`
(`packages/remote-surface/src/adapters/neko-surface-adapter.ts:356`). The
working `@demodesk/neko` integration is the console's private
`neko-client.ts`. External adopters would have to rediscover that file or
rebuild it.

### Compared with Browserbase / Steel / Browserless-style SDKs

Commercial browser-session APIs make the session object the product: create a
session, get connection/live-view URLs, configure keep-alive/timeout/context,
connect with Playwright/Puppeteer/CDP, and inspect live or recorded sessions.
They hide most allocation and observer plumbing behind durable session APIs.

Remote Surface's README says the package is not a complete hosted streaming
service and that hosts still own routes, auth, persistence, Docker allocation,
and product chrome (`packages/remote-surface/README.md:65`,
`packages/remote-surface/README.md:21`). That boundary is reasonable, but it
means the package must be excellent at the narrower thing it does own: an
embeddable headless viewer core and backend adapters. Today the README's
"client/viewer" row promises DOM controllers, viewport/control policies, IME,
clipboard policy, media settle, visual quality, and telemetry interfaces
(`packages/remote-surface/README.md:69`), while the export map mostly provides
interfaces and helpers, not a composed implementation
(`packages/remote-surface/package.json:37`,
`packages/remote-surface/src/client/index.ts:24`).

### What an external senior adopter would find missing or confusing

- No concrete headless viewer entry point such as
  `createRemoteSurfaceViewer()` or `useRemoteSurfaceViewer()`.
- No packaged n.eko web client despite the public `NekoSurfaceAdapter` requiring
  a substantial `NekoClientApi` bridge
  (`packages/remote-surface/src/adapters/neko-surface-adapter.ts:1`,
  `packages/remote-surface/src/adapters/neko-surface-adapter.ts:47`).
- No packaged n.eko server companion despite the reference implementation having
  the working companion.
- `./reference` is exported as a public subpath, which tells adopters the
  reference wire contract is part of the generic API
  (`packages/remote-surface/package.json:74`).
- Deprecated reference-shaped symbols are reachable from the root export
  (`packages/remote-surface/src/index.ts:38`,
  `packages/remote-surface/src/leases/index.ts:49`,
  `packages/remote-surface/src/server/index.ts:29`).
- The package is named as if ready for npm but remains private
  (`packages/remote-surface/package.json:2`,
  `packages/remote-surface/package.json:4`).
- The minimal consumer example still requires the host to provide lifecycle
  functions and a n.eko client bridge
  (`packages/remote-surface/README.md:82`,
  `packages/remote-surface/README.md:101`,
  `packages/remote-surface/README.md:128`).

## 4. Target Public API

The standalone package should make the "great viewer in a day" path boring:

```ts
import {
  createHeadlessRemoteSurfaceViewer,
  createRemoteSurfaceSessionClient,
} from "@opendatalabs/remote-surface/client";
import { createNekoWebClientApi } from "@opendatalabs/remote-surface/backends/neko/client";

const session = createRemoteSurfaceSessionClient({
  eventsUrl,
  inputUrl,
  viewportUrl,
  renew: async () => fetchFreshDescriptor(),
});

const neko = await createNekoWebClientApi({
  serverPath,
  statusPath,
  login,
});

const viewer = createHeadlessRemoteSurfaceViewer({
  session,
  surface: neko,
  container,
  mediaElement,
  textInputElement,
  telemetry,
});

await viewer.start();
```

Server-side:

```ts
import { createTokenSessionStore } from "@opendatalabs/remote-surface/server";
import { createNekoCompanion } from "@opendatalabs/remote-surface/backends/neko/server";

const sessions = createTokenSessionStore();
const companion = createNekoCompanion(nekoTarget, { browserControl });
```

Optional deployment:

```ts
import { createNekoDockerAllocator } from "@opendatalabs/remote-surface/backends/neko/docker-allocator";
```

That API keeps the host responsible for auth, product routes, persistence,
policy, and UI, while the package owns the specialized remote-surface mechanics:
viewer lifecycle, input bridging, geometry, media settle, reconnect, telemetry,
backend client integration, and backend companion behavior.

## 5. Migration Plan

1. Behavior-preserving: move generic session and lease cores out of
   `src/reference/`.

   - Create `src/server/token-session-store.ts` or
     `src/sessions/token-session-store.ts`.
   - Create `src/leases/surface-lease-manager.ts`.
   - Make current `reference/*` files import/re-export the new core.
   - Keep all existing tests green before any rename of public symbols.

2. Behavior-preserving: make compatibility explicit.

   - Add `src/compat/pdpp-reference/`.
   - Move wire parsers/builders/fixtures there.
   - Keep `./reference` as deprecated alias for one release, but stop presenting
     it as the path new adopters should use.
   - Update README examples away from `BrowserSurface*`,
     `StreamingSession*`, `_ref`, `run_id`, and `interaction_id`.

3. Behavior-preserving first, then API cleanup: package the n.eko web client.

   - Extract `neko-client.ts` into `packages/remote-surface/src/backends/neko/client/`.
   - Export `createNekoWebClientApi`.
   - Replace the console shim with a package import.
   - Only after parity, remove console-local duplicate helpers.

4. Behavior-preserving first, then new capability: extract the headless viewer
   controller.

   - Move attach/reconnect, viewport observer/posting, media settle, input
     dispatch, clipboard, presentation state, and telemetry into
     `createHeadlessRemoteSurfaceViewer`.
   - Leave `StreamOverlay`, `CornerControls`, `StreamInteractionDock`, dialogs,
     route actions, and product copy in the console.
   - Dogfood by rewriting the console viewer to consume the headless controller.

5. Behavior-preserving: package the n.eko server companion.

   - Move `createNekoCompanion` to `./backends/neko/server`.
   - Keep reference-specific target resolution in
     `reference-implementation/server/streaming/`.
   - Make focus/metric binding names configurable.

6. Optional module: extract Docker allocation last.

   - Move only if another product will use it.
   - Make namespace, labels, image, network, profile store, URL templates, and
     port policy configurable.
   - Keep it server-only and optional so the browser package remains small.

7. New capability/docs: add an external-adopter cookbook and conformance harness.

   - One minimal React viewer.
   - One vanilla DOM viewer.
   - One n.eko server companion example.
   - One "host supplies auth/routes/persistence" example.
   - Tests that prove the examples do not import `apps/console` or
     `reference-implementation`.

8. Release prep.

   - Remove `private: true` only after export paths and docs are stable.
   - Audit root exports for deprecated aliases.
   - Add package-size and browser/server subpath checks.
   - Run the package verification scripts listed in
     `packages/remote-surface/package.json:95`.

## Confidence

High confidence in the residue inventory and capability gap: it is based on
direct file:line inspection. Medium confidence in the exact target API shape:
it follows the existing code seams and prior-art comparison, but should be
validated by extracting the console viewer as the first dogfood consumer.

## Adapter integration friction (2026-07-06)

Dogfood context: rewired `packages/remote-surface/playground` to use the package
CDP path by default, with the old hand-rolled CDP driver retained behind
`--driver=legacy`, then ran the probe-page acceptance journey against real
Chromium.

- The package export map advertised `./backends/cdp`, but the checked-in `dist/`
  tree did not initially contain that subpath. A fresh package build generated
  it, so adopter installs would only work if source and dist are kept in lockstep.
- There is no ready-made transport bridge for a Playwright/Patchright
  `CDPSession`. The consumer has to adapt `send()` and `on()` manually, and
  Patchright's `send` must stay bound to the session object or it loses its
  internal channel.
- `CdpSurfaceAdapter.mount()` requires an `HTMLElement` even when the consumer is
  driving a server-side injected CDP transport and not using DOM event capture.
  The playground had to provide a fake element only to satisfy the adapter
  lifecycle and geometry contract.
- Screencast options are split: the backend accepts options, but
  `CdpSurfaceAdapter` hardcodes JPEG quality. The playground quality control can
  be A/B tested with the legacy driver, but package-driver quality is not cleanly
  configurable today.
- Input-path telemetry is not exposed by the adapter. To prove per-character
  `Input.insertText` usage, the playground had to wrap CDP transport commands and
  infer the path from methods/params.
- Fake-session tests missed two real-Chromium setup requirements: enabling the
  Page domain before screencast and enabling touch emulation for mobile/touch
  viewports. Those are now package behavior, not playground workarounds.
- Fake-session tests also missed a key-event semantic: text-bearing keydown
  events need CDP `keyDown`; `rawKeyDown` is appropriate for non-text keys. Real
  Chromium did not submit the probe form on Enter until the backend made that
  distinction.

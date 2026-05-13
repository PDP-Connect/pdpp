---
date: 2026-05-13
status: decided
scope: extract-remote-surface-streaming-architecture
---

# Remote Surface Streaming Extraction Closeout

## Publication Readiness

This tranche moves the implementation materially closer to an OSS-spinnable
`@pdpp/remote-surface` package rather than only reorganizing internal code.
The package now owns generic protocol helpers, the streaming session store,
client geometry/viewport/clipboard/media policies, n.eko and CDP client
adapter seams, backend-safe descriptors, diagnostics helpers, lease substrate,
and test fixtures. PDPP-specific routes, owner auth, run timelines, connector
handoff, Docker/Compose allocation, profile persistence, and dashboard product
UI remain host-owned.

The package is not ready to publish as a standalone OSS artifact yet. The
remaining work is mostly packaging and host-adapter hardening rather than
finding the boundary: live CDP/n.eko smoke still needs environment-backed
evidence, package `check` is blocked by the workspace Biome nested-root config,
and several compatibility shims still preserve existing reference/dashboard
import paths.

## Compatibility Shims Left In Place

- `reference-implementation/server/streaming/sessions.js` remains a reference
  import-path shim over `@pdpp/remote-surface/server` so current reference
  routes and tests keep their route envelopes, URLs, and auth ownership.
- `reference-implementation/server/streaming/routes.js` remains the host-owned
  `_ref` route adapter. It now uses package protocol helpers, but it still owns
  owner auth, token route names, n.eko proxy cookies, telemetry sinks, and spine
  events.
- Dashboard re-export shims such as `stream-geometry.ts`,
  `stream-viewport-classifier.ts`, `stream-viewer-control.ts`,
  `stream-clipboard-policy.ts`, `stream-media-settle.ts`, and
  `stream-viewer-protocol.ts` keep existing test and component imports stable
  while the underlying policy code lives in the package.
- `apps/web/.../stream/neko-client-api-shim.ts` remains the dashboard bridge
  from the module-singleton `neko-client.ts` implementation to the package
  `NekoClientApi` interface.
- `apps/web/.../stream/stream-viewer.tsx` still owns React lifecycle, layout,
  copy, URL resolution, and owner-facing controls. It now constructs
  `NekoSurfaceAdapter` and `CdpSurfaceAdapter` from the package rather than
  owning backend input controllers directly.

## Verification Notes

- Package typecheck and package tests pass, including CDP coordinate mapping
  through object-contain letterboxing.
- Dashboard stream viewer tests and `pdpp-web` TypeScript pass.
- Reference streaming route, session, run-target, CDP adapter, n.eko adapter,
  browser-surface lease, playground, and remote-surface boundary tests pass.
- Import-boundary sweep passes: `packages/remote-surface/src` has no imports
  from reference implementation, dashboard app, polyfill connectors, Docker, or
  server route modules.
- `openspec validate extract-remote-surface-streaming-architecture --strict`
  and `openspec validate add-dynamic-neko-surface-allocation --strict` pass.
- `pnpm --filter @pdpp/remote-surface check` currently fails before file
  analysis because the workspace still has nested Biome root configurations in
  other packages. This is not specific to `@pdpp/remote-surface`, but it keeps
  verification task 7.1 open.

## Remaining Risks

- Gated live CDP and n.eko smoke have not been rerun in this closeout pass.
- CDP fallback mobile IME behavior is package-routed but remains weaker than
  n.eko: it focuses a hidden input and forwards key events, while n.eko has the
  stronger `MobileTextInputController` path. Treat CDP as fallback/debug until
  live mobile evidence proves otherwise.

## Context

The audit considered `remote-browser`, `remote-browser-sandbox`, and `remote-browser-service`.

The best default is CDP-based streaming and control:

- `Page.startScreencast` frames over WebSocket.
- `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.dispatchTouchEvent` for control.
- Device-aware viewport sizing at session start, with later resize if implementation support is already present.

`remote-browser-service` appears to be the strongest fork target because it combines CDP streaming/control with orchestration and session lifecycle ideas. `remote-browser-sandbox` remains important prior art because it explores n.eko and rrweb fallback paths. The current implementation should not choose n.eko for MVP because it is heavier and expands the security/deployment surface.

## Goals

- When a connector run reaches an interaction requiring browser control, notify the owner with a link.
- The link opens a browser stream sized to the user's device.
- The owner can provide mouse, keyboard, and touch input.
- The stream session is bound to one pending run interaction and short-lived.
- The solution reuses existing reference auth/session/token patterns wherever possible.
- The streaming service stays separate from the local collector runner.

## Non-Goals

- Do not build a general remote desktop product.
- Do not use n.eko for MVP.
- Do not solve every cross-origin iframe/OOPIF edge before a real connector requires it.
- Do not store streamed frames or durable credentials.
- Do not make streaming a PDPP Core requirement.

## Design

### Surfaces

The reference should add a streaming companion surface with three parts:

1. Control-plane mint route: creates a short-lived, single-use streaming session for the current pending run interaction.
2. Viewer route: renders the owner-facing stream page and device-sized input surface.
3. WebSocket or event channel: carries frames and input events between viewer and browser session.

The stream session is not a collector credential. It cannot ingest records, read records, approve consent, or mutate unrelated runs.

### Authorization

The implementation should reuse existing reference patterns before inventing new auth:

- Owner-authenticated dashboard can mint the session.
- The streaming link carries an opaque signed or server-stored short-lived token.
- The token is scoped to run id, interaction id, device/browser session id, and expiry.
- The token is single-use where practical and revocable/cancelled when the interaction resolves or run ends.
- The stream viewer does not need an owner password after link mint, but token TTL must be short and bound.

If existing device enrollment or owner session helpers cover part of this, reuse them. If not, add the smallest store/helper in the reference control plane and test it directly.

### CDP Streaming

The MVP should use CDP:

- Start screencast at JPEG quality suitable for mobile and desktop.
- Encode frame metadata sufficient for aspect ratio and coordinate mapping.
- Map pointer/touch/keyboard events from the viewer to CDP input events.
- Acknowledge frames to avoid uncontrolled buffering.
- Resize or start with viewport dimensions derived from the viewer device.

### Relationship To Collector

The local collector runner may own the browser process, but streaming remains a companion session. The collector can request or expose a manual-action stream endpoint, but collector pairing does not automatically grant stream access.

### Prior Art Handling

- `remote-browser-service`: preferred implementation source for CDP session lifecycle and control patterns.
- `remote-browser-sandbox`: required comparison source for n.eko/rrweb/mobile-input edge cases.
- `remote-browser`: lighter Cloudflare/browser-streaming fallback if service assumptions are too heavy.

### Prior Art Verdict (recorded)

After inspection, `remote-browser-sandbox/server/src` is the deepest CDP fork
(neko proxy, rrweb, audio-stream, ~3KB CDP map plus a 44KB cdp-stream module).
We did NOT take that surface; it includes neko/rrweb fallbacks that the MVP
explicitly excludes and that materially expand the security and deployment
footprint. We took the leaner shape from
`remote-browser-service/sprite-server/src/{streamer,input-handler}.ts` —
straight CDP `Page.startScreencast` frames, `Input.dispatch{Mouse,Key,Touch}Event`
mapping, no neko, no rrweb. The MVP keeps that lean shape and adds
back-pressure ack and viewport via `Emulation.setDeviceMetricsOverride`. The
companion is hidden behind a small interface so tests use a deterministic mock
and a future real CDP adapter can be wired without touching routes or auth.

`remote-browser` (Cloudflare worker) was reviewed; its assumptions around a
managed worker and Durable Objects don't fit the local-first reference shape.

## Owner Self-Review

- Standards posture: safe if all surfaces remain reference-only and interaction-scoped.
- Security posture: acceptable only with short TTL, scoped token, no credential persistence, no broad browser access, no frame recording by default.
- UX posture: high value; solves real connector dead ends without Docker GUI hacks.
- Scope risk: high if streaming is fused with collector lifecycle or becomes a general browser product. Keep it narrow.

Confidence: high for CDP MVP and high that n.eko should not be MVP. Moderate uncertainty remains around exact prior-art reuse until code is inspected during implementation.

## Acceptance Checks

- `openspec validate add-run-interaction-streaming-companion --strict`
- A unit test proves streaming session token scope, expiry, and single-run binding.
- A route test proves unauthenticated or stale streaming links fail.
- A UI or route-level test proves manual-action interaction can mint a streaming link.
- A non-live CDP fixture or mock proves frame and input event mapping.
- A review of `remote-browser-sandbox` is recorded before final implementation choice.
- `pnpm --dir reference-implementation test`
- `pnpm --dir apps/web run types:check`
- `pnpm --dir apps/web run check`
- `pnpm --dir apps/web run build`


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
back-pressure ack and viewport via `Emulation.setDeviceMetricsOverride`.

Both `remote-browser-service` and `remote-browser-sandbox` reach CDP via
`patchright` (a Playwright fork). We deliberately did not pull a
browser-automation library into the reference server: the streaming surface
only needs JSON-RPC over a CDP page-target WebSocket, and Playwright's session
manager would be dead weight for that. `cdp-adapter.js` therefore connects
directly to the CDP WebSocket using Node's native `WebSocket` (Node 22+) and
handles JSON-RPC dispatch, pending-response correlation, screencast frame
fan-out, and back-pressure ack itself.

`remote-browser` (Cloudflare worker) was reviewed; its assumptions around a
managed worker and Durable Objects don't fit the local-first reference shape.

### Real Adapter And Honest Unavailable State

The default companion factory resolves a CDP page-target WebSocket URL from
`PDPP_RUN_INTERACTION_CDP_WS_URL` (or `opts.streamingCdpWsUrl`). When neither
is set, the factory returns `null` and the mint route fails closed with
`503 streaming_companion_unavailable`. We never hand out a token that can only
fail at attach time — that creates a dead "Start streaming" button which the
operator can only diagnose by reading server logs.

The dashboard viewer recognizes the typed unavailable error and surfaces a
configuration-pointer state instead of the canvas. Until streaming is wired,
the operator falls back to satisfying the interaction via the local collector
runner.

### Optimistic Collection Profile Posture

The reference implementation accepts either a single global page-target CDP
WebSocket URL (`PDPP_RUN_INTERACTION_CDP_WS_URL`) or a Chrome DevTools HTTP
base (`PDPP_RUN_INTERACTION_CDP_HTTP_URL`) and resolves a fresh page target
per streaming session from that base. A real Collection-Profile-aware
deployment would resolve a per-`browser_session_id` URL from a control-plane
registry: when a connector emits a manual-action interaction from a paired
local collector, that collector's browser session would be the streaming
target. The plumbing for "control plane → browser session → CDP target URL"
is **not** part of PDPP Core today and should not be silently standardized
here. We document it as **optimistic reference behavior requiring human-owner
alignment**:

- The Collection Profile spec does not yet name a binding between
  `browser_session_id` and a streamable CDP target.
- The runtime does not advertise `runtime_capabilities.cdp_streaming` on
  collectors that could host such a target.
- The mint route does not yet pass `browser_session_id` to the URL resolver.
- The DevTools HTTP path is operator-friendly reference config, not the final
  collector/session registry. It exists so the reference can be exercised
  against a real Chrome with `--remote-debugging-port` instead of forcing the
  operator to copy out a page-target ws URL.

When the human owner aligns on the right binding shape, the adapter's
`createDefaultStreamingCompanionFactory` should be extended to take a
`resolveTargetForSession({ browser_session_id })` resolver instead of a fixed
URL or HTTP base. Until then, this tranche stays reference-only with two
env-driven inputs and an honest fail-closed default.

### DevTools HTTP Target Resolution And Live Smoke Proof

In addition to `PDPP_RUN_INTERACTION_CDP_WS_URL`, the reference adapter
recognizes `PDPP_RUN_INTERACTION_CDP_HTTP_URL` (e.g. `http://127.0.0.1:9222`).
When the HTTP base is set:

- the default companion factory issues `PUT /json/new?about:blank` to mint a
  fresh page target per streaming session (with a GET fallback for older
  Chromium builds that do not honor PUT);
- the response's `webSocketDebuggerUrl` becomes the page-target ws URL the
  CDP companion connects to;
- on companion stop, the adapter best-effort calls `GET /json/close/<id>` to
  ask Chrome to close that target. Failures are logged but do not break the
  streaming session lifecycle on the server side.

Errors are typed (`cdp_http_url_invalid`, `cdp_http_unreachable`,
`cdp_http_create_failed`, `cdp_http_no_ws_url`, `cdp_http_parse_failed`) so
the route layer can surface operator-readable messages and so the dashboard's
configuration-pointer state remains the only path the operator sees when the
companion truly cannot stream.

A reference-only live smoke harness lives in
`reference-implementation/test/run-interaction-stream-cdp-live.test.js`. It is
**skipped by default** (it only runs when `PDPP_TEST_LIVE_CDP=1`) so normal
CI continues to pass without a real browser. When enabled it:

- launches a headless Chrome on an ephemeral port if a Chrome/Chromium binary
  is discoverable (or `PDPP_TEST_CDP_BIN` is set), or attaches to an
  externally provided `PDPP_TEST_CDP_HTTP_URL` / `PDPP_TEST_CDP_WS_URL`;
- starts the companion, awaits a real screencast frame, acks it, dispatches a
  paste input event, and verifies the underlying CDP session is alive via
  `Runtime.evaluate`;
- tears down the launched browser and the per-session DevTools target.

The harness exists to catch adapter or wire-format regressions against real
Chromium that the deterministic mocks cannot see. It is a proof, not a
contract: nothing in PDPP Core or the Collection Profile depends on it.

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


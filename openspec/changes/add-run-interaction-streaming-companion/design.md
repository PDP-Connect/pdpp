## Context

The audit considered `remote-browser`, `remote-browser-sandbox`, and `remote-browser-service`.

The best default remains CDP-based streaming and control:

- `Page.startScreencast` frames over WebSocket.
- `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.dispatchTouchEvent` for control.
- Device-aware viewport sizing at session start, with later resize if implementation support is already present.

`remote-browser-service` appears to be the strongest fork target because it combines CDP streaming/control with orchestration and session lifecycle ideas. `remote-browser-sandbox` remains important prior art because it explores n.eko and rrweb fallback paths. After Cloudflare-style challenge testing, the reference will add n.eko as an alternate backend while keeping CDP as the default. The n.eko path is still reference-only and interaction-scoped; it is not a CAPTCHA bypass feature.

## Goals

- When a connector run reaches an interaction requiring browser control, notify the owner with a link.
- The link opens a browser stream sized to the user's device.
- The owner can provide mouse, keyboard, and touch input.
- The stream session is bound to one pending run interaction and short-lived.
- The solution reuses existing reference auth/session/token patterns wherever possible.
- The streaming service stays separate from the local collector runner.

## Non-Goals

- Do not build a general remote desktop product.
- Do not make n.eko the default backend.
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

### n.eko Alternate Backend

The reference should also support a n.eko backend for user-present personal-server browser sessions:

- Keep the same owner-authenticated mint and short-lived run-interaction token lifecycle.
- Register streaming targets as typed descriptors: legacy CDP `ws_url` remains supported, and n.eko targets name a loopback same-origin sidecar base URL plus optional screen config.
- Route n.eko through a token-scoped same-origin proxy instead of exposing the sidecar directly.
- Require the browser-facing origin that serves `/neko/*` to forward raw WebSocket upgrades to the reference AS; HTTP-only dashboard rewrites are not enough for native n.eko signaling.
- Prefer the native n.eko WebRTC/control UI for the owner-facing surface. CDP may still be used behind the sidecar for metadata, window bounds, and health checks.
- Do not add stealth/evasion behavior. If anti-abuse infrastructure still refuses the session, surface that as a compatibility boundary and fall back to official export/OAuth/local-browser paths.

### Relationship To Collector

The local collector runner may own the browser process, but streaming remains a companion session. The collector can request or expose a manual-action stream endpoint, but collector pairing does not automatically grant stream access.

### Prior Art Handling

- `remote-browser-service`: preferred implementation source for CDP session lifecycle and control patterns.
- `remote-browser-sandbox`: required comparison source for n.eko/rrweb/mobile-input edge cases.
- `remote-browser`: lighter Cloudflare/browser-streaming fallback if service assumptions are too heavy.

### Prior Art Verdict (recorded)

After inspection, `remote-browser-sandbox/server/src` is the deepest browser-control fork
(neko proxy, rrweb, audio-stream, ~3KB CDP map plus a 44KB cdp-stream module).
The CDP default took the leaner shape from
`remote-browser-service/sprite-server/src/{streamer,input-handler}.ts` —
straight CDP `Page.startScreencast` frames, `Input.dispatch{Mouse,Key,Touch}Event`
mapping, no neko, no rrweb. The MVP keeps that lean shape and adds
back-pressure ack and viewport via `Emulation.setDeviceMetricsOverride`.

For the alternate backend, borrow only the n.eko pieces from
`remote-browser-sandbox`: same-origin `/neko` proxying, screen/window control
shape, and deployment assumptions. Do not import the full sandbox product or
its prototype auth defaults unchanged.

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

### Docker n.eko SLVP

The local Docker proof uses an optional `docker-compose.neko.yml` overlay
instead of making n.eko part of the default stack. The overlay keeps n.eko on
the private Compose network and points the reference server at the service DNS
target (`http://neko:8080/neko`) while only the WebRTC media mux ports are
published to the host. The reference proxy allowlist is explicitly scoped to
that private host (`neko:8080`), so the sidecar remains hidden behind the
stream-token-scoped `/neko/*` proxy without coupling n.eko to the lifecycle of
a specific `reference` container instance.

n.eko is configured with `NEKO_SERVER_PATH_PREFIX=/neko` so the direct
`@demodesk/neko` client mount, HTTP API calls, and WebSocket signaling all stay
under the browser-facing same-origin `/neko` path. Reverse proxies or dashboard
composition layers must forward raw WebSocket upgrades for that path. HTTP-only
rewrites are not sufficient. Because the dashboard origin may canonicalize
`/neko/` to `/neko`, the reference proxy normalizes exact `/neko` requests back
to the upstream `/neko/` root before proxying.

The Docker overlay uses n.eko's `noauth` member provider and enables
`PDPP_NEKO_PROXY_AUTOLOGIN=1` for the reference service. The stream-token entry
route still sets the scoped `/neko` cookie first, then redirects to `/neko`
with cache-busting plus dummy `usr`/`pwd` query params so the owner reaches the
native WebRTC control surface without a second sidecar login prompt.

The developer path is:

- start with `pnpm docker:neko` or the equivalent two-file Compose command;
- open `/dashboard/stream-playground?backend=neko`;
- let the playground endpoint register a n.eko descriptor for the synthetic
  interaction instead of launching the CDP data-URL page.

Operationally, n.eko must remain reachable from the reference container via the
private Docker DNS name. Earlier drafts used `network_mode: service:reference`,
but that was rejected because recreating only `reference` stranded n.eko in the
old network namespace and made loopback `127.0.0.1:8080` / `127.0.0.1:9222`
fail from the reference process.

Chromium still binds DevTools to loopback inside the n.eko container even when
started with a broad remote-debugging address. The PDPP n.eko image therefore
runs a small internal TCP proxy on `9223` and points
`PDPP_NEKO_CDP_HTTP_URL` at `http://neko:9223`. This keeps assistive CDP
features available to the reference service without exposing DevTools on the
host or coupling n.eko to the reference container's network namespace.

WebRTC media reachability is separate from the dashboard's HTTPS route and the
same-origin `/neko/*` signaling proxy. A public web route does not make WebRTC
UDP/TCP candidates reachable. The fast local path advertises the Docker host
address with `NEKO_WEBRTC_NAT1TO1`; the reliable public-device/WAN path adds the
optional Compose `turn` profile (`pnpm docker:neko:turn`) and advertises TURN
servers through `NEKO_WEBRTC_ICESERVERS`. TURN is a fallback relay, not the
preferred path: browsers should still choose direct candidates when direct LAN
or public NAT traversal works.

Because the Docker stack runs production-mode bundles, the playground is
enabled by an explicit `PDPP_ENABLE_STREAM_PLAYGROUND=1` flag on both the web
and reference services. The default Compose stack does not set that flag, so a
hardened production deployment still 404s the playground route and does not
register `/_ref/dev/playground/session`.

The overlay builds a thin local image from the pinned upstream n.eko Chromium
image. Its behavioral overrides are intentionally narrow: a local Chromium
launcher with Docker-required `--no-sandbox`/software-rendering flags, an
Openbox no-decoration rule, a dummy Xorg mode list tuned for popular
iPhone/Samsung/Pixel/iPad CSS viewports, and main/mq/lq VP8 capture pipelines
with n.eko's WebRTC bitrate estimator enabled. Browser/device emulation still
uses the exact owner viewport when the stealth mode allows it; the X11
framebuffers are often 8px-aligned so the n.eko capture path does less
resampling.

This remains a local SLVP. It does not add n.eko dynamic allocation, pooling,
or stealth/evasion behavior. If a provider refuses a user-present remote
browser session, the reference should surface that as a compatibility boundary
rather than attempting to disguise the browser.

### Stream Interaction Control Core

The n.eko UX hardening surfaced a recurring failure mode: the viewer was
reacting directly to browser events, n.eko status, timers, clipboard events,
and WebRTC media shape from one large React component. That makes mobile
rotation, keyboard occlusion, pointer mapping, copy/paste, and media quality
hard to reason about and hard to replay after a real-device regression.

The next tranche should treat the owner-facing stream as a small closed-loop
control system:

1. Browser, n.eko, WebRTC, clipboard, and SSE payloads are normalized into
   explicit facts.
2. Pure policy modules classify those facts: viewport behavior, keyboard
   occlusion, browser chrome changes, media settling, and protocol payload
   validity.
3. React runs the side effects: opening EventSource, POSTing viewport/input,
   invoking n.eko helpers, managing timers, focusing the keyboard overlay, and
   writing redacted telemetry.
4. Acks, status samples, WebRTC stats, and failures feed back into the same
   control loop instead of being treated as unrelated callbacks.

Do not introduce a broad state framework for this tranche. The desired shape is
small pure modules with a simple reducer/effect vocabulary and replay fixtures.
React should remain the lifecycle/wiring layer, not the source of policy truth.

The control core should preserve four distinct coordinate and size domains:

- local layout viewport and shell/container geometry;
- local visual viewport and occlusion geometry;
- requested remote browser viewport/screen geometry;
- actual n.eko/X11/WebRTC media geometry.

The viewer should not collapse those domains into one "width/height" number.
For example, mobile software keyboard occlusion is usually a local visible-area
change, not a reason to resize the remote browser. Conversely, device rotation
is a true target-viewport change, but should not be marked settled until n.eko
screen status, intrinsic video dimensions, and WebRTC inbound frame stats agree
for consecutive samples.

The initial implementation should be staged:

- add protocol validators for SSE and n.eko status payloads;
- add pure viewport/keyboard classification using runtime geometry rather than
  user-agent branching;
- add media settle logic that compares requested viewport, n.eko screen status,
  media intrinsic size, and selected WebRTC stats;
- add replay fixtures so real Android/iOS regressions become deterministic
  tests before another browser-specific patch is made;
- only then integrate the core into `stream-viewer.tsx`.

### n.eko UX Completion Tranche

The first n.eko pass proved that the owner can see and interact with the
stream, but it is still not the target UX. The bar is:

- the owner sees a PDPP-controlled browser surface, not n.eko branding,
  resolution menus, sidebars, product chrome, or unexpected Chrome extension
  pages;
- desktop and mobile input land exactly where the owner expects, with no cursor
  offset and no mismatch between visible pixels and n.eko's coordinate model;
- phone users can tap, scroll, drag, type, paste, dismiss/reopen the software
  keyboard, rotate, and reconnect without learning a remote-browser UI;
- resizing is polished: exact 1:1 pixels are used where X11/Chromium/n.eko can
  represent the local frame, otherwise the visible browser viewport is exact
  and the small residual capture gutter is locally cropped/remapped;
- mobile keyboard focus/blur does not make the remote browser chase transient
  visual-viewport height changes during the OS keyboard animation;
- stealth-sensitive sessions keep browser/profile ownership outside the viewer.

The implementation should now lean harder into `remote-browser-sandbox` as a
migration source. The highest-confidence path is to port the direct
`@demodesk/neko` component mount (`neko.setUrl()`, `neko.login()`,
`neko.connect()`) instead of continuing to embed the upstream n.eko room page in
an iframe. Direct component control gives PDPP access to n.eko's overlay
textarea and internal screen-size state, which are the two mechanisms the
sandbox used for mobile keyboard/paste and cursor-aligned viewport remapping.

The reference still keeps n.eko behind the same short-lived stream token and
same-origin `/neko/*` proxy. What changes is the owner-facing surface:

```
owner dashboard
  └─ token-scoped stream page
      └─ direct n.eko client mount
          └─ same-origin /neko signaling proxy
              └─ n.eko sidecar display + native input
                  └─ browser owner
```

Browser ownership has two modes:

- **n.eko-owned Chromium** for the local SLVP and development proof. PDPP may
  control X11 modes, Chromium app-window bounds, and n.eko screen selection.
- **browser-owner/Patchright-compatible Chrome** for stealth-sensitive runs.
  The browser owner is responsible for coherent launch-time profile, proxy,
  user data dir, viewport class, DPR, touch capability, UA/client hints, and
  Chrome channel. PDPP/n.eko streams and controls that browser without taking
  over page instrumentation.

Patchright's current published best practice for "without fingerprint
injection" is persistent Chrome, headful mode, no default viewport override,
and no custom headers/user agent. Its docs also call out `Runtime.enable` and
command-flag leaks. Therefore PDPP should classify n.eko UX helpers by stealth
budget:

- **strict**: direct n.eko mount, native input, overlay focus on user gesture,
  n.eko/X11/display sizing, app-window bounds, local crop/remap, token-scoped
  proxy, no page scripts, no CDP paste fallback, no runtime page focus bridge.
- **balanced**: strict plus launch-time browser profile/device selection owned
  by the browser owner, low-frequency browser-level status/window checks, and
  the RBS-style remote editable focus bridge (`Runtime.addBinding` plus
  `Page.addScriptToEvaluateOnNewDocument`) needed for automatic mobile keyboard
  open/blur. This is not strict-stealth, so strict remains available when page
  instrumentation is unacceptable.
- **assistive**: balanced plus explicit page-level helpers such as
  `Input.insertText`, `Runtime.evaluate` copy/status, user-agent override, and
  other CDP convenience features. Assistive mode is not the stealth default.

This keeps the product goal as maximum UX, not minimum UX: polish should come
from native n.eko/WebRTC input, direct overlay focus, display geometry control,
and browser-owner launch coherence. Page-level automation is a conditional
enhancement, not the foundation. Audio remains a follow-up decision: n.eko can
carry WebRTC audio, but this tranche proves video/control/paste/mobile
interaction quality for manual-action completion first.

#### Migration Classification

The bounded worker pass on 2026-05-06 produced this lift map:

| Source | Classification | PDPP handling |
|---|---|---|
| `client/src/neko-client.ts` from `remote-browser-sandbox` | lift | Port to a client-only web module; dynamic-import `@demodesk/neko`; expose `start`, `stop`, `focusOverlay`, and viewport-layout hooks. |
| `client/src/focus-events.ts` | lift, stealth-gated | Reuse the callback shape, but enable only outside `strict` mode because page focus telemetry requires page-level instrumentation. |
| `server/src/neko-proxy.ts` screen/window helpers | lift/adapt | Keep the n.eko HTTP screen ranking and browser window-bounds logic; adapt auth/proxy/session plumbing to PDPP's stream-token companion. |
| `server/src/neko-proxy.ts` persistent page CDP helpers | adapt/gate | Browser-level status/window operations are acceptable. Page focus telemetry is allowed in `balanced`; paste/copy/status Runtime helpers remain `assistive`. |
| `scripts/audit/touch-focus-smoke.mjs` | lift/adapt | Convert to PDPP live smoke scripts for phone/touch/focus/paste regression coverage. |
| Docker Chromium launcher, Openbox rule, policies, xorg modes | lift | Keep n.eko's default supervisord; override Chromium launcher/policies/window rule and provide mobile/tablet modes. |
| Custom `supervisord.conf` and `start-neko.sh` socket waiting | reject | Sandbox history showed these caused cold-start/FATAL races. Let upstream n.eko supervisord retry. |
| Sandbox rrweb, form overlay, fast decode, generic tab/session browser, proxy preset UI | reject | These are sandbox experiments or product-shell concerns, not PDPP streaming completion requirements. |
| TURN/cross-network WebRTC | implement opt-in | Required for reliable phone-over-WAN use beyond the local `peregrine-dev` proof. Add an authenticated coturn profile; keep direct ICE fastest/default when it works. |

Important sandbox history:

- PR #1 initially shipped an iframe n.eko viewer; that was not the final UX.
- The later direct Vue mount (`a223356`) unlocked n.eko overlay focus and input fidelity.
- Keyboard/paste polish came from focusing n.eko's own overlay textarea (`c5863d8`) and later focus hardening (`58370bc`, `72c0ada`, `e13913a`).
- Viewport work had failed intermediate crop hacks (`9c1aad4`, then reverted by `949702a`). The final lesson is not "crop everything"; it is "keep screen/window/browser geometry coherent, and only crop/remap residual capture gutters."
- Docker reliability improved after reverting custom supervisord/socket gating (`5d427fd`, `347f565`) and restoring only the Chromium override (`ca39ced`).

#### Acceptance Bar

The tranche is not complete until these checks pass:

- Chrome-free stream: no n.eko room UI, no n.eko branding, no forced extension page, and no unexpected browser tab/address chrome.
- Desktop pointer alignment: click-to-remote deviation <= 4 CSS px at 1x DPR and <= 8 CSS px at 2x DPR.
- Mobile tap alignment: tap-to-remote deviation <= 10 CSS px; no tap lands on a different remote element.
- Viewport mismatch: exact 1:1 when supported; otherwise visible viewport mismatch <= 8 px in width buckets and <= 4 px in height, with aspect error <= 1%.
- Paste: local-to-remote paste appears in the focused remote field within 500 ms and never lands in the local dashboard DOM.
- Clipboard controls: mobile users have explicit copy/paste controls in the stream chrome so clipboard access happens under user activation instead of depending on Android long-press menus.
- Keyboard: mobile soft keyboard opens on user tap, dismisses on remote blur or explicit user dismissal, and reopens without a full stream reload.
- Resize/orientation: orientation changes flush viewport handling within 250 ms after settling; ordinary resize posts within debounce + RTT.
- Reconnect: refresh/app switch/network restore either resumes the stream or shows a terminal, actionable state within 5 seconds.
- True 1:1 probes remain tracked separately from perceptual 1:1 so we can adopt exact modes whenever n.eko/X11/Chromium support them.

#### Viewer Support Library Stack

The direct n.eko client remains the remote browser/session layer. PDPP should
not rebuild mature local-viewer mechanics from scratch when active, adopted
libraries can own them without affecting the remote browser fingerprint. The
boundary is:

- local viewer mechanics may use libraries for coordinate transforms and later
  shell shortcut or gesture recognition;
- PDPP keeps policy decisions: which viewport is plausible, when to remote
  resize, when to suppress keyboard-shaped resizes, which shortcuts cross the
  stream boundary, and which helpers are allowed under each stealth mode;
- no local viewer library may inject into the remote page, override remote
  browser identity, or mutate Patchright-owned launch/device settings.

Adopted mechanics for this tranche:

- `transformation-matrix` owns fit/contain coordinate transforms used by
  pointer remapping and future resize modes.

Deferred mechanics:

- `react-use-measure` should not be used for this tranche. It can own
  `ResizeObserver` lifecycle, but it does not own PDPP's remote-resize policy;
  the first integration made Android viewport churn worse by making the remote
  browser follow measurement intermediates.
- `@use-gesture/react` should be added when PDPP introduces explicit gesture
  modes such as pinch/pan/local zoom. It should not sit in front of n.eko's
  native touch path until there is a concrete gesture policy to enforce.
- `hotkeys-js` should be added only when PDPP introduces shell-level shortcuts
  outside the streamed surface. It must not own copy/cut/paste inside the
  surface because n.eko needs the native key chord to reach its WebRTC input
  path for remote page selections.
- `xstate` should be added only if the viewer lifecycle is extracted into a
  durable state machine. The current resize/clipboard work can remain a small
  controller without that dependency.

#### Visual Quality Telemetry

Stream blur is measured with two diagnostic families:

- pixel-fit telemetry is the high-confidence signal. The viewer records the
  decoded media dimensions, displayed CSS box, displayed physical-pixel box,
  decoded-per-CSS-pixel ratios, decoded-per-physical-pixel ratios, stretch
  ratio, gutter/empty-area ratio, and upscaling flags. This lets a tester see
  whether the stream is CSS-1:1, physical-1:1, upscaled, downscaled, stretched,
  or letterboxed/cropped.
- sharpness telemetry is debug-only and content-dependent. The viewer samples a
  small video frame into an offscreen canvas and reports contrast, Laplacian
  variance, Sobel edge energy, and edge density. These numbers can detect
  regressions on visual-detail-rich pages, but a blank or intentionally soft
  page can score low even when the stream is correct.

The SLVP interpretation rule is: use pixel-fit ratios to diagnose geometry and
scaling correctness; use sharpness scores only as supporting evidence unless the
remote browser is showing a known calibration pattern. A future calibration
route should render a 1px checkerboard, line ramps, slanted edges, small
high-contrast text, and corner/center markers inside the streamed browser so
sharpness and crop/stretch metrics can be compared against fixed ROIs.

#### Mobile Stream UX Hardening

The viewer now treats CSS viewport size and capture size as separate facts. The
CSS viewport remains the logical browser viewport that the owner controls; a
bounded `screenWidth`/`screenHeight` target lets n.eko choose a higher-DPR Xorg
screen bucket when a high-DPR phone would otherwise upscale the decoded media.
The reference backend applies that split by selecting n.eko screen/window bounds
from the capture target while keeping CDP device emulation width/height at the
CSS viewport.

The same pure control reducer governs both remote viewport POSTs and local
n.eko presentation remaps. Orientation changes, same-width mobile browser-chrome
height churn, keyboard occlusion, and zoom are held until the reducer produces a
settled post decision; this avoids the visible intermediate stretch that showed
up during Android rotation.

Keyboard reacquire remains native n.eko input. On coarse-pointer devices, a
stream tap may optimistically focus n.eko's owner-side textarea so Android can
open the software keyboard even if the remote editable was already focused and
does not emit a new focus event. If the server does not confirm remote editable
focus shortly afterward, the viewer rolls the optimistic focus back.

## Owner Self-Review

- Standards posture: safe if all surfaces remain reference-only and interaction-scoped.
- Security posture: acceptable only with short TTL, scoped token, no credential persistence, no broad browser access, no frame recording by default.
- UX posture: high value; solves real connector dead ends without Docker GUI hacks.
- Scope risk: high if streaming is fused with collector lifecycle or becomes a general browser product. Keep it narrow.

Confidence: high for CDP default and high that n.eko should be an alternate backend, not a replacement. Moderate uncertainty remains around Cloudflare-style challenge compatibility until the n.eko path is tested against real challenged sites.

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
- n.eko proxy/control tests prove token-scoped access and no unauthenticated sidecar exposure.
- Native n.eko smoke tests run only when a browser-facing `/neko/*` proxy supports WebSocket upgrade forwarding and the n.eko sidecar is available.

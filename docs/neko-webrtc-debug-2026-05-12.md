# n.eko WebRTC "Starting WebRTC stream..." stuck on Android Brave — 2026-05-12

## Headline

**WebRTC is not actually broken.** The n.eko peer connection from the Android
Brave phone reaches `peer connection state: connected` and `ICE connection
state: connected` on the server side (neko logs, peer_id=2,
session_id=`operator-1BtWc`, 18:39:46Z, UA=`Mozilla/5.0 (Linux; Android 10; K)
... Chrome/148 Mobile Safari`). The Pion `STUN binding request timed out` to
`stun:192.168.1.180:3478` at 18:40:26 is harmless noise — ICELITE is on and the
host-candidate path already succeeded.

The user-visible "Starting WebRTC stream..." overlay comes from `NekoSurface`
(`apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx:3651-3658`)
and clears only when:

```
mediaReady && presentationMatchesRequestedViewport && localSurfaceCanDisplay
```

(`stream-viewer.tsx:3623-3626`). `mediaReady` becomes true only when
`assessNekoMediaSettle` reports `settled` or `degraded` against samples taken
via `readNekoMediaSettleSample(viewportCaptureSize(viewportInfo))`
(`stream-viewer.tsx:3530-3557`). Until then the overlay stays.

## Evidence the overlay path is the failure, not WebRTC

- neko logs show ICE Connected + `set webrtc connected connected=true` for the
  phone's session (`operator-1BtWc`) — i.e. media should be flowing.
- The web container's stream-debug log
  (`/app/tmp/stream-debug/2026-05-12.jsonl`, last write 17:07Z, ~1.5h before
  the 18:39 neko connect) contains **zero** events for any
  `playground_neko_*` runId today; only `playground_1778604687971_1` (a
  long-lived CDP playground from 14:11Z).
- Per `playground.js:484-491` neko sessions are minted with runIds of the form
  `playground_neko_<ts>_<seq>`; their absence means either (a) the phone's
  `?backend=neko` tab never reached `POST /_ref/dev/playground/session`, or
  (b) it did but its viewer never POSTed any debug events. The neko-server
  ICE-connected line at 18:39 says (b): the WS handshake and WebRTC came up,
  but the React side never reached the point of emitting `surface.neko.*` or
  `neko.media.settle.sample` telemetry — which is exactly what you'd see if
  `mediaReady` never flipped true and the component stayed in the
  pre-presentation state.

## Most likely root cause

`assessNekoMediaSettle` on Brave-Android never reports `settled` for this
device. The phone's measured viewport is 448×819 @ DPR 2.25 (from the latest
`raw.visualViewport.resize` for viewer `828f3f05...`), while neko's desktop is
`NEKO_DESKTOP_SCREEN=1440x900@30`. `toNekoNativeViewportInfo` overrides the
canonical viewport to native, and presentation viewport is only published from
inside the settle poller (`onPresentationViewportReady(... 'settled')` at
`stream-viewer.tsx:3546`). If the video element's intrinsic size on Brave
Android never matches the settle target within
`STREAM_VIEWER_POLICY.nekoMediaSettleMaxPolls`, the poller stops without ever
calling `setMediaReady(true)` and the overlay sticks.

## Fix recommendation (in order)

1. **Most surgical:** in `NekoSurface`, set `mediaReady` to true once the
   WebRTC peer reports `connected` AND a single non-zero
   `readNekoMediaSettleSample` is observed, treating subsequent settle as a
   refinement. The current "wait for fully settled" gate is too strict for
   mobile viewports that legitimately keyboard-resize after first paint.
   Concretely: in `stream-viewer.tsx:3499-3577`, on the first sample whose
   `width>0 && height>0`, call `setMediaReady(true)` and
   `onPresentationViewportReady(viewportInfo, { status: 'first-frame' })`,
   then continue polling for "settled" as today.
2. Add a hard timeout fallback: after
   `STREAM_VIEWER_POLICY.nekoMediaSettleMaxPolls *
   STREAM_VIEWER_POLICY.nekoMediaSettlePollMs` ms with no settle, force
   `setMediaReady(true)` with `status: 'timeout'` so the user sees video even
   if measurements never stabilize.
3. Independently, restart the dead `pdpp-coturn-1` container (Exited 0) — not
   the cause here (ICELITE + NAT1TO1 LAN path works) but the failure cause for
   any future off-LAN client.

## Next 3 checks if (1)/(2) don't resolve it

1. Live-inspect the phone via `adb forward tcp:9222
   localabstract:chrome_devtools_remote_com.brave.browser` + `chrome://inspect`
   on desktop. In the Network tab confirm the SSE `backend_ready` payload
   contains `backend: "neko"` and the iframe at the `iframe_path` actually
   loads neko's HTML (not a 401/redirect from `withOwnerSessionCookie`). In
   the Console look for `assessNekoMediaSettle` outcomes
   (`neko.media.settle.sample`) and the last `result.status`.
2. Open the same URL on desktop Chrome on the LAN. If desktop NekoSurface
   clears its overlay quickly, the issue is mobile-Brave-specific (intrinsic
   video size measurement) — confirming hypothesis above. If desktop also
   hangs, look at `readNekoMediaSettleSample` for non-Android viewport
   anomalies.
3. Tail `pdpp-web-1` for the **next** neko playground load:
   `docker logs -f pdpp-web-1` and reproduce. Grep its stream-debug for any
   `playground_neko_*` runId after the reproduction. If still none, the bug
   is upstream (the page never minted a neko session — auth/cache); if
   present, inspect the last `neko.media.settle.sample` row to see why settle
   never reached `settled`.

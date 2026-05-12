# n.eko Mode Mobile Validation — 2026-05-12

**Device**: Pixel 8 Pro (ADB serial 39111FDJG00ECM), Brave Android, screen 1008x2244.
**URL**: `https://peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko&stream_debug=1`

## Verdict

**INVESTIGATE FIRST** — Validation could not be completed because the n.eko WebRTC stream never finished negotiating from the phone. The companion session opened (loader visible) but never advanced past "Starting WebRTC stream…" after ~90s of waiting. All 10 mobile-UX tests are blocked behind that gate.

## What happened

- Page loaded fine (no login redirect; owner session intact). Screenshot: `/tmp/phone-step-1.png`.
- "Open browser" button (bounds [92,1301][918,1411]) tapped successfully. Screenshot: `/tmp/phone-step-2.png` shows the loader.
- Loader remained on "Starting WebRTC stream…" for 25s, 40s, 70s, 90s. Screenshots: `/tmp/phone-step-2-stream.png`, `/tmp/phone-step-2-stream2.png`, `/tmp/phone-wait.png`.
- Telemetry sink `/app/tmp/stream-debug/2026-05-12.jsonl` contains **zero** n.eko/WebRTC surface events for this session — only stale `surface.cdp-frame.*` samples from an earlier CDP-frame run. Indicates the n.eko peer never reached the data-channel-open milestone.
- All four containers healthy (`pdpp-neko-1` healthy, port 59000 UDP/TCP exposed; `pdpp-web-1`, `pdpp-reference-1`, `pdpp-postgres-1` up).
- An earlier screenshot (`/tmp/phone-step-2.png`, captured right after the very first tap) briefly rendered the playground test page WITH a Brave text-selection toolbar overlay. That run was the **CDP-frame** backend (telemetry confirms only `cdp-frame` events), not n.eko — so it does not validate Option E.

## Per-test results

| # | Test | Result | Note |
|---|------|--------|------|
| 1 | Tap counts as 1 | UNCLEAR | Stream never came up; could not interact with remote DOM. |
| 2 | Tap again -> 2 | UNCLEAR | Same. |
| 3 | Long-press doesn't trigger Android save-image | UNCLEAR | Same. |
| 4 | Tap input opens Gboard | UNCLEAR | Same. |
| 5 | Keyboard stays open on sustained tap | UNCLEAR | Same. |
| 6 | Type "hello" via Gboard | UNCLEAR | Same. |
| 7 | Backspace via Gboard | UNCLEAR | Same. |
| 8 | Numeric input | UNCLEAR | Same. |
| 9 | Viewport survives keyboard | UNCLEAR | Same. |
| 10 | Video keeps rendering | FAIL | Loader never transitioned to a live frame; no media track ever shown. |

## Likely root causes (rank-ordered)

1. **WebRTC peer can't reach `pdpp-neko-1:59000` from the phone.** peregrine-dev.vivid.fish is on a LAN/tunnel; UDP 59000 may not be NATed out to the public phone. The phone may have been on cell or external WiFi. Check whether the neko container's advertised ICE candidates are reachable from outside the host.
2. **ICE/TURN configuration mismatch.** No TURN server is configured, so a relay-only path fails when host-candidate UDP is blocked.
3. **Auth/cookie scope mismatch on `/dashboard/stream-playground` for the neko backend signal handshake** — less likely since the loader UI rendered.

## Recommended next steps

- Reproduce on **desktop Chrome on the same external network** as the phone first. If desktop also stalls on `?backend=neko`, it's an infra issue, not mobile-specific.
- Capture `chrome://webrtc-internals` from a desktop session to see where ICE fails.
- Once the stream lights up on desktop, re-run this 10-step checklist on the phone.
- If the n.eko backend is intended for LAN-only smoke tests, document that and run validation from a LAN-attached phone.

Do **not** abandon Option E yet — the UX path was never exercised. Report status: **investigate first**.

## Re-run 2026-05-12 (post mediaReady-timeout fix)

Stream came up. The `mediaReady` hard-timeout fallback works: loading overlay cleared at ~12–15s and the playground page rendered live in the remote browser. So that gate is unblocked.

But mobile UX is broken in a different place.

### Per-test results

| # | Test | Result | Note |
|---|------|--------|------|
| 1 | Tap → count=1 | FAIL | Counter stayed at 0 across multiple taps. `touchstart` reaches remote DOM, `touchend` acked on the wire, but no `click` synthesis. Screenshot `/tmp/rerun-tap1.png`, `/tmp/rerun-tap2.png`. |
| 2 | Tap again → count=2 | FAIL | Same root cause; no clicks ever register. |
| 3 | Long-press → no Save-Image | UNCLEAR | No Android save-image menu, BUT Brave's local text-selection toolbar (Copy / …) appears over the streamed video, intercepting long-press before the remote DOM sees it. `/tmp/rerun-longpress.png`. |
| 4 | Tap input opens Gboard | BLOCKED | Could not validate cleanly: each ADB `BACK` to dismiss Brave's selection toolbar instead navigated Brave back to the start page (state lost). Stream restart required re-tapping Open browser. |
| 5–9 | Type / backspace / numeric / keyboard stability | BLOCKED | Same blocker as #4. Could not safely dismiss Brave selection toolbar without losing the streaming page. |
| 10 | Video keeps rendering | PASS | Stream stayed live after the mediaReady timeout; no black-letterbox observed during the brief input attempts. |

### Telemetry highlights (`/tmp/sd.jsonl`, 556 events)

- `surface.neko.telemetry.attached` present → n.eko backend active (not CDP).
- 165 `wire.input.received`, 164 `wire.input.dispatched`, 75 `stream.input.dispatched`, 74 `stream.input.acked`. Touch events ARE flowing end-to-end.
- **`stream.input.mouse_suppressed` × 57**, reasons:
  - `keyboard-active` ×111, `keyboard-settling` ×72 (these are top-level reasons across all suppress types)
  - `touch-active` ×57 — every `mousedown`/`mouseup` is being suppressed because a touch is in flight.
- Zero `neko.media.settle.ok` events; many `viewport.presentation.hold` (190). Stream rendered anyway because the new timeout fired.

### Root-cause hypothesis

The viewer dispatches touch events to n.eko (correct), but n.eko's remote Chromium isn't synthesizing `click` from a stationary `touchstart`+`touchend` pair on a button. Meanwhile the viewer's own `mousedown` events are suppressed locally by the anti-double-fire guard (`reason: touch-active`) so no fallback mouse-click reaches the wire either. Net: mobile users see touch land but never trigger clicks. This is independent of the mediaReady fix.

### Secondary issues

- Brave's text-selection toolbar appears on long-press over the streamed `<video>`. Need `user-select:none` / `-webkit-touch-callout:none` / `touch-action:manipulation` on the surface element (and possibly a pointer-capture overlay) to prevent Brave from hijacking long-press.
- Dismissing that toolbar without `KEYCODE_BACK` (which nukes the page) is the immediate blocker for completing tests 4–9.

### Verdict

**NEEDS-MORE-FIXES.** The mediaReady timeout fix is correct and sufficient to unblock first paint, but the touch→click synthesis path in the n.eko remote browser (or the viewer's mouse-suppress policy that prevents a fallback) is broken on mobile. Fix that, plus add `user-select:none`/`touch-callout:none` on the stream surface to stop Brave's selection toolbar, then re-run tests 1–9.

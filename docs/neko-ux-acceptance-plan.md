# n.eko UX Acceptance Plan

_Last updated: 2026-05-07_

## Architecture summary (what we're testing)

PDPP's streaming surface has two rendering modes selected at mint time:

| Mode | Rendering | Input path |
|------|-----------|-----------|
| **CDP** | JPEG screencast frames via SSE (`data_base64`) | `POST /input` with typed events |
| **n.eko** | WebRTC VP8 via direct `@demodesk/neko` client mount behind the same-origin `/neko/` proxy | n.eko internal mouse/keyboard/clipboard over WebRTC data channel |

In CDP mode the client renders an `<img>` and does coordinate math via `pointToStreamViewport` / `containedStreamRect`. In n.eko mode the client mounts the n.eko Vue client directly, authenticates it through the scoped `/neko/` proxy, and uses n.eko's overlay textarea for keyboard, touch, and clipboard behavior when a remote input is focused or the operator explicitly opens the keyboard control. PDPP still suppresses n.eko room chrome and owns the minimal status/copy/paste/keyboard/close controls.

Relevant code entry points:
- `apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` — `StreamSurface`, `BrowserSurface` (CDP img), `NekoSurface` (direct n.eko client mount)
- `apps/web/src/app/dashboard/runs/[runId]/stream/neko-client.ts` — direct n.eko client lifecycle, focus, clipboard, video playback, and viewport layout bridge
- `apps/web/src/app/dashboard/runs/[runId]/stream/stream-geometry.ts` — `pointToStreamViewport`, `containedStreamRect`
- `apps/web/src/proxy.ts` — `/neko` passthrough rules
- `docker-compose.neko.yml` — `NEKO_MEMBER_PROVIDER=noauth`, `NEKO_IMPLICITCONTROL=true`, `NEKO_SESSION_IMPLICIT_HOSTING=true`

---

## 1. Manual acceptance checklist

Run each item against **both backends** unless marked. Mark P (pass) / F (fail) / N/A.

### 1.1 Chrome-free stream surface

Goal: zero n.eko UI (controls, member list, settings gear, tab/address bar) visible to the PDPP operator.

| # | Step | Expected |
|---|------|----------|
| C1 | Open `http://localhost:3002/dashboard/stream-playground?backend=neko` | Stage-1 orientation card; no stream visible yet |
| C2 | Click the CTA button | Stage-2 dialog opens; stream surface fills the overlay |
| C3 | Inspect the stream area visually | No n.eko toolbar, settings panel, member list, or chat visible |
| C4 | Inspect the streamed browser window inside the frame | No Chromium address bar, tab strip, or bookmarks bar |
| C5 | Open browser DevTools; inspect the n.eko client mount | Network/API paths are same-origin `/neko/…`; no external n.eko origin is exposed |
| C6 | Confirm only these PDPP overlay elements are visible: location label (hostname/pathname pill), status dot, close (×) button | Any other UI element is a fail |

### 1.2 Desktop pointer alignment

| # | Step | Expected | Threshold |
|---|------|----------|-----------|
| P1 | Navigate remote browser to a page with a known-position click target (e.g. `__rbs/input-lab` or a local HTML fixture) | Page loads | — |
| P2 | Click a 20×20 px target at known remote coords (e.g. 100, 100) | Remote browser click lands within ±8 px | **≤ 8 px** |
| P3 | Move mouse slowly across the full stream surface | Remote cursor tracks continuously; no jump | No single-frame jump > 16 px |
| P4 | Resize PDPP window to 50 % width; repeat P2 | Same ±8 px threshold | Verifies `containedStreamRect` recalculates |
| P5 | (CDP) Drag window edge continuously for 1 s; observe stream | Debounce fires ≤ 200 ms after drag stops; frame updates | `VIEWPORT_RESIZE_DEBOUNCE_MS = 200` |

### 1.3 Mobile tap alignment

| # | Step | Expected | Threshold |
|---|------|----------|-----------|
| M1 | Open `https://peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko` on a real phone | Stage-1 card renders in mobile viewport | — |
| M2 | Tap the CTA; stream appears | No duplicate touch events | — |
| M3 | Tap a 44×44 px button at a known remote coord | Remote receives tap within ±12 px | **≤ 12 px** |
| M4 | (CDP) Intercept mint request; verify `hasTouch: true`, correct UA | Both fields present | — |

### 1.4 Scroll and drag

| # | Step | Expected |
|---|------|----------|
| S1 | Desktop: scroll wheel over stream on a long remote page | Remote page scrolls; `deltaX`/`deltaY` received; local page does NOT scroll (`preventDefault` called) |
| S2 | Mobile: two-finger swipe up/down | Remote page scrolls; local PDPP page does not scroll |
| S3 | Desktop: click-drag within stream | Remote receives `mousemove` sequence; `draggable={false}` prevents native drag on PDPP page |
| S4 | Mobile: touch-drag | `touchstart` → `touchmove` (≤ 50 ms throttle) → `touchend` in order; no stale coord after `touchend` |
| S5 | Desktop: rapidly drag window edge for 3 s | Server receives ≤ 6 viewport POSTs/s (debounce gate); stream stays live |

### 1.5 Local-to-remote paste

| # | Step | Expected |
|---|------|----------|
| T1 | Click a text field in the remote browser | Field appears focused in stream |
| T2 | Copy text locally; focus stream surface; Ctrl+V / Cmd+V | Text appears in remote field; `postInput({type:"paste", text})` sent |
| T3 | Paste empty clipboard | No characters appear; no error; `preventDefault` still called |
| T4 | Paste a Unicode string (`"Héllo wörld"`) | Correct Unicode appears in remote field |
| T5 | Paste a 1 000-character string | All 1 000 characters appear in remote field |

### 1.6 Remote-to-local copy

| # | Step | Expected |
|---|------|----------|
| R1 | (n.eko) In remote browser, select text and press the PDPP copy button | Selected text lands in the operator clipboard |
| R2 | (CDP assistive mode) In remote browser, select and copy text | Local page receives `clipboard_message` SSE event with `{text: "…"}` |
| R3 | Confirm copied text does not appear passively in page DOM | No leakage; text accessible only via explicit operator action |

### 1.7 Mobile soft keyboard

| # | Step | Expected |
|---|------|----------|
| K1 | Real phone: tap a text field in the remote browser | Remote focus opens the n.eko mobile keyboard path; the PDPP keyboard button is the guaranteed fallback when the OS rejects async focus |
| K2 | Type on soft keyboard | Each key dispatched exactly once to remote browser; Android IME paste-style text is accepted without poisoning the local clipboard |
| K3 | Tap a non-text area; re-tap a text field | Keyboard does not open on non-text taps; it re-opens on remote input focus or explicit keyboard control |
| K4 | Background app; return | Next tap on text field opens keyboard again |
| K5 | Rotate phone 90° with keyboard open | Layout adjusts; stream is not distorted after orientation change |

### 1.8 Resize and orientation

| # | Step | Expected | Threshold |
|---|------|----------|-----------|
| O1 | Desktop: drag window from 1440×900 → 800×600 | Viewport POST fires ≤ 200 ms after resize settles; stream reframes | **≤ 400 ms end-to-end** |
| O2 | Desktop: maximise/restore | Same as O1 | — |
| O3 | Phone: portrait → landscape | First viewport POST is immediate; settled follow-up POSTs repair transient browser-UI samples | First POST immediate; settled by **≤ 1.2 s** |
| O4 | Phone: landscape → portrait | Same; final portrait viewport body matches visible frame | First POST immediate; settled by **≤ 1.2 s** |
| O5 | Verify viewport POST body contains correct `deviceScaleFactor` | Check DevTools network tab on mint request | — |
| O6 | (n.eko) Gray-bar gutter after resize | ≤ 4 px on either axis | **≤ 4 px** |

### 1.9 Perceptual and true 1:1 probes

| # | Step | Expected |
|---|------|----------|
| V1 | (CDP, 1:1 zoom) Render a 1 px border box at a known position; click the border | Click lands within 1 px |
| V2 | (CDP, 2× DPR / Retina) Same box | Coordinate math uses CSS px (DIP), not physical px; click within 1 px |
| V3 | (n.eko) Screenshot stream; overlay on reference screenshot of the same page | SSIM ≥ 0.90; no visible codec blocking on text |
| V4 | Compare frame rate: idle vs. active mouse movement | Idle ≤ 5 fps; active ≥ 24 fps |

### 1.10 Reconnect / refresh / app switch

| # | Step | Expected |
|---|------|----------|
| N1 | Network blip ≤ 5 s (toggle Wi-Fi) with stream live | EventSource auto-reconnects; status dot "trouble" → "live"; no re-mint |
| N2 | Network blip > 30 s | After `TOKEN_DEAD_FAILURE_THRESHOLD=3` pre-attach failures, client re-mints; stream recovers |
| N3 | Hard reload (Cmd+Shift+R) with stream open | Stage-1 card shown; CTA triggers fresh mint; stream live |
| N4 | Navigate away → browser Back | Stage-1 card shown; prior session gone; new mint on CTA |
| N5 | (Mobile) Background app > 2 min; return | Stream shows "trouble" → reconnect; either recovers or shows clear human-readable error |
| N6 | All 10 reconnect attempts exhausted | Terminal "trouble" state with clear message; no infinite retry |

### 1.11 Public endpoint — `peregrine-dev.vivid.fish`

| # | Step | Expected |
|---|------|----------|
| E1 | Open `https://peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko` on desktop | Stage-1 card loads over HTTPS |
| E2 | Open same URL from a real phone on LTE | Stream connects through either public host candidates (`NEKO_WEBRTC_NAT1TO1`) or TURN (`pnpm docker:neko:turn` with public TURN settings) |
| E3 | Confirm `/neko/` proxy path accessible from phone | No CORS or mixed-content errors |

### 1.12 Docker / n.eko restart and rebuild

| # | Step | Expected |
|---|------|----------|
| D1 | `docker compose ... stop neko && ... start neko` with stream live | Client detects disconnect; reconnects after neko restart; status recovers within 30 s |
| D2 | `docker compose ... down && ... up --build` (full rebuild) | Fresh stack; stream works end-to-end on first launch |
| D3 | `pnpm docker:neko` from repo root | Starts with default `.env.docker` settings; command: `docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml up --build` |
| D4 | Change `NEKO_DESKTOP_SCREEN=1920x1080@30`; restart neko only | New resolution in stream; viewport POST updates |

---

## 2. Automated smoke tests

### 2.0 Current public smoke proof

Run: 2026-05-07 against `https://peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko` after rebuilding/recreating `web`.

| Probe | Result |
|-------|--------|
| Mobile-sized attach | Playwright viewport `390×844`, coarse pointer emulation; WebRTC video decoded at `392×844`; no black frame |
| Generic stream touch | Synthetic touch/pointer on `role="application"` left `document.activeElement` as `BODY`; n.eko textarea did not focus |
| Remote input keyboard focus | Clicking the remote playground input focused the n.eko textarea with no immediate local blur; the direct-focus path did not register n.eko's hide-on-second-`visualViewport.resize` keyboard helper |
| Mobile typing clipboard echo | Synthetic `beforeinput`/`input` on n.eko textarea followed by `navigator.clipboard.writeText("remote-echo-after-mobile-type")` produced zero client clipboard writes |
| Local-to-remote paste | Remote playground input focused through the n.eko browser CDP endpoint; PDPP paste control inserted `pdpp-paste-smoke` into the remote input and remote event log showed `paste` + `beforeinput: insertFromPaste` |
| Remote-to-local copy | Remote playground input selected through CDP; PDPP copy control wrote `pdpp-paste-smoke` to the client clipboard hook |
| Orientation landscape | `390×844 → 844×390` posted viewport `{width:844,height:390,...}`; video decoded at `848×390` |
| Orientation portrait return | `844×390 → 390×844` posted final viewport `{width:390,height:844,...}`; video decoded at `392×844` |
| Residual console noise | One n.eko SDK `screen/cast.jpg` 401 can appear while WebRTC connects; it is non-blocking and the WebRTC stream remains live |

### 2.1 Reuse from `remote-browser-sandbox/scripts/audit/`

| Script | Verdict | Adaptation |
|--------|---------|-----------|
| `deep-link-smoke.mjs` | Adapt | Change `BASE_URL` env to PDPP stream-playground URL; assert `backend_ready` SSE event instead of session count |
| `touch-focus-smoke.mjs` | Adapt | Change BASE_URL; replace `stream-canvas` selector with PDPP `role="application"` div + `<img>`; keep coordinate math and `waitFor` patterns |
| `lib.mjs` | Reuse as-is | `waitFor`, `requestJson`, `launchChrome` are backend-agnostic |

### 2.2 New smoke tests for PDPP

Placement:
- Unit tests → `apps/web/src/app/dashboard/runs/[runId]/stream/__tests__/`
- E2e tests → `e2e/stream/` (new directory; use existing Playwright config)

#### `stream-geometry.test.ts` (unit — extend existing)
- `containedStreamRect`: letterbox mode, pillarbox mode, 1:1, degenerate zero-size input
- `pointToStreamViewport`: click outside rect → `null`; click on exact edge → boundary coord; non-finite input → `null`
- Round-trip: `pointToStreamViewport` at 2× deviceScaleFactor viewport uses CSS px not physical px

#### `e2e/stream/chrome-free.spec.ts`
```
PDPP_BASE_URL=http://localhost:3002
```
1. Navigate to `/dashboard/stream-playground?backend=neko`
2. Click CTA; wait for `[data-pdpp-neko-client] video`
3. Assert no elements with n.eko control classes (`neko-controls`, `neko-menu`, `neko-navbar`) visible in the direct mount
4. Assert PDPP close button, status dot, keyboard, paste, and copy buttons ARE present in overlay

#### `e2e/stream/pointer-alignment.spec.ts`
1. Playwright viewport `1280×800`; open CDP stream; wait for `attached` SSE event
2. Compute expected remote coord via `pointToStreamViewport` for a target at a known offset
3. `page.mouse.click(localX, localY)`
4. Intercept `POST /input`; assert `|received.x - expected.x| ≤ 8` and `|received.y - expected.y| ≤ 8`

#### `e2e/stream/paste.spec.ts`
1. Open stream; wait for `attached`
2. Intercept `POST /input`
3. `page.evaluate(() => navigator.clipboard.writeText("hello-paste-test"))`
4. Click stream surface; `page.keyboard.press("Control+V")`
5. Assert intercepted body: `{ type: "paste", text: "hello-paste-test" }`
6. Assert no text appears in PDPP local DOM (`preventDefault` verified)

#### `e2e/stream/reconnect.spec.ts`
1. Open stream; wait for `attached`
2. `page.route(attachEndpointPattern, r => r.abort())` for 6 s
3. Assert status dot shows "trouble" within 2 s
4. Restore route
5. Assert status returns to "live" within 15 s

#### `e2e/stream/mobile-viewport.spec.ts`
```js
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "<iPhone 15 UA>"
});
```
1. Intercept mint request
2. Assert body: `hasTouch: true`, `mobile: true`, `deviceScaleFactor: 3`, `width: 390`, `height: 844`
3. Complete Stage-1 → Stage-2 flow
4. Tap stream surface; assert `touchstart` event delivered (via intercepted `POST /input`)

---

## 3. Live test matrix

### 3.1 Devices and viewports

| Device | CSS viewport | DPR | Pointer | Priority |
|--------|-------------|-----|---------|----------|
| Desktop 1440×900 | 1440×900 | 1 | fine | P0 |
| Desktop 1280×800 | 1280×800 | 1 | fine | P0 |
| MacBook Retina 14" | 1512×982 | 2 | fine | P1 |
| iPhone 15 (real) | 393×852 | 3 | coarse | P0 |
| iPhone SE 3 (real) | 375×667 | 2 | coarse | P1 |
| Pixel 7 (real) | 412×915 | 2.625 | coarse | P1 |
| iPad Air 5 (real) | 820×1180 | 2 | coarse | P2 |
| Playwright iPhone 15 | 393×852 | 3 | coarse | P0 (CI) |
| Playwright Pixel 7 | 412×915 | 2.625 | coarse | P0 (CI) |

### 3.2 Orientation

| Device | Portrait | Landscape |
|--------|----------|-----------|
| iPhone 15 | P0 | P1 |
| Pixel 7 | P0 | P1 |
| iPad Air 5 | P1 | P1 |
| Desktop | N/A | P0 |

### 3.3 Network (manual only)

| Condition | Test via |
|-----------|---------|
| Fast Wi-Fi (> 50 Mbps) — baseline | Default |
| Throttled 4G (12 Mbps) | Chrome DevTools throttle |
| Blip 5 s | DevTools Offline toggle |
| Blip 30 s | DevTools Offline toggle |

---

## 4. Pass / fail thresholds

### 4.1 Cursor and tap alignment

| Metric | Pass | Fail |
|--------|------|------|
| Desktop pointer error (fine pointer, ≥ 1280 px wide) | ≤ 8 CSS px | > 8 CSS px |
| Mobile tap error (coarse pointer, real device) | ≤ 12 CSS px | > 12 CSS px |
| Scroll delta fidelity (`deltaX`/`deltaY`) | ≤ 5 % error | > 5 % |
| Touch gesture continuity | No `touchmove` gap > 100 ms during active drag | Gap > 100 ms |

Measurement: intercept `POST /input`; compare received `{x, y}` to `pointToStreamViewport(…)` for the same click.

### 4.2 Viewport / frame mismatch

| Metric | Pass | Fail |
|--------|------|------|
| Remote viewport width vs. viewer CSS width | ≤ 2 px error | > 2 px |
| Remote viewport height vs. viewer CSS height | ≤ 2 px error | > 2 px |
| n.eko gray-bar gutter (either axis) | ≤ 4 px | > 4 px |
| Viewport POST latency after resize settles | ≤ 400 ms | > 400 ms |
| Mobile keyboard focus/blur | No viewport POST while width is stable and height drops by keyboard-sized amount | Remote browser resizes during keyboard animation |
| Orientation-change reframe latency | ≤ 1 frame (34 ms at 30 fps) | > 1 frame |

### 4.3 Paste

| Metric | Pass | Fail |
|--------|------|------|
| Paste text reaches remote field | Yes | No |
| Local PDPP DOM unchanged after paste | Yes | No |
| Empty paste: no event sent | Yes | No |
| Unicode round-trip fidelity | 100 % of characters | Any corruption |

### 4.4 Reconnect resilience

| Metric | Pass | Fail |
|--------|------|------|
| "trouble" shown within 2 s of disconnect | Yes | No |
| Blip < 30 s: no re-mint | Yes | Re-mint triggered |
| Blip > 30 s: re-mints and recovers | Yes, within 15 s of restore | Stuck in "trouble" |
| Max 10 reconnect attempts then terminal | Yes | Infinite loop |
| No stale input URL after re-mint | Yes (401 never fires post-reconnect) | 401 on first click |

### 4.5 Chrome-free

| Metric | Pass | Fail |
|--------|------|------|
| n.eko UI elements visible | 0 | ≥ 1 |
| Chromium tab / address bar visible | 0 | ≥ 1 |
| PDPP corner overlay elements present | All (close, status dot) | Any missing |
| Any PDPP overlay element covers > 10 % of stream area | No | Yes |

---

## 5. Known risks and gaps

1. **n.eko gray-bar gutter on mobile viewports** — documented in `remote-browser-sandbox/docs/neko-mobile-viewport-problem.md`. The current fix (app-window + aligned X11 modelines + client-side crop) is validated to leave a small gutter. If measured gutter > 4 px at any of the P0 mobile viewports, threshold O6 is a release blocker.

2. **CDP-mode remote-to-local copy (R2)** — n.eko mode has an explicit operator copy button. CDP mode can only copy selection in assistive mode where page-level CDP helpers are allowed; strict mode should keep this unavailable rather than weakening stealth.

3. **WAN/LTE WebRTC reachability** — default `NEKO_WEBRTC_NAT1TO1=127.0.0.1` is for local/LAN proof only. For real off-LAN phones, set a public `NEKO_WEBRTC_NAT1TO1` when direct host candidates are valid, or run the optional TURN profile and advertise it through `NEKO_WEBRTC_ICESERVERS`. TURN is a fallback relay; expect extra latency/bandwidth only when the relay candidate is selected.

4. **iOS clipboard permission** — iOS 16+ requires a user gesture before `navigator.clipboard.readText()`. The automated paste test uses `page.evaluate` to write, which bypasses the gesture in Playwright but must be confirmed on a real device (K1–K5 matrix).

5. **Android soft keyboard behavior** — K2 must still be verified on Android Chrome because the OS/browser decides whether a programmatic focus from a touch gesture opens the keyboard. The explicit keyboard button is the fallback if automatic focus is suppressed.

6. **Popular-device exactness** — Browser/device emulation should stay exact to the owner viewport. X11/n.eko framebuffers may use the nearest 8px-aligned popular-device preset (for example iPhone 393x852 -> 400x856, Pixel 412x915 -> 416x920) to reduce encoder/scaler blur while preserving remote coordinate correctness.

7. **Dynamic bitrate behavior** — The local n.eko image uses main/mq/lq VP8 capture pipelines plus n.eko's estimator. Verify on LAN and TURN paths that text remains readable during downgrades and that recovery returns to the high-quality stream without reconnecting.

8. **`NEKO_MEMBER_PROVIDER=noauth` security perimeter** — The n.eko service is isolated on the private Compose network (only WebRTC mux ports exposed to host). Verify in D3 that the `/neko/` proxy (`PDPP_NEKO_PROXY_ALLOWED_HOSTS`) rejects unauthenticated requests that do not carry a valid PDPP session context.

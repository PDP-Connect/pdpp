# n.eko UX Acceptance Matrix

Status: researching
Owner: implementation agent
Created: 2026-05-06
Updated: 2026-05-06
Related: openspec/changes/add-run-interaction-streaming-companion

## Question

What must be proven before the n.eko backend is considered good enough for real ChatGPT run-interaction use from desktop and phone clients?

## Context

The viewer now prefers a direct `@demodesk/neko` WebRTC client mount instead of embedding the full n.eko room UI in an iframe. The reference backend exposes a stream-token-scoped client config endpoint and a same-origin `/neko` proxy cookie. The adapter supports browser-owner modes:

- `neko-owned` + `balanced`: default SLVP path. Allows n.eko screen selection, browser window bounds, device metrics, and touch emulation. Disallows Runtime-based copy/status and CDP paste unless promoted to `assistive`.
- `browser-owner` + `strict`: Patchright-compatible path. Keeps page-level CDP helpers off and avoids browser/window mutation from the viewer path.
- `assistive`: explicit debug/UX mode for `Runtime.evaluate` copy/status and `Input.insertText` paste fallback.

## Stakes

If this matrix is not passed, the operator may see a stream but be unable to complete real account interactions, especially on mobile. The failure modes to catch before handoff are browser chrome, n.eko room UI, pointer offset, broken paste direction, soft-keyboard failure, and resize/orientation drift.

## Current Leaning

Use direct n.eko mount as the default polished path. Keep strict mode available for stealth-sensitive browser-owner runs, and only enable assistive CDP helpers when the operator explicitly chooses that tradeoff.

## Promotion Trigger

Promote to spec/test updates if any threshold below changes a public contract, stream event payload, viewer route, or browser-owner mode semantics.

## Automated Coverage

- `node --test reference-implementation/test/run-interaction-stream-routes.test.js reference-implementation/test/run-interaction-stream-neko-adapter.test.js`
- `pnpm --dir apps/web run check`
- `pnpm --dir apps/web run types:check`
- `pnpm --dir apps/web run build`
- `openspec validate add-run-interaction-streaming-companion --strict`

Covered invariants:

- `backend_ready` carries `client_config_path` for direct n.eko mount and keeps `iframe_path` only as compatibility metadata.
- The client config endpoint sets the short-lived `/neko` stream cookie and returns only token-scoped n.eko client config.
- Strict browser-owner mode does not open CDP WebSockets for browser window bounds, page emulation, Runtime status/copy, or paste insertion.
- Assistive mode still supports RBS-style window bounds, touch/device metrics, copy, and paste fallback when explicitly configured.
- CDP target selection ignores `chrome-extension://` and other browser chrome targets and attaches to the real page target.
- Next.js production build accepts the Vue 2 n.eko client and n.eko CSS.

## Manual Acceptance Checklist

Run against `https://peregrine-dev.vivid.fish/dashboard/stream-playground?backend=neko` after recreating the `reference` and `neko` Docker services together.

- Chrome-free display: no n.eko header/sidebar/menu/branding; no Chromium tab strip/address bar; first visible pixels are the remote page/app content or the blank app surface.
- Desktop pointer: click five known points in the remote page. Error is <= 4 CSS px at 1x DPR and <= 8 CSS px at 2x DPR.
- Desktop drag/scroll: drag selection and wheel-scroll a page; no local page scroll steals focus while pointer is over the stream.
- Local-to-remote paste: copy text locally, focus a remote input, paste. Text appears within 500 ms and does not land in the local dashboard DOM.
- Remote-to-local copy: select remote text, copy, paste locally. This may require `assistive` mode if native n.eko copy does not bridge reliably.
- Phone tap alignment: tap five known points from a real phone browser. Error is <= 10 CSS px.
- Phone keyboard: tap a remote input and confirm the mobile soft keyboard opens; dismiss it; tap another input and confirm it reopens.
- Phone touch controls: tap, long-press, drag, and scroll on the remote page. No stuck-touch state after `touchcancel`/app switch.
- Resize/orientation: rotate the phone and resize desktop window. Stream settles within 250 ms after viewport stops changing; no persistent gray gutters unless a true 1:1 remote mode is unavailable.
- Reconnect/app switch: background the phone browser for 10 seconds, return, and confirm stream resumes or shows a terminal actionable error within 5 seconds.
- Strict mode smoke: with `PDPP_NEKO_BROWSER_OWNER_MODE=browser-owner`, verify interactions still work enough to operate the stream and no page-level CDP diagnostics are required for the happy path.

## Decision Log

- 2026-05-06: Captured matrix from worker reports, RBS behavior, and current PDPP implementation. Remaining live validation is Docker recreate plus real desktop/phone smoke.
- 2026-05-06: Public desktop smoke on `peregrine-dev.vivid.fish` passed direct n.eko mount, chrome suppression, crop/remap, pointer click, keyboard typing, and local-to-remote paste. A narrow mobile viewport smoke shows the stream remains chrome-free and fills the frame; real-phone soft keyboard, app switch, and touch precision remain unproven, so task 12.8 stays open.
- 2026-05-06: Android black-screen report traced to two plausible client-only/mobile causes: unreachable WebRTC advertised address and stricter Android video playback policy. Docker n.eko now advertises the Docker host LAN address for WebRTC (`NEKO_WEBRTC_NAT1TO1=192.168.1.180` in this local setup), and the direct client explicitly marks the inner video as muted/autoplay/playsInline with gesture-based playback retry. Desktop smoke still reports a live unmuted video track, `readyState=4`, `paused=false`, and `1024x768` decoded video.
- 2026-05-06: Android typing through n.eko uses upstream's hidden-textarea IME path, which forwards each composed text chunk via `control.paste(text)`. Upstream then emits `clipboard/updated` and synchronizes it back with `navigator.clipboard.writeText(text)`, so Android may treat every typed character as a local clipboard write. PDPP now suppresses recent mobile-typed text from the client clipboard bridge, removes automatic `mobileKeyboardShow()` calls, skips periodic textarea refocus on coarse-pointer devices, and exposes an explicit keyboard control instead of forcing the phone IME on initial load/touch.
- 2026-05-06: RBS felt better mostly because it did not combine upstream n.eko mobile paste semantics with app-level keyboard forcing; it used CDP focus/blur events to focus n.eko's overlay textarea only when the remote page focused an editable element. Porting that automatic behavior is the next polish step, but it should be gated behind a browser-owner mode because page-level focus instrumentation is more detectable than the current explicit-keyboard fallback.
- 2026-05-06: Ported the RBS-style remote editable focus bridge into the n.eko adapter for non-strict modes. The adapter emits `keyboard_focus` over the existing SSE event channel; the direct n.eko client focuses or blurs the overlay textarea from that event. Strict mode remains page-script-free.
- 2026-05-06: Clipboard policy now treats mobile IME echoes and user copy separately. Recent mobile-typed text can be suppressed from local clipboard writes, but an explicit copy/cut operation opens a short allow window so user-initiated remote copy wins over echo suppression. The stream chrome also exposes explicit copy and paste controls for mobile user activation.
- 2026-05-06: Added an optional authenticated coturn Compose profile for SLVP/WAN reliability. A public dashboard route is not a WebRTC media route; TURN is configured through ICE servers and should be used as fallback while direct candidates remain preferred when reachable.

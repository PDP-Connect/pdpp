# Remote Surface — Step 5b Validation (2026-05-12)

## Helpers created (`scripts/phone/`)

- `open-url.sh <url>` — launches URL in Brave on Pixel via ADB, verifies foreground.
- `screenshot.sh [label]` — `screencap -p` → `/tmp/phone-shots/<ISO>-<label>.png`.
- `tap.sh <x> <y>` — `adb input tap` wrapper.
- `find-and-tap.sh <substring>` — `uiautomator dump` + XML parse, taps first node whose text or content-desc contains substring (case-insensitive).
- `wait-for-telemetry.sh <substring> [timeout]` — polls `/app/tmp/stream-debug/<UTC-date>.jsonl` inside local pdpp-web container.
- `README.md` — usage doc.

## Validation sequence

| Step | Outcome | Evidence |
| --- | --- | --- |
| Open `peregrine-dev.vivid.fish/.../stream-playground?backend=neko&stream_debug=1` | PASS | `/tmp/phone-shots/20260512T222544Z-after-load.png` |
| Tap "Open browser" via aria-label match | PASS | uiautomator hit at (505, 1356) |
| Stream renders (15s wait) | PASS | `/tmp/phone-shots/20260512T222613Z-after-stream-load.png` |
| Regression: tap "Click me" → counter 0→1 | PASS | `/tmp/phone-shots/20260512T222623Z-after-clickme.png` |
| Locate keyboard button by `aria-label="Show keyboard for Stream Playground browser"` | PASS | bounds [540,1955][639,2057] → (589, 2006) |
| Soft keyboard appears | PASS | `/tmp/phone-shots/20260512T222711Z-after-kb-tap.png` (Gboard visible) |
| `mobile-text-input.attached` telemetry | **UNCLEAR — see limitation** | sink not observable from peregrine-dev |
| `neko.corner.keyboard` telemetry | **UNCLEAR — see limitation** | sink not observable |
| Type "hi" via `adb input text` after keyboard tap (fresh session) | PARTIAL | `/tmp/phone-shots/20260512T222924Z-after-type-hi.png` |

## Telemetry limitation

The Brave URL `peregrine-dev.vivid.fish` is a deployed environment, not the local pdpp-web docker container. The local stream-debug JSONL sink (`/app/tmp/stream-debug/2026-05-12.jsonl`) only contains events from earlier local-direct testing — last `receivedAt` is `22:22:12.532Z`, while keyboard interactions happened at 22:27+. Container restart (recreated 7 min ago) confirms it's serving local clients only. `wait-for-telemetry.sh` therefore cannot validate the deployed flow — this is a tooling-vs-environment mismatch, NOT a step-5b regression. To unblock telemetry observation we would need to either (a) point Brave at `http://<host>:3000`, or (b) tail the deployed env's log sink.

## Visual evidence of routing path

After tapping the corner keyboard button on a fresh stream session and typing "hi" via `adb shell input text`, the streamed page's event log displayed:

```
[10:29:22 PM] paste: "i"
[10:29:22 PM] paste: "h"
[10:29:18 PM] paste: " "
```

The remote "Type here" textarea remained empty; the characters were registered as `paste` events on the remote page rather than landing in the focused input. Screenshot: `/tmp/phone-shots/20260512T222924Z-after-type-hi.png`.

If `MobileTextInputController` were bound to a hidden textarea and forwarding via `RemoteSurfaceAdapter.sendText`, the remote page would observe `input` / typed-character events on the textarea, not paste events on the page body. Paste-on-page is the n.eko bundled-fallback signature (n.eko mirrors raw clipboard from the local soft-keyboard textarea to the remote via paste).

## Critical answer

**Does Gboard typing now flow through `MobileTextInputController` instead of n.eko's bundled fallback?**

**FAIL** — based on visual evidence. The streamed page receives characters as discrete `paste` events on the document, not as `input` events on the focused textarea. This is the n.eko bundled-fallback behavior. The step-5b wiring (`adapter.focusTextInput()` in the corner-keyboard handler) appears not to be actually binding the controller.

Caveat: this conclusion is from visual/event-log evidence only; the `mobile-text-input.attached` telemetry is unconfirmed due to the environment mismatch above.

## Single next-step hypothesis (do not implement)

The corner-keyboard handler calls `adapter.focusTextInput()` only when `adapter.getLifecycleState() === "mounted"`; otherwise it falls through to `focusNekoKeyboard()`. Hypothesis: on first keyboard tap the adapter lifecycle is still `"connecting"` or `"idle"` (n.eko WebRTC + neko-surface-adapter mount race), so the code path silently falls back to the legacy `focusNekoKeyboard()` and the controller is never constructed. Verify by logging `adapter?.getLifecycleState()` at tap time (already in the `logDebug("neko.corner.keyboard", ...)` payload as `adapterMounted`) once telemetry is observable from the deployed env — or repoint Brave at local docker to confirm against the JSONL sink.

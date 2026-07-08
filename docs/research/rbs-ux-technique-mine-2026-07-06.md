# RBS UX Technique Mine (2026-07-06)

Purpose: mine the old remote-browser-sandbox (RBS) implementation for concrete browser
surface UX techniques that can be ported into `@opendatalabs/remote-surface`.

Primary context read first: `docs/research/remote-surface-ux-onboarding-2026-07-06.md`.
That dossier establishes RBS as both the old UX bar and the Cloudflare counter-evidence:
the old RBS VM passed ChatGPT Cloudflare with pure CDP screencast, while the current n.eko
path had previously failed (`docs/research/remote-surface-ux-onboarding-2026-07-06.md:150`).

Scope inspected: RBS `client/`, `server/`, `docs/`, `deploy/`, and `docker-compose.yml`.
Also checked the root-level Instagram mobile login summary and CSV. Generated dependency
locks were treated as dependency evidence, not UX implementation. Secrets were not printed.
File references below are RBS-root-relative unless prefixed with `packages/remote-surface/`.

## Executive Summary

The standout RBS idea is the **form overlay**: RBS detects remote form fields with CDP,
draws invisible native local `<input>` / `<textarea>` elements exactly over the remote
canvas fields, lets the local browser/IME own typing, then commits text back to Chrome
with semantic CDP calls. That explains why typing could feel better than synthesized
keystrokes: the user sees local caret/IME/autofill behavior immediately while the JPEG
stream catches up later (`docs/decisions.md:16`).

RBS also had a cluster of latency-hiding techniques that are individually small and
collectively important: a local cursor canvas, off-main-thread JPEG decode with
`createImageBitmap`, first-frame skeletons, quality controls, deterministic canvas
coordinate mapping, and an input protocol that separates pointer, text, paste, resize,
quality, and diagnostics instead of overloading keystrokes.

The Cloudflare lesson is not "CDP screencast is safe by itself." The dossier's conclusion
is more specific: the pass likely came from browser binary/channel/profile posture, not
from CDP vs n.eko transport (`docs/research/remote-surface-ux-onboarding-2026-07-06.md:150`,
`docs/research/remote-surface-ux-onboarding-2026-07-06.md:154`). Checked-in RBS source
supports that posture mechanically with headed Chromium, automation flag stripping,
profile hooks, proxy hooks, and persistent n.eko profile wiring, but the checked-in Docker
defaults to Debian Chromium unless `CHROME_PATH` points elsewhere.

Important caveats:

- The Instagram mobile validation records had native form overlay off, so form overlay
  explains the general RBS keyboard feel, not necessarily those specific successful
  Instagram runs (`instagram-mobile-login-test-summary.md:35`).
- The form overlay uses CDP `Runtime.evaluate`, `Page.startScreencast`, and `Input.insertText`.
  It is directly portable to a CDP backend. It conflicts with any "strict no-CDP-touch during
  Turnstile" policy unless gated around sensitive pages.
- RBS detected `select` and `contenteditable`, but the overlay client renders textarea for
  `textarea` and input for everything else. That is useful for ordinary login forms, but not
  complete semantic parity for all editable surfaces.

## 1. Crown Jewel: Native Form Overlay

### Remote field detection

Server-side detection lives in `server/src/form-detector.ts`. It injects a small page
function through `Runtime.evaluate` to query:

- `input`
- `textarea`
- `select`
- `[contenteditable="true"]`

The selector is at `server/src/form-detector.ts:4`. For each element it skips hidden
or invisible fields with two checks: `(offsetParent === null && !:focus)` and zero-size
bounding boxes (`server/src/form-detector.ts:8`, `server/src/form-detector.ts:10`).
It captures a compact record: tag, input type, placeholder, name, id, rounded bounding
rect, value, and focused state (`server/src/form-detector.ts:12` to
`server/src/form-detector.ts:24`).

The detector polls immediately and every 500 ms (`server/src/form-detector.ts:41` to
`server/src/form-detector.ts:44`). It asks CDP for a by-value result (`server/src/form-detector.ts:53`
to `server/src/form-detector.ts:58`), JSON-hashes the field list, and only emits when
the hash changes (`server/src/form-detector.ts:60` to `server/src/form-detector.ts:68`).
Navigation races are deliberately swallowed (`server/src/form-detector.ts:69` to
`server/src/form-detector.ts:71`).

Integration is in `server/src/cdp-stream.ts`: `set_form_detection` starts/stops detection
(`server/src/cdp-stream.ts:355`), `startFormDetection()` emits `{ type: "form_elements",
elements }` (`server/src/cdp-stream.ts:594` to `server/src/cdp-stream.ts:600`), and popup
page switches restart detection if active (`server/src/cdp-stream.ts:607` to
`server/src/cdp-stream.ts:640`).

### Overlay placement

Client-side overlay logic is `client/src/experiments/form-overlay.ts`. It keeps an overlay
map keyed by tag/id/name/rounded coordinates (`client/src/experiments/form-overlay.ts:18`
to `client/src/experiments/form-overlay.ts:27`). Placement uses the same canvas fit math
as pointer input: `getCanvasSurfaceGeometry()` gives the actual rendered canvas rectangle
inside any object-fit letterbox, then remote rects are scaled into local CSS coordinates
(`client/src/experiments/form-overlay.ts:38` to `client/src/experiments/form-overlay.ts:58`).

Each field becomes a native textarea for remote `textarea`, otherwise a native input
(`client/src/experiments/form-overlay.ts:66` to `client/src/experiments/form-overlay.ts:70`).
The overlay copies `type`, `placeholder`, and autocomplete intent, using
`current-password` for password fields and `on` otherwise (`client/src/experiments/form-overlay.ts:72`
to `client/src/experiments/form-overlay.ts:76`).

CSS makes these controls user-interactive but visually invisible: the overlay container is
absolute, pointer-events are disabled on the container, child controls re-enable pointer
events, and controls are transparent with transparent caret/color (`client/index.html:70`
to `client/index.html:77`). Debug mode can add visible borders (`client/index.html:78`
to `client/index.html:84`).

Positioning is recomputed from remote rect times render scale: left/top/width/height and
font-size all scale from remote geometry (`client/src/experiments/form-overlay.ts:123`
to `client/src/experiments/form-overlay.ts:128`). If the remote field reports focused,
the local overlay is focused without scrolling (`client/src/experiments/form-overlay.ts:130`
to `client/src/experiments/form-overlay.ts:132`). Stale overlays are removed
(`client/src/experiments/form-overlay.ts:135` to `client/src/experiments/form-overlay.ts:141`),
and resize reuses the last field list (`client/src/experiments/form-overlay.ts:144` to
`client/src/experiments/form-overlay.ts:148`).

### Text and key commit path

RBS splits text input from special keys.

For special keys, the overlay's `keydown` handler only forwards keys whose `key.length > 1`,
excluding `"Unidentified"` and `"Process"` so mobile/IME composition is not corrupted
(`client/src/experiments/form-overlay.ts:78` to `client/src/experiments/form-overlay.ts:92`).
It builds the same modifier bitmask used elsewhere: Alt=1, Ctrl=2, Meta=4, Shift=8
(`client/src/experiments/form-overlay.ts:83` to `client/src/experiments/form-overlay.ts:88`).
The client then sends `keydown` followed by `keyup` to the server
(`client/src/main.ts:747` to `client/src/main.ts:750`).

For ordinary text, the local browser owns the native `input` event
(`client/src/experiments/form-overlay.ts:95` to `client/src/experiments/form-overlay.ts:117`):

- append-at-end sends only the added substring through the autofill/text path
  (`client/src/experiments/form-overlay.ts:101` to `client/src/experiments/form-overlay.ts:105`);
- end deletions synthesize one Backspace keypress per deleted character
  (`client/src/experiments/form-overlay.ts:105` to `client/src/experiments/form-overlay.ts:110`);
- replacement, paste, autofill, or middle edit sends Ctrl+A, then commits the full current
  value (`client/src/experiments/form-overlay.ts:111` to `client/src/experiments/form-overlay.ts:115`).

The `onAutofill` callback in `client/src/main.ts` also sends Ctrl+A before `paste_text`
(`client/src/main.ts:751` to `client/src/main.ts:755`). That means full-replacement paths
can double-select before inserting. It is probably harmless, but should be normalized during
porting.

On the server, `paste_text` maps to CDP `Input.insertText` (`server/src/cdp-stream.ts:405`
to `server/src/cdp-stream.ts:407`). Raw key events go through `server/src/input.ts`:
printable single characters become `keyDown` with `text`; non-printable keys use
`rawKeyDown`; both set virtual key codes when known (`server/src/input.ts:81` to
`server/src/input.ts:99`).

### Edge cases handled

Handled:

- hidden and zero-size remote fields are skipped (`server/src/form-detector.ts:8` to
  `server/src/form-detector.ts:11`);
- focused but `offsetParent === null` fields remain eligible (`server/src/form-detector.ts:8`);
- navigation/evaluation races are swallowed instead of crashing the stream
  (`server/src/form-detector.ts:69` to `server/src/form-detector.ts:71`);
- changed-only emission avoids repainting overlays on every 500 ms poll
  (`server/src/form-detector.ts:60` to `server/src/form-detector.ts:68`);
- stale overlays are removed when fields disappear (`client/src/experiments/form-overlay.ts:135`
  to `client/src/experiments/form-overlay.ts:141`);
- object-fit/letterbox math is shared with pointer mapping (`client/src/geometry.ts:36`
  to `client/src/geometry.ts:61`, `client/src/geometry.ts:63` to `client/src/geometry.ts:108`);
- mobile/IME events that produce `"Unidentified"` or `"Process"` are not forced through
  key synthesis (`client/src/experiments/form-overlay.ts:80` to `client/src/experiments/form-overlay.ts:82`);
- paste/autofill/replacement is handled by semantic text insertion rather than replaying
  every character as keyboard events (`client/src/experiments/form-overlay.ts:111` to
  `client/src/experiments/form-overlay.ts:115`, `server/src/cdp-stream.ts:405` to
  `server/src/cdp-stream.ts:407`);
- password fields request password-manager/autofill treatment through
  `autocomplete="current-password"` (`client/src/experiments/form-overlay.ts:72` to
  `client/src/experiments/form-overlay.ts:76`).

Limitations:

- `select` and `contenteditable` are detected server-side but rendered as plain local inputs
  client-side (`server/src/form-detector.ts:4`, `client/src/experiments/form-overlay.ts:66`
  to `client/src/experiments/form-overlay.ts:70`).
- Deletions are robust only for end-of-string deletion; middle edits fall back to
  select-all plus text insertion (`client/src/experiments/form-overlay.ts:105` to
  `client/src/experiments/form-overlay.ts:115`).
- Local selection state is hidden by CSS (`user-select: none` in `client/index.html:76`),
  so the overlay optimizes typing feedback, not rich local text editing.
- It needs CDP page inspection and CDP text insertion, so it must be policy-gated for
  anti-bot-sensitive pages.

### Portability

Port this first for the CDP backend. The current package has a CDP adapter shell with
pointer/keyboard/paste plumbing but no form-rect event channel (`packages/remote-surface/src/adapters/cdp-surface-adapter.ts:45`
to `packages/remote-surface/src/adapters/cdp-surface-adapter.ts:52`,
`packages/remote-surface/src/backends/cdp/index.ts:28` to
`packages/remote-surface/src/backends/cdp/index.ts:36`). The package already has the
input capabilities to name text and paste separately (`packages/remote-surface/src/protocol/index.ts:156`
to `packages/remote-surface/src/protocol/index.ts:168`) and already parses backend events
as generic named events (`packages/remote-surface/src/protocol/index.ts:104` to
`packages/remote-surface/src/protocol/index.ts:110`). The missing seam is a typed
`form_elements`/field-overlay event and a client overlay helper.

For n.eko, use the same principle but not the same implementation. Current
`MobileTextInputController` is a global hidden textarea (`packages/remote-surface/src/ime/mobile-text-input-controller.ts:1`
to `packages/remote-surface/src/ime/mobile-text-input-controller.ts:74`). It captures
composition/text commits and special keys (`packages/remote-surface/src/ime/mobile-text-input-controller.ts:243`
to `packages/remote-surface/src/ime/mobile-text-input-controller.ts:347`) but does not
bind a local native input to a remote field rectangle. A field-bound overlay would be a
separate controller layered on `src/client/` geometry and `src/ime/` commit behavior.

## 2. Local Cursor Canvas

RBS hides stream latency for pointer movement with a second transparent canvas above the
JPEG stream. `LocalCursor` creates a canvas/context over the stream (`client/src/experiments/local-cursor.ts:4`
to `client/src/experiments/local-cursor.ts:16`), positions it on the same rendered rect as
the stream (`client/src/experiments/local-cursor.ts:22` to `client/src/experiments/local-cursor.ts:35`),
and draws a small blue circle with a white stroke at local viewport coordinates
(`client/src/experiments/local-cursor.ts:38` to `client/src/experiments/local-cursor.ts:48`).

The input bridge updates it on outbound pointer events before the remote frame reflects
the cursor (`client/src/main.ts:837` to `client/src/main.ts:842`). The UI toggle explicitly
describes the goal: instant feedback hiding roughly 150 ms stream latency (`client/index.html:328`
to `client/index.html:330`).

Portability: low effort, medium/high perceived impact. Add a `src/client/local-cursor`
helper using `containedStreamRect()` and `pointToStreamViewport()` (`packages/remote-surface/src/client/geometry.ts:247`
to `packages/remote-surface/src/client/geometry.ts:312`). It should be backend-agnostic
and optional, because n.eko may already draw a remote cursor in some modes.

## 3. Fast Decode And Frame Draw

RBS decodes JPEG frames with `createImageBitmap(new Blob(...))` when enabled
(`client/src/experiments/fast-decode.ts:6` to `client/src/experiments/fast-decode.ts:11`).
It uses a monotonically increasing decode token to discard stale decodes and closes unused
bitmaps to avoid leaking GPU memory (`client/src/experiments/fast-decode.ts:7`,
`client/src/experiments/fast-decode.ts:12` to `client/src/experiments/fast-decode.ts:15`).
Draws are staged through `requestAnimationFrame`; a pending frame is cancelled and the
superseded bitmap is closed (`client/src/experiments/fast-decode.ts:17` to
`client/src/experiments/fast-decode.ts:29`).

The baseline viewer also closes bitmaps and revokes Blob URLs on fallback image decode
(`client/src/viewer.ts:15` to `client/src/viewer.ts:79`). The main binary-frame path uses
fast decode when toggled, otherwise falls back to `drawBlob()` (`client/src/main.ts:713`
to `client/src/main.ts:728`). The toggle is on by default (`client/index.html:332`
to `client/index.html:334`).

Portability: low effort. `@opendatalabs/remote-surface` currently has protocol-level frame
payloads (`packages/remote-surface/src/protocol/index.ts:95` to
`packages/remote-surface/src/protocol/index.ts:102`) but no frame renderer in `src/client/`.
If the package owns a viewer helper, port RBS's decode-token and bitmap-close pattern.

## 4. Quality Slider And Screencast Tuning

RBS exposes stream quality directly: a 10-100 slider, default 80
(`client/index.html:231` to `client/index.html:233`). Input sends `{ type: "set_quality",
quality }` over the stream socket (`client/src/main.ts:1068` to `client/src/main.ts:1073`),
and initial session creation includes quality (`client/src/main.ts:872` to
`client/src/main.ts:898`). Server defaults are also 80 (`server/src/config.ts:3` to
`server/src/config.ts:8`, `docker-compose.yml:14`, `deploy/docker-compose.prod.yml:11`).

The CDP screencast starts as JPEG with the requested quality, `maxWidth` and `maxHeight`
equal to the viewport, and `everyNthFrame: 1` (`server/src/cdp-stream.ts:186` to
`server/src/cdp-stream.ts:193`). Resizing restarts the screencast with new dimensions
and current quality (`server/src/cdp-stream.ts:557` to `server/src/cdp-stream.ts:572`).
Quality changes clamp to 1-100 and restart the screencast (`server/src/cdp-stream.ts:576`
to `server/src/cdp-stream.ts:592`). Each frame is acked and then sent as a raw binary JPEG
buffer with optional viewer-network simulation and `frame_metrics` (`server/src/cdp-stream.ts:962`
to `server/src/cdp-stream.ts:1003`).

RBS docs record the user-facing threshold: quality 80 was readable at 2-6 FPS static,
typing latency was 150-300 ms without form overlay and near-immediate with form overlay
(`docs/decisions.md:9`).

Portability: medium effort. The package capabilities already list diagnostics and input
modes, but no quality control mode (`packages/remote-surface/src/protocol/index.ts:16`
to `packages/remote-surface/src/protocol/index.ts:36`). Add a backend-specific quality
command under CDP first, then consider a generic "visual quality preference" capability.

## 5. Coordinate Mapping, Resize, And Fit Logic

RBS solves canvas interaction by explicitly modeling the contained stream rect:
`fitContainedRect()` computes object-fit-contain placement (`client/src/geometry.ts:36`
to `client/src/geometry.ts:61`), `getCanvasSurfaceGeometry()` derives render/input rects
and scale from host/canvas/viewport data (`client/src/geometry.ts:63` to
`client/src/geometry.ts:108`), and `mapClientPointToViewport()` rejects points outside
the rendered stream then rounds/clamps viewport coordinates (`client/src/geometry.ts:110`
to `client/src/geometry.ts:132`).

That same geometry feeds pointer input (`client/src/input.ts:49` to `client/src/input.ts:57`),
local cursor placement, and form overlay placement. This shared math is why the overlay
can line up with the canvas even when letterboxed.

Resize handling is split by backend. For CDP/rrweb, RBS sets the canvas viewport size and
sends a WS `resize` with width/height/mobile/DPR/touch/UA (`client/src/main.ts:1181` to
`client/src/main.ts:1196`). Server-side resize applies `Emulation.setDeviceMetricsOverride`,
touch emulation, emit-touch-for-mouse, and UA override before restarting screencast
(`server/src/cdp-stream.ts:523` to `server/src/cdp-stream.ts:572`).

For n.eko, RBS does the harder three-layer alignment: X11 screen modeline, app window,
and CDP emulated viewport. The doc says the workable model is aligned-up X11 modes,
exact app window resize, CDP emulation, and client crop gutter (`docs/neko-mobile-viewport-problem.md:5`
to `docs/neko-mobile-viewport-problem.md:13`). `neko-client.ts` applies a viewport layout
by resizing/scaling/translating the media element (`client/src/neko-client.ts:33` to
`client/src/neko-client.ts:83`), and the n.eko Xorg config carries mobile/tablet modelines
(`server/src/neko/xorg.conf:47` to `server/src/neko/xorg.conf:80`).

Portability: much of this already landed. `packages/remote-surface/src/client/geometry.ts`
has `containedStreamRect()` and `pointToStreamViewport()` (`packages/remote-surface/src/client/geometry.ts:247`
to `packages/remote-surface/src/client/geometry.ts:312`). It also has mobile keyboard resize
suppression (`packages/remote-surface/src/client/geometry.ts:136` to
`packages/remote-surface/src/client/geometry.ts:245`) and viewport payload normalization
(`packages/remote-surface/src/client/geometry.ts:58` to
`packages/remote-surface/src/client/geometry.ts:99`). What is missing for RBS parity is a
public helper that maps remote element rects to local overlay CSS rects, not just points.

## 6. Keyboard And Clipboard Paths

RBS desktop keyboard path:

- `keydown` allows Ctrl/Cmd+V to become a native paste event, avoids preventing
  `"Unidentified"` so mobile input can fire, and otherwise forwards keydown with modifiers
  (`client/src/input.ts:227` to `client/src/input.ts:235`);
- `keyup` ignores `"Unidentified"` and forwards normal keyup (`client/src/input.ts:237`
  to `client/src/input.ts:242`);
- server key dispatch uses CDP `Input.dispatchKeyEvent` (`server/src/input.ts:81` to
  `server/src/input.ts:99`).

RBS mobile/soft-keyboard fallback:

- a hidden `#keyboard-proxy` textarea exists in the DOM (`client/index.html:213` to
  `client/index.html:214`);
- its `input` event sends `paste_text` and clears the value, specifically for mobile
  keyboards (`client/src/input.ts:244` to `client/src/input.ts:255`);
- remote focus detection can focus or blur the local proxy (`client/src/focus-events.ts:1`
  to `client/src/focus-events.ts:77`, `client/src/main.ts:1741` to
  `client/src/main.ts:1758`).

RBS clipboard path:

- local paste events are intercepted and sent as `paste_text` (`client/src/input.ts:257`
  to `client/src/input.ts:263`);
- `paste_text` becomes `Input.insertText` on the server (`server/src/cdp-stream.ts:405`
  to `server/src/cdp-stream.ts:407`);
- after Ctrl+C keydown, the server waits briefly, reads `document.getSelection()?.toString()`,
  and emits a `clipboard` event (`server/src/cdp-stream.ts:486` to
  `server/src/cdp-stream.ts:489`, `server/src/cdp-stream.ts:1081` to
  `server/src/cdp-stream.ts:1095`);
- the client writes remote clipboard text through `navigator.clipboard.writeText`
  (`client/src/main.ts:763` to `client/src/main.ts:765`).

n.eko-specific RBS keyboard handling focuses n.eko's internal overlay textarea after
remote focus, periodically while remote input remains focused, and blurs it on remote blur
(`client/src/neko-client.ts:117` to `client/src/neko-client.ts:158`). That is a pragmatic
hack around n.eko's own text path.

Portability: partially done. `MobileTextInputController` already captures compositionend,
input events, paste/autocomplete input types, Backspace/Delete/Enter, and special keys
(`packages/remote-surface/src/ime/mobile-text-input-controller.ts:251` to
`packages/remote-surface/src/ime/mobile-text-input-controller.ts:347`). `NekoSurfaceAdapter`
wires committed text to `sendText` and special keys to `sendKeysym`
(`packages/remote-surface/src/adapters/neko-surface-adapter.ts:260` to
`packages/remote-surface/src/adapters/neko-surface-adapter.ts:292`,
`packages/remote-surface/src/adapters/neko-surface-adapter.ts:361` to
`packages/remote-surface/src/adapters/neko-surface-adapter.ts:421`). The CDP adapter still
uses a simpler keyboard/paste model (`packages/remote-surface/src/adapters/cdp-surface-adapter.ts:295`
to `packages/remote-surface/src/adapters/cdp-surface-adapter.ts:340`).

The RBS improvement to port is not another hidden textarea. It is field-bound overlay text
entry plus `Input.insertText` as the primary text primitive.

## 7. Mobile And Touch Handling

RBS touch input is deliberately mouse-backed for click reliability. On touchstart/move/end
it prevents default, suppresses synthetic mouse for 1s, blurs the remote active element
before touch, focuses the container, applies an 8 px drag threshold, and sends tap as
mouse down/up while drag sends down/move/up (`client/src/input.ts:80` to
`client/src/input.ts:152`). Pointer events ignore touch pointers because touch is handled
separately (`client/src/input.ts:154` to `client/src/input.ts:184`).

Wheel events prevent default and use ctrl/meta wheel as pinch/zoom-like input
(`client/src/input.ts:214` to `client/src/input.ts:225`). The page meta tag sets
`interactive-widget=resizes-visual` (`client/index.html:5`), and the stream surface disables
browser touch gestures/callouts (`client/index.html:63`).

The Instagram mobile test summary says all four recorded login runs passed, with perceived
latency rated 4/5 for CDP/WebRTC and 5/5 for rrweb (`instagram-mobile-login-test-summary.md:14`
to `instagram-mobile-login-test-summary.md:25`). Shared issues remained: focus-triggered
viewport shift, incomplete edit affordances, no meaningful scroll coverage, no 2FA/CAPTCHA/
suspicious challenge coverage (`instagram-mobile-login-test-summary.md:26` to
`instagram-mobile-login-test-summary.md:31`). The table records Gboard swipe typing working
in CDP but backspace and keyboard dismissal being inconsistent
(`instagram-mobile-login-test-summary.md:35` to `instagram-mobile-login-test-summary.md:40`).

Portability: RBS confirms the direction already encoded in `NekoPointerController`.
That controller documents the same tap-to-click convention and explicitly avoids emitting
native touch by default because touch+mouse double-fired on Android Brave
(`packages/remote-surface/src/controllers/neko-pointer-controller.ts:9` to
`packages/remote-surface/src/controllers/neko-pointer-controller.ts:45`). It implements
buttonDown/buttonUp/move and pointercancel release (`packages/remote-surface/src/controllers/neko-pointer-controller.ts:122`
to `packages/remote-surface/src/controllers/neko-pointer-controller.ts:183`). The package
also has a n.eko touch-scroll bridge policy (`packages/remote-surface/src/backends/neko/touch-scroll.ts:23`
to `packages/remote-surface/src/backends/neko/touch-scroll.ts:79`).

The CDP adapter is less complete than RBS: it forwards touchstart/move/end as touch events
(`packages/remote-surface/src/adapters/cdp-surface-adapter.ts:251` to
`packages/remote-surface/src/adapters/cdp-surface-adapter.ts:293`) but does not carry RBS's
tap/drag threshold, synthetic mouse suppression, or remote active-element blur.

## 8. Skeleton And Loading UX

RBS avoids blank-canvas waiting with hostname-aware skeletons. `skeleton.ts` maps Google,
Instagram, X, and default surfaces to background/accent/logo choices
(`client/src/experiments/skeleton.ts:1` to `client/src/experiments/skeleton.ts:27`).
`show(url)` extracts hostname, writes the skeleton markup, and activates a centered pulse
(`client/src/experiments/skeleton.ts:36` to `client/src/experiments/skeleton.ts:59`).
`hide()` fades the inner content and clears after 300 ms (`client/src/experiments/skeleton.ts:61`
to `client/src/experiments/skeleton.ts:70`).

The main flow shows the skeleton before session creation (`client/src/main.ts:850` to
`client/src/main.ts:858`) and hides it on the first frame draw (`client/src/main.ts:713`
to `client/src/main.ts:727`). The toggle is on by default (`client/index.html:336` to
`client/index.html:338`).

Portability: low effort. Put this in `src/client/` as a generic first-frame placeholder
hook. Keep it brand-neutral and host-provided: the package should accept a skeleton
descriptor rather than embed site-specific logos.

## 9. WS Frame And Input Protocol Shape

RBS protocol is intentionally narrow and explicit. `server/src/types.ts` defines:

- session config with URL, UA, viewport, locale/timezone/geolocation, quality, proxy, stream
  mode, and audio flags (`server/src/types.ts:5` to `server/src/types.ts:21`);
- mouse, key, scroll, quality, form detection, navigate, network simulation, resize,
  paste text, blur, sync input, commit-and-press, dialog/file/select/full-snapshot inputs
  (`server/src/types.ts:35` to `server/src/types.ts:191`);
- server events for URL changes, errors, cursor, form elements, frame metrics, dialog,
  popup, clipboard, file, select, and rrweb (`server/src/types.ts:195` to
  `server/src/types.ts:303`).

Operational details matter:

- WS handlers register before CDP setup, queueing pending messages until the page is ready
  (`server/src/cdp-stream.ts:74` to `server/src/cdp-stream.ts:87`);
- pending messages replay after setup (`server/src/cdp-stream.ts:196` to
  `server/src/cdp-stream.ts:199`);
- heartbeat pings every 15s (`server/src/cdp-stream.ts:95` to
  `server/src/cdp-stream.ts:103`);
- message handling is serialized (`server/src/cdp-stream.ts:294` to
  `server/src/cdp-stream.ts:300`);
- `mousemove`, `scroll`, and `sync_input` are coalesced by type/key before dispatch
  (`server/src/cdp-stream.ts:303` to `server/src/cdp-stream.ts:339`);
- video frames are raw binary JPEG buffers, while audio chunks are distinguishable by a
  prefix byte in the client path (`client/src/main.ts:697` to `client/src/main.ts:700`).

Portability: the package's canonical protocol is JSON/SSE-shaped and safer for public
surfaces (`packages/remote-surface/src/protocol/index.ts:95` to
`packages/remote-surface/src/protocol/index.ts:123`, `packages/remote-surface/src/protocol/index.ts:125`
to `packages/remote-surface/src/protocol/index.ts:168`). Port the concepts, not necessarily
the wire shape: explicit text/paste/form/quality events, pending-input queue until ready,
heartbeat/lifecycle, and coalescing for high-volume inputs.

## 10. Browser Posture That Passed Cloudflare

The strongest evidence is in the onboarding dossier, not only checked-in source: the old
RBS VM passed ChatGPT Cloudflare with pure CDP screencast in minutes, and the root-cause
conclusion was binary/channel plus profile posture, not CDP transport
(`docs/research/remote-surface-ux-onboarding-2026-07-06.md:150` to
`docs/research/remote-surface-ux-onboarding-2026-07-06.md:154`).

Checked-in RBS standalone CDP posture:

- launches headed (`headless: false`) with `defaultViewport: null`
  (`server/src/browser.ts:137` to `server/src/browser.ts:144`);
- uses `CHROME_PATH || puppeteer.executablePath()` (`server/src/browser.ts:137` to
  `server/src/browser.ts:142`);
- strips Puppeteer's `--enable-automation` default arg (`server/src/stealth.ts:77` to
  `server/src/stealth.ts:79`);
- applies viewport/mobile/touch/UA through CDP (`server/src/browser.ts:149` to
  `server/src/browser.ts:182`);
- supports proxy auth through `page.authenticate()` (`server/src/browser.ts:218` to
  `server/src/browser.ts:223`);
- keeps sessions alive with TTL and a 30s grace after WS close (`server/src/browser.ts:245`
  to `server/src/browser.ts:252`, `server/src/browser.ts:315` to
  `server/src/browser.ts:324`).

Stealth args include disabling AutomationControlled, first-run/default-browser prompts,
component/default apps/extensions where appropriate, popup blocking, translate, sync,
background networking, and metrics reporting, plus no-sandbox/dev-shm/SwiftShader flags
(`server/src/stealth.ts:5` to `server/src/stealth.ts:49`). Proxy URL handling can randomize
SOAX session IDs (`server/src/stealth.ts:52` to `server/src/stealth.ts:64`).

Checked-in Docker posture:

- standalone server images install Debian `chromium` and set `CHROME_PATH=/usr/bin/chromium`
  (`server/Dockerfile:3` to `server/Dockerfile:27`, `deploy/Dockerfile.prod:20` to
  `deploy/Dockerfile.prod:47`);
- `entrypoint.prod.sh` starts Xvfb, nginx, then Node (`deploy/entrypoint.prod.sh:4`
  to `deploy/entrypoint.prod.sh:14`);
- n.eko uses a pinned Chromium image (`server/src/neko/Dockerfile:7`) and a persistent
  profile volume at `/home/neko/.config/chromium` (`server/src/neko/Dockerfile:49`);
- n.eko Chrome starts with `--user-data-dir=/home/neko/.config/chromium`, remote debugging,
  app-window mode, optional proxy server, and app data URL (`server/src/neko/start-chromium.sh:7`
  to `server/src/neko/start-chromium.sh:25`);
- managed policies disable sign-in/sync/password manager/guest profile, allow autoplay, and
  restrict file URLs (`server/src/neko/policies.json:1` to `server/src/neko/policies.json:29`);
- docker compose shares network namespace between app and n.eko so CDP can reach localhost
  (`docker-compose.yml:4` to `docker-compose.yml:19`, `deploy/docker-compose.prod.yml:6`
  to `deploy/docker-compose.prod.yml:17`).

Portability: this belongs in `src/backends/cdp/` as posture reporting and host-side launch
guidance, not in browser-exposed descriptors. The current package already prevents unsafe
CDP URLs/tokens from reaching clients (`packages/remote-surface/src/protocol/index.ts:463`
to `packages/remote-surface/src/protocol/index.ts:493`). Add diagnostics that can say:
binary/channel, profile persistence, headless/headed, automation defaults stripped, proxy
mode, and whether CDP is being used during challenge-sensitive windows.

## 11. Related RBS Technique: rrweb Live DOM Mirror

This was not the specific old-CDP Cloudflare path, but it is highly relevant to "keyboard
felt native." RBS's rrweb/live-DOM renderer reconstructs a sandboxed iframe with real local
inputs so password managers, autofill, and selection can be native (`docs/rrweb-live-dom-handoff.md:3`
to `docs/rrweb-live-dom-handoff.md:17`). It syncs typed input back to the remote with
debounced `sync_input` and uses `commit_and_press` for Enter/Tab
(`docs/rrweb-live-dom-handoff.md:46` to `docs/rrweb-live-dom-handoff.md:53`).

Implementation details:

- sandbox iframe with no scripts but forms/same-origin allowances (`client/src/live-dom-renderer.ts:200`
  to `client/src/live-dom-renderer.ts:206`);
- events batched every 16 ms (`client/src/live-dom-renderer.ts:250` to
  `client/src/live-dom-renderer.ts:281`);
- focused/dirty input state, selection, and scroll are preserved across snapshots
  (`client/src/live-dom-renderer.ts:650` to `client/src/live-dom-renderer.ts:747`);
- scripts, event handlers, links, forms, and unsafe resources are sanitized/proxied
  (`client/src/live-dom-renderer.ts:1430` to `client/src/live-dom-renderer.ts:1608`);
- editable targets keep normal local character editing, while Enter/Tab and non-editable
  keys are forwarded (`client/src/live-dom-renderer.ts:1966` to
  `client/src/live-dom-renderer.ts:2011`);
- input events send target descriptors and text with a 50 ms debounce
  (`client/src/live-dom-renderer.ts:2026` to `client/src/live-dom-renderer.ts:2057`);
- cross-origin/captcha iframes are detected and replaced with cropped screencast overlays
  (`client/src/live-dom-renderer.ts:1804` to `client/src/live-dom-renderer.ts:1912`,
  `client/src/screencast-overlay.ts:40` to `client/src/screencast-overlay.ts:94`).

Portability: high impact but high effort and higher correctness risk. Treat this as a
separate R&D lane after the simpler form overlay is proven. The durable lesson for
`@opendatalabs/remote-surface` is "semantic local controls when possible, pixels when not."

## Portability By Package Seam

### `src/client/`

Best fits:

- overlay-rect math: extend `containedStreamRect()` from point mapping to remote-rect to
  local-CSS mapping (`packages/remote-surface/src/client/geometry.ts:247` to
  `packages/remote-surface/src/client/geometry.ts:312`);
- local cursor canvas helper;
- fast JPEG decode/draw helper if the package owns rendering;
- skeleton/first-frame state helper;
- typed form-overlay controller that accepts remote field records and calls backend text/key
  callbacks;
- clipboard policy already exists and can host explicit local-to-remote/remote-to-local UI
  decisions (`packages/remote-surface/src/client/clipboard-policy.ts:107` to
  `packages/remote-surface/src/client/clipboard-policy.ts:150`).

### `src/backends/cdp/`

Current CDP backend descriptor only exposes capabilities and safe descriptor parsing
(`packages/remote-surface/src/backends/cdp/index.ts:28` to
`packages/remote-surface/src/backends/cdp/index.ts:53`). Add CDP-host implementation seams:

- start/stop screencast with tunable JPEG quality;
- emit `form_elements` from a FormDetector equivalent;
- handle semantic text insertion through `Input.insertText`;
- expose focus events (`keyboard_focus`) and remote clipboard events;
- report browser posture without exposing unsafe endpoints;
- queue/coalesce input before page-ready, like RBS.

### `src/controllers/`

`NekoPointerController` already absorbed the tap-to-click lesson (`packages/remote-surface/src/controllers/neko-pointer-controller.ts:9`
to `packages/remote-surface/src/controllers/neko-pointer-controller.ts:45`). The missing
RBS pieces are mostly for CDP/touch:

- tap/drag threshold;
- synthetic mouse suppression after touch;
- active remote element blur before touch when appropriate;
- optional local cursor update hook.

### `src/ime/`

Current IME code is stronger than the old RBS hidden-textarea fallback in composition
handling, but weaker than RBS form overlay in field-local UX. Keep
`MobileTextInputController` for global soft-keyboard capture; add a separate
`FormOverlayTextController` or similar for field-bound native inputs. Do not force field
overlay semantics into `MobileTextInputController`; its header explicitly warns against
mixing commit-only and diff-style invariants (`packages/remote-surface/src/ime/mobile-text-input-controller.ts:18`
to `packages/remote-surface/src/ime/mobile-text-input-controller.ts:23`).

`keysym.ts` is still just a deferred type stub (`packages/remote-surface/src/ime/keysym.ts:1`
to `packages/remote-surface/src/ime/keysym.ts:17`). If CDP overlay ports first, it can avoid
expanding keysym scope by using CDP key strings for special keys and `Input.insertText`
for text.

## Ranked Port List

1. **CDP form overlay and semantic text insertion**
   Impact: very high. Effort: medium. Risk: CDP policy/anti-bot gating. This is the RBS
   differentiator for typing feel.

2. **Remote field event and overlay-rect geometry in `src/client/`**
   Impact: high. Effort: medium. Risk: field detection correctness. Needed to make form
   overlay package-clean rather than app-specific.

3. **Explicit text/paste path using `Input.insertText` for CDP**
   Impact: high. Effort: low/medium. Risk: low for normal fields. Avoids fragile per-key
   replay for paste, autofill, mobile commits, and password entry.

4. **Local cursor overlay**
   Impact: medium/high. Effort: low. Risk: low. Immediate perceived latency win.

5. **Fast decode with stale-frame discard and bitmap cleanup**
   Impact: medium. Effort: low. Risk: low. Good package helper if the package owns frame
   rendering.

6. **CDP input coalescing and ready-queue discipline**
   Impact: medium/high. Effort: medium. Risk: low. RBS has proven patterns for queue,
   serialize, heartbeat, and coalesce.

7. **CDP mobile touch parity with RBS**
   Impact: medium. Effort: low/medium. Risk: medium. Port tap/drag threshold, synthetic
   mouse suppression, and blur-before-touch into the CDP adapter.

8. **Skeleton/first-frame UX helper**
   Impact: medium. Effort: low. Risk: low. Avoid blank/ambiguous states while sessions
   boot or first frame decodes.

9. **Quality control and diagnostics for screencast**
   Impact: medium. Effort: medium. Risk: low. Useful for tuning and field debugging; keep
   backend-specific until more than CDP supports it.

10. **Browser posture diagnostics for Cloudflare-sensitive flows**
    Impact: high. Effort: medium. Risk: medium. Report binary/channel/profile/headed/proxy
    posture from host-side code without leaking unsafe descriptors to clients.

11. **rrweb live DOM mirror**
    Impact: potentially very high. Effort: high. Risk: high. Mine after form overlay ships;
    it is a larger architecture lane, not the first portability move.

## Bottom Line

The RBS UX edge was not one trick. It was a layered approach: pixels for broad visual
compatibility, native local controls for text, fast local feedback for cursor/typing/loading,
and CDP semantic primitives for committing text. The first implementation lane should port
the form overlay into the CDP backend and make the overlay geometry/client controller clean
inside `@opendatalabs/remote-surface`. That gives the current package the biggest RBS UX
win without taking on the full rrweb live-DOM mirror or another n.eko IME rewrite.

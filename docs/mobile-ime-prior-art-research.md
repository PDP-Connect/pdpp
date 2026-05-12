# Mobile IME (Android Gboard) prior-art research for remote-browser typing

Context: Chromium runs on a Linux X11 host, streamed via WebRTC to Android Brave/Chrome. Android soft keyboards (Gboard, SwiftKey) do not emit usable `keydown` events — they fire `keyCode === 229` ("composition in progress") and deliver real characters in `InputEvent.data` on `beforeinput`/`input` of a focused editable element. Naive paste-style forwarding breaks for CJK composition, emoji, autocomplete, predictive replacement, and swipe-typing. This document inventories what shipping products and OSS projects actually do.

---

## Priority 1 — Hyperbeam (hyperbeam.com)

**Status: active but tiny.** The site is up, status page operational, domain registered through July 2026, YC W22, $500K raised, currently ~2 employees per Tracxn (down from 5). No acquisition, no shutdown. ([scalarly.com][1], [ycombinator.com][2], [updownradar][3], [tracxn][4])

**Public technical surface.** Hyperbeam's stack is documented at a high level: a resource-optimized Chromium fork running in a server-side VM, streamed to clients via WebRTC; client SDK (`@hyperbeam/web`) embeds the video and forwards input. ([ycombinator.com][2], [docs.hyperbeam.com][5]) The FAQ confirms mobile is a first-class target — you set `user_agent: "chrome_android"` to make the remote Chromium pretend to be mobile, and the client handles taps/gestures. ([docs.hyperbeam.com][5])

**Mobile IME specifics.** There is **no public engineering writeup** describing how Hyperbeam bridges Android soft-keyboard composition into the remote Chromium. Their Launch HN, YC profile, docs site, and the small set of engineering posts do not address it. ([HN Launch][6]) The SDK is closed-source; the npm `@hyperbeam/web` package is a minified bundle. Founders (Goncalves, Balaji) have not posted talks or blog posts on input handling.

**Adaptability.** Black box. The most we can infer is the architecturally-forced approach: any WebRTC-streamed remote browser that "works" on mobile must implement some variant of the Guacamole text-input pattern (hidden editable element, listen to `input`/`compositionend`, diff-and-forward). There is no Hyperbeam-specific technique to copy.

---

## Priority 2 — Caracal.club

**Status: active, closed-source.** Site live (HTTP 200, fresh content, Cloudflare-fronted, PHP backend with `PHPSESSID` cookies). ([live HTML fetched 2026-05-12][7]) Subscription product, $5/mo paid tier. No GitHub presence under "caracal" matches this project; it is **not** open source.

**What m1k1o/neko issue #381 actually requested.** Despite the issue being widely cited as proof Caracal "solved mobile," reading the thread shows the bounty was for **mobile *layout*** (landscape full-screen video + swipe-up chat panel), not IME input. The maintainer shipped a CSS-only patch on branch `scroll-to-chat-on-mobile`, later merged as PR #496. ([GitHub #381][8]) Nothing in the thread discusses Gboard, composition, beforeinput, or keysym translation. The requester (SpiderSuave) is a movie-night user, not an engineer.

**Adaptability.** None for IME. Issue #381 is a red herring for our problem; the only Caracal evidence is "watch parties work OK on mobile for tap/scroll," which doesn't require solving the typing problem at all (you don't type during a movie).

---

## Priority 3 — Apache Guacamole (the real prior art)

This is where the actual technique lives, and m1k1o himself points to it.

**Maintainer position.** In m1k1o/neko issue #547, m1k1o writes verbatim: *"Neko uses Guacamole's keyboard implementation… They do not seem to support as well, instead they say: 'If you wish to type via an IME (input method editor)… text input mode is required for this as well.' Maybe we should implement such text input mode for neko too."* ([GitHub #547][9]) Translation: the upstream maintainer knows the answer, has not built it, and considers it open work.

**Guacamole's documented approach** ([Guacamole manual][10]):
- Three keyboard modes: None, Text input, On-screen keyboard.
- Text-input mode hides a `<textarea>` to trigger the device IME, lets the IME do its full composition cycle locally (including CJK candidate selection), then on commit it **diffs textarea contents against the previous snapshot** to infer keystrokes.
- Diff algorithm (verified in `guacTextInput.js`, lines ~150ff): strip common prefix and suffix; deleted middle → `BackSpace` keysym (0xFF08) press/release pairs; inserted middle → for each Unicode codepoint, translate to X11 keysym (`codepoint` if ≤0xFF, else `0x01000000 | codepoint`) and send press/release. The textarea is padded with zero-width-space characters (U+200B) so the user has Backspace/Delete headroom and is periodically reset. ([apache/guacamole-client `guacTextInput.js`][11])
- IME composition is bracketed with `compositionstart`/`compositionend` listeners; mutations during composition are suppressed, and only the committed string is forwarded. This is exactly the channel that solves CJK, predictive autocomplete, swipe-typing, and emoji — because all of them resolve into a committed Unicode string before the diff runs.

**Limitations Guacamole itself flags.** Modifier combos (Ctrl-Alt-Del, Alt-Tab, system-reserved chords) cannot be expressed in text-input mode, so Guacamole adds an on-screen modifier strip (Ctrl, Alt, Esc, Tab) alongside the textarea. ([manual][10]) Also, certain IME-heavy flows (autocompletion replacing already-committed text) still work but rely on the diff catching multi-char deletes + inserts.

**Adaptability.** Direct fit. Guacamole is Apache-2.0; `guacTextInput.js` (a few hundred lines of plain DOM + a keysym map) can be ported into a neko/PDPP client component verbatim. The remote side already speaks X11 keysyms — neko's existing keyboard wire format and `xdotool key` / X11 `XTestFakeKeyEvent` integration already accept what Guacamole produces. The work is on the **client**, not the host.

---

## Priority 4 — Other prior art surveyed

- **m1k1o/neko upstream**: issue #115 ("mobile keyboard input"), #251 ("mobile support"), #547 (IME) all open or partially-fixed (focus textarea to summon keyboard, but no diff/composition pipeline). No PR has landed a text-input mode in 5+ years. ([m1k1o/neko issues][12])
- **Browserbase / Steel.dev / browserless**: paid agent-browser products. No public docs on mobile IME — their target customer is *AI agents driving headless browsers from servers*, not humans typing on phones. Mobile typing is a non-goal. (Survey of their docs surfaced nothing relevant.)
- **Microsoft RDP for Android**: solves the same problem but architecturally cheats — the RDP protocol has a first-class "Unicode mode" that sends codepoints directly, plus a "Scancode mode" for physical keys. Toggle is a documented user setting. ([learn.microsoft.com][13]) Conceptually identical to Guacamole's separation of "commit string" vs "raw key."
- **Wayland `input-method-unstable-v1`**: canonical protocol-level reference. Distinguishes `commit_string` (final text from IME, the channel CJK uses) from `forward_key`/synthetic `keysym` (raw key passthrough). Confirms the architectural pattern: **never try to synthesize keysyms from composing text — only from the committed string.** ([wayland.app][14])
- **rrweb**: captures DOM events for replay. Theoretically could capture `input`/`beforeinput` on a local textarea, but rrweb is designed for *replay-into-DOM*, not *forward-into-remote-X11*. The capture half is useful as a model; the playback half is irrelevant.
- **Editor projects (CKEditor, Slate, ProseMirror)**: years of bug reports (CKEditor #12058, #13693; Slate #5883) confirm the underlying browser model — Android requires a "completely custom handling" because composition events fire differently than every other platform, and the only reliable signal is `beforeinput.data` after the IME commits. ([CKEditor #12058][15])

---

## Architectural recommendation for PDPP

**Adopt Guacamole's text-input mode pattern, ported to the neko/PDPP client.** Specifically:

1. **Two-mode toggle on the client.** Default desktop = direct keydown/keyup with X11 keysym map (what neko already does). Mobile-detected (`navigator.maxTouchPoints > 0 && coarse-pointer media query`) = text-input mode by default, with a "raw keys" toggle in settings for power users.

2. **Text-input mode mechanics** (clone of `guacTextInput.js`):
   - Hidden `<textarea>` with `autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text"`, padded with 4× U+200B on each side of the cursor.
   - Listen to `input`, `compositionstart`, `compositionend`. Suppress forwarding while `composingText === true`.
   - On `input` (when not composing) or `compositionend`: snapshot value, diff vs previous snapshot using common-prefix/suffix strip, emit `BackSpace` keysyms for deletions and `keysymFromCodepoint(cp)` for insertions, then reset the textarea to a fresh U+200B-padded state.
   - Surface modifier chord buttons (Ctrl/Alt/Esc/Tab/arrows/F-keys) in a mobile toolbar — the ALLOWED_KEYS set from Guacamole is a complete starting list.

3. **Wire format.** No protocol change needed. Neko's existing keyboard event opcode already takes `(keysym, state)` pairs; the client just emits more of them per "tap."

**What this handles natively:**
- English typing → diff yields one codepoint per `input` → one keysym press/release. ✅
- CJK (Pinyin etc.) → IME does its candidate UI locally on the device; on commit, `compositionend` fires with the chosen string; diff emits its codepoints. ✅
- Emoji → single (or surrogate-pair-decoded) codepoint via the `0x01000000 | cp` keysym range. ✅
- Autocomplete / predictive replacement → multi-char delete + multi-char insert resolves in the diff. ✅
- Swipe-typing → Gboard treats a swipe as one committed word; same path as autocomplete. ✅
- Arrow keys / Enter / Backspace from soft keyboard → these *do* fire real keydown on Android even in IME mode; pass them through directly (Guacamole's ALLOWED_KEYS list). ✅

**Confidence and validation plan.**

Realistic confidence we hit "feels native enough" on the first iteration: **~70%.** Guacamole has been running this in production for >10 years across Chinese/Japanese/Korean enterprise users, so the algorithm is battle-tested. The 30% risk is integration-shaped, not algorithm-shaped:
- Brave-on-Android quirks (Brave occasionally diverges from Chrome on composition timing).
- Race between `compositionend` and `input` ordering on different Android versions.
- Latency of WebRTC datachannel for keysym pairs vs. user's typing speed in IME candidate flows.

**How to de-risk in <1 day of work, not 1–2 weeks:**
1. **Standalone harness page.** Build a static page with the proposed textarea + diff logic that logs `[keysym press/release, codepoint]` to the screen. Deploy to a URL the owner can open on his Android Brave. Type English, CJK (install Gboard Pinyin), emoji, swipe-typed words, autocomplete tap-completions. Read the log. This proves the *client half* in isolation, with zero remote-browser plumbing — pure DOM + diff + console output.
2. **Loopback into a local textarea.** Same page, second textarea below the log, where the synthesized keysym stream is converted back to characters and `document.execCommand('insertText')`-ed in. If the second textarea matches the first after every test, the algorithm is correct.
3. **Only then** wire it into PDPP's neko fork. By that point the remaining work is "send these keysym pairs over the existing websocket instead of into a local textarea" — a few hours.

If the standalone harness shows correct codepoint extraction across all six categories (English, CJK, emoji, autocomplete, swipe, special keys), confidence rises to ~90% before we touch the server. If it shows gaps, we know exactly what to fix without having debugged through a video-streaming + WebRTC layer.

---

## Sources

[1]: https://www.scalarly.com/startup-stack/hyperbeam/ "Hyperbeam startup profile"
[2]: https://www.ycombinator.com/companies/hyperbeam "Hyperbeam (YC W22)"
[3]: https://updownradar.com/status/hyperbeam.com "Hyperbeam uptime"
[4]: https://tracxn.com/d/companies/hyperbeam "Hyperbeam company profile 2026"
[5]: https://docs.hyperbeam.com/home/user "Hyperbeam FAQ — mobile user_agent"
[6]: https://news.ycombinator.com/item?id=30433104 "Launch HN: Hyperbeam API"
[7]: https://caracal.club/ "Caracal.club (alive 2026-05-12)"
[8]: https://github.com/m1k1o/neko/issues/381 "neko #381 — caracal-style phone layout (CSS-only)"
[9]: https://github.com/m1k1o/neko/issues/547 "neko #547 — maintainer on Guacamole text input"
[10]: https://guacamole.apache.org/doc/gug/using-guacamole.html "Apache Guacamole manual: text input mode"
[11]: https://github.com/apache/guacamole-client/blob/master/guacamole/src/main/frontend/src/app/textInput/directives/guacTextInput.js "guacTextInput.js source (Apache-2.0)"
[12]: https://github.com/m1k1o/neko/issues "neko issues — #115, #251, #547"
[13]: https://learn.microsoft.com/en-us/previous-versions/remote-desktop-client/client-features-android-chrome-os "RDP Android — Unicode vs Scancode"
[14]: https://wayland.app/protocols/input-method-unstable-v1 "Wayland input-method-v1: commit_string vs keysym"
[15]: https://github.com/ckeditor/ckeditor5/issues/12058 "CKEditor: Android composition needs custom handling"

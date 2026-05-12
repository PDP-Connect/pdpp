# @demodesk/neko on Android Mobile — Research Findings

**Date:** 2026-05-12
**Question:** If we refactor PDPP to embed `@demodesk/neko` for the Android Brave streaming surface, should we expect a native-feeling experience, or will we still be patching the same 5 bugs (synth click, keyboard flicker, IME `Unidentified`, long-press save-image, viewport black bars)?

**TL;DR:** Adopting `@demodesk/neko` solves the easy bugs (touch suppression, contextmenu, save-image overlay) but inherits the hard one: **IME / Gboard typing on Android is a known, open, multi-year limitation of the entire neko family**, explicitly aligned with Guacamole's stance that you need a separate "text input mode" instead of raw keyboard forwarding. The demodesk fork has not solved this. Plan on writing a non-trivial IME shim — and even then, expect lower confidence than desktop.

---

## 1. Known mobile touch / Android issues (with citations)

Mobile is officially "partial" support. The maintainer (`@m1k1o`) has stated this repeatedly:

- **[#251 — Feature: Mobile support](https://github.com/m1k1o/neko/issues/251)** (open, 2023-02-19): `"Mobile support is only partial now."` Confirms watching works; control + IME do not work end-to-end. Tagged for the **n.eko v3 client** rewrite milestone ([#371](https://github.com/m1k1o/neko/issues/371)).
- **[#115 — Add mobile keyboard input support](https://github.com/m1k1o/neko/issues/115)** (closed 2024 by [PR #497](https://github.com/m1k1o/neko/pull/497) "show keyboard icon on touch screen devices"). The fix is just a UI button that focuses a hidden textarea — **it does not solve IME forwarding**, only on-screen keyboard visibility.
- **[#522 — Fix mobile keyboard behavior](https://github.com/m1k1o/neko/pull/522)** (merged): explicitly notes `"Other logic was removed as it was causing some issues on android, mainly closing the keyboard right after it has been shown."` — the same **keyboard flicker** symptom the owner is hitting in the hand-rolled implementation. This is what PDPP would inherit "for free."
- **[#566 — Keyboard open half of time that i interact on mobile…some browsers don't have input text](https://github.com/m1k1o/neko/issues/566)** (open, 2025-08): a real user reports the keyboard opening on every scroll/tap and being non-functional for input. Their workaround is to inject a Tampermonkey on-screen QWERTY inside the streamed Chrome — i.e. give up on the host IME entirely.
- **[#473 — Clipboard sharing not works on iOS (+ mobile screen resolution)](https://github.com/m1k1o/neko/issues/473)** (open).
- **[#640 — Mobile track pad support](https://github.com/m1k1o/neko/issues/640)** (open, 2026-04): cursor-vs-absolute touch is still being debated; user request for "donate to whoever can make phone layout exactly like caracal.club" — [#381](https://github.com/m1k1o/neko/issues/381) — has sat open since 2024.
- **[#62 — iOS doesn't play audio](https://github.com/m1k1o/neko/issues/62)** and a string of mobile autoplay/codec edge cases on the [releases page](https://github.com/m1k1o/neko/releases).

## 2. Is Android IME (Gboard, SwiftKey) known to work?

**No.** This is the single highest-confidence finding in the research.

- **[#547 — Support behavior of IME](https://github.com/m1k1o/neko/issues/547)** (open). Maintainer's reply is the definitive answer:
  > *"Neko uses [Guacamole's keyboard implementation](https://guacamole.apache.org/doc/gug/using-guacamole.html). They do not seem to support [IME] as well, instead they say: 'If you wish to type via an IME (input method editor)…text input mode is required for this as well. Such IMEs function through the explicit insertion of text and do not send traditional key presses.' Maybe we should implement such text input mode for neko too."*

  So the project is *aware* IME needs a separate text-input-mode RPC (`compositionend` → server-side `xdotool type`-equivalent), but **as of May 2026 nobody has built it**.

- **[#252 — support Chinese](https://github.com/m1k1o/neko/issues/252)** (closed without a fix; user redirected to clipboard paste).
- The community-blessed workaround per [#566](https://github.com/m1k1o/neko/issues/566) and the comment thread on [#115](https://github.com/m1k1o/neko/issues/115) is **type into the chat/clipboard text box and use a "send" button** (PR-merged in [#497](https://github.com/m1k1o/neko/issues/115#issuecomment-link)) or paste via clipboard. This is functionally equivalent to giving up on real-time typing.

The `@demodesk/neko` bundle's commented-out `compositionend` handler ("Removed because of clipboard handling") is consistent with this history — the fork removed it because the v2 design routes mobile text through clipboard, not the keystroke channel.

## 3. Has anyone shipped this to mobile end-users at quality?

I could not find a single first-party blog post, conference talk, or Reddit thread describing "we shipped n.eko to phones at a quality bar our users like." Adjacent evidence:

- **[Umbrel App Store listing](https://apps.umbrel.com/app/neko)** uses marketing language ("feels native despite running remotely") but Umbrel is desktop-first; the "Improved mobile experience" line refers to the v2 client landing, not a quality claim.
- **[XDA Developers hands-on](https://www.xda-developers.com/put-my-browser-in-a-container/)** is desktop-focused; no mobile evaluation.
- **[HN Show HN thread (2021)](https://news.ycombinator.com/item?id=29406112)** — no mobile discussion of substance.
- **[caracal.club](https://github.com/m1k1o/neko/issues/381)** is the one production reference users keep pointing to as "good mobile UX" — and they specifically asked for someone to **port their layout back to neko**, implying it's a custom downstream that hasn't been upstreamed.

## 4. Does the demodesk fork have mobile-specific patches the upstream doesn't?

Looking at `demodesk/neko-client` commit history (the repo is **archived since Feb 2024**, last release 1.6.32):

- [`4918c62` "Add support for touch gestures" (#40, 2023-07)](https://github.com/demodesk/neko-client/pull/40)
- [`0d83099` "Native touch events" (#42, 2023-08)](https://github.com/demodesk/neko-client/pull/42)
- [`c71a9d7` "split touch events to enabled and supported" (#43)](https://github.com/demodesk/neko-client/pull/43)
- [`d3514b9` "Fix textarea focus for touchscreens with keyboard" (#30, 2023-04)](https://github.com/demodesk/neko-client/pull/30)

So the demodesk fork did meaningfully advance touch (the bundle inspection findings match: real touch events, gestures, textarea overlay). **Zero commits about IME / compositionevent forwarding.** The fork is **archived**, so further mobile work is happening (slowly) on the upstream `m1k1o/neko` v3 milestone, not on `@demodesk/neko`.

## 5. Competitors with similar architecture

- **[Hyperbeam](https://hyperbeam.com/)** is the closest production comparable (WebRTC + multi-user shared input). Their marketing copy explicitly calls out *"tap, gesture, and drag-and-drop on…mobile devices"* and they advertise an Android-emulator product. Reviews on [Trustpilot](https://www.trustpilot.com/review/hyperbeam.com) are mixed on mobile polish but it does work for typing. Hyperbeam is closed-source proprietary infra; we cannot copy their input pipeline directly, but the fact that they offer it as a primary capability suggests **the architecture is not fundamentally limited — neko is just behind**.
- **[Browserbase](https://www.browserbase.com/)** is agent-first / headless and not a human mobile target; their "Live View" supports remote control but they use Playwright device emulation rather than a real mobile IME bridge.
- **Apache Guacamole** — neko's stated reference — also punts on IME and routes through text-input mode.

The takeaway: a video+input split is fine; **the missing piece is a `compositionevent` → server-side typed-text RPC**, which Hyperbeam built and neko hasn't.

---

## Bottom line for the refactor decision

If we adopt `@demodesk/neko`:
- **Solved**: synthesized click suppression, contextmenu prevention, long-press save-image (textarea overlay), keyboard flicker (PR #522 already addresses this exact symptom).
- **Still on us**: IME shim (compositionstart/update/end → custom WebRTC data-channel message → server-side `xdotool type` or equivalent). This is **a non-trivial bidirectional protocol extension**, not a 1-day shim, because:
  1. `@demodesk/neko` exposes a strict event schema; we'd be extending it or forking.
  2. The server side (`m1k1o/neko` gst pipeline) doesn't have a "type this UTF-8 string" handler today — only key-by-key forwarding.
  3. Composition state needs to survive focus loss, autocorrect replacements, and Gboard's swipe-typing (which emits a single `insertText` instead of individual keys).
- **Black bars on keyboard open**: not covered by the fork either; visualViewport relayout would still be on us.

**Confidence that Android Brave + Gboard typing + tap + scroll feels native-quality after refactor + IME shim: ~35%.**

Rationale: touch/scroll/tap will be solid (high confidence, ~85%) because that's the well-trodden path. But Gboard typing is the user-facing make-or-break, and we'd be the **first public implementer** of an IME-to-Xorg bridge on top of neko — every prior attempt (Chinese support #252, IME #547, mobile keyboard #115, scroll-flicker #566) has been closed without solving it or workarounded with a clipboard paste box. "First implementer" risk is high.

If Gboard typing is a hard product requirement, the realistic options are (a) build the IME shim and accept ~3-6 weeks of polish, (b) ship the clipboard-paste workaround that the neko community uses (visible "type here, then Send" affordance — same UX as Guacamole text-input mode), or (c) evaluate Hyperbeam-as-vendor.

## Three things to verify in the sandbox before committing

1. **Gboard composition test on a live `@demodesk/neko` sandbox.** Spin up `m1k1o/neko:firefox`, open from Android Brave, focus the address bar, and try to type "hello" via Gboard tap-typing, then via swipe-typing, then with a Chinese IME if available. Expected: tap-typing produces garbage or nothing; swipe-typing produces nothing; Chinese composition is silently dropped. If even tap-typing works cleanly, the bundle is further along than the issue tracker suggests and `@demodesk/neko` becomes much more attractive.

2. **Keyboard-open viewport behavior.** Open `@demodesk/neko` in Android Brave, focus the overlay to trigger Gboard, and confirm whether the video re-lays-out or shows the black-bar issue we hit in the hand-rolled impl. The `visualViewport` listener exists in the bundle but doesn't relayout (per source inspection) — verifying this rules out a "they already fixed it" surprise.

3. **Scroll inertia + long-press text selection on a remote page** (e.g. select text on en.wikipedia.org inside the streamed Chromium from an Android phone). This exercises whether the `Native touch events` (PR [#42](https://github.com/demodesk/neko-client/pull/42)) actually forward multi-touch and long-press-to-select correctly through to the X11 side. If selection works, scroll inertia almost certainly does too; if selection silently fails, we have a second large gap to close.

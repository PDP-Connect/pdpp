# Remote-browser mobile input architecture — independent review brief

**Audience:** an outside engineer experienced with WebRTC remote-browser systems, Chromium DevTools Protocol, Android mobile web, and IME / accessibility. The reviewer has full latitude to do additional research, contest premises, and recommend a different direction than the one we are leaning toward.

**Goal of review:** confirm or contest our intended architecture for forwarding mobile-user input (touch, keyboard, IME) from a phone-based dashboard to a remote Chromium browser running in a Linux container, under a hard requirement of maximizing bot-detection stealth. We are choosing between continuing to build on our current hand-rolled implementation, adopting an open-source component (`@demodesk/neko`), porting Apache Guacamole's text-input subsystem, or pursuing a different architecture entirely.

This brief is neutral. We have a leaning, but if the reviewer reaches a different conclusion supported by evidence we should change course.

---

## 1. System under review

### 1.1 Purpose

PDPP (Personal Data Portability Protocol) is a reference implementation of a draft protocol for streaming a user's data out of consumer services (ChatGPT, Gmail, Spotify, Reddit, etc.) to the user themselves, on their own infrastructure. The reference instantiates the protocol end-to-end so that engineers, standards reviewers, product teams, and prospective adopters can read, run, and evaluate it.

A "connector" is the code that drives an external service to retrieve the user's data. Some connectors authenticate via OAuth and pull from public APIs; others have no public API and must drive a real browser session belonging to the user. For the latter category (e.g. ChatGPT), the connector runs a Chromium browser, navigates to the service, and exfiltrates the user's records via the same web endpoints the service's own front-end uses.

When the browser-driving connector hits a step that requires the human (e.g. a Cloudflare Turnstile, 2FA prompt, captcha, or a login screen the connector cannot auto-fill), it emits a `manual_action` interaction. The PDPP dashboard surfaces this interaction to the user, who is expected to complete the step. Critically, the user is often on a phone, viewing the remote browser through a video stream.

### 1.2 Hard requirements

1. **Stealth.** The remote Chromium must not present detectable automation fingerprints (no `navigator.webdriver`, no CDP-leak side channels, no synthetic-event tells). We have established that Cloudflare Turnstile is the dominant gate; passing it on a clean residential IP is our acceptance bar.
2. **Compatibility with `manual_action` UX.** The user must be able to see the remote browser, click inside it (e.g. a Turnstile checkbox), type into form fields (login email, password, 2FA code), and have those inputs land at the remote browser AS IF the user were physically using that machine. "Feels native" is the bar.
3. **Reference quality.** Code is publicly inspectable. Implementation decisions are documented. Tests are real.

### 1.3 Current architecture (verified working for some steps)

**Stealth control plane (working).** The connector subprocess runs inside a reference container. It uses `patchright.chromium.connectOverCDP("http://neko:9223")` to attach to a real Chromium running inside a sibling Docker container (`n.eko`, see §1.4). Patchright is a stealth-patched Playwright fork whose driver-side stealth (avoiding `Runtime.enable`, route-based init-script injection, lazy isolated worlds) applies to any browser it attaches to. The neko-hosted Chromium binary is itself Patchright's bundled stealth-patched Chromium 147, baked into the neko Docker image. The CDP TCP endpoint is fronted by a small `cdp-proxy.py` that rewrites `webSocketDebuggerUrl` in the discovery response so the Patchright client can dial through.

**Verified outcomes:** the ChatGPT connector running on this stack reaches the OpenAI push-2FA prompt cleanly. Cloudflare Turnstile is not triggered. Once the user approves 2FA out-of-band, the connector successfully extracts 10,000+ records before hitting unrelated 429 rate limits. Stealth-side architecture is solved for connector-driven navigation. See `/docs/patchright-integration-spec.md` and `/docs/neko-stealth-design-brief.md`.

**Streaming companion UX plane (problematic).** When a `manual_action` interaction fires, the dashboard provides a stream view at `/dashboard/runs/<runId>/stream`. Implementation: a React `<StreamSurface>` component (`apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx`, ~5000 lines). It renders the remote browser via `<img>` tags fed by CDP `Page.startScreencast` frames. It captures the user's touch / mouse / keyboard events using hand-written React handlers (`onTouchStart`, `onMouseDown`, `onKeyDown`, plus a hidden `<input>` to coax the OS soft keyboard open). It POSTs these to the reference server's `/_ref/run-interaction-streams/<token>/input` endpoint, which forwards them via CDP `Input.dispatchTouchEvent` / `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` to the streamed Chromium.

**Stealth note for this UX plane:** every CDP `Input.dispatch*` call originates from the *same* CDP session that Patchright is using to drive the page. This is a second consumer of the same session. Per our Patchright research (`patchright-integration-spec.md` §8 anti-pattern list), this is borderline acceptable for `Input.*` (does not require `Runtime.enable` / `Console.enable`) but it does not get the same X11-level realism that real OS events would.

### 1.4 What `n.eko` is and how we are using it

[n.eko](https://github.com/m1k1o/neko) is an open-source remote-browser project: a Chromium running on a Linux server with an X server, streamed to clients via WebRTC. It includes a server (Go) and a Vue web client (`@demodesk/neko`, an archived fork on npm).

In our system, n.eko provides the Chromium runtime: real X server, real WebRTC stack, real OS-level input synthesis from its own input protocol (which speaks `XTest` to the X server). When the connector clicks via Patchright/CDP, the events reach the browser as CDP-synthesized input — not X11. When n.eko's own clients click via the n.eko Vue component, they reach the browser as real X11 events from the X server.

**We are currently using n.eko only as a Chromium host.** We are NOT using its Vue web client, NOT using its WebRTC media transport, NOT using its input WebSocket protocol. The dashboard renders the remote browser via CDP screencast and dispatches input via CDP. The n.eko container's WebRTC ports are exposed but unused for the streaming-companion path.

### 1.5 The bugs we hit on Android Brave (the user's phone)

The user opened `/dashboard/stream-playground?backend=neko-remote-cdp&stream_debug=1` on his Android phone using Brave (Chromium-based mobile browser) and tested. Telemetry was captured end-to-end (phone raw events, wire dispatch, server-side CDP dispatch, remote DOM events via a Patchright `exposeBinding` channel; see `apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` and `reference-implementation/server/streaming/`):

1. **Double-click.** Single tap of "Click me" button incremented the counter by 2. Telemetry showed Android Brave dispatches both native `touchstart/touchend` AND synthesized `mousedown/mousemove/mouseup/click` for the same physical tap. Our handlers forwarded BOTH to the remote browser as separate CDP dispatches; the remote browser counted both as clicks.

2. **Keyboard flicker / focus bounce.** Tapping a remote input field opened the OS soft keyboard on touchstart, then closed it the moment the finger lifted. Telemetry showed the focus went `<input>` (our hidden keyboard trap) → `<div role="application">` (the stream surface) on the synthesized mousedown. `<div tabindex="0">` is focusable; synthesized mousedown stole focus from the hidden input.

3. **IME "Unidentified" keys.** Typing letters dispatched `keydown` events with `key="Unidentified"`, `code=""`. Android IME (Gboard, Brave's keyboard) does not fire real `keydown` for typed characters — the actual text arrives in `InputEvent.data` of `beforeinput`/`input` events. Our wire schema and CDP-adapter handle `keydown` and `paste` but not `beforeinput`. No text reached the remote.

4. **Long-press → Save Image.** Long-pressing the streamed area triggered Android's native "Save image" menu (because the streamed frame is an `<img>`).

5. **Black bars on keyboard open.** When the OS keyboard opened, `visualViewport.height` shrunk, and the stream surface (sized by `aspect-ratio`) was centered with black bars filling the now-empty space.

### 1.6 What we have already tried (and the user's feedback)

We applied two rounds of patches to the existing hand-rolled implementation:

- Round 1: ghost-click suppression flag (set on touchstart, clears 800ms after touchend) gating mouse handlers. CSS `pointer-events:none; -webkit-touch-callout:none; user-select:none; touch-action:none` on the `<img>`. **Outcome:** double-click fixed, long-press save-image fixed. Keyboard flicker partly improved but not resolved.

- Round 2: `e.preventDefault()` on synthesized mousedown to suppress focus-shift. `onBeforeInput` on the hidden `<input>` forwarding `InputEvent.data` as a `paste` payload. Temporarily changed the stream `<div>` from `tabindex="0"` to `tabindex="-1"` to prevent touchstart-focuses-target from stealing focus from the hidden input. **Outcome:** click count became reliably 1, but keyboard flicker persisted, typing produced no text remote-side, and the `tabindex="-1"` change introduced a screen-reader accessibility regression (since reverted).

The user's feedback after round 2 was direct: "we keep adding patches that introduce new edge cases" and "these are not 95% SLVP-ideal fixes." This brief is the response: stop patching, decide on the right architecture.

### 1.7 Constraint: "95% SLVP" decision quality

The user holds every architectural decision to a "Simplest Lossless Verifiable Path" (SLVP) bar: the simplest design that loses no important property, with verification evidence. The user explicitly does not accept "ship the simplest fix that makes this symptom go away" if it does not also hold up under a second use case or against a foreseeable future requirement. He has repeatedly asked us to confirm a decision is the long-term-correct one before committing, and to bring in independent expert review when the path is non-obvious.

---

## 2. Options under consideration

### 2.1 Option A — Continue patching the hand-rolled implementation

Keep the current React handler stack in `stream-viewer.tsx`. Continue fixing each new mobile-browser quirk as it surfaces (IME, composition events, viewport reactivity, multi-touch, long-press text selection on the remote page, etc.).

**Pros:** no architectural disruption; bugs we have fixed stay fixed; we own every line of input code.

**Cons:** every mobile-browser quirk lands on us. The matrix is large (iOS Safari, Android Chrome, Brave, Samsung Internet, Firefox Android; English, CJK, Arabic; finger, stylus, mouse; Tablet, phone, foldable; soft-keyboard heights varying by OS keyboard app). No existing community implementation has solved all of this in this combination. We are reinventing remote-desktop client engineering from scratch.

### 2.2 Option B — Adopt `@demodesk/neko` Vue client; layer an IME shim

Replace our React `<StreamSurface>` for n.eko-backed sessions with the `@demodesk/neko` Vue component (Vue 2, mounted inside React via `$mount`, as `~/code/remote-browser-sandbox` does). Inputs route through n.eko's existing WebSocket protocol to the X server (real X11 events, not CDP). Touch / mouse / focus / contextmenu issues solved by n.eko's existing handlers (verified in source: `bindTouchHandler` calls `preventDefault` on touch events with `passive:false`; target is a transparent textarea so save-image menu does not fire). Layer a custom IME shim on top of n.eko's `_textarea`, capturing `beforeinput`/`compositionend` events and routing the committed text through `nekoInstance.control.paste()` (which translates to X11 `XTest` typing events server-side).

**Pros:** stops us writing touch / mouse / focus / contextmenu code; gets us 3 of the 5 Android Brave bugs solved out-of-the-box; input arrives at the remote browser as real X11 events (better stealth than CDP-dispatched events); leverages an existing implementation that the user himself ran on Android Brave and reported as working in `~/code/remote-browser-sandbox`.

**Cons:** `@demodesk/neko` is an archived fork (last release Feb 2024); we adopt unmaintained code. IME is NOT solved by it — the Guacamole-derived `compositionend` path is explicitly disabled in the bundle (we read the source). We must write the IME shim ourselves. Vue-2-inside-React lifecycle is moderately invasive in the dashboard. We continue to need our hand-rolled adapter for non-n.eko backends (legacy invisible-headless connectors that screen-capture via CDP).

### 2.3 Option C — Use guacamole-common-js's Keyboard module + write a thin UI shell

Apache Guacamole has been solving this exact problem since ~2012 for enterprise RDP/VNC use. Its `guacamole-common-js` (Apache 2.0, on npm) includes a `Keyboard` module that handles Android IME via beforeinput/composition events and produces X11 keysym pairs. Guacamole's full text-input UI shell (`guacTextInput.js`) wraps the Keyboard module with a hidden textarea, U+200B padding, common-prefix/suffix diffing, and composition-event bracketing. We would import the `Keyboard` module from npm and write a small (~200-line) UI shell adapted from Guacamole's reference implementation. Forward the resulting keysyms over our wire as a new `keysym` payload type that the server-side adapter translates either to CDP `Input.dispatchKeyEvent` (for our existing path) or to n.eko's X11 keysym channel (if combined with Option B).

**Pros:** the keysym-mapping code is the part nobody should reimplement, and Guacamole has done it correctly for 12+ years. Apache 2.0 license is permissive. Tree-shakable: we use only the Keyboard module, not the whole client. Acknowledges canonical prior art rather than hiding it.

**Cons:** does not solve the touch / mouse / focus / contextmenu / long-press issues — those still need either Option B or our own handlers. Requires writing the UI shell (one day's work) and a new wire-protocol type. The shell is small but is something to maintain.

### 2.4 Option D — Port Guacamole's full `guacTextInput.js` directly

Same as Option C, but copy the entire `guacTextInput.js` source file (Apache 2.0, attribution preserved) into our codebase as a standalone module. Wire to our existing `<StreamSurface>` (Option A) or to `@demodesk/neko`'s `_textarea` (Option B + D).

**Pros:** maximum reuse of canonical code; minimum new code for us; license-compatible.

**Cons:** `guacTextInput.js` lives inside the AngularJS-based Guacamole web app and is tangled with that framework's directives and services. Porting it requires extracting it from the framework, which is moderately invasive. We'd be lifting more code than we need.

### 2.5 Option E — Compose: `@demodesk/neko` for touch/mouse/focus, `guacamole-common-js` Keyboard for IME

Combine Options B and C. The Vue component handles everything it handles well (touch, mouse, contextmenu, focus, video display). The Guacamole Keyboard module handles IME. Both feed into n.eko's input WebSocket protocol on the server side (keysyms become X11 events).

This is the option we are currently leaning toward. The two components are independent and well-licensed. Each has known prior-art usage. The seam between them (`@demodesk/neko`'s `_textarea` becomes the Guacamole Keyboard's input target) is documented in Guacamole's own architecture.

**Pros:** maximum reuse of battle-tested code; we write the integration glue (small) but not the core input handling. The stealth model is also stronger here than under our current architecture: inputs reach the browser as real X11 events, not CDP-synthesized events, so Cloudflare cannot detect "this input came from CDP."

**Cons:** Vue-in-React; archived `@demodesk/neko` fork; we have not yet tested whether `@demodesk/neko`'s WebRTC media transport is reliable on the user's specific network. Larger refactor than Option A or C alone.

### 2.6 Option F — Adopt a different remote-browser stack entirely

Replace n.eko with a different implementation that ships better mobile support. Candidates: Apache Guacamole (full stack — has the IME solution by design, but is an RDP/VNC proxy not a Chromium host; we'd need to run Chromium-on-X11 behind it), Hyperbeam (paid SaaS, closed source — does not meet the "self-hostable, inspectable reference" requirement), browserless / browserbase / steel.dev (paid SaaS, same constraint).

**Pros:** Apache Guacamole has IME solved upstream; using it as a stack would mean we don't have to assemble pieces.

**Cons:** moves us off WebRTC onto Guacamole's protocol (less efficient for video). Requires re-doing the Patchright + connectOverCDP integration we just completed. Significantly larger architectural change with no validated path.

---

## 3. The Patchright / stealth interaction with each option

A premise we want the reviewer to challenge: **the stealth requirement (Patchright connectOverCDP) is independent of the streaming-companion implementation.**

Our claim:

- Patchright owns *page* control: navigation, init-script injection, fingerprint patches. It attaches to the n.eko-hosted Chromium via `connectOverCDP`. This works regardless of how the user's input reaches the browser.
- Streaming companion owns *user input* and *video display*. It can route input through CDP `Input.dispatch*` (current; reasonable stealth, but every input call adds a CDP message to the same session Patchright uses) OR through n.eko's native input channel (X11 events; the browser cannot distinguish from a real user at the keyboard).

Under Option E (n.eko + Guacamole keyboard), inputs reach the remote browser as real X11 events. The remote browser's bot-detection JS sees:
- `navigator.webdriver === false` (Patchright stealth)
- Real `MouseEvent` / `TouchEvent` / `KeyboardEvent` with no synthetic markers (because X11 → Chromium event pipeline is the same as for a real user)
- TLS fingerprint, GPU profile, etc., all matching Patchright Chromium binary

Under the current option A or B-only, inputs reach the browser via CDP. The remote browser's bot-detection JS sees:
- Same `navigator.webdriver === false`
- `MouseEvent.sourceCapabilities === null` and other CDP-dispatched event signatures (some detection systems probe these)
- Same TLS / GPU as above

Is the CDP-dispatched-event signature actually detectable by Cloudflare Turnstile in practice? We do not know. We have not seen Cloudflare flag us on input-event signatures, but we also haven't run a controlled experiment. The reviewer is invited to weigh in on whether this stealth differential is load-bearing for the SLVP decision.

---

## 4. Key uncertainties for the reviewer

1. **Does `@demodesk/neko`'s WebRTC video work reliably across mobile networks?** We have not stress-tested it. The current CDP-screencast `<img>` path is verifiably reliable but lower quality.

2. **Will the Guacamole-derived IME shim actually feel native?** Guacamole's text-input subsystem has been working in production for enterprise users for ~12 years. But Guacamole's UX bar is "type your password into a Windows VM through a desktop browser." Our UX bar is "type your password into a captcha solver via Gboard on Android with autocomplete and emoji." Are these the same problem? The reviewer's domain experience matters here.

3. **Are we underestimating the IME problem?** The maintainer of m1k1o/neko (the upstream of `@demodesk/neko`) explicitly identified this as needed-but-unbuilt in 2023 (issue #547). 5+ years of community effort has not closed this gap in the self-hosted n.eko world. Yet Guacamole has it solved upstream. Why has nobody bridged the two?

4. **Are we missing a simpler architecture entirely?** Our default assumption is "stream the browser to the phone, forward inputs from the phone to the browser." An alternative: render only the captcha/2FA/login *fragment* of the page to the phone (not the whole browser), and re-inject the result via CDP. This trades video-streaming complexity for HTML-fragment-replication complexity. We have not seriously evaluated this path.

5. **For Cloudflare Turnstile specifically, does input-event provenance matter?** If Patchright stealth + WebRTC-frame display + CDP-input is sufficient for Turnstile to pass — even when the user is actively clicking the challenge — then Option A patched to working might be acceptable indefinitely. We have not tested this empirically because our test traffic has been intermittent and our IP has plausibly been flagged at times.

6. **What is the right abandonment threshold for an archived dependency (`@demodesk/neko`, last release Feb 2024)?** It works, the source is short, the fork point is recent, the upstream m1k1o/neko remains active. Is taking a dependency on an archived component a defensible engineering decision, or a slow-motion mistake?

---

## 5. Research and references the reviewer may want to consult

In the PDPP repository (paths relative to repo root):

- `docs/patchright-integration-spec.md` — Patchright internals research, including the anti-pattern list for code that attaches to a Patchright-managed browser.
- `docs/neko-stealth-design-brief.md` — three-layer stealth design (binary, launch args, driver) for n.eko-hosted Chromium.
- `docs/neko-adapter-refactor-spec.md` — earlier (deferred) spec for refactoring our cdp-adapter to use Patchright APIs.
- `docs/patchright-init-script-debug.md` — diagnostic walk-through that uncovered the utility-world vs main-world `page.evaluate` gotcha.
- `docs/demodesk-neko-input-research.md` — source-code inspection of the `@demodesk/neko` Vue bundle, including line citations.
- `docs/neko-mobile-research.md` — community-evidence search for n.eko mobile UX known issues.
- `docs/mobile-ime-prior-art-research.md` — Hyperbeam / Caracal / Guacamole / Wayland investigation.
- `apps/web/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` — current hand-rolled stream-viewer.
- `apps/web/src/app/dashboard/stream-playground/page.tsx` — operator-only test harness, used to capture the telemetry referenced in §1.5.
- `reference-implementation/server/streaming/playground.js` — the matching server-side playground factory.
- `reference-implementation/server/streaming/cdp-adapter.js` — current CDP-input adapter.
- `reference-implementation/server/streaming/neko-adapter.js` — current cdp-screencast-via-neko adapter.

External:

- m1k1o/neko issue #547 (https://github.com/m1k1o/neko/issues/547) — maintainer acknowledging the IME gap.
- m1k1o/neko issues #115, #251, #381, #566 — community discussion of mobile UX limitations.
- `@demodesk/neko` archive on npm (https://www.npmjs.com/package/@demodesk/neko) and the archived client repo (https://github.com/demodesk/neko-client).
- Apache Guacamole client (https://github.com/apache/guacamole-client), specifically the `guacTextInput.js` directive and `Keyboard.js` core module.
- `guacamole-common-js` on npm (https://www.npmjs.com/package/guacamole-common-js), Apache 2.0.
- `~/code/remote-browser-sandbox/` (separate the owner project, not in the PDPP repo) — exemplar implementation of `@demodesk/neko` mounted with `inputMode: "touch"` + a CDP InputBridge for the non-neko paths.

---

## 6. Questions for the reviewer

We are asking the reviewer to respond to these specifically. Each one is a decision we have to make; the reviewer's job is to inform it, not necessarily to make it.

1. **Is Option E (`@demodesk/neko` + Guacamole Keyboard + IME shim) the right SLVP target, or are we still missing something simpler?** If there is a simpler architecture that hits the same bar — including for users' phones, including for IME-heavy languages, including under the Patchright stealth requirement — please name it.

2. **How load-bearing is the input-event-provenance stealth differential?** For Cloudflare Turnstile specifically (which is our acceptance gate), is CDP-dispatched input detectable in 2026? Is the gap between "user inputs arrive as real X11 events" and "user inputs arrive as CDP-synthesized events" something Turnstile actually probes?

3. **Is the archived status of `@demodesk/neko` a blocker, a risk to be mitigated, or a non-issue?** The repository is archived but the npm release is stable; m1k1o/neko upstream is active. What would a senior engineer's defensible posture be on this dependency?

4. **For IME, will porting Guacamole's text-input mechanism actually produce a "feels native" experience on Android Gboard for the user's likely flows (password entry, 2FA code, email address, occasional CJK or emoji), or are there mobile-specific quirks Guacamole's enterprise-desktop-origin code does not handle?** If the latter, what specifically should we expect to encounter, and what is the actual time investment to reach 95% SLVP?

5. **Should we run a controlled experiment before committing?** E.g. set up the user's `~/code/remote-browser-sandbox` and ask him to test on his Android Brave directly. If `@demodesk/neko` + the sandbox's existing input pipeline feels broken to him on his phone, we shouldn't be building on it. If it feels good, we have validated the foundation. The experiment is ~30 minutes.

6. **Is there an architectural option in §2 we have framed incorrectly, weighted wrong, or omitted?** The reviewer is not bound to our framing.

7. **What is the reviewer's confidence interval on "Option E ships a native-feeling Android mobile UX that passes Cloudflare Turnstile within ~3-5 days of engineering work"?** And: what would have to be true for the reviewer to give a higher confidence number?

---

## 7. Author's leaning (disclosed for transparency)

The author of this brief currently leans toward Option E with a phased rollout:

1. ~½ day: bring up `~/code/remote-browser-sandbox`, have the user test on his Android Brave. If it feels broken, abandon Options B/E.
2. ~1 day: add an IME shim using Guacamole's Keyboard module to our existing playground (`/dashboard/stream-playground?backend=neko-remote-cdp&stream_debug=1`); test in isolation.
3. ~1-2 days: refactor the dashboard stream-viewer to mount `@demodesk/neko` Vue component for n.eko-backed sessions; integrate the IME shim from step 2.
4. ~½ day: validation pass — Cloudflare Turnstile checkbox flow, password entry, email entry, CJK if available, screen-reader smoke test.

Total estimate: 3-5 days. The author's confidence in "this hits 95% SLVP" is ~70% pre-experiment, ~90% after step 1 succeeds.

The author considers this leaning provisional and explicitly invites the reviewer to contest it. The wrong call here costs ~1-2 weeks of misdirected work. The right call has compounding value across every browser-driving connector for the lifetime of the reference implementation.

---

*This brief was written 2026-05-12. The deciding human is the owner Nunamaker, principal of the PDPP reference implementation. The reviewer is invited to recommend whatever course of action the reviewer believes is correct, including "none of the above."*

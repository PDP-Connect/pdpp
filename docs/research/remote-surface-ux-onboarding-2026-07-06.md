# Remote-surface streaming UX — full onboarding dossier (2026-07-06)

Purpose: one document that loads the whole context of the browser-surface streaming UX
problem — what exists, what was tried, what the owner's testing feedback was, what was
abandoned (and is mineable), and a diagnosis of why the UX never converged — so a fix
effort can start from evidence instead of re-discovery.

Sources: the long-running RI Codex session thread (`019d922d` 2026-04-15→06-11 [1.5 GB],
its 05-31 fork, and continuation `019ea88b` 2026-06-08→07-06 [661 MB]) mined for owner
messages; the repo's design docs, openspec archive, `tmp/workstreams/` debugging logs,
and git history. Owner quotes are verbatim from transcripts, dated.

---

## 0. TL;DR

The problem is **four stacked problems that were fought as one**:

1. **Stealth / anti-bot** — SOLVED and validated (Patchright Chromium baked into the
   n.eko image, strict no-CDP-touch mode, clean Turnstile pass; `docs/neko-stealth-design-brief.md`,
   "shipped 2026-05-11. Validated").
2. **Video transport + geometry** (sizing, rotation, blur, pointer offset) — mostly
   converged after brutal iteration (RandR modelines, container-rect override, ~1px
   pointer accuracy), but viewer fit-to-phone-viewport is still bad enough that on
   06-19 the owner had to put his own browser in mobile-view mode to see Amazon's
   login form.
3. **Mobile input / IME (typing on a phone into the remote browser)** — NEVER solved.
   Not just by us: the n.eko maintainer admits upstream doesn't support IME (issue #547,
   open 5+ years). Our Guacamole-derived `MobileTextInputController` is fully built and
   unit-tested, but four sequential validation docs (`remote-surface-step-4-ime` →
   `step-5` → `step-5b` → `step-5c`) each disproved the previous one's success claim;
   step-5b proved text was still flowing through the legacy fallback path, and step-5c
   ends "hypothesis neither confirmed nor refuted." As of 06-29 the agent's own words:
   *"the stream keyboard path is brittle"* — workaround was "don't type in the stream."
4. **Orchestration / handoff state machine** (when to show the stream, what state the
   run is in, resuming after the human acts) — the dominant pain in the June→July
   window. Partially fixed (PR #169 routing, PR #170 "Preparing the secure browser"
   state + timeline poller). The single most important designed-but-unbuilt fix:
   **auto-resume** — after escalating to a blocking manual action the connector stops
   polling for session-validity, so a run can sit dead while the user is already
   logged in ("i opened the stream and it's just sitting on chatgpt.com already
   logged in").

The meta-failure across all four was **validation, not design**: telemetry said green
while the user-visible result was wrong, repeatedly. Owner, 05-08: *"You're saying
'maxEmpty = 0.001, highEmptyCount = 0' but apparently this doesn't measure what
actually matters, because as a user, the size of the stream is just wrong. …How does
this keep happening? It's exhausting."* The expert's 9-point Android acceptance gate
was never passed end-to-end. Any new effort should start by making that gate
executable and observable (see §7).

---

## 1. What exists (map, current state)

### The package: `packages/remote-surface` (`@opendatalabs/remote-surface`)
~14,300 lines, Apache-2.0-bound, OSS-spinnable, deliberately host-neutral (must not
import reference-implementation / apps / connectors / Docker code). Republish under
@opendatalabs is an open openspec change (naming/license only).

- `types.ts` — the narrow `RemoteSurface` interface: `mount/unmount/focusTextInput/sendPointer/sendKeysym/sendText/…` (exactly the expert brief's shape).
- `protocol/` — JSON-safe session/token/capability shapes; `assertNoUnsafeDescriptor`
  blocks CDP URLs/tokens/docker.sock from reaching browser clients.
- `adapters/` — `NekoSurfaceAdapter` (preferred) / `CdpSurfaceAdapter` (fallback).
  Both are DI shells with step-TODOs, **not fully wired to the real console client**.
  `sendKeysym` keyup is a permanent no-op (n.eko's primitive is atomic press+release).
- `client/` — clipboard policy, geometry/coordinate mapping, viewport classifier
  (keyboard-vs-resize detection explicitly heuristic), control reducer. Well-tested pure logic.
- `backends/neko/` — allocator client (the one real-I/O file), layout, media-settle
  (test named for the real "Android portrait fallback caused cover-crop and pointer
  drift" bug), touch-scroll, pointer diagnostics. `backends/cdp/`, `backends/types.ts`
  (future VNC/Kasm seam, unimplemented).
- `controllers/NekoPointerController` — tap-to-click state machine; native touch is
  opt-in only because touch+mouse double-emission double-fired clicks on Android Brave.
- `ime/mobile-text-input-controller.ts` — the Guacamole `guacTextInput.js` port
  (hidden textarea, U+200B padding, prefix/suffix diff on commit, composition
  bracketing). 349 lines, 18 tests, thorough justification header. `ime/keysym.ts` is
  the one clear stub (`type Keysym = number`).
- `leases/` — facade; the real 1,326-line `BrowserSurfaceLeaseManager` lives in
  `src/reference/browser-surface-leases.ts` (born from the "lease reused a dead
  surface" incident). `reference/streaming-session-store.ts` holds the real token
  hashing/TTL logic.

### Reference-implementation integration
- `reference-implementation/server/neko-surface-allocator-server.ts` (1,159 lines) —
  Docker orchestration: one container per (connector, profile), replace-never-restart,
  triple health probe (n.eko `/neko/health`, CDP `/json/version`, supervisorctl).
- `server/streaming/neko-adapter.js` (1,191 lines) — HTTP-polling JPEG screencast
  bridge, optionally CDP-assisted; **fully disabled under `stealth_mode: strict`**
  (any CDP touch is Turnstile-detectable).
- Flow: connector hits unresolvable step → run `skipped` + AttentionLifecycle → lease →
  readiness probe → streaming session minted (fails closed) → push/ntfy deep link to
  `/syncs/:runId/stream` → resume is in-memory Promise resolution (`brokerInteraction`),
  not polling. Routes: `/_ref/runs/:runId/run-interaction-stream`,
  `/_ref/run-interaction-streams/:token/{events,input,viewport}`.
- Docker: `docker-compose.neko.yml`, `docker/neko/cdp-proxy.py` (Chromium binds CDP to
  127.0.0.1), custom image baking Patchright's Chromium into n.eko.
  **Live-config gotcha (bit us 06-10):** running containers can silently lack
  `PDPP_NEKO_*` env vs what compose files say — `reference-stack.sh verify` is mandatory;
  the un-managed path re-exposed the ChatGPT captcha.

### Viewer UI
`apps/console/.../syncs/[runId]/stream/` — 27 files; `stream-viewer.tsx` is **5,256
lines** and `neko-client.ts` **2,393 lines** (note: the expert brief explicitly said
"don't keep patching stream-viewer.tsx" — it happened anyway). Control acquired
silently on first gesture; two-stage UX (orientation card → full-bleed chromeless
dialog); backdrop-click-close deliberately disabled after a mid-auth mis-tap incident;
hardened "End session"; `NekoSurface` (WebRTC) vs `BrowserSurface` (CDP JPEG-poll)
rendering paths. Named-incident regression tests exist (USAA dead-container carcass;
Android Chrome landscape 13% stretch; Brave portrait white borders), but the only
live-Docker tests are opt-in and out of CI.

---

## 2. Timeline (the narrative, from the transcripts)

- **2026-05-03 — conceived, "avoid neko."** *"we're going to ship a streaming solution
  too… notify the user with a link… shows them a stream of the browser, resized to
  their device… I think we should probably avoid using n.eko for this, it's quite
  heavy. CDP works."* Prior-art bar set by `vana-com/remote-browser-sandbox` (RBS) and
  siblings (data-connect, vana-connect-mobile, remote-browser-service).
- **05-05→06 — CDP hits the Cloudflare wall → pivot to neko.** *"I can't seem to get
  past the cloudflare captcha… Is there a fundamental problem with this CDP
  strategy?"* Moved to n.eko as the "more true stream." (See §5.1 — this pivot's
  premise was later disproven.)
- **05-06→11 — neko UX rehab against the RBS bar.** The dense complaint corpus (§3).
  Root cause of the size bugs: neko's encoder/X server painted a smaller frame than
  the `<video>` was sized for → RandR modelines in `docker/neko/xorg.conf` + layout
  gating. Owner skepticism: *"Not really sure why native n.eko features were
  untrustworthy, n.eko has far more development hours than our code."*
- **05-12→13 — the expert brief + package spinout.**
  `docs/5-12-26-chatgpt-remote-surface-brief-response.txt` = decision of record:
  three planes — Patchright/CDP (automation), n.eko/X11/WebRTC (human input,
  preferred: CDP `Input.dispatch*` is an automation primitive, not a real OS input
  path), Guacamole-style keysym/IME (mobile text). Spinout rationale (owner):
  *"Just as a forcing function to help us stay focused on the correct separation of
  concerns"* — near-publishable, not published; later "ship in @opendatalabs."
  Also decided: dynamic per-connector profiles capped by leases (each surface costs
  hundreds of MB RAM).
- **05-13→14 — first real ChatGPT runs.** 2FA/notify friction: no server notification
  on 2FA push; *"if I approve the 2FA I also need to confirm that I did, vs the
  connector proceeding automatically"* (the auto-resume theme, first appearance);
  stale CDP client after a minute of OTP idle: *"Isn't that the bigger problem?"*
- **05-18→31 — deliberately punted.** *"human-device UX polish is not complete — i
  want to wait until we're through green connectors so I can collect feedback."*
  Meanwhile it kept breaking under real use: *"I was not prompted to view the stream"*,
  *"Couldn't reach the browser stream after several tries"*, *"very important to commit
  frequently because we have churned a lot on this feature"*, *"use playwright to
  validate that streaming works before I get involved again."*
- **06-01→02 — the reckoning.** Owner proved his old RBS VM passed ChatGPT's
  Cloudflare **with pure CDP screencast in minutes** (`http://<remote-browser-sandbox-host>/#rendering=cdp&input=cdp…`,
  Chrome stable, datacenter IP): *"it clearly worked to get me 40 MB of ChatGPT in a
  matter of minutes, whereas *our* version has been running for many hours."*
  Root-cause conclusion: the Cloudflare delta was **browser binary/channel + profile
  trust history**, not CDP-vs-neko. Proposed (not confirmed built): one Patchright
  browser-posture contract with two adapters (local-launch / managed-neko-attach) +
  a golden drift probe (binary/version/flags/profile/CDP-mode/viewport/WebGL).
  Owner: *"streaming has been a very challenging part of the RI implementation."*
- **06-04** — openspec `consolidate-neko-patchright-browser-posture` closed the
  posture ambiguity; its residual-risk section records live device smoke tests
  "Not yet run."
- **06-08→07-06 — pain moves up the stack.** No latency/video complaints at all in
  this window; every reported failure was the console wrapper: 06-10 captcha
  regression = live env drift (missing `PDPP_NEKO_*`), 06-19 Amazon viewer-too-small +
  stuck "Preparing the browser stream", 06-26 *"i opened the stream and it's just
  sitting on chatgpt.com already logged in"* (blocking manual action stopped
  session-polling; only copy was fixed — PR #85 "Continue collection"), 06-29 *"trouble
  typing my password in the browser stream"* (brittle keyboard path; workaround =
  one-time-code login), 06-29/07-01/07-02 the recurring *"No browser action is
  waiting"* dead-end — root causes: (a) `/run-interaction-stream` 409'd on no-response
  browser assistance (no pending interaction row), (b) a race where `run.started` was
  treated as "send owner to stream now" before `run.assistance_requested` existed.
  **PR #170 (`68aef8e32`, live v0.18.12-71)** made "preparing owner browser action" a
  first-class state with timeline polling + regression test, generic across
  browser-session repair runs. PR #169 fixed reconnect routing by connection binding
  (browser-session → session repair, not credential capture). PR #111 fixed a
  cross-connection stream-label bug.
- **07-03 night report** (most recent status): browser-streaming lifecycle has open
  race/leak candidates (concurrent attach, stop/start); "n.eko instance cleanup on
  remount and `sendText` no-op are functional gaps, not cleanup nits."

---

## 3. The owner-feedback corpus (verbatim, thematic)

**Sizing / geometry / fidelity**
- "the remote page doesn't resize to fit the local frame" (05-05)
- "i see black bars to the bottom and to the right" (05-07)
- "it seems a bit blurry… closer to 1:1 pixel mapping would be ideal" (05-07)
- "when I rotate my phone, I see the dimensions of things change at least twice before settling" / "rotations are glitchy" (05-07/08)
- "as a user, the size of the stream is just wrong… How does this keep happening? It's exhausting." (05-08)
- Amazon: had to switch his own browser to mobile-view mode to see the login form (06-19)

**Keyboard / IME / clipboard**
- "Every character I type is landing in my android clipboard, I don't understand why… the keyboard behavior… seems a bit random. Why did the keyboard feel much better in remote-browser-sandbox, and clipboard too?" (05-06)
- "Why does the keyboard open on every touch rather than on focus?" / "the keyboard comes up but immediately closes" (05-07/08)
- "ctrl+c… doesn't update my clipboard on the host machine" (05-07); one-way clipboard (05-06)
- "paste button doesn't seem to work" (05-10)
- "I'm having trouble typing my password in the browser stream" (06-29)

**Reliability / reachability**
- "sometimes it gets stuck on Starting WebRTC Stream… not even a hard reload brings the stream back up" (05-10)
- "Couldn't reach the browser stream after several tries" (05-28, again 06-03 "seems like a regression", again 07-01)
- "I was not prompted to view the stream" (05-27)

**Handoff / run-state UX**
- "if I approve the 2FA I also need to confirm that I did, vs the connector proceeding automatically" (05-14)
- "it's just sitting on chatgpt.com already logged in. idk what happened there… so I approved chatgpt without realizing it and the connector wasn't able to capitalize?" (06-26)
- "again… I got this bullshit: run continuing / No browser action is waiting" (07-02)
- "Preparing the browser stream… is a really confusing experience, I have no idea if it worked" (06-19)

**Standards / process**
- "I don't want the minimum UX. I want the polished UX (responsive resizing, touch controls, etc., unless it weakens stealth)" (05-06)
- "this feels like shaving a yak. Please get this into a shippable state, we have infinite time and an SLVP bar." (05-06)
- "we keep adding patches that introduce new edge cases" / "these are not 95% SLVP-ideal fixes" (the trigger for the external expert review, `docs/remote-browser-mobile-input-review-brief.md`)
- Latency, notably, was a minor theme: one "feels a little laggy considering it's the same host machine" (05-08); zero latency complaints June→July.

---

## 4. References / prior art actually used

- **`vana-com/remote-browser-sandbox` (RBS)** — the recurring UX gold standard AND the
  06-01 Cloudflare counter-evidence. Working config preserved in transcript:
  CDP screencast rendering + CDP input, Chrome stable, direct datacenter IP, quality 80.
  Siblings: `data-connect`, `vana-connect-mobile`, `remote-browser-service`, `remote-browser`.
- **m1k1o/neko** — the streaming backend. Upstream issues #115/#251/#547: mobile
  IME unsupported for 5+ years; maintainer: "maybe we should implement such text
  input mode."
- **@demodesk/neko(-client)** — archived; expert: "wrap/vendor/fork, not the
  architectural center." `docs/demodesk-neko-input-research.md`: its bundled
  Guacamole keyboard has the IME `input`/`compositionend` handlers commented out.
- **Apache Guacamole** — "the real prior art" for mobile text input; `guacTextInput.js`
  algorithm ported into `ime/mobile-text-input-controller.ts`.
  `docs/mobile-ime-prior-art-research.md` (~70% confidence, integration-risk framing,
  staged de-risk plan) — also debunks the Caracal.club "solved mobile IME" claim
  (their neko bounty was layout, not input).
- **Patchright** — stealth posture; its docs identify `Runtime.enable` as the top
  fingerprint leak → strict mode = zero CDP touches on the user's tab during interaction.
- Also surveyed: Hyperbeam (black box, nothing to copy), Browserbase/Steel.dev/
  browserless (mobile typing a non-goal), Microsoft RDP Android client (Unicode-mode vs
  scancode-mode — same split as Guacamole), Wayland `input-method-unstable-v1`
  (protocol-level confirmation: never synthesize keysyms from composing text),
  Kasm/Selkies/noVNC (OSS-posture survey, `design-notes/prior-art/slvp-remote-surface-oss-posture-prior-art-2026-05-27.md`).

---

## 5. Abandoned / deferred directions — the mineable list

1. **Pure CDP screencast+input viewer** (the original design). Abandoned 05-05 for the
   Cloudflare loop; **abandoned for the wrong reason** — 06-01 proved the same
   transport passes Cloudflare when the *browser posture* is right (Chrome-stable +
   trusted persistent profile). Caveat before reviving: strict stealth mode bans CDP
   touches on the user's tab *during interaction* (Turnstile-detectable), so CDP can't
   simply become the human-input plane again; but the posture insight (binary/profile
   trust dominates transport) is load-bearing either way. The `CdpSurfaceAdapter` and
   the JPEG-poll `BrowserSurface` path still exist as the fallback ("is that still
   around?" — yes, but disabled under strict stealth and under-maintained).
2. **Auto-resume race** (designed 06-26, unbuilt): after escalation to a blocking
   manual action, race `owner clicked Continue` OR `session became active` and resolve
   whichever wins. Kills the "sat there logged in" / "approved without realizing"
   class. Only the copy fix (PR #85) shipped.
3. **Guacamole IME completion** — the controller exists and is unit-green; what's
   missing is *proof of binding* on-device (step-5b showed legacy fallback still
   handling text) and the un-stubbed keysym table. The staged de-risk plan from the
   prior-art doc (standalone harness on the real phone → loopback → wire) was never
   completed.
4. **One-posture-contract + golden drift probe** (proposed 06-01): a probe reporting
   binary/version/flags/profile/CDP-mode/viewport/WebGL for both local-launch and
   managed-neko paths, to prevent silent posture drift (the class of bug behind both
   the original CDP abandonment and the 06-10 captcha regression).
5. **Manual "switch stream" affordance** (05-13) — rejected for dynamic per-connector
   leases; fallback design if lease RAM cost (hundreds of MB/surface) or capacity
   starvation (research doc: cap 3 vs 5 managed connectors; one stuck 2FA starves the
   rest) bites.
6. **noVNC/KasmVNC/lower-level geometry libs** (05-07) — probed, rejected: no library
   decides resize-vs-crop-vs-hold during Android viewport churn. The custom
   container-rect + RandR approach came from this.
7. **TURN / public WebRTC route** (05-06) — raised for off-LAN media path, disposition
   unclear; relevant if remote (non-LAN) mobile latency ever becomes a real complaint.

---

## 6. Open defects (as of 2026-07-06)

- Remote typing on mobile: brittle, no end-to-end-validated path (the #1 "never got
  the UX to work well" item).
- Viewer fit-to-viewport on phones: unfixed (06-19 Amazon incident).
- Auto-resume: designed, unbuilt.
- `sendText` no-op; n.eko cleanup-on-remount; streaming lifecycle race/leak candidates
  (07-03 night report — untriaged).
- Only-opt-in live-Docker tests: capacity queueing and real frame emission unexercised
  in CI.
- Unhandled remote-surface fetch can throw to the console error boundary on a network
  blip (shippability audit 06-16).
- Legacy ChatGPT browser_collector/SSO reconnect still owner-unconfirmed after
  the PR #169/#170 fixes.

---

## 7. Diagnosis and recommended attack order (analysis, 2026-07-06)

**Why it never converged:** the four layers (§0) have different difficulty classes and
were debugged interleaved, so a fix in one layer kept being "disproven" by a bug in
another (e.g., IME work invalidated by geometry churn, geometry fixes invalidated by
orchestration dead-ends). And every layer shared one meta-bug: **no trustworthy,
user-equivalent acceptance signal** — telemetry measured internal quantities, not what
the user saw; the expert's Android acceptance checklist was never made executable; the
"validated" claims kept being falsified one document later.

**Recommended order (highest leverage per unit of yak):**

1. **Build the acceptance instrument first.** Make the 9-point Android gate (one-tap =
   one-click; no long-press save-image; keyboard opens and stays; email/password/
   numeric-2FA/backspace/enter; viewport survives keyboard; WebRTC stable) an
   executable, observable checklist: per-character input-path telemetry (WHICH handler
   consumed each keystroke — the exact signal whose absence let step-5's false success
   stand), plus a screenshot-diff harness for geometry. Without this, any fix round
   repeats 05-08 ("how does this keep happening?").
2. **Ship the auto-resume race (§5.2).** Small, fully designed, kills the most
   recent, most owner-visible failure class, and independent of the hard IME problem.
3. **Reduce the need to type in the stream at all.** The 06-29 workaround is a product
   insight: prefer one-time-code/email-link login flows where sites offer them;
   offer host→stream credential paste as a first-class affordance (clipboard inject via
   neko API rather than keystrokes); lean on push-2FA. Every character not typed
   remotely is UX won without solving IME.
4. **Viewer fit-to-viewport** — bounded geometry work with the §7.1 harness as its gate.
5. **Then, and only then, the IME endgame** — resume the staged plan at the point it
   broke: prove `MobileTextInputController` binds (step-5c's unresolved hypothesis),
   un-stub the keysym table, run the gate. Accept that this is ecosystem-unsolved
   territory; the Guacamole port is still the right architecture per all prior art.
6. **Posture drift probe (§5.4)** as regression insurance — cheap, prevents the two
   historical "mystery captcha" incidents from recurring.

Non-goals to resist (from the expert brief, still valid): don't keep patching
`stream-viewer.tsx` (it's 5,256 lines — the brief's warning was ignored once already);
don't make `@demodesk/neko` the center; don't chase every IME edge case up front.

---

## Appendix: key artifacts

- `docs/5-12-26-chatgpt-remote-surface-brief-response.txt` — decision of record (architecture).
- `docs/remote-browser-mobile-input-review-brief.md` — the original ask + concrete Android bug list.
- `docs/neko-stealth-design-brief.md` — stealth layer, shipped+validated.
- `docs/mobile-ime-prior-art-research.md` — Guacamole plan + staged de-risking.
- `docs/handoff-2026-05-12.md` — best single first-person "what went wrong" account.
- `docs/remote-surface-step-{4-ime,5-validation,5b-validation,5c-diagnosis}.md` — the disproven-success chain.
- `tmp/workstreams/claude-neko-rh-*.md` — live layered-bug debugging logs (geometry → keyboard race → touch triple-dispatch).
- `docs/handoffs/2026-07-03-night-report-finding-harvest.md` — latest open-gap status.
- Transcripts: codex `019d922d` (origin story, May), `019ea88b` (June→July window).
- Recent shipped fixes: PR #85 (continue-collection copy), #111 (stream label), #169
  (binding-first reconnect routing), #170 (`68aef8e32`, "Preparing the secure browser"
  first-class state + timeline poller).

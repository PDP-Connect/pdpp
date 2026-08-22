# Browser-stream: the captcha tap, and the false "logged in" claim

2026-08-22

Two owner-reported defects on the interactive browser-stream path, both
repeated across several days. They are unrelated in mechanism but share a
theme: the console asserted things it could not prove.

## 1. "Can't tap the captcha on mobile" — the residual half

Reported at least three times from 2026-08-18. Scroll and rotate worked; taps
did not.

### The iframe theory is wrong, and worth retiring explicitly

A reCAPTCHA checkbox lives in a cross-origin iframe, so the natural suspicion is
that synthetic pointer events do not cross the iframe boundary, or that
coordinates fail to resolve inside the iframe's document.

**That is not what happens here.** The remote input path is coordinate-based all
the way down — neko dispatches X11 pointer events, and the CDP backend calls
`Input.dispatchMouseEvent` with raw `x`/`y`. Both operate at the browser
compositor level, *below* the DOM, so they cross cross-origin iframe boundaries
by construction. Nothing in the path hit-tests the top document: there is no
`elementFromPoint`, no `querySelector` against remote DOM, no frame targeting.
The only `elementFromPoint` in the streaming server is a calibration-beacon
diagnostic, not the input path.

The captcha was never special. It is simply the one control an owner *cannot*
work around, so it is where a general tap defect gets noticed and reported.

### What two prior commits fixed, and what they left

- `a21a9a1be` stopped *dropping* touch taps that reported a non-zero
  `event.button`. Correct: `button` is mouse-state and must not gate touch.
- `5274dbd4c` rerouted touch press/release onto the CDP mouse path, because
  `Input.dispatchTouchEvent` does not reliably synthesize a `click`.

Both are real fixes. Neither covers the residual case, because the first
commit stopped *filtering* on `button` but still **forwards the raw value**, and
downstream that value is not a filter — it is arithmetic:

```js
// remote-surface 1.5.2, controllers/neko-pointer-controller.js
const x11Button = (event.button ?? 0) + 1;
```

X11 button 1 is primary. A touch `pointerdown` reporting `button === -1` — the
same non-spec value `stream-viewer-pointer-input.ts`'s own doc comment documents
as real on touch input paths — therefore becomes **X11 button 0**, which is not
a button. neko presses nothing, and the tap never clicks.

Verified by replaying the exact client payload through the real installed
controller:

| `button` on pointerdown | X11 call emitted |
|---|---|
| `0` (spec-compliant) | `buttonDown(1)` — correct |
| `-1` | `buttonDown(0)` — **no button pressed** |

`pointerup` was already safe by luck: the controller prefers the *remembered*
press button over the event's own. `pointerdown` has nothing to fall back to.

This also explains the reporting pattern. Engines that report a spec-compliant
`0` always worked, which is why the bug never reproduced on desktop and why it
looked intermittent rather than universal.

### The fix

`normalizedPointerButton` in
`apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer-pointer-input.ts`
pins touch and pen to primary contact at the payload boundary. Touch and pen
have no secondary button, so this loses no information. Mouse is passed through
untouched — its `button` is meaningful, and normalizing it would turn every
right-click into a left-click.

Guarded by `stream-viewer-touch-tap-oracle.test.ts`, which asserts against the
**real dependency** rather than restating our own arithmetic, so a future
dependency bump that changes the mapping fails loudly instead of silently.

### Honest limits

**This is not confirmed against a real phone.** I do not have the owner's
device, and I did not attempt a Reddit login (OTP/bot-detection sensitive, and
the owner has been explicit about not burning accounts). What is proven is
mechanical: the payload the client sends, replayed through the real controller,
pressed no button before this change and presses primary after it. Whether that
was the *only* remaining cause of the owner's symptom is unverified — it is a
genuine defect on the exact reported path, not a confirmed end-to-end repro.

## 2. The false "logged in" state — the more dangerous half

The UI told the owner he was already logged in to Reddit when he was not.

### The evidence the UI used was a proxy

`deriveSetupState` in `reference-implementation/runtime/static-secret-setup-status.ts`
reaches `first_sync_running` / `first_sync_pending` for a browser session from
`hasDraftSetupProgress`, which is satisfied by run evidence alone:

```ts
return hasSetupMaterial || (setupKind === "browser_session" && hasRunEvidence(input));
```

The console then rendered, in `connect/status/[connectionId]/page.tsx`:

> "Login is complete and the first sync is running."

**For a `browser_session` connection, the run IS the login attempt.** It starts
precisely so the owner can sign in inside the streamed browser. So a run row
proves a sign-in was *attempted*, never that it completed. The projection's own
comment stated the flawed inference out loud — "(the owner completed login and a
first sync started)" — which nothing in the projection verifies. `lastRun` also
satisfies it, so a *previous* failed run made the UI claim login was complete on
the current attempt.

The asymmetry makes the defect obvious once seen. For the other two setup kinds
the same states carry claims that **are** backed by evidence:

| Setup kind | Claim | Backed by |
|---|---|---|
| `static_secret` | "The provider credential is captured" | `setup_material.present === true` |
| `manual_upload` | "The import file is captured" | `setup_material.present === true` |
| `browser_session` | ~~"Login is complete"~~ | **nothing** — `defaultSetupMaterial` pins `present: false` |

### The fix

The browser-session copy now describes only what is observed — a sync is
running — and points the owner back at the browser, admitting the page cannot
confirm the login itself. The static-secret and manual-upload claims are
deliberately left intact, and a test pins them, so this does not over-correct
into scrubbing information that is genuinely proven.

Guarded by `browser-session-login-honesty.invariants.test.ts`, which fails on
any phrasing that asserts a completed sign-in.

### What was NOT fixed, and should be

The connector layer already holds **real proof** of Reddit login state.
`isSessionLive` in `packages/polyfill-connectors/src/auto-login/reddit.ts`
fetches an owner-only JSON endpoint and requires HTTP 200 — ground truth, not a
heuristic, and deliberately so per its own doc comment.

**That verdict is never plumbed into the console.** Wiring it through would let
the UI make a positive, evidence-backed claim instead of merely declining to
make a false one. That is a larger change across the RI projection boundary and
is left for a follow-up.

Two related weaknesses found and not fixed here:

- `isSessionLive` degrades to counting a logout-link selector when
  `REDDIT_USERNAME` is unset — which is exactly the credential-less manual
  handoff path. The repo's own tests document that this selector is unreliable
  in both directions.
- An instance flips to `status = 'active'` on first successful ingest and is
  **never re-validated**. A session that worked in June and has since been
  logged out server-side still projects `active` → `healthy`. There is no
  `last_verified_at` on the credential row, and for browser sessions the
  credential row is bypassed entirely.

Both mean "connection active" is a durable-row claim, not a live one. That is a
real instance of the same defect class and deserves its own change.

## 3. "Couldn't reach the browser stream" — assessed, largely already sound

Root-caused but not re-engineered, because the existing design is mostly honest.
The give-up message fires after 10 attempts with backoff, and is followed by a
diagnostic probe (`stream-reach-diagnostics.ts`) that recovers the real HTTP
status and error code — necessary because `EventSource` collapses every
pre-attach failure into a payload-less error. Four of six reasons already get
specific, actionable copy.

Two genuine residual gaps, left for a follow-up rather than fixed blind:

1. `managed_surface_window_settle_unavailable` (a 503 the server describes as a
   transient restart worth retrying) is not in the classifier's match list, so
   it falls through to the vague generic copy.
2. The generic message is shown *before* the probe resolves, so there is a
   window where the owner reads network-flavored copy even when the cause is
   precisely known moments later.

Neither is a fabricated-green defect — the classification rests on a real HTTP
status — so they are accuracy gaps, not dishonesty.

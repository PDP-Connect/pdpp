# SLVP-Ideal: Scheduled Run Human-Help — Cloudflare Detection, Bounded Wait, Notify Config

**Date:** 2026-06-12  
**Source:** Red-teamed design from autonomous research task `wqkwq4c9a`, final confidence 90%. Individual component confidences: cloudflare_primitive 96%, bounded_wait 88%, notify_config 96%.

---

## Status

| Component | Status |
|---|---|
| **Cloudflare detection (shared primitive)** | **IMPLEMENTED** — shipped in this change (final-drain worktree) |
| **Scheduled bounded-wait for owner help** | **DESIGNED, NOT YET SHIPPED** — has a ship-blocking precondition (see §2) |
| **Notify-on-scheduled-human-needed config** | **SHIPS ON, non-configurable** — already fires via existing push path; ideal two-tier config is design-noted only (see §3) |

---

## 1. Cloudflare Detection (Shared Primitive) — IMPLEMENTED

### What shipped

`packages/polyfill-connectors/src/platform-probes.ts` now exports `detectCloudflareChallenge(page, opts?)` returning `CloudflareVerdict { isChallenge: boolean; signals: CloudflareSignal[]; confidence: 'confirmed' | 'none' }`.

The function is read-only by contract (matching the file's existing probe doctrine): it inspects title, DOM, and an optional navigation response — it never clicks, types, navigates, or attempts to solve a Turnstile challenge.

### Signals

Six independently-sufficient signals, in probe order:

| Signal | Trigger |
|---|---|
| `title_just_a_moment` | `page.title()` matches `/^just a moment/i` |
| `challenge_platform_script` | `locator('script[src*="challenge-platform"], script[src*="/cdn-cgi/challenge-platform/"]').count() > 0` |
| `turnstile_iframe` | `locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count() > 0` |
| `cf_challenge_dom` | `locator('#cf-challenge-running, #challenge-running, #cf-error-details').count() > 0` OR `locator('[id^="cf-"]').count() > 0` **when another signal has already fired** (corroboration guard — loose prefix alone does not count) |
| `cf_mitigated_header` | `navResponse.headers()['cf-mitigated'] === 'challenge'` |
| `http_403_cf` | `navResponse.status() === 403` AND (`headers['cf-ray']` present OR `headers['server']` matches `/cloudflare/i`) |

`isChallenge = signals.length > 0`. `confidence = 'confirmed'` iff `isChallenge`, else `'none'` — callers never have to guess.

Every probe is wrapped in a `safe()` helper that swallows both synchronous throws and rejected promises; a broken page object cannot propagate out of detection.

### Adopters

**ChatGPT** (`src/auto-login/chatgpt.ts` `fallbackForUnexpectedLoginUi`, ~line 224): previously emitted "possibly Cloudflare challenge" purely on absence of login inputs (a guess). Now calls `detectCloudflareChallenge(page)` and reports either "Cloudflare challenge confirmed (signals: …)" or "ChatGPT login inputs were not found and no Cloudflare challenge was detected."

**Reddit** (`src/auto-login/reddit.ts` `ensureRedditSession`, ~line 163): same pattern — absence of `USERNAME_SELECTOR` previously guessed CF; now the verdict is earned.

**Amazon** — noted follow-up. The Amazon connector's existing CAPTCHA classifier runs inside `page.evaluate()` (client-side JS) rather than Playwright locator calls, so adopting the shared detector requires a connector-side wiring read before proceeding. Not required for this change.

### Honesty win

Before: every "expected inputs not found" branch unconditionally emitted a "possible Cloudflare challenge" label — correct by luck at best, and it mislabels ordinary UI drift as CF. After: `interaction_posture`, `manualAction` reason, and operator-facing copy are earned from real page artifacts, not guessed from absence of inputs.

Red-team verdict: SOUND (≥96%). False-positive risk is low and bounded — each signal is a genuine CF artifact. The only soft spot is the loose `[id^="cf-"]` prefix (an unrelated app element whose id starts "cf-" could match), which the corroboration guard mitigates. False-negative residual: a CF variant that injects a decoy input would still let `findAndFillEmail` proceed; that is a strict improvement over today.

---

## 2. Scheduled Bounded-Wait for Owner Help — DESIGNED, NOT YET SHIPPED

### The problem

Today the scheduler's `onInteraction` handler fires a push notification and immediately returns `{status:'cancelled'}` (~`reference-implementation/server/index.js:5454`). The connector emitted `timeoutSeconds:1800` (30 minutes) for the interaction but that value is discarded at the scheduler seam — the bounded wait the connector promised never happens. Result: one Cloudflare challenge or OTP prompt during a scheduled tick wastes the entire run (0 records) and parks the connector via `markNeedsHuman`.

### The design

**Two files, one new env var.**

**(A) `reference-implementation/server/index.js` `onInteraction` (~lines 5406–5459):** Keep the existing `fanoutPendingInteractionWebPush` (lines 5416–5448, the f434bd2a owner-notification plumbing stays). Instead of immediately returning `{status:'cancelled'}` at 5454, await a bounded owner-response source — reuse the manual path's broker (`controller.ts` `brokerInteraction` / `respondToInteraction(runId, …)`, the same machinery manual runs already use) raced against a scheduler-max timeout.

- If the owner responds within the window → return their `INTERACTION_RESPONSE` (run continues, can complete — records gained, connector NOT parked).
- If the window elapses → return `{status:'cancelled'}` exactly as today (durable gaps, needs-human, 0 records — graceful, unchanged downstream).

**(B) `reference-implementation/runtime/scheduler.ts` `wrappedInteraction` (~lines 1778–1790):** Move / condition the `markNeedsHuman(connectorId, connectorInstanceId)` call at `:1780` so it fires **only** when the bounded window elapses without an owner answer. Currently it fires synchronously before `onInteraction` returns — a successfully-answered scheduled interaction would leave the connector falsely parked (`markNeedsHuman` is a sticky in-memory `Set`, cleared only by a manual run or `clearNeedsHuman`, no auto-retry).

**Window value:** `min(connector-declared msg.timeout_seconds, PDPP_SCHEDULER_INTERACTION_WAIT_MAX_MS)` where the env defaults to `600000` (600 s / 10 min). Rationale: connectors already declare the exact window they want (`chatgpt.ts` emits `timeoutSeconds:1800` at three sites). That contract is currently discarded at the scheduler seam. The 10-minute clamp is not the full connector-declared 30 minutes — it is chosen to bound cross-connector global-cap starvation under the live cap=3 config (see precondition below).

**Window-elapse status note:** When the window elapses the runtime timeout racer fires `status:'timeout'` (not `status:'cancelled'`). This is harmless — connectors re-probe session liveness on `manualAction` return (`chatgpt.ts:240–241`, `reddit.ts:171`) and ignore the return status. Downstream spine/attention events will read `'timeout'` not `'cancelled'`; verify any test that pins `status:'cancelled'` on scheduled-interaction timeout before shipping.

---

### THE SHIP-BLOCKING PRECONDITION

**Set `PDPP_NEKO_SURFACE_CAP >= number of managed browser connectors` (currently ≥ 5) BEFORE enabling the bounded wait.**

Why this is blocking: the global `surfaceCap` is a flat count of all neko surfaces across all connectors — `packages/remote-surface/src/reference/browser-surface-leases.ts:1259–1261` `#activeSurfaceCount()` holds no per-connector partition. A new lease at-cap returns `wait_reason:'capacity_full'` (`:1079`). Reclaim is idle-only: `planCapacityPressureReclaim` (`:1047–1055`) and `cleanupIdleSurfaces` (`:1009`) both gate on `!surface.active_lease_id`, so a run **blocked on an owner CF challenge holds its active lease and cannot be reclaimed** for the full bounded window.

The live config is `PDPP_NEKO_SURFACE_CAP=3` with 5 managed browser connectors (ChatGPT, Chase, USAA, Amazon, Reddit) — already at cap. A 10-minute owner-help hold can give a 4th connector `wait_reason:'capacity_full'` → `lease_wait_timeout` → deferred → re-timeout loop while the block persists.

**Fix:** Raise `PDPP_NEKO_SURFACE_CAP >= 5` on `pdpp-reference-1`. At that point `#activeSurfaceCount` never hits cap while all connectors have active surfaces, `capacity_full` never fires, and the bounded wait starves nothing. The 600 s clamp then bounds hold duration without any cross-connector impact.

Note: per-container surfaces are dedicated (each connector has its own `pdpp-neko-<connectorId>-<hash>` container, own port/profile/CDP), so a blocked ChatGPT tab **cannot literally occupy Chase's or USAA's browser window** — the only shared resource is the integer global cap seat. Holding a CF challenge page open is benign; the wait never auto-solves Turnstile, never resubmits, never hammers.

### Two required wiring reads before implementing

**(a)** Read `controller.ts` `brokerInteraction` (`:1403`) resolve/cleanup and `resolveCancelledInteraction` at run teardown. Confirm the broker promise resolves on `respondToInteraction` and is cleaned up on run teardown, so a leaked pending entry cannot hold the `activeRuns` slot past the window.

**(b)** Read `reference-implementation/runtime/index.js` racer (~`:2983`) to confirm it is no longer pre-empted by the scheduler's instant cancel before the timeout fires.

### Deferred: active-lease cooperative yield (design-note only)

Correct long-term design (do not build now): a scheduled run blocked on owner help yields its pool seat only when `activeSurfaceCount >= surfaceCap` AND a cross-connector `capacity_full` waiter exists. This requires extending the currently idle-only reclaim to preempt an active-but-blocked lease — a non-trivial change. The cap-raise above makes it unnecessary for the initial ship.

---

## 3. Notify-on-Scheduled-Human-Needed Config — SHIPS ON, Non-configurable

### Ship-now: already fires, zero new code

The scheduler's `onInteraction` (`index.js:5406–5459`) already calls `fanoutPendingInteractionWebPush` unconditionally for every scheduled-run interaction. A Cloudflare challenge during a scheduled run surfaces as a `manual_action` interaction → `classifyInteractionSensitivity` `'external'` → `ACTION_REQUIRED` tier → rides this push path with no separate plumbing.

`notification-policy.js` `projectNotificationDelivery` already makes `ACTION_REQUIRED` bypass quiet-hours (`quiet_hours_applied` only when `tier === INFORMATIONAL`, `:77`). The un-suppressable floor is correct and already correct.

Spam is bounded: `markNeedsHuman` parks the connector after the first blocked tick; `gateNeedsHuman` (`:1657–1713`) skips subsequent automatic ticks; the `§10-F` escalation push (`:5464–5481`) deduplicates once per streak via `announcedBlockedClass` / `notifiedNeedsHumanSkips`. The push fires once per real interaction, not every tick.

**Net ship-now action: leave both seams as-is.** Only pair this with the bounded-wait above so the push gives the owner a real chance to respond before the (clamped) cancel.

### Ideal two-tier config (design-note only — do NOT build now)

**Shape:** Two-tier matching the Stripe / GitHub / Vercel / Plaid norm.

1. **Global per-owner event-class default** — one toggle + channel selection + optional quiet-hours for the event class "a scheduled run needs me." Default = ON, no quiet-hours, all opted-in devices.
2. **Optional per-`connection_instance_id` override** (natural because `connector_schedules` is already per-instance, consistent with GitHub per-repo Custom notifications).
3. **Un-suppressable `action_required` floor** — a genuinely blocked schedule can never go silently dark (mirrors GitHub's participating floor and Vercel's "can't disable critical alerts").

The honest trigger signal for which connectors fire it: `interaction_posture != 'none'` from the connector manifest (`auth.js` `REFRESH_POLICY_ALLOWED_KEYS` `interaction_posture`). Connectors with `interaction_posture === 'none'` (fully unattended) will not realistically trigger this.

**Where it lives: a NEW policy store**, NOT the device table. `web_push_subscriptions` (`db.js:294–313`) is keyed by `owner_subject_id + endpoint` and models **devices** (where to send) — it is the wrong home for whether to send. Connector manifests are also wrong: they carry the connector's intrinsic nature, not the owner's preferences. Correct home: a new small policy store with a global per-owner row (`owner_subject_id`, `event_class`, `enabled`, `quiet_window`) and an optional override column keyed on `connector_instance_id`.

**How it wires:** The config feeds the existing `projectNotificationDelivery({ channelOptedIn, quietWindow, tier })` chokepoint in `notification-policy.js` — the two params are already there, hardcoded today (`channelOptedIn: true`, `quietWindow` never threaded). The config is a store behind an already-designed pure function; no new policy logic required.

**Full per-connection × per-event matrix** is explicitly NOT the default design — prior art (Stripe, Vercel) reserves that for separate Alerts/Workflows surfaces, not the main notification preference page.

---

## Red-team summary

| Component | Verdict | Key caveat |
|---|---|---|
| Cloudflare primitive | SOUND ≥96% | False-negative: CF variant injecting a decoy input bypasses (strict improvement over today) |
| Bounded wait | NEEDS-REVISION 88% — do not ship without cap fix + two wiring reads | Cap=3 < 5 connectors is a real starvation path until PDPP_NEKO_SURFACE_CAP≥5 |
| Notify config | SOUND ≥96% | Confirm CF `manual_action` populates `owner_action`/`progress_posture` so `classifyAssistanceNotification` yields `ACTION_REQUIRED` not `INFORMATIONAL` |

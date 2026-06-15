# SLVP-Ideal Connector Agency and Silence
**Research date:** 2026-06-15  
**Status:** Final — adversarially reviewed  
**Commissioned to correct:** prior research `slvp-connector-health-priorart-2026-06-15.md` was honesty-myopic (84 status/render mentions, only 11 agency/silence mentions). That doc answered "how do products SHOW health"; this doc answers "what should the system DO, and what should it STAY SILENT about."

---

## The core question

A connector-health dashboard that honestly shows "stale, broken, 2532 gaps" across 12 connectors and leaves the user to deal with it is **honest AND useless**. This document answers:

1. The **agency frontier** — what does the system do on the owner's behalf vs. what does it surface for a human decision?
2. The **silence discipline** — which honest signals should never reach the owner because they are not actionable?
3. The **calm-technology ideal** — what design choices earn "I never think about it"?
4. The **honesty↔usefulness reconciliation** — how can a system be both honest (never lie) and useful (don't make the owner process truth they don't need)?
5. The **SLVP-ideal agency policy for PDPP** — per-state decision rules.

---

## 1. The Agency Frontier — Prior Art

### 1.1 Plaid — Item lifecycle (gold standard)

Source: https://plaid.com/docs/errors/item/ · https://plaid.com/docs/link/update-mode/ · https://plaid.com/docs/api/items/

Plaid's canonical Item states:

| State | Who handles it | Mechanism |
|---|---|---|
| `HEALTHY` | System | Silent collection continues |
| `PENDING_EXPIRATION` (UK/EU, 7 days) | System raises pre-emptive flag | `PENDING_EXPIRATION` webhook; app may show warning |
| `PENDING_DISCONNECT` (US/CA, 7 days) | System raises pre-emptive flag | `PENDING_DISCONNECT` webhook |
| `ITEM_LOGIN_REQUIRED` | **Human required** | Auth broken; Link update mode re-auths the same Item |
| `ERROR` (transient/network) | System retries silently | No user interrupt |

**The critical design decision:** Plaid does not interrupt the user for transient errors, network failures, or rate-limiting. It only interrupts for `ITEM_LOGIN_REQUIRED` — which literally cannot be resolved without the human's credentials. Every other failure is a system responsibility.

**The `LOGIN_REPAIRED` webhook** fires when the Item exits the bad state — *even if it was repaired elsewhere*. The app receives an explicit "stop nagging" signal. Recovery is a state transition, not a button click.

**Agency rule from Plaid:** Only surface to the human when the provider will not accept any automated credential the system already holds. Everything else is the system's problem.

### 1.2 Nango — OAuth token lifecycle

Source: https://nango.dev/docs/guides/auth/token-refreshing · https://docs.nango.dev/guides/platform/webhooks-from-nango

Nango's automatic token refresh policy:
- Refreshes OAuth access tokens **before expiry** — silently, without any app or user involvement.
- Refreshes each token at least **once every 24 hours** to prevent inactivity-based revocation.
- On refresh failure: sends a webhook to the app. The app decides whether to prompt the user.
- Failure categories that require humans: user revoked access, API revoked refresh token, provider outage (temporary — retry first).

Nango's sync run webhook payload distinguishes `success: true/false`. The app surfaces only the failure, not the mechanism (which token failed, which retry count).

**Agency rule from Nango:** The integration platform owns the token lifecycle completely. The application (and its owner) is only notified on failure, and only after the platform has exhausted its own recovery options. The human is prompted to reconnect, not to understand token internals.

### 1.3 Stripe Connect — Requirements as tiered obligations

Source: https://stripe.com/docs/connect/account-capabilities · https://stripe.com/docs/connect/handling-api-verification

Stripe's `requirements` hash:

| Field | Meaning | Who acts |
|---|---|---|
| `eventually_due` | May be needed someday | System monitors, no user interrupt yet |
| `currently_due` | Needed before deadline | **Human required** — verification info |
| `past_due` | Deadline passed, capability disabled | **Human required, urgent** |
| `disabled_reason` | Current capability status | System derived; displayed if human needs to act |

Auto-clear: when a `currently_due` requirement is satisfied, it disappears from the array. The system does not need to tell the user "you did it" — the absence of the requirement is the signal.

**Agency rule from Stripe:** Tier your requirements by human-necessity. Surface `currently_due` only when the deadline is approaching. Surface `past_due` with urgency. `eventually_due` lives in the periphery. The **removal** of a requirement is the positive signal — not an explicit success notification.

### 1.4 Google OAuth — Silent refresh as the baseline

Source: https://developers.google.com/identity/protocols/oauth2/web-server#offline

Google's access token expires every 3600 seconds. The client silently exchanges the refresh token for a new access token — zero user involvement. Human re-auth is required only when:
- The user explicitly revokes permissions in their Google account
- The refresh token expires due to inactivity (6 months)
- The user changes their password (in some configurations)

**Agency rule from Google OAuth:** Short-lived tokens + silent automatic refresh = the system handles all routine credential maintenance. Human involvement is reserved for the case where the user has actively changed the trust relationship.

### 1.5 Temporal — Workflow retry vs. terminal failure

Source: https://docs.temporal.io/workflows

Temporal separates:
- **Activity retries**: automatic, configurable, silent. A failing activity retries with backoff until its retry policy exhausts.
- **Workflow failure** (terminal `Failed` state): requires human intervention — inspect history, decide to retry or fix.
- **Task queue health** (no pollers, lag): a runtime problem, not a workflow problem. Surfaces as a separate global indicator, never as individual workflow failures.

**Agency rule from Temporal:** Distinguish retry-eligible transient failures (system handles) from terminal failures (human needed). Critically: a runtime problem (scheduler dead, queue empty) must not cascade as individual item failures — it surfaces as a global runtime health indicator above the per-item level.

---

## 2. The Silence Discipline — Prior Art

### 2.1 Google SRE Book — Alerting Philosophy

Sources: https://sre.google/sre-book/monitoring-distributed-systems/ · https://sre.google/workbook/alerting-on-slos/

The SRE Book is the most cited operational document on the cost of noisy alerting. Key principles:

**The five-question alert test** (from Ch. 6, "Tying These Principles Together"):
1. Does this rule detect an *otherwise undetected condition* that is **urgent, actionable, and actively or imminently user-visible**?
2. Will I ever be able to **ignore** this alert, knowing it's benign? If yes, it's a design defect.
3. Does this alert **definitely** indicate users are being negatively affected? If there are benign cases, filter them.
4. Can I take **action** in response to this alert? Is it urgent, or could it wait until morning? Could the action be **safely automated**?
5. Are **other people** getting paged for this issue (redundancy = noise)?

**Symptom over cause** (Ch. 6, "Symptoms Versus Causes"):
> "What's broken" (symptom) vs. "why" (cause). Alert on symptoms. Cause-oriented heuristics belong in debugging tools, not alert rules.
> "A healthy monitoring and alerting pipeline is simple and easy to reason about. It focuses primarily on **symptoms** for paging, reserving cause-oriented heuristics to serve as aids to debugging problems."

**Dashboard vs. alert** (Ch. 6, Conclusion):
> "Email alerts are of very limited value and tend to easily become overrun with noise; instead, you should **favor a dashboard** that monitors all ongoing subcritical problems."

In other words: subcritical, self-healing, or cause-level information belongs in a dashboard panel that operators can consult — not in an attention-capture channel.

**SLO-based alerting precision/recall** (Workbook Ch. 5):
> "If you set SLOs that are meaningful, understood, and represented in metrics, you can configure alerting to notify an on-caller only when there are actionable, specific threats to the error budget."
> "Pages and tickets are the only valid ways to get a human to take action."

**The silence rule derived from SRE:** An alert that can be automated is a design defect. An alert that can be ignored is a design defect. An alert that is about a cause (not a symptom) belongs on a dashboard, not in the attention channel. The attention channel is for: urgent + actionable + human-intelligence-required + not automatically resolvable.

### 2.2 Alert Fatigue — The Cost of Noise

Alert fatigue is the well-documented phenomenon where high-volume, low-signal alerts cause operators to ignore or silence all alerts — including the real ones. Key research findings (multiple sources):

- After approximately 100 low-signal alerts per day, operators begin ignoring alert content and develop "alert blindness."
- Alert fatigue is self-reinforcing: once operators stop trusting the alert channel, real alerts are also missed.
- The primary cause is "honest but non-actionable" alerts — alerts that accurately report a state but where the operator has no action to take.

**Silence as a safety property:** Suppressing an honest-but-non-actionable signal is not dishonesty — it is correct system behavior. An alert that the owner cannot act on consumes attention budget without delivering value. Over many such alerts, the attention budget is exhausted and real alerts are missed.

### 2.3 Nango — What gets surfaced vs. what stays internal

Nango's webhook design (https://docs.nango.dev/guides/platform/webhooks-from-nango) fires on:
- Connection created
- Sync run finished (success or failure)
- **Auth refresh failure** (the only credential-lifecycle event that reaches the app)

What Nango does NOT surface:
- Individual token refresh attempts
- Intermediate retry attempts within a sync
- Rate limit encounters
- Internal retry backoff state

The app developer (and by extension, the end user) sees only the terminal outcome, not the mechanism.

---

## 3. Calm Technology — The Attention-Minimization Ideal

### 3.1 Weiser and Brown's Calm Technology (1995)

Source: Wikipedia (https://en.wikipedia.org/wiki/Calm_technology) citing Weiser & Brown, "Designing Calm Technology" (1995); Weiser & Brown, "The Coming Age of Calm Technology" (1996)

> "Calm technology: that which informs but doesn't demand our focus or attention." — Weiser & Brown

Three core principles:
1. **The user's attention must reside mainly in the periphery.** Technology shifts to center-of-attention when needed, but otherwise operates in the periphery.
2. **Technology increases effective use of the periphery** — not by adding more signals to the center, but by letting the periphery carry more ambient meaning.
3. **Technology conveys familiarity and situational awareness** — the user feels "I know roughly what's happening" without having to actively check.

Applied to a connector dashboard: the system's default state is periphery — a status indicator the owner notices only if it turns red. The transition to center is reserved for when the owner's action is genuinely needed.

### 3.2 The "Ignorable Until It Needs You" Ideal

Products praised as calm technology share a pattern:
- **Tailscale:** Connects automatically on boot, heals on network changes, visible only as a menu-bar icon with a green dot. Interrupts only when a device is disconnected for policy reasons or auth expires.
- **Backblaze/Time Machine:** Runs silently on schedule, visible only as "Last backed up: X hours ago" in the menu bar. Interrupts only when no backup has run in N days (urgency = data loss risk).
- **Dropbox:** Syncs silently, tray icon shows activity. Interrupts only for selective sync errors or account storage full (things the user must resolve).

The common pattern: **ambient status is available on demand (periphery); active interruption only for human-required failures.** The owner never needs to check unless the system has told them to.

### 3.3 Amber Case — Eight Principles of Calm Technology

Source: https://calmtech.com (Amber Case's formalization of Weiser & Brown):
1. Technology should require the **smallest possible amount of attention**.
2. Technology should **inform without demanding** our focus.
3. Technology should **make use of the periphery** — what we're aware of without thinking about.
4. Technology should **amplify the best of technology and humanity** — not the worst.
5. Technology can **communicate** without speaking.
6. Technology should work even when it fails — **graceful degradation**.
7. The **right amount of technology** is the minimum needed to solve the problem.
8. Technology should **respect social norms**.

Principle 1 directly addresses PDPP: a dashboard showing 12 connectors' internal states (gaps, retry counts, scheduler state) maximizes the attention required, violating principle 1. The ideal minimizes it: the owner sees a compact status and is interrupted only when human action is required.

---

## 4. The Honesty↔Usefulness Reconciliation

### 4.1 The Tension

**Honesty-maximalism** argues: show everything accurate. If there are 2532 gaps, show 2532 gaps. If ChatGPT is stale while draining, show "stale, 2532 gaps pending." This is honest.

**Usefulness** argues: the owner cannot act on "2532 gaps draining." The system is handling it. Showing this number consumes the owner's attention budget and trains them to ignore the dashboard.

The tension is real. The resolution is **not** "suppress information" — it is "route information correctly."

### 4.2 The Resolution: Two-Layer Honesty

**Surface layer (dashboard headline):** Optimizes for signal-to-noise. Shows only what the owner can act on. Suppresses mechanistic details the system is handling. This is the **attention layer**.

**Detail layer (connection panel, run log, operator console):** Full fidelity. Every gap count, retry attempt, token refresh, scheduler tick. This is the **inspection layer** — always accessible, never forced.

The system is not hiding the truth — the truth is one click away. It is routing the truth to the correct layer. This is identical to how progressive disclosure (NN/g) works: "higher-level pages contain higher-level concepts; lower-level pages fill in the details for those users who want to know everything."

**The reconciliation principle:** The dashboard is honest when it never lies and never withholds actionable information from the owner. It is useful when it only interrupts for what the owner genuinely needs to do. The detail panel is the safety valve: engineers, reviewers, and power users get the full picture one click down.

### 4.3 The "Reference Must Be Inspectable" Constraint

PDPP's reference implementation has a specific requirement: the system must be inspectable for engineering review and verification. This is not in tension with calm-technology — it is a different user and a different layer.

The engineer-user relationship with the system is via the **operator console** and **run logs**, not the owner dashboard. The distinction:
- **Owner dashboard** → calm, minimal, action-oriented
- **Operator/engineer console** → full fidelity, all axes, all evidence

These are already separate surfaces in PDPP's architecture. The calm-technology ideal applies to the owner dashboard, not the operator console.

### 4.4 The Counterargument: More Visibility Is Better

The strongest counterargument to silence discipline:
1. **Power users want to understand their system.** A sophisticated owner might want to see gap counts to calibrate expectations ("how long until ChatGPT catches up?").
2. **Visibility builds trust.** Hiding internal state feels like a black box — even if the system is handling it, the owner may not trust it.
3. **Early detection.** A human reviewing gap counts might catch a pathological case (e.g., gaps not draining for 5 days) before the system's automatic escalation fires.

**How the ideal reconciles this:**
- Power users can access the detail panel for any connection. The visibility is not removed — it is correctly placed.
- Trust is built by the dashboard being *right*, not by it showing everything. If the dashboard says "healthy" and the data is fresh, the owner trusts it. If the dashboard shows 2532 gaps and then they drain, the owner learns to ignore gap counts.
- Early detection for pathological cases is handled by the system's own escalation to `degraded` or `blocked`. The owner doesn't need to manually review gap counts to catch a drain that stalled — the system catches it and escalates.

---

## 5. SLVP-Ideal Agency Policy for PDPP

### 5.1 The Agency Decision Rule

**A human is required if and only if:**
> The condition cannot be resolved by any operation the system can perform with credentials and access it currently holds, AND the absence of owner action will permanently harm data completeness or collection capability.

Corollary: if the system can retry, wait, rotate, backoff, or self-heal — it should do so silently. The owner is not needed.

Finer points:
- "Cannot be resolved" includes "would resolve but we don't have authority." For example, if a refresh token is revoked, no automatic operation can re-grant it.
- "Permanently harm" rules out transient gaps that drain automatically. 2532 gaps draining on a scheduler is not permanent harm — it is scheduled work.
- The system should make this determination from `interaction_posture` and `background_safe` manifest fields, not from runtime heuristics.

### 5.2 The Silence Rule

**A signal is suppressed from the attention channel if:**
> It is honest AND the system is already handling it AND the owner cannot accelerate or improve the outcome by acting now.

Applied to PDPP states:

| Condition | Surface? | Reason |
|---|---|---|
| Automatic retry in progress | Suppress | System handling; owner action = wait anyway |
| Cooling off (source pressure, scheduled resume) | Periphery only (ambient badge + resume time) | System handling; owner knows if they look |
| ChatGPT gaps draining on scheduler | Periphery only (stale badge) | System handling; no owner acceleration |
| Token refresh succeeded silently | Suppress entirely | No owner action; no decision |
| Run completed successfully | Suppress entirely | No owner action; healthy state |
| Outbox items pending (normal queue) | Suppress | System handling |
| Outbox stalled (dead letters, no progress >threshold) | Surface as degraded | System cannot self-heal this |

The key inversion from the prior research: **the default is silence; the exception is surfacing.** The prior honesty-first model inverts this — it surfaces everything and hopes the owner ignores non-actionable signals. The SRE evidence shows that model fails.

### 5.3 The Per-State PDPP Agency Policy

This table is the deliverable: for each connection health state, what is the system's responsibility, and what (if anything) reaches the owner?

#### Tier 1: System handles — owner stays in periphery

| State | Dashboard surface | System action | Owner involvement |
|---|---|---|---|
| `healthy` (all conditions green, fresh) | Nothing — no pill, no badge | Routine scheduled collection | None |
| `healthy` + `syncing` badge | Ambient `syncing` badge only | Active run in progress | None — badge visible on inspection |
| `stale` + assisted connector (`interaction_posture` ∈ credentials/otp/manual) + `next_attempt_at` set | Quiet stale badge + scheduled resume time | Scheduler is managing gap drain | None — **this is the ChatGPT case: 2532 gaps draining is not an alarm** |
| `stale` + unattended connector + retrying | Quiet stale badge + next_attempt_at | Automatic retry scheduled | None |
| `cooling_off` (source pressure) | Compact backlog scale + resume time | Scheduler managing source pressure cooldown | None — inspectable if owner opens connection |
| `idle` (manual-only connector, stale) | Quiet stale badge + "Sync now" CTA visible on open | No automatic action | Owner can initiate sync; not alarming |
| `idle` (never run) | Idle pill, no alarm | Awaiting first run | None — owner aware they haven't run it |

#### Tier 2: System handles but owner may want to know

| State | Dashboard surface | System action | Owner involvement |
|---|---|---|---|
| `degraded` (coverage gaps, retryable) | Degraded pill + next step guidance | System retrying; may self-heal | Optional: owner can run manually to accelerate |
| `degraded` (outbox stalled, no progress) | Degraded pill + "Check the collector" CTA | System cannot self-heal; waiting for device | Owner may need to restart local collector |
| `degraded` (remote surface failure) | Degraded pill + surface guidance | System retrying; browser surface may recover | Optional intervention |

Tier 2 surfaces to the dashboard (a persistent pill) but does **not** send a push notification. It is a "you may want to look at this" signal, not a "you must act now" signal. The SRE principle: subcritical signals belong on the dashboard, not in the alert channel.

#### Tier 3: Human genuinely required — owner must act

| State | Dashboard surface | Push notification | Owner action |
|---|---|---|---|
| `needs_attention` (OTP/CAPTCHA requested) | CENTER — prominent CTA + attention card | Yes — "Owner input needed" | Provide the OTP/CAPTCHA value |
| `needs_attention` (credential rejected, session expired) | CENTER — CTA + attention card | Yes — "Owner action needed" | Re-authenticate via dashboard |
| `needs_attention` (act_elsewhere — OAuth approve) | CENTER — CTA + attention card | Yes — "Approve in your other app" | Complete OAuth flow in external app |
| `needs_attention` (response_required, any) | CENTER — blocking CTA | Yes — varies by `owner_action` | Must respond before run can continue |
| `blocked` (give-up streak exceeded) | Persistent `blocked` pill + guidance | Optional (one-time) | Investigate and reconfigure or re-authenticate |

This is the Plaid `ITEM_LOGIN_REQUIRED` equivalent: the system has exhausted its options. Human credential re-establishment is the only path forward.

### 5.4 The Runtime vs. Connection Distinction (Temporal lesson)

Following the Temporal pattern: a runtime failure (scheduler loop dead, browser surface unavailable) must not cascade as individual connection failures. If the scheduler is dead, 12 connections going to `cooling_off` simultaneously is incorrect — it is noise, and it breaks the silence discipline.

The PDPP equivalent: a global runtime health indicator (above the per-connection level) covers:
- Scheduler liveness
- Browser surface availability
- Local collector device connectivity

If the runtime has a problem, one global alert fires. Per-connection pills stay correct (the connections themselves are not broken — the runtime serving them is).

### 5.5 The Inspection Layer (satisfying "reference must be inspectable")

For every connection in Tier 1 (silently handled), full detail is available one click away:
- Gap count and drain rate
- Scheduler state and next attempt time
- Run history with per-gap outcomes
- Token state (refresh time, expiry)
- Source pressure backlog scale

This is the operator console / connection detail panel. Engineers and reviewers use this surface. The owner dashboard abstracts over it.

**The invariant:** The system never lies. The detail panel always reflects the honest state. The dashboard shows the subset of that state that requires owner attention.

---

## 6. Adversarial Validation

### 6.1 Strongest case for MORE visibility

"The owner of a financial data system should see all gap counts — financial gaps are meaningful, not noise. 2532 ChatGPT gaps represents 2532 conversations that haven't been synced. The owner deserves to know this."

**Response:** They do know it — it's in the detail panel. The dashboard suppresses it because it's not actionable: the system is draining them. If the drain stalls (system cannot continue), it escalates to `degraded` and the owner sees it. The alternative — showing 2532 on the dashboard — trains the owner to watch the number, which is not their job.

### 6.2 Strongest case for MORE alerting

"Silence about degraded states means the owner might not notice a chronic stall. If ChatGPT's drain is blocked by an undetected bug for 5 days, the owner hasn't been told."

**Response:** The `degraded` pill fires when the drain stalls past policy (outbox stalled, no progress). The system is responsible for detecting the stall and escalating. The correct fix for a stall that isn't caught is to improve the stall-detection logic, not to notify the owner of every gap count. Notifying on gap count doesn't help the owner detect a stall — it trains them to see gap counts as noise.

### 6.3 The "power user wants raw data" case

"the owner specifically looks at the dashboard to understand system health. He wants to see scheduler state."

**Response:** the owner has access to the operator console and connection detail panels. The owner dashboard is not the appropriate surface for scheduler internals — it is the surface for "do I need to do something?" If the owner wants to review scheduler state, the connection detail panel is the right place. The calm-technology ideal is not enforced — the owner can always navigate deeper. The design merely ensures the default experience is not noisy.

### 6.4 Confidence assessment

**High confidence** (multiple independent sources converge):
- Agency frontier principle (Plaid + Nango + Google OAuth all independently arrive at the same rule)
- Silence discipline (Google SRE book is authoritative; the five-question test is widely adopted)
- Calm technology principles (Weiser & Brown 1995 is the definitive source; widely cited)

**Medium confidence** (principled but PDPP-specific judgment calls):
- The precise Tier 2 threshold for `degraded` (when to surface vs. continue silently)
- The exact staleness window before the stale badge appears vs. stays suppressed
- Whether `cooling_off` should be silent or show a compact badge

**Lower confidence** (depends on owner mental model validation):
- Whether showing stale badge for ChatGPT-draining-silently is the right periphery signal or still too noisy
- Whether Tier 2 `degraded` should send a deferred push notification after N hours

---

## 7. Summary and Design Implications

### The agency-frontier rule
> Involve the human when and only when the system cannot resolve the condition with credentials and access it currently holds, AND inaction will cause permanent data loss or capability loss.

### The silence rule
> Suppress any honest signal if (a) the system is actively handling it, and (b) the owner cannot improve the outcome by acting now. Route suppressed signals to the inspection layer (detail panel), not to /dev/null — they remain truthful and accessible.

### The calm-tech principles
> Default to periphery. Shift to center only for human-required conditions. The right amount of interruption is the minimum needed. Build trust by being right when you do speak, not by speaking often.

### The honesty↔usefulness reconciliation
> Honesty is not maximized by maximum visibility — it is satisfied by "never lie and truth is one layer down." Usefulness requires that the attention layer shows only what the owner can act on. The inspection layer provides full fidelity for engineers and power users. These are two surfaces, not two policies.

### How this changes PDPP's connector-health design

The current implementation already contains most of the right machinery:
- `needs_attention` lifecycle (Tier 3) correctly gates push notifications to actionable attention only.
- `isHealthRelevant()` already filters non-blocking notices from headline state.
- `stale_assisted_refresh` advisory already targets the ChatGPT case as an info-severity (not degrading) condition.
- Attention `pushPayload()` already returns null for `owner_action === "none"` — correctly suppressing non-actionable notifications.

**The gap the prior research missed:** the current dashboard may still surface mechanistic detail (gap counts, scheduler state, retry counts) in the connection row or summary view, where the silence discipline says it should live only in the detail panel. A connection that is `stale` with `next_attempt_at` set should look calm and scheduled — not alarming. The number 2532 should not appear on the dashboard; "syncing, resumes in 3 hours" should.

**The shift:** from "show health accurately" to "show health and only interrupt when the owner is the resolution." The system earns the right to be ignored when it only speaks up about things that genuinely require the owner.

---

## Sources

| Source | URL | Key finding |
|---|---|---|
| Plaid Item Errors | https://plaid.com/docs/errors/item/ | `ITEM_LOGIN_REQUIRED` = only human-required state |
| Plaid Update Mode | https://plaid.com/docs/link/update-mode/ | LOGIN_REPAIRED webhook = explicit "stop nagging" |
| Plaid Webhooks | https://plaid.com/docs/api/items/ | `PENDING_DISCONNECT` = pre-emptive 7-day warning |
| Nango Token Refresh | https://nango.dev/docs/guides/auth/token-refreshing | Silent automatic refresh; failure → webhook only |
| Nango Webhooks | https://docs.nango.dev/guides/platform/webhooks-from-nango | Webhook shape: only terminal outcomes, not mechanism |
| Stripe Capabilities | https://stripe.com/docs/connect/account-capabilities | `eventually_due` / `currently_due` / `past_due` tiering |
| Stripe Verification | https://stripe.com/docs/connect/handling-api-verification | Auto-clear on satisfaction; absence = positive signal |
| Google OAuth | https://developers.google.com/identity/protocols/oauth2/web-server | Silent refresh; human only for revoked trust |
| Temporal Workflows | https://docs.temporal.io/workflows | Runtime health ≠ workflow health; terminal = human |
| Google SRE Book Ch. 6 | https://sre.google/sre-book/monitoring-distributed-systems/ | Five-question alert test; symptom over cause |
| Google SRE Workbook Ch. 5 | https://sre.google/workbook/alerting-on-slos/ | Alert only on meaningful SLO budget consumption |
| Calm Technology (Wiki) | https://en.wikipedia.org/wiki/Calm_technology | Weiser & Brown three principles; periphery default |
| NN/g Progressive Disclosure | https://www.nngroup.com/articles/progressive-disclosure/ | Defer secondary content; match info to task stage |

# Connector Health State UX — Prior-Art Research and PDPP Recommendation

**Date:** 2026-05-15
**Author:** Worker E (research-only)
**Status:** Recommendation for owner review
**Scope:** Pure design research. No code. Produces the canonical taxonomy + UX recommendation for PDPP's connector dashboard health surface.

---

## 0. Why this document exists

PDPP's reference implementation runs a heterogeneous fleet of connectors (Chase, ChatGPT, Reddit, USAA, Gmail, Slack, Codex/Claude local, etc.). Some are clean, some fail every scheduled run, some succeed with gaps. The dashboard today is honest in the database (`run_outcome`, `known_gaps`) but does not yet express health *legibly* to the user.

The narrow trigger was the scheduler back-off case: when a connector has failed N times in a row with the same reason, the scheduler now delays the next attempt. The UI question is "what should the dashboard show?" — but answering that without a coherent state taxonomy guarantees inconsistency the moment the next failure mode appears (rate limiting, consent expiry, broken cookies, runtime crash, etc.).

This research builds the taxonomy from prior art before naming the back-off pill, then circles back to the narrow case.

The handoff doc (§10, §13, §26) and the connector catalog audit are the PDPP-side inputs. Stripe, Linear, Vercel, and Plaid are the prior-art inputs, plus secondary sources (Fivetran, Airbyte, Zapier, Segment, Carbon DS) where they clarified a pattern.

---

## 1. What the four shops do

### 1.1 Stripe — webhook endpoints, Connect accounts

**State taxonomy (webhook endpoints):** binary by storage (`enabled` / `disabled`) but trichotomous by *meaning* — `enabled & healthy`, `enabled & failing`, `auto-disabled`.

- **Enabled & failing**: endpoint is still receiving events but a portion are non-2xx. Visible in the per-endpoint event log as red rows.
- **Auto-disabled**: after ~3 days of continuous failures (in live mode) Stripe disables the endpoint and emails the account owner. The Dashboard shows the endpoint as **Disabled**. Test-mode endpoints disable faster but with the same shape.
- Re-enable affordance: explicit **Enable** button next to the endpoint in `dashboard.stripe.com/account/webhooks`.

**State taxonomy (Stripe Connect accounts):** four named states surface in the Dashboard as a *red banner* with the reason and a link to the resolution path:

| State | Trigger | Resolution path |
|---|---|---|
| `complete` | All required info present, no overdue items | — |
| `pending_verification` | Info submitted, Stripe is reviewing | wait |
| `restricted` | Requirements past_due → charges/payouts may be disabled | `form` / `notice` / `support` / `underwriting_case` |
| `disabled` (terminated) | Risk threshold crossed | formal appeal only |

**Visual treatment:** A persistent red banner across the top of the account when restricted, with a one-line reason ("Identity documentation required") and a deep link into the exact action ("Update business details"). Status itself is communicated by inline pills next to capabilities ("Payouts: enabled / disabled"), not just a global pill. The Dashboard never shows a colour without a paired reason and a paired action.

**Reason surfacing:** Stripe's requirements API exposes `currently_due`, `past_due`, `eventually_due`, `pending_verification` *as separate buckets*. Each requirement carries a `resolution_path` (`form`, `notice`, `support`, `underwriting_case`) that determines the affordance. The Dashboard turns these into a discrete checklist — never "something is wrong, talk to support."

**Affordance:** always inline. For webhooks: **Enable** button. For Connect: "Update business details" CTA directly inside the banner. **Resend** event for an individual failed delivery, but no bulk resend in the UI (CLI only).

**History:** the webhook endpoint detail page shows the most-recent attempts with status codes; not a sparkline, but a tabular log of last N deliveries. Disabled endpoints retain their event log so the user can diagnose.

**Recovery animation:** none observed. Stripe is deliberately undramatic — a state simply flips from `disabled` to `enabled` after the user clicks the button.

**Automation policy:** ~3-day failure window → auto-disable + email. No exponential auto-pause that I can see; it's a hard timer.

**Sources:** [Stripe Docs — Webhooks](https://docs.stripe.com/webhooks), [Handle verification with the API](https://docs.stripe.com/connect/handling-api-verification), [Support — webhook troubleshooting](https://support.stripe.com/questions/troubleshooting-webhook-delivery-issues), [Rally.fan — Stripe account stages](https://rally.fan/blog/stripe-account-closed).

---

### 1.2 Plaid — Item lifecycle (closest analogue to PDPP)

Plaid is the highest-signal reference because they wrap third-party auth like PDPP does. Their Item state machine is explicitly designed around "the user must come back and do something" — exactly PDPP's `manual_action_required`.

**State taxonomy (5 named states):**

| State | Trigger | What user must do |
|---|---|---|
| `HEALTHY` | Default — sync works | — |
| `PENDING_EXPIRATION` (UK/EU) | OAuth consent expires in ≤7 days | Run Link update mode |
| `PENDING_DISCONNECT` (US/CA) | Item scheduled for disconnect in 7 days (`INSTITUTION_MIGRATION`, `INSTITUTION_TOKEN_EXPIRATION`) | Run Link update mode |
| `ITEM_LOGIN_REQUIRED` | Re-auth needed (creds/MFA changed, or consent already expired) | Run Link update mode |
| `ERROR` (other) | `INSTITUTION_DOWN`, `INSTITUTION_NOT_RESPONDING`, `RATE_LIMIT_EXCEEDED`, etc. | Usually wait; sometimes retry |

**Visual treatment:** end-developer-facing rather than end-user-facing — Plaid is B2B2C — but the design discipline shows up in the *webhook contract*:
- `ITEM: ERROR` webhook carries `error_code`, `error_message`, `display_message` (already translated for end users).
- `LOGIN_REPAIRED` fires automatically when the Item exits the bad state without going through your app (because the same user fixed it in another app's Plaid Link). This is profound: the system tells you *to stop nagging the user* when the underlying issue is fixed elsewhere.

**Reason surfacing:** every error has three layers — `error_code` (machine), `error_message` (developer-facing English), `display_message` (end-user-facing copy that Plaid has already vetted). The dashboard / your app is supposed to show `display_message` directly. This is the gold standard of "machine reason → human reason."

**Affordance:** one canonical recovery affordance — **Link update mode** — a re-launch of the consent flow scoped to the specific Item. Not full reconnect: if the user's OTP expired, Plaid will only ask for a new OTP. Granular recovery.

**History/streak:** N/A in the consumer surface; Plaid exposes per-Item consent_expiration_time and the per-product `last_successful_update` field, but does not show streaks.

**Recovery animation:** the `LOGIN_REPAIRED` webhook *itself* is the recovery primitive. The expected UX in the host app is: "Your bank connection was just repaired. We're refreshing your data now." then the alert vanishes.

**Automation policy:**
- The 7-day warning window (`PENDING_DISCONNECT` / `PENDING_EXPIRATION`) is the celebrated insight — the system warns before it breaks, not just after.
- Plaid does *not* auto-retry blindly during `ITEM_LOGIN_REQUIRED`; it stops syncing and waits for the user. This is exactly the right behaviour for an auth-failure shape.
- When the Item exits the error state, the next sync covers all data missed during the outage — i.e. recovery includes catch-up.

**Sources:** [Plaid Docs — Item Errors](https://plaid.com/docs/errors/item/), [Plaid Docs — Link Update Mode](https://plaid.com/docs/link/update-mode/), [Plaid Docs — Webhooks](https://plaid.com/docs/api/webhooks/), [Plaid Docs — Launch Checklist](https://plaid.com/docs/launch-checklist/), [Plaid Docs — OAuth Guide](https://plaid.com/docs/link/oauth/).

---

### 1.3 Linear — integrations as first-class workspace settings

**State taxonomy:** Linear's surface is sparser than Plaid's — fundamentally **`connected` / `disconnected`** with sub-reasons. The depth lives in their changelog, which reveals operational reality:

- Silent connection errors used to be the failure mode; the changelog notes "fixed silent integration connection errors for GitHub, so a proper error now displays."
- "Reconnect a GitHub organization would fail if a different user than the original integration creator performed the reconnect" — i.e. they ran into ownership-of-the-integration problems.
- The "Reconnect" copy in Slack settings was renamed to "Update connection" because *the integration was still connected* — the old copy implied a worse state than reality. Naming discipline matters.

**Visual treatment:** integration tiles in `Settings → Integrations`. Each tile shows the integration name, an enable/disable toggle, and a "Configure" or "Reconnect" button when applicable. There is no fancy badge — it's a plain settings page with the connected-or-not signal carried by the configure/reconnect button itself.

**Reason surfacing:** when known, surfaced as a banner on the integration page — historically Linear's failure was *silent* errors, which they explicitly fixed.

**Affordance:** **Reconnect** (or "Update connection" when the integration is healthy but needs OAuth refresh) — single named action. For broken integrations like a deleted Slack channel binding, the user has to manually re-add the bot to the channels.

**History/streak:** none. Linear treats integrations as configuration, not as ongoing data pipes — their model assumes the integration either works or it doesn't, with no concept of "degraded."

**Recovery animation:** none observed.

**Automation policy:** Linear apparently auto-disconnects workspaces under unspecified conditions (e.g., the Plain–Linear incident in April 2026 where integrations were "automatically disconnected from certain workspaces"). The lesson: auto-disconnect without UI explanation is a footgun.

**The naming insight is the headline take-away from Linear:** "Reconnect" vs "Update connection" — only use the harsher word when the integration is *actually broken*. Soft refresh actions should not look like emergencies.

**Sources:** [Linear Changelog](https://linear.app/changelog), [Linear Docs — Slack](https://linear.app/docs/slack), [Linear Docs — Sentry](https://linear.app/docs/sentry), [IsDown — Plain Linear incident](https://isdown.app/status/plain/incidents/575855-linear-integrations-are-being-disconnected).

---

### 1.4 Vercel — Git integrations and deployments

**State taxonomy (deployments):** 7 named status events emitted from the platform — `pending`, `building`, `ready` (= `success`), `error` (= `failed`), `canceled`, `ignored`, `skipped`, plus `promoted`. The Dashboard collapses these into 4 visible states on a deployment row:

| State | Pill colour (observed) | Meaning |
|---|---|---|
| Ready | green | Live + reachable |
| Error | red | Build or runtime failure |
| Building | blue / animated | In flight |
| Canceled | grey | Superseded or aborted |

**State taxonomy (Git integration itself):** binary — connected or not. The integration breaking is detected indirectly: commits stop triggering deployments. The Dashboard does *not* prominently surface a "Git integration broken" pill; the user has to notice that commits in the last 24h have no checks.

**Visual treatment (deployments):** colour-coded chip next to each deployment, plus the project-level "Production" status is the colour of the latest production deployment.

**Visual treatment (Git integration broken):** this is the weak spot — Vercel rates worse than Plaid here. The user must navigate to `Settings → Git` to discover the integration is missing, then go to GitHub's *own* Settings → Integrations to see if the Vercel App was uninstalled. This is the **silent failure** anti-pattern Linear specifically called out and fixed.

**Reason surfacing:** for deployments, Vercel shows the build log inline with the deployment row — the failure reason is one click away. For Git integration breakage, the reason is essentially undiscoverable from the Vercel side; the user has to triangulate.

**Affordance:** **Redeploy without cache** for an erroring deployment, **Redeploy** on any historical deployment, **Promote** to flip a previous good deployment back to production (instant rollback). For Git: disconnect + reconnect via Settings.

**History/streak:** the Deployments table *is* the history. No sparkline, but each row carries timestamp, branch, commit, status — visually scannable.

**Recovery animation:** instant rollback is the headline — the marketing argument is "click Promote and your previous good deployment is live before the page refreshes." Recovery is dramatized in the right way.

**Automation policy:** auto-cancel of in-flight builds when a newer commit arrives on the same branch. No auto-back-off for failing deployments — every push tries.

**The Vercel headline take-away:** **rollback is a first-class affordance**. When something breaks, you don't fix the broken thing first; you flip back to the last known good one. PDPP can borrow this *for record state* (e.g., "you can keep querying the data from the last successful sync while we wait for you to reconnect") — see §3.

**Sources:** [Vercel — Deploying GitHub Projects](https://vercel.com/docs/git/vercel-for-github), [Vercel KB — Why aren't commits triggering deployments](https://vercel.com/kb/guide/why-aren-t-commits-triggering-deployments-on-vercel), [Vercel — Error List](https://vercel.com/docs/errors/error-list), [Vercel Community — not syncing latest commit](https://community.vercel.com/t/vercel-not-syncing-latest-github-commit-environment-variable/15283).

---

## 2. Secondary references (briefly)

**Fivetran** — closest direct analogue to PDPP because it is *a connector fleet dashboard*. They use three setup states (`incomplete`, `connected`, `broken`) plus an orthogonal `paused` boolean plus sync state (`scheduled`, etc.). Alerts are split into **Errors (red icon)** = blocks syncing, **Warnings (yellow icon)** = does not block. Their explicit rule: an Error is auto-resolved when the next successful sync happens — no manual "mark as fixed." This matches the Plaid `LOGIN_REPAIRED` discipline. ([Fivetran — Alerts](https://fivetran.com/docs/using-fivetran/fivetran-dashboard/alerts))

**Airbyte** — used colour-mapping for sync status as their first pass: green for "Pending / Running / Succeeded / Cancelled / Incomplete", grey for inactive connection, red for Failed. The lumping of `Incomplete` into green is the bug-of-record — incomplete should not look like success. PDPP must avoid this anti-pattern. ([Airbyte #2426](https://github.com/airbytehq/airbyte/issues/2426))

**Zapier** — three-tier error taxonomy: **Stopped** (Zap turned off after repeated failures), **Errored** (one run failed, Zap still active), **Held** (paused awaiting review). The user-research insight is that trigger-level errors *don't appear in task history at all* because the failure happens before the Zap run is created. Zaps can be paused while the dashboard says "no errors." PDPP must surface back-off / auto-pause as a *first-class state*, not as the absence of recent runs. ([OrderSync Pro — Zapier troubleshooting](https://getordersyncpro.com/blogs/zapier-zap-failures-troubleshooting))

**Segment** — uses two surfaces: per-source/destination tiles for *configuration* health, and a separate **Event Delivery** dashboard for *flow* health. Splits the question "is the connection set up correctly?" from "is data actually flowing?" — relevant for PDPP because a connector can be authenticated and configured but still produce gaps. ([Segment — Delivery Overview](https://segment.com/docs/connections/delivery-overview/))

**Carbon Design System** — gives the visual semantic vocabulary: "critical instability" (caution) vs. "process failure that needs immediate attention" (red) vs. "informational" — useful for picking which states deserve red vs. amber. ([Carbon DS — Status indicator pattern](https://carbondesignsystem.com/patterns/status-indicator-pattern/))

**The Trevor Calabro "Bad Status Design" critique** (substack) — the most important warning: "a table full of badges, timestamps, and vague labels does not automatically [improve UX]. In a lot of cases, it just relocates the confusion." A pill must always be paired with cause, time-of-failure, and next-action. PDPP cannot just decorate the dashboard with coloured pills; the pill is the entry point, not the answer. ([Trevor Calabro — Fixing Bad Status Design](https://trevorcalabro.substack.com/p/fixing-bad-status-design))

---

## 3. Synthesis — what the prior art collectively says

Stripe, Plaid, Linear, Vercel, Fivetran, and Zapier converge on six principles:

1. **Auth-failure and runtime-failure are different states.** Plaid splits `ITEM_LOGIN_REQUIRED` (user must act) from generic `ERROR` (Plaid retries, user does nothing). Stripe splits webhook auto-disable (action needed) from Connect restriction (different action needed). Conflating these confuses users.

2. **Every state owns one named affordance.** Plaid: Update mode. Stripe webhook: Enable. Stripe Connect: Update business details. Linear: Reconnect / Update connection. Vercel: Redeploy / Promote. Never "fix this somehow"; always a verb on a button.

3. **`display_message` exists.** Plaid's three-layer model (machine code → developer English → end-user English) is universal best practice. PDPP already produces structured assistance events (§13); it must commit to a vetted end-user copy layer.

4. **Warn before you break, when possible.** Plaid's 7-day `PENDING_DISCONNECT` window is the gold-plate example. If PDPP knows a cookie or OAuth grant is approaching expiry, surface a warning *before* the next sync fails.

5. **Recovery is a state transition, not a button click.** The system should detect recovery and update the UI without the user touching anything when possible (Plaid `LOGIN_REPAIRED`; Fivetran auto-resolves errors on next successful sync). Manual "I fixed it, mark as fixed" buttons are an anti-pattern.

6. **History should be lightweight at the card level, full at the detail level.** Stripe shows the last N webhook attempts. Vercel's deployment list *is* the history. None of them put sparklines on the card; sparklines are a dashboard-summary affordance, not a per-row affordance.

These six principles are not negotiable for PDPP.

---

## 4. Recommended state taxonomy for PDPP

### 4.1 Six states

After comparing Stripe (4 visible), Plaid (5 explicit), Vercel (4), Fivetran (3 + paused boolean), and Zapier (3), the right count for PDPP is **six**. Fewer leaves no room for the gap-honest case (which PDPP uniquely needs). More is over-engineering — Stripe shipped four for a reason.

| State | Pill colour | Pill word | Meaning |
|---|---|---|---|
| `healthy` | green | "Connected" | Last run completed cleanly, no overdue work |
| `degraded` | amber | "Partial" | Last run was `succeeded_with_gaps`; data is flowing but with known gaps |
| `needs_attention` | amber + icon | "Sign in needed" / "Approve in app" | Manual action required (assistance event raised); user must do something to unblock |
| `cooling_off` | amber + clock icon | "Paused — retrying soon" | Scheduler back-off active after N consecutive failures with same reason |
| `blocked` | red | "Disconnected" | Auto-paused after sustained failure or persistent auth failure; system stopped trying |
| `idle` | grey | "Not yet run" | Never run or never authenticated; not an error — just nothing has happened |

`healthy` and `degraded` are run-outcome-driven; `needs_attention`, `cooling_off`, `blocked` are scheduler/runtime-driven; `idle` is the empty state.

There is no `running` / `syncing` pill at the card level — running is communicated by a small spinner next to the connector name or a "running now" badge that lives independently of the health pill. Conflating "currently working" with health is the Airbyte mistake.

### 4.2 ASCII state diagram

```
                              ┌───────────┐
                       (never ran)        │
                       ┌──────►   idle    │
                       │      └─────┬─────┘
                       │            │ (first authenticated run starts)
                       │            ▼
                       │      ┌───────────┐
                       │      │  healthy  │◄──────────────┐
                       │      └─────┬─────┘               │ (next clean run)
                       │            │                     │
            ┌──────────┤            │ (run finishes)      │
            │          │            ▼                     │
            │          │      ┌───────────┐               │
            │          │      │           │───────────────┤
            │          │      │ degraded  │ (next run     │
            │          │      │           │  is clean)    │
            │          │      └─────┬─────┘               │
            │          │            │                     │
            │          │            │ (run hits assistance│
            │          │            ▼ boundary or auth    │
            │          │      ┌───────────┐ failure)      │
            │ (user    │      │   needs_  │               │
            │ revokes/ │      │ attention │───────────────┤
            │ deletes) │      └─────┬─────┘ (user         │
            │          │            │ completes action,   │
            │          │            │ next run clean)     │
            │          │            │                     │
            │          │   (user ignores; N consecutive   │
            │          │    same-reason failures)         │
            │          │            ▼                     │
            │          │      ┌───────────┐               │
            │          │      │  cooling_ │───────────────┘
            │          │      │    off    │ (next attempt
            │          │      └─────┬─────┘  succeeds)
            │          │            │
            │          │            │ (back-off ceiling reached;
            │          │            │  scheduler gives up)
            │          │            ▼
            │          │      ┌───────────┐
            │          │      │  blocked  │
            │          │      └─────┬─────┘
            │          │            │
            │          │            │ (user reconnects /
            │          │            │  resumes manually)
            │          │            │
            │          └────────────┘
            └──────────────────────────────► (back to idle)
```

### 4.3 Transitions worth celebrating

- `needs_attention → healthy` after the user completes assistance and the next run lands cleanly. Show a one-shot "Reconnected — catching up on missed data" toast (mirrors Plaid `LOGIN_REPAIRED`). Same for `cooling_off → healthy` and `blocked → healthy`.
- `idle → healthy` on first successful run. One-shot "First sync complete — N records imported."
- Do not animate `healthy → healthy`. Most state transitions on this dashboard should be visually quiet.

### 4.4 Entry/exit conditions table

| State | Enters from | Enters because | Exits to | Exits because |
|---|---|---|---|---|
| `idle` | (initial) or `blocked` | Never authenticated, or connector was reset | `healthy` / `needs_attention` | First run starts |
| `healthy` | `idle`, `degraded`, `needs_attention`, `cooling_off`, `blocked` | Run completed with `run.completed` and no `known_gaps` | `degraded` / `needs_attention` / `cooling_off` / `blocked` | Next run produces gaps, asks for help, or fails |
| `degraded` | `healthy` | Run completed with `known_gaps` but emitted records | `healthy` | Next run clean — gaps resolved |
| | | | `needs_attention` / `cooling_off` / `blocked` | Next run fails harder |
| `needs_attention` | `healthy`, `degraded`, `cooling_off` | Run emitted a structured assistance event (`manual_action_required`, `interaction_required`) | `healthy` / `degraded` | User completes action and next run succeeds |
| | | | `cooling_off` | User ignores; same assistance event raised N times |
| `cooling_off` | `needs_attention`, `degraded`, `healthy` | Same failure reason repeated K consecutive times; scheduler delays next attempt | `healthy` / `degraded` / `needs_attention` | Next attempt succeeds or surfaces new assistance |
| | | | `blocked` | Back-off ceiling reached (e.g., 24h+ delay) |
| `blocked` | `cooling_off` | Scheduler hit the ceiling; system has stopped scheduling automatic attempts | `healthy` / `degraded` / `needs_attention` | User manually triggers run and it succeeds, or reconnects |
| | | | `idle` | User revokes / removes the connector |

---

## 5. Per-state design notes

### 5.1 `healthy`

**Means in PDPP terms:** the most recent `run.completed` event had no `known_gaps`, the schedule is enabled, and the next run is within the expected cadence window.

**Card shows:** connector logo, name, green dot or "Connected" pill, secondary line `Last sync 2 min ago · 47 records`. No primary CTA. Hover/expand shows "Run now" as a *secondary* action.

**Timeline shows:** the recent runs as small successful nodes. No banner. This is the quiet state.

**Spine events:** `run.started`, `run.completed`, `records.emitted` — nothing health-specific.

**Override semantics:** owner can force `run-now`, can pause the schedule (transitions to `idle`-like state but with `paused: true` annotation — see §7 reconciliation), can force `resync` (full historical re-sweep).

---

### 5.2 `degraded`

**Means in PDPP terms:** `run.completed` with `known_gaps[]` non-empty. Records *did* flow, but some streams or fields could not be collected. This is the Chase `succeeded_with_gaps` case, and the Slack `not_available` streams case.

**Card shows:** amber dot, pill "Partial", secondary line `Last sync 2 min ago · 6 streams ok · 1 gap`. CTA "See what's missing" → opens the gap detail panel.

**Timeline shows:** a small amber marker on the last run with `known_gaps` summarized inline. Each gap is itself a row with `stream`, `reason_code`, `retryable`, `last_attempt`.

**Spine events:** `run.completed` with `known_gaps[]`; gaps that come and go between runs are visible because `degraded` is recomputed each run.

**Override semantics:** owner can force `run-now` (will re-attempt all streams), can mark a specific gap `unavailable_by_design` (suppresses it from the count but keeps it in the audit log — see §3 of the connector catalog audit, Slack `not_available` streams).

**Critical:** `degraded` is *not* a warning. It is the honest, designed-for state for connectors like Chase and Slack. Treat it as a working-as-intended state with a side note, not as a problem.

---

### 5.3 `needs_attention`

**Means in PDPP terms:** the connector raised a structured assistance event during a run (`manual_action_required`, `interaction_required`, `cloudflare_challenge`, OAuth re-consent, OTP needed, push notification approval pending). The run is paused waiting for the user; the scheduler is *not* attempting again until the user acts or the assistance window times out.

**Card shows:** amber dot with subtle pulse animation (this is the only animated state — earns attention), pill copy varies by reason: **"Sign in needed"** (auth re-consent), **"Approve in app"** (push 2FA), **"Code needed"** (OTP), **"Verify in browser"** (Cloudflare challenge). Secondary line: `Started at 14:32 · waiting for you · expires in 4m`. Primary CTA: **"Open assistant"** (deep link to the remote surface / push notification surface / OTP entry surface — whichever the assistance event names).

**Timeline shows:** the assistance event as a distinct yellow-pill row with the structured fields: what is blocking, where to act, whether the runtime can auto-detect completion, what timeout applies, what will be persisted (this list comes directly from handoff §13).

**Spine events:** `assistance.requested` (with `reason`, `surface`, `timeout`, `auto_detect`), `assistance.completed` or `assistance.timed_out` or `assistance.cancelled`.

**Override semantics:** owner can **dismiss** the assistance (cancels the run with a `cancelled_by_user` outcome), can **extend timeout**, can **switch surface** if multiple are available (e.g., desktop vs. mobile). Cannot `run-now` while assistance is open — that just re-arms the same assistance.

**The naming insight from Linear applies here:** "Sign in needed" not "Authentication required." "Approve in app" not "MFA pending." End-user copy, not protocol copy.

---

### 5.4 `cooling_off`

**Means in PDPP terms:** the scheduler has detected `K` consecutive runs failing with the *same* reason code (Reddit's 12 consecutive `reddit_login_unexpected_ui`, ChatGPT's repeated Cloudflare), and it is delaying the next scheduled attempt according to a back-off curve. The connector is *not* blocked — the next attempt is scheduled, just further in the future than the normal cadence.

This is the state that does not exist in Plaid's vocabulary but *should* — Plaid stops scheduling entirely on `ITEM_LOGIN_REQUIRED`, which works for them because Plaid is event-driven (the user comes back to your app and you trigger update mode then). PDPP is schedule-driven, so we need a state that says "we noticed it's broken, we're trying less often, here's when we'll try next."

**Card shows:** amber dot (same colour as `needs_attention` and `degraded` — see §6 colour discipline), clock icon, pill copy **"Paused — retrying in 32m"** (always a duration, never just "Paused"). Secondary line: `12 attempts since last success · same reason each time · last attempt 14m ago`. Primary CTA: **"Try now"** — bypasses the back-off and forces an immediate attempt. Secondary affordance: **"What's wrong?"** → opens a detail panel with the streak of failed runs and the shared reason.

**Timeline shows:** the failed runs as small red markers and a single banner span above them labelled "Auto-paused after 5 consecutive failures of `reddit_login_unexpected_ui`. Next retry scheduled for 15:04." If the user clicks "Try now" and that also fails, the streak extends and the next back-off slot extends. If the user fixes the underlying issue (e.g., Reddit's CAPTCHA passes) and a `run.completed` lands, the timeline shows the recovery clearly.

**Spine events:** `schedule.back_off.started` (with `reason_code`, `consecutive_failures`, `next_attempt_at`), `schedule.back_off.extended`, `schedule.back_off.cleared`.

**Override semantics:** owner can **try now** (forces an immediate run; if it fails, the back-off extends), can **change schedule** (sets a different cadence), can **reset back-off** (zeros the streak counter without running — useful if the owner believes the upstream issue is fixed and wants to resume normal cadence).

**The key copy decision:** the pill says "Paused — retrying in 32m" because:
- "Paused" alone is what Linear, Stripe, Fivetran all use, so users recognize it.
- "— retrying in 32m" prevents the Zapier failure mode where users think the connector is dead when actually the system just hasn't tried recently. Always show the next-attempt-at duration.
- *Not* "Auto-paused" because that sounds permanent. Not "Backed off" because that's jargon. Not "Throttled" because that implies the upstream rate-limited us specifically.

---

### 5.5 `blocked`

**Means in PDPP terms:** either the scheduler back-off has reached its ceiling (e.g., 24h delay slot crossed and still failing) and the system has stopped auto-scheduling, OR a hard fatal error has occurred (revoked credentials, deleted account, manifest mismatch). The connector is dormant; nothing will run unless the owner acts.

This is `cooling_off`'s terminal state. The `cooling_off → blocked` transition is the analogue of Stripe's auto-disable.

**Card shows:** red dot, pill **"Disconnected"** or **"Stopped"**, secondary line `Stopped retrying at 02:14 · 47 attempts failed with reddit_login_unexpected_ui`. Primary CTA: **"Reconnect"** (re-runs the auth/consent path) or **"Try again"** (one-shot manual retry; if it succeeds, transition back to `healthy`). Hover shows last successful sync timestamp — borrows from Vercel's instant-rollback ethos: "Your data from May 12 is still queryable. Reconnecting will refresh it."

**Timeline shows:** the `schedule.gave_up` event as a clear terminal marker with the full streak history collapsed behind a "Show 47 attempts" expander. Records collected *before* the streak began remain queryable and the dashboard says so.

**Spine events:** `schedule.gave_up` (with `final_reason_code`, `total_consecutive_failures`, `last_success_at`).

**Override semantics:** owner can **reconnect** (re-runs OAuth / re-authenticates), can **delete** (transitions to `idle`), can **try again** (one-shot manual run — if it succeeds, jump to `healthy`).

**Note on data retention during `blocked`:** the previously-collected records remain queryable. This is the Vercel "instant rollback" lesson — the user is not punished for the connector being broken by losing access to historical data.

---

### 5.6 `idle`

**Means in PDPP terms:** the connector has never run successfully, OR the owner has explicitly paused the schedule, OR the connector has been deleted from the catalog but is shown here as a discoverability surface. This is the empty state.

**Card shows:** grey dot, pill **"Not connected"** (for never-authenticated) or **"Schedule paused"** (for owner-paused). Secondary line: `Never connected` or `Paused on May 12 by you`. Primary CTA: **"Connect"** (first-time auth) or **"Resume schedule"**.

**Timeline shows:** the connector card with an empty timeline and a "Connect to start collecting" placeholder.

**Spine events:** `schedule.paused`, `schedule.resumed`, `connector.deleted`.

**Override semantics:** the only state where the affordance is *positive* (Connect) rather than corrective.

---

## 6. Visual and copy discipline (cross-state)

### 6.1 Colour discipline

Carbon DS gives the right vocabulary: there are three semantic tiers (green / amber / red), and *six states must compress into three colours*. The mapping:

- **Green:** `healthy`
- **Amber:** `degraded`, `needs_attention`, `cooling_off` — all "something the user might want to address, but data is still queryable / the system is still trying"
- **Red:** `blocked`
- **Grey:** `idle` (neutral, not bad)

Three amber states sharing colour is fine because each carries a distinct *icon* and *pill word*. Colour-blind users can tell them apart by shape and copy. This is the Carbon DS rule: at least two of {colour, shape, symbol}. PDPP gets all three.

### 6.2 Icon discipline

- `healthy` — small filled green dot, no icon
- `degraded` — amber dot + tiny "•••" or small bar-with-gap icon ("partial")
- `needs_attention` — amber dot + key icon (or person-silhouette) and a subtle pulse animation (the *only* animated state)
- `cooling_off` — amber dot + clock icon
- `blocked` — red dot + plug-disconnected icon or "stop" icon
- `idle` — grey dot, no icon

### 6.3 Copy discipline (the `display_message` layer)

Borrowing Plaid: every state must have an end-user-vetted display string. Never expose `reason_code` raw. Examples PDPP needs from day one (these come straight from the catalog audit):

| Internal reason code | End-user display |
|---|---|
| `reddit_login_unexpected_ui` | "Reddit is asking for extra verification" |
| `chatgpt_login_unexpected_ui` | "ChatGPT needs you to sign in again" |
| `cloudflare_challenge` | "Cloudflare is checking it's really you" |
| `manual_action_required` (OTP) | "Enter the code from your bank" |
| `manual_action_required` (push) | "Approve the request on your phone" |
| `succeeded_with_gaps` (downloads) | "Some files couldn't be downloaded" |
| `succeeded_with_gaps` (Slack not_available) | "Some Slack data isn't available through the archive" |
| `controller_restarted` | "We restarted in the middle — we'll try again" (NB: this is a system artifact, not a connector bug, per Worker D verdict 2026-05-15) |
| `consent_expiring_soon` | "Your sign-in will expire in 7 days" |

The codes themselves must remain in the spine and the timeline detail view for engineers and the protocol-honesty bar. They just never appear as primary copy.

### 6.4 The Trevor Calabro test

Every pill must answer all four of these without the user clicking:

1. **What's the state?** (the pill word)
2. **Why?** (the secondary line, in display copy)
3. **When did it change?** (relative time on the secondary line)
4. **What can I do?** (the CTA button or "no action needed")

If any pill answers fewer than four, redesign the pill.

---

## 7. The specific back-off pill UX (the narrow case)

This is the question that triggered the research: **"What should the dashboard show when a connector has failed N times in a row with the same reason and the scheduler is delaying the next attempt?"**

**The pill:** amber background, clock icon, copy **"Paused — retrying in 32m"**. The duration is always present and updates as the next-attempt-at approaches.

**The secondary line (always shown directly below the pill on the card):**
> `12 attempts in a row failed with the same problem. Last try 14m ago.`

That sentence comes from the catalog audit findings (Reddit's 12 consecutive failures, ChatGPT trending the same way). It is intentionally not technical — but the underlying reason code is one click away in the "What's wrong?" expander.

**Reason copy (the expander):**
> "Reddit is asking for extra verification (`reddit_login_unexpected_ui`). This usually means signing in again. Connect Reddit to fix it, or click Try now to retry without changes."

This carries:
- end-user display message
- machine reason code in `monospace` (parenthetical, engineer-readable)
- two concrete affordances

**"Try now" affordance:**

A primary button labelled exactly **"Try now"**. Clicking it:
- Bypasses the next-attempt-at slot, runs the connector immediately.
- If the immediate run succeeds → transition to `healthy` with the "Reconnected — catching up" toast.
- If the immediate run fails → streak count increments, back-off extends to the next slot, pill duration recomputes. The button does *not* grey out.
- Allow up to 3 "Try now" presses per back-off cycle, then disable for the rest of the cycle to prevent thrash. (Empirical guess; revisit in §8.)

This affordance is the single most important UX choice in this surface. Without it, `cooling_off` reads as "the system has given up" — with it, it reads as "the system is trying less often, but you can override." That difference is the difference between user agency and helplessness.

**Sparkline / streak indicator decision:**

**Do not put a sparkline on the connector card.** Reasoning:

1. PatternFly explicitly recommends sparklines only when card width allows; PDPP's cards are constrained (catalog has 14 visible connectors).
2. A sparkline of the last 12 runs of Reddit would be a solid red bar — not informative.
3. Stripe's webhook UI does not use sparklines for endpoint health; they use a tabular log. Right call.
4. Vercel uses the deployment table itself as the history surface, not sparklines.

**Instead, show a numeric streak counter** on the secondary line: `12 attempts in a row failed`. This carries the streak in one English clause. The visual streak (red bars) is reserved for the *expanded timeline detail* — which is where engineers and curious owners will look.

**Empty-state when never-failed:**

In `healthy`, `degraded`, and `idle`, no streak counter is shown. The secondary line is just `Last sync 2m ago · 47 records` or `Never connected`. Streak counters appearing only on bad states is the same pattern Stripe uses (failure count is invisible until there's a failure).

**Reconciliation with Plaid:**

Does Plaid's `ITEM_LOGIN_REQUIRED` + webhook model map onto our `needs_attention` + `cooling_off`?

**Largely yes, with one structural divergence:**

| Plaid concept | PDPP concept | Map? |
|---|---|---|
| `ITEM_LOGIN_REQUIRED` (Item in bad state, user must re-auth) | `needs_attention` (assistance event raised) | Yes |
| `PENDING_DISCONNECT` / `PENDING_EXPIRATION` (7-day warning) | (gap; PDPP doesn't have a "consent will expire soon" warning state today) | **No — open** |
| `ERROR` (transient e.g. `INSTITUTION_DOWN`) | `cooling_off` (transient failure with back-off) | Partial. Plaid retries quietly; PDPP exposes the back-off explicitly. |
| `LOGIN_REPAIRED` (webhook fired when fixed elsewhere) | `cooling_off → healthy` transition + toast | Yes |
| Plaid stops syncing on `ITEM_LOGIN_REQUIRED` | PDPP stops *scheduling new runs* on `needs_attention` | Yes |

**The structural divergence:** Plaid is **event-driven** — they wait for the user to next visit your app, then you call Link in update mode. PDPP is **schedule-driven** — the system keeps trying, just slower, and the dashboard is the surface for the user to come back to. This is why PDPP *needs* a `cooling_off` state that Plaid doesn't (Plaid's `ITEM_LOGIN_REQUIRED` is permanent until update mode runs; ours is degrading-cadence until user acts or back-off ceiling hits).

The 7-day warning insight from Plaid (`PENDING_DISCONNECT`) is the one thing PDPP should adopt that the current design doesn't have. Logged as future follow-up §8.

---

## 8. Decision log (judgment calls explicit)

1. **Six states, not five.** Considered collapsing `cooling_off` into `needs_attention`. Rejected because the affordances differ — `needs_attention` says "you must do something or we will stop trying" and `cooling_off` says "we're trying less often but still trying." Distinct user agency.

2. **`degraded` is amber, not green.** Airbyte lumped `Incomplete` into green; that's wrong. The Chase `succeeded_with_gaps` case has *records flowing* but the run was not clean — amber communicates that honestly. Green is reserved for clean runs.

3. **No sparkline on cards.** Justified in §7. Reserve sparklines for engineer/operator views (the eventual operations dashboard for the protocol team, not the user dashboard).

4. **"Try now" is unlimited within a cycle but capped at 3 per back-off slot.** Picked 3 as a guess based on no prior art. Worth empirical tuning; the reasoning is "enough for an impatient owner during a real outage, not so many that they can hammer the upstream service." Logged for future tuning.

5. **No `running` state at the pill level.** Running is communicated by a separate spinner/badge. Conflating run-in-progress with health is the Airbyte mistake.

6. **`idle` is grey, not a colour-of-concern.** A never-connected connector is not a problem — it's just an empty state. Grey is the right semantic.

7. **One canonical recovery affordance per state.** Borrowed from Plaid + Linear. Resisted the temptation to show "Reconnect" *and* "Pause" *and* "Try now" *and* "Open logs" on the same card. Pick one primary action; everything else lives behind a kebab menu or in the detail panel.

8. **Animated pulse only on `needs_attention`.** It is the only state where the user is actively blocking progress and the system needs the user to look. Stripe's red banner is the equivalent "earn attention" affordance. Everything else should be visually quiet.

9. **Did not introduce a `degraded_consent` state for 7-day warnings.** Wanted to keep state count at 6. Instead, the warning would surface as an additional banner *within* the `healthy` card (because the connector is still working today, it just won't be in a week). Equivalent to how Stripe Connect shows a red banner above an otherwise-functional account. Logged as future enhancement.

10. **Recovery toasts are one-shot and dismissable.** Tempted to make `needs_attention → healthy` a persistent "Reconnected" badge for 24h. Decided against — a recovery should be celebrated briefly and then disappear, not haunt the dashboard. Plaid does the same: `LOGIN_REPAIRED` is a webhook, not a sticky state.

---

## 9. Reconciliation with Worker C (read last)

*The following section was written after the rest of this document, per the brief's instruction.*

After reading `tmp/workstreams/worker-c-scheduler-backoff-report.md`:

**Alignments (stronger than I expected before reading):**

- Worker C produces `{ backoffApplied, consecutiveFailures, effectiveIntervalMs, nextRunAt, reasonClass }` from a pure helper. Those five fields are *exactly* what the `cooling_off` pill needs: `consecutiveFailures` drives the secondary-line counter ("12 attempts in a row failed"), `nextRunAt` drives the pill duration ("retrying in 32m"), `reasonClass` drives the reason-copy expander.
- Worker C's "same reason class breaks the streak; success resets it" rule maps cleanly onto the user-facing "in a row failed with the *same* problem" copy. The classifier already prefers `connector_error.reason` (which carries Reddit's `reddit_login_unexpected_ui`), then falls back to terminal reason, then `failure:unknown`. This is the right level of granularity.
- Worker C emits exactly **one** `skipped` `RunRecord` per failure streak with text `"scheduler_backoff_applied: <N> consecutive <reasonClass> failures; next attempt at <ISO>"`. That record is persisted and surfaces via `onRunComplete` — i.e. the dashboard already has a deterministic event to render the `cooling_off` banner from. No new spine event is required for the MVP.
- Manual run-now goes through `controller.ts::runNow`, which **already bypasses** the scheduler entirely (Worker C confirms this and treats it as a feature, not a gap). The "Try now" button therefore works in the recommended UX *without* any code change — it just calls the existing manual run path, and a successful run will reset the streak naturally.
- The 24h absolute `maxBackoffMs` cap means `cooling_off` will eventually plateau at "retrying in 24h" rather than blowing up to days. Aligns with the §5.4 design that says the duration is always finite and visible.

**Divergences / gaps that the data model would benefit from for the full recommended UX:**

1. **No distinct `cooling_off → blocked` transition.** Worker C's back-off is uncapped in terms of streak length; the curve just plateaus at the 24h ceiling. There is no `schedule.gave_up` terminal event. The recommended UX has a `blocked` red-pill state for "the system has stopped retrying," which under Worker C's current behaviour would never actually happen for connectors with active schedules — back-off continues indefinitely at 24h intervals. **Decision needed:** either keep `cooling_off` perpetual and demote `blocked` to "user manually paused / revoked credentials / no schedule" (simpler), or add a streak ceiling that flips the connector to `blocked` after K days of unbroken back-off (more honest). I lean toward the latter — a connector that has been back-off-skipping for a week is dead in practical terms and should be loudly marked so. **Future follow-up.**

2. **No distinct "back-off cleared" event for recovery toasts.** Worker C resets the streak counter when a `succeeded` run lands but does not emit a distinct event saying "streak just broke." The one-shot recovery toast ("Reconnected — catching up on missed data") needs *something* to fire on. The cheap option: the dashboard computes the transition by observing that the previous tick had `backoffApplied: true` and the current tick has `consecutiveFailures: 0`. That works for the MVP without any runtime change. Logged as nice-to-have, not a blocker. **Future follow-up.**

3. **"Try now" failure semantics during an active cool-down.** Worker C confirms manual runs go through `controller.ts::runNow` and bypass the back-off scheduler. But the design question is: if the user clicks "Try now" during an active back-off and the immediate run *fails*, does that failure extend the back-off, or is it a free retry? Reading Worker C closely: the manual run will append a new `RunRecord` to history with the same `connector_error.reason`, which the back-off helper *will* see on the next scheduled tick — so the streak count grows by one and the back-off curve gets steeper. **This is the right behaviour technically but the dashboard copy must reflect it:** "Try now" failing should update the streak count and the next-attempt duration. The §7 design already assumes this; no code gap.

4. **No cap-per-back-off-slot on "Try now" presses.** §8 decision 4 proposes soft-capping manual retries at 3 per slot. Worker C does not enforce this. The dashboard can implement this client-side as a debounce — not a runtime concern. **Logged as UI-only.**

5. **"Reset back-off without running" affordance.** §5.4 proposes a "reset streak counter" override. Worker C does not expose this directly, but it is computable: any `succeeded` `RunRecord` in the trailing window resets the streak. So "reset back-off" could be implemented as either (a) inserting a synthetic `succeeded` row (data dishonesty — bad) or (b) a new "force resume" controller endpoint that clears the in-memory `announcedBackoffClass` and forces the next scheduled tick to re-evaluate without the back-off (clean). **Future follow-up.**

6. **`announcedBackoffClass` is in-memory only.** Worker C flags this as acceptable; for the UI it matters because *if the server restarts mid-streak, a duplicate back-off skip RunRecord will be emitted.* The dashboard should tolerate this and not show the user a phantom "streak grew by 1" jump. Cosmetic but worth noting in dashboard rendering logic. **Logged.**

7. **The 7-day expiring-consent warning** (decision 9 in §8) requires a *forward-looking* signal Worker C does not have. This is genuinely future work — Plaid's `PENDING_DISCONNECT` is a feature add (consent expiry tracking), not a reconciliation point with the back-off scheduler. **Future follow-up.**

**Net read:** Worker C's `scheduler-backoff.ts` data model is **directly sufficient** for the `cooling_off` pill's MVP. The streak count, next-attempt-at, reason class, and skip-record are all exposed and persisted. The "Try now" override works for free because manual runs already bypass the scheduler.

The one real *design* decision that needs an owner call (not a coding gap): **whether to ever transition from `cooling_off` to `blocked` automatically.** Worker C's current curve plateaus and continues forever; the recommended UX defines `blocked` as "the system has given up." I recommend adding a streak-length ceiling (e.g., "after 14 days of unbroken back-off, give up and surface `blocked`"), but this is a behavioural change to the scheduler that the owner should approve before implementation.

---

## 10. Sources

**Primary (the four mandated shops):**
- [Stripe Docs — Webhooks](https://docs.stripe.com/webhooks)
- [Stripe Docs — Handle verification with the API](https://docs.stripe.com/connect/handling-api-verification)
- [Stripe Support — Troubleshooting webhook delivery issues](https://support.stripe.com/questions/troubleshooting-webhook-delivery-issues)
- [Plaid Docs — Item Errors](https://plaid.com/docs/errors/item/)
- [Plaid Docs — Link Update Mode](https://plaid.com/docs/link/update-mode/)
- [Plaid Docs — Webhooks API](https://plaid.com/docs/api/webhooks/)
- [Plaid Docs — Launch Checklist](https://plaid.com/docs/launch-checklist/)
- [Plaid Docs — OAuth Guide](https://plaid.com/docs/link/oauth/)
- [Linear Changelog](https://linear.app/changelog)
- [Linear Docs — Slack](https://linear.app/docs/slack)
- [Linear Docs — Sentry](https://linear.app/docs/sentry)
- [Vercel — Deploying GitHub Projects](https://vercel.com/docs/git/vercel-for-github)
- [Vercel KB — Why aren't commits triggering deployments](https://vercel.com/kb/guide/why-aren-t-commits-triggering-deployments-on-vercel)
- [Vercel — Error List](https://vercel.com/docs/errors/error-list)
- [Vercel — Environments](https://vercel.com/docs/deployments/environments)

**Secondary:**
- [Fivetran — Alerts Documentation](https://fivetran.com/docs/using-fivetran/fivetran-dashboard/alerts)
- [Fivetran — Connection details API](https://fivetran.com/docs/rest-api/api-reference/connections/connection-details)
- [Airbyte Issue #2426 — Display failed connection status in UI](https://github.com/airbytehq/airbyte/issues/2426)
- [Segment — Delivery Overview](https://segment.com/docs/connections/delivery-overview/)
- [OrderSync Pro — Zapier troubleshooting guide](https://getordersyncpro.com/blogs/zapier-zap-failures-troubleshooting)
- [Carbon Design System — Status indicator pattern](https://carbondesignsystem.com/patterns/status-indicator-pattern/)
- [Trevor Calabro — Fixing Bad Status Design](https://trevorcalabro.substack.com/p/fixing-bad-status-design)
- [GitHub Docs — Code scanning tool status page](https://docs.github.com/en/code-security/code-scanning/managing-your-code-scanning-configuration/about-the-tool-status-page)
- [IsDown — Plain Linear integration incident, April 2026](https://isdown.app/status/plain/incidents/575855-linear-integrations-are-being-disconnected)

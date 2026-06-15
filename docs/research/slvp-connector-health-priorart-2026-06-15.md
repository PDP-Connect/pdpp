# SLVP-ideal prior art: connector/integration health UX and the get-back-to-healthy recovery loop

**Date:** 2026-06-15
**Author:** ink-carbon-polish lane (RI worker)
**Status:** prior-art corpus. Research + reasoning only. NO code or DB changes.
**Companion:** `docs/research/slvp-connector-health-legibility-reflection-2026-06-15.md` (the verified diagnosis: the backend model is honest, the render seams drop the axes, and there is no recovery model). This document is the **prior-art evidence base** that the reflection's six never-formed goals are earned by what Plaid / Stripe / Vercel / GitHub / Datadog / Nango actually ship, not invented.
**Existing model under design:** `reference-implementation/runtime/connection-health.ts` — `ConnectionHealthSnapshot` with a 7-state headline (`unknown | idle | needs_attention | blocked | cooling_off | degraded | healthy`), four orthogonal `axes` (coverage / freshness / attention / outbox), `badges` (stale / syncing), `forward_disposition`, `conditions[]`, `dominant_condition_id`, and `next_action`.

---

## 0. The thesis the prior art proves

Every mature integration product converges on the **same three-part contract**, and PDPP's snapshot already carries two of the three but renders all three badly:

1. **ONE synthesized verdict** the surface renders verbatim — never re-derived from raw state fields per screen. (Plaid: Item status + error envelope. Stripe: `charges_enabled`/`payouts_enabled` + `requirements`. Datadog: one monitor status. GitHub: installation state. Vercel: connection state.)
2. **A typed required-action** attached to every unhealthy verdict — not a CTA string, but `{which field is wrong, the machine-readable code, the plain-English reason, who can fix it}`. (Stripe `requirements.errors[]` with `requirement`/`code`/`reason`; Plaid error envelope `error_type`/`error_code`/`display_message`; the geographic webhook split that pre-declares the action.)
3. **A satisfaction + self-heal contract** — the system detects the action was done and flips itself back to green with no separate "now run it" step, and where possible self-heals without the user acting at all. (Plaid update-mode + `LOGIN_REPAIRED`; Stripe `account.updated` → `pending_verification` → enabled; Datadog auto-recover thresholds; Nango 401-retry-then-mark.)

The reflection found PDPP has #1's *data* but re-derives it per surface, has #2's *evidence* but exposes it as a non-typed CTA, and has *none* of #3. The sections below are the receipts.

---

## 1. Plaid — the canonical "broken → one action → healthy" loop

Plaid is the closest analogue to PDPP: a third party holding a durable connection to an account the owner controls, where the connection silently rots (password change, consent expiry, revoked access) and must be repaired by **one owner action** that the system then confirms and auto-resumes.

### 1.1 The single-verdict Item status model

An **Item** (Plaid's unit = a user's authenticated connection at one institution) collapses to a small, honest set of human verdicts surfaced as an **error envelope**, not a sprawl of flags:

```json
{
  "error_type": "ITEM_ERROR",
  "error_code": "ITEM_LOGIN_REQUIRED",
  "error_message": "the login details of this item have changed ...",   // engineer-facing
  "display_message": "Username or password incorrect: If you've recently   // owner-facing, jargon-free
                      updated your account with this institution, be sure
                      you're entering your updated credentials",
  "request_id": "..."
}
```

This is the load-bearing pattern: **one object carries BOTH the machine state (`error_code`) AND the exact owner-facing instruction (`display_message`), AND the engineer detail (`error_message`) one layer down.** PDPP's `reason_code` + `next_action` + `dominant_condition_id` are the same three layers — but split across fields and re-narrated per surface instead of fused.

The canonical error states (the verdict vocabulary):
- **healthy** — implicit; no error envelope, data flows.
- **`ITEM_LOGIN_REQUIRED`** — "Additional input from the user is required to continue getting data for this Item." The single broken state. Delivered via the `ITEM: ERROR` webhook OR returned inline when you call any endpoint. Common causes are enumerated (non-OAuth password change, MFA change/expiry, OAuth consent expired/revoked, duplicate-Item). **Troubleshooting is exactly one instruction:** "Send the Item through Link's update mode. Update mode will then automatically prompt the user for whatever input ... is necessary to fix the Item."
- **`PENDING_DISCONNECT`** (US/CA) / **`PENDING_EXPIRATION`** (UK/EU) — a *pre-broken* warning fired ~7 days before consent expires, so the app can proactively run update mode *before* the connection breaks. This is the "stale/degraded but not yet broken" state done right: a distinct, named, pre-emptive verdict with its own (identical) one-action fix.

> **Mapping to PDPP:** PDPP's `axes.freshness: "stale"` + `badges.stale` is the `PENDING_*` analogue — "still working but heading toward a problem." The reflection's bug is that PDPP **drops** this axis at render, so the green pill ships without the pre-broken warning Plaid makes a first-class, named state. Plaid never shows a green Item while a `PENDING_DISCONNECT` is live; PDPP shows green Amazon while 31-days-stale.

### 1.2 Update mode — the "one action" repair, on the EXISTING connection

The repair is **not a re-setup**. You launch Link in *update mode* against the **same Item**:

> "To use update mode for an Item, initialize Link with a `link_token` configured with the `access_token` for the Item that you wish to update." — [Plaid: Update mode](https://plaid.com/docs/link/update-mode/)

Three properties make this the SLVP-ideal repair loop:

1. **Lands on the existing connection, not a fresh one.** The owner does not re-pick their bank, re-grant scopes, or create a duplicate. The `access_token` is reused.
2. **Abbreviated / minimum-input.** "When resolving these issues, for most institutions, Plaid will present an abbreviated re-authentication flow requesting only the minimum user input required to repair the Item." If only an OTP expired, the owner provides one OTP — not a full re-login. The action is sized to *exactly what's broken*.
3. **Tokens do not rotate.** "Once the user has reauthenticated their account, you will be able to use the original access and processor tokens again. Plaid does not require you to rotate these tokens when an item is reconnected as it is the same underlying item." → the app's downstream wiring (schedules, processor tokens) survives untouched. ("all existing processor tokens will automatically receive the updates, since they are linked to the access token, which does not change during update mode.")

> **Mapping to PDPP:** This is goal #4 (self-heal + auto-resume) and goal #3 (typed RequiredAction). The owner action is `kind: reauth`, `satisfied_when: credential present & non-rejected`, and the *target is the existing connection* — exactly the "Reconnect lands on the existing connection, schedule survives, confirming run fires" loop the reflection asks for. PDPP today makes the owner re-run manually after a fix; Plaid makes the credential update *itself* the trigger.

### 1.3 Webhooks flip the verdict back to healthy — including without the owner acting

- **Confirming pull → green.** After update mode, the data refreshes and the Item exits the error state. There is no separate "now go run it" step the owner must perform; reconnection IS the resume trigger.
- **`LOGIN_REPAIRED` — true self-heal.** "Fired when an Item exits `ITEM_LOGIN_REQUIRED` without going through update mode in your app." Driver: "If a user has connected the same account via Plaid to multiple different apps, resolving the `ITEM_LOGIN_REQUIRED` error for an Item in one app may also fix Items in other apps ... Upon receiving this webhook, **you can dismiss any messaging you are presenting to the user telling them to fix their Item.**" The banner removes itself; the owner is never nagged about an already-fixed problem.
- **Recommended UX loop:** show a reconnect banner on `ITEM_LOGIN_REQUIRED` → listen for `LOGIN_REPAIRED` → auto-dismiss when it fires. The verdict is a *function of live evidence*, so it heals itself the instant the evidence flips.

> **Mapping to PDPP:** `LOGIN_REPAIRED` is the proof that a verdict must be a pure projection of current evidence with **no sticky UI state**: the instant `satisfied_when` flips true (credential re-accepted, schedule re-attached, gap drained), the verdict must re-compute to green and the action must disappear — no manual dismissal, no stale banner. PDPP's projection is *already pure*; the gap is that the recovery contract (`satisfied_when`) doesn't exist to drive the flip, and the render layer caches/re-narrates instead of re-projecting.

**Sources:**
- [Plaid — Link: Update mode](https://plaid.com/docs/link/update-mode/)
- [Plaid — Errors: Item errors (ITEM_LOGIN_REQUIRED, error envelope shape)](https://plaid.com/docs/errors/item/)
- [Plaid — API: Items (LOGIN_REPAIRED, PENDING_DISCONNECT, PENDING_EXPIRATION webhooks)](https://plaid.com/docs/api/items/)
- [Plaid — Launch checklist (which webhooks to handle)](https://plaid.com/docs/launch-checklist/)

---

## 2. Stripe — one object that communicates BOTH state AND the exact action, with urgency tiers

Stripe Connect is the canonical "what's needed to stay enabled" model. The genius is that **a single Account object answers both "is this OK?" and "what exactly do I do?"** with no second lookup, and it tiers the action by *urgency* so the owner knows whether to act now or later.

### 2.1 The two boolean verdicts (the "is this OK?" glance)

`charges_enabled` and `payouts_enabled` are the one-glance health verdict. "If either of those attributes is false, check the Account's `requirements` hash to determine what information is needed." → **state first (binary, instantly legible), action detail one layer down.** Exactly the SLVP "glance → drill" shape.

### 2.2 The `requirements` hash — urgency-tiered required actions

Outstanding requirements are sorted into arrays **by urgency**, which is the taxonomy other products lack:

| Array | Meaning | PDPP analogue |
|---|---|---|
| `currently_due` | Must collect now; a deadline (`current_deadline`) is set. | An open required action with a near-term satisfaction window. |
| `past_due` | Overdue → **functionality is already disabled.** | A required action whose deadline passed → connection now `blocked`/`degraded`. |
| `eventually_due` | Will be required later; collect up-front or incrementally. | The `PENDING_*` / "stale but not broken" pre-emptive tier. |
| `pending_verification` | Under active Stripe review; **"No action is required"** but functionality stays disabled until it clears. | The "syncing / we're checking, don't touch it" axis — work in flight, owner should wait. |

> **Mapping to PDPP:** This is the missing **urgency dimension** of a `RequiredAction`. PDPP's reflection proposes `RequiredAction { kind, satisfied_when, terminal }`; Stripe shows the production-grade version also needs an *urgency/`deadline`* field (`act now` vs `act eventually` vs `wait, we're verifying` vs `it already broke`). The `pending_verification` tier is especially load-bearing for PDPP's ChatGPT case: a connection can be *busy and healthy with nothing for the owner to do* — "no action required, work in flight" is a distinct verdict from both green-idle and broken.

### 2.3 `requirements.errors[]` — the typed, plain-English action

Each error is a typed triple — this is the exact shape PDPP's `next_action` should become:

```json
{
  "requirement": "company.address.line1",     // WHICH thing is wrong (machine field id)
  "code": "invalid_street_address",            // machine-readable reason (branch on this)
  "reason": "The provided street address cannot be found."  // plain-English owner message + remediation
}
```

Design rules Stripe enforces and PDPP should copy:
- **`reason` is non-localized plain language** intended for direct display ("The image supplied isn't readable.") — the engineer never has to translate a code into owner copy.
- **`code` is for branching only; lean on `reason` for display, and handle unknown codes gracefully** — Stripe explicitly warns that adding a new code is a breaking change, so consumers must degrade to `reason`. (Goodhart-proofing: the UI can't hard-code a closed enum of messages.)
- **Some codes are intentionally generic** (`information_missing`) with the specificity in `requirement` + `reason`.

### 2.4 `disabled_reason` — the single field that names WHY, including terminal/not-owner-fixable

`requirements.disabled_reason` (an **enum** since the 2024 API change, previously a string) is the one field that says *why the whole capability is off* — distinct from the field-level errors. Critically it encodes **non-owner-fixable / terminal** cases: e.g. `rejected.inactivity` (Issuing disabled for inactivity → capability marked `inactive`), and risk-review requirements that **"you can't provide using the API"** and can only be resolved via Dashboard action or a remediation link. Stripe cleanly separates:
- **Owner-fixable**: collect a field → update Account/Person → `pending_verification` → enabled.
- **NOT owner-fixable via the normal path** (risk review, rejection): needs a remediation link or platform/Stripe-side action; the API self-serve path won't help.

> **Mapping to PDPP — the owner's "your action won't help, this needs a code fix" case:** `disabled_reason` is the direct precedent for the reflection's `terminal: true` flag. Chase's `current_activity` terminal-gap (stale selectors needing a connector *code* change) is PDPP's `rejected`-equivalent: the verdict must say **"we need to update the connector — your action won't help"**, exactly as Stripe says "you can't provide this via the API." PDPP's `forward_disposition` saying "resumes collection" for a terminal gap is the precise lie Stripe's `disabled_reason` enum is built to prevent.

### 2.5 The remediation link + auto-clear loop (self-heal)

- **One link, one action.** From the Dashboard's **"Actions required"** list, the platform generates an account-specific **remediation link** (valid 90 days, reusable) and sends it to the connected account. The account clicks → Stripe-hosted page → submits exactly the missing info. One action, on the existing account, sized to what's missing — the Stripe analogue of Plaid update mode.
- **Ordered by urgency.** When multiple actions exist the list orders them: *Information request from Stripe → `past_due` → `currently_due` → future → `eventually_due`*. The owner is shown **the most urgent single thing first.**
- **Auto-clear via events.** After resubmission, "Stripe needs time to verify ... assume any related functionality remains disabled" → status sits in `pending_verification` → on success the capability auto-enables. The consumer **"listens for `account.updated` events"** (Account v2: `v2.core.account[requirements].updated`) and re-renders. The verdict heals itself when verification passes; no manual "re-enable" button.
- **Plain-English, drill-down dashboard.** Goal stated by Stripe: "understand an account's status, impacted capabilities, and outstanding requirements **without examining webhook logs**. View clear instructions on how to resolve open requirements." Each list row shows due date, status, and **which capabilities it affects**; clicking drills into the error codes + remediation paths.

> **Mapping to PDPP:** Stripe's "Actions required" list = the reflection's goal #1 rendered: one synthesized verdict + the single most-urgent typed action + which streams it affects + a self-clearing satisfaction loop. PDPP's per-stream chips ("coverage·unknown · resumes collection") are the anti-pattern: N un-ordered, un-reconciled facts instead of one ordered "here's the one thing, and what it blocks."

**Sources:**
- [Stripe — Onboard your connected account (requirements hash, charges/payouts_enabled)](https://docs.stripe.com/connect/saas/tasks/onboard)
- [Stripe — Handle verification updates (currently_due / past_due / pending_verification, future_requirements)](https://docs.stripe.com/connect/handle-verification-updates)
- [Stripe — Handle verification with the API (requirements.errors[] requirement/code/reason)](https://docs.stripe.com/connect/handling-api-verification)
- [Stripe — Account capabilities and configurations (per-capability requirements, disabled_reason)](https://docs.stripe.com/connect/account-capabilities)
- [Stripe — Review and take action on connected accounts ("Actions required" list, ordering)](https://docs.stripe.com/connect/dashboard/review-actionable-accounts)
- [Stripe — Remediation links](https://stripe.com/docs/connect/dashboard/remediation-links)
- [Stripe — Changelog: account disabled_reason becomes an enum (2024-11-20)](https://docs.stripe.com/changelog/acacia/2024-11-20/account-disabled-reason)
- [Stripe — Changelog: adds requirement error codes (2025-03-31)](https://docs.stripe.com/changelog/basil/2025-03-31/adds-requirement-error-codes)

---

## 3. Observability / integration dashboards — one verdict, no contradictory signals, "stale but not broken"

### 3.1 Datadog monitors — the canonical single-status-with-orthogonal-modifiers model

Datadog is the strongest prior art for PDPP's *exact architectural choice* (headline state + orthogonal axes), because it independently arrived at the same split:

- **Small closed status set:** `OK | Warn | Alert | No Data` (+ `Unknown` for integration monitors). One status per monitor. `Warn` is the explicit "degraded but not broken" tier between OK and Alert — a crossed warning threshold that has not crossed the alert threshold.
- **`No Data` is a first-class verdict, not green.** "No data is reporting" when you expect a metric to always report → a *distinct* status, never silently shown as OK. This is the direct precedent for PDPP's bug: a connection with no schedule and nothing flowing must NOT read green; it is the `No Data` case. Datadog even lets you *notify* on No-Data because "looks fine but isn't reporting" is the dangerous failure.
- **`Muted` is an ORTHOGONAL axis, not a status.** Muting "suppresses notifications **without resolving the underlying condition**." The monitor is still Alert; it's *also* muted. This is precisely PDPP's stale/syncing-as-axis decision: a modifier that rides alongside the headline without replacing it. Datadog never lets "muted" hide that the thing is still broken — the reflection's bug is PDPP letting `state:healthy` hide `freshness:stale`.
- **Integration monitor `Unknown` is shown in "No Data grey" but does not flip the overall monitor green** — an evidence-reliability axis kept visually distinct, mirroring PDPP's `unknown` state + `unknown_reasons[]`.
- **Aggregation is an explicit, single decision.** Simple alert = "no matter which group breaches, send ONE alert" (one rolled-up verdict); multi-alert = per-group rows. PDPP's per-stream chips need this: a connection-level rolled-up verdict (the pill) AND, on drill, per-stream rows — but the rollup is computed once, not implied by N independent chips. Critically the rollup is *worst-wins*: one Alert group makes the monitor Alert. PDPP's connection pill must be the worst-wins rollup of its streams (Chase's terminal `current_activity` must darken the whole pill), not an average that lets a broken core stream hide behind healthy siblings.

> **Mapping to PDPP:** Datadog validates PDPP's model as correct and shows the three guardrails PDPP's *render* drops: (1) "No Data" is never green; (2) a modifier (muted/stale) never replaces or hides the headline; (3) the connection verdict is a *worst-wins* rollup computed once. These are the reflection's render-time consistency invariant, stated by a shipping product.

### 3.2 GitHub Apps — suspended/`requires action`, and the "fixed the same way it broke" rule

- **Suspended installation = one clear, named state** with one consequence: "the GitHub App cannot access resources owned by that installation account." The break and the fix are symmetric and *attributed*: "A GitHub App must be unsuspended in the same way it was suspended." If the owner suspended it, the owner unsuspends it; if the app owner suspended it, the user **cannot** unsuspend it.
- This is the **owner-fixable vs NOT-owner-fixable** distinction rendered as UX: the system knows *who* can resolve the state and shows the action only to the party who can act. The frustration GitHub avoids is telling the user to do something only the app vendor can do.

> **Mapping to PDPP:** Direct precedent for the `terminal` / `who-can-fix` field on `RequiredAction`. Chase's selector fix is "app-owner only" (code change) — PDPP must, like GitHub, NOT show the owner a "reconnect" affordance for a state only the maintainers can resolve. The action's *audience* is part of its type.

### 3.3 Vercel integrations — "disconnected" with a single bounded fix, and the false-disconnect trap

- **One named broken state** ("disconnected") with enumerated causes (repo deleted/archived, app uninstalled) and a **single remediation flow**: Settings → Git → Disconnect/Reconnect, re-confirm app permissions.
- **The false-disconnect race is the cautionary tale:** a timing bug where "Vercel was unable to retrieve the app installation from GitHub, which made it appear as if the Vercel GitHub App was never installed" → shows disconnected when it isn't. Fix: "wait a couple of minutes and try connecting again." This is the **evidence-unreliable** case: the verdict must distinguish "genuinely broken" from "we can't currently read the truth" — exactly PDPP's `unknown` state + `unknown_reasons[]`, and a warning against rendering a hard "broken" when the real situation is "projection unreliable, retry."

> **Mapping to PDPP:** Vercel's false-disconnect = PDPP's `unknown` (projection unreliable) vs `degraded`/`blocked` (actually broken). The render must never collapse "I can't tell" into "it's broken" or "it's fine" — both are lies. PDPP already has the `unknown` state; the lesson is to *surface the retry/"checking" framing* rather than a definitive red.

### 3.4 Nango / Merge — automatic refresh, retry-then-mark, and webhook-on-invalid

- **Credential monitoring + webhook on invalid:** Nango "notifies via webhooks when credentials become invalid," and proactively refreshes each OAuth token at least once/24h to *prevent* the broken state.
- **Retry-then-mark (the recoverable-vs-terminal decision, automated):** "Status 401 is retryable so Nango can recover after refreshing ... If a 401 happens and the connection credentials do not change on the next fetch, Nango treats that as a **definitive authentication failure and stops** performing additional retries" (exponential backoff 3s→cap 10m between attempts). For revoked refresh tokens (Salesforce `invalid_grant`): "these errors are permanent, and the only way to fix them is to ask the user to re-authenticate" → recommended strategy: "retry once ... if it fails again, **mark the account for re-authentication** and let the user know."
- **Dashboard = active vs needs-attention vs error**, a single consolidated verdict per connection ("which connections are active, which need re-authorization, which are experiencing errors").

> **Mapping to PDPP:** Nango operationalizes the **recoverable → auto-retry, terminal → surface one action** branch as runtime policy: try the cheap automatic fix (refresh/retry with backoff) FIRST, and only escalate to an owner-facing `reauth` action when the evidence proves the automatic path is exhausted. This is exactly PDPP's Chase QFX (`retryable_gap`, auto-retry) vs `terminal_gap` (needs owner/code) distinction — and the lesson is the *verdict should not surface an owner action while the automatic recovery still has budget*, mirroring PDPP's `cooling_off` axis.

**Sources:**
- [Datadog — Monitor status page (OK/Warn/Alert/No Data, Unknown, muted)](https://docs.datadoghq.com/monitors/status/status_page/)
- [Datadog — Configure monitors (No Data, thresholds, recovery)](https://docs.datadoghq.com/monitors/configuration/)
- [Datadog — Integration monitor (Unknown shown as No-Data grey, overall stays OK)](https://docs.datadoghq.com/monitors/types/integration/)
- [Datadog — Alert aggregation (simple vs multi-alert rollup)](https://docs.datadoghq.com/monitors/guide/alert_aggregation/)
- [GitHub — Suspending a GitHub App installation ("unsuspended in the same way it was suspended")](https://docs.github.com/en/apps/maintaining-github-apps/suspending-a-github-app-installation)
- [Vercel — Error list (Git connection disconnected causes + reconnect)](https://vercel.com/docs/errors/error-list)
- [Vercel — Git settings (disconnect/reconnect flow)](https://vercel.com/docs/project-configuration/git-settings)
- [Nango — Salesforce OAuth refresh token invalid_grant (retry-once-then-mark-for-reauth)](https://nango.dev/blog/salesforce-oauth-refresh-token-invalid-grant/)
- [Nango — Observability & logs (per-connection status, operations)](https://nango.dev/docs/guides/platform/logs)

---

## 4. The design pattern: one honest synthesized state + one required-action + a satisfaction/auto-resume contract

Synthesizing across all five companies, the SLVP-ideal connector-health pattern is a **single object** with this shape (each part has multiple independent prior-art precedents):

```
RenderedVerdict {
  // (A) ONE state — worst-wins rollup, computed once, rendered verbatim
  state:            <closed small enum>                  // Plaid Item status · Datadog OK/Warn/Alert/NoData · Stripe enabled-bool
  mandatory_axes:   { freshness, work_in_flight, ... }   // Datadog muted-as-axis · Plaid PENDING_* · pill NEVER ships without these

  // (B) ZERO-OR-ONE required action — typed, most-urgent-first, plain-English + machine code
  required_action?: {
    kind:           reauth | add_info | fix_config | backfill | reattach_schedule | wait | code_fix | contact_support,
    audience:       owner | maintainer | none,           // GitHub "fixed the way it broke" · Stripe owner-vs-risk-review
    urgency:        now | eventually | verifying | overdue,   // Stripe currently_due/eventually_due/pending_verification/past_due
    affects:        [<stream/capability ids>],            // Stripe "capabilities it can affect"
    owner_message:  <jargon-free reason>,                 // Stripe reason · Plaid display_message
    detail_code:    <machine code, branch-only>,          // Stripe code · Plaid error_code (handle-unknown-gracefully)
    satisfied_when: <machine-checkable condition>,        // Plaid credential-present · Stripe field-collected
    terminal:       bool                                  // Stripe disabled_reason rejected.* · GitHub maintainer-only
  }

  // (C) SELF-HEAL — verdict is a pure projection of live evidence; flips on satisfaction with NO manual step
  // Plaid update-mode→confirming-pull→green · LOGIN_REPAIRED auto-dismiss · Stripe account.updated→pending→enabled
}
```

### 4.1 The required-action taxonomy other products use

Collapsing every product's vocabulary into PDPP's terms (the universal kinds, each with ≥2 precedents):

| `kind` | What it means | Prior-art precedents | PDPP instance |
|---|---|---|---|
| **reauth** | Credential/consent dead; re-authenticate the *existing* connection. | Plaid `ITEM_LOGIN_REQUIRED`→update mode; Nango `invalid_grant`→mark-for-reauth | Amazon (no credential); any token-rejected |
| **add_info** | Missing required data the owner can supply. | Stripe `currently_due` field; remediation link | (future: connector needing a setup field) |
| **fix_config** | A configuration is wrong/incomplete and owner-fixable. | Vercel reconnect/permissions; Stripe collection | Amazon (no schedule → reattach) |
| **reattach_schedule** | Connection has data but nothing scheduled to refresh it. | (PDPP-specific; closest = Stripe "inactive for inactivity") | Amazon (records + no schedule) |
| **backfill** | Recoverable historical gap; enqueue a backfill. | Plaid transactions refresh; Stripe re-submit | Chase `transactions` retryable_gap |
| **wait** | Work is in flight / under verification; **owner does nothing**. | Stripe `pending_verification`; Datadog syncing; Plaid `LOGIN_REPAIRED` pending | ChatGPT mid-run; gap-drain in progress |
| **code_fix** (terminal) | Only a maintainer code change fixes it; owner action won't help. | Stripe `disabled_reason: rejected.*`; GitHub maintainer-only unsuspend | Chase `current_activity` terminal_gap (stale selectors) |
| **contact_support** (terminal) | Out-of-band human escalation. | Stripe risk-review remediation link; Plaid Support ticket | (rare; escalation path) |

**The two-way cut everyone makes:**
- **owner-fixable** (`reauth`/`add_info`/`fix_config`/`reattach_schedule`/`backfill`) → show the ONE action, sized to exactly what's broken, on the existing connection.
- **NOT-owner-fixable / terminal** (`code_fix`/`contact_support`) → say so honestly ("we need to update the connector — your action won't help"), show no false reconnect affordance, route to the party who *can* act (GitHub's symmetry rule; Stripe's risk-review path).
- **wait** is the third, often-missed bucket: "nothing is wrong that you can fix; we're working/verifying" — Stripe's `pending_verification`, Datadog's syncing, the gap PDPP's ChatGPT case falls into.

### 4.2 The "one verdict + one action + self-heal" invariants (earned from prior art)

1. **The pill is a worst-wins rollup computed once and rendered verbatim** (Datadog aggregation; Stripe single enabled-bool). No surface re-derives state from raw fields → kills PDPP's N-formatter drift.
2. **The pill NEVER ships without its mandatory axes** (Datadog muted-rides-alongside; Plaid never-green-while-PENDING). Green + "stale 31d, nothing scheduled" is ONE verdict, not a green pill and a hidden badge.
3. **At most one required action is surfaced, most-urgent-first** (Stripe "Actions required" ordering). Drill-down shows the rest; the glance shows the single next thing.
4. **The action is typed, plain-English, and carries a machine code consumers handle unknown-gracefully** (Stripe code-is-breaking-change warning; Plaid display_message). The engineer never hand-writes owner copy from a code.
5. **`forward_disposition` must reconcile against the action** — it may not say "resumes collection" when the action is `terminal` or `wait`-on-owner (Stripe never says "enabled soon" for a `rejected` capability). This is the precise PDPP lie to kill.
6. **The verdict is a pure projection of live evidence with a `satisfied_when` contract; satisfaction flips it to green with no manual step, and self-heals when evidence flips externally** (Plaid update-mode + LOGIN_REPAIRED; Stripe account.updated). No sticky banners, no "now go run it."
7. **"Can't tell" ≠ "broken" ≠ "fine"** (Datadog No-Data/Unknown; Vercel false-disconnect). Evidence-unreliable is its own honest verdict (PDPP's `unknown` + `unknown_reasons[]`), framed as "checking / retry," not a hard red.

---

## 5. Legibility for non-technical users (with engineer-grade detail one layer down)

The universal pattern across all five products and the UX literature is **two-layer legibility**: a glanceable plain-language verdict on top, full technical detail one click down.

- **State first, as a binary/tiny enum the eye reads instantly** (Stripe `charges_enabled` true/false; Datadog colored OK/Warn/Alert; Plaid healthy/needs-login). "Is this OK?" is answered before any reading.
- **One plain-English action sentence, jargon-free, blame-free** — the dominant error-UX guidance (Nielsen heuristic 9): "state what the issue is in plain language, then what the user can do about it." "Use plain language — no jargon, no codes, no stack traces ... reserve technical details for developer-facing logs." Stripe's `reason` ("The provided street address cannot be found.") and Plaid's `display_message` ("Username or password incorrect: ... be sure you're entering your updated credentials") are the production exemplars: a non-technical owner reads them and knows exactly what to do.
- **Specific, not generic.** "Avoid generalities like 'invalid input.'" PDPP's "coverage·unknown" / "succeeded · coverage unknown" are exactly the banned vague non-messages — they tell the owner nothing actionable.
- **Engineer detail is present but demoted** (Plaid's `error_message` vs `display_message`; Stripe's `code` vs `reason`; the reflection's plan to put raw JSON in a `<details>`). The engineer gets `reason_code`, `dominant_condition_id`, `conditions[]`, run traces — one layer down, not in the headline.
- **No contradictory chips.** The error-UX literature's "be specific and consistent" + Datadog's single-status discipline both forbid the PDPP failure of two adjacent chips asserting incompatible facts ("coverage·unknown" next to "resumes collection"). One voice.
- **Show what it blocks.** Stripe shows "capabilities it can affect" per requirement; the owner sees not just "broken" but "this is why your X isn't updating." PDPP's `affects: [stream ids]` carries this.

> **The non-technical test (the owner's bar):** an owner glances at Amazon and reads "Stale — last refreshed 31 days ago, nothing scheduled. **Reconnect to resume.**" (not a green dot); glances at Chase `current_activity` and reads "Can't collect this — we need to update the connector. **Nothing you can do right now; we're on it.**" (not "resumes collection"); glances at ChatGPT and reads "Working — collected through today." (not "0 records this run"). Each is one sentence, plain, honest, and either gives the ONE action or honestly says there isn't one. The engineer clicks in and gets the codes, conditions, and traces.

**Sources:**
- [Nielsen Norman / UX Tigers — Error message usability (heuristic 9)](https://www.uxtigers.com/post/heuristic-9-error-messages)
- [LogRocket — Writing clear error messages: UX guidelines & examples](https://blog.logrocket.com/ux-design/writing-clear-error-messages-ux-guidelines-examples/)
- [UX Content Collective — How to write error messages](https://uxcontent.com/how-to-write-error-messages/)

---

## 6. How each model maps onto PDPP's existing `ConnectionHealthSnapshot`

The snapshot **already carries the data**; the prior art shows the synthesis + recovery layer to add on top (NOT a new state machine — the reflection's hard constraint).

| Prior-art primitive | PDPP field that already exists | What prior art says to ADD |
|---|---|---|
| Plaid Item status / Datadog single status / Stripe enabled-bool | `state` (7-state headline) | `synthesizeRenderedVerdict(snapshot) → RenderedVerdict`: ONE worst-wins rollup; forbid surfaces reading `state` directly. |
| Plaid `PENDING_*` / Datadog muted-axis / Stripe `eventually_due` | `axes.freshness`, `badges.stale`, `badges.syncing` | The pill MUST ship with these as mandatory annotations (never a bare green dot). Render-time invariant + test. |
| Stripe `requirements.errors[]` triple / Plaid error envelope | `next_action` (CTA), `reason_code`, `dominant_condition_id`, `conditions[]` | Promote `next_action` → typed `RequiredAction { kind, audience, urgency, affects, owner_message, detail_code, satisfied_when, terminal }`. |
| Stripe `disabled_reason: rejected.*` / GitHub maintainer-only | (none — gap) | The `terminal` + `audience` flags. Chase `current_activity` → `kind: code_fix, audience: maintainer, terminal: true`. |
| Stripe `pending_verification` / Datadog syncing | `badges.syncing`, `forward_disposition` | The `wait` action-kind: "work in flight, owner does nothing." ChatGPT mid-run, gap-drain. |
| Stripe urgency arrays | `forward_disposition` (`owner_refresh_due`/`resumable`/`awaiting_owner`) | Add `urgency` to the action; reconcile `forward_disposition` against `required_action.terminal` (no "resumes collection" when terminal/wait). |
| Plaid update-mode + LOGIN_REPAIRED / Stripe account.updated | (none — gap; projection is pure but no satisfaction contract) | The `satisfied_when` → auto-reattach-schedule → confirming-run → flip-green loop. Reconnect lands on the EXISTING connection; tokens/schedule survive. |
| Datadog No-Data / Vercel false-disconnect | `state: "unknown"`, `unknown_reasons[]` | Already present — render it as "checking / retry," never as a hard red or a green. |
| Stripe "capabilities affected" | per-stream coverage axes | `affects: [stream ids]` on the action; the rollup is worst-wins over streams (a terminal core stream darkens the pill). |
| Nango retry-then-mark | `cooling_off` state, `axes.outbox`, gap retryability | Don't surface an owner `reauth` while automatic recovery (`cooling_off`/retry budget) still has runway — escalate only when exhausted. |
| ChatGPT `records_emitted=0` footgun | run-summary projection | Collection-model-aware progress (records committed + gaps drained), not `records_emitted` — so deferred-collection connectors don't read idle. (No prior-art product exposes raw "events emitted" as the health signal; all expose *outcome* — data fresh? capability enabled? — which is the lesson.) |

**Net:** PDPP's model is, independently, the Datadog/Plaid/Stripe convergence — a small headline state plus orthogonal axes plus a per-error envelope. The prior art proves three additions, none a rewrite:
1. **A single server-owned synthesizer** (`RenderedVerdict`) that every surface renders verbatim, with worst-wins rollup and mandatory-axis invariants (Datadog + Stripe + Plaid).
2. **A typed `RequiredAction`** with `kind`/`audience`/`urgency`/`affects`/`owner_message`/`detail_code`/`satisfied_when`/`terminal` (Stripe `requirements.errors[]` + `disabled_reason` + GitHub audience rule).
3. **A `satisfied_when` self-heal loop** — reconnect on the existing connection, auto-reattach schedule, confirming run, flip green, with `LOGIN_REPAIRED`-style external self-heal and no manual "now run it" (Plaid update-mode + Stripe account.updated events).

---

*Corpus artifact for the connector-health prior-art research. Pairs with `slvp-connector-health-legibility-reflection-2026-06-15.md` (the diagnosis). Every claim above is sourced to a cited URL; the PDPP mappings are reasoned against `connection-health.ts` at HEAD, not against live iteration.*

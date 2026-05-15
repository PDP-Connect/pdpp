# Connector Health Dashboard — UI Mocks

**Date:** 2026-05-15
**Author:** Worker H (design-only, no code)
**Status:** Mocks for owner review. No implementation until reviewed.
**Companions:**
- Data contract: `docs/connector-health-state-design-brief-2026-05-15.md` (locked)
- Prior art: `docs/connector-health-state-research-2026-05-15.md` (Worker E)
- Catalog: `tmp/workstreams/connector-catalog-audit.md`

---

## 0. Scope and design principles

### 0.1 What this doc covers

Visual mocks for the dashboard surface that consumes `HealthSnapshot` from `computeConnectorHealth()`. Five surfaces:

A. Connector card (catalog grid)
B. Connector detail page header
C. "What's wrong?" expander
D. Timeline row (per-run history)
E. Recovery toast

ASCII mocks at production proportions. No CSS, no JSX, no Tailwind. Mocks read top-to-bottom; each carries inline annotation for non-obvious decisions.

### 0.2 Out of scope

Dashboard chrome (navigation, sidebar, filters, search). Anything outside the health surface itself. The state machine itself is locked — this doc consumes it, does not redesign it.

### 0.3 Inherited principles from brief and Worker E research

1. **Trevor Calabro's four-question test (§6.4):** every card answers *what state / why / when / what to do* without a click.
2. **One canonical affordance per state.** Never two CTAs of equal weight on the card.
3. **`display_message` is the source of card copy.** `reason_code` only appears in monospace inside the expander.
4. **Six states compress into four colours.** Green / amber / red / grey. Three amber states are disambiguated by icon + pill word + secondary copy, never by colour shading.
5. **No sparklines on cards.** Streak is a numeric clause in the secondary line. Visual streak lives only in the detail timeline.
6. **Recovery is celebrated quietly.** One-shot toast on `cooling_off → healthy` and `blocked → healthy`. No persistent recovery badge.
7. **Honesty for `degraded`:** amber not green. Records flowed but the run wasn't clean. Airbyte's `Incomplete-as-green` mistake is forbidden.

### 0.4 PDPP brand alignment

PDPP brand:
- **Primary:** `oklch(0.580 0.172 253.7)` — protocol blue (`--primary`). Reserved for protocol surfaces; **not** used for `healthy` pill.
- **Human:** `oklch(0.52 0.09 45)` — copper. Reserved for identity/consent surfaces; **not** used for status.
- Status colours are a separate token tier. Green = `--status-success`, amber = `--status-warning`, red = `--status-danger`, grey = `--status-muted`. These tokens are introduced by this design — they do not exist in `packages/pdpp-brand/base.css` yet. (See §G open question 4.)

Typography: Geist Sans for pill words and copy, JetBrains Mono for `reason_code` only.

---

## A. Connector card (catalog grid)

PDPP's catalog has 14 visible connectors. Cards live in a 3-column grid at desktop (≥1024px), 2-column at tablet, 1-column on mobile. Each card is ~320px wide × ~140px tall. Card has a 1px border, 12px radius (matching `--radius`), 16px internal padding, 8px gap between rows.

**Logo slot:** 24×24 SVG placeholder. PDPP ships the connector logo as a JPG/SVG asset per connector under `apps/web/public/connectors/<id>.svg`. Falls back to a monogram tile if missing.

### A.1 `healthy` — Gmail

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ░░  Gmail                                          ⋯      │
│  ░░                                                        │
│                                                            │
│  ● Connected                                               │
│  Last sync 4m ago · 12,281 records                         │
│                                                            │
│                                            ┌────────────┐  │
│                                            │  Run now   │  │
│                                            └────────────┘  │
└────────────────────────────────────────────────────────────┘
```

- `░░` = 24×24 logo slot (SVG)
- `⋯` = kebab menu (secondary actions: Pause, Reset, Open settings)
- `●` = filled 8px green dot, baseline-aligned with pill word
- Pill word "Connected" — single word, no parens, no count
- Secondary line: relative time + record count from latest run
- "Run now" is a **ghost** button — present but visually quiet. Rationale: in `healthy` the user has nothing to do; the affordance is offered, not pushed.

### A.2 `degraded` — Chase

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ░░  Chase                                          ⋯      │
│  ░░                                                        │
│                                                            │
│  ● Partial                                                 │
│  Synced 22m ago · 6 streams ok · 1 gap                     │
│                                                            │
│                                       ┌─────────────────┐  │
│                                       │ See what's gone │  │
│                                       └─────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

- `●` = filled 8px amber dot
- Pill word "Partial" not "Degraded" — Linear naming insight: don't make a working state sound broken.
- Secondary line carries the *honest* clause "1 gap" — the number of unfilled streams, not an opaque badge.
- "See what's gone" is an **outlined** button. Less aggressive than primary-fill because the user is not in crisis; data is flowing. Verb-led copy ("See", not "Details").
- Rationale for amber not green: per brief §1.1 and Worker E §8 decision 2 — gaps are honest but not invisible. Amber communicates "look at this when you have a minute."

### A.3 `needs_attention` — ChatGPT

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ░░  ChatGPT                                        ⋯      │
│  ░░                                                        │
│                                                            │
│  ◉ Sign in needed                          [pulsing]       │
│  ChatGPT needs you to sign in again · started 3m ago       │
│                                                            │
│                                       ┌─────────────────┐  │
│                                       │ Open assistant  │  │
│                                       └─────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

- `◉` = filled amber dot with a 1px amber ring at 0.6 opacity that pulses (the only animated state).
- **Pulse spec:** 1.8s cycle, ease-in-out, ring expands from radius 4px to 6px while fading from 0.6 → 0 opacity. Cycle starts on mount; pauses on tab `visibilitychange: hidden`. See §F.2.
- Pill word varies by `reason_code`: "Sign in needed" / "Approve in app" / "Code needed" / "Verify in browser". One pill word per copy bucket; never a generic "Action required".
- Secondary line is the `display_message` itself + "started Xm ago". *Not* "expires in Xm" — that's footnote-grade detail; it lives in the expander.
- "Open assistant" is a **filled primary** button. Rationale: this is the only state where the user *must* act for the connector to make progress, and the button must earn the pulse-attention investment.

### A.4 `cooling_off` — Reddit (the headline state)

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ░░  Reddit                                         ⋯      │
│  ░░                                                        │
│                                                            │
│  ⏱ Paused — retrying in 32m                                │
│  12 attempts in a row failed with the same problem.        │
│  Last try 14m ago.                                         │
│                                                            │
│                            ┌──────────────────────────────┐│
│                            │  Try now    What's wrong?    ││
│                            └──────────────────────────────┘│
└────────────────────────────────────────────────────────────┘
```

- `⏱` = filled clock icon, 12px, amber. *Replaces* the dot — single status mark per card.
- Pill copy is the full clause "Paused — retrying in 32m". The duration updates every minute. Always finite (back-off ceiling 24h per Worker C).
- Secondary line is 2-line, taken verbatim from Worker E §7 spec.
- **Two-affordance row** is unique to this state. Justification: `cooling_off` is the only state where the user has a real choice between "let it run on its own" and "force a retry now". Both affordances are legitimate; neither should be hidden.
- "Try now" is **filled primary** (the active override). "What's wrong?" is **ghost** (passive disclosure). Visual weight ratio communicates which is the recommended action.
- Card height grows by ~18px to accommodate the 2-line secondary copy. Live spec must reflow gracefully.

### A.5 `blocked` — USAA (hypothetical post-promotion; today USAA has no schedule)

```
┌────────────────────────────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  ░░  USAA                                           ⋯      │
│  ░░                                                        │
│                                                            │
│  ⊘ Disconnected                                            │
│  Stopped retrying at 02:14 · 47 attempts failed            │
│                                                            │
│                                          ┌─────────────┐   │
│                                          │  Reconnect  │   │
│                                          └─────────────┘   │
└────────────────────────────────────────────────────────────┘
```

- Top edge `━━━` = 2px red top border (vs. the standard 1px neutral border on other states). This is the only state with a heavier frame — see §F.5.
- `⊘` = stroked "no entry" / plug-disconnected icon, 12px, red. Filled would feel hostile; stroke reads as terminal not aggressive.
- Pill word "Disconnected" — chosen over "Stopped" because the user thinks in terms of connection, not scheduler state.
- Secondary line carries the moment-of-quit + the streak length. Does *not* carry the reason code — that's in the expander.
- "Reconnect" is **filled primary** — borrows the Plaid Link-update-mode affordance discipline (§Worker E 1.2).
- Records collected before the streak remain queryable; the card does not mention this (the detail page does — see §B.5).

### A.6 `idle` — Spotify (never run)

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ░░  Spotify                                        ⋯      │
│  ░░                                                        │
│                                                            │
│  ○ Not connected                                           │
│  Never synced                                              │
│                                                            │
│                                            ┌────────────┐  │
│                                            │  Connect   │  │
│                                            └────────────┘  │
└────────────────────────────────────────────────────────────┘
```

- `○` = stroked grey dot (not filled). The stroke vs. fill distinction signals "empty state" without changing colour. See §F.6.
- Pill word "Not connected" for never-run, **"Schedule paused"** for owner-paused. Two variants of `idle`:

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ░░  Slack                                          ⋯      │
│  ░░                                                        │
│                                                            │
│  ○ Schedule paused                                         │
│  Paused on May 12 by you                                   │
│                                                            │
│                                       ┌─────────────────┐  │
│                                       │ Resume schedule │  │
│                                       └─────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

- "Connect" / "Resume schedule" — both **filled primary** with `--primary` (protocol blue, not the status palette). Rationale: `idle` is the only state where the affordance is *positive forward motion*, not corrective. Using protocol blue ties the action visually to "starting a protocol session" rather than "fixing a problem".

---

## B. Connector detail page header

When the user clicks into a connector. The detail page is full-width with a sidebar elsewhere; the header occupies the top of the main column at ~960px wide.

### B.1 Layout principles

- Larger logo (48×48) + connector name (24px Geist Sans).
- Health pill is a larger version of the card pill — same colour vocabulary, larger pulse for `needs_attention`, full back-off countdown for `cooling_off`.
- Primary affordance on the right edge of the header.
- Kebab menu beside the affordance for secondary actions.
- A "streak history" strip lives directly under the pill: numeric, not sparkline (per Worker E §7).

### B.2 `healthy` — Gmail detail header

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ░░░░  Gmail                                          ┌──────────┐  ⋯     │
│  ░░░░  ● Connected                                    │ Run now  │        │
│  ░░░░  Last sync 4m ago · 12,281 records              └──────────┘        │
│                                                                            │
│  Last 14 days:  ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓     0 failures              │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- `░░░░` = 48×48 logo slot.
- 14-day streak strip: filled green check per run. Spacing 8px between marks. At >14 marks per day, the strip collapses to "14 days · 42 runs · 0 failures" — text-only.
- `0 failures` is the headline streak count.

### B.3 `cooling_off` — Reddit detail header (the case where the expander lives)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ░░░░  Reddit                                                              │
│  ░░░░  ⏱ Paused — retrying in 32m                                          │
│  ░░░░  12 attempts in a row failed with the same problem.                  │
│        Last try 14m ago. Last successful sync 18 days ago.                 │
│                                                                            │
│        ┌──────────┐  ┌─────────────────┐                                  │
│        │ Try now  │  │ What's wrong? ▾ │  ⋯                               │
│        └──────────┘  └─────────────────┘                                  │
│                                                                            │
│  Last 14 days:  ✓ ✓ ✓ ⚠ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕     11 failures, 1 partial   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- The header carries a third secondary line ("Last successful sync 18 days ago") that the card omits. This is the Vercel "your previous good state is still here" reassurance, surfaced at detail level not card level.
- The "What's wrong?" expander button has a `▾` chevron and toggles the panel below the header (see §C).
- 14-day streak shows `✕` for failed, `⚠` for partial, `✓` for clean. Colour matches state.

### B.4 `needs_attention` — ChatGPT detail header

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ░░░░  ChatGPT                                                             │
│  ░░░░  ◉ Sign in needed                              [pulsing 1.8s]        │
│  ░░░░  ChatGPT needs you to sign in again. Waiting for you · expires 4m.  │
│                                                                            │
│        ┌────────────────────┐  ┌─────────────────┐                        │
│        │  Open assistant    │  │ What's wrong? ▾ │  ⋯                     │
│        └────────────────────┘  └─────────────────┘                        │
│                                                                            │
│  Last 14 days:  ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✕ ✕ ✕ ✕ ⏸     4 failures, 1 waiting   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- `⏸` indicates the current run is paused waiting on assistance (today's run).
- "expires 4m" appears in the header (not on the card) because the expiry is a real ticking deadline at this depth.

### B.5 `blocked` — USAA detail header

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                            │
│  ░░░░  USAA                                                                │
│  ░░░░  ⊘ Disconnected                                                      │
│  ░░░░  Stopped retrying on May 13 at 02:14. 47 attempts in a row failed   │
│        with the same problem. Your data from May 12 is still queryable.    │
│                                                                            │
│        ┌──────────────┐  ┌─────────────────┐                              │
│        │  Reconnect   │  │ What's wrong? ▾ │  ⋯                           │
│        └──────────────┘  └─────────────────┘                              │
│                                                                            │
│  Last 14 days:  ⏸ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ✕ ⊘     14 failures, then stopped │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- The 2px red top border crosses the entire header (continuous with the card frame on the catalog page).
- "Your data from May 12 is still queryable" — direct Vercel-instant-rollback ethos translated to PDPP terms. This sentence is the difference between a `blocked` state that feels hopeful and one that feels dead.
- `⊘` at the right end of the streak strip marks the `schedule.gave_up` event itself.

---

## C. The "What's wrong?" expander

Opens directly below the detail page header when the user clicks "What's wrong? ▾". Slides down (160ms ease-out). Push-down layout — does not float over content. Width matches the header (~960px).

### C.1 `cooling_off` expander — Reddit

```
┌────────────────────────────────────────────────────────────────────────────┐
│  What's wrong?                                                       ▴    │
│                                                                            │
│  Reddit is asking for extra verification.                                  │
│  This usually means signing in again, or completing a Cloudflare prompt   │
│  in a browser. Reddit only does this when something about your session    │
│  looks off to them — not because anything is broken on our side.           │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ reason_code   reddit_login_unexpected_ui                              │ │
│  │ first seen    May 14, 04:50                                           │ │
│  │ last seen     May 15, 04:50  (14 minutes ago)                         │ │
│  │ next attempt  May 15, 15:36  (in 32 minutes)                          │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  ┌────────────────┐  ┌──────────┐                                         │
│  │  Reconnect     │  │ Try now  │                                         │
│  └────────────────┘  └──────────┘                                         │
│                                                                            │
│  ─────────────────────────────────────────────────────────────────────    │
│                                                                            │
│  Recent attempts (showing last 12 of 47)                                  │
│                                                                            │
│  ✕  May 15, 04:50   reddit_login_unexpected_ui                            │
│  ✕  May 15, 02:14   reddit_login_unexpected_ui                            │
│  ✕  May 14, 23:01   reddit_login_unexpected_ui                            │
│  ✕  May 14, 19:48   reddit_login_unexpected_ui                            │
│  ✕  May 14, 16:35   reddit_login_unexpected_ui                            │
│  ✕  May 14, 13:22   reddit_login_unexpected_ui                            │
│  ✕  May 14, 10:09   reddit_login_unexpected_ui                            │
│  ✕  May 14, 06:56   reddit_login_unexpected_ui                            │
│  ⋯  Show 35 more                                                          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- Prose first, code second. The `display_message` is the headline; the `reason_code` is the receipt.
- The bordered fact box (`reason_code` / `first seen` / `last seen` / `next attempt`) is in JetBrains Mono. This is the engineer-honest layer — exact codes and exact timestamps, no fuzzing.
- **Two affordances** here, but reversed visual weight from the card: "Reconnect" is **filled primary** because in the expander the user has invested in understanding the problem and is more likely to want the durable fix; "Try now" is **outlined** because it's the lightweight option once you're already this deep.
- "Recent attempts" is a tabular log — the Stripe webhook detail discipline (Worker E §1.1). Each row: status mark + timestamp + reason code in monospace. "Show 35 more" expands; does not paginate to a new page.

### C.2 `blocked` expander — USAA

```
┌────────────────────────────────────────────────────────────────────────────┐
│  What's wrong?                                                       ▴    │
│                                                                            │
│  USAA's connection has stopped working.                                    │
│  After 47 attempts spread over 14 days, the same problem kept happening.  │
│  We've stopped retrying automatically. You can reconnect to start over,   │
│  or try one manual run to see if the problem cleared on its own.           │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ reason_code        connector_reported_failed                         │ │
│  │ classifier hint    browser_context_died_before_navigation             │ │
│  │ first seen         May 1, 00:40                                       │ │
│  │ stopped retrying   May 15, 02:14                                      │ │
│  │ last success       Apr 28, 19:33  (data still queryable)              │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  ┌────────────────┐  ┌──────────────┐                                     │
│  │  Reconnect     │  │ Try one run  │                                     │
│  └────────────────┘  └──────────────┘                                     │
│                                                                            │
│  ─────────────────────────────────────────────────────────────────────    │
│                                                                            │
│  Recent attempts (showing last 14 of 47)                                  │
│                                                                            │
│  ⊘  May 15, 02:14   stopped retrying — back-off ceiling reached            │
│  ✕  May 15, 00:01   connector_reported_failed                             │
│  ✕  May 14, 19:24   connector_reported_failed                             │
│  ✕  May 14, 14:47   connector_reported_failed                             │
│  ✕  May 14, 10:10   connector_reported_failed                             │
│  ✕  May 14, 05:33   connector_reported_failed                             │
│  ✕  May 14, 00:56   connector_reported_failed                             │
│  ✕  May 13, 20:19   connector_reported_failed                             │
│  ✕  May 13, 15:42   connector_reported_failed                             │
│  ✕  May 13, 11:05   connector_reported_failed                             │
│  ✕  May 13, 06:28   connector_reported_failed                             │
│  ✕  May 13, 01:51   connector_reported_failed                             │
│  ✕  May 12, 21:14   connector_reported_failed                             │
│  ✕  May 12, 16:37   connector_reported_failed                             │
│  ⋯  Show 33 more                                                          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- "Try one run" not "Try now" — wording shifts at this depth to signal "this is a one-shot attempt, the system has otherwise given up". Same controller call as `runNow`.
- The `⊘` row at the top of the log is the `schedule.gave_up` event itself, rendered as a distinguishable terminal row.

### C.3 `degraded` expander — Chase

When opened from a `degraded` card, the expander is a *gap list*, not an attempt log.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  What's missing?                                                     ▴    │
│                                                                            │
│  Chase finished, but some data couldn't be collected.                     │
│  This usually clears on the next run. If a gap keeps showing up, the      │
│  underlying source has probably changed.                                  │
│                                                                            │
│  ─────────────────────────────────────────────────────────────────────    │
│                                                                            │
│  Gaps in this run (1)                                                     │
│                                                                            │
│  ⚠  current_activity                                                       │
│      reason_code         selectors_pending                                 │
│      retryable           unknown — needs fixture                           │
│      first seen          May 8, 09:12                                      │
│      what we need        A saved page after expanding a row that visibly   │
│                          shows date, description, amount, and pending     │
│      ┌──────────────────┐                                                 │
│      │  Help by sharing │                                                 │
│      └──────────────────┘                                                 │
│                                                                            │
│  ─────────────────────────────────────────────────────────────────────    │
│                                                                            │
│  Streams that completed (6)                                                │
│                                                                            │
│  ✓  accounts          1 record                                            │
│  ✓  balances          1 record                                            │
│  ✓  statements        5 records                                            │
│  ✓  transactions      15 records                                          │
│  ✓  inbox_messages    14 records                                          │
│  ✓  credit_card_…     2 records                                           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- "What's missing?" not "What's wrong?" when the state is `degraded` — softens the framing because nothing is wrong; data is flowing.
- The gap row offers a *participatory* affordance ("Help by sharing") for `selectors_pending` reason codes — direct line back to the connector authoring path. Other gap types show "See details" instead.

---

## D. Timeline row (per-run history)

The timeline is the bowl of the connector detail page (Martini Glass model — see `project_reference_design_research.md`). Each run is one row. Rows are ~64px tall, full-width.

### D.1 Successful run row

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ✓  May 15, 14:51         Slack                                            │
│     Completed in 4m 32s · 1,544 records emitted                            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- `✓` = filled green check, 12px.
- Timestamp + connector name on the first line. Duration + record count on the second.

### D.2 `degraded` run row (succeeded with gaps)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ◐  May 15, 13:50         Chase                                            │
│     Completed in 1m 12s · 6 streams ok · 1 gap (current_activity)         │
│                                                       ┌─────────────────┐ │
│                                                       │ See what's gone │ │
│                                                       └─────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

- `◐` = half-filled amber circle. Visual rhyme with the `degraded` card pill.
- Inline affordance on a single row (only `degraded` and failure rows carry inline affordances).

### D.3 Failed run row

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ✕  May 15, 04:50         Reddit                                           │
│     Failed in 38s · Reddit is asking for extra verification                │
│     reason_code   reddit_login_unexpected_ui                               │
│                                                       ┌─────────────────┐ │
│                                                       │ Open this run   │ │
│                                                       └─────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

- Two-line body: `display_message` in prose on line 1, `reason_code` in monospace on line 2. Engineer English and end-user English coexist *here* because the timeline is mixed-audience.
- "Open this run" deep-links into the full run record (spine events, browser session id, persisted screenshots if any).

### D.4 Auto-paused banner (spans the streak)

```
       ┌──────────────────────────────────────────────────────────────────┐
       │  ⏱  Auto-paused after 5 consecutive failures of                  │
       │     reddit_login_unexpected_ui.                                   │
       │     Next retry scheduled for May 15, 15:36.                       │
       └──────────────────────────────────────────────────────────────────┘

│  ✕  May 14, 23:01         Reddit                                           │
│     Failed in 41s · Reddit is asking for extra verification                │
│     reason_code   reddit_login_unexpected_ui                               │
│                                                                            │
│  ✕  May 14, 19:48         Reddit                                           │
│     Failed in 39s · Reddit is asking for extra verification                │
│     reason_code   reddit_login_unexpected_ui                               │
│                                                                            │
│  ✕  May 14, 16:35         Reddit                                           │
│     ...                                                                    │
```

- The banner sits *between* the run that triggered the back-off (5th consecutive same-class failure) and the runs that followed. It is a sticky marker for the streak, not a row.
- Banner copy is **the most important multi-row affordance in the timeline** — it converts a wall of red rows into a legible "the system noticed; here's what it did" moment.
- Banner is amber-tinted background, no border, 16px padding, indented ~24px from the timeline gutter so it visually bridges between rows.
- When the streak ends (next successful run), a *second* banner fires:

```
       ┌──────────────────────────────────────────────────────────────────┐
       │  ✓  Reconnected — back to normal cadence.                         │
       └──────────────────────────────────────────────────────────────────┘

│  ✓  May 15, 15:36         Reddit                                           │
│     Completed in 2m 18s · 47 records emitted                              │
```

- The recovery banner is green-tinted, single line. It is the persistent record of what the toast (§E) only flashes briefly.

### D.5 `schedule.gave_up` terminal banner

```
       ┌──────────────────────────────────────────────────────────────────┐
       │  ⊘  Stopped retrying.                                            │
       │     After 47 consecutive failures over 14 days, automatic        │
       │     attempts are paused. Reconnect or try a manual run.          │
       └──────────────────────────────────────────────────────────────────┘
```

- Red-tinted, 2-line.
- Renders *between* the last auto-attempt and any subsequent manual attempts. Manual attempts appear as normal rows below it but visibly belong to a different epoch.

---

## E. Recovery toast

One-shot. Fires on `cooling_off → healthy` or `blocked → healthy` transitions. Lives in the bottom-right toast slot. Width ~360px, height ~64px (single-line body) or ~88px (two-line).

### E.1 Toast frame

```
                          ┌────────────────────────────────────────────────┐
                          │ ✓  Reconnected — catching up on missed data.  │
                          │    Reddit                                ✕    │
                          └────────────────────────────────────────────────┘
```

- `✓` = filled green check on a green-tinted background (subtle, ~6% opacity green).
- Body copy: "Reconnected — catching up on missed data." (exact Plaid-mirror copy from Worker E §1.5).
- Subtitle: connector name (so multiple recoveries in one session are distinguishable).
- `✕` = dismiss affordance on the right.
- **Auto-dismiss: 6 seconds.** Rationale: long enough to register but short enough to not interrupt. Plaid's `LOGIN_REPAIRED` webhook is single-fire and host apps typically render it as a sub-10s notice.
- Toast does **not** stack a CTA inside it. Recovery is celebrated, not turned into another decision. If the user wants to verify, the connector card itself is now green.

### E.2 Toast on `blocked → healthy`

Same frame, slightly different copy:

```
                          ┌────────────────────────────────────────────────┐
                          │ ✓  Reconnected — back to normal cadence.       │
                          │    USAA                                  ✕    │
                          └────────────────────────────────────────────────┘
```

- "back to normal cadence" because after `blocked` the cadence resumption is the more notable change than data catch-up. (The catch-up phrasing reads weird for USAA because USAA has been off the schedule for two weeks; "normal cadence" is the honest signal.)

### E.3 Toast non-interactions

- No "Undo" affordance — recovery is good news; nothing to undo.
- No "View details" affordance — the card itself is the destination.
- Does **not** fire on `degraded → healthy`. A gap clearing on the next run is normal cadence, not a recovery moment.
- Does **not** fire on `needs_attention → healthy` either, in the SLVP version — those transitions are user-initiated and the user already saw the assistance modal close. (Open question §G.2 — owner may decide to fire this third.)

---

## F. Cross-state design decisions

Each decision is a position with a one-line rationale.

### F.1 Icon system

**Decision:** Stroke-only for status icons (clock, no-entry, dot ring), filled for the dot/state mark. Inline with the pill word, never floating.

**Rationale:** Filled dots at 8px read as solid signals; stroked secondary icons at 12px stay visually quiet and don't fight the pill word for attention. Mixed-weight is intentional: state colour is the loud part, icon shape is the disambiguation.

### F.2 Pulse animation timing

**Decision:** **1.8s cycle**, ease-in-out, ring expands from 4px to 6px radius while fading 0.6 → 0 opacity.

**Rationale:** 1.2s reads as urgent (notification-style). 2.4s reads as ambient (breathing-style). 1.8s is the Plaid-Link / Linear-status sweet spot — present without nagging. Pause on `visibilitychange: hidden` so the pulse doesn't drain battery on background tabs.

### F.3 "Try now" button affordance during back-off

**Decision:** **Filled primary** on the card. **Outlined** in the expander. **Disabled** for the rest of the cycle after 3 presses (per Worker E §8 decision 4).

**Rationale:** On the card, the user has limited surface to act — "Try now" is the override and deserves primary weight. In the expander, the user has already discovered "Reconnect" as the durable fix; "Try now" becomes the secondary lightweight option. The 3-press cap prevents thrash; after the cap, the button reads "Try now (cooling off)" and is non-interactive until the next scheduled slot.

### F.4 Card hover state

**Decision:** Hover reveals the kebab `⋯` only on the hovered card; everything else stays static. No secondary actions reveal on hover. No full-reason on hover.

**Rationale:** Mobile and keyboard users have no hover. Anything important must be visible without it. Hover should add discoverability, not gate functionality. The kebab is always discoverable on focus/touch.

### F.5 `blocked` state visual weight

**Decision:** **Heavier frame.** 2px top border in `--status-danger`, vs. 1px neutral on all other states.

**Rationale:** `blocked` is the only state where the system has actually stopped doing something for the user. Every other state is a "we're still trying" variant. The heavier frame says "this one needs your eyes" without resorting to ALL-CAPS or shouting copy. Borrows Stripe Connect's red banner discipline.

### F.6 Empty-state cards (`idle`)

**Decision:** **Stroked dot** instead of filled (`○` vs. `●`), pill word in 60% opacity grey, secondary line in 50% opacity grey. Frame remains 1px neutral. No icon.

**Rationale:** `idle` is the absence of a state, not a "bad" state. The visual signal must be quietly different — same shape language, lower commitment. Filled grey would read like "muted but real"; stroked reads like "nothing yet". Affordance ("Connect") uses `--primary` (protocol blue) to put forward motion into the card without confusing it with `healthy`.

### F.7 Dark mode

**Decision:** All six states translate cleanly. Pill colour tokens flip via the standard `oklch(L C H)` lightness inversion already established in `packages/pdpp-brand/base.css`. Status tokens (introduced by this design — see §G.4) must follow the same convention.

**Risk pills:** **Amber on dark** is the historical fail-case. Standard `oklch(0.8 0.16 80)` becomes hard to read against a `oklch(0.18 …)` background unless the `L` shifts to ~0.72. Mitigation: explicit `--status-warning-dark` token at `oklch(0.78 0.15 80)`. Verified by checking against the Carbon DS dark-mode status indicator palette — same lightness range.

**Green on dark** and **red on dark** both work at standard tokens with a 4px-wider visual halo around the dot to compensate for reduced perceived contrast.

**Grey on dark** for `idle` is the trivial case — the stroked dot remains legible because the contrast comes from the stroke against the card surface, not the fill against the page background.

---

## G. Open questions for owner review

Each is a specific decision needing a call, not a vague concern.

### G.1 Should `needs_attention → healthy` also fire the recovery toast?

**The case for yes:** consistency. The user just acted; a confirmation is warming.
**The case for no:** the user already saw the assistance modal close; doubling up reads as nagging.
**Worker H recommendation:** **No** in SLVP, **yes** if user research finds users uncertain about whether their action took effect. Defer the third toast.

### G.2 Should `blocked` connectors sort to the top of the catalog grid?

The brief Appendix flags this as "yes probably; UI concern."
**Worker H recommendation:** **Yes**, with the sort order: `blocked → needs_attention → cooling_off → degraded → idle → healthy`. Rationale: the dashboard's job is to surface what needs attention first. `healthy` connectors are the success state and can wait at the bottom.
**Owner override needed:** if alphabetical-stable is preferred for muscle memory, the alternative is a filter chip ("Show needs attention first").

### G.3 Should "Try now" appear in the kebab menu when the card itself is `healthy`?

The card has no primary "Try now" in `healthy` (only "Run now" as a ghost). The kebab carries "Pause schedule", "Reset", "Open settings", and "Run now" duplicates the ghost button on the card.
**Worker H recommendation:** **Remove "Run now" from the kebab** when the card already shows it. Kebab carries only actions not exposed on the card surface — keeps mental model clean.

### G.4 Do status colours go into `packages/pdpp-brand/base.css`?

The brand currently has `--primary` (protocol blue) and `--human` (copper). Status colours are absent. Either:
- (a) Add a new `--status-*` tier to `base.css` (PDPP brand owns status semantics ecosystem-wide).
- (b) Define status tokens in `apps/web` only, treat as app-layer.
**Worker H recommendation:** **(a)** — status semantics are common across PDPP ecosystem apps (future operator dashboards, mobile, etc.), and putting them in the brand package matches the existing three-layer token architecture (system → theme → app). This decision needs brand-package buy-in.

### G.5 What happens visually when a connector is *currently running* (not at rest)?

The state machine doesn't expose "in flight" — that's a separate axis (per Worker E §4.1 final paragraph: a running connector keeps its current pill, with a small spinner badge added).
**Worker H recommendation:** small 8px spinner appended after the pill word, e.g. `● Connected ⟳`. Rotates 1.4s per turn. Spinner does *not* replace the dot; the two coexist. Question for owner: does the dashboard render this from real-time scheduler signal, or by inferring from the most-recent `run.started` without `run.completed`?

### G.6 When `cooling_off` extends slot duration past 4 hours, does the pill copy change?

Currently spec'd: "Paused — retrying in 32m" (minutes). At slot ≥ 4h, "retrying in 4h 15m" gets verbose. At slot = 24h ceiling, "retrying in 23h 47m" is borderline unreadable.
**Worker H recommendation:** at >4h slots, copy becomes "Paused — next try tomorrow at 03:14" (absolute timestamp). Switchover at the 4h boundary. Keeps the duration legible.
**Owner call:** acceptable to mix relative and absolute time on the same pill copy?

### G.7 Banner colour intensity in the timeline

The auto-paused banner uses an amber tint. The `schedule.gave_up` banner uses red. Should the recovery ("Reconnected — back to normal cadence") banner be green-tinted, or should it match the surrounding row weight to stay quiet?
**Worker H recommendation:** **green-tinted, single-line.** The brief locks "recovery is celebrated quietly"; one tint-band in the timeline at the moment of recovery is the right amount of celebration without becoming a permanent decoration.

---

## H. Decision log (non-obvious choices)

1. **"Partial" not "Degraded" for amber-clean.** The word "degraded" carries failure connotation; "Partial" is honest about what happened (a portion of data flowed) without sounding broken. Linear's "Update connection" vs. "Reconnect" naming insight applied.

2. **`cooling_off` shows two affordances on the card.** This is the only state to do so. Justified by the unique user-agency moment: the system has paused, but the user can override. Hiding either affordance behind a click would make the state read as either "the system gave up" (no Try now) or "you must act now" (no clear cadence sense).

3. **`blocked` does not show the reason code on the card.** Card stays compact at six lines. The reason lives one click away in the expander. Card-level honesty is "the system stopped"; engineer-level honesty is "here's exactly why" and belongs deeper.

4. **`idle` uses `--primary` for the affordance, not status grey.** A "Connect" button in muted grey reads as a third-class option. Connecting is the *point*; the affordance is forward motion, and PDPP's protocol blue is the colour of forward motion in the brand.

5. **The Auto-paused banner spans multiple rows, not embedded in each row.** Spanning communicates "this happened across all of these failures"; embedding would imply each row independently triggered the back-off. The spanning visual mirrors the data: one `schedule.back_off.started` event followed by N skip records.

6. **No "Run now" CTA on the `cooling_off` card despite having a schedule.** "Try now" replaces "Run now" because the user's intent is different: they're not asking for a regular run, they're overriding the back-off. Same controller call, different copy. Words steer expectations.

7. **Recovery toast does not fire on `degraded → healthy`.** Gaps clearing on the next run is normal cadence, not a recovery moment. Firing here would dilute the toast's meaning — it must only fire when the system genuinely stopped working and is now working again.

8. **Streak strip in the detail header uses symbols, not bars.** Tried bars (sparkline-like) in the first iteration but they violated Worker E §7's "no sparklines on per-connector surfaces" rule and read as data viz where text would do. Symbols (`✓ ⚠ ✕ ⊘ ⏸`) are scannable, accessible to screen readers, and don't pretend to be a chart.

9. **"What's wrong?" vs. "What's missing?" depending on state.** Same expander affordance, different label by state. `degraded` opens "What's missing?", everything else opens "What's wrong?". The wording shift is small but communicates "this is a different kind of problem" without changing the underlying UI.

10. **Filled-primary "Reconnect" in expander, even though the card had a different visual weight for the same action.** Affordance weight is contextual. On a card, the "Reconnect" button is in a 320px-wide constrained space and competes with many other cards on the catalog page — outlined keeps it visually quiet across the grid. In the expander, the user has invested in understanding the problem; the durable-fix button earns primary weight.

---

## I. Future enhancements

Logged for later workstreams. None are in this design's scope.

### I.1 7-day expiring-consent warning (Plaid `PENDING_DISCONNECT` analogue)

**Brief §2:** explicitly deferred — needs consent-expiry tracking that doesn't exist yet.
**UI plan when it lands:** surface as a *banner inside the `healthy` card* (because the connector is still working today, it just won't be in a week). Worker E §8 decision 9 model. Equivalent to how Stripe Connect shows a red banner above an otherwise-functional account. Banner copy: "Your sign-in expires in 7 days — reconnect to keep this working." Banner affordance: "Reconnect" (filled primary, same affordance as `blocked`).

### I.2 "Reset back-off without running" affordance

**Brief §2 and Worker E §9 item 5:** deferred — needs a controller endpoint Worker C didn't add.
**UI plan when it lands:** lives in the kebab menu of the `cooling_off` card, as "Reset back-off". Confirmation dialog warns "This will resume normal cadence. If the underlying issue isn't fixed, the streak will start over on the next failure." Not promoted to card affordance because it's a niche operator action.

### I.3 3-presses-per-slot cap on "Try now"

**Brief §2 and Worker E §9 item 4:** UI-only debounce; deferred for empirical tuning.
**UI plan when it lands:** after 3 presses in a single back-off slot, the "Try now" button becomes "Try now (cooling off)" with a tooltip "Try now is paused until {next-slot-time}. Open the assistant or wait." Disabled state matches the card's amber palette; not red.

### I.4 Currently-running spinner badge

**Worker E §4.1:** "running is communicated by a small spinner next to the connector name or a 'running now' badge that lives independently of the health pill."
**UI plan when it lands:** 8px rotating spinner appended to the pill word — coexists with the dot, does not replace it. Rotates 1.4s per turn. Pauses on `visibilitychange: hidden`.

### I.5 Per-stream gap detail on the catalog card

Today, a `degraded` card says "1 gap"; clicking opens the expander. For connectors with multiple persistent gaps (Slack's 4 `not_available` streams), surfacing a one-line "4 streams permanently unavailable" on the card would prevent the expander from being the only path to the truth.
**UI plan when it lands:** if `known_gaps[].length >= 3` and all gaps are `unavailable_by_design`, the card surfaces "4 streams unavailable by design" with a tooltip naming them. Cap at one gap detail per card to preserve compactness.

### I.6 Catalog-level health summary

The current mocks do not include a dashboard-level "12 healthy / 1 partial / 1 needs attention" summary strip above the grid. Defer — it overlaps with the eventual operations dashboard for the protocol team (per `feedback_design_process.md` audience framing, this is operator territory, not user territory).

### I.7 Banner copy when the connector recovers via a *manual* run during cooling_off

Currently the recovery toast copy is "Reconnected — catching up on missed data". When the user clicked "Try now" themselves and it worked, "Reconnected" reads slightly off (nothing was disconnected from the user's POV; they pressed a button). Worth A/B testing alternate copy: "Working again — back to normal cadence." Deferred to copy-testing pass.

---

*End of mocks. Awaiting owner review.*

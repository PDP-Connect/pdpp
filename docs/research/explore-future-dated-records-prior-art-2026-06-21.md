# Future-dated records in a newest-first timeline — prior art (2026-06-21)

Research (deep-research workflow, 25 agents, adversarially verified, ~78 sourced
claims) into how leading timeline / activity-feed / log / finance products handle
FUTURE-DATED entries in a reverse-chronological feed. Driver: after the
semantic-time sort + display fix, the live PDPP Explore timeline opens on
future-dated rows (YNAB July/Aug 2026 budget months) ABOVE today's activity, which
Tim flagged as wrong ("data from today's date should show first"). He proposed
collapsing future rows by default with a "future" pill — this confirms and refines
the pattern.

## The convergent pattern (overwhelming consensus)
Future-dated items go in a SEPARATE, NAMED section — NEVER interleaved at the top of
a newest-first feed. The main feed is clamped to "now"/today.

- **YNAB** — not-yet-cleared items go in a **collapsible "Pending" section** of the
  register, walled off (they don't affect balances), marked with a clock icon.
  Editing one promotes it into the real register. Source: YNAB support docs.
- **Stripe** — future-dated invoices surface in a dedicated **"Scheduled"**
  section/filter with a status badge + hover tooltip (scheduled + estimated dates).
  Stripe's "upcoming invoice" is a PREVIEW, not a created object, and is EXCLUDED
  from the List-invoices endpoint that backs the feed (id prefixed `upcoming_`).
  Bounded horizon (~2–60 days out). Source: Stripe docs/API.
- **Gmail** — scheduled (future-send) mail lives in a separate **"Scheduled"**
  label, not interleaved with sent. Capped at 100 pending. Source: Gmail help.
- **Things 3** — clamps "Today" to today; all future-dated → a separate
  **"Upcoming"** list, FORWARD-chronological (soonest-first), bucketed by day, and
  AUTO-PROMOTED into Today the moment the date arrives. Later-today items demoted to
  a de-emphasized "This Evening" at the BOTTOM of Today. Source: Cultured Code docs.
- **Todoist** — future-dated tasks isolated in an **"Upcoming"** view (separate from
  Today), forward-chronological, "today" boundary, day-grouped. Overdue handled as
  its own category. Source: Todoist help.
- **Datadog / Grafana** — the time window terminates at **"now"** by default;
  viewing the future is opt-in syntax (`now+`), and some surfaces (Datadog frames,
  Grafana Alerting) DISALLOW future ranges entirely. Source: vendor docs.
- **Activity-feed design canon** (Microsoft-Teams-derived guidance) — a chronological
  activity feed is strictly reverse-chronological of actions that ALREADY HAPPENED;
  no future treatment exists because the feed is past-and-now by definition.
- **FullCalendar** — a `nowIndicator` line separates past/future on a TIME GRID, but
  that's a positional axis, not a newest-first feed; OFF by default.

## Label/copy
- Finance contexts use **"Pending"** (YNAB) or **"Scheduled"** (Stripe, Gmail).
- Task/agenda contexts use **"Upcoming"** (Things, Todoist) and **"Scheduled"**
  (Google Calendar's list view is literally named "Schedule").
- For PDPP's MIXED personal corpus (finance + messages + calendar + tasks),
  **"Upcoming"** is the best neutral umbrella; "Scheduled" skews finance/email and
  "Pending" collides with the bank meaning of in-flight (not future).

## Visual + a11y treatment
- Distinguish future entries with a **text label/pill**, not position or color alone
  (WCAG use-of-color). Badge taxonomy: a free-standing section marker that NAMES a
  state is a LABEL, not an overlaid badge.
- **Collapsed-by-default with a count** is the right call when the count drives the
  next action (YNAB collapsible; a count like "188 upcoming" is meaningful here).
- a11y: pair the badge with an `aria-label` ("188 upcoming records"); the section is
  a labeled region; while loading more, set `aria-busy="true"` on the feed container;
  `role="log"` + redundant `aria-live="polite"` for append feeds; `aria-posinset`/
  `aria-setsize` for item position. (ARIA feed pattern is silent on sort order — it's
  the app's call.)

## Decision for PDPP Explore
1. **Clamp the main timeline to today/now.** Future-dated records (semantic_time >
   today) must NOT appear above today's activity in the default feed.
2. **A dedicated "Upcoming" section, collapsed by default, with a count + pill.**
   Placed at the TOP of the feed (it's the chronological extreme of a newest-first
   list — the calendar/finance convention puts "what's next" reachable at the top),
   but collapsed so today leads visually. FORWARD-chronological inside (soonest
   future first), day-bucketed, mirroring Things/Todoist.
3. **Items auto-cross the boundary by date** (no manual promotion needed — the
   boundary is computed at render from `now`).
4. The existing burst-collapse + day-group machinery in `explore-feed-grouping.ts`
   is the natural home; add a future partition analogous to the burst partition.

Open question for the owner: top vs bottom placement of the collapsed Upcoming
section. Prior art splits — calendars/tasks anchor "now" and look forward (Upcoming
reachable at top via a forward view), while finance registers (YNAB) put Pending at
the top of the register too. Recommendation: collapsed Upcoming pill at the TOP
(one line: "▸ 188 upcoming"), expanding into a forward-chronological day-bucketed
sub-list, with Today's group immediately below it leading the main feed.

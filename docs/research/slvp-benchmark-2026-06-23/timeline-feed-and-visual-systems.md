# Timeline / Heterogeneous Record Feed — Design Benchmark & Visual Systems

**Date:** 2026-06-23
**Scope:** Reverse-chronological, heterogeneous record feed (mixed record kinds from many sources, day-grouped, newest-first, with an upcoming/scheduled section, search + filters). Benchmarked against Vercel (Geist), GitHub (Primer), Datadog/Grafana log streams, and finance timelines (Copilot Money, Monarch, YNAB, Google Calendar).
**Method:** WebSearch + WebFetch fan-out (5 parallel angles), pulling published design-system tokens from authoritative sources and product/UX teardowns. All concrete values traced to a cited URL.

---

## 0. Executive summary

- **The universal heterogeneous-row rule:** unify the row *structure*, vary only the **leading glyph**. Every benchmarked product (Vercel, GitHub, Datadog, Grafana) uses one row template — leading icon/badge changes per type, but primary text / secondary text / trailing time stay positionally fixed. This is the single most-repeated decision across all five sources.
- **Upcoming goes at the TOP, expanded, labeled "Upcoming", with a blue accent — not dimmed.** Copilot, Monarch, and YNAB all agree. Google Calendar dims *past*, not future. Collapsed-by-default is *not* the consumer-app norm — it's a defensible engineering accommodation only when the future set is huge (e.g. PDPP's 188 YNAB budget months).
- **Honest tension on day-headers:** finance apps day-group ("Today / Yesterday / date"); Vercel and GitHub's *primary* feeds deliberately do **not** — they use continuous relative-time scroll. Day-grouping is right for PDPP (multi-year, mixed-source personal corpus), but it is a deliberate departure from the dev-tool feeds, not a copy of them.
- **Anchor type scale on Geist + Primer published tokens** (Section 4). Both publish exact px/rem/weight/line-height and CSS-var color roles; values below are pulled from `vercel.com/design.md` and `@primer/primitives@11.9.0`.

---

## 1. FEED ROW design for a heterogeneous list

### The shared template (all five products)

```
[ leading glyph ]  Primary text (semibold/medium, fgColor-default)
                   Secondary text (regular, fgColor-muted) · context · source
                                                          [ trailing: relative time, muted ]
```

Only the **leading glyph** and the *content* of the text slots change between a deploy, a comment, a transaction, and a log line. Row height, the three text slots, and the trailing-time position are fixed. This is what makes a mixed list scannable.

### What leads each row — per product

| Product | Leading element | Notes |
|---|---|---|
| **GitHub notifications** | 16px **Octicon** per content type (`git-pull-request`, `issue-opened`, `comment`, `git-commit`), color-coded by state (open=green, merged=purple, closed=red) | Icon = type + state in one pre-attentive cue |
| **GitHub homepage feed** | **Actor avatar**, then `[actor] [verb] [target]` phrase | Card layout (subtle border/elevation), not flat rows |
| **GitHub PR/issue Timeline** | **Badge** (octicon in a 32px circle) for system events; **Avatar** for user-authored events | `TimelineItem--condensed` for low-signal events |
| **Vercel Activity Log** | **No icon** — user name leads; event type is a plain string label (`deployment-created`), not a colored pill | Visually homogeneous despite 200+ event types |
| **Vercel Deployments** | Status indicator (ready/building/error/canceled) at leading edge | Denser May-2026 redesign; branch + commit message are primary scannable text |
| **Datadog logs** | **Colored status badge/pill** in a dedicated leftmost `status` column (ERROR red, WARN orange, INFO green, DEBUG gray) | "status has a dedicated layout" |
| **Grafana logs** | **Thin colored vertical bar** on the row's left edge encoding log level (no text-width cost) | Level color also re-applied to the level label text (redundant coding) |

### Metadata hierarchy & subordination — the consensus mechanics

1. **Two-tier text color, always.** Primary text in the default foreground; *all* metadata (source, context, timestamp) in a single muted foreground token. GitHub: `--fgColor-default #1f2328` for titles, `--fgColor-muted #59636e` for repo name + timestamp. Geist: `gray-1000 #171717` primary, `gray-900 #4d4d4d` secondary.
2. **Relative time as trailing muted text; exact time on hover.** Vercel and GitHub both do exactly this — compact rows without losing precision. GitHub ships this as a `<relative-time>` web component that flips to "on Mon DD" for older dates and "on Mon DD, YYYY" once the date crosses a prior year, always with an ISO `datetime` attribute for a11y.
3. **Promote-to-column / progressive disclosure for the rest.** Datadog and Grafana both start metadata *subordinated* (collapsed/hidden) and let the user promote a field to a visible column. The row shows only timestamp + severity + one-line message; click expands the full structured detail in a side/inline panel.
4. **Hoist repeated metadata out of the rows.** Grafana shows "common labels" (shared by all visible rows) in a meta bar *above* the list, so repeated noise isn't reprinted on every row. Strong idea for a single-source filtered view.
5. **Condensed vs. full variant by signal level.** GitHub's clearest expression: system events (label added, assignee changed) get a smaller, background-less badge and reduced padding (`condensed`); user events (comment, review) get a full avatar + body. A way to keep low-signal records present but quiet.

### Cards vs. flat rows — the density verdict

Datadog and Grafana **decisively use columnar/list rows, not cards** — a log stream can be thousands of rows and "cards read beautifully for small sets and fall apart past a few dozen records." GitHub's *notifications inbox* is flat rows; only its *homepage social feed* uses cards (smaller volume, more narrative). **Rule:** cards for low-volume narrative feeds; flat dense rows for high-volume record streams. A personal-data record explorer is the latter → flat rows.

---

## 2. DAY GROUPING + headers

**Key honest finding — two camps:**

- **Dev-tool feeds do NOT day-group.** Vercel Activity Log = continuous newest-first scroll, relative time, **no date headers at all**. GitHub homepage feed = same (flat infinite scroll). GitHub's notifications inbox *can* group by date, but it's a non-default toggle with simple non-sticky text dividers, not a styled sticky header. The dev-tool philosophy: relative timestamps + infinite scroll, let the eye track recency without chrome.
- **Finance feeds DO day-group, consistently.** "Today" / "Yesterday" / "Weekday, Month Day" is the most consistent pattern across Copilot, Monarch, YNAB, Monzo. Recent first, relative labels for the two nearest days, then full date.

**Recommendation for a multi-year, mixed-source personal corpus:** follow the **finance camp** (day-group), not the dev-tool camp. The dev-tool no-header approach works when everything is "recent" (deploys from the last days/weeks); a personal corpus spans years, so day headers are load-bearing wayfinding. This is a *deliberate* departure — note it as such.

**Day-header styling guidance (synthesized):**

- Labels: `Today` / `Yesterday` for the two nearest days; then `Weekday, Month Day` (e.g. `Monday, June 16`). **Include the year for a multi-year corpus** (`Thursday, June 19, 2026`) — consumer apps omit it (current-year assumption), but a multi-year personal archive must disambiguate.
- Weight/size: a small, muted, semibold caption — Primer `--text-caption` (12px / weight bumped to semibold) or Geist `label-13` in `gray-900`. Headers should be *quieter* than row primary text, not louder — they're structure, not content.
- **Count per group is optional and finance apps mostly omit it.** Add a count only if it earns its place (e.g. group totals in a money view). Don't reflexively badge every header with a count.
- **Sticky:** no source documents sticky date headers as a default. Sticky is defensible for long scrolls (keeps "which day am I in" answered) but is an addition beyond observed prior art — treat as an enhancement, test it, don't assume it.

---

## 3. UPCOMING / SCHEDULED / future-dated section — strongest prior art

This is the highest-confidence section: Copilot, Monarch, and YNAB **independently converge**.

### The converged pattern

| Decision | Industry standard | Evidence |
|---|---|---|
| **Placement** | **TOP of the feed, above past** (a newest-first feed reads future→present→past) | Copilot dashboard upcoming strip; Monarch "Upcoming" above "Complete"; YNAB scheduled float above the "today" line |
| **Label** | **"Upcoming"** (dominant). "Scheduled" is YNAB's term. "Future" is system-speak, never user-facing | Copilot, Monarch use "Upcoming" |
| **Internal order** | **Forward-chronological** (soonest first: Tomorrow before next week) — opposite of the past feed's newest-first | All apps |
| **Visual treatment** | **Full color with a distinct accent (usually blue), NOT dimmed.** Dimming is reserved for *past* events (Google Calendar) | Monarch blue dots/highlights for unpaid; Calendar dims past |
| **Separator** | **A named section header** ("Upcoming") — sometimes plus a rule. No app uses an unlabeled divider alone; the label is essential | Monarch, Copilot, YNAB |
| **Collapsed by default** | **No** in consumer apps — shown expanded. Collapse-with-count is a *pragmatic* choice only when the future set is large enough to bury today | Copilot/Monarch/YNAB expanded; PDPP's collapse-pill is a sound accommodation for 188 budget months, not the consumer default |

### Rationale (why top, why not dimmed)

Upcoming items are **action-oriented** (a bill to pay, a budget to fund) while past items are **read-only history**. Putting upcoming at the top and giving it an accent (not a dim) reflects that it *needs attention*. Dimming would signal "ignore me," which is wrong for a future obligation. Google Calendar's agenda view is the inverse proof: it dims the *past* ("don't waste screen space on past events") and shows the future at full strength.

### Strongest single model to copy

**Monarch Money's Recurring page** is the cleanest reference: mini-calendar at the very top → **"Upcoming" section (forward-chronological, blue accent)** → **"Complete" section (past, full weight)** below, each introduced by a bold labeled section header. It nails placement, label, order, accent, and separator in one screen.

**For PDPP specifically:** keep upcoming at the top with the label and true count, but the **collapse-by-default pill** ("▸ 188 upcoming · scheduled / future-dated") is the *correct* deviation from the consumer norm — when the future set can be hundreds of synthetic rows (YNAB budget months), expanding it by default would bury "today." Document it as a deliberate, count-bearing accommodation, not an oversight.

---

## 4. VISUAL SYSTEM — concrete Geist + Primer tokens

### 4A. Vercel Geist

**Source:** `https://vercel.com/design.md` (machine-readable token spec), `vercel.com/geist/typography`, `/colors`, `/spacing`.

**Three weights only:** 400 (read / body), 500 (interact / buttons), 600 (announce / headings). No letter-spacing on labels/copy/buttons; headings compress aggressively (-4.32px at 72px → -0.28px at 14px).

**Typography — the tokens you'd use in a feed row** (full scale in source):

| Token | Size | Line-height | Weight | Use in a feed |
|---|---|---|---|---|
| `heading-16` | 16px | 24px | 600 | day-header / section title |
| `heading-14` | 14px | 20px | 600 | compact section title |
| `label-14` | 14px | 20px | 400 | row primary text (single-line) |
| `label-13` | 13px | 16px | 400 | dense row primary |
| `copy-14` | 14px | 20px | 400 | row body (multi-line) |
| `copy-13` | 13px | 18px | 400 | secondary/metadata line |
| `label-13-mono` | 13px | 20px | 400 | **monospace** — IDs, hashes, amounts |
| `label-12-mono` | 12px | 16px | 400 | **monospace** — timestamps, codes |

**Color — text hierarchy (light theme, sRGB hex):**

| Role | Token | Hex |
|---|---|---|
| Primary text/icons | `gray-1000` (`primary`) | `#171717` |
| Secondary text/icons | `gray-900` (`secondary`) | `#4d4d4d` |
| Tertiary / disabled text | `gray-700` | `#8f8f8f` |
| Default border | `gray-400` | `#eaeaea` |
| Hover border | `gray-500` | `#c9c9c9` |
| Default background | `background-100` | `#ffffff` |
| Subtle background | `background-200` | `#fafafa` |
| Link / accent / focus | `blue-700` | `#006bff` |
| Success | `green-700` | `#28a948` |
| Warning | `amber-700` | `#ffae00` |
| Error | `red-700` | `#fc0035` |

Focus ring: `box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #006bff`.

**Spacing — base 4px, sparse scale** (5/7/9 intentionally absent):

| Step | px | rem | Use |
|---|---|---|---|
| 1 | 4 | 0.25 | icon gap, tight padding |
| 2 | 8 | 0.5 | inside a group |
| 3 | 12 | 0.75 | row vertical padding |
| 4 | 16 | 1.0 | between groups |
| 6 | 24 | 1.5 | card padding |
| 8 | 32 | 2.0 | between sections |
| 10 | 40 | 2.5 | default control height |

**Radius:** `rounded-sm` 6px (inputs/buttons), `rounded-md` 12px, `rounded-lg` 16px, `rounded-full` 9999px (pills).

### 4B. GitHub Primer

**Source:** `@primer/primitives@11.9.0` dist CSS; `primer/react` Timeline + ActionList; `primer.style/foundations`.

**Base text sizes:** `xs` 12px, `sm` 14px, `md` 16px, `lg` 20px, `xl` 32px, `2xl` 40px.
**Base weights:** light 300, normal 400, medium 500, semibold 600.

**Functional typography tokens — feed-relevant:**

| Token | Size | Weight | Line-height | Use |
|---|---|---|---|---|
| `--text-title-medium` | 20px | 600 | 1.625 | page/section title |
| `--text-title-small` | 16px | 600 | 1.5 | sub-section / day header |
| `--text-body-large` | 16px | 400 | 1.5 | row primary (roomy) |
| `--text-body-medium` | 14px | 400 | 1.5 | **default UI / row primary** |
| `--text-body-small` | 12px | 400 | 1.625 | helper/footnote |
| `--text-caption` | 12px | 400 | 1.25 | single-line meta (day header label) |
| `--text-codeInline` | 0.9285em | 400 | — | inline mono |

**Color — text hierarchy (light theme hex):**

| Role | CSS variable | Hex |
|---|---|---|
| Primary text / headings | `--fgColor-default` | `#1f2328` |
| Secondary / metadata text | `--fgColor-muted` | `#59636e` |
| Disabled text | `--fgColor-disabled` | `#818b98` |
| Link / accent | `--fgColor-link` / `--fgColor-accent` | `#0969da` |
| Danger / closed | `--fgColor-danger` | `#d1242f` |
| Success / open | `--fgColor-success` | `#1a7f37` |
| Attention / warning | `--fgColor-attention` | `#9a6700` |
| Done (merged) | `--fgColor-done` | `#8250df` |
| Default background | `--bgColor-default` | `#ffffff` |
| Muted / grouped background | `--bgColor-muted` | `#f6f8fa` |
| Tag/label background | `--bgColor-neutral-muted` | `#818b981f` |
| Default border | `--borderColor-default` | `#d1d9e0` |
| Muted separator | `--borderColor-muted` | `#d1d9e0b3` |

> Note: Primer has **no `--fgColor-subtle`** — its text hierarchy is `default` / `muted` / `disabled` (three tiers). `subtle` exists only for *backgrounds*.

**ActionList anatomy (the heterogeneous-row primitive):**

```jsx
<ActionList showDividers>
  <ActionList.Group>
    <ActionList.GroupHeading as="h3">Day header</ActionList.GroupHeading>
    <ActionList.Item onSelect={...} variant="default|danger" size="medium|large">
      <ActionList.LeadingVisual><Icon /></ActionList.LeadingVisual>   {/* icon OR avatar OR empty */}
      Primary text
      <ActionList.Description variant="inline|block" truncate>Secondary text</ActionList.Description>
      <ActionList.TrailingVisual>relative time</ActionList.TrailingVisual>
    </ActionList.Item>
  </ActionList.Group>
  <ActionList.Divider />
</ActionList>
```

- **Heterogeneous leading visuals are first-class:** items with icons, avatars, or no leading visual coexist; the slot container handles alignment, unset slots are simply absent.
- `Description variant="inline"` = beside primary text; `"block"` = below. `truncate` clips inline overflow.
- `Group` + `GroupHeading` + `Divider` (or `showDividers`) = the day-grouping primitive.

**Timeline anatomy (canonical event rail — CSS from `Timeline.module.css`):**

- `.TimelineItem`: `display:flex; padding: var(--base-size-16) 0; margin-left: var(--base-size-16)`; connector is a `::before` — `width:2px; background:var(--borderColor-muted)` running full height.
- `.TimelineBadge`: 32×32 circle, `border-radius:50%`, thick border in `--bgColor-default`, `color:var(--fgColor-muted)`, `margin-left:-15px` to overlap the rail.
- **Condensed** (`data-condensed`): `padding-top:4px; padding-bottom:0`, badge shrinks to 16px, loses border. → low-signal events.
- `.TimelineBody`: `font-size:var(--text-body-size-medium); color:var(--fgColor-muted)`.
- Badge `data-variant`: `accent / success / attention / severe / danger / done / open / closed / sponsors` → emphasis bg + `--fgColor-onEmphasis` (#fff) text.
- `clipSidebar="start|end|both"` trims the connector at the first/last item.

### 4C. Monospace usage rules (both systems agree)

Monospace is for **machine-format, fixed-width values only**, never prose:
- **Timestamps** (Geist `label-12-mono`; Datadog/Grafana fixed-width ISO/epoch columns — required to keep columns aligned across rows).
- **IDs, hashes, commit SHAs, codes** (Geist `label-13-mono`).
- **Amounts / money** where column alignment matters (tabular figures).
- **Log/code bodies and JSON** (Grafana prettifies JSON in mono).
- **Never** for row titles, descriptions, or human-readable labels — those stay in Geist Sans / Mona Sans.

---

## 5. MOBILE adaptation

- **Vercel** explicitly improved Deployments-list scan-ability on mobile in the May-2026 redesign — denser rows, environments grouped with statuses, branch/commit as the primary scannable text. The columnar desktop view collapses to a stacked single-column row on narrow screens.
- **Datadog/Grafana** columnar tables don't translate cleanly to phones; the standard adaptation is to drop non-essential columns and keep severity-glyph + timestamp + one-line message, with detail in a full-screen drawer on tap (progressive disclosure does the heavy lifting on mobile).
- **Finance apps** are mobile-first: the day-grouped list with "Today/Yesterday/date" headers and the top "Upcoming" section is *the* mobile pattern — single column, full-width rows, tap-row → full-page detail. (Matches PDPP's existing mobile master-detail push-nav.)
- **General rule:** on mobile, keep the leading glyph + primary text + trailing relative-time; demote secondary metadata to a second line or into the tap-through detail. Don't try to preserve desktop columns — collapse to the three-slot row template.

---

## 6. PRINCIPLES TO STEAL (heterogeneous day-grouped feed)

1. **One row template; vary only the leading glyph.** Lock primary-text / secondary-text / trailing-time positions; let only the leading icon (and text content) change per record kind. (Vercel, GitHub, Datadog, Grafana — unanimous.)
2. **Lead with a type+state glyph, not a colored pill.** A 16px icon (optionally state-colored, à la GitHub octicons: open=green/merged=purple/closed=red) carries type *and* status pre-attentively in one element. Reserve colored badges for a small fixed enum like severity (Datadog status column).
3. **Two-tier text color is the whole hierarchy.** Primary in default foreground (`#171717` Geist / `#1f2328` Primer), *all* metadata in one muted token (`#4d4d4d` Geist gray-900 / `#59636e` Primer muted). Don't invent a third text color for rows.
4. **Relative time, trailing, muted; exact on hover.** Compact rows, no precision lost. Flip to absolute date past a year boundary (GitHub `relative-time` behavior). Always emit an ISO `datetime` for a11y.
5. **Progressive disclosure: minimal row, rich detail on open.** Row = glyph + one-line summary + time. Everything else (full attributes, raw JSON, relationships) lives in the tap/click detail panel. (Datadog/Grafana promote-to-column + side panel.)
6. **Hoist repeated metadata above the list, don't reprint per row.** In a single-source/filtered view, surface shared labels once in a meta bar (Grafana "common labels").
7. **Condensed variant for low-signal records.** Keep noisy system-ish records present but quiet (smaller/borderless leading visual, tighter padding) vs. high-signal records (full avatar + body). (GitHub `TimelineItem--condensed`.)
8. **Flat dense rows, not cards, for a high-volume record stream.** Cards are for low-volume narrative feeds; a years-deep mixed corpus is a stream → flat rows (Datadog/Grafana doctrine).
9. **Day-group with relative-then-absolute headers, quieter than row text.** `Today` / `Yesterday` / `Weekday, Month Day, Year`. Caption-sized, muted, semibold. Include the **year** (multi-year corpus). This is the finance pattern, a deliberate departure from dev-tool no-header scroll — justified by multi-year span.
10. **Monospace only for machine values** (timestamps, IDs, hashes, amounts, code/JSON) — never for titles or prose. Use tabular figures so amounts/times align down the column.
11. **Three font weights max** (400 body / 500 interactive / 600 headings — Geist's discipline). Resist a fourth; weight + color + size already give enough hierarchy.
12. **Calm dense lists via restraint, not chrome:** thin muted dividers (`--borderColor-muted #d1d9e0b3` / Geist `gray-400 #eaeaea`), 12px row vertical padding, single accent color (`#006bff` / `#0969da`) used sparingly for links/focus only. Let whitespace and the two-tier color do the work.

---

## 7. The upcoming/scheduled-section pattern — recommendation

**Adopt the converged finance pattern (Monarch as the model):**

- **Top of feed**, above the newest-first past records (the feed reads future → today → past).
- **Label "Upcoming"** with the **true count** ("Upcoming · 188").
- **Forward-chronological inside** (soonest first), with its own day sub-headers ("Tomorrow", "Wednesday, July 1").
- **Accent, not dim** — a blue accent (`#006bff` / `#0969da`) marks "needs attention"; reserve dimming for *past* if anything.
- **Labeled section header as the separator** (a label is mandatory; an unlabeled rule alone is never used).
- **Collapse-by-default ONLY when the set is large** (PDPP's pill for 188 budget months is the correct deviation; consumer apps show it expanded). The count must be honest and visible whether collapsed or expanded.

---

## 8. Sources (all cited)

**Vercel / Geist**
- https://vercel.com/design.md (machine-readable Geist token spec — primary source for type/color/space)
- https://vercel.com/geist/typography
- https://vercel.com/geist/colors
- https://vercel.com/geist/spacing
- https://vercel.com/docs/activity-log
- https://vercel.com/changelog/redesigned-deployments-list (May 27, 2026)
- https://vercel.com/changelog/dashboard-navigation-redesign-rollout
- https://vercel.com/docs/deployments/managing-deployments
- https://designmd.cc/benchmarks/vercel

**GitHub / Primer**
- `@primer/primitives@11.9.0` dist CSS (base typography, base size, functional typography, light-theme color)
- https://primer.style/foundations/typography
- https://primer.style/foundations/color
- https://primer.style/foundations/primitives/color
- https://primer.style/components/action-list
- https://primer.style/product/components/action-list/
- https://primer.style/components/timeline-item
- https://primer.style/product/components/relative-time/
- https://primer.style/product/components/label/
- `primer/react` Timeline.tsx + Timeline.module.css (component source)
- https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/viewing-and-triaging-notifications/managing-notifications-from-your-inbox
- https://github.blog/changelog/2025-02-14-reverting-feed-activity-sorting-back-to-chronological-ordering/
- https://geeksforgeeks.org/primer-css-timeline

**Datadog / Grafana**
- https://docs.datadoghq.com/logs/explorer/
- https://docs.datadoghq.com/logs/explorer/visualize/
- https://docs.datadoghq.com/logs/log_configuration/attributes_naming_convention/
- https://grafana.com/docs/grafana/latest/explore/logs-integration/
- https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/logs/

**Finance / Calendar**
- https://help.copilot.money/en/articles/6045480-dashboard-tab-overview
- https://help.copilot.money/en/articles/9554412-transactions-tab-overview
- https://help.copilot.money/en/articles/9778259-recurrings-tab-overview
- https://help.monarch.com/hc/en-us/articles/4890751141908-Tracking-Recurring-Expenses-and-Bills
- https://www.monarch.com/blog/track-recurring-bills-and-subscriptions
- https://help.monarch.com/hc/en-us/articles/29446697869076-Getting-Started-with-Bill-Sync
- https://support.ynab.com/en_us/scheduled-transactions-a-guide-BygrAIFA9
- https://medium.com/design-bootcamp/from-confusion-to-clarity-improving-transaction-history-ux-2e43f2838954
- https://www.eleken.co/blog-posts/calendar-ui
- https://www.eleken.co/blog-posts/modern-fintech-design-guide

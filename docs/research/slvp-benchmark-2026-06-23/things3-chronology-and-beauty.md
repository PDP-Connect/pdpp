# Things 3 Design Benchmark: Chronology + Beauty
**Date:** 2026-06-23
**Purpose:** Collect concrete design evidence from Things 3 (Cultured Code) — best-in-world for day-grouped chronological lists with Today/Upcoming sections — to anchor the Explore surface redesign.

---

## TL;DR (10-line summary)

Things 3 wins two Apple Design Awards by making one radical bet: **the present is always primary, the future is explicitly separated, and the past is gone.** Its Upcoming section shows the next 7 days individually (forward-chronological, day-by-day) then collapses further future into week- and month-level buckets — preventing future items from burying today's work. Every row is composed of a round checkbox, a title, and almost nothing else — metadata (tags, deadline, notes indicator) is visible only when the row is expanded. Typography uses the system font (SF Pro) at exactly two or three sizes with weight contrast as the only hierarchy tool. The restrained palette — white backgrounds, careful grays, brightly-colored area icons, and a signature blue for the app's interactive accent — creates calm through **color constraint, not color elimination**. Animation is custom-built, purposeful, and pervasive: every state change (task completion, drag, section expand) has a satisfying micro-interaction, but none linger. On iPhone, there is one list on screen at a time; no split panes, no bottom sheets — full-screen nav push for detail. The result is an app Craig Mod described as "one of the most tactile, fast-as-you-can-move apps around" and Marius Masalar called "the most beautiful Mac and iOS app I have ever used — full stop."

---

## 1. The Today / Upcoming / Scheduled Model

### Mental model: temporal zones

Things 3 partitions tasks into four named temporal zones. These are not arbitrary labels — they encode a contract with the user about "what you can and cannot act on right now":

| Zone | Contains | Ordering |
|------|----------|----------|
| **Today** | Items whose start date is today; includes a "This Evening" subsection | User-defined within the day |
| **Upcoming** | Items with a future start date, hibernating until their date arrives | Forward-chronological (earliest first) |
| **Anytime** | Items with no start date — available whenever | User-defined |
| **Someday** | Items explicitly deferred with no commitment | User-defined |

**The critical insight:** future-dated items *disappear* from all action-oriented views (Today, Anytime) and only live in Upcoming. The user never sees a future item mixed into their present-day work. This is the exact pattern Explore's Upcoming section implements: a hard temporal partition so the 188 YNAB future-dated budget months do not bury today's real activity.

### Today structure (in order, top to bottom)

1. **Calendar events** — pulled from Apple Calendar, grouped as a block at the top. Visual distinction: they are styled differently (event shape vs. task row) and carry time information.
2. **Today tasks** (main list) — the tasks the user decided to do today.
3. **This Evening** — a named subsection at the bottom. Items placed here are still visible but quieted: "still present, so you know there's more to do, but unobtrusive enough to not bother you until you have time." This is a sub-header within the same screen — not a separate view.

### Upcoming structure (in order, top to bottom)

- **Days 1–7** (tomorrow through 7 days out): each day gets its own labeled section with a date header. Day headers within Upcoming follow the format **"Tomorrow"**, then specific weekday names + dates (e.g., "Monday, June 30") rather than relative labels. Items are listed under each day header.
- **Beyond 7 days**: Items are grouped **week by week**, then **month by month** as you go further out. This progressive bucketing prevents the list from becoming an overwhelming infinite scroll of daily slots. "A bird's-eye view of tasks further out in the future" is the explicit design intent.
- The entire Upcoming list is **strictly forward-chronological** — earliest dates at top.

### Key design decisions in the Today/Upcoming split

1. **Hard cut, not a gradient.** Items either ARE in Today or are NOT. There is no "upcoming soon" row mixed into Today. The only signal of future items within Today is a deadline badge (a red dot/flag indicator visible on today-active tasks).
2. **Future items hibernate.** A task with a future start date literally disappears from the sidebar and main lists until its date arrives. This is a behavioral guarantee, not just a visual convention.
3. **"This Evening" is the only sub-day granularity.** Things does not offer morning/afternoon/evening/night slots. The single binary split (Now vs. This Evening) is explicitly chosen to prevent over-scheduling anxiety.
4. **Upcoming is a separate navigation destination**, not a section within Today. The user taps "Upcoming" in the sidebar to enter a different view entirely. This is a stronger separation than an in-page collapsed section.

---

## 2. Visual Craft and Beauty (Why It Wins Design Awards)

### Typography

- **System font**: Things uses SF Pro (Apple's system font) exclusively. No custom typeface. The beauty comes from how it is used, not which font is chosen.
- **Scale**: Effectively 3 sizes: large for section/view titles (nav-level), medium for task titles (the primary reading text), small for metadata (tags, date chips, notes indicators). MacStories notes the typography "renders a unique blend of proportional and fixed-width fonts" when markdown is used in notes (SF Pro + SF Mono), but task titles are always proportional.
- **Weight contrast**: Section headers (e.g., "Today", "This Evening") are set at a heavier weight than task titles, which are set at regular weight. Metadata is lighter/smaller still. Weight, not color, does the hierarchical work.
- **Generous line height / vertical breathing**: Rows are taller than the text alone requires. The visual rhythm comes from padding, not size.

### Color palette

- **Background**: White (light mode). No tinted backgrounds on list surfaces.
- **Text**: Near-black primary (task titles), medium gray for metadata and secondary text.
- **Accent**: Things blue — a medium, saturated blue — is used for interactive elements, links, and the app's checkboxes/completion indicators. It is the only strong hue on list surfaces. The blue is distinctive and instantly recognizable — described by the OS 26 release notes as "Things' iconic blue box."
- **Area/project icons**: Brightly colored (teal, orange, purple, green, etc.) — these are the primary splashes of color in the interface. The vibrancy of the icons makes the sidebar feel alive and personalized without adding color to the data itself.
- **No tinting of task rows**: Task rows have no background color, no alternating row tints, no status-color-coding of individual rows. Color is reserved for icons (sidebar) and the interactive state (checkbox when completing). This restraint is what makes the list feel calm.

### Spacing and vertical rhythm

- The 2025/2026 OS 26 refresh explicitly increased spacing: "wider spacing that feels a bit more relaxed." This is a deliberate direction, not an accident.
- Section headers (day headers in Upcoming, "Today"/"This Evening" in Today) have substantial top padding that creates a visible gutter between sections — the eye immediately groups items under their header.
- Row height is generous. Tasks are not packed tightly. A single task row is tall enough to be an easy tap target (Apple HIG: 44pt minimum) and to have breathing room above and below the title text.
- No horizontal rules or separator lines between individual rows — the spacing alone creates the separation. Separators appear only at section boundaries, and even then they are hairline-thin or implemented as spacing-only gaps.

### Depth and surfaces

- Flat-ish hierarchy: task lists live on a single white plane. No card shadows on individual rows.
- The task detail view (when expanded) rises "up out of the background as a card-like object" — a sheet that comes forward, not a navigation push. On Mac, this is a sheet overlay; on iPhone, it is a modal card.
- Sidebar (Mac/iPad) has a subtle material treatment — the OS 26 version adds "a touch of glass in the sidebar that lets a hint of color shine through" — but the list content area remains clean and flat.

### What "minimal decoration" means concretely

The IXD@Pratt critique enumerates the affordances visible in a task row by default: a circular checkbox (round, not square) and the task title. That is it. Notes indicator, tags, date chips, and deadline badge are all visible only when relevant — and even then they appear in subordinate scale. The instruction to the designer is: **if it can be absent without loss, it should be absent by default.**

---

## 3. List Row Design

### Row anatomy (collapsed state)

```
[○] Task title text                    [optional: deadline 🔴]
```

- **Left**: A circle (not a square, not a checkbox) — the completion control. Round shape is softer, less "form-like." Tapping it completes the task with a satisfying check animation + haptic feedback.
- **Center**: Task title at medium weight regular SF Pro. This is the only text that gets full visual weight.
- **Right**: Deadline indicator (a colored dot or flag icon) if a deadline exists and is approaching/overdue. Otherwise empty.
- There is no visible source label, no category badge, no timestamp on the collapsed row.

### Row anatomy (expanded / detail state)

```
[○] Task title text
    Notes (gray, smaller)
    [tag chip] [tag chip]    [When: date chip]    [Deadline: date chip]
    [Checklist sub-items...]
```

- Metadata appears *below* the title, indented, at a smaller size and lighter color.
- The notes field appears first (if any) — it is free text and contextual.
- Tags, date, and deadline chips appear inline on a single metadata row — pill-shaped, with a light background.
- This expansion is revealed by tapping the row — the row physically grows in place. Nothing navigates away for simple viewing.

### Design principles in row anatomy

1. **Title dominates.** Everything else is subordinate in both size and color.
2. **Metadata on demand.** The collapsed row shows ≤1 accessory item (deadline indicator only if urgent). Everything else requires expansion.
3. **Left-anchored.** The eye travels down the left column (checkboxes), hits the title, moves on. No complex multi-column layout.
4. **No timestamps in the list.** Unlike a data feed or email client, Things task rows show no "created at" or "modified at" timestamps. This is intentional: temporal anchoring happens at the section/day-header level, not at the row level.

---

## 4. Interaction Feel

### The Magic Plus

The floating action button in Things 3 is called the "Magic Plus." Its behavior is the canonical example of thoughtful mobile interaction design:

- **Tap**: Creates a new to-do at the bottom of the current list.
- **Long-press and drag**: The button becomes draggable. As the user drags, insertion-point indicators appear between rows, between sections, and in the sidebar (Inbox target). Release drops a new to-do at exactly that position.
- **Drag to left margin (in a project)**: Creates a heading — a structural element — rather than a task. The gesture encodes semantic intent (heading vs. task) through direction.
- **Drag to Inbox target (sidebar)**: Creates a new Inbox item without leaving the current view.

The Magic Plus teaches everything through direct manipulation: there is no separate "insert above" or "insert below" menu. The gesture is "pinch-to-zoom all over again" — obvious in retrospect, invisible until you discover it.

### Animation philosophy

- **Custom-built toolkit**: Cultured Code built their own animation framework to control every transition. They do not use stock UIKit animations.
- **Every state change is animated**: Task completion (circle fills, row fades, optional bounce), drag (item lifts with shadow), section transitions, list-to-detail, sidebar highlighting. MacStories noted that "each interface gesture invokes subtle, deeply satisfying animations."
- **Short durations**: Animations are quick — they add personality without slowing the user down. Craig Mod's quote — "one of the most tactile, fast-as-you-can-move apps around" — specifically highlights speed.
- **Purposeful, not decorative**: Motion always communicates state change (completion, move, arrival). There are no ambient/idle animations.
- **Haptic feedback**: Task completion triggers a haptic pulse (vibration) on iPhone. This is non-visual confirmation — you feel the task leave your list.

### Detail transition (iPhone)

- Tapping a task row does NOT navigate to a new screen. Instead, the row expands in place (grows downward) to reveal detail fields.
- This is a key contrast to navigation-based designs: the list never disappears. Context is preserved.
- On iPhone, the full-page task list is the primary surface; you stay in it throughout the editing interaction.

---

## 5. Mobile (iPhone) Specifics

### Single-column, full-screen list

- On iPhone, the app shows one list at a time. No split pane (that is iPad territory). The navigation model is: sidebar list → tap a section (Today, Upcoming, etc.) → full-screen task list → tap a task → row expands in place.
- There is no visible sidebar on iPhone; navigation is a modal panel (swipe from left or tap a hamburger-equivalent).
- Section labels ("Today", "This Evening", day headers in Upcoming) span the full width of the screen as left-aligned large-ish text. They feel like natural document headings.

### Touch targets and density

- Row heights accommodate comfortable finger taps. Apple HIG minimum is 44pt; Things rows are at or above this.
- The Magic Plus button is fixed-position at the bottom-right — the primary thumb zone on iPhone. This is the only persistent UI chrome aside from the navigation title bar.
- No horizontal swipe gestures on rows (Things does not use swipe-to-complete on the main list — the tap-the-circle paradigm is primary). This avoids accidental completions during list scrolling.

### Day headers on iPhone (Upcoming view)

- Each day section header in Upcoming reads: **"Tomorrow"** for the next day, then specific dates for days 2–7 (e.g., "Monday, Jun 30"). The weekday name is prominent; the date is subordinate.
- Section headers are left-aligned, set larger than task text, with a strong top margin that visually groups the tasks beneath each header.
- Empty days (no tasks scheduled) still show their header — so the user can see the full week structure at a glance, even if some days are empty. (This differs from dense data feeds that omit empty date buckets.)

### Calm through reduction

The Block 81 review's summary is precise: Cultured Code has done "an amazing job at trimming away all the visual fat." On mobile specifically this means:
- No sub-navigation tabs or filter bars in the default list view.
- No visible metadata on collapsed rows.
- No pull-to-refresh visual (data is local).
- No skeleton loaders (data is local).
- No ads, upsells, or banner notifications within the list.
- The only persistent UI element is the section title (e.g., "Today") in the navigation bar and the Magic Plus button.

---

## 6. Principles to Steal (8–12 Concrete, Replicable Decisions)

### P1: Hard temporal partition — "Upcoming" is a separate destination, not a section

Do not mix future-dated records into the main reverse-chronological feed even as a subordinate section. Give Upcoming its own entry point (or a clearly demarcated collapsed pill at the top). Once expanded, it is a fully different view with its own ordering (forward-chrono). **Applied to Explore:** the "188 upcoming" collapsed pill is the right call; expanding it should feel like entering a different temporal context, not just continuing the same feed downward.

### P2: 7-day individual + week/month bucketing for future items

For the first 7 days of the future zone, show each day individually under its own header (Tomorrow → Monday → Tuesday…). Beyond 7 days, bucket by week, then by month. This gives high granularity where it matters (the near future) and bird's-eye compression for the far future. **Applied to Explore:** apply this progressive bucketing to the expanded Upcoming section rather than showing every future day slot.

### P3: "This Evening" — sub-day sections are one split only

If you need to split a single day into sub-sections (e.g., "past events in today's feed" vs. "upcoming this afternoon"), make the split exactly once. Things uses exactly one: Now vs. This Evening. Do not fragment into morning/afternoon/evening/night. **Applied to Explore:** within the Today section, a single split between "earlier today" and "later today" (if needed) is the maximum; don't over-segment.

### P4: Section headers as document headings, not chrome

Day/section headers should be styled as first-class content — left-aligned, set at a notably larger size than task titles, with generous top-padding that makes the grouping obvious. They should feel like document headings, not data table headers. **Applied to Explore:** the existing day headers in the feed should increase top padding and be visually heavier than they are; they should feel like chapter markers, not category labels.

### P5: Round checkbox as the single left anchor

Every row leads with a round, tappable completion indicator. The eye travels down the left column of circles, then reads the titles. This creates a predictable visual rhythm. **Applied to Explore:** the leftmost element in every record row should be a consistent fixed-width glyph (source icon or a type indicator) that the eye can skip over uniformly, like Things' checkboxes.

### P6: Title only on the collapsed row — metadata on demand

Do not show tags, timestamps, categories, or secondary metadata in the collapsed list row. Show only: glyph + title + (at most one) urgency indicator. Reveal the rest on tap/expand. **Applied to Explore:** the current design showing source label, date, tags, and content preview all at once on every row is the anti-pattern. A collapsed row should be: source-icon + record title + one data point (time-ago). The full preview expands on tap.

### P7: No row background tinting — color is for icons and accents only

Task rows in Things have no background color, no alternating shading, no status-color-coded backgrounds. Color lives in icons (sidebar), the completion accent (blue), and deadline indicators. **Applied to Explore:** strip row-level background color variations. If source-type needs visual identity, put it in the source icon, not the row background.

### P8: One accent color, used for interactive elements only

Things uses a specific blue for the primary interactive element (the completion circle) and interactive accents. Everything else is black/gray/white. **Applied to Explore:** the interactive accent (links, active filters, focus states) should be a single consistent color. If the current design uses multiple accent colors for different source types within the feed, consolidate to one.

### P9: Day headers for empty days — don't suppress structure for missing data

In Upcoming, Things shows day headers even for days with no tasks (so the weekly structure is always visible). **Applied to Explore:** in the Upcoming section of the feed, show day headers even for days with no records — the user needs to see the temporal skeleton, not just the filled slots.

### P10: Magic Plus lesson — direct manipulation over menus

The signature interaction is a draggable FAB that removes the need for insertion menus. The principle is: if a user wants to place something at a specific position, let them physically drag to that position. **Applied to Explore:** any "filter by date" or "jump to date" interaction should prefer a direct scrubber/drag over a modal date-picker menu.

### P11: Custom animation toolkit — own your motion

"Beautiful animations. Everything you do in Things is nicely animated for pop. This is achieved with our own, custom-built animation toolkit." Generic CSS transitions read as generic. If Explore aims to feel premium, the day-group appear, the Upcoming expand, and the row-expand animations need explicit, deliberate timing curves — not `transition: all 0.2s ease`. **Applied to Explore:** define 2–3 named animation tokens (duration + easing) for structural transitions and use them consistently.

### P12: Haptic feedback for completions (mobile)

Tapping the completion circle triggers a haptic pulse. The task leaves without only a visual change — you feel it. **Applied to Explore:** if/when records can be marked (archived, dismissed, annotated), trigger haptic feedback on mobile. This is what "tactile" means.

---

## 7. The Today/Upcoming Pattern in Detail (Best Prior Art for Explore)

### How Things solves the "future items burying the present" problem

The exact mechanism:
1. When a task gets a future start date, it **immediately disappears** from Today and Anytime.
2. It appears only in **Upcoming**, which is a distinct navigation destination.
3. The Upcoming view shows **tomorrow first**, then the next 6 days individually, then week buckets.
4. When the start date arrives, the task **automatically appears in Today** — "a gentle nudge of commitment."
5. The user can glance at Upcoming to plan their week, but it never contaminates their daily work view.

### Translating to Explore

Explore's 188 YNAB budget-month records are exactly analogous to Things 3's scheduled-but-not-yet-active tasks. The correct pattern (which the current implementation follows, per the MEMORY notes) is:

- Main feed: **reverse-chronological**, bounded to `nowCeiling` — records from the past and present.
- At the top: a **collapsed Upcoming pill** with the count of future-dated records.
- Expanding the pill: enter a **forward-chronological** view, day-bucketed, starting with tomorrow.
- The Upcoming view should use the 7-day granular + week/month bucketing pattern from Things.
- Day headers in Upcoming: **"Tomorrow"**, then **"[Weekday], [Month Day]"** — not ISO dates, not "2 days from now."

### Header label format table (derived from Things' pattern)

| Relative distance | Things format | Recommended Explore format |
|-------------------|---------------|---------------------------|
| Today | "Today" | "Today" |
| Yesterday | — (past; Today/Logbook) | "Yesterday" |
| 2–6 days ago | Full date | "[Weekday], [Month] [Day], [Year]" |
| Tomorrow | "Tomorrow" | "Tomorrow" |
| 2–7 days out | "[Weekday], [Month] [Day]" | "[Weekday], [Month] [Day], [Year]" |
| 8–28 days out | "Next Week", "In 2 Weeks", etc. | "Week of [Month] [Day]" |
| 1–11 months out | "[Month]" | "[Month] [Year]" |
| 12+ months out | "[Year]" | "[Year]" |

---

## 8. Visual Calm Techniques for Explore to Adopt

Things 3 is specifically described by reviewers as "not messy or overbearing no matter the length of your task list." These are the concrete techniques that produce that quality:

**Typography:**
- Use the system font (SF Pro on Apple, system-ui on web). Do not introduce a display typeface for list content.
- Three sizes maximum: large for section headers (~20–22px), medium for row titles (~16–17px), small for metadata (~13–14px).
- Use weight (600–700 for headers, 400 for titles, 400 lighter for metadata) not color as the primary hierarchy signal.
- Never bold a metadata label. Metadata is always lighter than the title.

**Color:**
- White or near-white background for the list surface.
- Near-black (#1a1a1a or system label color) for primary text.
- Medium gray (~#6e6e6e) for metadata and secondary text.
- One blue accent for interactive elements. Not per-source-type colors on rows.
- Source icons can have varied colors; row backgrounds cannot.

**Spacing:**
- Minimum 12–16px horizontal padding from screen edge to content.
- Section header top margin: ~24–32px. This is the visual "gutter" between sections.
- Row padding: ~12–14px top and bottom — not tight, not airy.
- No separator lines between rows within a section. Separators only at section boundaries, and only as spacing (not a visible line).

**Information density:**
- Collapsed row: 2 elements (glyph + title) + 1 optional indicator (age or urgency). Maximum.
- Do not show source label text in every row — use a source icon (16×16px, left-anchored) that the eye learns to skip.
- Do not show raw timestamps ("2026-06-21T14:32:00Z") — use relative human time ("3 hours ago", "Yesterday", "Monday").

**Motion:**
- Structural transitions (section expand/collapse, view switches): 200–280ms, ease-out.
- Row expand: 180–220ms, ease-out. The row physically grows; nothing navigates.
- Completion/dismissal: 160–200ms with a slight scale or fade — satisfying but quick.
- No ambient animation. No breathing, pulsing, or looping elements.

---

## 9. Sources

All URLs accessed and indexed June 22–23, 2026.

- **Cultured Code — Things homepage**: https://culturedcode.com/things/
- **Cultured Code — Features / What's New**: https://culturedcode.com/things/features/
- **Cultured Code — What's New (original Things 3 launch)**: https://culturedcode.com/things/whats-new/
- **Cultured Code — Things for OS 26 (blog)**: https://culturedcode.com/things/blog/2025/09/things-for-os-26/
- **Cultured Code — An In-Depth Look at Today, Upcoming, Anytime, and Someday (support)**: https://culturedcode.com/things/support/articles/4001304/
- **Cultured Code — Scheduling To-Dos in Things (support)**: https://culturedcode.com/things/support/articles/2803579/
- **MacStories — Things 3: Beauty and Delight in a Task Manager**: https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/
- **Marius Masalar — Things 3: First Impressions**: https://mariusmasalar.me/things-3-first-impressions-8f0155c60cf2
- **IXD@Pratt — Design Critique: Things 3 (iOS App)**: https://ixd.prattsi.org/2020/02/design-critique-things-3-ios-app/
- **Block 81 — Organizing My Life With Things 3**: https://block81.com/blog/organizing-my-life-with-things-3
- **Calmevo — Things 3 Review: Pros and Cons**: https://calmevo.com/things-3-review/
- **Timothy B. Smith / Medium — Review: Things 3 for Mac and iOS**: https://medium.com/@smithtimmytim/review-things-3-for-mac-and-ios-114f4420f44b
- **Grey Patterson — Things 3, or it's like they brought the best of Material Design to iOS**: https://greypatterson.me/2017/06/things-3/

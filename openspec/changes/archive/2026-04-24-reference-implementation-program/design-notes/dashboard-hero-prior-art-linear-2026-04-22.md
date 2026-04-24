# Dashboard hero prior art — Linear

**Status:** research finding
**Date:** 2026-04-22
**Context:** `/dashboard` (Overview) credibility-screen hero research for PDPP operator console.

## Caveat on methodology

Linear's logged-in home (`/inbox`, `/my-issues`) is behind auth. Findings come from:
- Linear's own redesign writeup (first-party quotes from co-founder Karri Saarinen and designer Yann-Edern Gillet, March 2024)
- A live screenshot of the linear.app marketing hero (embeds real product UI)
- Linear's public docs for Inbox, Teams, Workspaces, Preferences, Display options
- A saved screenshot artifact: `linear-home-viewport.png`

## What Linear's first fold actually is

**There is no home "overview."** Default view on login is user-configurable (Inbox / My Issues / Active issues). The workspace composition is an **"inverted L-shape"**:

- Sidebar (workspace + team sections, favorites, views)
- Top header (breadcrumb + filters/display options)
- Main list

**No hero card, no metric tiles, no KPI chrome.** Credibility comes from the sidebar being dense with *named entities* (teams, cycles, projects, views, labels) rather than numbers.

## How Linear signals "real substance" without a dashboard

- **Counts as metadata, not trophies.** On the marketing hero the issue counter reads `02 / 145` in monospace, set small in the header bar next to nav arrows — not as a KPI tile. Numbers appear inline with lists (team backlog count, cycle issue count) in muted weight.
- **Entity breadth in the sidebar does the work.** Seeing "Inbox / My Issues / Reviews / Pulse" plus team sections with cycles/projects/views already reads as "real system." Sidebar alignment is deliberate: Yann spent time "aligning labels, icons, and buttons, both vertically and horizontally... something you'll feel after a few minutes."
- **Identity color dots** next to team names, project status indicators, priority icons — tiny color signals distributed across a monochrome field telegraph variety without chart chrome.

## Typographic hierarchy on dense list pages

- **Two-font system**: Inter Display for headings ("more expression while maintaining readability"), regular Inter for everything else. This is the single strongest restraint lever.
- **No small-caps labels.** Section labels in sidebar use regular-case sentence fragments at reduced weight/opacity, not ALL-CAPS tracking.
- **Contrast via opacity, not size.** "Text and neutral icons darker in light mode and lighter in dark mode."
- **8px spacing scale** reused everywhere; monochrome + desaturated blue accent; modest border radii; sharp borders.
- Hierarchy lives in **weight + color + alignment**, not type-size jumps.

## Empty-state behavior

Brand-new workspaces get routed to a **demo/sample content experience** (linear.app/demo) rather than a skeletal screen — Linear treats "empty" as a failure mode and populates via onboarding templates and a sample team.

## Diversity signals without decoration

- **Grouped lists with small icon prefixes** (priority, status, assignee avatar). Labels appear as flat pill tags inline, not floating chips.
- **Display options panel** toggles which properties render per row. Density is **user-tunable**, not fixed.
- Breadth emerges from **heterogeneous row types** (issues, projects, cycles) sharing the same horizontal rhythm — same gutters, same icon slot, same right-aligned meta.

## Restrained-vs-informative resolution

- **Emphasized**: entity name (issue title, project name) in Inter Display at body+ weight.
- **Demoted**: IDs, timestamps, counts, statuses — muted weight, smaller, or icon-only.
- Karri's explicit goal: "reduce visual noise, maintain visual alignment, and increase the hierarchy and density of navigation elements."
- Formula: **density without noise = same rhythm everywhere + ruthless demotion of metadata.**

## Patterns worth stealing for PDPP

1. **Consider skipping the KPI hero entirely.** Lead with a left-rail of named sources + a main panel in a single rhythm. Breadth = populated sidebar.
2. **Two-tier type only.** Display face for the one headline; body sans for all list content. No size ladder beyond that.
3. **Counts as metadata chrome.** Render totals inline as `02 / 145`-style fragments in muted monospace, not as tiles.
4. **Tunable display options** on the main list — let the user increase density rather than pre-rendering five stat cards.
5. **Identity dots + status icons** across the list = color-coded diversity signal without charts.
6. **Seed with sample data** for fresh installs; never show a blank frame.

## Tension with the hero brief

Linear's pattern is **the least "hero"** of the four SLVP references. It conflicts with the owner's brief on its face ("visually strong hero stats"). The synthesis question: do we take Linear's *typographic and restraint* lessons while borrowing Stripe/Vercel's *hero-number* shape, or do we follow Linear all the way and carry credibility with dense populated chrome instead?

This conflict is worth resolving explicitly in the synthesis note.

## Sources

- [Linear: How we redesigned the UI (part II)](https://linear.app/now/how-we-redesigned-the-linear-ui) — Karri Saarinen & team, March 2024
- [linear.app](https://linear.app/) — live hero screenshot showing Inbox/My Issues/Reviews/Pulse + `02/145` count pattern
- [Linear Docs: Inbox](https://linear.app/docs/inbox), [Teams](https://linear.app/docs/teams), [Workspaces](https://linear.app/docs/workspaces), [Preferences](https://linear.app/docs/account-preferences), [Display options](https://linear.app/docs/display-options)
- [Linear Brand Guidelines](https://linear.app/brand)
- [LogRocket: Linear design analysis](https://blog.logrocket.com/ux-design/linear-design/)
- Artifact: `linear-home-viewport.png`

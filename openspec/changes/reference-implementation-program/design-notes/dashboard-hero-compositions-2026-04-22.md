# Dashboard hero — compositions A and B

**Status:** composition proposals for the owner's pick
**Date:** 2026-04-22
**Scope:** two concrete hero compositions honoring the locked constraints in `dashboard-hero-plan-2026-04-22.md` (no category strip, no tiles, compact, above existing Overview, live from `/_ref/dataset/summary`).

## Shared skeleton

Both compositions use the same three-zone rhythm:

1. Headline line (typographically dominant)
2. Secondary breadth row (quiet, muted)
3. Anatomy callout (ambient, smallest register)

Both consume the same response from `GET /_ref/dataset/summary`.

## Composition A — "integrated sentence"

### Headline

> **184 MB across 12,847 records from 9 connectors · since 2022-07-03**

Typography:
- Numbers in Geist semibold, ~32–36px, tabular-numerals (`font-variant-numeric: tabular-nums`).
- Unit and connective words ("MB", "across", "records from", "connectors", "since") in regular weight, same size, muted (`text-muted-foreground`).
- Date in `text-foreground`, regular weight.

### Secondary breadth row

Three top connectors by record count, inline, with identity dots:

> ● spotify 3,402   ● amazon 2,891   ● apple-health 2,104 · +6 more

- Dots use brand accent color channel (neutral palette, per Linear).
- Connector slug in monospace, small (13px), muted.
- Counts in tabular-numerals.
- "+N more" muted link to `/dashboard/records`.

### Anatomy callout

One ambient sentence below in the smallest register:

> Each approved grant issues runs that write records into streams — every record is inspectable as raw JSON via `/v1/streams`.

- 13px, muted.
- `/v1/streams` rendered as inline monospace.

### Visual weight

Total vertical footprint on desktop: ~120–140px. Fits above ActionBanner + first Failures row on 1440×900 and 1280×800.

### Why A is good

- Stripe/Vercel register: dominant number + precise time range, no deltas, no cards.
- Integrated sentence reads naturally for mixed audiences — CEO can parse it as prose, engineer parses it as facts.
- Breadth carried by a Linear-style muted row, not by tiles. Satisfies the owner "quieter secondary breadth row, not more tiles" constraint exactly.
- Anatomy callout does Vercel-observability work in one sentence.

### Risks

- "Integrated sentence" flows right-to-left in data density (unit → record → connector → time). A viewer scanning left-to-right may read "184 MB" first and weight it over the timespan. Probably fine; worth watching in the browser.
- On very narrow viewports the sentence wraps awkwardly. Fix with explicit line breaks or balanced wrapping via `text-wrap: balance`.

---

## Composition B — "split line + metadata strip"

### Headline

Two lines, top-heavy:

> **12,847 records**
> *across 9 connectors · 184 MB retained · since 2022-07-03*

Typography:
- Line 1: Geist semibold ~40px, tabular-numerals. Number dominates.
- Line 2: 15–16px regular, muted, dot-separated (` · `). Reads as typographic chrome to line 1.

### Secondary breadth row

Same as Composition A:

> ● spotify 3,402   ● amazon 2,891   ● apple-health 2,104 · +6 more

### Anatomy callout

Same as Composition A:

> Each approved grant issues runs that write records into streams — every record is inspectable as raw JSON via `/v1/streams`.

### Visual weight

Total vertical footprint on desktop: ~150–170px (the two-line headline adds ~30px). Still within first-fold budget on 1440×900; tighter on 1280×800.

### Why B is good

- Strongest hero register — the record count number is unambiguous and dominant, matching Vercel Observability's "one hero number" discipline most literally.
- Metadata line reads like Stripe's delta-with-period row, but reframed as compositional context rather than growth chrome.
- Easier to skim: eye lands on the dominant number, then fills in context.

### Risks

- Slightly more vertical space → risk of pushing ActionBanner below fold on small laptops. Mitigation: tighten spacing on the metadata line and/or shrink headline to 36px on `md:` viewports.
- Single-number framing makes "records" feel like the KPI. A skeptical reader might ask "why records?" The integrated sentence in A dodges that by composing the truth across dimensions.

---

## Side-by-side feel

| Dimension | A | B |
|---|---|---|
| Register | Stripe integrated composition | Vercel "one hero number" |
| Dominant element | Composite sentence | Record-count number |
| Reads first | 184 MB (leftmost) | 12,847 (largest) |
| Vertical footprint | ~120–140px | ~150–170px |
| Empty-state grace | "No records yet · 0 connectors connected" fits same sentence shape | "0 records / no connectors yet / 0 MB retained" still readable but feels emptier |
| Risk | Wrapping on narrow viewports | Pushing operator content below fold |

Both satisfy the constraint set. Both are implementable against the same data.

## Empty-state copy (both compositions)

Single paragraph replaces the headline when `record_count === 0`:

> **No records yet · 0 connectors connected**
> Start a grant to begin ingesting. Every record lands inspectable through `/v1/streams`.

No secondary row, no anatomy callout in empty state — the honest message is enough.

## Server-unreachable state (both compositions)

Reuse the existing `ServerUnreachable` pattern (already in place per `control-plane-v1-follow-up.md`). No hero band renders when the reference server is unreachable; the existing banner covers the state.

## Recommendation

**Composition A** as the default. It:
- Integrates four honesty signals (bytes, records, connectors, timespan) into a single readable sentence without privileging one over another.
- Matches the owner's "quieter" directive most closely — the dominant element is a composed sentence, not an oversized number.
- Has the smaller vertical footprint, which protects the operator content below from being pushed off fold.
- Degrades more gracefully in the empty state (the sentence shape absorbs zeros cleanly).

**Composition B** is the better choice if the owner wants the hero to feel more unmistakably a "hero" at a glance — but at the cost of slightly heavier chrome and slightly more risk of operator content displacement.

## Pending decisions for either choice

1. **Byte units**: decimal (MB = 1,000,000 bytes) or binary (MiB = 1,048,576)? Recommend **decimal MB** — matches what "184 MB" reads as to a non-technical audience, and Stripe/Vercel/Plaid all use decimal.
2. **Date format**: ISO (`2022-07-03`) or locale (`Jul 3, 2022`)? Recommend **ISO** — developer-tool register, unambiguous, stable.
3. **Connector slug presentation**: `spotify` vs `Spotify` vs `spotify.com`? Recommend raw slug (lowercased connector_id) for both honesty and typographic consistency with monospace row.
4. **Anatomy callout link**: should `/v1/streams` be a real link to `/dashboard/records` (local pivot) or just rendered as monospace string? Recommend **link to `/dashboard/records`** — adds a pivot, matches the "never dead-end" IA rule.

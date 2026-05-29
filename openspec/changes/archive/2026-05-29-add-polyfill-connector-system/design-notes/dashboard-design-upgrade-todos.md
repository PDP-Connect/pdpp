# Dashboard design upgrade — deferred until data is pristine

**Status:** deferred / not started
**Raised:** 2026-04-19
**Precondition:** data-quality audits clean (no wrongly-empty columns, extractor bugs closed, Layer 2 gaps closed or explicitly deferred).

the owner's list (verbatim, then expanded):

1. **Navigate relationships** — records reference other records via foreign keys (`message.channel_id` → `channels.id`). Dashboard should let you click through these. Right now each record is a terminal JSON blob; a relationship-aware view would let you drill from a message into its channel, from a transaction into its account, etc. Manifest `relationships` already declare the graph.

2. **Filters on timeline(s)** — by connector, by stream, by time-window shortcut beyond the built-in presets, by keyword. Current timeline is all-or-nothing per window.

3. **Human-readable timestamps** — "3 days ago", "2026-04-16 at 9:42 am" rather than raw ISO-8601. Keep ISO available on hover/tooltip for auditors.

4. **Search UX** — currently a substring match is good enough but UX is bare. Add: result-count summary, match preview with context, sort by relevance or recency, filter by stream, remember last query.

5. **Hero stats** — how big is the DB? Total records? Date range of oldest→newest across all connectors? Which connector has the most? Fastest-growing? Time-to-first-record per connector? These belong on `/dashboard` above the connector list.

6. **Record-view legibility** — evaluate whether a table is the right rendering. For some streams (messages, emails) a "card with sender/time/body" is better than columns. For others (transactions) a dense table is right. Consider the reader's mental model per stream. This is per-stream design work.

7. **Full design upgrade without bloat** — apply a consistent design language, don't pile features. Constitution at `reference-implementation/.../CONSTITUTION.md` + existing apps/web style (monospace, terse, dense) is the anchor.

## Dependencies

- Data must be verifiably pristine first (extractor bugs closed, manifest↔data consistency, Layer 2 gaps decided).
- Relationship navigation depends on having consistent FK fields actually populated (currently most streams have the declared FKs but some are null in records — audit would catch).
- Hero stats require the data-health view's sample-scan to run cheaply at dashboard-load time (or be cached).

## Principle

"Consider who the user is and what they want to do." — the owner.

The dashboard serves four different users already, with different expectations:
- **the owner (owner)** — exploration, reconciliation, finding things.
- **Engineer reviewing protocol** — wants to see real JSON, verify spec shape.
- **LF standards reviewer** — wants data-health, audit trail, manifest↔data.
- **GTM** — wants quick-demo visuals.

Any design work should ask per page/view: which of these does this serve, and can it serve multiple without diluting any?

## Anti-patterns to avoid

- Adding charts/graphs for their own sake. This is a reference, not a dashboard-as-a-product.
- Hiding raw JSON in favor of "pretty" views. The spec compliance comes from the raw.
- Building interactive controls that require client hydration when server-rendered would do.

## Action items

- [ ] Confirm data quality gate clean (Layer 1 audit + Layer 2 audit follow-ups complete)
- [ ] Draft a small design brief per-page with the four-users lens
- [ ] Implement in batches: one page at a time, user-review each

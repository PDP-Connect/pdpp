# Dashboard hero — current-code audit

**Status:** research finding
**Date:** 2026-04-22
**Context:** What already exists in `apps/web/src/app/dashboard` and what's genuinely missing for a hero-stats addition.

## Current `/dashboard/page.tsx` structure

Top fold today:
- Page header: "Overview" + subtitle ("Local-first operator console…")
- `ActionBanner` — "All clear" or "Action needed" with failure counts
- 2-column grid: "Recent failed traces" + "Recent failed runs" (5 each, FailuresPanels)

Below fold:
- "Recent decisions" (6 merged grant lifecycle events: issued/revoked/denied)
- "Recent runs" (up to 10)

Data loaded (async): `listTraces({ status: 'failed' })`, `listRuns({ status: 'failed' })`, `listGrants` for revoked/denied/issued, `listRuns({ limit: 10 })`.

**Gap:** The page is failure/lifecycle-centric. No aggregate data surfaces (stream/connector/record counts, data size, timespan).

## Existing primitives in `components/primitives.tsx`

Page-layout components, not metric components:
- `DashboardBreadcrumbs`, `DashboardFrame`, `DashboardRail`, `DashboardRailSection`
- `DashboardMasthead` (eyebrow, title, description, actions, meta)
- `DashboardToolbar`, `DashboardSection`, `DashboardFilterSummary`
- `DashboardSurfaceCard` (titled card with description, actions, children)
- `DashboardMetaPill` — small inline pill: label + value, tones `neutral | protocol | human | danger`. **Closest existing primitive to a stat display, but too small to be hero.**

Typography classes already available: `pdpp-label`, `pdpp-title`, `pdpp-heading` (from `packages/pdpp-brand/base.css`).

**Gap:** No dedicated stat-display primitive. A new `StatGroup` / `HeroStat` composed from brand tokens is required.

## Available data for the candidate hero stats

| Metric | Status | Source | Cost |
|---|---|---|---|
| Connector count | ✅ Available | `rs-client.listConnectorManifests()` (disk) | O(1) |
| Stream count | ✅ Available | `rs-client.listStreams(connectorId)` per connector | O(N) calls, N ≤ 31 today |
| Retained record count | ✅ Available | Sum of `stream.record_count` across all streams | Client-side aggregation on top of the N calls above |
| **Total data size** | ❌ Missing | No public endpoint; DB has `blobs.size_bytes` but not exposed | Needs either a new read-only `_ref` helper or a proxy (record count × typical size) — neither ideal |
| Timespan (earliest → latest) | ✅ Available | Spine `first_at` / `last_at` already loaded by current page (or `StreamRecord.emitted_at` min/max) | Reuse existing loaded data |
| Stream-category diversity | ⚠️ Partial | Manifests have `streams.name`; no structured `category` field | Either count per-connector, infer from stream names, or add manifest field |

## Design-system readiness

- CSS tokens (via `packages/pdpp-brand/base.css`): `--background`, `--foreground`, `--primary`, `--destructive`, `--muted`, `--muted-foreground`, `--success`, `--warning`, `--human`; duration/motion/font tokens in place.
- Tailwind classes in use: restrained — `text-xs/sm/lg`, `font-semibold/medium`, `text-muted-foreground/destructive/foreground`, `bg-muted`, `border-border`, `rounded`.
- **No pre-built stat card or metric-display pattern** — must compose.

## Implications for the hero brief

1. **Cheapest honest path**: connector count + stream count + retained records + timespan, all from existing surfaces. Parallel `listStreams` calls across 31 manifests is acceptable (cache-able).
2. **Total-size hero**: either (a) add a read-only `GET /_ref/storage/summary` helper that returns `{ total_bytes, records, blobs }`, or (b) drop size from the hero and compose richer honesty from record count + timespan + breadth. Option (b) is strictly less work; option (a) lets PDPP honestly claim "X GB under management" — a stronger credibility signal.
3. **Stream-category diversity**: adding a manifest-level `category` field is the cleanest path (e.g., `health`, `commerce`, `communication`, `content`, `location`) but requires touching 31 manifests + the connector contract. A reasonable v1 substitute is "N streams across M connectors" as a single composed phrase.
4. **Fresh / empty instance behavior** already has precedent (see `reference-server-unreachable` + empty-state blocks called out in the control-plane implementation plan). Hero must degrade gracefully in the same register, not fabricate numbers.

## Open questions for the synthesis

1. Add a read-only `/_ref/storage/summary` helper so the hero can truthfully show bytes? (Versus dropping size from the hero.)
2. Add `streams[].category` to the manifest schema, or defer category diversity to v2?
3. Does the hero replace the existing ActionBanner + Failures fold, or sit above it?

## Files referenced

- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/app/dashboard/components/primitives.tsx`
- `apps/web/src/app/dashboard/lib/rs-client.ts`
- `apps/web/src/app/dashboard/lib/ref-client.ts`
- `reference-implementation/server/index.js`
- `packages/pdpp-brand/base.css`
- `packages/polyfill-connectors/manifests/*.json` (31 manifests)

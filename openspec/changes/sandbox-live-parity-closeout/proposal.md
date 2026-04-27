## Why

The sandbox is now a separate React tree that *resembles* the live dashboard but is implemented as parallel page wrappers. As features land on `/dashboard/**`, `/sandbox/**` drifts. The reference-quality closeout plan calls for one dashboard with two data sources: live AS/RS for `/dashboard/**`, deterministic mock AS/RS for `/sandbox/**`. Several leaf pages already follow that contract through shared feature views. The remaining live pages need to consume the same shared views before further dashboard work can be safely shared between the two surfaces.

## What Changes

- Make the shared dashboard feature views the single source of truth for overview and records UI. Both `/dashboard/**` and `/sandbox/**` SHALL render through the same view components.
- Live pages inject the live data source, real actions, and live polling.
- Sandbox pages inject the deterministic mock data source and read-only/no-op actions.
- Sandbox connector-health time semantics ("Synced last 24h", "Stale >7d") SHALL be evaluated against the deterministic sandbox clock (`DEMO_NOW`) rather than wall-clock `Date.now()`.
- Educational walkthroughs (`/sandbox/walkthrough`, `/sandbox/api-examples`) MAY remain sandbox-only.
- Parity guard tests SHALL cover `/dashboard/schedules` and `/sandbox/schedules`.

This change does not modify API route contracts, mock dataset content (other than clock-relative health-label semantics), or grants/runs/traces/deployment/search rendering paths. Those are out of scope and tracked as future parity slices.

## Capabilities

### Modified Capabilities

- `reference-demo-instance`: tighten the existing data-source-seam requirement so that the shared dashboard feature views become the source of truth for the parity surfaces in this slice (overview, records). Add a deterministic-clock requirement for sandbox health labeling.

## Impact

- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/app/dashboard/records/page.tsx`
- `apps/web/src/app/dashboard/components/views/overview-view.tsx`
- `apps/web/src/app/dashboard/components/views/records-list-view.tsx`
- `apps/web/src/app/sandbox/overview/page.tsx`
- `apps/web/src/app/sandbox/records/page.tsx`
- `apps/web/src/app/sandbox/_demo/dataset.ts` or `data-source.ts` (clock-relative health-label semantics only)
- Parity guard test under `apps/web/src/app/sandbox/_demo/`
- No API route, no manifest, no protocol surface, no new dependency.

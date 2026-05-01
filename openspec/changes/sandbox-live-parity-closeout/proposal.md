## Why

The sandbox must be a real mock-backed reference instance, not a tutorial fork or a Next-side imitation of AS/RS behavior. The architectural rule is unconditional: `/sandbox/**` binds the same dashboard feature layer and canonical AS/RS operation semantics to deterministic mock adapters. `/dashboard/**` binds the same feature layer and operation semantics to the live owner-authenticated AS/RS.

The first slice of this change closed overview and records UI drift. The remaining closeout is to make that rule durable across primary sandbox pages and sandbox API routes before further dashboard or public-demo work lands.

## What Changes

- Treat shared dashboard feature views as the single source of truth for primary overview, records, search, grants, runs, traces, schedules, and deployment UI.
- Live pages inject the live data source, real owner actions, owner auth, and live polling.
- Sandbox pages inject deterministic mock AS/RS data, read-only/no-op actions, demo labeling, and the deterministic sandbox clock.
- Sandbox API routes under `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**` SHALL mount canonical AS/RS operation modules with mock adapter dependencies wherever a canonical operation exists.
- Demo builders remain allowed only as deterministic fixture/adapters, not as parallel business-logic implementations.
- Educational walkthroughs (`/sandbox/walkthrough`, `/sandbox/api-examples`) MAY remain sandbox-only and tutorial-shaped.
- Guard tests SHALL catch primary page drift, sandbox-to-live AS/RS calls, and route-handler regressions back to parallel builders.

This change does not alter public PDPP protocol semantics, make the sandbox collect real credentials, or turn `_ref/**` into a public assistant API.

## Capabilities

### Modified Capabilities

- `reference-demo-instance`: tighten the existing data-source-seam requirement so primary sandbox pages and sandbox API routes bind real feature/operation seams to deterministic mock adapters.

## Impact

- `apps/web/src/app/dashboard/**`
- `apps/web/src/app/sandbox/**`
- `apps/web/src/app/dashboard/components/views/overview-view.tsx`
- `apps/web/src/app/dashboard/components/views/records-list-view.tsx`
- `apps/web/src/app/dashboard/components/views/**`
- `apps/web/src/app/sandbox/_demo/data-source.ts`
- `apps/web/src/app/sandbox/_demo/operations-fixtures.ts`
- `apps/web/src/app/sandbox/_demo/builders.ts`
- `apps/web/src/app/sandbox/_demo/*test*`
- Sandbox route handlers under `apps/web/src/app/sandbox/**/route.ts`
- No manifest change, no protocol surface change, no new dependency.

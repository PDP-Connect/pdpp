## Context

`add-mock-reference-demo-instance` introduced a typed `DashboardDataSource` seam, with `liveDashboardDataSource` for `/dashboard/**` and `sandboxDashboardDataSource` for `/sandbox/**`. Several sandbox pages (overview, traces, grants, runs, search, records timeline, records detail) already render through shared feature views in `apps/web/src/app/dashboard/components/views/**`, with sandbox-specific pages binding `sandboxRoutes` and the mock data source.

The remaining drift lives on the *live* side: `apps/web/src/app/dashboard/page.tsx` and `apps/web/src/app/dashboard/records/page.tsx` still render their own forks of overview and records UI. They duplicate the layout, copy, sort logic, and health-strip math that already exists in `OverviewView` / `RecordsListView`. As long as both implementations exist, every dashboard polish lands twice, gets out of sync, or quietly misses the sandbox.

This change closes that gap for two routes — overview and records — without touching grants, runs, traces, deployment, or search. Those have their own follow-up slices.

## Decisions

### One source of truth, two data sources

The shared view components in `apps/web/src/app/dashboard/components/views/**` are the source of truth for what an overview or records page looks like and how it sorts/labels data. Live and sandbox pages become thin shells that:

1. Resolve the right `DashboardDataSource` (`liveDashboardDataSource` for `/dashboard`, `sandboxDashboardDataSource` for `/sandbox`).
2. Resolve the right `Routes` (`dashboardRoutes` vs `sandboxRoutes`).
3. Inject mode-specific behaviors: live actions/polling for `/dashboard`, no-op/read-only behaviors for `/sandbox`.
4. Handle live-only error surfaces (`ReferenceServerUnreachableError` → `ServerUnreachable`).

### Live data, live actions, live polling stay live

Refactoring the page wrappers does not change owner-auth, action wiring, or polling. The live records page keeps its `RecordsPagePoller` and its `ConnectorRow` (which carries the Sync-now server action). Those are passed through the shared view via the `pollerSlot` prop and the `interactive` flag that already exists on `RecordsListView`.

### Sandbox uses the deterministic clock for health labels

`RecordsListView` currently calls `Date.now()` to compute "Synced last 24h" / "Stale >7d". For the live page that is correct: real wall-clock time is the right reference. For the sandbox it is wrong: the dataset is anchored to `DEMO_NOW = 2026-04-25T15:00:00Z`. As wall-clock time advances past the seeded `last_at` values, every sandbox connector silently rolls into "Stale", which contradicts the dataset.

The fix: thread an optional `now` argument through `RecordsListView`. The live page omits it (defaulting to `Date.now()`); the sandbox page passes `Date.parse(DEMO_NOW)`. This keeps the change surgical and does not require a new clock abstraction.

### Out of scope

- Grants, runs, traces, deployment, and search page parity. Those follow the same pattern but are separate slices.
- Mock dataset content. The only sandbox-side change is computing the "now" reference for health labels.
- API route contracts (`/sandbox/v1/**`, `/sandbox/_ref/**`, etc.).
- The educational walkthroughs at `/sandbox/walkthrough` and `/sandbox/api-examples`.

## Alternatives Considered

- **Inject a `Clock` interface across the seam.** Overkill for one usage site. The optional `now` parameter is honest, local, and easy to remove later if a real clock seam becomes necessary.
- **Recompute sandbox `last_at` values on each request to keep them within 24h of wall-clock time.** Rejected: that breaks deterministic-dataset invariants that other sandbox tests depend on.
- **Have sandbox pages keep their fork and rely on review discipline to keep drift small.** Rejected by the reference-quality closeout plan: the sandbox is supposed to *be* the dashboard with mock data, not a polished lookalike.

## Acceptance Checks

- `/dashboard` and `/dashboard/records` render through the shared view components, with live data, owner-auth, real actions, and `RecordsPagePoller` behavior preserved.
- `/sandbox/overview` and `/sandbox/records` continue to render through the shared view components.
- The records health strip on `/sandbox/records` reflects the deterministic sandbox clock — connectors with `last_at` near `DEMO_NOW` count toward "Synced last 24h", not toward "Stale >7d".
- A parity guard test asserts that `/dashboard/schedules` and `/sandbox/schedules` both exist (so the next slice cannot delete one and forget the other).
- Orphan sandbox modules (no importers) are removed.
- `openspec validate sandbox-live-parity-closeout --strict` passes.
- `pnpm --dir apps/web run types:check`, `pnpm --dir apps/web run check`, and `pnpm --dir apps/web run build` pass.

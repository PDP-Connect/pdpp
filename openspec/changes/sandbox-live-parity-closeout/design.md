## Context

`add-mock-reference-demo-instance` introduced a typed `DashboardDataSource` seam, with `liveDashboardDataSource` for `/dashboard/**` and `sandboxDashboardDataSource` for `/sandbox/**`. Several sandbox pages already render through shared feature views in `apps/web/src/app/dashboard/components/views/**`, with sandbox-specific pages binding `sandboxRoutes` and the mock data source.

The first slice of `sandbox-live-parity-closeout` closed the most obvious live-side drift for overview and records. Owner review clarified the broader architectural bar: there is no conditional "if Vercel requires it" branch. `/sandbox/**` is always a mock-adapter-backed reference instance. It should use the real dashboard feature layer and real AS/RS operation modules where those modules exist, with only the environment, data, credentials, and side effects mocked.

The expanded audit found drift in two places: React-page duplication and sandbox route handlers that still bound directly to `_demo/builders.ts`. Builders are acceptable as deterministic fixture/data construction; they are not acceptable as a parallel implementation of AS/RS business logic when a canonical operation module exists.

## Decisions

### One source of truth, two data sources

The shared view components in `apps/web/src/app/dashboard/components/views/**` are the source of truth for what an overview or records page looks like and how it sorts/labels data. Live and sandbox pages become thin shells that:

1. Resolve the right `DashboardDataSource` (`liveDashboardDataSource` for `/dashboard`, `sandboxDashboardDataSource` for `/sandbox`).
2. Resolve the right `Routes` (`dashboardRoutes` vs `sandboxRoutes`).
3. Inject mode-specific behaviors: live actions/polling for `/dashboard`, no-op/read-only behaviors for `/sandbox`.
4. Handle live-only error surfaces (`ReferenceServerUnreachableError` → `ServerUnreachable`).

This rule applies to primary dashboard-mode sandbox pages: overview, records, search, grants, runs, traces, schedules, and deployment. `api-examples` and `walkthrough` remain allowed to be tutorial-specific because they are secondary educational surfaces, not the mock-owner dashboard experience.

### Real operation semantics, mock adapters

Sandbox API routes should mount canonical AS/RS operation modules wherever a canonical operation exists. The sandbox host supplies deterministic fixture dependencies from `_demo/operations-fixtures.ts`; the operation owns request parsing, authorization-shape semantics, envelope shape, pagination, errors, and public/reference contract behavior.

`_demo/builders.ts` can remain a fixture construction layer for:

- seeded mock data;
- deterministic mock dependency implementations;
- route families that do not yet have canonical operation modules, if explicitly documented;
- non-route educational/demo-state helpers that are not AS/RS contract semantics.

It must not grow into a second AS/RS implementation. When a sandbox route has a canonical operation available, the route calls the operation with mock adapters rather than hand-building the business response in Next. After this closeout, the primary sandbox route handlers under `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**` no longer import `_demo/builders.ts` for business responses.

### Live data, live actions, live polling stay live

Refactoring the page wrappers does not change owner-auth, action wiring, or polling. The live records page keeps its `RecordsPagePoller` and its `ConnectorRow` (which carries the Sync-now server action). Those are passed through the shared view via the `pollerSlot` prop and the `interactive` flag that already exists on `RecordsListView`.

### Device exporters stay live-only for this change

Device exporters remain a documented live-only reference-experimental exception, not a mock-owner sandbox page. The surface is about enrolling/revoking local exporter agents, reading live heartbeat diagnostics, and inspecting source-instance ingest counts. Those are operator side effects around local device agents, not AS/RS read semantics. A sandbox page would either be a static tutorial fork or a fake operator flow with no real reference behavior to exercise.

The mock-owner shell already suppresses the device-exporters nav and command-palette shortcut. A future sandbox counterpart should only be added if the device-exporter capability grows a read-only canonical state or operation seam that can be backed by deterministic mock adapters.

### Sandbox uses the deterministic clock for health labels

`RecordsListView` currently calls `Date.now()` to compute "Synced last 24h" / "Stale >7d". For the live page that is correct: real wall-clock time is the right reference. For the sandbox it is wrong: the dataset is anchored to `DEMO_NOW = 2026-04-25T15:00:00Z`. As wall-clock time advances past the seeded `last_at` values, every sandbox connector silently rolls into "Stale", which contradicts the dataset.

The fix: thread an optional `now` argument through `RecordsListView`. The live page omits it (defaulting to `Date.now()`); the sandbox page passes `Date.parse(DEMO_NOW)`. This keeps the change surgical and does not require a new clock abstraction.

## Current Audit

### Primary Dashboard Pages

| Area | Current classification | Decision |
|---|---|---|
| Overview | Drift: `/dashboard` uses `OverviewView`, while `/sandbox` was a standalone launcher and `/sandbox/overview` held the dashboard view. | Make `/sandbox` the mock-owner overview and keep `/sandbox/overview` as a compatibility alias. |
| Records | Shared-view-backed. | Keep; guard deterministic sandbox clock behavior. |
| Records timeline | Shared-view-backed. | Keep; guard route parity. |
| Search | Shared-view-backed. | Live page now resolves live session/data/redirect/debug wiring and renders through `SearchView`; sandbox keeps mock data binding. |
| Grants | Shared-view-backed with live-only slots. | Live list/detail use shared list/timeline views while preserving pending approval actions and owner-only raw URLs. |
| Runs | Shared-view-backed with live-only slots. | Live list/detail use shared list/timeline views while preserving polling, stderr diagnostics, bridge warnings, and run interaction panels. |
| Traces | Shared-view-backed. | Live list/detail use shared list/timeline views with live data and pagination. |
| Schedules | Shared-view-backed. | Shared schedules view binds live create/update/delete actions vs sandbox read-only copy. |
| Deployment | Shared-view-backed with sandbox extension slot. | Shared diagnostics view renders live and sandbox; sandbox appends deterministic AS/RS metadata and capability matrix through `afterDiagnostics`. |
| Device exporters | Live-only reference-experimental surface; no sandbox counterpart. | Documented live-only exception: enrollment/revocation/heartbeat diagnostics are operator side effects, and mock-owner navigation/command palette suppress this route. |
| API examples / walkthrough | Safely divergent educational surfaces. | Keep outside dashboard parity requirements. |

### Sandbox API Routes

| Route family | Current binding | Decision |
|---|---|---|
| `/sandbox/v1/schema` | `rs-schema-get` operation with mock fixtures. | Keep. |
| `/sandbox/v1/search` | `rs-search-lexical` operation with mock fixtures. | Keep. |
| `/sandbox/v1/streams/**` | `rs-streams-*` and `rs-records-*` operations with mock fixtures. | Keep. |
| `/sandbox/ref/dataset/summary` | `ref-dataset-summary` operation with mock fixtures. | Keep. |
| `/sandbox/ref/grants`, `/sandbox/ref/runs`, `/sandbox/ref/traces` | `ref-spine-correlations-list` operation with mock spine fixtures. | Keep; source guard asserts the canonical operation stays mounted. |
| `/sandbox/ref/*/timeline` and trace detail routes | `ref-spine-events-page` operation with mock spine-event fixtures. | Keep; route-shape tests cover representative trace/grant/run timeline envelopes. |
| `/sandbox/well-known/oauth-authorization-server` | `as-authorization-server-metadata` operation with sandbox metadata adapters. | Keep; metadata route-shape tests cover issuer/host forwarding behavior. |
| `/sandbox/well-known/oauth-protected-resource` | `rs-protected-resource-metadata` operation with sandbox metadata adapters. | Keep; metadata route-shape tests cover lexical capability and discovery hints. |

Implemented order: root overview parity first, then schedules shared view, deployment diagnostics extraction, live-side search/grants/runs/traces convergence, device-exporter exception documentation, route-handler operation migration, and source/shape guard tests.

### Out of scope

- Making the sandbox collect real credentials or talk to real connector accounts.
- Treating `_ref/**` as public assistant API.
- Changing root protocol semantics or public extension semantics.
- Adding new production storage adapters or manifest fields.
- Rewriting educational pages (`/sandbox/walkthrough`, `/sandbox/api-examples`) into dashboard-mode pages.
- Adding a sandbox counterpart for live-only local device-exporter enrollment/revocation flows before that surface has a read-only canonical state or operation seam.

## Alternatives Considered

- **Inject a `Clock` interface across the seam.** Overkill for one usage site. The optional `now` parameter is honest, local, and easy to remove later if a real clock seam becomes necessary.
- **Recompute sandbox `last_at` values on each request to keep them within 24h of wall-clock time.** Rejected: that breaks deterministic-dataset invariants that other sandbox tests depend on.
- **Have sandbox pages keep their fork and rely on review discipline to keep drift small.** Rejected by the reference-quality closeout plan: the sandbox is supposed to *be* the dashboard with mock data, not a polished lookalike.
- **Keep Next route handlers as the sandbox's AS/RS implementation.** Rejected. That creates a parallel reference server whose behavior can drift from the real AS/RS and makes public demo correctness depend on duplicated business logic.
- **Embed the live reference server process in the web app.** Rejected for hosted/public sandbox use. The sandbox must run without a live database, owner auth, connector credentials, or a reference process. Embeddable operation modules plus mock adapters provide the right boundary.

## Acceptance Checks

- Primary `/dashboard/**` and `/sandbox/**` dashboard-mode pages render through shared feature components or have an explicit safety/demo-state reason for divergence.
- `/sandbox/**` primary pages bind `sandboxDashboardDataSource`, `sandboxRoutes`, read-only/no-op actions, and mock-owner labeling.
- `/dashboard/**` primary pages bind live data sources, owner auth, real actions, and live polling where applicable.
- Sandbox API routes use canonical operation modules with mock adapters wherever a canonical operation exists.
- No primary sandbox route handler imports `_demo/builders.ts` for AS/RS business responses; `_demo/builders.ts` remains seeded fixture/data construction and non-route demo support.
- The records health strip on `/sandbox/records` reflects the deterministic sandbox clock — connectors with `last_at` near `DEMO_NOW` count toward "Synced last 24h", not toward "Stale >7d".
- A parity guard test asserts that `/dashboard/schedules` and `/sandbox/schedules` both exist (so the next slice cannot delete one and forget the other).
- Guard tests assert sandbox primary pages do not call live AS/RS clients and sandbox route handlers do not bypass available canonical operations.
- Orphan sandbox modules (no importers) are removed.
- `openspec validate sandbox-live-parity-closeout --strict` passes.
- `pnpm --dir apps/web run types:check`, `pnpm --dir apps/web run check`, and `pnpm --dir apps/web run build` pass.

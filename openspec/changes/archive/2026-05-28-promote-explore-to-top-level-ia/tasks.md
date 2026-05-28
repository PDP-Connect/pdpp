# Tasks — promote-explore-to-top-level-ia

## 1. Routes plumbing

- [x] 1.1 Replace `section.recordsExplorer` with `section.explore` in `apps/web/src/app/dashboard/components/views/routes.ts` so `dashboardRoutes` and `sandboxRoutes` both bind `${basePath}/explore`. Both prior callers (the view's `buildExplorerHref` and the form `action`) now point at the top-level path.
- [x] 1.2 Mirror the same delta in `apps/console/src/app/dashboard/components/views/routes.ts`.

## 2. Top-level Explore route

- [x] 2.1 Move `apps/web/src/app/dashboard/records/explorer/` to `apps/web/src/app/dashboard/explore/` via `git mv` and rewrite the `../../` import paths to `../`. The page now mounts at `/dashboard/explore`, renders `RecordsExplorerView` inside `<DashboardShell active="explore">`, and the underlying RS / `_ref` reads are unchanged.
- [x] 2.2 Mirror under `apps/console`.

## 3. Shell and nav

- [x] 3.1 Add `"explore"` to the `DashboardSection` union in `apps/web/src/app/dashboard/components/shell.tsx`.
- [x] 3.2 Insert an `Explore` entry in `buildNav` between `Search` and `Traces`, with `match: (a) => a === "explore"`.
- [x] 3.3 Update the Records subnav `Explorer` link to point at `routes.section.explore` (same destination as the top-level nav).
- [x] 3.4 Mirror under `apps/console/src/app/dashboard/components/shell.tsx`.

## 4. Redirect from old path

- [x] 4.1 In `apps/web/next.config.mjs`, add a non-permanent redirect from `/dashboard/records/explorer` → `/dashboard/explore` (Next.js redirects preserve the query string by default).
- [x] 4.2 Mirror in `apps/console/next.config.mjs`.
- [x] 4.3 Add `explore` and `device-exporters` to the pre-v1 bare-connector wildcard's exclusion list so `/dashboard/explore/...` is never misrouted into `/dashboard/records/explore/...`.

## 5. Old explorer directory

- [x] 5.1 The old `apps/{web,console}/src/app/dashboard/records/explorer/` directory has been removed (moved by `git mv`). The `next.config.mjs` redirect handles all deep links to `/dashboard/records/explorer*` without a 404 race because Next.js evaluates redirects before App Router routing. Both apps agree.

## 6. Records-explorer view: top-level breadcrumbs

- [x] 6.1 Updated `RecordsExplorerView` directly: breadcrumb is `[{ label: "Explore" }]`, title is `Explore`. The deep-link page is gone (redirect handles it) so no caller still needs the `Records / Explorer` breadcrumb. Simpler than a prop override.
- [x] 6.2 N/A (no second caller).

## 7. Tests

- [x] 7.1 Existing `explorer-url.test.ts` was carried over with the directory move and updated to assert `/dashboard/explore` as the canonical path.
- [x] 7.2 Same in `apps/console`. All other explorer tests (`peek-url.test.ts`, `row-routing.test.ts`, `search-hit-attribution.test.ts`) work unchanged because they were location-agnostic.

## 8. Validation

- [x] 8.1 `openspec validate promote-explore-to-top-level-ia --strict` passes; `openspec validate --all --strict` reports 136/136 pass.
- [x] 8.2 `pnpm -C apps/web run types:check` passes.
- [x] 8.3 `pnpm -C apps/console run types:check` passes.
- [x] 8.4 Targeted explorer tests pass via `pnpm -C apps/web exec node --test ...` (27/27) and the `apps/console` mirror (27/27).

## 9. Documentation / handoff

- [x] 9.1 Closeout report at `tmp/workstreams/explore-ia-designer-alignment-report.md` documents in-scope vs deferred work and recommends the next OpenSpec changes (Connections rename, Timeline absorption, Search records-section retirement).

## Acceptance checks

- Visiting `/dashboard/explore` renders the records explorer with the top-level nav `Explore` entry highlighted.
- Visiting `/dashboard/records/explorer?q=foo&connection=conn-1` lands on `/dashboard/explore?q=foo&connection=conn-1` and renders the same feed.
- The Records subnav still exposes `Explorer`; clicking it goes to `/dashboard/explore`.
- The top-level nav order is `Overview · Search · Explore · Traces · Grants · Runs · Records · Schedules · Deployment · Device exporters` in live mode.

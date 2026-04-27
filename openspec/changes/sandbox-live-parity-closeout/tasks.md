## 1. Live overview parity

- [x] 1.1 Refactor `apps/web/src/app/dashboard/page.tsx` to consume the shared `OverviewView` from `apps/web/src/app/dashboard/components/views/overview-view.tsx`, binding `liveDashboardDataSource` and `dashboardRoutes` while preserving live data, `force-dynamic`, and the `ReferenceServerUnreachableError → ServerUnreachable` fallback.

## 2. Live records parity

- [x] 2.1 Refactor `apps/web/src/app/dashboard/records/page.tsx` to consume the shared `RecordsListView`, binding `liveDashboardDataSource`, `dashboardRoutes`, `interactive: true`, and the existing `RecordsPagePoller` via the `pollerSlot` prop. Preserve owner-auth, the `ConnectorRow` Sync-now action, sort order, and counts.

## 3. Sandbox connector-health time semantics

- [x] 3.1 Thread an optional `now: number` parameter through `RecordsListView` defaulting to `Date.now()`.
- [x] 3.2 Update `apps/web/src/app/sandbox/records/page.tsx` to pass `Date.parse(DEMO_NOW)` (or an equivalent helper exported from the sandbox clock module) so "Synced last 24h" / "Stale >7d" labels are evaluated against the deterministic demo clock.

## 4. Parity guard for /schedules

- [x] 4.1 Add (or extend) a parity guard test under `apps/web/src/app/sandbox/_demo/` that imports the page modules for `/dashboard/schedules` and `/sandbox/schedules` and asserts both exist. The intent is that future renames or deletions trip the test rather than silently breaking parity.

## 5. Orphan cleanup

- [x] 5.1 Use `rg` to identify any sandbox-only or dashboard-only view shims that have no remaining importers after the refactor. Delete only files that `rg` confirms have zero importers in `apps/web/src/`.

## 6. Validation

- [x] 6.1 `openspec validate sandbox-live-parity-closeout --strict`.
- [x] 6.2 `openspec validate --all --strict`.
- [x] 6.3 `pnpm --dir apps/web run types:check`.
- [x] 6.4 `pnpm --dir apps/web run check`.
- [x] 6.5 `pnpm --dir apps/web run build`.
- [x] 6.6 Run the new/updated parity test and any sandbox tests touched.

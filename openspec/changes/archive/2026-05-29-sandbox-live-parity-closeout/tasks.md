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

## 7. Broadened Mock-Adapter Architecture Audit

- [x] 7.1 Inventory every primary `/dashboard/**` page and its `/sandbox/**` counterpart, classifying each as shared-view-backed, safely divergent, or drift.
- [x] 7.2 Inventory every sandbox route handler under `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**`, mapping each to an existing canonical AS/RS operation module or marking the operation as missing.
- [x] 7.3 Audit `_demo/builders.ts` and classify each export as seeded data construction, mock operation dependency, no-operation-available route support, or parallel business logic debt.
- [x] 7.4 Produce a short in-change design note or table in `design.md` with the audit results and the selected implementation slices.

## 8. Primary Dashboard Page Parity

- [x] 8.1 Convert `/sandbox` from a standalone launcher to the shared mock-owner overview dashboard surface.
- [x] 8.2 Keep `/sandbox/overview` as a compatibility alias that renders the same shared overview content.
- [x] 8.3 Create a shared schedules view and bind it to live actions vs sandbox read-only/no-op behavior.
- [x] 8.4 Extract shared deployment diagnostics and keep sandbox-only metadata/capability sections as extension slots.
- [x] 8.5 Convert live search/grants/runs/traces pages that duplicate already-shared sandbox feature views to shared view components with live wrappers.
- [x] 8.6 Decide whether device exporters need a mock read-only sandbox counterpart or a documented live-only reference-experimental exception.
- [x] 8.7 Add or extend guard tests proving primary mock-owner dashboard pages use dashboard-mode shell/chrome and do not regress to tutorial/product shell framing.

## 9. Sandbox Route Operation Adapter Parity

- [x] 9.1 For sandbox routes with existing canonical operations, replace route-local business response construction with operation calls bound to deterministic mock adapter dependencies.
- [x] 9.2 Move any reusable mock dependency construction into `_demo/operations-fixtures.ts`; keep `_demo/builders.ts` as seeded fixture/data construction rather than AS/RS semantics.
- [x] 9.3 For sandbox routes without a canonical operation, document the missing operation and keep the builder path only as an explicit temporary exception.
- [x] 9.4 Add source-level guard tests that fail if a sandbox route bypasses an available canonical operation or imports live AS/RS clients.
- [x] 9.5 Add route-shape regression tests for representative `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**` endpoints after adapter migration.

## 10. Documentation And Safety Copy

- [x] 10.1 Update sandbox/reference copy only where needed to state the sharper rule: mock-backed reference instance, deterministic data, no real credentials, no live AS/RS dependency.
- [x] 10.2 Preserve educational routes as secondary surfaces and avoid reframing primary sandbox pages as tutorials.
- [x] 10.3 Document deliberate sandbox/live divergences with the reason: safety, demo-state specificity, or missing canonical operation.

## 11. Final Validation

- [x] 11.1 Run `openspec validate sandbox-live-parity-closeout --strict`.
- [x] 11.2 Run `openspec validate --all --strict`.
- [x] 11.3 Run relevant sandbox route and mock-owner page tests.
- [x] 11.4 Run `pnpm --dir apps/web run types:check`.
- [x] 11.5 Run `pnpm --dir apps/web run check`.
- [x] 11.6 Run `pnpm --dir apps/web run build`.

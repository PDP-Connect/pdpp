## 1. Nav and surface rename

- [x] 1.1 Change nav label from "Search" to "Jump" in `apps/web/src/app/dashboard/components/shell.tsx`.
- [x] 1.2 Change nav label from "Search" to "Jump" in `apps/console/src/app/dashboard/components/shell.tsx`.
- [x] 1.3 Change command palette shortcut label from "Search" to "Jump" in both `command-palette.tsx` files.
- [x] 1.4 Change page heading from "Search" to "Jump" in `apps/web/src/app/dashboard/components/views/search-view.tsx`.
- [x] 1.5 Change page heading from "Search" to "Jump" in `apps/console/src/app/dashboard/components/views/search-view.tsx`.
- [x] 1.6 Update placeholder copy to "trace id, grant id, or run id…" (spine-only intent).

## 2. Search page narrowing

- [x] 2.1 Remove `searchRecordsLexical` / `searchRecordsHybrid` / `getRecord` calls and the `rs-client` import from `apps/web/src/app/dashboard/search/page.tsx`.
- [x] 2.2 Add free-text redirect to Explore: `redirect(\`\${dashboardRoutes.section.explore}?q=\${encodeURIComponent(query)}\`)` when the query is not an exact id match and `jump !== "0"`.
- [x] 2.3 Mirror the same changes in `apps/console/src/app/dashboard/search/page.tsx`.
- [x] 2.4 Mirror the same changes in `apps/web/src/app/sandbox/search/page.tsx` (uses `sandboxRoutes.section.explore`).
- [x] 2.5 Update `SearchView` JSDoc in both apps to document the narrowed purpose (spine artifact lookup only; record content search lives on Explore).

## 3. Static guard tests

- [x] 3.1 Add static guard tests for `apps/web/src/app/dashboard/search/page.tsx`: no `rs-client` import, no record-search symbols, free-text redirects to Explore, exact-id branch preserved.
- [x] 3.2 Add static guard tests for `apps/console/src/app/dashboard/search/page.tsx`: same guards.
- [x] 3.3 Add static guard tests for `apps/web/src/app/sandbox/search/page.tsx`: no `ds.searchRecords*` calls, redirects to sandbox Explore.

## 4. OpenSpec artifacts

- [x] 4.1 Land `openspec/changes/narrow-search-to-spine-jump/proposal.md`.
- [x] 4.2 Land `openspec/changes/narrow-search-to-spine-jump/design.md`.
- [x] 4.3 Land `openspec/changes/narrow-search-to-spine-jump/tasks.md`.
- [x] 4.4 Land `openspec/changes/narrow-search-to-spine-jump/specs/reference-surface-topology/spec.md` spec delta.

## Acceptance checks

Run these before reporting done:

- `node --test apps/web/src/app/dashboard/search/page.test.ts` — all pass.
- `node --test apps/console/src/app/dashboard/search/page.test.ts` — all pass.
- `node --test apps/web/src/app/sandbox/search/page.test.ts` — all pass.
- `node --test apps/web/src/app/dashboard/explore/page.invariants.test.ts` — all pass.
- `openspec validate narrow-search-to-spine-jump --strict` — valid.
- `git diff --check` — no whitespace errors.

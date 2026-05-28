## 1. Spec deltas and design lineage

- [ ] 1.1 Land this proposal, design, and the `reference-implementation-architecture` spec delta as a reviewable artifact set.
- [ ] 1.2 Run `openspec validate narrow-search-to-spine-jump --strict` and `openspec validate --all --strict`.
- [ ] 1.3 Confirm with owner which UI shape (A: rename nav to `Jump`, B: retire nav entirely) ships in this tranche. Record the choice in the implementation lane report.

## 2. Trim `/dashboard/search` to spine-only

- [ ] 2.1 In `apps/web/src/app/dashboard/search/page.tsx`, remove `searchRecords`, `RecordPage`, `RetrievalDebug`, `buildRetrievalNotice`, `parsePrevStack`, `buildSearchTimestampMetadata` (if used only here), and every import that only supports the records-results section: `searchRecordsHybrid`, `searchRecordsLexical`, `searchRecordsSemantic`, `getRecord`, `getDeploymentDiagnostics`, `lookupSearchTimestampMetadata`, `pickSearchDisplayTimestamp`, `searchTimestampMetadataKey`, `SearchTimestampMetadata`, `shouldAttemptSemanticUplift`, `isHybridRetrievalAdvertised`, `isSemanticRetrievalAdvertised`, `listConnectorManifests`, `summarize`.
- [ ] 2.2 Refactor `loadSearchResult` to call only `refSearch` and return spine artifact buckets plus the exact-id `redirect()` branch.
- [ ] 2.3 When a query is present, `jump !== "0"`, and `spineResult.exact` is null, `redirect(`/dashboard/explore?q=${encodeURIComponent(query)}`)`. Forward an `Explore` link in any error-state copy so the operator path is obvious.
- [ ] 2.4 Mirror tasks 2.1–2.3 in `apps/console/src/app/dashboard/search/page.tsx`. The console page also has the `WarningsBanner` + `dedupeWarnings` helper around the records-results section; remove both since they only consume record-result warnings.
- [ ] 2.5 Mirror tasks 2.1–2.3 in `apps/web/src/app/sandbox/search/page.tsx`. Use the sandbox data source's `refSearch` only; remove the lexical record-results branch.

## 3. Slim the shared `SearchView`

- [ ] 3.1 In `apps/web/src/app/dashboard/components/views/search-view.tsx`, remove `SearchRecordHit`, the `hits`/`hasMore`/`nextCursor`/`prevStack` fields on `SearchData`, `RetrievalNoticeView`, `currentCursor`/`retrievalNotice`/`debugSlot` props, and the `RetrievalNoticeCallout`, `PaginationBar`, `RecordRow`, `RetrievalBadge`, `Highlight`, `searchHref`, and `encodePrevStack` helpers.
- [ ] 3.2 Update the page header copy: replace the `records · artifacts` total line with an artifacts-only count.
- [ ] 3.3 Mirror in `apps/console/src/app/dashboard/components/views/search-view.tsx`.
- [ ] 3.4 Delete the dead `apps/web/src/app/dashboard/search/search-filters-form.tsx` and its `apps/console` twin (no callers).

## 4. Nav, command palette, and copy

- [ ] 4.1 Implement the chosen Shape:
      - Shape A: change the `Search` nav label in `shell.tsx` (both apps) to `Jump`; keep the route `routes.section.search`. Update the matching `data-testid` if any test pins the label.
      - Shape B: remove the `Search` nav entry in `shell.tsx` (both apps). Update parity tests accordingly.
- [ ] 4.2 In both apps' `command-palette.tsx`, ensure the shortcut still points at `${basePath}/search` (rename label to match Shape A if chosen).
- [ ] 4.3 In `apps/web/src/app/dashboard/lib/actions.ts`, update the `nav-search` command title/description/keywords so the role is unambiguous: title `Jump` (Shape A) or remove (Shape B); description "Jump to a trace, grant, run, or connector by id."; keywords drop `search`/`record`/etc. references. Mirror in `apps/console/src/app/dashboard/lib/actions.ts`.
- [ ] 4.4 Update Search's empty-state copy in `SearchView` to read "Paste a trace, grant, or run id." with an explicit "Search records by text in Explore →" link.

## 5. Tests

- [ ] 5.1 Add a focused test asserting `apps/web/src/app/dashboard/search/page.tsx` does NOT reference `searchRecordsLexical`, `searchRecordsHybrid`, `searchRecordsSemantic`, or `getRecord`. Mirror in `apps/console`.
- [ ] 5.2 Add a focused test asserting `apps/web/src/app/sandbox/search/page.tsx` does NOT call any `ds.searchRecords*` method on its data source.
- [ ] 5.3 Add a focused test asserting `apps/web/src/app/dashboard/search/page.tsx` calls `redirect()` to `${routes.section.explore}` when a non-spine query is submitted without `jump=0`. Mirror in `apps/console`.
- [ ] 5.4 Update `apps/web/src/app/sandbox/_demo/mock-owner-shell.test.ts` (and any sibling tests) if Shape B is chosen and `search/page.tsx` is no longer expected to exist for parity. Otherwise, no change required.
- [ ] 5.5 `pnpm -C apps/web run types:check` and `pnpm -C apps/console run types:check` clean.

## 6. Validation

- [ ] 6.1 `openspec validate narrow-search-to-spine-jump --strict`.
- [ ] 6.2 `openspec validate --all --strict`.
- [ ] 6.3 `pnpm -C apps/web exec node --import tsx --test src/app/dashboard/explore/page.invariants.test.ts src/app/dashboard/search/page.test.ts src/app/sandbox/_demo/mock-owner-shell.test.ts` pass.
- [ ] 6.4 `pnpm -C apps/console exec node --import tsx --test src/app/dashboard/explore/page.invariants.test.ts src/app/dashboard/search/page.test.ts` pass.
- [ ] 6.5 Spot-check by hand or by stub data source: submitting a free-text query on `/dashboard/search?q=alpha&jump=1` lands on `/dashboard/explore?q=alpha`.
- [ ] 6.6 Spot-check that `/dashboard/search?q=tr_<known-trace>&jump=1` still redirects to the trace.
- [ ] 6.7 Spot-check that the command palette `Search` shortcut (or its renamed equivalent) reaches the page.

## Acceptance checks (reproducible commands)

- `openspec validate narrow-search-to-spine-jump --strict`.
- `pnpm -C apps/web run types:check`.
- `pnpm -C apps/console run types:check`.
- After implementation: `grep -n "searchRecordsLexical\|searchRecordsHybrid\|searchRecordsSemantic" apps/web/src/app/dashboard/search/page.tsx apps/console/src/app/dashboard/search/page.tsx apps/web/src/app/sandbox/search/page.tsx` returns no matches.
- After implementation: `/dashboard/search?q=<free-text>` (without `jump=0`) redirects to `/dashboard/explore?q=<free-text>`.

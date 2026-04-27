## 1. Foundation: wrapper module + extended registry

- [ ] 1.1 Promote `tmp/run-timeline-memory-regression-memo.md` (already moved to `design-notes/run-timeline-memory-regression-memo-2026-04-27.md`) and the audit table from `design-notes/audit-call-sites-2026-04-27.md` (to be created) into the change.
- [ ] 1.2 Create `reference-implementation/lib/db.ts` that imports `getDb` from `server/db.js` and exports the bounded primitives `getOne`, `getMany`, `iterate`, `exec`, `allowUnboundedReadAcknowledged`, `transaction`. Engine bootstrap stays in `server/db.js`.
- [ ] 1.3 Define branded types `ReadQuery`, `MutationQuery`, `SmallEnumerationQuery` so raw SQL strings cannot be passed to the wrapper primitives. Construction is gated through the registry loader and the small-enumeration manifest only.
- [ ] 1.4 Extend `reference-implementation/server/queries/index.ts` to recursively load every `.sql` file under `server/queries/`, parse SQL frontmatter (`-- @terminator: …`, `-- @cursor_field: …`, `-- @bounded_by: …`, `-- @max_rows: …`), validate each artifact with `db.prepare(sql)` at startup, and freeze the registry.
- [ ] 1.5 Enforce at startup: every artifact whose `terminator` is `'many'` SHALL contain a `LIMIT ?` placeholder OR be annotated `@bounded_by: small_enumeration_table @max_rows: <N>`. Mismatches throw with the offending file path.
- [ ] 1.6 Re-export `referenceQueries` and the registered-query handle types from `lib/db.ts` so call sites import the wrapper primitives and the query handles from one module.
- [ ] 1.7 Author wrapper unit tests: `getOne` returns null on no match; `getMany` enforces `limit > 0` and `limit <= MAX_LIMIT`; `getMany` returns `truncated: true` when `rows.length === limit + 1`; cursor encode/decode round-trip; `exec` returns `{ changes, lastInsertRowid }`; `transaction` rolls back on throw; `allowUnboundedReadAcknowledged` only accepts `SmallEnumerationQuery`-typed inputs.

## 2. Pathological sites: spine half (closes the 2026-04-27 OOM regression)

- [x] 2.1 Migrate `lib/spine.ts::listSpineEvents` (lines 383-411): replace with `listSpineEventsPage(kind, id, opts)` returning `{events, truncated, next_cursor, limit}`. The legacy `eventType` and bare-else branches are removed (no production callers).
- [x] 2.2 Migrate `lib/spine.ts::listSpineEventsSync` (lines 362-380) folded into the new page shape via internal `loadEventsForSummary` helper.
- [x] 2.3 Migrate `lib/spine.ts::listSpineCorrelations` per-row hydration (line 778): bounded by `SUMMARY_EVENT_CAP` (5,000 events). Closes the hidden quadratic.
- [x] 2.4 Migrate the three `_ref` timeline routes at `server/index.js:2111, 2122, 2133`: accept `limit` (default 2,000, max 5,000) and `cursor` query parameters; forward to `listSpineEventsPage`; return the additive envelope shape with `truncated`, `next_cursor`, `limit`.
- [x] 2.5 Migrate `server/ref-control.ts::toConnectorRunSummary` (line 298): replace `listSpineEvents({ runId })` + `extractKnownGaps` with `getOne(referenceQueries.spineGetRunTerminalEvent, [runId])` that returns the terminal event directly.
- [x] 2.6 `searchSpine` per-row hydration (line 896) bounded by the same `SUMMARY_EVENT_CAP`.

## 3. Deferred pathological sites (follow-up change `bound-grant-narrowed-search-and-streams`)

The remaining 7 pathological sites each touch a public spec surface (lexical-retrieval extension, semantic-retrieval extension, or `/v1/streams` discovery floor) and warrant focused changes with parity-test infrastructure. The spine-half migration closes the actual 2026-04-27 OOM regression; these follow-ups close the structural-prevention coverage gap. Tracked separately:

- `server/search.js:803` (lexical search candidate builder) — push grant `time_range` and `resources` into the FTS query itself; eliminate the unbounded candidate-key scan.
- `server/search-semantic.js:1392` (semantic search candidate builder) — same shape as lexical.
- `server/records.js:1966` (`listStreams` per-stream full scan) — replace JS-side visible-record counting with SQL `COUNT(*)` plus pushed-down `time_range` predicate.
- `server/index.js:1503` (blob bindings UNION read) — wrapper-consistency migration, no semantic change.
- `server/records.js:1930` (`deleteAllRecords` distinct-stream scan) — wrapper-consistency migration.
- `server/records.js:2218` (`getTopConnectorsByRecordCount`) — already SQL-bounded by `LIMIT ?`; wrapper-consistency only.
- `server/records.js:1944-1947` (`deleteAllRecords` DELETE cluster) — wrapper-consistency migration of mutations.

## 4. Bulk migration: the remaining 162 correct-by-discipline sites

The audit at `design-notes/audit-call-sites-2026-04-27.md` enumerates all 177 sites. After §2 closed 8 spine-half pathological sites and §3 deferred 7 to a follow-up change, the remaining 162 are mutations (~110), single-row PK lookups (~30), small-enumeration reads (~25), and four already-streaming sites that need only wrapper passthrough. Sub-agents drive batches of ~10 sites each in parallel; each batch is one commit's worth of diff.

- [ ] 4.1 Mutations under `server/auth.js` (`pending_consents`, `owner_device_auth`, `oauth_clients`, `connectors`, `grants`, `tokens`): move SQL into `server/queries/auth/*.sql`, call via `db.exec(...)`. Behavior unchanged.
- [ ] 4.2 Mutations under `server/records.js` (`records`, `record_changes`, `version_counter`, `blob_bindings`, sync-state tables): move SQL into `server/queries/records/*.sql`, call via `db.exec(...)`.
- [ ] 4.3 Mutations under `server/search.js` and `server/search-semantic.js` (lexical/semantic index DDL and DML): move SQL into `server/queries/search/*.sql` and `server/queries/semantic/*.sql`, call via `db.exec(...)`.
- [ ] 4.4 Single-row PK lookups under `server/auth.js`: move SQL into `server/queries/auth/get-*.sql` with `LIMIT 1`, call via `db.getOne(...)`.
- [ ] 4.5 Single-row PK lookups under `server/records.js`: move SQL into `server/queries/records/get-*.sql`, call via `db.getOne(...)`.
- [ ] 4.6 Small-enumeration reads (`server/auth.js::listRegisteredConnectorIds`, `server/records.js::getRealWorldTimeBounds`, similar): move SQL into appropriate `server/queries/*` artifact, annotate `@bounded_by: small_enumeration_table @max_rows: <documented_max>`, call via `db.allowUnboundedReadAcknowledged(...)` with adjacent `// REVIEWED-BOUNDED:` comment.
- [ ] 4.7 Already-streaming `.iterate()` sites under `server/records.js` (lines 856, 1010, 1173, 1310): move to `iterateDynamicSqlAcknowledged` with adjacent `// REVIEWED-DYNAMIC:` comments since their SQL is composed at call time.
- [ ] 4.8 Migrate `runtime/controller.ts` sites (lines 642, 798, 830, 838, 859, 883): persistence and schedule-mutation queries move into `server/queries/controller/*.sql`, called via `db.exec(...)` and `db.iterate(...)`.
- [ ] 4.9 Migrate `fetchVisibleRecordRowsPaginated` (`server/records.js:885+`) and the other dynamic-WHERE builders to `iterateDynamicSqlAcknowledged` with `// REVIEWED-DYNAMIC:` comments. SQL is composed in JS as today; the wrapper is the chokepoint.

## 5. Lefthook gate

- [ ] 5.1 Add a `reference-implementation:no-direct-prepare` job to `lefthook.yml` modeled on the existing `polyfill-connectors:no-double-cast` precedent. The job greps staged files in `reference-implementation/{lib,server,runtime,cli}/**/*.{ts,js}` for `\.prepare\(` or `getDb\(\)\.prepare\(`, allow-listing only `reference-implementation/lib/db.ts` itself and `reference-implementation/server/db.js` (the engine bootstrap, which legitimately calls `raw.prepare()` to back the cached-prepare Proxy).
- [ ] 5.2 Add a `reference-implementation:reviewed-bounded-comment` job that requires every staged-file `allowUnboundedReadAcknowledged` call to be preceded by an adjacent `// REVIEWED-BOUNDED:` comment.
- [ ] 5.3 Add a `reference-implementation:reviewed-dynamic-comment` job that requires every staged-file `iterateDynamicSqlAcknowledged` call to be preceded by an adjacent `// REVIEWED-DYNAMIC:` comment AND that the dynamic SQL passed to it includes a `LIMIT` keyword.
- [ ] 5.4 Verify all three gates trigger on synthetic violation files; confirm rejection; remove scratch files.

## 6. Public envelope migration on apps/web

- [ ] 6.1 Extend `apps/web/src/app/dashboard/lib/ref-client.ts::normalizeTimeline` (line 51) to surface `truncated` and `next_cursor` on the typed envelope.
- [ ] 6.2 Update the run-detail, grant-detail, and trace-detail pages under `apps/web/src/app/dashboard/{runs,grants,traces}/[id]/page.tsx` to render a "more events available" affordance when `truncated === true` and to fetch the next page on demand. Minimum behavior: the dashboard does not silently drop events beyond the page boundary.
- [ ] 6.3 Confirm the sandbox's mock `_ref` routes under `apps/web/src/app/sandbox/_ref/*` are updated to emit the same additive envelope shape so sandbox + live behave identically.

## 7. Repro harness extension and verification

- [ ] 7.1 Extend `repro-crash.sh` (the archived change's frozen N-run harness) to also exercise `/dashboard/runs?peek=…`, `/dashboard/grants/…`, `/dashboard/traces/…` URLs alongside the existing dashboard URLs. Use a representative `runId` from the current substrate.
- [ ] 7.2 Run `bash repro-crash.sh --runs=5` against the current substrate **before** any code change in this PR lands; baseline the PASS/FAIL rate. Record in `design-notes/repro-baseline-2026-04-27.md`.
- [ ] 7.3 Run `bash repro-crash.sh --runs=5` again **after** §2 lands; confirm PASS rate matches the archived change's bar (5/5 survive).
- [x] 7.4 Add a runtime test that asserts `db.getMany(query, params, { limit: 0 })` throws with `UnboundedReadError`. (db-wrapper.test.js)
- [x] 7.5 Add a runtime test that asserts a `.sql` artifact registered as `terminator: 'many'` without `LIMIT ?` and without `@bounded_by` causes server boot to throw with the artifact path. (query-registry.test.js)
- [ ] 7.6 Add a runtime test that asserts the three `_ref` timeline endpoints accept `limit` and `cursor`, return `truncated: true` when applicable, and that paging through `next_cursor` yields a stable, non-overlapping event sequence.

## 8. Cleanup

- [ ] 8.1 Update `reference-implementation/AGENTS.md` (and equivalent docs that mention `db.prepare`) to point at the wrapper API.
- [ ] 8.2 Confirm that no production read path imports `getDb` directly anymore (the only legitimate consumers of `getDb` are `lib/db.ts` itself and the engine internals in `server/db.js`).
- [ ] 8.3 Re-run `pnpm --dir reference-implementation run verify` end-to-end.

## 9. Validation

- [ ] 8.1 `openspec validate bound-spine-and-record-read-paths --strict`.
- [ ] 8.2 `openspec validate --all --strict`.
- [ ] 8.3 `pnpm --dir reference-implementation run verify`.
- [ ] 8.4 Full reference test suite (`pnpm --dir reference-implementation run test`).
- [ ] 8.5 `bash repro-crash.sh --runs=5` against current substrate; PASS = 5/5.
- [ ] 8.6 `pnpm --filter pdpp-web run verify` (apps/web typecheck, build, dashboard renders).
- [ ] 8.7 Manual smoke: open `/dashboard/runs?peek=run_1776643908440` (worst-case current run, 2,542 events) and confirm the page renders without OOM, with the `truncated`/`next_cursor` affordance visible.

## Deferred follow-up

- [ ] Per-route concurrency cap with coupled dashboard 503 retry + partial-failure coordination. The bounded read-path rewrite alone resolves the measured pathology, but a concurrency cap remains a useful defense-in-depth defense. Take up when a measured remaining problem justifies the scope.
- [ ] Response-size budget hook. Same rationale.
- [ ] Process-supervisor mandate. Same rationale.
- [ ] Migrate `apps/web` SSR fan-out to use the paginated timeline shape natively rather than just the structural envelope (§5 lands the structural; this would land the visual).
- [ ] Replace the lefthook grep gates with a Biome plugin once Biome's plugin support ships and Ultracite ships a compatible config.
- [ ] Grandfathered direct-`db.prepare(...)` call sites that the lefthook gate exempts because they pre-date the wrapper (the gate fires only on new staged-file diffs). Migrate when an opportunity edit touches them, or in a focused follow-up. Surveyed 2026-04-27:
  - `lib/spine.ts:302` — `emitSpineEvent` INSERT (named-property binding object; needs positional shape or wrapper support for `@name` placeholders).
  - `lib/spine.ts:847` — `listSpineCorrelations` aggregate (dynamic WHERE/HAVING; same shape as `fetchVisibleRecordRowsPaginated`; would migrate to `iterateDynamicSqlAcknowledged`).
  - `lib/spine.ts:934` — `searchSpine` exact-match probe (dynamic column name interpolation; would migrate to `iterateDynamicSqlAcknowledged`).
  - `server/search-semantic.js:564, 574, 593, 598, 611` — vec0 virtual-table runtime DDL/DML with backend-derived dimensions. These genuinely cannot live as static `.sql` artifacts because the table is created at runtime with backend-resolved `FLOAT[N]` dimensions. Needs an `execDynamicSqlAcknowledged` primitive (parallel to `iterateDynamicSqlAcknowledged`) to migrate cleanly. Defer with the candidate-builder follow-up.
- [ ] Stripe SafeSQL pattern: log every escape-hatch call site (count, file:line) to a CI artifact so the surface area of `allowUnboundedReadAcknowledged` and `iterateDynamicSqlAcknowledged` use stays auditable as the codebase grows. Cheap follow-up; not gate-blocking.

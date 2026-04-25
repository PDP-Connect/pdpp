## 1. Inventory

- [x] Re-audit `swap-sqlite-driver/tasks.md` and classify every remaining query-extraction checkbox as static, dynamic, or obsolete.
  - 2026-04-24 proof slice: `swap-sqlite-driver` is archived at `openspec/changes/archive/2026-04-25-swap-sqlite-driver/`; its only query-extraction follow-up is transferred to this change. Static extraction remains active here, dynamic builders remain in code, and obsolete driver-swap work is complete.
- [x] Count current SQL call sites across `server/`, `runtime/`, `lib/`, and tests.
  - 2026-04-24 proof slice count after the registry/test addition: 285 `prepare`/`exec` matches total (`server`: 164, `runtime`: 10, `lib`: 13, `test`: 98).
- [x] Identify dynamic query sites that should explicitly stay in code.
  - 2026-04-24 proof slice: dynamic builders remain in `records.js` for grant/resource filters, cursor predicates, expansion `IN (...)` lists, and order clauses; in `search.js`/`search-semantic.js` for authorized stream/resource plans and variable candidate sets; in `lib/spine.ts` for correlation filters and checked dynamic columns; and in `ref-control.ts` for records timeline filters/timestamp ordering.

## 2. Query Registry

- [x] Add `reference-implementation/server/queries/` with a deterministic loader.
- [x] Map query file names to stable camelCase registry keys.
- [x] Fail fast when a required query artifact is missing or malformed.

## 3. Extraction

- [x] Extract one low-risk server module first and validate the pattern.
  - 2026-04-24 proof slice: extracted `list-registered-connectors.sql` and wired `ref-control.ts` connector listing through `referenceQueries.listRegisteredConnectors`.
- [ ] Extract remaining static server/runtime/lib statements in small commits.
- [ ] Extract test-only static statements only where it improves readability.
- [x] Leave dynamic query builders in code with short comments explaining why.
  - 2026-04-24 proof slice: documented the touched `ref-control.ts` timeline dynamic builder; broader dynamic builders listed above remain for later extraction slices.

## 4. Validation

- [x] Add a query/schema validation command or test.
  - 2026-04-24 proof slice: `reference-implementation/test/query-registry.test.js` validates deterministic loading and prepares extracted queries against the reference schema.
- [x] Run the focused reference test suites touched by extraction.
  - 2026-04-24 proof slice: `node --test reference-implementation/test/query-registry.test.js` and `node --test reference-implementation/test/control-actions.test.js` passed.
- [x] Run `pnpm --dir reference-implementation run verify`.
  - 2026-04-24 proof slice: passed after tightening the required-query registry type and moving loader regexes to module scope.
- [x] Run `openspec validate make-reference-queries-inspectable --strict`.
  - 2026-04-24 proof slice: passed.
- [x] Run `openspec validate --all --strict`.
  - 2026-04-24 proof slice: passed, 12 items.

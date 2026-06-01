## 1. Spec Delta

- [x] Modify the `Public read warnings SHALL be structured and closed over known non-fatal outcomes` requirement under `reference-implementation-architecture` to admit a clamped page limit as a known non-fatal outcome, with a `limit_clamped` scenario covering clamp, in-range no-op, invalid-limit fallback, and fan-in dedup.
- [x] Modify the `MCP read tools SHALL mirror the canonical public read contract` requirement to add a scenario enforcing the records-list `limit` cap at MCP input validation (inclusive maximum 100, reject over-max, accept ≤ max).
- [x] Run `openspec validate add-records-limit-clamp-warning --strict` and `openspec validate --all --strict`.

## 2. Shared Clamp Primitive

- [x] Add `RECORDS_DEFAULT_PAGE_LIMIT` (25) and `RECORDS_MAX_PAGE_LIMIT` (100) named constants plus a pure `clampRecordsPageLimit(rawLimit)` helper in `reference-implementation/server/connection-id-request.js` (the module both record paths already import), returning `{ limit, requested, clamped }`.
- [x] Add a `buildLimitClampedWarning(requested)` helper emitting the canonical `{ code, param, message }` warning shape with the new `limit_clamped` code.
- [x] Add `LIMIT_CLAMPED: 'limit_clamped'` to `CANONICAL_WARNING_CODES` with a doc comment.

## 3. Runtime Wiring (REST/RS, additive)

- [x] Replace the inline `Math.min(parseInt(...) || 25, 100)` clamp in `server/records.js` `queryRecords` with `clampRecordsPageLimit`; push a `limit_clamped` warning into `requestWarnings` when clamped, so it flows through the existing `attachRequestWarningsToResponse` for both the normal and `changes_since` return paths.
- [x] Replace the duplicated `parseLimit`/`DEFAULT_LIMIT`/`MAX_LIMIT` in `server/postgres-records.js` with the shared helper and emit the same warning into `requestWarnings`.
- [x] Confirm multi-connection fan-in deduplicates the warning (per-binding emission collapses via `appendUniqueWarning`).
- [x] Confirm the `limit_clamped` warning rides the existing `meta.warnings[]` channel; no new envelope field shape introduced.

## 4. MCP Conformance Fix

- [x] Tighten the MCP `query_records` `limit` input schema from `max(1000)` to `max(100)` in `packages/mcp-server/src/tools.js` so an over-max value is rejected at input validation, with a `LIMIT_DESCRIPTION` documenting the cap.
- [x] Update the `query_records` tool description: limit is capped at 100, the MCP layer rejects over-max rather than clamping, and a direct REST client is clamped with a `limit_clamped` warning.

## 5. Tests

- [x] `reference-implementation/test/records-limit-clamp.test.js`: helper unit coverage (default/in-range/over-max/invalid); end-to-end `queryRecords` clamp + `limit_clamped` warning at `limit=500`; no warning for in-range/default/at-max; multi-connection fan-in single deduplicated warning.
- [x] `packages/mcp-server/test/schema-token-budget.test.js`: `query_records` input schema advertises inclusive `maximum: 100` and rejects `limit=500` at input validation; description names the cap and the `limit_clamped` warning.
- [x] Repoint `packages/mcp-server/test/record-payload-token-budget.test.js` fat-page lever from `limit: 500` to the in-contract `limit: 100`.

## 6. Validation

- [x] `node --test test/records-limit-clamp.test.js`
- [x] `node --test packages/mcp-server/test/*.test.js` (full mcp-server suite)
- [x] `pnpm --dir reference-implementation run verify` (typecheck + check)
- [x] Full `node reference-implementation/scripts/run-tests.js`
- [x] `git diff --check`

## Acceptance Checks

- [x] `openspec validate add-records-limit-clamp-warning --strict`
- [x] `openspec validate --all --strict`
- [x] REST default and in-range `limit` behavior is unchanged (no new 400s); `limit > 100` returns ≤100 rows plus a `limit_clamped` warning instead of a silent clamp.
- [x] MCP `query_records` rejects `limit > 100` at input validation and advertises `maximum: 100`.
- [x] SQLite and Postgres record paths share one clamp primitive and one warning code.

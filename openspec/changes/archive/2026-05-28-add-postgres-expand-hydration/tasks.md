## 1. Promote shared expansion helpers

- [x] 1.1 Extract the helpers the Postgres backend will reuse — `normalizeExpandRequest`, `buildEffectiveFilter`, `normalizePrimaryKey`, `parseIntegerValue`, `invalidQueryError`, `SAFE_JSON_FIELD`, and `assertSafeJsonField` — into a new `reference-implementation/server/record-expand-helpers.js` module so both backends import from the same source. (Originally framed as "add named exports to records.js"; extracting avoids the circular import between `records.js` and `postgres-records.js`.)
- [x] 1.2 Update `records.js` to import the helpers from the new module instead of defining local copies, leaving the SQLite call sites unchanged.

## 2. Implement Postgres expansion hydration

- [x] 2.1 In `reference-implementation/server/postgres-records.js`, import the shared helpers and add a `rejectExpandWithChangesSince` guard so `expand + changes_since` rejects with `invalid_expand` before any SQL runs. Validate the expand request shape up front with `normalizeExpandRequest`.
- [x] 2.2 Implement `hydratePostgresExpandedRelations({ connectorInstanceId, expansions, parentRows, manifest })` mirroring `records.js#hydrateExpandedRelations`. For each expansion, run one batched window-function query of the shape documented in `design.md §3` (`ROW_NUMBER() OVER (PARTITION BY <fk> ORDER BY <cursor>, <pk>)`).
- [x] 2.3 Push child-grant `time_range` and `resources` into the child SQL `WHERE` clause exactly as the SQLite path does. Use bound parameters for all values; re-validate JSON field identifiers with the shared `SAFE_JSON_FIELD` regex before interpolating them into SQL.
- [x] 2.4 Apply child field projection (via `buildEffectiveFilter(childGrant, {}, requiredFields)` then `projectFields`) before assembling each child response record, so the response envelope matches SQLite's child projection.
- [x] 2.5 Emit `expanded.<name>` as an object on each parent response record. For `has_one`, the value is a single record (or `null`). For `has_many`, the value is `{ object: 'list', has_more, data: [...] }` with `has_more` driven by the `+1` overflow from the window query.
- [x] 2.6 Wire hydration into `postgresQueryRecords`: after the parent page is fetched, call the hydrator. Reject `expand` combined with `changes_since` with `invalid_expand` before any query runs.
- [x] 2.7 Wire hydration into `postgresGetRecord`: after the single record is loaded, call the hydrator with a one-element `parentRows` array. Reuse the same helper so list and detail share semantics.

## 3. Per-deployment capability advertisement — DEFERRED

Flipping the host's `referenceReadCapabilities` projection to advertise
`read_capabilities.expand: true` for Postgres deployments is deferred to
a follow-up change. Current main does not yet have the
`projectReadCapabilities` / `supportsExpand` capability projection
foundation that flip depends on. The hydration implementation in section
2 stands alone: it makes Postgres honor expand requests instead of
silently ignoring (or, where wired, rejecting) them. The capability
advertisement will be a one-line input change once the projection
foundation lands, and will not require any additional Postgres-side
work.

## 4. Tests

- [x] 4.1 Add `reference-implementation/test/postgres-expand-hydration.test.js` gated on `process.env.PDPP_TEST_POSTGRES_URL`. When unset, register one skipped test. When set, the suite drives `queryRecords` / `getRecord` against the Postgres backend via the public `records.js` API.
- [x] 4.2 Cover, at minimum:
  - List endpoint: `expand=recently_played` with `expand_limit[recently_played]=1` returns one child per parent and `has_more: true` when more children exist.
  - Detail endpoint: `getRecord` with `expand=recently_played` returns the same shape.
  - Insufficient scope: `expand=recently_played` without a `recently_played` grant rejects with `insufficient_scope`.
  - Unsupported relation: `expand=not_a_relation` rejects with `invalid_expand`.
  - `expand_limit` exceeds `max_limit`: rejects with `invalid_expand`.
  - `changes_since` incompatibility: `expand=…&changes_since=beginning` rejects with `invalid_expand`.
  - Cross-connector-instance isolation: a sibling instance's child rows never leak into the expansion.
  - Child grant projection: a child field outside the grant is absent from the expanded record.

## 5. Validation

- [x] 5.1 `openspec validate add-postgres-expand-hydration --strict`.
- [x] 5.2 `node --test --import tsx reference-implementation/test/postgres-expand-hydration.test.js` — confirms the new Postgres parity tests register cleanly (skipped without `PDPP_TEST_POSTGRES_URL`).
- [x] 5.3 `PDPP_TEST_POSTGRES_URL=<isolated db> node --test --import tsx reference-implementation/test/postgres-expand-hydration.test.js` — confirms live Postgres parity against an isolated test database.
- [x] 5.4 `node --test --import tsx reference-implementation/test/rs-records-list-operation.test.js reference-implementation/test/query-contract.test.js reference-implementation/test/rs-records-detail-operation.test.js` — confirms the SQLite records path still passes after helper extraction.

## Acceptance Checks (Reproducible)

- `node --test --import tsx reference-implementation/test/postgres-expand-hydration.test.js` exercises the Postgres expand path under `PDPP_TEST_POSTGRES_URL`.
- `openspec validate add-postgres-expand-hydration --strict` validates the change.

## Known Acceptable Baseline Failures

None expected from this change. The Postgres test path is opt-in; the SQLite path and contract conformance must remain green. The deployment-level capability advertisement is intentionally not modified by this change.

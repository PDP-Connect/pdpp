# w1 Postgres records decomposition plan

Status: **awaiting orchestrator sign-off; implementation is paused.**

## Preconditions and invariants

- Target: `reference-implementation/server/postgres-records.js`.
- Base branch: `curation/lfdt-prep`; worktree branch: `waspflow/w1-pgrecords`.
- `reference-implementation/server/records.js` is out of scope and will not be touched.
- Every current export from `postgres-records.js` remains exported there with the same signature and behavior. The new modules are internal implementation details, not new public entry points.
- Route behavior, SQL result ordering, query sequencing, error types/codes/messages/params, response shapes, warning order, cursors, projection, and grant visibility are preserved.
- The required baseline is currently blocked before test execution because this worktree cannot resolve `pg` and `better-sqlite3`; details are in `w1p-report.md`. Even after plan approval, implementation will not begin until the exact PIN suite is green.

## Problem observed in the target

The 1,934-line file braids four different reasons for change:

1. Public read-contract decisions (parameter compatibility, ordering, cursor validity, projection, warning/meta shape).
2. Postgres read execution (current-page queries, change-feed snapshot reads, count/window reads, field-window reads).
3. Relationship expansion (child-manifest validation, per-parent ranked SQL, bucketing, and cardinality-shaped attachment).
4. Write/maintenance/blob/dataset capabilities.

The main complexity is not the file length by itself. `postgresQueryRecords` currently validates the public contract, selects a read mode, assembles SQL, performs I/O, evaluates grant visibility, hydrates relations, computes aggregates, and shapes the wire response in one control-flow unit. `hydratePostgresExpandedRelations` similarly interleaves expansion policy, SQL construction, I/O, grouping, and mutation. Those braids prevent local reasoning and are the semantic defects behind the complexity metric.

## Module boundary 1: `server/postgres-record-read.js`

### Concern owned

The complete Postgres-backed **record read engine**: query/list, changes feed, single-record fetch, field-window fetch, count/window metadata, cursor codec, public record projection, and request-warning attachment.

### Why this is a real boundary

- All members change for the same reason: the records read contract or its Postgres execution changes.
- It separates read policy and read effects from ingest/versioning/retention, blobs, dataset aggregates, and destructive maintenance.
- The module exposes a small facade hiding substantial depth: three implementation entry points corresponding to the three existing public read capabilities. It will not export its internal validators, SQL fragments, codecs, or response helpers.
- It will not import `postgres-records.js`. The dependency remains one-way: the compatibility facade imports the read engine.
- This is not a whole-branch relocation. The large query function is decomposed internally into pure decisions and effectful application as described below.

### Interface

Internal named exports (names may be adjusted mechanically, signatures will carry the existing inputs unchanged):

- `queryPostgresRecords(storageTarget, stream, grant, requestParams, manifest)`
- `getPostgresRecord(storageTarget, stream, recordId, grant, manifest, requestParams)`
- `getPostgresRecordFieldWindow(storageTarget, stream, recordId, fieldPath, grant, manifest, requestParams)`

`postgres-records.js` keeps the existing `postgresQueryRecords`, `postgresGetRecord`, and `postgresGetRecordFieldWindow` exports as compatibility delegates. These delegates are required by the no-public-API-change constraint; they are not additional conceptual layers exposed to callers.

### Internal decide/apply decomposition

1. **Prepare the read request (pure decision).**
   - Validate `count`, `window`, `sort`, legacy `order`, changes-feed exclusions, and expand incompatibility.
   - Resolve fields/effective grant, order, clamped limit/warnings, manifest stream, compiled filters, and mode (`changes` or `list`).
   - Return a discriminated read-plan value. Validation remains before SQL, preserving current failure precedence.

2. **Apply connection scoping and identity (effectful shell).**
   - Preserve connection-narrowing enforcement and the current best-effort identity lookup/degradation behavior.
   - Pass the resolved identity into either mode executor.

3. **Changes feed: load, decide, apply.**
   - Pure cursor decision returns the starting version or the existing `invalid_cursor` error.
   - Effectful loader reads session max, retained-history floor, change rows, and the two snapshots per row in the current sequence.
   - A pure `decideVisibleChange` classifies each loaded tuple as `omit`, `deleted`, or `upsert` using resource/time/filter/projection rules.
   - The effectful loop applies that decision to the response array without changing order or query sequencing.

4. **List page: build, execute, shape.**
   - A pure SQL-plan builder returns `{ sql, params, countScope, cursorBasis }`; filter-only count/window scope is captured before cursor narrowing exactly as today.
   - An effectful executor runs the page query.
   - A pure page projector produces response records and next-cursor data.
   - Relation hydration and aggregate reads remain effects after the main page query and in their current order.

5. **Count/window: table-driven grade dispatch.**
   - `none` decides no work; `exact` and `estimated` share the existing exact-result application path (including projected-count optimization and silent upgrade semantics).
   - Window planning separates the decision to omit/total-only/read bounds from the actual SQL calls and ISO normalization.

6. **Single-record and field-window reads.**
   - SQL execution stays effectful.
   - Resource/time visibility and field-window outcome classification become pure decisions returning data or the same typed error to throw.
   - Field-window SQL remains one statement; only selector-to-query parameters and row-to-envelope decisions are separated.

### Guard-clause and dispatch changes

- Replace nested visibility/cardinality branches with early-return classifiers.
- Use closed lookup tables only for stable vocabularies (`count` grade, range operator to SQL operator); do not hide ordering-sensitive control flow in generic dispatch machinery.
- Preserve explicit sequential loops where database call order is observable or operationally relevant.

## Module boundary 2: `server/postgres-record-expansion.js`

### Concern owned

Postgres relationship expansion for record reads: validate one declared relationship, construct the batched per-parent ranked query, execute it, group child rows, and attach the cardinality-specific expansion envelope.

### Why this is a real boundary

- Expansion is a declared relational sub-query engine with its own manifest/grant policy, SQL ranking semantics, per-parent limit, and `has_one`/`has_many` wire representation.
- It changes independently from base record pagination, changes feeds, ingest, and blobs.
- Its single facade (`hydratePostgresExpandedRelations`) hides manifest validation, safe-field checks, effective child grants, window-function SQL, row bucketing, and response attachment.
- It does not import `postgres-records.js`; it depends only on existing shared contract helpers and Postgres query execution.
- The extraction includes an internal policy/mechanism split, so the existing 180-line loop is not merely moved.

### Internal decide/apply decomposition

1. `planExpansion` is pure: validate child stream/primary key/cardinality inputs; derive child projection; create SQL, params, rank bound, and attachment metadata.
2. `executeExpansionPlan` is effectful: perform exactly one query per expansion, sequentially as today.
3. `indexExpansionRows` is pure: produce foreign-key buckets.
4. `buildExpansionValue` is pure and table-driven by cardinality: produce `null`/record for `has_one`, or list/`has_more` for `has_many`.
5. A narrow apply step mutates only `responseRecord.expanded[expansion.name]`, preserving current response assembly and expansion order.

## What stays in `server/postgres-records.js`

- All current public exports and their signatures.
- Postgres manifest cache/invalidation and sort-position backfill. The cache is shared by ingest and maintenance, so folding it into the read module would create a reverse dependency or duplicate state.
- Record identity/key/semantic-time preparation needed by ingest.
- Version allocation, ingest/no-op/self-heal, history pruning, retained-size deltas, and delete ingestion.
- Stream listing and durable-tail deletion.
- Blob persistence/loading/binding reads.
- Dataset aggregate queries.
- The three read exports remain as compatibility delegates to `postgres-record-read.js`.

Small pure functions will move only when their entire reason for change belongs to the read engine. Helpers still used by write/maintenance stay local; no generic `utils` or helper-bag module will be introduced.

## Expected cognitive-complexity movement

Current task-provided baseline: **251 total excess mass** in `postgres-records.js`. A fresh per-function measurement is not currently available because Biome configuration resolution also requires the missing installed dependencies (`ultracite/biome/core`). These are estimates to be verified, not claimed results.

| Surface | Expected excess after decomposition | Rationale |
| --- | ---: | --- |
| `postgres-records.js` | 60–90 | The read-mode branch and expansion loop leave; ingest/versioning remains the principal complex workflow. Target is below the required 100. |
| `postgres-record-read.js` | 15–35 | Mode executors become shallow orchestration over pure plans/classifiers; no single helper is intended to exceed the Biome threshold. |
| `postgres-record-expansion.js` | 0–15 | Policy planning, query execution, bucketing, and cardinality shaping are separate chunks behind one facade. |
| Total touched surface | 75–140 | Expected material reduction of roughly 44–70% from 251, not just transfer between files. |

If total excess merely migrates into either extracted module, the design has failed and will be revised before landing. If the target stays at or above 100, another real concern seam must be identified; functions will not be split solely to game the threshold.

## Coherent implementation/commit sequence after approval

Each mechanical step will be delegated to the requested cheaper `codex exec` sub-worker, then reviewed, gated, and committed by this lane.

1. Restore dependency availability outside the refactor diff and rerun the exact seven-file PIN suite. Stop if red.
2. Extract and internally decompose relationship expansion into `postgres-record-expansion.js`; review diff, run covering tests/typecheck/Biome, commit.
3. Build the pure request/read-plan seam inside `postgres-record-read.js`, initially keeping behavior mechanically equivalent; review and commit only with green gates.
4. Move and decomplect the changes-feed executor; review and commit.
5. Move and decomplect the paginated-list/count/window executor; review and commit.
6. Move single-record and field-window reads; review and commit.
7. Run final full gates, read every touched file, grep for stale moved names/import paths, obtain independent checker evidence, and update `w1p-report.md` with measured results.

No step combines behavior changes with structural changes. A failing gate is revised/reverted; it is never solved by altering the oracle.

## Test expectations suspected to need changing

**None.** This design requires no expectation changes and proposes no new wire behavior.

If any existing expectation appears incompatible with the decomposition, implementation stops and the exact proposed oracle change plus reasoning is reported for orchestrator approval. Characterization tests may be added only when they assert existing behavior; existing expectations will not be edited without approval.

## Review questions for the orchestrator

1. Approve the two internal module boundaries (`postgres-record-read.js` and `postgres-record-expansion.js`) and the compatibility delegates remaining in `postgres-records.js`?
2. Approve keeping ingest/versioning untouched even if it remains the largest residual contributor, provided the target file is below 100 and total touched-surface excess drops materially?
3. Confirm dependency restoration is expected to happen outside this lane's refactor diff before the green PIN rerun.

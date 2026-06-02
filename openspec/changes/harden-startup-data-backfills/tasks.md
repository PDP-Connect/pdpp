# Tasks: harden startup data backfills

## 1. Postgres boot path

- [x] 1.1 In `reference-implementation/server/postgres-storage.js`, split
  `migratePostgresSpineSourceColumns()` into a boot-safe DDL step (add
  `source_kind`/`source_id`, drop `provider_id` if present, create
  `idx_pg_spine_events_source`) and remove the full-table `SELECT … FROM
  spine_events` + per-row `UPDATE` backfill from the boot path.
- [x] 1.2 Export `deriveSpineSource` from `postgres-storage.js` so the
  maintenance script reuses the canonical derivation (single source of truth).
- [x] 1.3 No long transaction at boot. The DDL is individual idempotent
  statements; the row-count assertion (which only made sense to guard the
  removed backfill) is dropped.

## 2. SQLite boot path

- [x] 2.1 In `reference-implementation/server/db.js`, split
  `migrateSpineSourceColumns()` the same way: boot keeps the bounded DDL and the
  index; remove the unbounded per-row backfill from the boot runner.
- [x] 2.2 Removed the dead `user_version = 1` write (it gated nothing — the
  migration ran every boot regardless) so no no-op version stamp implies
  convergence. The result object no longer carries `backfilledRows`.

## 3. Maintenance script

- [x] 3.1 Added `reference-implementation/scripts/backfill-spine-source/`
  modeled on `compact-record-history.mjs`: direct-DB-access auth, dry-run
  default, `--apply`, `--batch-size`, `--max-batches`. **Postgres only** — the
  reader-blocking lock problem is Postgres-specific and the existing
  `compact-record-history` precedent is also Postgres-only. SQLite is
  embedded/single-process; its boot likewise no longer backfills and reads
  derive source from `data_json`.
- [x] 3.2 Selects only NULL-source rows, batches in short transactions, reuses
  the exported `deriveSpineSource`, writes `source_kind`/`source_id` and the
  `data_json.source` mirror only for rows it resolves.
- [x] 3.3 Resumable and convergent via a keyset cursor on the unique monotonic
  `event_seq`: the cursor advances past unresolvable rows so the run terminates;
  reports `scanned` / `resolved` / `unresolvable` / `written` / `batches`.

## 4. Tests

- [x] 4.1 Postgres (`test/spine-source-boot-backfill.test.js`): proven by
  observable state — a RESOLVABLE NULL-source row (runtime actor) stays NULL
  across a simulated reboot, which is only possible if boot does not backfill.
  (Stronger than query interception: a query spy could miss an indirect write;
  observed final state cannot.)
- [x] 4.2 Postgres: boot creates the `source_kind`/`source_id` columns and the
  `idx_pg_spine_events_source` index on a fresh DB.
- [x] 4.3 Maintenance script: seed resolvable (runtime-actor) + genuinely
  sourceless rows; dry-run writes nothing and reports the split (`batchSize=1`
  pages row-by-row); `--apply` resolves the resolvable rows in bounded batches,
  leaves sourceless rows NULL, mirrors `data_json.source`, and a second run is a
  no-op.
- [x] 4.4 SQLite: `test/event-spine.test.js` updated to assert the new boot
  contract — DDL applied (columns added, `provider_id` dropped, row count
  preserved) and `source_*` left NULL (no boot backfill). SQLite has no separate
  backfill script (see 3.1).

## 5. Validation

- [x] 5.1 `pnpm --dir reference-implementation run typecheck` — pass.
- [x] 5.2 Targeted `node --test` for the new tests against a temporary Postgres
  DB (`PDPP_TEST_POSTGRES_URL`) — `spine-source-boot-backfill.test.js` 4/4 pass;
  `event-spine.test.js` 46/46 pass; `migrate-storage.test.js` 73/73 pass.
- [x] 5.3 `openspec validate harden-startup-data-backfills --strict` (valid) and
  `openspec validate --all --strict` (40/40 pass).
- [x] 5.4 `git diff --check` — clean.

Known baseline failure (NOT caused by this change): `postgres-runtime-storage.test.js:949`
(lexical-search pagination `has_more`) fails identically on the unchanged
pre-change source; verified by reverting both source files and re-running.

## Acceptance checks

Reproducible steps:

```bash
# Temp Postgres DB inside the local container
docker exec pdpp-postgres-1 createdb -U pdpp pdpp_boot_test
export PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55432/pdpp_boot_test

# Run the focused boot + backfill tests
node --test --import tsx reference-implementation/server/<spine-boot-backfill>.test.js

# Cleanup
docker exec pdpp-postgres-1 dropdb -U pdpp pdpp_boot_test
```

- Boot against a columns-present DB performs no full spine_events scan/update.
- Boot against a columns-absent DB creates columns + index.
- `backfill-spine-source` dry-run reports counts and writes nothing; `--apply`
  converges in bounded batches and is idempotent on re-run.
- `openspec validate --all --strict` passes.

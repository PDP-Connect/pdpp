# Tasks: harden startup data backfills

## 1. Postgres boot path

- [ ] 1.1 In `reference-implementation/server/postgres-storage.js`, split
  `migratePostgresSpineSourceColumns()` into a boot-safe DDL step (add
  `source_kind`/`source_id`, drop `provider_id` if present, create
  `idx_pg_spine_events_source`) and remove the full-table `SELECT … FROM
  spine_events` + per-row `UPDATE` backfill from the boot path.
- [ ] 1.2 Export `deriveSpineSource` from `postgres-storage.js` so the
  maintenance script reuses the canonical derivation (single source of truth).
- [ ] 1.3 Keep the row-count safety assertion only where it still makes sense
  (DDL is row-count neutral); do not wrap boot in a long transaction.

## 2. SQLite boot path

- [ ] 2.1 In `reference-implementation/server/db.js`, split
  `migrateSpineSourceColumns()` the same way: boot keeps the bounded DDL and the
  index; remove the unbounded per-row backfill from the boot runner.
- [ ] 2.2 Remove or repurpose the dead `user_version = 1` write so it gates the
  DDL or is deleted; do not leave a no-op version stamp implying convergence.

## 3. Maintenance script

- [ ] 3.1 Add `reference-implementation/scripts/backfill-spine-source/` modeled
  on `compact-record-history.mjs`: direct-DB-access auth, dry-run default,
  `--apply`, `--batch-size`, Postgres and SQLite support.
- [ ] 3.2 Select only `WHERE source_kind IS NULL`, batch in short transactions,
  reuse `deriveSpineSource`, write `source_kind`/`source_id` and the
  `data_json.source` mirror only for rows it resolves.
- [ ] 3.3 Make it resumable and convergent: stop when a batch resolves zero new
  rows; report `resolved` / `remaining_unresolvable` / `total` counts.

## 4. Tests

- [ ] 4.1 Postgres: against a temporary DB, prove a boot with columns already
  present issues no full `SELECT … FROM spine_events` and no per-row
  `UPDATE … source_kind` (instrument via a query-capturing client or by
  asserting on a seeded large-row table that boot leaves NULL rows NULL and is
  fast / non-locking).
- [ ] 4.2 Postgres: prove boot still creates columns + index on a DB missing
  them.
- [ ] 4.3 Maintenance script: seed mixed rows (resolvable via payload source,
  resolvable via runtime actor, genuinely sourceless); assert dry-run writes
  nothing and reports the split; `--apply` resolves the resolvable rows in
  batches, leaves sourceless rows NULL, and a second run is a no-op.
- [ ] 4.4 SQLite: prove the boot runner no longer backfills and the script
  works against a temp SQLite file (if SQLite support is included in 3.1).

## 5. Validation

- [ ] 5.1 `pnpm --dir reference-implementation run typecheck` (if
  TypeScript-visible files changed).
- [ ] 5.2 Targeted `node --test` for the new tests against a temporary Postgres
  DB (`PDPP_TEST_POSTGRES_URL`).
- [ ] 5.3 `openspec validate harden-startup-data-backfills --strict` and
  `openspec validate --all --strict`.
- [ ] 5.4 `git diff --check`.

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

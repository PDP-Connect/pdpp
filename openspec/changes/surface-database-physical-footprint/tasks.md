# Tasks — surface-database-physical-footprint

This is a planning lane. The spec delta (§1) is authored here; the
implementation lanes it sequences (§2 helper, §3 contract, §4 console, §5 tests,
§6 owner closeout) are scoped for the implementer and not done in this lane.

## 1. Spec delta (this lane)

- [x] Add the `reference-implementation-architecture` requirement extending the
  `GET /_ref/deployment` `database` block with read-only `physical_bytes` and
  `top_relations[]`, with scenarios for Postgres reporting, clean SQLite/failure
  degradation, read-only execution, physical-vs-logical decomplection, and the
  owner-only / non-secret constraint.
- [x] Confirm the delta extends the existing deployment-diagnostics surface
  (`reference-implementation-architecture`) and does not overlap the logical
  retained-size projection (`/_ref/dataset/summary`, `retained-size-read-model.js`)
  or the semantic/lexical backfill diagnostics requirements.
- [x] `openspec validate surface-database-physical-footprint --strict`.
- [x] `openspec validate --all --strict`.
- [x] `git diff --check`.

## 2. Physical-size helper (implementation lane — not in this spec lane)

- [ ] Add a read-only physical-footprint helper to
  `reference-implementation/server/postgres-storage.js`: `pg_database_size(current_database())`
  for the total and an ordered top-N `pg_total_relation_size(relid)` query
  (joined to `pg_class` for relation names, `relkind = 'r'`) for the relation
  list. Use only pure `pg_*_size` read functions; issue no DDL/DML.
- [ ] Gate the helper on `isPostgresStorageBackend()`; return `null` (total) and
  `null`/empty (relations) on a non-Postgres backend and on any read failure,
  mirroring the existing fail-open diagnostics stance. Never fabricate a `0`.
- [ ] Bound the relation list to a small top-N (for example 8) so the payload
  stays small and ordered largest-first.

## 3. Contract delta (implementation lane)

- [ ] Extend the `refDeployment` `database` block shape in the reference contract
  with optional `physical_bytes: number | null` and
  `top_relations: Array<{ name: string; bytes: number }> | null`, leaving
  `database.path` unchanged.
- [ ] Build the new fields into the `database` block in
  `reference-implementation/server/deployment-diagnostics.ts` (currently
  `database: { path: input.dbPath }`) from the §2 helper, and wire the helper
  output through the deployment-diagnostics input in `server/index.js`.
- [ ] Update the operator-ui `DeploymentDiagnostics.database` type in
  `packages/operator-ui/src/lib/ref-client.ts` (currently
  `database: { path: string }`) in lockstep with the server shape.
- [ ] `pnpm --filter reference-implementation check:generated` (or repo
  equivalent) stays clean after the delta; ref-client type mirror matches.

## 4. Console rendering (implementation lane — depends on §3)

- [ ] Extend `DatabaseSection` in
  `packages/operator-ui/src/components/views/deployment-diagnostics-view.tsx`
  (currently two fields) to render "Database on disk: N" from `physical_bytes`
  and a short `top_relations[]` list, with a one-line "Retained payload
  (logical): M" comparison drawn from the existing dataset summary.
- [ ] Label the relation composition "approximate"; never alias, sum, or replace
  `total_retained_bytes` with `physical_bytes`.
- [ ] Render the SQLite / unmeasured state cleanly (a `—` with a note) when
  `physical_bytes` is `null`, with no fabricated `0`.

## 5. Tests (implementation lane)

- [ ] Helper unit test against a live Postgres: `physical_bytes` is a positive
  bigint, `top_relations` is ordered desc, each size ≤ `physical_bytes`, and the
  list sums to ≤ `physical_bytes`. Assert the helper returns `null`/empty on
  SQLite and on a simulated read failure. Assert read-only (no DDL/DML; `pg_*_size`
  are pure reads).
- [ ] Deployment-diagnostics contract test: the Postgres path carries
  `physical_bytes` + `top_relations`; the SQLite path carries `null`/empty and
  still carries `database.path`.
- [ ] operator-ui `DatabaseSection` component test: renders the physical footprint
  + logical comparison on the Postgres shape, and the `—`/unmeasured state on the
  SQLite/`null` shape. `biome` 0-new; `tsc` 0.
- [ ] Record any pre-existing baseline failures (via stash) before attributing a
  failure to this change.

## 6. Owner closeout

- [ ] Owner-only live verification: owner-session `GET /_ref/deployment`
  `physical_bytes` equals `psql -c "SELECT pg_database_size(current_database())"`
  on the live `pdpp_proof` DB (~51 GB), and the rendered retained payload still
  matches `/_ref/dataset/summary` `total_retained_bytes` (~4,555 MB). Record as a
  residual risk if it is the only remaining step.
- [ ] File the deferred design note for the P1 storage-composition strip and the
  P2(b) compaction reclaimable-bytes estimate captured in `design.md`.
- [ ] Archive this change once the helper + contract + console + tests land and
  the spec delta is folded into `reference-implementation-architecture`.

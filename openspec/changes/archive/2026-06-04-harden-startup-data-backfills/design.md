# Design: harden startup data backfills

## Problem detail

`initPostgresStorage()` (`reference-implementation/server/postgres-storage.js`)
calls `migratePostgresSpineSourceColumns(client)` unconditionally on every boot.
That function:

1. `BEGIN`
2. `ALTER TABLE spine_events ADD COLUMN IF NOT EXISTS source_kind/source_id`
   (cheap, idempotent)
3. `SELECT event_id, actor_type, actor_id, data_json, source_kind, source_id
   FROM spine_events` — **a full table read of every row into Node**
4. per-row: `deriveSpineSource()`, then if changed,
   `UPDATE spine_events SET source_kind=$1, source_id=$2, data_json=$3 WHERE
   event_id=$4`
5. optional `DROP COLUMN provider_id`
6. `CREATE INDEX IF NOT EXISTS idx_pg_spine_events_source`
7. row-count assert, `COMMIT`

Steps 3–4 are the defect. With ~361k rows the boot stalled ~90–120s, and the
open transaction's `ROW EXCLUSIVE` table lock plus per-row row locks blocked
owner reads against `spine_events`.

### Why it never converges

Read-only inspection of the live `pdpp_proof` table (2026-06-02):

```
total           = 361451
missing_source  = 8904      (source_kind IS NULL OR source_id IS NULL)
provider_id col = absent    (already dropped on a prior boot)
```

The 8904 NULL rows break down by `actor_type` as `subject` (3107), `client`
(2562), `authorization_server` (2063), `reference` (1163), `owner_agent` (9),
and by `event_type` as `token.issued`, `request.submitted`,
`consent.approved`, `disclosure.served`, `query.received`, etc. These are
authorization/disclosure events with **no data source**. `deriveSpineSource()`
returns `null` for them (no `source`/`source_binding`/`connector_id`/
`provider_id` in payload, and `actor_type !== 'runtime'`), so they are skipped
with `continue` and stay NULL forever. Every subsequent boot re-scans all
361k rows, re-derives, writes ~0 rows, and still pays the scan and holds the
transaction. `provider_id` is already gone, so even the one-time legacy
migration value of this function is spent.

### Why NULL columns are tolerable

`spine_events.source_kind`/`source_id` are a denormalized cache. The canonical
source lives in the event payload, with runtime actor identity as the fallback
used by current emitters. The read path proves this:

- `sourceFromEvent()` (`reference-implementation/lib/spine.ts`): reads the
  columns first, then **falls back to deriving from `ev.data`** (the
  `data_json` payload) and runtime actor identity. Source-unfiltered
  correlation summaries recover source correctly with NULL columns.
- The columns matter for exactly one read: a source-*filtered* correlation
  query pushes `WHERE source_kind = ?` / `source_id = ?` into the GROUP BY
  (`reference-implementation/lib/spine.ts` `buildCorrelationQuery`). A legacy
  row with NULL columns will not match such a filter even if its `data_json`
  carries a source. That is a bounded under-count of legacy rows in
  source-filtered spine correlations — not a correctness break in unfiltered
  dashboard summary views.

So the safe move is: stop doing the backfill at boot, keep deriving at read
time, and offer an explicit operator backfill for operators who want
source-filtered correlations to cover legacy rows.

## Decision

1. **Split schema DDL from data backfill.** Boot keeps only the bounded
   idempotent DDL (add columns, drop `provider_id` if present, create index).
   Boot does not read or update table rows for source backfill.

2. **Move the backfill to an explicit operator maintenance script**,
   `reference-implementation/scripts/backfill-spine-source/`, modeled on the
   existing `compact-record-history.mjs` and `retry-dead-letters` conventions:
   - authorization by direct DB access (`PDPP_DATABASE_URL` /
     `PDPP_TEST_POSTGRES_URL`); no HTTP route, no scheduler;
   - **dry-run by default**, `--apply` to write;
   - **bounded batches** (`--batch-size`, default small) each in its own short
     transaction, selecting only `WHERE source_kind IS NULL` so it touches the
     remaining gap, not the whole table;
   - **resumable**: re-running continues from wherever NULL rows remain; it
     terminates when a batch resolves zero new rows, reporting the count of
     genuinely-unresolvable (sourceless) rows it left untouched;
   - reuses the canonical `deriveSpineSource()` (now exported) so the
     maintenance derivation and the read-time derivation can never drift.

3. **Durable requirement.** Add a `reference-implementation-architecture`
   requirement that normal startup performs only bounded idempotent schema
   migrations and MUST NOT run an unbounded full-table data backfill or hold a
   long, reader-blocking transaction at boot. Large data repairs are explicit
   operator maintenance.

## Alternatives considered

- **Add an idempotency guard (a `migrated` flag / `user_version`) and keep the
  backfill at boot.** Rejected: the first boot on a large table still stalls and
  locks, and the guard does not help an operator who restores a pre-migration
  dump. The backfill is the wrong thing to run at boot regardless of guard.
- **Tiny capped boot batch (e.g. 500 rows/boot, no long transaction).**
  Viable and explicitly allowed by the new requirement as a fallback, but it
  makes boot's effect on data nondeterministic and would take ~18 boots to
  drain 8.9k rows while never resolving the sourceless tail. An explicit
  operator script is cleaner, observable, and resumable. We choose the script;
  the requirement still permits a tiny non-blocking boot batch for
  implementations that prefer it.
- **`UPDATE … FROM` set-based SQL backfill in one statement.** Still a
  full-table write in one transaction — same lock/duration problem, just in
  SQL instead of Node. Rejected for boot; the operator script may use batched
  set-based SQL internally because it runs off the boot path with short
  transactions.
- **Backfill the `data_json.source` mirror too.** The script keeps the existing
  behavior of also writing `data_json.source` for rows it resolves (parity with
  the prior migration), but only for rows it actually resolves; it never
  rewrites already-correct rows.

## Scope

In scope: the spine source boot backfill on both backends, the new maintenance
script, the startup-migration requirement, and focused tests.

Out of scope: other boot migrations. They were audited; only
`migratePostgres/Sqlite SpineSourceColumns` does an unbounded full-table data
backfill. `migratePostgresLegacyConnectorInstancesToDefaultAccount` and peers
operate on the small `connector_instances`/`connector_state` tables with
bounded, connector-keyed predicates (e.g. `LIMIT 2`), not full runtime-data
scans. The `event_seq` SQLite seed (`UPDATE … WHERE event_seq IS NULL`) is a
one-shot ordering reconstruction; it is noted as a candidate for the same
treatment but is left unchanged here to keep this change focused (SQLite-only,
embedded, and already converges to zero once seeded).

## Acceptance checks

1. With `source_kind`/`source_id` columns already present and `provider_id`
   absent, a fresh `initPostgresStorage()` against a temporary Postgres DB
   issues no `SELECT … FROM spine_events` full read and no per-row
   `UPDATE spine_events … SET source_kind …` during boot. (test)
2. Boot still creates the columns and the `idx_pg_spine_events_source` index on
   a DB that lacks them. (test)
3. `backfill-spine-source` in dry-run reports the resolvable/unresolvable split
   and writes nothing; with `--apply` it resolves resolvable NULL rows in
   bounded batches and leaves genuinely-sourceless rows NULL; re-running is a
   no-op. (test, against a temporary Postgres DB seeded with mixed rows)
4. A source-unfiltered correlation read returns the correct source for rows
   whose `source_*` columns are NULL but whose `data_json.source` or runtime
   actor identity is resolvable. (test)
5. `openspec validate harden-startup-data-backfills --strict` and
   `openspec validate --all --strict` pass.

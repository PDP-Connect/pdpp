# Design: surface-database-physical-footprint

## Context

The reference deployment diagnostics surface (`GET /_ref/deployment`, built in
`reference-implementation/server/deployment-diagnostics.ts`, rendered by
`packages/operator-ui/src/components/views/deployment-diagnostics-view.tsx`,
governed by `reference-implementation-architecture`) already reports semantic
backend identity, vector index kind and state, lexical/semantic backfill
progress, manifest provenance, and a `database` block. That block is today only
`{ path: string }` — it reports where the database lives, not how large it is.

Separately, `GET /_ref/dataset/summary` reports the **logical retained payload**:
`record_json_bytes`, `record_changes_json_bytes`, `blob_bytes`, summed into
`total_retained_bytes` and rendered as the "Retained" KPI. That figure is the
byte length of current record JSON, history JSON, and blob bytes — computed in
`reference-implementation/server/retained-size-read-model.js` as
`SUM(octet_length(record_json::text))` over `records`, the same over
`record_changes`, and the blob byte sum. It deliberately excludes index storage,
the operational event log, TOAST overhead, page bloat, WAL, and every
non-canonical table.

The audit (`tmp/workstreams/ri-storage-ops-visibility-audit-v1-report.md`)
established as a hard static fact that there is **no** `pg_database_size`,
`pg_total_relation_size`, `pg_relation_size`, `pg_table_size`, `pg_indexes_size`,
or `pg_size_pretty` call site anywhere in the codebase, and **no** physical-size
contract field on any `/_ref` shape. So when an operator's retained payload reads
`~4,555 MB` but the database occupies `~51 GB`, no operator surface can explain
or even expose the difference; the operator must drop to `psql`.

The reference uses `isPostgresStorageBackend()`
(`reference-implementation/server/postgres-storage.js`) as the established
backend discriminator throughout `server/index.js`. The physical footprint is a
Postgres-only fact (a SQLite file's on-disk size is a different, lower-value
question, addressed only as clean degradation here), and the diagnostics path is
the one operator page that already reports database topology — so it is the
natural and lowest-leverage home for the new read.

## Goals

- Make the **physical on-disk database size visible and numeric** on a page the
  operator already opens, so the retained-vs-physical gap can be reconciled
  without a `psql` session.
- Keep the read **strictly read-only** (pure `pg_*_size` functions, no DDL/DML,
  no vacuum/reindex side effect).
- Keep the physical fact **decomplected from the logical retained payload** — a
  labeled comparison, never an alias, sum, or replacement.
- Keep the surface **honest about backend and absence**: real sizes on Postgres,
  clean `null` degradation on SQLite or read failure, no fabricated zero.
- Keep the facts **owner-only and non-secret** — only a byte total and a bounded
  list of relation-name + size pairs from the operator's own catalog.

## Non-goals

- Not a grouped "storage composition" reconciliation strip that buckets relations
  into canonical / search-index / event-log / other. That is the audit's P1 and
  is a code-only UI derivation over the `top_relations[]` this change returns; it
  needs no new contract field and is deferred.
- Not a compaction reclaimable-bytes estimate on `/_ref/records/version-stats`.
  That is the audit's P2(b), a separate contract delta that must preserve the
  `disposition_affects_thresholds: false` display-only invariant; out of scope
  here.
- Not backup-table cleanup, vacuuming, or any DBA mutation. The audit's ~18 GB
  backup/migration residue is a manual DBA task, explicitly not a dashboard
  feature; this change only *measures*, it never *reclaims*.
- Not a change to the logical retained-size projection, its rebuild/reconcile
  actions, or `total_retained_bytes`. The logical number stays exactly as it is;
  this change adds an orthogonal physical number beside it.
- Not a SQLite physical-size implementation. SQLite degrades to `null`; a
  `PRAGMA page_count * page_size` file-size read is a possible later refinement,
  not required for the P0 fact.

## Decisions

### D1. Where the facts live: the `GET /_ref/deployment` `database` block

The footprint is added to the existing `database` block on the deployment
diagnostics shape, alongside `path`. The deployment page is the operator's
database/topology surface and already renders the `database` section; extending
it reuses the one page, one endpoint, and one owner-session gate the operator
already has. A dedicated `/_ref/storage` endpoint was rejected: it would split
database facts across two reads and add a route and gate for a single scalar plus
a top-N list that belongs with the topology the page already shows.

### D2. Shape: a nullable total plus a bounded relation list

```
database: {
  path: string,                       // unchanged
  physical_bytes: number | null,      // pg_database_size(current_database())
  top_relations: Array<{              // largest by pg_total_relation_size(relid)
    name: string,                     // relation name
    bytes: number                     // table + indexes + TOAST aggregate
  }> | null                           // null/empty when unavailable
}
```

- `physical_bytes` is the load-bearing fact: the database's on-disk size. It is
  `null` on SQLite or when the read is unavailable/fails — never a fabricated
  `0`.
- `top_relations` is a bounded list (a small top-N, for example top 8) so the
  payload stays small and the operator gets the relations that actually drive
  size (the `lexical_search_*` / `semantic_search_*` index tables, `spine_events`,
  the canonical `records` / `record_changes` tables). It is `null` or empty on
  SQLite / read failure.
- Both fields are additive and optional, so a consumer that ignores them and a
  SQLite deployment are unaffected, and the existing `database.path` is untouched.

### D3. Read-only by construction

`pg_database_size` and `pg_total_relation_size` are pure read functions; the
helper runs a single scalar query plus one ordered top-N query against the
catalog and `pg_class`, and issues no DDL or DML. This is named as a normative
requirement and an acceptance check so a future change cannot quietly add a
vacuum/analyze "while we're here." Surfacing footprint must never change
footprint.

### D4. Decomplected from the logical retained payload

The physical footprint and the logical `total_retained_bytes` are two different
measurements of two different things: bytes the database process occupies on disk
versus the JSON/blob byte length of retained owner records. The console renders
them side by side as a labeled comparison ("Database on disk: N" vs "Retained
payload (logical): M") precisely so the operator sees that the physical number is
larger and why it is a different number — never as one figure aliased to or
summed with the other. The two being far apart is the expected, now-explained
state, not an error.

### D5. Honest about backend and absence

The helper returns `null` on a non-Postgres backend (gated on
`isPostgresStorageBackend()`) and on any read failure, mirroring the fail-open
stance used elsewhere in diagnostics. A `null` (unmeasured / not-Postgres) is
distinct from a `0` and the contract forbids fabricating a zero, so the UI never
renders "0 bytes on disk" for a database it simply could not measure.

### D6. Owner-only, non-secret

The block carries only a byte total and relation-name + byte-size pairs from the
operator's own catalog — no record payloads, owner data, credentials, base URLs,
or tokens. It stays on the owner-session-gated `/_ref/deployment` surface, which
already redacts secrets server-side and is never read by a grant-scoped `/v1`
route, so the facts are owner-only by construction.

### D7. Approximate composition

`pg_total_relation_size` includes a relation's TOAST and indexes, but the per-
relation sizes will not sum to `pg_database_size` because shared/system catalogs,
the free space map, and WAL are not attributed per relation. The contract and the
UI copy SHALL call the composition "approximate" rather than imply the relations
account for the whole database — keeping the honest-framing posture.

## Risks and tradeoffs

- **Top-N truncation hides the long tail.** A small `top_relations` list will not
  enumerate every table, so the listed relations will not sum to `physical_bytes`.
  This is acceptable and explicitly labeled approximate (D7); the goal is the
  headline size plus the size drivers, not a full table census.
- **`pg_total_relation_size` cost.** Computed over the catalog it is cheap, but on
  a database with very many relations the ordered top-N still scans `pg_class`.
  The query is bounded (top-N) and runs only when the operator opens the page; it
  is not on a hot path. If it ever proves costly it can be cached with the rest of
  the diagnostics snapshot.
- **Backend drift.** The fact is Postgres-only. If a future backend is added, the
  helper must extend its discriminator rather than assume Postgres; the contract's
  clean-degradation requirement already covers "any backend that did not produce a
  size."

## Deferred (out of scope for this change)

Captured for follow-up, explicitly not required here:

1. **Storage composition strip (audit P1).** A UI grouping that buckets
   `top_relations[]` into canonical / search-index / event-log / other by
   table-name prefix, so `~51 GB` resolves into named categories. Code-only over
   this change's data; no new contract field.
2. **Compaction reclaimable-bytes estimate (audit P2b).** A `reclaimable_bytes`
   display field on `/_ref/records/version-stats` summing `octet_length(record_json)`
   over the removable-version set, preserving `disposition_affects_thresholds: false`.
3. **SQLite physical size.** A `PRAGMA page_count * page_size` file-size read so
   SQLite reports a real number instead of `null`.
4. **Backup-table cleanup.** Enumerating and dropping validation-harness residue
   (`backup_*`, `_seed`, `_restored` tables) — a manual DBA task, never automated
   into the dashboard.

## Acceptance checks

- `GET /_ref/deployment` on a Postgres backend carries a positive
  `database.physical_bytes` equal to `pg_database_size(current_database())` and a
  bounded `database.top_relations` ordered largest-first, where each relation
  size is `pg_total_relation_size(relid)` and `physical_bytes` is at least the
  largest reported relation size.
- On a SQLite backend (or read failure) `physical_bytes` is `null` and
  `top_relations` is empty or `null`; no fabricated `0`; `database.path` still
  reported.
- The footprint read issues only pure `pg_*_size` functions — no DDL/DML, no
  vacuum/reindex side effect.
- The console renders the physical footprint and the logical `total_retained_bytes`
  as a labeled comparison; the physical number is never aliased to or summed with
  the logical one; the composition is labeled approximate.
- The `database` block carries only a byte total and relation-name + byte-size
  pairs, no record payloads/owner data/credentials/URLs/tokens, and is not exposed
  to grant-scoped clients.
- `check:generated` stays clean after the `refDeployment` delta and the
  operator-ui `DeploymentDiagnostics.database` type is updated in lockstep.
- Live cross-check: owner-session `GET /_ref/deployment` `physical_bytes` matches
  `psql -c "SELECT pg_database_size(current_database())"`, and the rendered
  retained payload still matches `/_ref/dataset/summary` `total_retained_bytes`;
  the two numbers being far apart is the expected, now-explained state.

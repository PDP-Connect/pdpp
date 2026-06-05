# Proposal: surface-database-physical-footprint

## Why

The operator dashboard surfaces the **logical retained payload** — the byte
length of current record JSON, record-history JSON, and blob bytes, summed into
`total_retained_bytes` on `GET /_ref/dataset/summary` and rendered as the
"Retained" KPI (for example `~4,555 MB`). It surfaces no **physical storage**
fact at all. An audit of the reference implementation
(`tmp/workstreams/ri-storage-ops-visibility-audit-v1-report.md`) found **zero**
call sites for `pg_database_size`, `pg_total_relation_size`, `pg_relation_size`,
`pg_table_size`, `pg_indexes_size`, or `pg_size_pretty` across the server,
packages, and apps, and **no contract field** for on-disk size on any `/_ref`
shape.

The consequence is a reconciliation gap the operator cannot close from the UI:
the same database whose retained payload reads `~4,555 MB` can occupy `~51 GB`
on disk — roughly `11×` — because the logical projection deliberately measures
only `records`, `record_changes`, and `blob_bindings` JSON/blob length. It never
accounts for index overhead (the `lexical_search_*` / `semantic_search_*` tables
are a large physical category), the operational event log (`spine_events`,
`client_event_*`), TOAST storage, page bloat, or DBA-side residue from
backup/restore validation harnesses. An operator reasonably reads "Retained" as
the storage cost, then opens a `psql` session to discover the database is an
order of magnitude larger and cannot tell, from any operator surface, where the
difference lives.

The `GET /_ref/deployment` deployment-diagnostics surface already carries the
`database` block (today only `{ path }`) and already reports database/index
topology for the operator. It is the natural home for a read-only physical
footprint fact: the operator's own Postgres already knows `pg_database_size` and
`pg_total_relation_size`, and surfacing them turns "I have to `psql` and run
`pg_total_relation_size`" into one panel on a page the operator already opens.

This is **operator diagnostics for a self-hosted reference instance**, not a
hosted-service guarantee, quota, or billing surface, and the physical footprint
is explicitly **not** the retained owner-data size — it is what the database
process occupies on disk, which the panel reconciles against the existing
logical retained number rather than conflating with it.

## What Changes

- Add a `reference-implementation-architecture` requirement extending the
  `GET /_ref/deployment` `database` block with read-only **physical footprint**
  facts for a Postgres-backed deployment: a `physical_bytes` total derived from
  `pg_database_size(current_database())`, and a bounded `top_relations[]` list
  of the largest relations by `pg_total_relation_size(relid)` (table + its
  indexes + TOAST aggregate), each carrying a relation name and a byte size.
- Require the physical facts to be **read-only**. The deployment diagnostics
  path SHALL run only the pure `pg_*_size` read functions and SHALL NOT issue
  DDL or DML to produce them; surfacing footprint SHALL NOT mutate, vacuum,
  reindex, or otherwise change storage.
- Require the facts to be **honest about backend and absence**. On a Postgres
  backend the fields carry real sizes; on a SQLite backend (or when the size
  read fails or is unavailable) the deployment diagnostics SHALL degrade
  cleanly — `physical_bytes` is `null` and `top_relations` is empty or `null` —
  rather than fabricating a zero or a Postgres-shaped figure.
- Require the surface to keep the **physical-vs-logical distinction explicit**.
  The physical footprint is operator diagnostics describing on-disk database
  size; it SHALL NOT be presented as, aliased to, or summed with the logical
  retained payload (`total_retained_bytes`). The operator console SHALL render
  the physical footprint alongside the existing logical retained number as a
  labeled comparison so the gap is explained, not hidden, and SHALL describe the
  composition as approximate (the relation sizes do not sum exactly to
  `pg_database_size` because of shared catalogs, free space, and WAL).
- Require the facts to be **owner-only and non-secret**. They carry only a
  byte-size total and a bounded list of relation-name + byte-size pairs from the
  operator's own catalog; they SHALL NOT carry record payloads, owner data, or
  credentials, and SHALL remain on the owner-session-gated `/_ref/deployment`
  surface, never exposed to grant-scoped clients.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Reference implementation and operator console only. Does not change the public
  record/query/search/schema/blob `/v1` API, the PDPP protocol, Collection
  Profile JSONL messages, connector manifests, or the logical retained-size
  projection.
- Reads the operator's own Postgres catalog through the pure `pg_database_size`
  / `pg_total_relation_size` functions; no new table, column, migration, or
  background job. The reads are bounded (a single scalar plus a top-N relation
  list) and run on the existing deployment-diagnostics path.
- The contract delta is additive and nullable: `database.physical_bytes` and
  `database.top_relations[]` are new optional fields on the `GET /_ref/deployment`
  `database` block. The existing `database.path` field and every other
  deployment-diagnostics field are unchanged, so a SQLite deployment and any
  consumer that ignores the new fields are unaffected.
- Requires a `check:generated` regen for the `refDeployment` shape and a
  matching `DeploymentDiagnostics.database` type update in the operator-ui
  ref-client, kept in lockstep with the server-built block.
- Deliberately out of scope: a grouped "storage composition" reconciliation
  strip (a code-only UI derivation over `top_relations[]`), a compaction
  reclaimable-bytes estimate on `/_ref/records/version-stats`, and any
  backup-table cleanup or DBA tooling. Those are the audit's P1/P2 follow-ups and
  remain separate; this change ships only the P0 physical-footprint fact.

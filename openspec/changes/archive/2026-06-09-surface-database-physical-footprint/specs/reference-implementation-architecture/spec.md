## ADDED Requirements

### Requirement: Deployment diagnostics SHALL surface the physical database footprint for Postgres backends

The reference deployment diagnostics surface SHALL extend the
`GET /_ref/deployment` `database` block with read-only physical storage facts so
an operator can reconcile the database's on-disk size against the logical
retained payload without opening a `psql` session. For a Postgres-backed
deployment the `database` block SHALL carry a `physical_bytes` total derived from
`pg_database_size(current_database())` and a bounded `top_relations` list of the
largest relations by `pg_total_relation_size(relid)` (each relation's table,
indexes, and TOAST storage aggregated), where each entry carries a relation name
and a byte size.

These facts SHALL be read-only. The deployment diagnostics path SHALL produce
them using only the pure `pg_*_size` read functions and SHALL NOT issue DDL or
DML, SHALL NOT vacuum, reindex, or compact, and SHALL NOT otherwise change
storage as a side effect of reporting footprint.

The facts SHALL be honest about absence and backend. On a SQLite-backed
deployment, or when the size read is unavailable or fails, `physical_bytes` SHALL
be `null` and `top_relations` SHALL be empty or `null`; the surface SHALL NOT
fabricate a `0` total or a Postgres-shaped relation list for a backend that did
not produce one. The existing `database.path` field SHALL remain unchanged, and a
deployment that omits the physical facts SHALL remain a valid deployment
diagnostics response.

The physical footprint SHALL be distinct from the logical retained payload. It is
operator diagnostics describing on-disk database size, and it SHALL NOT be
presented as, aliased to, or summed with `total_retained_bytes` from
`GET /_ref/dataset/summary`. The `top_relations` sizes SHALL be treated as an
approximate composition; the surface SHALL NOT claim they sum exactly to
`physical_bytes`, because shared catalogs, free space, and WAL are not attributed
per relation.

The facts SHALL be owner-only and non-secret. The `database` block SHALL carry
only a byte-size total and a bounded list of relation-name and byte-size pairs
from the operator's own catalog. It SHALL NOT carry record payloads, owner data,
credentials, base URLs, or tokens, and it SHALL remain on the owner-session-gated
`/_ref/deployment` surface and SHALL NOT be exposed to grant-scoped clients.

#### Scenario: Postgres deployment reports physical footprint

- **WHEN** an operator opens deployment diagnostics on a Postgres-backed deployment
- **THEN** `GET /_ref/deployment` SHALL include a `database.physical_bytes` total derived from `pg_database_size(current_database())`
- **AND** it SHALL include a bounded `database.top_relations` list of the largest relations by `pg_total_relation_size(relid)`, each carrying a relation name and a byte size, ordered largest first
- **AND** the reported `physical_bytes` SHALL be a positive byte count and SHALL be at least the largest reported relation size

#### Scenario: SQLite deployment degrades cleanly

- **WHEN** deployment diagnostics are produced on a SQLite-backed deployment
- **THEN** `database.physical_bytes` SHALL be `null` and `database.top_relations` SHALL be empty or `null`
- **AND** the surface SHALL NOT fabricate a `0` total or a Postgres-shaped relation list
- **AND** the existing `database.path` field SHALL still be reported

#### Scenario: Footprint reporting is read-only

- **WHEN** the deployment diagnostics path computes the physical footprint
- **THEN** it SHALL execute only the pure `pg_*_size` read functions
- **AND** it SHALL NOT issue DDL or DML, vacuum, reindex, compact, or otherwise change storage as a side effect of reporting

#### Scenario: Physical footprint is not conflated with retained payload

- **WHEN** the operator console renders the deployment diagnostics database block
- **THEN** it SHALL render the physical footprint alongside the logical retained payload as a labeled comparison
- **AND** the physical footprint SHALL NOT be presented as, aliased to, or summed with `total_retained_bytes`
- **AND** the relation composition SHALL be described as approximate rather than claimed to sum exactly to `physical_bytes`

#### Scenario: Size read failure surfaces as unmeasured

- **WHEN** the physical size read fails or is unavailable on a Postgres-backed deployment
- **THEN** `database.physical_bytes` SHALL be `null` and `database.top_relations` SHALL be empty or `null`
- **AND** the rest of the deployment diagnostics response SHALL still be produced

#### Scenario: Physical footprint is owner-only and non-secret

- **WHEN** the deployment diagnostics surface exposes the physical footprint
- **THEN** the `database` block SHALL carry only a byte-size total and relation-name plus byte-size pairs
- **AND** it SHALL NOT carry record payloads, owner data, credentials, base URLs, or tokens
- **AND** it SHALL remain on the owner-session-gated `/_ref/deployment` surface and SHALL NOT be exposed to grant-scoped clients

## Context

The reference engine ships grant-scoped one-hop parent → child relationship
expansion on the SQLite backend (`records.js#hydrateExpandedRelations`).
The Postgres records backend has no expand handling: the route accepts the
parameter, but the backend silently drops it. The live Postgres deployment
therefore cannot serve expansion even though the parser, client tooling,
and the SQLite engine already implement the contract.

This change implements the deferred Postgres hydration work. It is bounded:

- one new code path (Postgres hydration of expand) modeled on the SQLite
  implementation in `records.js#hydrateExpandedRelations`;
- one shared parser/projection module (`record-expand-helpers.js`)
  extracted from `records.js` so both backends agree on validation;
- one test surface (Postgres-targeted scenarios under the existing
  `PDPP_TEST_POSTGRES_URL` env gate).

The originally-planned third bullet — flipping a per-deployment
`read_capabilities.expand: true` advertisement — is **deferred** to a
separate change. Current main does not yet have the
`projectReadCapabilities` / `supportsExpand` capability projection
foundation that flip depends on. This slice keeps the hydration honest
and leaves the advertisement bit to its own change once the projection
foundation lands.

No public contract changes. No protocol changes. No new dependencies.

## The Gap In One Line

The Postgres records backend silently ignores `expand`/`expand_limit`
because the hydration path was never implemented. After this change the
Postgres backend honors the same expand contract the SQLite backend
honors, with parity on the observable response envelope. The
deployment-level capability advertisement remains unchanged here and is
landed by a follow-up change.

## Decisions

### 1. Reuse `normalizeExpandRequest` from `records.js`

`normalizeExpandRequest` validates the request shape (allowed relation
names, child grant scope, nested-expansion rejection, `expand_limit`
shape, default/max limit enforcement) and produces a normalized
`expansions[]` array. It does not touch storage. The SQLite path already
uses it. The Postgres path SHALL import and call it directly.

Why: the parser is the contract surface — duplicating it would let SQLite
and Postgres drift on what counts as a valid expansion. The function is
already pure and storage-agnostic; promoting it to an export costs one
line. Mirroring the parser in `postgres-records.js` would multiply the
attack surface for the same accepted-shape decisions.

### 2. Reuse `buildEffectiveFilter` for the child grant projection

The SQLite hydrator passes the child grant through `buildEffectiveFilter`
to compute `{ fields, timeRange, resources }` for the child stream. The
Postgres path SHALL do the same. The output is small and serializable;
the Postgres backend already has its own field-projection helper
(`fieldsFor`) but is missing the time-range/resources filtering needed
for honest grant projection on child rows.

Why: child rows that fall outside the child grant's `time_range` or
`resources` MUST NOT leak through expansion. The SQLite engine enforces
this in SQL. The Postgres engine SHALL enforce it equivalently. The
existing `buildEffectiveFilter` helper from `records.js` produces the
exact shape both backends need; exporting it (already a single function
with no SQLite coupling) is the cheapest way to keep both paths honest
about the same fact.

### 3. Batched per-relation child query with a window function (`ROW_NUMBER()`)

For each expansion in the parent page, run **one** Postgres query of the
shape:

```sql
WITH ranked AS (
  SELECT
    record_key,
    record_json,
    emitted_at,
    (record_json->>$fk) AS __fk,
    ROW_NUMBER() OVER (
      PARTITION BY (record_json->>$fk)
      ORDER BY <cursor_expr> ASC NULLS LAST, (record_json->>$pk) ASC
    ) AS __rn
  FROM records
  WHERE connector_instance_id = $1
    AND stream = $2
    AND deleted = FALSE
    AND (record_json->>$fk) = ANY($parent_keys::text[])
    AND <grant time_range / resources clauses>
)
SELECT record_key, record_json, emitted_at, __fk
FROM ranked
WHERE __rn <= $rankBound;
```

- `$parent_keys` is the parent page's record keys.
- `$rankBound` is `limit + 1` for `has_many` (the `+1` is the
  `has_more` signal) and `1` for `has_one`.
- `<cursor_expr>` mirrors the SQLite engine: when the child manifest
  declares a `cursor_field`, sort by it first (nulls last), then by
  primary-key text; otherwise sort by primary-key text only.

Why: this is the same hydration shape SQLite uses (`records.js`
~`fetchExpansionChildrenGroupedByForeignKey`), and the same shape
PostgREST uses for resource embedding. It is N+0 per page: one query per
relation, regardless of parent count.

### 4. SQL safety: identifiers vs literals

All JSON field references (`$fk`, `$pk`, `$cursor_field`,
`$consent_time_field`) come from the manifest, which is itself validated
by `validateConnectorManifest`. The Postgres path SHALL additionally
re-validate against the same `SAFE_JSON_FIELD = /^[A-Za-z_][A-Za-z_0-9]*$/`
regex the SQLite path uses (`assertSafeJsonField`) before interpolating
them into SQL. Parent keys, time-range bounds, and resource IDs go
through bound parameters (`$N`), never string interpolation.

Why: identifiers cannot be bound parameters in SQL, so the only safe
gate is a tight regex applied at the manifest-load and hydration
boundaries. Bound parameters cover all caller-controlled values, so
nothing user-supplied reaches the SQL text.

### 5. Single-record (`postgresGetRecord`) parity

The SQLite path supports `expand` on both the list endpoint and the
single-record endpoint. The Postgres path SHALL match: after the
single-record load, run the same per-relation hydration with a one-element
`parentKeys` array.

Why: clients learn expansion from `query_capabilities.expandable_fields`
on the stream metadata, which advertises a per-stream capability, not a
per-endpoint capability. Asymmetric support would surprise callers and
require contract-level documentation we have explicitly avoided.

### 6. `changes_since` incompatibility preserved

The SQLite engine rejects `expand` combined with `changes_since` because
the change-feed semantics (delete-tombstones, version cursors) do not
have a defined parent-snapshot shape. The Postgres engine SHALL reject
the same combination with the same `invalid_expand` error code.

### 7. Pagination cursors unchanged

Parent pagination on Postgres already works (cursor encoding/decoding
implemented in `postgresQueryRecords`). This change does not touch the
parent-page cursor. Expanded children attach to the current page only;
`has_more` on the parent page list and `has_more` on each per-parent
expanded sublist remain the two independent truncation signals.

### 8. `read_capabilities.expand` advertisement — deferred

Originally this change would have flipped the host's
`referenceReadCapabilities` projection input from
`supportsExpand: !isPostgresStorageBackend()` to `supportsExpand: true`
so downstream surfaces (REST envelope, `expandable_fields`, MCP
`query_records` schema, generated docs) pick up the new backend
capability automatically.

That flip is **deferred to a separate change**. Current main does not
yet have the `projectReadCapabilities` / `supportsExpand` capability
projection foundation. Landing the flip here would require sneaking that
foundation in alongside the hydration, widening this slice past the
"smallest safe reland" target. The hydration implementation in this
change stands alone: Postgres honors expand requests with parity against
SQLite, regardless of how the deployment advertises the capability.

When the projection foundation lands separately, advertising
`read_capabilities.expand: true` for Postgres will be a one-line input
change with no additional Postgres-side work.

## Non-Goals

- Reverse / belongs-to expansion (child → parent). The
  `expand-first-party-parent-child-relations/design-notes/cookbook.md`
  rationale still stands.
- Generalized nested select language (PostgREST-style, GraphQL-style).
- Per-deployment public manifest generation (the deferred
  `add-per-deployment-public-manifest-generation` change).
- Any new data-explorer surfaces. The substrate work lives in
  `design-notes/retained-size-and-data-explorer-substrate-2026-05-22.md`.

## Alternatives Considered

- **Per-parent child query loop (N+1).** Rejected: identical correctness
  to the batched approach but linear in parent-page size; the batched
  approach is the prior-art convergent shape (DataLoader, PostgREST) and
  the SQLite engine already uses it.
- **Reuse SQLite SQL by templating it.** Rejected: SQLite and Postgres
  diverge on `json_extract` vs `record_json->>` and on `ROW_NUMBER()`
  PARTITION BY syntax differences for nullable fields. A shared template
  would obscure both engines without removing the conditional.
- **Promote `hydrateExpandedRelations` to a backend-pluggable abstraction
  (interface + adapter).** Rejected for now: there are exactly two
  backends, and one of them already inlines the helper. Adding the
  abstraction would lock in a contract that both implementations would
  immediately have to satisfy. The construction-boundary fix already
  proves the per-deployment seam is at `supportsExpand`, not at the
  hydration call site.
- **Use a deferrable transaction or `FOR UPDATE` on the child query.**
  Rejected: hydration is a pure read; the parent page is already a
  snapshot via the parent SELECT's transaction (or lack thereof — both
  backends accept read skew across pages today, and the SQLite engine
  does not stiffen this). Stiffening read isolation is out of scope.

## Acceptance Checks

- `queryRecords(connectorId, parentStream, grant, { expand, expand_limit },
  manifest)` on a Postgres-backed deployment returns the same envelope
  shape the SQLite backend returns: each parent record gets an
  `expanded.<relation>` object whose `data` is the projected child
  record(s) and whose `has_more` reflects whether more than
  `expand_limit` matched.
- `expand_limit[recently_played]=1` on a Postgres-backed deployment
  returns exactly 1 child row per parent and `has_more: true` for parents
  with more matching children. Child rows project only fields permitted
  by the child grant.
- `expand=recently_played` with no `recently_played` grant on a
  Postgres-backed deployment rejects with `insufficient_scope`.
- `expand=not_a_relation` on a Postgres-backed deployment (relation not
  declared in the parent's manifest) rejects with `invalid_expand`.
- `expand=recently_played&changes_since=beginning` on a Postgres-backed
  deployment rejects with `invalid_expand` (same as SQLite).
- Cross-connector-instance isolation: a sibling connector instance's
  child rows never leak into the expansion payload.
- The SQLite records path (`rs.records.list`, `rs.records.get`,
  `query-contract.test.js`) remains green after the helper extraction
  (no regression).
- Deployment-level capability advertisement (`read_capabilities.expand`,
  per-stream `expandable_fields`, MCP `query_records` schema flip) is
  **not** an acceptance check of this change; it is owned by the
  follow-up change that lands the `projectReadCapabilities` projection.
- New `postgres-expand-hydration.test.js` (env-gated on
  `PDPP_TEST_POSTGRES_URL`) covers list, detail, scope, limits,
  cardinality, child projection, and `changes_since` incompatibility.

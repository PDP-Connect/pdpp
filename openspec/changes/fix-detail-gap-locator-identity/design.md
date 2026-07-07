# Design — detail-gap locator identity fix

## Problem, precisely

`connector_detail_gaps` is the durable store of records whose detail collection
was deferred and must be retried. A gap's durable identity determines whether a
re-discovery updates the existing row or inserts a new one. The prior identity
was:

```
(connector_instance_id, grant_id, stream, parent_stream, record_key, detail_locator_json)
```

`detail_locator_json` is the connector-supplied blob needed to re-fetch the
record's detail. Its shape is volatile: connectors add fields over time. Amazon's
order-detail locator began emitting `order_date`. Because the whole locator was
hashed into identity, the same order under the new shape hashed to a different
`gap_id`. The recovery path (`DETAIL_GAP_RECOVERED` to mark the served `gap_id`
recovered) closed the new-shape row; the old-shape pending row was orphaned.
Because the reader required the newer `order_date` field, the old-shape locator
was also unrecoverable.

The fix is to make identity stable across locator drift.

## Decision: identity excludes the volatile locator when a record_key exists

The stable natural key of a detail gap is the record it defers:
`(connector_instance_id, grant_id, stream, parent_stream, record_key)`. This is
the identity the recovery closeout already reasons in terms of: recovery keys on
the record, not on the locator.

`record_key` is nullable, so identity uses a single derived key:

```
identity_key =
  record_key present -> 'key:' || record_key
  else               -> 'loc:' || locator_text
```

- `record_key` present: identity ignores the locator and is drift-immune.
- `record_key` absent: the locator remains the only disambiguator, so it is
  retained. Distinct locators still form distinct gaps.
- Both branches are prefixed with a disjoint namespace (`key:` vs. `loc:`) so a
  `record_key` whose literal value begins with `loc:` can never collide with a
  locator-only gap, and vice versa.

The store's computed `gap_id` and the database unique index apply the same
record-key branch. For locator-only gaps, the locator remains the storage-backend
uniqueness authority.

When a re-discovery hits an existing natural identity, the store updates the
stored `detail_locator_json` to the newly supplied locator. This is required:
the old locator shape may be exactly what made the stale row unrecoverable, so
deduping identity without upgrading the locator would preserve the retry defect.

### NULL uniqueness semantics

Postgres treats bare `NULL`s as distinct in a UNIQUE index, which would reopen a
loophole for null `grant_id`, `parent_stream`, or `record_key`. Every nullable
identity component is `COALESCE`/`NULLIF`-normalized to a concrete sentinel, so
no SQL NULL admits a duplicate. `grant_id` and `parent_stream` remain distinct
index columns; an empty-string sentinel there cannot cross-collide with another
column's value.

## Migration: reconcile pre-existing duplicates before rebuilding the index

A live database can already hold locator-drift duplicate rows. The new UNIQUE
index cannot be built over them directly. On init, both backends' detail-gap
migration:

1. Drops the identity index.
2. Reconciles each new-identity group by keeping the most-resolved sibling
   (`terminal` > `recovered` > `in_progress` > `pending`, then newest
   `updated_at`, then `gap_id`) and deleting the rest.
3. Rebuilds the identity index over the now-unique data.

This is safe for existing data: it removes only rows that share a natural
identity with a kept sibling, and prefers the resolved state. No collected record
data is touched, only redundant detail-gap rows. The Postgres path runs inside a
transaction; the SQLite path runs under the existing busy-retry wrapper.

The identity UNIQUE index is created only by the migration, not by bootstrap DDL,
so index creation always follows the dedupe step. The migration runs on every
init including fresh databases, so a new database still gets the index.

## Alternatives considered

- **Normalize the locator before hashing.** Rejected: it requires per-connector
  knowledge of which locator fields are volatile; that leaks connector specifics
  into the generic store.
- **Add a reconcile pass in the runtime recovery handler.** Rejected: it would
  only close orphans that happen to be re-served. Rows whose stale locator cannot
  be served would never trigger such a pass.
- **Cap retry attempts until the old row quarantines.** Complementary, not a
  fix: it would terminalize the orphan rather than recognize that the same record
  was already recovered under a newer locator.

## Acceptance checks

- A pending gap under an old-shape locator plus a re-upsert under a new-shape
  locator for the same `record_key` resolve to one durable row and store the
  newer locator shape.
- Recovery under the new-shape locator closes the pre-existing old-shape pending
  row.
- A `record_key` literally beginning with `loc:` does not collide with a
  locator-only gap.
- With no `record_key`, distinct locators still form distinct identities.
- A database seeded with pre-existing locator-drift duplicates collapses to the
  resolved sibling on migration, and the rebuilt index rejects a third-shape
  duplicate.
- Parity is proven on SQLite and Postgres.

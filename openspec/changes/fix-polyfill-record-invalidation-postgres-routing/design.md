# Design — Fix polyfill record invalidation Postgres routing

## Problem

The Postgres record-delete boundary had two adjacent class-A bugs:

1. **Connector-wide path was SQLite-only.** `deleteAllRecordsForConnector(connectorId)` is the helper the polyfill manifest reconciler calls when it detects the narrow seed-fixture → polyfill fingerprint transition (`openspec/changes/reconcile-invalidates-stale-records/`). It was written against the SQLite primitives only — `getOne` / `allowUnboundedReadAcknowledged` / `exec` against `referenceQueries.recordsDelete*`, which `lib/db.ts` dispatches unconditionally to `better-sqlite3`. `reconcilePolyfillManifests` is enabled by default on Postgres deployments (`shouldAutoReconcilePolyfillManifests` returns `true` for `storageBackendKind: 'postgres'`). So in Postgres mode the helper ran, found an empty SQLite shadow namespace, reported `deletedCount = 0`, logged no invalidation line, and left stale Postgres `records` sitting under the prior-shape manifest fingerprint.

2. **Per-stream helper was unusable on Postgres.** `postgresDeleteAllRecords(storageTarget, stream)` bundled its eight DELETEs into one semicolon-separated parameterized query passed to `postgresQuery`. `node-postgres`'s extended-protocol (prepared statements) refuses multi-statement queries with parameters: `cannot insert multiple commands into a prepared statement (code 42601)`. Every Postgres-mode caller of `deleteAllRecords(storageTarget, stream)` — owner reset, `rs.records.delete_stream` — therefore threw at runtime. No existing test exercised it against a real Postgres, so the bug had been silent.

Both bugs live on the same construction boundary (Postgres record-tail DELETEs); the audit at `tmp/workstreams/storage-backend-routing-audit-report.md` Finding 1 only called out the first. Shipping a connector-wide fix that works around the second would create incidental complexity — one delete path works, an adjacent nearly-identical one fails. Owner Revision 1 directed both to close together.

## Approach

One per-pair tail helper that both paths share. Keep the per-stream / per-connector difference confined to which extra cleanup runs around it.

### Shared per-pair tail in `postgres-records.js`

```js
export async function deletePostgresRecordTailForPair(client, connectorInstanceId, stream) {
  // record_changes, records, version_counter,
  // lexical_search_index, lexical_search_meta,
  // semantic_search_blob (LIKE scope_key), semantic_search_meta,
  // semantic_search_backfill_progress
  // — each as its own client.query so the prepared-statement
  //   protocol accepts the parameterized form.
}
```

Single transactional client (passed by the caller) keeps the set atomic. The DELETE set matches the rows the old multi-statement string targeted, byte-for-byte. Each is one parameterized statement — the construction that prepared statements actually accept.

### Per-stream `postgresDeleteAllRecords`

```js
export async function postgresDeleteAllRecords(storageTarget, stream) {
  // resolve instance from storageTarget
  return withPostgresTransaction(async (client) => {
    const deletedRecordCount = ...count live records...;
    await deletePostgresRecordTailForPair(client, instance, stream);
    return deletedRecordCount;
  });
}
```

Identical contract (signature, return shape) to before; the only behavior change is correctness: it no longer throws on the prepared-statement protocol.

### Connector-wide `postgresDeleteAllRecordsForConnector` in `records.js`

```js
async function postgresDeleteAllRecordsForConnector(connectorId) {
  // Discover (instance, stream) pairs from records ∪ record_changes ∪ blob_bindings
  // Count live records for the return-shape contract
  for each pair:
    await postgresDeleteAllRecords(storageTarget, stream);     // shared tail
    await postgresQuery('DELETE FROM blob_bindings ...');       // per-connector extra
    await markRetainedSizeStreamDirty(...);
    await lexicalIndexDeleteByConnectorStream(...);             // backend-aware helper
    await semanticIndexDeleteByConnectorStream(...);
  if deletedCount > 0:
    markDatasetSummaryProjectionStale(...);
    markRetainedSizeConnectionDirty(...);
}
```

The `blob_bindings` drop is per-connector only, mirroring the SQLite asymmetry: SQLite per-stream delete does NOT touch `blob_bindings` (lines 2454–2456 of `records.js`); SQLite per-connector delete DOES (line 2507). Postgres preserves that asymmetry so cross-backend semantics stay symmetrical.

The `lexicalIndexDeleteByConnectorStream` / `semanticIndexDeleteByConnectorStream` helpers already self-branch on `isPostgresStorageBackend()` and clear `lexical_search_*` / `semantic_search_*` for the pair. The shared tail also clears those tables under the same connection. The double-clear is intentional: it keeps the connector-wide path's shape identical to the SQLite arm and lets the search helpers own any future backend-specific index cleanup beyond raw table DELETEs (e.g. pgvector index invalidation, lexical refresh tokens). The cost is negligible — the second pass runs against rows the first already cleared.

## Alternatives considered

- **Single shared `_helper(client, instance, stream)` plus an `includeBlobBindings` flag.** Rejected: hides the per-stream vs. per-connector contract difference behind a boolean parameter; the call sites already make the difference visible by the extra DELETE.
- **Push the branch up into `polyfill-manifest-reconcile.ts`.** Rejected: that file is intentionally storage-backend-agnostic per the existing reconcile design; making it postgres-aware spreads the boundary further than the bug surface justifies.
- **Make `referenceQueries.recordsDelete*ByConnector` dual-backend at the `lib/db.ts` primitive layer.** Rejected: `lib/db.ts` is the SQLite primitive boundary by construction (`requireDb()` is `better-sqlite3`). Generic dual-backend dispatch would force ~70 other call sites into a query-text format that has no Postgres analogue.
- **Inline four DELETEs in the connector-wide helper, leave `postgresDeleteAllRecords` broken with a TODO.** Rejected per Owner Revision 1: leaves the per-stream owner-reset path knowingly broken on the same boundary; creates the same construction failure mode the fix is supposed to close.

## Acceptance checks

- Unit-level (env-gated Postgres): `records-delete-postgres-routing.test.js`
  - Connector-wide: seed 3 records across 2 streams under a unique connector_id; `deleteAllRecordsForConnector` returns `deletedCount: 3`, both streams in `streams`, and zero residual rows in `records` / `record_changes` / `version_counter` / `blob_bindings` for that connector.
  - Per-stream: seed 2 records on a target stream and 1 on a sibling stream under a unique connector_instance_id; `deleteAllRecords(storageTarget, target)` returns 2 and drops only the target's `records` / `record_changes` / `version_counter`; sibling stream and its `version_counter` survive untouched.
- Existing SQLite reconcile invalidation test (`polyfill-manifest-reconcile-invalidation.test.js`, 11 tests) continues to pass unchanged.
- Existing SQLite per-stream / per-connector delete coverage in `dataset-summary-read-model.test.js` and `records-instance-namespace.test.js` continues to pass.
- `openspec validate fix-polyfill-record-invalidation-postgres-routing --strict` and `openspec validate --all --strict` clean.
- `rg` for `recordsDeleteListInstanceStreamsByConnector|recordsDeleteCountRecordsByConnector|recordsDeleteDeleteBlobBindingsByStream` returns hits only inside the SQLite arm of `deleteAllRecordsForConnector` (and the query catalogue).

## Out of scope

- The two other findings from the routing audit (`resolveGrantScopedStateGrant`, `computeIndexState`) — each is a separate small change per the audit's recommendation.
- Broader record-store rewrites; the helper composes existing primitives rather than introducing new dispatch.
- Compaction or version-churn logic on the Postgres records boundary.
- Any change to the reconciler's transition gate, log line, or summary shape.
- Dashboard/UX changes around the invalidation event.

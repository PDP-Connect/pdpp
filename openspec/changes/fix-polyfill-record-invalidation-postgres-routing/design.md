# Design — Fix polyfill record invalidation Postgres routing

## Problem

`deleteAllRecordsForConnector(connectorId)` is the connector-wide record invalidation hook the polyfill manifest reconciler calls when it detects the narrow seed-fixture → polyfill fingerprint transition (`openspec/changes/reconcile-invalidates-stale-records/`). It was written against the SQLite primitives only:

- reads `recordsDeleteListInstanceStreamsByConnector` / `recordsDeleteCountRecordsByConnector` through `getOne` / `allowUnboundedReadAcknowledged`, which dispatch to `better-sqlite3` unconditionally via `lib/db.ts`'s `requireDb()`;
- writes through `exec` against four `recordsDeleteDelete*ByStream` queries, again SQLite only.

`reconcilePolyfillManifests` is enabled by default on Postgres deployments (`shouldAutoReconcilePolyfillManifests` returns `true` for `storageBackendKind: 'postgres'` because Postgres deployments do not have the canonical SQLite path sentinel but still need persisted manifest refresh). So in Postgres mode the helper runs, finds an empty SQLite shadow namespace, reports `deletedCount = 0`, logs no invalidation line, and leaves stale Postgres `records` sitting under the prior-shape manifest fingerprint.

The audit at `tmp/workstreams/storage-backend-routing-audit-report.md` calls this Finding 1 ("same class as `computeIndexState`"); the sibling per-stream `deleteAllRecords` is already correctly branched and composes a `postgresDeleteAllRecords(storageTarget, stream)` helper that the connector-wide path never grew.

## Approach

Keep the per-connector wipe local to the records boundary, issuing each per-pair DELETE as its own parameterized statement.

1. **Storage-backend branch at the top.** Mirror the shape used by `deleteAllRecords`, `listAllStreams`, `getDatasetRecordTimeBounds`, and ~70 other call sites in `reference-implementation/server/`:

   ```js
   if (isPostgresStorageBackend()) {
     return postgresDeleteAllRecordsForConnector(connectorId);
   }
   ```

2. **Namespace discovery against Postgres.** SQLite reads the `recordsDeleteListInstanceStreamsByConnector` view, which is a `DISTINCT connector_instance_id, stream FROM records WHERE connector_id = ?` shape. The Postgres helper does the same against `records ∪ record_changes ∪ blob_bindings` so that:

   - a stream with only history rows (every record deleted, history retained) is still rediscovered;
   - a stream whose only surviving artifacts are blob bindings (records and history already pruned) still gets bindings cleared;
   - the result is `DISTINCT` and stable-ordered for log readability.

3. **Per-pair deletion inline.** Each pair's deletes — `record_changes`, `records`, `version_counter`, `blob_bindings` — are issued as four individual parameterized statements so they survive pg-pool's prepared-statement protocol (the existing per-stream `postgresDeleteAllRecords` helper bundles its deletes into one semicolon-separated string, which pg rejects when params are present; that helper is not on this change's call path and is left untouched). The four-statement set matches the SQLite path's `recordsDeleteDeleteRecordsByStream`, `recordsDeleteDeleteRecordChangesByStream`, `recordsDeleteDeleteVersionCounterByStream`, `recordsDeleteDeleteBlobBindingsByStream` byte-for-byte in intent.

4. **Index teardown via the existing helpers.** `lexicalIndexDeleteByConnectorStream` and `semanticIndexDeleteByConnectorStream` already branch on `isPostgresStorageBackend()` internally and drop the postgres `lexical_search_*` / `semantic_search_*` tables for the (instance, stream) pair. The new helper invokes them once per discovered pair, matching the SQLite path's post-delete index teardown.

5. **Retained-size and dataset-summary side effects.** The two cross-cutting hooks — `markRetainedSizeStreamDirty` per stream, `markRetainedSizeConnectionDirty` once, `markDatasetSummaryProjectionStale` once — already branch internally for the backends that need them; the Postgres path invokes them in the same order as the SQLite path.

6. **Count semantics.** The SQLite path returns `recordsDeleteCountRecordsByConnector`, which counts live (`deleted = FALSE`) rows. The Postgres path does the same via a single `SELECT COUNT(*)::int FROM records WHERE connector_id = $1 AND deleted = FALSE`. This keeps the reconciler's "invalidated N records" log line honest in both backends.

## Alternatives considered

- **Push the branch up into `polyfill-manifest-reconcile.ts`.** Rejected: that file is intentionally storage-backend-agnostic per the existing reconcile design; making it postgres-aware spreads the boundary further than the bug surface justifies.
- **Make `referenceQueries.recordsDelete*ByConnector` dual-backend at the `lib/db.ts` primitive layer.** Rejected: `lib/db.ts` is the SQLite primitive boundary by construction (`requireDb()` is `better-sqlite3`). Generic dual-backend dispatch would force ~70 other call sites into a query-text format that has no Postgres analogue.
- **Walk the SQLite-derived `connector_instances` namespace and trust it in Postgres mode.** Rejected: in Postgres deployments the `connector_instances` rows live in Postgres, not in the SQLite shadow; this would propagate the same bug, just via a different table.

## Acceptance checks

- Unit-level: env-gated Postgres regression seeds records under a unique `(connector_id, connector_instance_id, stream)` triple and asserts `deleteAllRecordsForConnector` returns a non-zero `deletedCount`, returns the seeded stream in `streams`, and leaves zero rows under that `connector_id` in `records`, `record_changes`, `version_counter`, and `blob_bindings`.
- Existing SQLite reconcile invalidation test (`polyfill-manifest-reconcile-invalidation.test.js`) continues to pass unchanged.
- `openspec validate fix-polyfill-record-invalidation-postgres-routing --strict` is clean.
- `rg` for `recordsDeleteListInstanceStreamsByConnector|recordsDeleteCountRecordsByConnector|recordsDeleteDeleteBlobBindingsByStream` returns hits only inside the SQLite arm of `deleteAllRecordsForConnector` (and the query catalogue).

## Out of scope

- The two other findings from the routing audit (`resolveGrantScopedStateGrant`, `computeIndexState`) — each is a separate small change per the audit's recommendation.
- Broader record-store rewrites; the helper composes existing primitives rather than introducing new dispatch.
- Compaction or version-churn logic on the Postgres records boundary.
- Any change to the reconciler's transition gate, log line, or summary shape.

/**
 * Owner-approved migration plan for the Claude/Codex connector-instance
 * consolidation. One file, one source of truth — referenced by cli.mjs and
 * the regression test. Each pair has:
 *
 *   sourceInstanceId      legacy / snapshot row to drain
 *   targetInstanceId      active row that must own all useful data
 *   purgeSourceInstance   true → remove the connector_instances row after
 *                         draining (and any device_source_instances binding)
 *   skipMigration         true → no records exist on source, only purge
 *   targetDisplayName     canonical label to set on the active instance
 *
 * The script will refuse to run if any id here does not exist in the live
 * database. The id allow-list is intentionally narrow.
 */

export const MIGRATION_PAIRS = [
  {
    label: 'Simon VM Claude Code',
    targetInstanceId: 'cin_316b0e196d55bc14a70804fa',
    targetDisplayName: 'Simon VM Claude Code',
    sources: [
      // Fully-overlapped legacy snapshot — drain (no unique rows expected
      // but copy by anti-join anyway), then purge the connector_instances row.
      { sourceInstanceId: 'cin_legacy_82ad767be9acc7c96130a01a', purgeSourceInstance: true },
      // Zero-row entries — only purge the connector_instances row.
      { sourceInstanceId: 'cin_5add2c79ea36dfe99b8f3361', purgeSourceInstance: true, skipMigration: true },
      { sourceInstanceId: 'cin_779fcd03160816594b862808', purgeSourceInstance: true, skipMigration: true },
    ],
  },
  {
    label: 'vivid fish Claude Code',
    targetInstanceId: 'cin_11c6ac125e425934d3a1205c',
    targetDisplayName: 'vivid fish Claude Code',
    sources: [
      { sourceInstanceId: 'cin_legacy_b74b8d719b864f61c7703d81', purgeSourceInstance: true },
    ],
  },
  {
    label: 'peregrine Claude Code',
    targetInstanceId: 'cin_2de5ede05c8cc8d45935c414',
    targetDisplayName: 'peregrine Claude Code',
    sources: [
      { sourceInstanceId: 'cin_legacy_4e661a7b38d924115c5179ef', purgeSourceInstance: true },
    ],
  },
  {
    label: 'peregrine Codex',
    targetInstanceId: 'cin_ece4bfe5096b8bf67a1468c2',
    targetDisplayName: 'peregrine Codex',
    sources: [
      { sourceInstanceId: 'cin_legacy_3539b36392b2d972a1a4607c', purgeSourceInstance: true },
    ],
  },
  {
    // No target — instance has zero records and is being retired outright.
    label: 'Simon Codex (retire)',
    targetInstanceId: null,
    targetDisplayName: null,
    sources: [
      { sourceInstanceId: 'cin_57f33244fe8ec638498c96d0', purgeSourceInstance: true, skipMigration: true },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────
// Schema classification
//
// Every table in the per-instance categories below is verified against
// reference-implementation/server/postgres-storage.js to have a
// `connector_instance_id` column (and either a PK or index that uses it).
// Tables WITHOUT that column — notably lexical_search_snapshots and
// semantic_search_snapshots — are NEVER targeted by per-instance DELETE
// or COUNT. Those snapshots are pagination cursors keyed by snapshot_id,
// TTL-bounded, with a plan_hash that auto-invalidates when the per-
// connector plan changes (see search.js::hashPlan,
// search-semantic.js::hashSemanticPlan).
//
// Categories:
//   AUTHORITATIVE_INSTANCE_TABLES
//     Per-instance authoritative data. Copied source → target before
//     the source rows are deleted. Backed up first.
//
//   TARGET_REBUILD_STREAM_KEYED_TABLES
//     Search-derived rows keyed by (connector_instance_id, stream).
//     Invalidated on the target via `stream = ANY($streams)`.
//
//   TARGET_REBUILD_SCOPE_KEYED_TABLES
//     Search-derived rows keyed by (connector_instance_id, scope_key,
//     record_key) — currently only `semantic_search_blob`. `scope_key`
//     is the JSON-encoded scope tuple whose first element is the stream
//     (see search-semantic.js::scopeKeyPrefixForStream → e.g. `["posts",`).
//     Invalidated on the target via `scope_key LIKE ANY($prefixes)`,
//     where each prefix is `scopeKeyPrefixForStream(stream) || '%'`.
//
//   SOURCE_CLEAR_ONLY_TABLES
//     Per-instance rows that are operationally bound to the source
//     instance and MUST NOT be carried over to the target:
//       - controller_active_runs:    in-flight run rows; a soon-purged
//                                    instance can have nothing running.
//       - connector_schedules:       target already has its own schedule.
//       - connector_detail_gaps:     pending detail-fetch TODOs against
//                                    a stale instance id; target will
//                                    rediscover gaps on its own.
//       - connector_attention_records: operational alerts surfaced for
//                                    the source instance; resetting them
//                                    is the desired behavior post-merge.
//     Backed up, then cleared from the source. Never migrated.
//
//   IGNORED_PER_INSTANCE_TABLES (intentionally not touched):
//     - lexical_search_snapshots, semantic_search_snapshots — no CII
//       column, plan_hash already invalidates stale cursors.
//     - blobs — CII column present but content-addressed by blob_id;
//       handled explicitly by the blob-reattribution step in cli.mjs
//       (see drainSource), NOT as a per-CII clear.
//     - browser_surfaces, browser_surface_leases — keyed by connector_id /
//       surface_id, not CII; runtime owns lifecycle.
//     - spine_events, tokens, grants, pending_consents,
//       source_webhook_events, device_enrollment_codes,
//       device_exporters, device_ingest_*, oauth_clients,
//       owner_device_auth, web_push_subscriptions — not CII-keyed.
//     - device_source_instances — handled explicitly (see
//       DEVICE_BINDING_TABLES below).
// ──────────────────────────────────────────────────────────────────────

export const AUTHORITATIVE_INSTANCE_TABLES = Object.freeze([
  'records',
  'record_changes',
  'version_counter',
  'blob_bindings',
  'connector_state',
  'grant_connector_state',
  'scheduler_run_history',
  'scheduler_last_run_times',
]);

// Search-derived per-instance tables keyed by (connector_instance_id, stream).
// Invalidated on the target via `WHERE connector_instance_id = $1 AND stream = ANY($2)`.
export const TARGET_REBUILD_STREAM_KEYED_TABLES = Object.freeze([
  'lexical_search_index',
  'lexical_search_meta',
  'semantic_search_meta',
  'semantic_search_backfill_progress',
]);

// Search-derived per-instance tables keyed by (connector_instance_id, scope_key,
// record_key). `scope_key` JSON-encodes the scope tuple whose first element is
// the stream (see search-semantic.js::scopeKeyPrefixForStream — yields strings
// like `["posts",`). Invalidated on the target via
// `WHERE connector_instance_id = $1 AND (scope_key LIKE $p1 OR scope_key LIKE $p2 …)`.
export const TARGET_REBUILD_SCOPE_KEYED_TABLES = Object.freeze([
  'semantic_search_blob',
]);

// Union convenience for code paths that don't care about the keying shape —
// e.g. backups, source-side bulk delete, classification assertions. Anything
// that issues DML referencing `stream` MUST use TARGET_REBUILD_STREAM_KEYED_TABLES,
// never this union.
export const TARGET_REBUILD_ALL_TABLES = Object.freeze([
  ...TARGET_REBUILD_STREAM_KEYED_TABLES,
  ...TARGET_REBUILD_SCOPE_KEYED_TABLES,
]);

export const SOURCE_CLEAR_ONLY_TABLES = Object.freeze([
  'controller_active_runs',
  'connector_schedules',
  'connector_detail_gaps',
  'connector_attention_records',
]);

// Tables intentionally omitted from all per-instance categories above. Most
// have no `connector_instance_id` column at all — per-instance DELETE/COUNT
// against them would fail outright. `blobs` is the exception: it does carry
// a CII column, but the row identity is `blob_id` (sha256-derived) and rows
// are shared across instances. Blob rows are handled by the dedicated
// blob-reattribution step in cli.mjs::drainSource, not by bulk per-instance
// DML. Exported so the test suite can assert the script never DELETEs or
// COUNTs them by connector_instance_id.
export const IGNORED_PER_INSTANCE_TABLES = Object.freeze([
  'lexical_search_snapshots',
  'semantic_search_snapshots',
  'blobs',
  'browser_surfaces',
  'browser_surface_leases',
  'spine_events',
  'tokens',
  'grants',
  'pending_consents',
  'source_webhook_events',
  'device_enrollment_codes',
  'device_exporters',
  'device_ingest_batch_outcomes',
  'device_ingest_credentials',
  'oauth_clients',
  'owner_device_auth',
  'web_push_subscriptions',
  'connectors',
]);

// Tables that bind a device's local source to a connector_instance. After
// migration we either retarget the binding (if the device still represents
// the active source) or drop the row entirely if the legacy instance is
// being retired. Owner decision is communicated via purgeSourceInstance.
export const DEVICE_BINDING_TABLES = Object.freeze([
  'device_source_instances',
]);

// All tables the source side will touch when computing row counts and
// backups. Source-clear-only rows are included so the preview accurately
// reflects what will be deleted from the source.
export const SOURCE_TOUCHED_TABLES = Object.freeze([
  ...AUTHORITATIVE_INSTANCE_TABLES,
  ...SOURCE_CLEAR_ONLY_TABLES,
  // Source's own search-derived rows are dropped too — otherwise they
  // would point at a connector_instance_id that no longer exists once
  // the source is purged. Both stream-keyed and scope-keyed tables are
  // safe to clear by `WHERE connector_instance_id = $1` alone (the bulk
  // source-clear path doesn't filter by stream/scope_key, only CII).
  ...TARGET_REBUILD_ALL_TABLES,
  ...DEVICE_BINDING_TABLES,
]);

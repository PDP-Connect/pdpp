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

// Tables keyed by connector_instance_id that hold authoritative state.
// Order matters: record_changes references no FK but uses
// (connector_instance_id, stream, version) as PK, so we re-allocate version
// during copy. blobs is referenced by blob_bindings via blob_id (not by
// connector_instance_id), so we copy bindings while leaving the blob row
// untouched — the blob is content-addressed and may be shared.
export const AUTHORITATIVE_INSTANCE_TABLES = Object.freeze([
  'records',
  'record_changes',
  'version_counter',
  'blob_bindings',
  'connector_state',
  'grant_connector_state',
  'scheduler_run_history',
  'scheduler_last_run_times',
  'controller_active_runs',
]);

// Derived/search tables — dropped for the source instance after migration,
// since the runtime rebuilds these lazily (search.js::rebuildLexicalIndexForStream,
// search-semantic.js::rebuildSemanticIndexForStream). We do not attempt to
// rewrite the rows; clearing them on both source and target's affected
// streams forces a clean rebuild on next query.
export const DERIVED_INSTANCE_TABLES = Object.freeze([
  'lexical_search_index',
  'lexical_search_meta',
  'lexical_search_snapshots',
  'semantic_search_blob',
  'semantic_search_meta',
  'semantic_search_snapshots',
  'semantic_search_backfill_progress',
]);

// Tables that bind a device's local source to a connector_instance. After
// migration we either retarget the binding (if the device still represents
// the active source) or drop the row entirely if the legacy instance is
// being retired. Owner decision is communicated via purgeSourceInstance.
export const DEVICE_BINDING_TABLES = Object.freeze([
  'device_source_instances',
]);

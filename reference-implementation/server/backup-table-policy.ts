// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type BackupTableClassification = "backup_required" | "derived_rebuildable" | "ephemeral_crash_reconciled";

export interface BackupTableInventoryEntry {
  classification: BackupTableClassification;
  reason: string;
}

export const BACKUP_TABLE_INVENTORY: Record<string, BackupTableInventoryEntry> = {
  acquisition_batches: {
    classification: "backup_required",
    reason: "Manual/import acquisition history and artifact linkage are owner state.",
  },
  blob_bindings: {
    classification: "backup_required",
    reason: "Binds durable blob bytes to records and JSON paths.",
  },
  blobs: {
    classification: "backup_required",
    reason: "Durable binary object metadata; bytes must restore with the database recovery point.",
  },
  browser_surface_leases: {
    classification: "ephemeral_crash_reconciled",
    reason: "Active browser leases are runtime locks that must converge through crash recovery after boot.",
  },
  browser_surface_replacement_receipts: {
    classification: "ephemeral_crash_reconciled",
    reason: "Replacement receipts describe in-flight browser recovery and must be reconciled after a crash.",
  },
  browser_surface_replacement_selection_override_audit_outbox: {
    classification: "backup_required",
    reason:
      "Audit outbox state is durable audit evidence unless an executable crash-reconciliation oracle proves safe loss.",
  },
  browser_surface_replacement_selection_override_batches: {
    classification: "ephemeral_crash_reconciled",
    reason: "Batch rows coordinate replacement override processing and are reconciled by runtime recovery.",
  },
  browser_surface_replacement_selection_overrides: {
    classification: "ephemeral_crash_reconciled",
    reason: "Override rows affect active browser replacement choices and are reconciled with live surfaces.",
  },
  browser_surfaces: {
    classification: "ephemeral_crash_reconciled",
    reason: "Surface liveness is process-local and must be re-probed after restore.",
  },
  cimd_client_documents: {
    classification: "backup_required",
    reason: "Client documents are persisted client configuration.",
  },
  client_event_attempts: {
    classification: "backup_required",
    reason: "Delivery attempts are durable delivery evidence unless reconciliation proves safe loss.",
  },
  client_event_queue: {
    classification: "backup_required",
    reason: "Queued client delivery is outbox state unless reconciliation proves safe loss.",
  },
  client_event_subscriptions: {
    classification: "backup_required",
    reason: "Subscriptions are durable client delivery configuration.",
  },
  connector_attention_records: {
    classification: "backup_required",
    reason: "Owner-visible connector attention state must survive restore.",
  },
  connector_detail_gaps: {
    classification: "backup_required",
    reason: "Gap evidence records source coverage state.",
  },
  connector_instance_credentials: {
    classification: "backup_required",
    reason: "Stored connector credentials require the credential encryption key to decrypt after restore.",
  },
  connector_instance_tombstones: {
    classification: "backup_required",
    reason: "Deletion tombstones prevent connection resurrection.",
  },
  connector_instances: {
    classification: "backup_required",
    reason: "Connection identity and configuration are core owner state.",
  },
  connector_maintenance_cursor: {
    classification: "ephemeral_crash_reconciled",
    reason: "Maintenance sweep cursors can be retried after crash recovery.",
  },
  connector_schedules: {
    classification: "backup_required",
    reason: "Collection schedules are durable owner configuration.",
  },
  connector_state: {
    classification: "backup_required",
    reason: "Connector checkpoint state is needed for incremental recovery.",
  },
  connector_summary_evidence: {
    classification: "derived_rebuildable",
    reason: "Summary evidence is a projection rebuilt from records and connector state.",
  },
  connectors: {
    classification: "backup_required",
    reason: "Connector catalog rows are required to interpret connections and records.",
  },
  controller_active_runs: {
    classification: "ephemeral_crash_reconciled",
    reason: "Active run rows represent in-flight work and must be reconciled by startup/runtime recovery.",
  },
  dataset_summary_projection: {
    classification: "derived_rebuildable",
    reason: "Dataset summary rows are projections rebuilt from retained records.",
  },
  dataset_summary_stream_projection: {
    classification: "derived_rebuildable",
    reason: "Stream summary rows are projections rebuilt from retained records.",
  },
  device_enrollment_codes: {
    classification: "backup_required",
    reason: "Outstanding enrollment codes are operator-visible enrollment state.",
  },
  device_exporters: {
    classification: "backup_required",
    reason: "Local device exporter definitions are durable source configuration.",
  },
  device_ingest_batch_outcomes: {
    classification: "backup_required",
    reason: "Batch outcomes record ingest idempotency and diagnostics.",
  },
  device_ingest_credentials: {
    classification: "backup_required",
    reason: "Device ingest credentials are durable local collector secrets.",
  },
  device_source_instances: {
    classification: "backup_required",
    reason: "Device source bindings are durable connection state.",
  },
  explore_cursor_store: {
    classification: "ephemeral_crash_reconciled",
    reason:
      "Explore cursor handles are bounded TTL page tokens; stale or missing handles fail closed as invalid cursors.",
  },
  grant_connector_state: {
    classification: "backup_required",
    reason: "Grant-scoped connector checkpoint state is needed for recovery.",
  },
  grant_package_members: {
    classification: "backup_required",
    reason: "Grant package membership is authorization state.",
  },
  grant_packages: {
    classification: "backup_required",
    reason: "Grant package metadata is authorization state.",
  },
  grants: {
    classification: "backup_required",
    reason: "OAuth grants are core authorization state.",
  },
  lexical_search_index: {
    classification: "derived_rebuildable",
    reason: "Lexical index rows are rebuilt from records.",
  },
  lexical_search_meta: {
    classification: "derived_rebuildable",
    reason: "Lexical index metadata is rebuilt with the index.",
  },
  lexical_search_snapshots: {
    classification: "derived_rebuildable",
    reason: "Search result snapshots are derived query artifacts.",
  },
  manifest_write_violations: {
    classification: "backup_required",
    reason: "Manifest write violations are durable diagnostics for connector integrity.",
  },
  manual_upload_artifacts: {
    classification: "backup_required",
    reason: "Manual upload artifact metadata must match restored artifact files.",
  },
  oauth_authorization_codes: {
    classification: "ephemeral_crash_reconciled",
    reason: "Authorization codes are short-lived OAuth transaction state.",
  },
  oauth_clients: {
    classification: "backup_required",
    reason: "Registered client metadata is durable authorization configuration.",
  },
  oauth_refresh_tokens: {
    classification: "backup_required",
    reason: "Refresh tokens are durable authorization credentials.",
  },
  owner_device_auth: {
    classification: "backup_required",
    reason: "Owner-device authorization state must survive restore.",
  },
  pending_consents: {
    classification: "backup_required",
    reason: "Pending consent transactions must not be silently dropped by a coherent restore.",
  },
  presentation_screen_states: {
    classification: "ephemeral_crash_reconciled",
    reason: "Presentation screen state is tied to live browser/screen surfaces.",
  },
  provider_app_config: {
    classification: "backup_required",
    reason: "Provider app secrets/config depend on the credential encryption key.",
  },
  record_acquisition_provenance: {
    classification: "backup_required",
    reason: "Acquisition provenance must match restored records and artifacts.",
  },
  record_changes: {
    classification: "backup_required",
    reason: "Record history is durable owner data.",
  },
  record_rejection_quota: {
    classification: "backup_required",
    reason: "Hosted rejection quota counters bound durable rejection accounting and replay.",
  },
  record_rejections: {
    classification: "backup_required",
    reason: "Hosted rejection receipts are durable ingest evidence.",
  },
  records: {
    classification: "backup_required",
    reason: "Current records are durable owner data.",
  },
  retained_size_connection: {
    classification: "derived_rebuildable",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_global: {
    classification: "derived_rebuildable",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_record_family: {
    classification: "derived_rebuildable",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_stream: {
    classification: "derived_rebuildable",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_top_rows: {
    classification: "derived_rebuildable",
    reason: "Retained-size rows are rebuildable projections.",
  },
  run_history: {
    classification: "backup_required",
    reason: "Terminal run history is durable operational evidence.",
  },
  scheduler_last_run_times: {
    classification: "backup_required",
    reason: "Scheduler checkpoints prevent duplicate or skipped scheduled work.",
  },
  search_index_dirty: {
    classification: "ephemeral_crash_reconciled",
    reason: "Dirty flags are reconciled by bounded search-index repair.",
  },
  semantic_search_backfill_progress: {
    classification: "derived_rebuildable",
    reason: "Semantic backfill progress is recomputed while rebuilding semantic search.",
  },
  semantic_search_blob: {
    classification: "derived_rebuildable",
    reason: "Semantic embeddings are rebuilt from records and blobs.",
  },
  semantic_search_meta: {
    classification: "derived_rebuildable",
    reason: "Semantic index metadata is rebuilt with the index.",
  },
  semantic_search_rowid: {
    classification: "derived_rebuildable",
    reason: "SQLite semantic rowid mapping is rebuilt with semantic search.",
  },
  semantic_search_snapshots: {
    classification: "derived_rebuildable",
    reason: "Semantic search snapshots are derived query artifacts.",
  },
  source_webhook_events: {
    classification: "backup_required",
    reason: "Webhook event idempotency and diagnostics must survive restore.",
  },
  source_webhook_run_receipts: {
    classification: "backup_required",
    reason: "Webhook event-to-run receipts prevent replay from admitting duplicate runs.",
  },
  spine_events: {
    classification: "backup_required",
    reason: "Disclosure-spine events are durable audit state.",
  },
  tokens: {
    classification: "backup_required",
    reason: "Access-token state is core authorization state.",
  },
  version_counter: {
    classification: "backup_required",
    reason: "Version counters are required to continue monotonic record versions.",
  },
  web_push_subscriptions: {
    classification: "backup_required",
    reason: "Push subscription rows are durable notification configuration.",
  },
};

const SQLITE_INTERNAL_TABLES = new Set(["sqlite_sequence", "sqlite_stat1", "sqlite_stat4"]);
const SQLITE_LAZY_APPLICATION_TABLES = ["explore_cursor_store"] as const;

export function isInternalBackupCatalogTable(name: string): boolean {
  return SQLITE_INTERNAL_TABLES.has(name) || isShadowTable(name);
}

export const SQLITE_LAZY_STORAGE_TABLES = Object.freeze([...SQLITE_LAZY_APPLICATION_TABLES]);

export const POSTGRES_STORAGE_TABLES = Object.freeze(
  Object.keys(BACKUP_TABLE_INVENTORY).filter((name) => name !== "semantic_search_rowid")
);

export const SHADOW_TABLE_PATTERNS = [
  /^lexical_search_index_(config|data|docsize|idx|content)$/,
  /^ref_record_search$/,
  /^ref_record_search_(config|data|docsize|idx|content)$/,
  /^semantic_search_vec$/,
  /^semantic_search_vec_.+$/,
];

export function isShadowTable(name: string): boolean {
  for (const pattern of SHADOW_TABLE_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
}

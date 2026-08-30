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
  agent_connect_attempts: {
    classification: "backup_required",
    reason: "Agent-connect handoff attempts and recovery bindings are durable authorization delivery state.",
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
    classification: "backup_required",
    reason: "Active browser leases are runtime locks that must converge through crash recovery after boot.",
  },
  browser_surface_replacement_receipts: {
    classification: "backup_required",
    reason: "Replacement receipts describe in-flight browser recovery and must be reconciled after a crash.",
  },
  browser_surface_replacement_selection_override_audit_outbox: {
    classification: "backup_required",
    reason:
      "Audit outbox state is durable audit evidence unless an executable crash-reconciliation oracle proves safe loss.",
  },
  browser_surface_replacement_selection_override_batches: {
    classification: "backup_required",
    reason: "Batch rows coordinate replacement override processing and are reconciled by runtime recovery.",
  },
  browser_surface_replacement_selection_overrides: {
    classification: "backup_required",
    reason: "Override rows affect active browser replacement choices and are reconciled with live surfaces.",
  },
  browser_surfaces: {
    classification: "backup_required",
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
  connector_coverage_horizons: {
    classification: "backup_required",
    reason:
      "Provider coverage-horizon confirmations are owner/operator-recorded provenance (basis, reason, confirmed_by); losing them silently reverts a confirmed provider boundary back to unconfirmed.",
  },
  connector_detail_gaps: {
    classification: "backup_required",
    reason: "Gap evidence records source coverage state.",
  },
  connector_instance_config_current: {
    classification: "backup_required",
    reason:
      "Names the revision a connection actually collects under. Losing the pointer silently reverts every connection to unconfigured while the revisions survive — configuration present but inert, with nothing saying so.",
  },
  connector_instance_config_revisions: {
    classification: "backup_required",
    reason:
      "Owner consent decisions and the scopes they authorize. A collection_scope revision is the owner's answer to what may be collected; it cannot be rebuilt from any other table.",
  },
  connector_instance_credentials: {
    classification: "backup_required",
    reason: "Stored connector credentials require the credential encryption key to decrypt after restore.",
  },
  connector_instance_groups: {
    classification: "backup_required",
    reason:
      "Connection grouping is owner-decided data, never inferred at read time, so it cannot be rebuilt after restore.",
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
    classification: "backup_required",
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
    classification: "backup_required",
    reason: "Summary evidence is a projection rebuilt from records and connector state.",
  },
  connector_summary_evidence_repair_chunk: {
    classification: "backup_required",
    reason:
      "Chunked whale-repair resume state. A restore that drops it is safe — an absent cursor simply restarts that connection's scan from the beginning — but it is captured like every other table so the inventory stays a complete census rather than a judgement call about which rows matter.",
  },
  connectors: {
    classification: "backup_required",
    reason: "Connector catalog rows are required to interpret connections and records.",
  },
  consent_exchange_codes: {
    classification: "backup_required",
    reason: "Consent exchange state is durable owner authorization state until expiry or redemption.",
  },
  controller_active_runs: {
    classification: "backup_required",
    reason: "Active run rows represent in-flight work and must be reconciled by startup/runtime recovery.",
  },
  controller_identity: {
    classification: "backup_required",
    reason:
      "The identity that decides which orphaned runs a boot may adjudicate. It must restore with the runs it adjudicates, because both readings of a missing row are wrong: a restore that reseeds from the host name reproduces the defect this table fixes, and one that adopts an unrelated id adjudicates runs it does not own.",
  },
  dataset_summary_projection: {
    classification: "backup_required",
    reason: "Dataset summary rows are projections rebuilt from retained records.",
  },
  dataset_summary_stream_projection: {
    classification: "backup_required",
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
    classification: "backup_required",
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
    classification: "backup_required",
    reason: "Lexical index rows are rebuilt from records.",
  },
  lexical_search_meta: {
    classification: "backup_required",
    reason: "Lexical index metadata is rebuilt with the index.",
  },
  lexical_search_snapshots: {
    classification: "backup_required",
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
    classification: "backup_required",
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
    classification: "backup_required",
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
    classification: "backup_required",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_global: {
    classification: "backup_required",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_record_family: {
    classification: "backup_required",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_stream: {
    classification: "backup_required",
    reason: "Retained-size rows are rebuildable projections.",
  },
  retained_size_top_rows: {
    classification: "backup_required",
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
    classification: "backup_required",
    reason: "Dirty flags are reconciled by bounded search-index repair.",
  },
  semantic_hnsw_index_build: {
    classification: "backup_required",
    reason:
      "Scheduling/diagnostic state for the optional HNSW catalog-acceleration build (server/postgres-storage.ts runPostgresSemanticHnswMaintenance). A restore that drops the row is safe: bootstrap reseeds it to 'pending' via INSERT ... ON CONFLICT DO NOTHING, and maintenance rebuilds the index with CREATE INDEX CONCURRENTLY IF NOT EXISTS, so no reader depends on the row surviving. It is still captured, like connector_summary_evidence_repair_chunk, so the inventory stays a complete census rather than a judgement call about which rows matter.",
  },
  semantic_search_backfill_progress: {
    classification: "backup_required",
    reason: "Semantic backfill progress is recomputed while rebuilding semantic search.",
  },
  semantic_search_blob: {
    classification: "backup_required",
    reason: "Semantic embeddings are rebuilt from records and blobs.",
  },
  semantic_search_meta: {
    classification: "backup_required",
    reason: "Semantic index metadata is rebuilt with the index.",
  },
  semantic_search_rowid: {
    classification: "backup_required",
    reason: "SQLite semantic rowid mapping is rebuilt with semantic search.",
  },
  semantic_search_snapshots: {
    classification: "backup_required",
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
  storage_migration_ledger: {
    classification: "backup_required",
    reason:
      "The completion receipt for data migrations that rewrite rows (server/postgres-migration-ledger.ts). It cannot be rebuilt from the data it describes — inferring completion from row shape is precisely the guess the ledger replaced — so a lost row makes the next boot re-run a completed migration against a restored database, reinstating the repeated pre-listen rewrite this table exists to prevent. A lost `blocked` row is worse: it erases an operator-visible fail-closed stop and lets a later boot re-attempt a collision silently.",
  },
  stream_evidence_run_registry: {
    classification: "backup_required",
    reason:
      "The accepted-(run_id, stream) claims enforcing spec-collection-profile.md rule 5 ('at most one accepted STREAM_EVIDENCE per stream per run_id'). Rows are never deleted and cannot be rebuilt from any other table: rule 5 defines 'same run' strictly by caller-chosen run_id and grants no restart or restore exception, so a claim lost at the durability boundary lets a reused run_id re-accept and admit duplicate authority — the same replay-admits-duplicates hazard source_webhook_run_receipts is retained against.",
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
const POSTGRES_LAZY_APPLICATION_TABLES = [
  "dataset_summary_projection",
  "dataset_summary_stream_projection",
  "explore_cursor_store",
] as const;
const POSTGRES_SQLITE_ONLY_TABLES = ["semantic_search_rowid"] as const;
// pgvector/HNSW has no SQLite counterpart; the build-progress row only ever exists
// under the Postgres backend, so it is the Postgres-side mirror of the
// SQLite-only exception above rather than part of the shared storage seam.
const SQLITE_POSTGRES_ONLY_TABLES = ["semantic_hnsw_index_build"] as const;

export function isInternalBackupCatalogTable(name: string): boolean {
  return SQLITE_INTERNAL_TABLES.has(name) || isShadowTable(name);
}

export const SQLITE_LAZY_STORAGE_TABLES = Object.freeze([...SQLITE_LAZY_APPLICATION_TABLES]);
export const POSTGRES_LAZY_STORAGE_TABLES = Object.freeze([...POSTGRES_LAZY_APPLICATION_TABLES]);
export const POSTGRES_SQLITE_ONLY_STORAGE_TABLES = Object.freeze([...POSTGRES_SQLITE_ONLY_TABLES]);
export const SQLITE_POSTGRES_ONLY_STORAGE_TABLES = Object.freeze([...SQLITE_POSTGRES_ONLY_TABLES]);

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

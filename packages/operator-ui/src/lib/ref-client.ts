/**
 * Type declarations for the reference-designated `_ref` read surfaces on the
 * PDPP authorization server.
 *
 * On the public site (`apps/site`) this module is a **types-only** declaration
 * surface: the shared dashboard feature components and the mock sandbox import
 * these shapes with `import type`, but the runtime client (the owner-token
 * authenticated `_ref` fetchers) lives with the operator console
 * (`apps/console`), not here. Keeping this file type-only guarantees the public
 * bundle never value-imports `owner-token`/`verify-session`/`login-redirect`
 * and never reaches a live AS/RS.
 */

export interface SourceObject {
  id: string;
  kind: "connector" | "provider_native";
}

export interface SpineEvent {
  actor_id: string | null;
  actor_type: string | null;
  client_id: string | null;
  data: Record<string, unknown>;
  event_id: string;
  event_type: string;
  grant_id: string | null;
  interaction_id: string | null;
  object_id: string | null;
  object_type: string | null;
  occurred_at: string;
  provider_id?: string | null;
  recorded_at: string;
  request_id: string | null;
  run_id: string | null;
  scenario_id: string | null;
  source?: SourceObject | null;
  status: string | null;
  stream_id: string | null;
  subject_id: string | null;
  subject_type: string | null;
  token_id: string | null;
  trace_id: string;
  version: string;
}

export interface TimelineEnvelope {
  event_count: number;
  events: SpineEvent[];
  next_cursor?: string;
  object: string;
  trace_id: string | null;
  truncated?: boolean;
}

export interface ListResponse<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string;
  object: "list";
}

export interface FailureInfo {
  event_type: string;
  reason: string | null;
}

export interface TraceSummary {
  actor_id: string | null;
  actor_type: string | null;
  client_id: string | null;
  event_count: number;
  failure: FailureInfo | null;
  first_at: string;
  grant_id: string | null;
  kinds: string[];
  last_at: string;
  object: "trace_summary";
  provider_id?: string | null;
  request_id: string | null;
  run_id: string | null;
  source?: SourceObject | null;
  status: string;
  trace_id: string;
}

export interface GrantSummary {
  client_id: string | null;
  connector_id?: string | null;
  event_count: number;
  failure: FailureInfo | null;
  first_at: string;
  grant_id: string;
  kinds: string[];
  last_at: string;
  object: "grant_summary";
  provider_id?: string | null;
  source?: SourceObject | null;
  status: string;
}

export interface RunSummary {
  browser_surface_lease_id?: string;
  browser_surface_profile_key?: string;
  browser_surface_status?: string;
  browser_surface_wait_reason?: string;
  connector_id?: string | null;
  event_count: number;
  failure_reason: string | null;
  first_at: string;
  grant_id: string | null;
  kinds: string[];
  last_at: string;
  needs_input: boolean;
  object: "run_summary";
  provider_id?: string | null;
  run_id: string;
  source?: SourceObject | null;
  status: string;
}

export interface RefConnectorRunSummary {
  event_count: number;
  failure_reason: string | null;
  finished_at: string | null;
  first_at: string;
  known_gaps?: unknown[];
  last_at: string;
  run_id: string;
  started_at: string;
  status: string;
}

export interface RefreshPolicy {
  assisted_after_owner_auth?: boolean;
  background_safe?: boolean;
  bot_detection_sensitivity?: "high" | "low" | "medium";
  interaction_posture?: "credentials" | "manual_action_likely" | "none" | "otp_likely";
  maximum_staleness_seconds?: number;
  minimum_interval_seconds?: number;
  rate_limit_sensitivity?: "high" | "low" | "medium";
  rationale?: string;
  recommended_interval_seconds?: number;
  recommended_mode?: "automatic" | "manual" | "paused";
  session_lifetime_seconds?: number;
}

export type RefRunAutomationMode = "ask_before_run" | "assisted" | "manual_only" | "unattended";
export type RefNotificationPosture = "action_required" | "informational" | "none";

export interface RefSchedule {
  active_run_id: string | null;
  automation_mode: RefRunAutomationMode;
  automation_summary: string;
  connector_id: string;
  created_at: string;
  effective_mode: "automatic" | "manual" | "paused";
  enabled: boolean;
  human_attention_needed: boolean;
  /**
   * Non-null when the row is enabled but the connector's current manifest
   * policy makes it ineligible for automatic background refresh. The schedule
   * persists as operator intent, but the scheduler will not run it and the
   * dashboard should surface this reason instead of implying it is running.
   */
  ineligibility_reason: string | null;
  interval_seconds: number;
  jitter_seconds: number;
  last_error_code: string | null;
  last_finished_at: string | null;
  last_started_at: string | null;
  last_successful_at: string | null;
  minimum_interval_warning: string | null;
  next_due_at: string | null;
  notification_posture: RefNotificationPosture;
  object: "schedule";
  policy_warning?: string | null;
  recommended_policy: RefreshPolicy | null;
  scheduler_backoff: {
    backoff_applied: boolean;
    consecutive_failures: number;
    next_run_at: string | null;
    reason_class: string | null;
    recommended_health_state: "blocked" | "cooling_off" | null;
  } | null;
  trigger_kind: "scheduled";
  updated_at: string;
}

/**
 * Push-mode (local-device exporter) durable progress evidence. `null` /
 * absent for scheduler-managed connections; populated only when a trusted
 * device-side heartbeat row exists scoped to this `connector_instance_id`.
 *
 * The dashboard renders this in place of "no scheduler run yet" for
 * local-device connectors. Mirrors `LocalDeviceProgress` from
 * `reference-implementation/server/ref-control.ts`.
 */
export interface RefLocalDeviceProgress {
  last_heartbeat_at: string | null;
  last_heartbeat_status: string | null;
  last_ingest_at: string | null;
  records_pending: number | null;
  source_count: number;
}

export interface RefRetainedBytesBreakdown {
  blob_bytes: number;
  record_changes_json_bytes: number;
  record_json_bytes: number;
  total_bytes: number;
}

export interface RefConnectorSummary {
  connection_health: RefConnectionHealthSnapshot;
  connection_id: string;
  connector_display_name?: string;
  connector_id: string;
  connector_instance_id?: string;
  display_name: string;
  freshness: Record<string, unknown>;
  last_run: RefConnectorRunSummary | null;
  last_successful_run: RefConnectorRunSummary | null;
  /**
   * Per-instance durable progress for local-device connectors. Absent on
   * scheduler-managed rows and on local-device rows with no trusted
   * heartbeat yet.
   */
  local_device_progress?: RefLocalDeviceProgress | null;
  manifest_version: string | null;
  /** Top-level mirror of `connection_health.next_action`. */
  next_action: RefNextAction | null;
  refresh_policy?: RefreshPolicy | null;
  retained_bytes?: RefRetainedBytesBreakdown | null;
  schedule: RefSchedule | null;
  stream_count?: number;
  streams: string[];
  total_records: number;
  total_retained_bytes?: number | null;
}

/**
 * Owner-facing, non-secret call to action surfaced alongside the health
 * snapshot. Mirrors the reference-implementation contract at
 * reference-implementation/runtime/connection-health.ts. The dashboard
 * renders this verbatim; it must not invent fields or infer secret
 * `action_target` values.
 *
 * `source` carries provenance:
 *   - `structured`: a durable structured-attention record drove the CTA.
 *   - `schedule_fallback`: only the schedule's `human_attention_needed`
 *     flag was available, so the CTA is coarse and the UI must say so.
 *   - `none`: reserved for non-needs-attention states.
 */
export interface RefNextAction {
  action_target: string | null;
  attention_id: string | null;
  expires_at: string | null;
  /**
   * Durable notification delivery state for the attention prompt
   * driving this CTA. `null` for schedule-fallback CTAs (the durable
   * record is unknown) and for older snapshots that pre-date this
   * field. The dashboard renders "we notified you / delivery failed /
   * quiet hours" without rereading transport logs. Per the
   * schedule/manual-attention spec, `failed` MUST remain visible
   * — notification failure is not permission to relaunch the run.
   */
  notification_state?: "acknowledged" | "failed" | "pending" | "sent" | "suppressed" | null;
  owner_action: "act_elsewhere" | "operate_attachment" | "provide_value" | null;
  reason_code: string | null;
  response_contract: "response_required" | "none" | null;
  source: "none" | "schedule_fallback" | "structured";
}

export type RefAttentionAxis = "acknowledged" | "in_progress" | "none" | "open";

export type RefCoverageAxis =
  | "complete"
  | "deferred"
  | "gaps"
  | "inventory_only"
  | "partial"
  | "retryable_gap"
  | "terminal_gap"
  | "unavailable"
  | "unknown"
  | "unsupported";

export type RefFreshnessAxis = "fresh" | "stale" | "unknown";

export type RefOutboxAxis = "active" | "idle" | "stalled" | "unknown";

export type RefRemoteSurfaceAxis = "failed" | "idle" | "leased" | "none" | "unknown" | "waiting";

export interface RefConnectionConditionRemediation {
  action: string;
  label: string;
  retryable: boolean;
  target: string | null;
}

export interface RefConnectionHealthCondition {
  current?: boolean;
  expires_at: string | null;
  id: string;
  message: string;
  observed_at: string | null;
  origin: string;
  reason: string;
  remediation: RefConnectionConditionRemediation | null;
  sensitivity: "owner" | "public" | "secret_redacted";
  severity: "blocked" | "error" | "info" | "warning";
  status: "false" | "true" | "unknown";
  type: string;
}

export interface RefConnectionHealthSnapshot {
  axes: {
    attention: RefAttentionAxis;
    coverage: RefCoverageAxis;
    freshness: RefFreshnessAxis;
    outbox: RefOutboxAxis;
    remote_surface?: RefRemoteSurfaceAxis;
  };
  badges: {
    stale: boolean;
    syncing: boolean;
  };
  conditions?: readonly RefConnectionHealthCondition[];
  dominant_condition_id?: string | null;
  last_success_at: string | null;
  /** Non-secret owner CTA, or null when no attention is required. */
  next_action: RefNextAction | null;
  next_attempt_at: string | null;
  reason_code: string | null;
  state: "blocked" | "cooling_off" | "degraded" | "healthy" | "idle" | "needs_attention" | "unknown";
  supporting_condition_ids?: readonly string[];
  unknown_reasons: readonly string[];
}

export interface WebPushConfig {
  enabled: boolean;
  object: "web_push_config";
  public_key: string | null;
  unavailable_reason: string | null;
}

export interface WebPushSubscriptionSummary {
  created_at: string;
  device_label: string | null;
  endpoint: string;
  endpoint_redacted: string | null;
  id: string;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  last_success_at: string | null;
  last_used_at: string | null;
  owner_subject_id: string;
  platform: string | null;
  revoked_at: string | null;
  updated_at: string;
  user_agent: string | null;
}

export interface ListQuery {
  client_id?: string;
  connector_id?: string;
  cursor?: string;
  grant_id?: string;
  limit?: number;
  provider_id?: string;
  q?: string;
  since?: string;
  source_id?: string;
  source_kind?: SourceObject["kind"];
  status?: string;
  until?: string;
}

export interface DatasetConnectorSummary {
  connector_id: string;
  object: "dataset_connector_summary";
  record_count: number;
}

export interface DatasetSummary {
  blob_bytes: number;
  /** When the returned summary values were produced by the reference projection, when available. */
  computed_at?: string | null;
  /** Legacy wire name; the operator console treats this as configured connections with retained records. */
  connector_count: number;
  /** Substrate ingestion bounds (when the runtime wrote the row). Not the real age of the data. */
  earliest_ingested_at: string | null;
  /** Real-world earliest timestamp pulled from record data via each stream's manifest-declared `consent_time_field`. */
  earliest_record_time: string | null;
  latest_ingested_at: string | null;
  /** Real-world latest timestamp pulled the same way. */
  latest_record_time: string | null;
  object: "dataset_summary";
  projection?: DatasetSummaryProjectionMetadata;
  record_changes_json_bytes: number;
  record_count: number;
  record_json_bytes: number;
  stream_count: number;
  top_connectors: DatasetConnectorSummary[];
  total_retained_bytes: number;
}

export interface DatasetSummaryProjectionMetadata {
  computed_at?: string | null;
  last_error?: string | null;
  rebuild_status?: "idle" | "running" | "failed";
  source_high_watermark?: string | null;
  stale_since?: string | null;
  state?: "fresh" | "refreshing" | "stale" | "rebuilding" | "failed";
}

// The reference deployment diagnostics surface. Consumed by the operator-
// facing /dashboard/deployment page. Shape matches the report returned by
// server/deployment-diagnostics.ts; the RS redacts secrets before sending,
// and the dashboard must not re-assemble them.
export interface DeploymentDiagnostics {
  database: {
    path: string;
    // Read-only physical on-disk footprint (Postgres-only). `null` on a
    // SQLite backend or when the size read fails — never a fabricated `0`.
    // Distinct from the logical retained payload (`total_retained_bytes`);
    // the console renders them as a labeled comparison and never aliases or
    // sums them. The relation sizes are an approximate composition.
    // Optional so an older server (or the sandbox specimen) that omits them
    // still parses; absence is treated as unmeasured.
    physical_bytes?: number | null;
    top_relations?: ReadonlyArray<{ name: string; bytes: number }> | null;
  };
  // Optional so older reference deployments still parse. null means unmeasured;
  // null byte fields mean the server attempted the probe but could not measure
  // the filesystem.
  disk_headroom?: {
    path: string;
    free_bytes: number | null;
    total_bytes: number | null;
  } | null;
  environment: ReadonlyArray<{
    name: string;
    value: string | null;
    provenance: "absent" | "present" | "redacted";
    secret: boolean;
  }>;
  lexical: {
    index: {
      state: "built" | "building";
      backfill_progress: {
        active_jobs: number;
        connector_id: string;
        id: string;
        indexed_rows: number;
        manifest_streams_checked: number;
        manifest_streams_total: number;
        phase: "planning" | "checking" | "rebuilding" | "cleanup";
        records_scanned: number;
        records_total: number | null;
        started_at: string;
        stream: string | null;
        updated_at: string;
      } | null;
    };
  };
  manifests: ReadonlyArray<{
    connector_id: string;
    display_name: string | null;
    provenance: "native" | "polyfill-registered";
    semantic_stream_count: number;
  }>;
  runtime_capabilities: {
    bindings: {
      browser: boolean;
      filesystem: boolean;
      local_device: boolean;
      network: boolean;
    };
    collector_paired: boolean;
    // Versions the reference server is willing to accept on ingest. Empty
    // when the diagnostics adapter could not introspect.
    accepted_collector_protocol_versions: readonly string[];
    // Per-pairing detail. Null when no collector is enrolled.
    collector_pairing: {
      // null when this device pre-dates the X-PDPP-Collector-Protocol
      // header. "legacy_unknown" carries the same idea in a typed form
      // when the device row exists but the column is empty.
      protocol_version: string | "legacy_unknown" | null;
      protocol_outdated: boolean;
      runner_version: string | null;
      connector_versions: Readonly<Record<string, string>>;
    } | null;
    in_container: boolean;
  };
  semantic: {
    backend: {
      configured: boolean;
      available: boolean;
      profile_id: string | null;
      model: string | null;
      dtype: string | null;
      dimensions: number | null;
      distance_metric: string | null;
      language_bias: { primary: string; note?: string } | null;
      model_cache_path: string | null;
      model_cache_present: boolean | null;
      download_allowed: boolean | null;
    };
    index: {
      kind: "sqlite-vec" | "blob-flat" | null;
      state: "built" | "building" | "stale" | null;
      backfill_progress: {
        active_jobs: number;
        connector_id: string;
        id: string;
        indexed_vectors: number;
        manifest_streams_checked: number;
        manifest_streams_total: number;
        phase: "planning" | "checking" | "rebuilding" | "cleanup";
        records_scanned: number;
        records_total: number | null;
        started_at: string;
        stream: string | null;
        updated_at: string;
      } | null;
    };
    participation: {
      connector_count: number;
      stream_count: number;
      field_count: number;
      tuples: ReadonlyArray<{
        connector_id: string;
        stream: string;
        field: string;
        provenance: "native" | "polyfill-registered";
      }>;
    };
  };
  warnings: ReadonlyArray<{
    code:
      | "zero_participation"
      | "lexical_building_index"
      | "building_index"
      | "stale_index"
      | "backend_unavailable"
      | "missing_model_cache"
      | "download_disabled"
      | "vector_index_fallback"
      | "browser_connectors_need_collector"
      | "collector_protocol_outdated"
      | "low_disk_headroom";
    message: string;
  }>;
}

export interface DeviceSourceInstanceOutboxDiagnostics {
  backlog_open?: number;
  dead_letter?: number;
  leased?: number;
  oldest_pending_at?: string | null;
  pending?: number;
  retrying?: number;
  stale_leases?: number;
  succeeded?: number;
  total?: number;
}

export type DeviceSourceInstanceOutboxState =
  | "backlog"
  | "dead_letter"
  | "drained"
  | "pending"
  | "retrying"
  | "stale"
  | "unknown";

export interface DeviceSourceInstance {
  accepted_record_count?: number;
  connector_id: string;
  connector_instance_id?: string | null;
  created_at: string;
  device_id: string;
  display_name?: string | null;
  last_error?: Record<string, unknown> | null;
  last_heartbeat_at?: string | null;
  last_heartbeat_status?: string | null;
  last_ingest_at?: string | null;
  local_binding_name: string;
  local_collector_gaps?: {
    last_updated_at: string | null;
    pending_count: number;
    reasons: string[];
    unreliable?: boolean;
  };
  object: "device_source_instance";
  outbox_diagnostics?: DeviceSourceInstanceOutboxDiagnostics | null;
  outbox_state?: DeviceSourceInstanceOutboxState;
  records_pending?: number | null;
  rejected_record_count?: number;
  source_instance_id: string;
}

export interface DeviceExporter {
  /**
   * Build-derived agent version the device last reported on a heartbeat (e.g.
   * `0.0.0+43f63825f01a`). Owner-only diagnostic for spotting stale-build drift;
   * `null` when the device has never reported a version.
   */
  agent_version?: string | null;
  created_at: string;
  device_id: string;
  display_name?: string | null;
  last_error?: Record<string, unknown> | null;
  last_heartbeat_at?: string | null;
  last_ingest_at?: string | null;
  object: "device_exporter";
  revoked_at?: string | null;
  source_instances: DeviceSourceInstance[];
  stale: boolean;
  status: "active" | "revoked";
  subject_id: string;
}

export interface DeviceEnrollmentCode {
  connector_id: string;
  enrollment_code: string;
  expires_at: string;
  local_binding_name: string;
  object: "device_exporter_enrollment_code";
}

export interface CreateDeviceEnrollmentCodeInput {
  connector_id: string;
  display_name?: string;
  expires_in_seconds?: number;
  local_binding_name: string;
}

export interface PendingApproval {
  approval_id: string;
  client_id?: string | null;
  created_at: string;
  grant_preview?: {
    source?: SourceObject | null;
    streams?: Array<{ name?: string } | string>;
  } | null;
  kind: "consent" | "owner_device";
  object: "approval";
  user_code?: string | null;
}

/** Operator-issued OAuth client (one per dashboard-issued bearer). */
export interface OwnerIssuedClient {
  active_token_count: number;
  client_id: string;
  client_name: string | null;
  created_at: string;
}

/**
 * Server-only helper for the reference-designated `_ref` read surfaces on
 * the PDPP authorization server. These are inspection endpoints, not part
 * of the public PDPP contract, and the dashboard is one of two consumers
 * (CLI is the other).
 *
 * Server-only: do not import from client components.
 */
import { isOwnerSessionRequiredBody } from "./auth-errors.ts";
import { redirectToOwnerLogin } from "./login-redirect.ts";
import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "./owner-token.ts";
import { verifyDashboardSession } from "./verify-session.ts";

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

interface TimelinePageOptions {
  cursor?: string | null;
}

/**
 * The reference server returns timeline envelopes as
 * `{ object, <id_key>: <id_value>, trace_id, event_count, data: [...] }`
 * where `data` carries the events. The dashboard and CLI both predate a
 * unified name, so we normalize here for the web UI without changing the
 * server contract.
 */
function normalizeTimeline(raw: unknown): TimelineEnvelope {
  const r = (raw || {}) as {
    object?: string;
    trace_id?: string | null;
    event_count?: number;
    data?: SpineEvent[];
    events?: SpineEvent[];
    next_cursor?: unknown;
    truncated?: unknown;
  };
  let events: SpineEvent[] = [];
  if (Array.isArray(r.events)) {
    events = r.events;
  } else if (Array.isArray(r.data)) {
    events = r.data;
  }
  return {
    object: r.object ?? "timeline",
    trace_id: r.trace_id ?? null,
    event_count: typeof r.event_count === "number" ? r.event_count : events.length,
    events,
    next_cursor: typeof r.next_cursor === "string" && r.next_cursor.length > 0 ? r.next_cursor : undefined,
    truncated: r.truncated === true,
  };
}

function withTimelinePage(path: string, options: TimelinePageOptions = {}): string {
  if (!options.cursor) {
    return path;
  }
  const params = new URLSearchParams({ cursor: options.cursor });
  return `${path}?${params.toString()}`;
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
  schedule: RefSchedule | null;
  streams: string[];
  stream_count?: number;
  retained_bytes?: RefRetainedBytesBreakdown | null;
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
  owner_action: "act_elsewhere" | "operate_attachment" | "provide_value" | null;
  reason_code: string | null;
  response_contract: "response_required" | "none" | null;
  source: "none" | "schedule_fallback" | "structured";
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
  id: string;
  type: string;
  status: "false" | "true" | "unknown";
  severity: "blocked" | "error" | "info" | "warning";
  reason: string;
  message: string;
  origin: string;
  observed_at: string | null;
  expires_at: string | null;
  current?: boolean;
  sensitivity: "owner" | "public" | "secret_redacted";
  remediation: RefConnectionConditionRemediation | null;
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
  supporting_condition_ids?: readonly string[];
  last_success_at: string | null;
  /** Non-secret owner CTA, or null when no attention is required. */
  next_action: RefNextAction | null;
  next_attempt_at: string | null;
  reason_code: string | null;
  state: "blocked" | "cooling_off" | "degraded" | "healthy" | "idle" | "needs_attention" | "unknown";
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

class RefNotFoundError extends Error {
  readonly status = 404;
}

async function refFetch(path: string, params?: Record<string, string | number | undefined>, init: RequestInit = {}) {
  // DAL gate: verify owner session before any AS read. The proxy already
  // redirects unauthenticated browser navigations; this catches programmatic
  // / proxy-bypass paths (CVE-2025-29927 class) before any data leaves the AS.
  await verifyDashboardSession();

  const url = new URL(`${getAsInternalUrl()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  let res: Response;
  try {
    res = await fetch(
      url.toString(),
      await withOwnerSessionCookie({
        cache: "no-store",
        ...init,
        headers: init.headers,
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err);
  }
  if (res.status === 404) {
    throw new RefNotFoundError(`not found: ${path}`);
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 && isOwnerSessionRequiredBody(body)) {
      await redirectToOwnerLogin();
    }
    throw new Error(`_ref ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

export { RefNotFoundError };

export async function getTraceTimeline(
  traceId: string,
  options?: TimelinePageOptions
): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(await refFetch(withTimelinePage(`/_ref/traces/${encodeURIComponent(traceId)}`, options)));
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

export async function getGrantTimeline(
  grantId: string,
  options?: TimelinePageOptions
): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(
      await refFetch(withTimelinePage(`/_ref/grants/${encodeURIComponent(grantId)}/timeline`, options))
    );
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

export async function getRunTimeline(runId: string, options?: TimelinePageOptions): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(
      await refFetch(withTimelinePage(`/_ref/runs/${encodeURIComponent(runId)}/timeline`, options))
    );
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
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

export async function listTraces(opts: ListQuery = {}): Promise<ListResponse<TraceSummary>> {
  return (await refFetch(
    "/_ref/traces",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<TraceSummary>;
}

export async function listGrants(opts: ListQuery = {}): Promise<ListResponse<GrantSummary>> {
  return (await refFetch(
    "/_ref/grants",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<GrantSummary>;
}

export async function listRuns(opts: ListQuery = {}): Promise<ListResponse<RunSummary>> {
  return (await refFetch(
    "/_ref/runs",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<RunSummary>;
}

export async function getWebPushConfig(): Promise<WebPushConfig> {
  return (await refFetch("/_ref/web-push/config")) as WebPushConfig;
}

export async function listWebPushSubscriptions(): Promise<ListResponse<WebPushSubscriptionSummary>> {
  return (await refFetch("/_ref/web-push/subscriptions")) as ListResponse<WebPushSubscriptionSummary>;
}

export async function listConnectorSummaries(): Promise<ListResponse<RefConnectorSummary>> {
  return (await refFetch("/_ref/connectors")) as ListResponse<RefConnectorSummary>;
}

export async function listSchedules(): Promise<ListResponse<RefSchedule>> {
  return (await refFetch("/_ref/schedules")) as ListResponse<RefSchedule>;
}

export async function getConnectorSchedule(
  connectorId: string,
  options: { connectorInstanceId?: string | null } = {}
): Promise<RefSchedule | null> {
  try {
    const path = options.connectorInstanceId
      ? `/_ref/connections/${encodeURIComponent(options.connectorInstanceId)}/schedule`
      : `/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`;
    return (await refFetch(path)) as RefSchedule;
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
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

export async function getDatasetSummary(): Promise<DatasetSummary> {
  return (await refFetch("/_ref/dataset/summary")) as DatasetSummary;
}

// The reference deployment diagnostics surface. Consumed by the operator-
// facing /dashboard/deployment page. Shape matches the report returned by
// server/deployment-diagnostics.ts; the RS redacts secrets before sending,
// and the dashboard must not re-assemble them.
export interface DeploymentDiagnostics {
  database: { path: string };
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
      | "collector_protocol_outdated";
    message: string;
  }>;
}

export async function getDeploymentDiagnostics(): Promise<DeploymentDiagnostics> {
  return (await refFetch("/_ref/deployment")) as DeploymentDiagnostics;
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

export async function createDeviceEnrollmentCode(
  input: CreateDeviceEnrollmentCodeInput
): Promise<DeviceEnrollmentCode> {
  return (await refFetch("/_ref/device-exporters/enrollment-codes", undefined, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  })) as DeviceEnrollmentCode;
}

export async function listDeviceExporters(): Promise<ListResponse<DeviceExporter>> {
  return (await refFetch("/_ref/device-exporters")) as ListResponse<DeviceExporter>;
}

export async function listDeviceExporterSourceInstances(
  opts: { connector_instance_id?: string; device_id?: string } = {}
): Promise<ListResponse<DeviceSourceInstance>> {
  return (await refFetch(
    "/_ref/device-exporters/source-instances",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<DeviceSourceInstance>;
}

export async function listDeviceExporterDiagnostics(): Promise<ListResponse<DeviceExporter>> {
  return (await refFetch("/_ref/device-exporters/diagnostics")) as ListResponse<DeviceExporter>;
}

export async function revokeDeviceExporter(deviceId: string): Promise<{
  device_id: string;
  object: "device_exporter_revocation";
  revoked_at: string;
}> {
  return (await refFetch(`/_ref/device-exporters/${encodeURIComponent(deviceId)}/revoke`, undefined, {
    method: "POST",
  })) as {
    device_id: string;
    object: "device_exporter_revocation";
    revoked_at: string;
  };
}

export async function refSearch(query: string): Promise<{
  object: "search_result";
  traces: TraceSummary[];
  grants: GrantSummary[];
  runs: RunSummary[];
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
}> {
  return (await refFetch("/_ref/search", { q: query })) as {
    object: "search_result";
    traces: TraceSummary[];
    grants: GrantSummary[];
    runs: RunSummary[];
    exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  };
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

export async function listPendingApprovals(): Promise<ListResponse<PendingApproval>> {
  return (await refFetch("/_ref/approvals")) as ListResponse<PendingApproval>;
}

/** Operator-issued OAuth client (one per dashboard-issued bearer). */
export interface OwnerIssuedClient {
  active_token_count: number;
  client_id: string;
  client_name: string | null;
  created_at: string;
}

/**
 * Operator-scoped listing of dynamic clients the dashboard registered for the
 * signed-in operator (one per issued owner self-export bearer). Backs the
 * Tokens page list + Revoke UX.
 *
 * Spec: openspec/changes/dcr-per-owner-token-with-revoke/specs/
 *       reference-implementation-architecture/spec.md
 */
export async function listOwnerIssuedClients(): Promise<ListResponse<OwnerIssuedClient>> {
  return (await refFetch("/_ref/clients", { owner: "true" })) as ListResponse<OwnerIssuedClient>;
}

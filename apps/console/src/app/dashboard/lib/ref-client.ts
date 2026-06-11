/**
 * Server-only helper for the reference-designated `_ref` read surfaces on
 * the PDPP authorization server. These are inspection endpoints, not part
 * of the public PDPP contract, and the dashboard is one of two consumers
 * (CLI is the other).
 *
 * Server-only: do not import from client components.
 */
import { isOwnerSessionRequiredBody } from "./auth-errors.ts";
import { describeErrorText } from "./describe-error.ts";
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
  /**
   * Run-timeline only: the run's window-independent terminal status,
   * resolved server-side from the most-recent terminal spine event. The
   * authoritative active/terminal signal for the run detail surface —
   * unlike scanning `events` (a single page), this is the same value on
   * any page. `null` means the run has no terminal event (still active);
   * absent for trace/grant timelines.
   */
  terminal_status?: "completed" | "failed" | "cancelled" | "abandoned" | null;
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
    terminal_status?: unknown;
    truncated?: unknown;
  };
  let events: SpineEvent[] = [];
  if (Array.isArray(r.events)) {
    events = r.events;
  } else if (Array.isArray(r.data)) {
    events = r.data;
  }
  const terminalStatus =
    r.terminal_status === "completed" ||
    r.terminal_status === "failed" ||
    r.terminal_status === "cancelled" ||
    r.terminal_status === "abandoned"
      ? r.terminal_status
      : null;
  return {
    object: r.object ?? "timeline",
    trace_id: r.trace_id ?? null,
    event_count: typeof r.event_count === "number" ? r.event_count : events.length,
    events,
    next_cursor: typeof r.next_cursor === "string" && r.next_cursor.length > 0 ? r.next_cursor : undefined,
    terminal_status: terminalStatus,
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
  /**
   * Parent grant-package id when this row's binding token is a hosted-
   * MCP package token. Optional; absent for non-package grants. Pivot
   * link target for the operator console.
   */
  grant_package_id?: string | null;
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
  /**
   * Connection-level rollup of the per-source outbox diagnostics the
   * device reports on heartbeats, summed across this connection's trusted
   * sources. `null` (or absent) when no trusted source reported counts.
   * Mirrors `LocalDeviceProgress.outbox_counts` in `ref-control.ts`. Carries
   * only non-negative integers and an optional ISO timestamp.
   */
  outbox_counts?: DeviceSourceInstanceOutboxDiagnostics | null;
  records_pending: number | null;
  source_count: number;
}

export interface RefRetainedBytesBreakdown {
  blob_bytes: number;
  record_changes_json_bytes: number;
  record_json_bytes: number;
  total_bytes: number;
}

export type RefRecordVersionRisk = "high" | "normal" | "watch";

/**
 * Reference-DERIVED disposition explaining why a churn row's retained history
 * exists. Computed server-side from reference-controlled signals — a connector
 * cannot set or override it. Only `active_defect_or_unclassified` counts toward
 * an operator "needs review" signal. A label only: it never alters risk.
 */
export type RefRecordVersionDisposition =
  | "active_defect_or_unclassified"
  | "reviewed_historical_residue"
  | "point_in_time_retained_history"
  | "lossless_compaction_candidate"
  | "recurring_point_in_time_snapshot";

/**
 * Reference-DERIVED remediation: the operator's available next action for a
 * churn row's retained history. Orthogonal to `version_disposition` (which says
 * why the history exists). Computed server-side from the row's disposition plus
 * reference-controlled stream lists — a connector cannot set or override it. A
 * label only: it never alters risk or disposition. `none` means this surface
 * offers no further action (the history is already minimal, an actionable
 * compaction candidate whose command is shown, or expected recurring history
 * with no pending owner decision) — not that the history is absent.
 */
export type RefRecordVersionRemediation =
  | "none"
  | "content_fingerprint_pending"
  | "owner_migration_pending"
  | "owner_retention_policy";

export interface RefRecordVersionStatsRow {
  connector_id: string | null;
  connector_instance_id: string;
  current_record_count: number;
  display_name: string | null;
  last_current_at: string | null;
  last_history_at: string | null;
  projection_authority: "record_changes_ground_truth" | "retained_size_projection";
  projection_dirty: boolean;
  projection_missing: boolean;
  record_history_count: number;
  record_key_count: number | null;
  risk_level: RefRecordVersionRisk;
  risk_reasons: string[];
  stream: string;
  version_disposition: RefRecordVersionDisposition;
  version_remediation: RefRecordVersionRemediation;
  versions_per_record: number;
}

export interface RefRecordVersionStatsEnvelope {
  data: RefRecordVersionStatsRow[];
  meta: {
    /** Normative assertion that disposition never alters the risk thresholds. */
    disposition_affects_thresholds: false;
    /** Normative assertion that remediation never alters the risk thresholds. */
    remediation_affects_thresholds: false;
    filters: {
      connector_instance_id: string | null;
      risk: RefRecordVersionRisk | null;
      stream: string | null;
    };
    has_more: boolean;
    limit: number;
    risk_thresholds: {
      high_history_count: number;
      high_history_versions_per_record: number;
      high_versions_per_record: number;
      watch_versions_per_record: number;
    };
    returned: number;
    source: "retained_size_projection_with_record_changes_ground_truth";
    total_matching: number;
  };
  object: "ref_record_version_stats";
  projection: {
    computed_at: string | null;
    dirty: boolean;
    metadata: Record<string, unknown> | null;
  };
}

/**
 * One derived per-stream entry on the owner/control-plane Collection Report
 * (`define-connector-progress-evidence-contract`, Tranche C). Mirrors the
 * reference's `CollectionReportEntry`, derived on read from the latest run's
 * runtime `collection_facts` block plus the connection's freshness / refresh /
 * attention evidence. Owner/control-plane surface only — never on `/v1`.
 *
 * The honesty contract the console MUST preserve: `considered` is `"unknown"`
 * when the connector declared no denominator, and a stream with an unknown
 * considered denominator reads `coverage_condition: "unknown"`, never
 * `"complete"`. `collected` is the raw run-local count, never a verdict. When
 * the reference supplies `covered`, it is the accounted-for numerator
 * (emitted plus suppressed-unchanged), not another collected count.
 */
export interface RefCollectionReportEntry {
  /** Committed-checkpoint status from the runtime fact block, or `"unknown"`. */
  checkpoint: string;
  /** Raw per-stream collected count from the runtime fact block (never a verdict). */
  collected: number;
  /** Known considered denominator, or `"unknown"` when the connector declared none. */
  considered: number | "unknown";
  /** Derived coverage condition, from the same vocabulary as the coverage axis. */
  coverage_condition: RefCoverageAxis;
  /** Known accounted-for numerator, or `"unknown"` when the connector declared none. */
  covered?: number | "unknown";
  /** Derived forward disposition (what the next run is expected to do on this stream). */
  forward_disposition: RefForwardDisposition;
  /** Count of pending recoverable detail gaps for this stream. */
  pending_detail_gaps: number;
  /** The runtime `SKIP_RESULT` fact for this stream, or `null`. */
  skipped: { reason: string; recovery_action?: string } | null;
  stream: string;
}

export interface RefConnectorSummary {
  /**
   * Per-stream Collection Report derived on read by the reference
   * (`define-connector-progress-evidence-contract`). Optional on the mirror:
   * a reference predating the field omits it and the console renders nothing
   * per stream rather than inventing progress. Forwarded opaquely through
   * `GET /_ref/connectors`; never exposed on grant-scoped `/v1`.
   */
  collection_report?: readonly RefCollectionReportEntry[];
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
  /** Durable connector-instance lifecycle state. Revoked rows remain owner-visible. */
  revoked_at?: string | null;
  schedule: RefSchedule | null;
  status?: string | null;
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

/**
 * Connection-level forward disposition mirror — the reference's answer to
 * "what is the next run expected to do?" (`ForwardDisposition` in the reference
 * runtime's `connection-health.ts`, defined by
 * `define-connector-progress-evidence-contract`). It is a fusion of the coverage,
 * gap-retryability, attention, freshness, and refresh-policy evidence, not a
 * sixth axis: it answers what the next run does, distinct from current state,
 * coverage, freshness, and outbox.
 */
export type RefForwardDisposition = "awaiting_owner" | "complete" | "owner_refresh_due" | "resumable" | "terminal";

export type RefOutboxAxis = "active" | "idle" | "stalled" | "unknown";

/**
 * Source-pressure detail-gap backlog rollup mirror — the reference's additive,
 * nullable `connection_health.detail_gap_backlog` (`DetailGapBacklog` in the
 * runtime's `connection-health.ts`, defined by
 * `surface-source-pressure-detail-gap-backlog`). It is owner-only diagnostic
 * scale for retryable *source-pressure* detail gaps; it never changes the
 * headline `state`, the coverage/freshness/attention axes, the
 * `forward_disposition`, or `next_action`.
 *
 * Honesty contract the console MUST respect (it does not re-derive any of this):
 *   - The whole object is `null` only when the durable gap evidence could not be
 *     read. A readable-but-empty backlog is a real `0` pending — a surface must
 *     be able to tell "drained" from "unmeasured" and never invent a count.
 *   - `pending` counts only pending source-pressure gaps.
 *   - `pending_is_floor` is `true` when the durable read was bounded and hit the
 *     bound, so `pending` is a floor ("at least N"), never an exact total.
 *   - `pending_other` counts pending non-source-pressure detail gaps from the
 *     same bounded read. It prevents source-pressure catch-up copy from saying
 *     "caught up" while budget/cap-deferred gaps remain.
 *   - `recovered` is `null` when no count-by-status aggregate was available (the
 *     first projection tranche always leaves it `null`); never fabricated.
 *   - `next_attempt_at` is the backlog's retry floor (Retry-After / cooldown). It
 *     can be set for a manual connector even when the connection-level
 *     `next_attempt_at` (the scheduler's next automatic dispatch) is `null`, so a
 *     surface must show it as a resume floor, not a promise of completion.
 */
export interface RefDetailGapBacklog {
  max_attempt_count: number;
  next_attempt_at: string | null;
  pending: number;
  pending_is_floor: boolean;
  pending_other?: number;
  pending_other_is_floor?: boolean;
  recovered: number | null;
}

/**
 * The adaptive collection rate controller's last-known state, surfaced so an
 * operator can see the adaptation (the way Stripe shows rate-limit headroom).
 * Additive and nullable on the snapshot: a reference predating the field omits
 * it, and the console renders an explicit unknown rather than inventing a rate.
 * Derived by the reference from the connector's `collection_rate` run-trace
 * progress events.
 */
export interface RefCollectionRateSnapshot {
  /** The rate ceiling: fastest interval (ms) the probe never crosses. */
  ceiling_interval_ms: number;
  /** Effective ceiling rate (requests/min). */
  ceiling_rate_per_min: number;
  /** Current learned inter-request interval (ms). */
  current_interval_ms: number;
  /** Current effective rate (requests/min). */
  effective_rate_per_min: number;
  /** Most recent back-off, or null when none. */
  last_backoff: { at?: string | null; at_interval_ms: number; reason: string } | null;
}

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
  /**
   * Additive, nullable adaptive collection rate controller state
   * ({@link RefCollectionRateSnapshot}). `null`/omitted when the reference did not
   * surface controller state (e.g. a reference predating the field); the console
   * then renders an explicit unknown, never a false zero or green.
   */
  collection_rate?: RefCollectionRateSnapshot | null;
  conditions?: readonly RefConnectionHealthCondition[];
  /**
   * Additive, nullable source-pressure detail-gap backlog rollup
   * ({@link RefDetailGapBacklog}). `null` when no backlog evidence was supplied
   * or the durable gap store was unreadable; a readable-but-drained backlog is a
   * real `0` pending count.
   *
   * Optional on the mirror because it is an additive field on the reference's
   * `connection_health` snapshot (passed through `GET /_ref/connectors`); a
   * reference predating the field omits it and the console renders no backlog cue
   * rather than inventing a count.
   */
  detail_gap_backlog?: RefDetailGapBacklog | null;
  dominant_condition_id?: string | null;
  /**
   * Connection-level forward disposition: the reference's single answer to
   * "what is the next run expected to do?", rolled up from the coverage,
   * gap-retryability, open-attention, freshness, and refresh-policy evidence the
   * snapshot already carries (`define-connector-progress-evidence-contract`).
   *
   * Optional on the mirror because it is an additive field surfaced on the
   * reference's `connection_health` snapshot (passed through `GET /_ref/connectors`
   * as the canonical projection); a reference predating the field omits it and the
   * console renders nothing rather than inventing a disposition.
   */
  forward_disposition?: RefForwardDisposition;
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

class RefNotFoundError extends Error {
  readonly status = 404;
}

class RefRequestError extends Error {
  readonly bodyText: string;
  readonly status: number;

  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.name = "RefRequestError";
    this.status = status;
    this.bodyText = bodyText;
  }
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
    // Surface the reference server's envelope message (`error.message`) rather
    // than the raw JSON body: this Error.message is shown verbatim to operators
    // in action banners (e.g. the event-subscription disable affordance), where
    // a stringified `{"error":{...}}` blob reads as a crash, not a reason.
    throw new RefRequestError(describeErrorText(body, `_ref ${path} failed (${res.status})`), res.status, body);
  }
  return res.json();
}

export { RefNotFoundError, RefRequestError };

// Thrown when the owner-session static-secret capture route rejects a credential
// at the synchronous validation moment (HTTP 400, code
// `static_secret_credential_rejected`). The message is the provider-named,
// owner-causal reason; nothing was stored. The Console action catches this to
// keep the owner on the form with their non-secret context preserved, rather
// than redirecting to a setup-status page for a connection that never started a
// run.
export class StaticSecretValidationError extends Error {
  readonly code = "static_secret_credential_rejected";
  constructor(message: string) {
    super(message);
    this.name = "StaticSecretValidationError";
  }
}

function isCredentialRejectionBody(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } | string };
    const code = typeof parsed.error === "object" && parsed.error ? parsed.error.code : parsed.error;
    return code === "static_secret_credential_rejected";
  } catch {
    return false;
  }
}

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

export async function listConnectorSummaries(
  options: { connectionRouteId?: string } = {}
): Promise<ListResponse<RefConnectorSummary>> {
  // When a record subpage knows the connection it wants, pass the route id so
  // the reference projects only that one connection (a 0-or-1 list) instead of
  // running the per-connection fan-out for every configured connection. Unscoped
  // callers (records index, schedules, grant request) omit it and get the full
  // list exactly as before.
  return (await refFetch("/_ref/connectors", {
    connection: options.connectionRouteId,
  })) as ListResponse<RefConnectorSummary>;
}

export async function listRecordVersionStats(
  opts: { connectorInstanceId?: string; limit?: number; risk?: RefRecordVersionRisk; stream?: string } = {}
): Promise<RefRecordVersionStatsEnvelope> {
  return (await refFetch("/_ref/records/version-stats", {
    connector_instance_id: opts.connectorInstanceId,
    limit: opts.limit,
    risk: opts.risk,
    stream: opts.stream,
  })) as RefRecordVersionStatsEnvelope;
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
  database: {
    path: string;
    // Read-only physical on-disk footprint (Postgres-only). `null` on a
    // SQLite backend or when the size read fails — never a fabricated `0`.
    // Distinct from the logical retained payload (`total_retained_bytes`);
    // rendered as a labeled comparison, never aliased or summed. Optional so
    // a server that omits them still parses; absence is unmeasured.
    physical_bytes?: number | null;
    top_relations?: ReadonlyArray<{ name: string; bytes: number }> | null;
  };
  // Ordered filesystem entries: data dir first, Postgres data mount second
  // (when a distinct volume). Empty array when all probes failed or no probes
  // ran. mount_label is set when more than one distinct FS is reported
  // ("data", "postgres"). Optional for backward compat with older servers
  // that returned a singular object — callers should use `disk_headroom ?? []`.
  disk_headroom?: ReadonlyArray<{
    path: string;
    free_bytes: number | null;
    total_bytes: number | null;
    mount_label?: string;
  }>;
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

export interface StaticSecretDraftConnection {
  connection_id: string;
  connector_id: string;
  connector_instance_id: string;
  credential_kind: string;
  next_step: {
    kind: "capture_static_secret_credential";
    method: "POST";
    reason?: string;
    url: string;
  };
  object: "static_secret_draft_connection";
  status: "draft";
}

export interface StaticSecretCredentialCapture {
  connection_id: string;
  connector_id: string;
  connector_instance_id: string;
  credential: {
    captured_at: string | null;
    credential_kind: string | null;
    fingerprint: string | null;
    present: boolean;
    revoked_at: string | null;
    rotated_at: string | null;
    status: string | null;
  };
  // Non-secret account identity from a synchronous credential probe ("Connected
  // as {identity}"). Null when the connector has no probe (first-sync path).
  identity: { account_identity: string; detail: string | null } | null;
  next_step: {
    kind: "run_connection";
    method: "POST";
    reason?: string;
    url: string;
  };
  object: "static_secret_credential_capture";
  validation: "first_sync" | "synchronous";
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

export interface StaticSecretSetupField {
  autocomplete: string | null;
  description: string | null;
  help_text: string | null;
  help_url: string | null;
  identity: boolean;
  label: string;
  name: string;
  placeholder: string | null;
  required: boolean;
  secret: boolean;
  type: "email" | "password" | "text";
}

export interface StaticSecretSetup {
  connector_id: string;
  credential_capture: {
    description: string | null;
    fields: StaticSecretSetupField[];
    kind: string;
    label: string;
    submit_label: string | null;
  };
  credential_kind: string;
  deployment_readiness: {
    blockers: Array<{ key: string; label: string; secret: boolean }>;
    guidance: string | null;
    state: "needs_config" | "ready";
  };
  display_name: string;
  object: "static_secret_setup";
  // Whether the credential is validated synchronously at capture (the route
  // probes the secret and echoes the account identity before storing) or only
  // at first sync. Drives the form's validate-then-redirect flow with no
  // connector-specific branch.
  validation: "first_sync" | "synchronous";
}

export async function getStaticSecretSetup(connectorId: string): Promise<StaticSecretSetup> {
  return (await refFetch(
    `/_ref/connectors/${encodeURIComponent(connectorId)}/static-secret-setup`
  )) as StaticSecretSetup;
}

export async function createStaticSecretDraftConnection(
  connectorId: string,
  setupFields: Record<string, string>
): Promise<StaticSecretDraftConnection> {
  return (await refFetch(`/_ref/connectors/${encodeURIComponent(connectorId)}/draft-connection`, undefined, {
    body: JSON.stringify({ setup_fields: setupFields }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })) as StaticSecretDraftConnection;
}

export async function captureStaticSecretCredential(input: {
  connectionId: string;
  credentialKind: string;
  secret: string;
}): Promise<StaticSecretCredentialCapture> {
  try {
    return (await refFetch(
      `/_ref/connections/${encodeURIComponent(input.connectionId)}/static-secret-credential`,
      undefined,
      {
        body: JSON.stringify({
          credential_kind: input.credentialKind,
          secret: input.secret,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    )) as StaticSecretCredentialCapture;
  } catch (err) {
    // A synchronous validation rejection (400 static_secret_credential_rejected)
    // becomes a typed error so the action keeps the owner on the form. The
    // message is the provider-named, owner-causal reason from the route.
    if (err instanceof RefRequestError && err.status === 400 && isCredentialRejectionBody(err.bodyText)) {
      throw new StaticSecretValidationError(err.message);
    }
    throw err;
  }
}

// Owner-facing static-secret setup lifecycle. Projected from the connection's
// real status, non-secret credential metadata, and current/last run — never an
// onboarding-only enum. `setup_state` maps onto the canonical connection-health
// vocabulary the rest of the dashboard uses.
export type StaticSecretSetupStateValue =
  | "active"
  | "awaiting_credential"
  | "first_sync_failed"
  | "first_sync_pending"
  | "first_sync_running"
  | "paused"
  | "revoked"
  | "unknown";

export interface StaticSecretSetupStatus {
  account_identity: string | null;
  connection_id: string;
  connector_id: string;
  created_at: string | null;
  credential: {
    captured_at: string | null;
    credential_kind: string | null;
    present: boolean;
  };
  display_name: string | null;
  health_state: string;
  last_error: {
    reason: string;
    remediation: string;
  } | null;
  object: "static_secret_setup_status";
  pending: boolean;
  run: {
    finished_at: string | null;
    run_id: string | null;
    started_at: string | null;
    status: string | null;
  } | null;
  running: boolean;
  setup_state: StaticSecretSetupStateValue;
  status: string;
  updated_at: string | null;
}

export async function getStaticSecretSetupStatus(
  connectionId: string,
  runId?: string | null
): Promise<StaticSecretSetupStatus> {
  const suffix = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  return (await refFetch(
    `/_ref/connections/${encodeURIComponent(connectionId)}/setup-status${suffix}`
  )) as StaticSecretSetupStatus;
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

export interface CimdClientDocument {
  client_id: string;
  client_name: string | null;
  created_at: string;
  document_id: string;
  logo_uri: string | null;
  object: "cimd_client_metadata_document";
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  updated_at: string;
}

export interface CreateCimdClientDocumentInput {
  clientName?: string | null;
  logoUri?: string | null;
  redirectUris: string[];
}

export async function listCimdClientDocuments(): Promise<ListResponse<CimdClientDocument>> {
  return (await refFetch("/_ref/cimd-client-documents")) as ListResponse<CimdClientDocument>;
}

export async function createCimdClientDocument(input: CreateCimdClientDocumentInput): Promise<CimdClientDocument> {
  return (await refFetch("/_ref/cimd-client-documents", undefined, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  })) as CimdClientDocument;
}

export async function deleteCimdClientDocument(documentId: string): Promise<{
  client_id: string;
  deleted: true;
  document_id: string;
  object: "cimd_client_metadata_document_deletion";
}> {
  return (await refFetch(`/_ref/cimd-client-documents/${encodeURIComponent(documentId)}`, undefined, {
    method: "DELETE",
  })) as {
    client_id: string;
    deleted: true;
    document_id: string;
    object: "cimd_client_metadata_document_deletion";
  };
}

// ---------------------------------------------------------------------------
// Client event subscriptions — operator oversight surface
//
// Spec: openspec/changes/add-client-event-subscription-management/specs/
//       reference-implementation-architecture/spec.md
// ---------------------------------------------------------------------------

export type ClientEventSubscriptionStatus =
  | "pending_verification"
  | "active"
  | "disabled"
  | "disabled_failure"
  | "disabled_revoked"
  | "deleted";

export interface ClientEventSubscriptionSummary {
  callback_host: string;
  client_id: string;
  created_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
  final_failure_count: number;
  grant_id: string;
  last_attempt_ok: boolean | null;
  last_attempt_status_code: number | null;
  last_attempted_at: string | null;
  pending_queue_count: number;
  status: ClientEventSubscriptionStatus;
  subscription_id: string;
  updated_at: string;
}

export interface ClientEventSubscriptionAttempt {
  attempt_id: number;
  attempted_at: string;
  error: string | null;
  event_id: string;
  event_type: string;
  latency_ms: number | null;
  ok: boolean;
  queue_id: number;
  response_snippet: string | null;
  status_code: number | null;
}

export interface ClientEventSubscriptionDetail extends ClientEventSubscriptionSummary {
  callback_url: string;
  recent_attempts: ClientEventSubscriptionAttempt[];
  scope: { source?: unknown; streams?: Array<{ name: string }> } | null;
  subject_id: string;
}

export interface ListClientEventSubscriptionsQuery {
  client_id?: string;
  grant_id?: string;
  status?: ClientEventSubscriptionStatus | string;
}

export async function listClientEventSubscriptions(
  opts: ListClientEventSubscriptionsQuery = {}
): Promise<ListResponse<ClientEventSubscriptionSummary>> {
  return (await refFetch(
    "/_ref/event-subscriptions",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<ClientEventSubscriptionSummary>;
}

export async function getClientEventSubscription(
  subscriptionId: string
): Promise<ClientEventSubscriptionDetail | null> {
  try {
    return (await refFetch(
      `/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}`
    )) as ClientEventSubscriptionDetail;
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

export async function disableClientEventSubscription(
  subscriptionId: string,
  reason?: string | null
): Promise<ClientEventSubscriptionDetail> {
  return (await refFetch(`/_ref/event-subscriptions/${encodeURIComponent(subscriptionId)}/disable`, undefined, {
    body: JSON.stringify(reason ? { reason } : {}),
    headers: { "content-type": "application/json" },
    method: "POST",
  })) as ClientEventSubscriptionDetail;
}

/**
 * Owner-facing grant-package summary used by the dashboard list view.
 * Mirrors the `_ref/grant-packages` envelope. Never carries secret
 * material — the underlying storage does not expose token bytes through
 * this surface.
 */
export interface GrantPackageSummary {
  approved_at: string | null;
  client_id: string;
  created_at: string;
  member_count: number;
  object: "grant_package_summary";
  package_id: string;
  parent_package_id: string | null;
  revoked_at: string | null;
  status: string;
  subject_id: string;
}

export interface GrantPackageChild {
  added_at: string;
  grant_id: string;
  grant_status: string;
  member_status: string;
  object: "grant_package_child";
  revoked_at: string | null;
  source: { kind?: string; id?: string; connector_id?: string; connection_id?: string | null } | null;
}

export interface GrantPackageDetail {
  approved_at: string | null;
  children: GrantPackageChild[];
  client_id: string;
  created_at: string;
  member_count: number;
  object: "grant_package";
  package_id: string;
  parent_package_id: string | null;
  revoked_at: string | null;
  scenario_id: string | null;
  status: string;
  subject_id: string;
  trace_id: string | null;
}

/**
 * Cumulative per-client view across one client's lineage of incremental
 * add-source packages linked by `parent_package_id`. Reference-experimental.
 * Lineage is grouping/audit metadata only — every child grant remains
 * independently revocable.
 */
export interface CumulativeClientPackage {
  approved_at: string | null;
  created_at: string;
  member_count: number;
  object: "grant_package_lineage_member";
  package_id: string;
  parent_package_id: string | null;
  revoked_at: string | null;
  status: string;
}

export interface CumulativeClientChild {
  added_at: string;
  grant_id: string;
  grant_status: string;
  member_status: string;
  object: "grant_package_child";
  package_id: string;
  revoked_at: string | null;
  source: { kind?: string; id?: string; connector_id?: string; connection_id?: string | null } | null;
}

export interface CumulativeClientAccess {
  active_child_count: number;
  children: CumulativeClientChild[];
  client_id: string;
  experimental: string;
  object: "grant_package_cumulative_view";
  package_count: number;
  packages: CumulativeClientPackage[];
  root_package_id: string;
  subject_id: string;
}

export interface GrantPackageRevokeResult {
  not_revoked_child_count: number;
  not_revoked_child_grants: {
    error: {
      code: string;
      message: string;
    };
    grant_id: string;
  }[];
  object: "grant_package_revoke_result";
  package_id: string;
  revoked_at: string | null;
  revoked_child_count: number;
  revoked_child_grants: string[];
  status: string;
}

export class GrantPackageRevokePartialFailureError extends Error {
  readonly result: GrantPackageRevokeResult;

  constructor(result: GrantPackageRevokeResult) {
    super(formatGrantPackageRevokePartialFailure(result));
    this.name = "GrantPackageRevokePartialFailureError";
    this.result = result;
  }
}

function parseGrantPackageRevokeResult(bodyText: string): GrantPackageRevokeResult | null {
  try {
    const parsed = JSON.parse(bodyText) as Partial<GrantPackageRevokeResult>;
    if (parsed.object !== "grant_package_revoke_result" || parsed.status !== "partial_failure") {
      return null;
    }
    return parsed as GrantPackageRevokeResult;
  } catch {
    return null;
  }
}

function formatGrantPackageRevokePartialFailure(result: GrantPackageRevokeResult): string {
  const failed = result.not_revoked_child_grants.map((entry) => `${entry.grant_id} (${entry.error.code})`).join(", ");
  const failedSummary = failed || "unknown child grant";
  return `Partial revoke: ${result.revoked_child_count} child grant(s) revoked; ${result.not_revoked_child_count} not revoked: ${failedSummary}. Package remains active.`;
}

export async function listGrantPackages(): Promise<ListResponse<GrantPackageSummary>> {
  return (await refFetch("/_ref/grant-packages")) as ListResponse<GrantPackageSummary>;
}

/**
 * Find a grant's parent package id, if any. Issues a narrow `_ref/grants?q=…`
 * read and inspects the resulting row. Returns null when no matching row
 * exists or the row is not package-bound.
 *
 * Used by the grant detail page to render the package pivot affordance
 * without minting a dedicated lookup endpoint.
 */
export async function lookupGrantPackageIdForGrant(grantId: string): Promise<string | null> {
  if (!grantId) {
    return null;
  }
  try {
    const page = await listGrants({ q: grantId, limit: 5 });
    for (const row of page.data) {
      if (row.grant_id === grantId && typeof row.grant_package_id === "string" && row.grant_package_id.length > 0) {
        return row.grant_package_id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function getGrantPackage(packageId: string): Promise<GrantPackageDetail | null> {
  try {
    return (await refFetch(`/_ref/grant-packages/${encodeURIComponent(packageId)}`)) as GrantPackageDetail;
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

/**
 * Cumulative per-client view across the lineage a package belongs to.
 * Returns null when the package id is unknown. Reference-experimental.
 */
export async function getCumulativeClientAccess(packageId: string): Promise<CumulativeClientAccess | null> {
  try {
    return (await refFetch(
      `/_ref/grant-packages/${encodeURIComponent(packageId)}/cumulative`
    )) as CumulativeClientAccess;
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

export async function revokeGrantPackage(packageId: string): Promise<GrantPackageRevokeResult> {
  try {
    return (await refFetch(`/_ref/grant-packages/${encodeURIComponent(packageId)}/revoke`, undefined, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    })) as GrantPackageRevokeResult;
  } catch (err) {
    if (err instanceof RefRequestError) {
      const result = parseGrantPackageRevokeResult(err.bodyText);
      if (result) {
        throw new GrantPackageRevokePartialFailureError(result);
      }
    }
    throw err;
  }
}

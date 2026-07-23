// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  connection_id?: string | null;
  connector_id?: string | null;
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

export type RunHandleStatus =
  | "abandoned"
  | "active"
  | "cancelled"
  | "completed"
  | "deferred"
  | "expired"
  | "failed"
  | "leased"
  | "released"
  | "starting_surface"
  | "surface_failed"
  | "waiting_for_browser_surface";

export interface RunStatusEnvelope {
  completed_at: string | null;
  connector_id: string | null;
  connector_instance_id: string | null;
  failure: {
    connector_error_message: string | null;
    message: string | null;
    origin: string | null;
    reason: string | null;
  } | null;
  links: { timeline: string };
  object: "run_status";
  run_id: string;
  started_at: string | null;
  status: RunHandleStatus;
  terminal_reason: string | null;
  trace_id: string | null;
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
    ({ events: events } = r);
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
    event_count: typeof r.event_count === "number" ? r.event_count : events.length,
    events,
    next_cursor: typeof r.next_cursor === "string" && r.next_cursor.length > 0 ? r.next_cursor : undefined,
    object: r.object ?? "timeline",
    terminal_status: terminalStatus,
    trace_id: r.trace_id ?? null,
    truncated: r.truncated === true,
  };
}

const CONTROLLER_RUN_STATUSES = new Set([
  "abandoned",
  "active",
  "cancelled",
  "completed",
  "deferred",
  "expired",
  "failed",
  "leased",
  "released",
  "starting_surface",
  "surface_failed",
  "waiting_for_browser_surface",
]);

function normalizeControllerRunStatus(value: unknown): RunStatusEnvelope["status"] {
  return typeof value === "string" && CONTROLLER_RUN_STATUSES.has(value)
    ? (value as RunStatusEnvelope["status"])
    : "active";
}

function normalizeRunFailure(value: unknown): RunStatusEnvelope["failure"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const failure = value as Record<string, unknown>;
  return {
    connector_error_message:
      typeof failure.connector_error_message === "string" ? failure.connector_error_message : null,
    message: typeof failure.message === "string" ? failure.message : null,
    origin: typeof failure.origin === "string" ? failure.origin : null,
    reason: typeof failure.reason === "string" ? failure.reason : null,
  };
}

function normalizeRunLinks(value: unknown): RunStatusEnvelope["links"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { timeline: "" };
  }
  return { timeline: String((value as Record<string, unknown>).timeline ?? "") };
}

function normalizeRunStatus(raw: unknown): RunStatusEnvelope {
  const r = (raw || {}) as {
    completed_at?: unknown;
    connector_id?: unknown;
    connector_instance_id?: unknown;
    failure?: unknown;
    links?: unknown;
    object?: unknown;
    run_id?: unknown;
    started_at?: unknown;
    status?: unknown;
    terminal_reason?: unknown;
    trace_id?: unknown;
  };
  const status = normalizeControllerRunStatus(r.status);
  return {
    completed_at: typeof r.completed_at === "string" ? r.completed_at : null,
    connector_id: typeof r.connector_id === "string" ? r.connector_id : null,
    connector_instance_id: typeof r.connector_instance_id === "string" ? r.connector_instance_id : null,
    failure: normalizeRunFailure(r.failure),
    links: normalizeRunLinks(r.links),
    object: "run_status",
    run_id: typeof r.run_id === "string" ? r.run_id : "",
    started_at: typeof r.started_at === "string" ? r.started_at : null,
    status,
    terminal_reason: typeof r.terminal_reason === "string" ? r.terminal_reason : null,
    trace_id: typeof r.trace_id === "string" ? r.trace_id : null,
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
  client?: {
    client_id: string;
    client_name: string | null;
    registration_mode: string | null;
  };
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
  client?: {
    client_id: string;
    client_name: string | null;
    registration_mode: string | null;
  };
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
  connection_id?: string | null;
  connector_id?: string | null;
  connector_instance_id?: string | null;
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
  /** Manifest-declared coverage proof strategy, absent on older references. */
  coverage_strategy?:
    | "checkpoint_window"
    | "full_inventory"
    | "parent_detail_accounting"
    | "snapshot_import_receipt"
    | "singleton_presence"
    | null;
  /** Known accounted-for numerator, or `"unknown"` when the connector declared none. */
  covered?: number | "unknown";
  /** Derived forward disposition (what the next run is expected to do on this stream). */
  forward_disposition: RefForwardDisposition;
  /** Manifest-declared freshness proof strategy, absent on older references. */
  freshness_strategy?:
    | "device_heartbeat"
    | "manual_as_of"
    | "not_trackable"
    | "scheduled_window"
    | "source_reported_as_of"
    | null;
  /** Count of pending recoverable detail gaps for this stream. */
  pending_detail_gaps: number;
  /** True when the pending-gap count is a floor from a bounded read. */
  pending_detail_gaps_is_floor?: boolean;
  /** The runtime `SKIP_RESULT` fact for this stream, or `null`. */
  skipped: { reason: string; recovery_action?: string } | null;
  stream: string;
}

export interface RefAcquisitionBatchSummary {
  accepted_count: number | null;
  acquisition_method: string | null;
  batch_id: string;
  date_range: { end: string | null; start: string | null };
  detected_format: string | null;
  duplicate_count: number | null;
  failed_count: number | null;
  media_coverage: unknown;
  parsed_count: number | null;
  skipped_count: number | null;
  status: string;
  uploaded_file_name: string | null;
  warnings: readonly string[];
}

export interface RefAcquisitionCoverageSummary {
  latest_batch: RefAcquisitionBatchSummary | null;
  recent_batches: readonly RefAcquisitionBatchSummary[];
}

/**
 * Orthogonal count-evidence state (`reconcile-active-summary-evidence`
 * design.md "Health boundary") shared by `RefConnectorSummary.total_records_state`
 * and `RefConnectorStreamRecord.count_state`. Every console renderer of a
 * `total_records`/per-stream `record_count` value should route through
 * `formatTotalRecordsLabel`/`isTotalRecordsAuthoritative` in
 * `sources-view-model.ts` (Sol fourth-verdict P1.3: "centralize state-aware
 * count formatting... every owner-console total_records consumer") rather
 * than re-deriving this literal union or its branching locally.
 */
export type RefCountState = "known" | "known_zero" | "unobserved" | "stale" | "unknown";

export interface RefConnectorSummary {
  /**
   * Owner/control-plane acquisition provenance for manual imports, device
   * syncs, backup imports, and future multi-path coverage. Never appears on
   * grant-scoped `/v1` reads.
   */
  acquisition_coverage?: RefAcquisitionCoverageSummary | null;
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
  /**
   * Manifest-declaration evidence component (`reconcile-active-summary-evidence`
   * design.md "Orthogonal projection evidence"). Optional on the mirror: a
   * reference predating this field omits it and the console renders nothing
   * for it rather than inventing a state.
   */
  manifest_declaration?: RefEvidenceComponentState | null;
  manifest_version: string | null;
  /** Top-level mirror of `connection_health.next_action`. */
  next_action: RefNextAction | null;
  /**
   * The one closed owner-facing state for this source (Wave 10a, 2026-07-09
   * state-model convergence). Derived server-side by `deriveOwnerState`
   * (`reference-implementation/runtime/owner-state.ts`); optional on the
   * mirror because a reference predating this field omits it, in which case
   * console view-models fall back to deriving from `rendered_verdict` alone
   * rather than inventing owner-state evidence.
   */
  owner_state?: RefOwnerState | null;
  /**
   * Record-snapshot evidence component (`reconcile-active-summary-evidence`
   * design.md "Orthogonal projection evidence"). Optional on the mirror for
   * the same reason as `manifest_declaration`.
   */
  record_snapshot?: RefEvidenceComponentState | null;
  refresh_policy?: RefreshPolicy | null;
  /**
   * Server-owned owner-surface verdict. Current reference builds send this
   * alongside `connection_health`; older builds omit it and the console falls
   * back to the legacy snapshot rather than inventing a verdict.
   */
  rendered_verdict?: RefRenderedVerdict | null;
  retained_bytes?: RefRetainedBytesBreakdown | null;
  /**
   * Retained-bytes evidence component (`reconcile-active-summary-evidence`
   * design.md "Orthogonal projection evidence"), the fourth typed component
   * alongside `record_snapshot`/`terminal_facts`/`manifest_declaration`.
   * Deliberately NOT fed into `ProjectionReliable` server-side — a
   * retained-bytes failure makes byte/history/blob fields unavailable but
   * does not itself degrade connection health. Optional on the mirror for
   * the same reason as the other three components: a reference predating
   * this field omits it and the console renders nothing for it rather than
   * inventing a state.
   */
  retained_bytes_evidence?: RefEvidenceComponentState | null;
  /** Durable connector-instance lifecycle state. Revoked rows remain owner-visible. */
  revoked_at?: string | null;
  schedule: RefSchedule | null;
  source_binding_kind?: string | null;
  /**
   * The connection's source kind and non-secret source-binding kind. Owner
   * surfaces route repair BINDING-FIRST: a browser-session binding
   * (`browser_collector`/`browser_enrollment_shell`) repairs by browser/session
   * repair, not static-secret credential capture, even when the connector also
   * supports a static secret. Optional on the mirror: a reference predating the
   * field omits it and the console falls back to connector-level modality.
   */
  source_kind?: string;
  status?: string | null;
  stream_count?: number;
  stream_records?: readonly RefConnectorStreamRecord[];
  streams: string[];
  /**
   * Terminal-facts evidence component (`reconcile-active-summary-evidence`
   * design.md "Orthogonal projection evidence"). Optional on the mirror for
   * the same reason as `manifest_declaration`.
   */
  terminal_facts?: RefTerminalFactsState | null;
  total_records: number;
  /**
   * Orthogonal state for `total_records` (`reconcile-active-summary-evidence`
   * design.md "Health boundary"): `"stale"` when the evidence backing
   * `total_records` exists but its record_snapshot is not current — the
   * number is a non-authoritative carried-over hint, not a proven exact
   * count. Optional on the mirror: a reference predating this field omits
   * it and the console falls back to rendering the number as-is (the exact
   * prior behavior) rather than inventing a state.
   */
  total_records_state?: RefCountState;
  total_retained_bytes?: number | null;
}

/**
 * Shared shape for the `record_snapshot` / `manifest_declaration` evidence
 * components. Mirrors the server's inline object types in `ref-control.ts`.
 */
export interface RefEvidenceComponentState {
  as_of: string | null;
  reason_code: string | null;
  state: "current" | "unobserved" | "stale" | "unavailable" | "failed";
}

export interface RefTerminalFactsState extends RefEvidenceComponentState {
  event_seq: number | null;
}

export interface RefConnectorStreamRecord {
  count_state?: RefCountState;
  /**
   * Orthogonal declaration/count state pair (`reconcile-active-summary-evidence`
   * design.md "Explicit stream evidence"). Optional on the mirror: a reference
   * predating these fields omits them and the console falls back to the
   * `record_count === null` binary check rather than inventing a state.
   */
  declaration_state?: "declared" | "dormant" | "unexpected" | "unavailable";
  last_updated: string | null;
  /** `null` when the count is genuinely unknown/unavailable — never a fabricated `0`. */
  record_count: number | null;
  retained_record_count?: number | null;
  stream: string;
}

export interface RefConnectorRuntimeStatus {
  label: string;
  message: string | null;
  object: "ref_runtime_status";
  ok: boolean;
  reason: "controller_unavailable" | null;
}

export interface RefConnectorSummariesResponse extends ListResponse<RefConnectorSummary> {
  runtime?: RefConnectorRuntimeStatus;
}

/**
 * Mirrors `OwnerStateResolver` (`reference-implementation/runtime/owner-state.ts`).
 * Closed, server-side derivation aid — NEVER rendered to the owner verbatim.
 * Console copy states the concrete cause/action instead of this enum label.
 */
export type RefOwnerStateResolver =
  | "blocked_maintainer"
  | "collecting"
  | "healthy"
  | "needs_owner"
  | "not_measured"
  | "owner_paused"
  | "refresh_due"
  | "retired"
  | "setup_in_progress"
  | "system_degraded";

export type RefOwnerOfState = "maintainer" | "owner" | "system";
export type RefOwnerStatePosture = "frozen-since-last-run" | "observed";

/** Mirrors `OwnerState` (`reference-implementation/runtime/owner-state.ts`). */
export interface RefOwnerState {
  /**
   * ISO-8601 instant of the EVIDENCE that produced this state — never
   * read/projection time. `null` when the server has no evidence at all
   * (never-run source, no freshness proof yet) — never fabricated from
   * request time.
   */
  evidence_as_of: string | null;
  owner_of_state: RefOwnerOfState;
  posture: RefOwnerStatePosture;
  resolver: RefOwnerStateResolver;
}

export type RefVerdictTone = "amber" | "green" | "grey" | "red";
export type RefRenderedChannel = "advisory" | "attention" | "calm";

export interface RefVerdictPill {
  label: "Can't collect" | "Checking" | "Degraded" | "Healthy" | "Needs refresh" | "Not measured" | "Syncing";
  tone: RefVerdictTone;
}

export interface RefVerdictAnnotation {
  kind: "activity" | "attention" | "coverage" | "freshness" | "outbox" | "schedule";
  text: string;
}

export type RefRequiredActionKind =
  | "add_info"
  | "backfill"
  | "code_fix"
  | "contact_support"
  | "reattach_schedule"
  | "reauth"
  | "refresh_now"
  | "retry_gap"
  | "wait";

export type RefActionAudience = "maintainer" | "none" | "owner";
export type RefActionUrgency = "now" | "overdue" | "soon" | "verifying";

export type RefActionRemediationCause =
  | "dead_letter_backlog"
  | "stale_pending"
  | "state_read_failed"
  | "stalled_unknown";

export type RefActionRemediationCommandKind =
  | "local_collector_doctor"
  | "local_collector_recover_apply"
  | "local_collector_recover_preview"
  | "local_collector_retry_dead_letters_apply"
  | "local_collector_retry_dead_letters_preview"
  | "local_collector_run";

export interface RefActionRemediationCommand {
  command_template: string;
  kind: RefActionRemediationCommandKind;
  label: string;
}

export interface RefActionRemediationTarget {
  identity_source: "source_instance_bindings";
  kind: "local_device";
}

export interface RefActionRemediation {
  cause: RefActionRemediationCause;
  commands: readonly RefActionRemediationCommand[];
  kind: "local_collector_recovery";
  label: string;
  summary: string;
  target: RefActionRemediationTarget;
}

export interface RefRequiredActionTarget {
  kind: "sync";
  run_id: string;
}

export type RefOwnerActionSurfaceKind =
  | "browser_session"
  | "local_device"
  | "maintainer"
  | "none"
  | "provider_interaction"
  | "runtime_retry"
  | "schedule"
  | "stored_credential";

export interface RefOwnerActionSurface {
  kind: RefOwnerActionSurfaceKind;
}

export interface RefSatisfactionContract {
  kind:
    | "attention_resolved"
    | "backfill_window_covered"
    | "confirming_run_succeeded"
    | "credential_present_and_unrejected"
    | "gap_recovered"
    | "none"
    | "schedule_attached_and_enabled";
}

export interface RefRequiredAction {
  affects: readonly string[];
  audience: RefActionAudience;
  cta: string;
  kind: RefRequiredActionKind;
  remediation?: RefActionRemediation;
  satisfied_when: RefSatisfactionContract;
  surface?: RefOwnerActionSurface;
  target?: RefRequiredActionTarget;
  terminal: boolean;
  urgency: RefActionUrgency;
}

export interface RefRenderedProgress {
  gaps_drained_last_run: number | null;
  headline: string;
  last_refreshed_at: string | null;
  mode: "deferred" | "local_device" | "manual" | "scheduled";
  records_committed_last_run: number | null;
  retained_records: number | null;
}

export interface RefVerdictStreamRow {
  action_ref: number | null;
  collected: number | null;
  considered: number | null;
  coverage: RefCoverageAxis;
  disposition: RefForwardDisposition;
  statement: string;
  stream_id: string;
}

export interface RefSuppressedSignal {
  detail_field: string;
  kind: "cooldown" | "drain" | "runtime_fault" | "syncing";
  reason: string;
}

export interface RefRenderedVerdictDetail {
  suppressed?: readonly RefSuppressedSignal[];
}

export interface RefRenderedVerdict {
  annotations: readonly RefVerdictAnnotation[];
  channel: RefRenderedChannel;
  /** Owner-only inspection layer; rendered only on detail/diagnostic surfaces. */
  detail: RefRenderedVerdictDetail;
  forward_statement: string;
  pill: RefVerdictPill;
  progress: RefRenderedProgress;
  required_actions: readonly RefRequiredAction[];
  streams: readonly RefVerdictStreamRow[];
  /** Owner-only calibration diagnostic; never grant-scoped. */
  trace: unknown;
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
export type RefForwardDisposition =
  | "awaiting_owner"
  | "checking"
  | "complete"
  | "owner_refresh_due"
  | "resumable"
  | "terminal"
  | "unmeasured";

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
  /**
   * Count of gaps that are permanently unfillable (404/410/permanent error,
   * exhausted recovery budget). Set only when the reference server supports
   * §10-A terminal-gap tracking; absent/null on older projections — treat
   * absence as zero for backward compatibility.
   *
   * When `terminal > 0`, the honest copy is NOT "caught up" but "recovered
   * everything still available; N items no longer retrievable at the source"
   * (spec §6.3 corrected by red-team §10-A). Folding terminal into `pending`
   * to reach zero would be a silent lie.
   */
  terminal?: number | null;
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
  surface?: RefOwnerActionSurface;
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

// Exported so AS-routed `/_ref/*` clients in sibling modules (e.g. the explore
// bucket aggregate in rs-client.ts) reach the AUTHORIZATION server, not the RS.
// The `/_ref/explore/*` routes are mounted on the AS under the owner session.
export async function refFetch(
  path: string,
  params?: Record<string, string | number | undefined>,
  init: RequestInit = {}
) {
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
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, {
      cause: err,
    });
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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

export async function getRunStatus(runId: string): Promise<RunStatusEnvelope | null> {
  try {
    return normalizeRunStatus(await refFetch(`/_ref/runs/${encodeURIComponent(runId)}`));
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

/**
 * Response envelope for GET /_ref/explore/records (Phase 3 merged timeline).
 * Mirrors `ExploreTimelineOutput` from the rs-explore-timeline operation.
 */
export interface ExploreTimelinePage {
  data: ExploreTimelineRecord[];
  has_more: boolean;
  new_since_snapshot: number;
  next_cursor: string | null;
  object: "list";
  snapshot_at: string;
}

/**
 * Carries BOTH identity fields:
 *   - `connector_id`: connector TYPE (e.g. "amazon") — use for display labels and
 *     manifest/registry lookup.
 *   - `connector_instance_id`: connection INSTANCE (e.g. "cin_...") — use for
 *     per-connection API reads and connection-detail URLs.
 *
 * Never render raw `connector_instance_id` as a display name; resolve the
 * human label via `connector_id` against the connector registry.
 */
export interface ExploreTimelineRecord {
  /** Connector TYPE id (e.g. "amazon"). Use for display labels and manifest lookup. */
  connector_id: string;
  /** Connection INSTANCE id (e.g. "cin_..."). Use for per-connection API reads. */
  connector_instance_id: string;
  data: unknown;
  emitted_at: string;
  object: "timeline_record";
  record_key: string;
  stream: string;
}

/**
 * Fetch one page of the Phase 3 merged cross-source timeline.
 *
 * Route: GET /_ref/explore/records
 * Auth: owner session cookie (same as all /_ref routes).
 *
 * The composite cursor encodes all per-partition positions + the snapshot
 * anchor for point-in-time stability. Pass the returned `next_cursor` as
 * `cursor` to page forward; pass `null`/`undefined` for the first page.
 */
export async function listExploreTimeline(
  opts: {
    connectionIds?: readonly string[];
    cursor?: string | null;
    limit?: number;
    /**
     * REWIND: re-render page 1 pinned to `cursor`'s ORIGINAL snapshot
     * (snapshotSeq) instead of capturing a fresh one. The Explore "Load more"
     * accumulator sets this for the page-1 fetch (cursor = the page-1 → page-2
     * cursor) so an after-snapshot backfill can never displace an original
     * page-1 row. Only meaningful when `cursor` is set.
     */
    rewindToFirstPage?: boolean;
    streams?: readonly string[];
    /** EXCLUDE scope ("is not" facet / `-con:`/`-stream:`), applied server-side. */
    excludeConnectionIds?: readonly string[];
    excludeStreams?: readonly string[];
    /**
     * Page the Upcoming (future) projection to exhaustion. When set, the request
     * pages ONLY the future set (the cursor carries the pinned snapshot + scope +
     * per-partition positions), so `cursor`/`rewind`/scope are not sent.
     */
    upcomingCursor?: string | null;
    /** Page-1 head size for the bounded Upcoming set, independent of `limit`. */
    upcomingLimit?: number;
    /**
     * Sort DIRECTION for the merged feed. "desc" (default) = newest-first browse;
     * "asc" = the `order=oldest` re-page (earliest record first). Sent as
     * `direction=asc` only when non-default so the newest-first URL stays clean.
     */
    direction?: "asc" | "desc";
  } = {}
): Promise<ExploreTimelinePage> {
  if (opts.upcomingCursor) {
    return (await refFetch("/_ref/explore/records", {
      limit: opts.limit,
      upcoming_cursor: opts.upcomingCursor,
      upcoming_limit: opts.upcomingLimit,
    })) as ExploreTimelinePage;
  }
  const connection = opts.connectionIds?.filter((v) => typeof v === "string" && v.length > 0).join(",");
  const stream = opts.streams?.filter((v) => typeof v === "string" && v.length > 0).join(",");
  const xconnection = opts.excludeConnectionIds?.filter((v) => typeof v === "string" && v.length > 0).join(",");
  const xstream = opts.excludeStreams?.filter((v) => typeof v === "string" && v.length > 0).join(",");
  return (await refFetch("/_ref/explore/records", {
    connection: connection || undefined,
    cursor: opts.cursor ?? undefined,
    // Only the oldest-first re-page sends a direction; newest-first is the default.
    direction: opts.direction === "asc" ? "asc" : undefined,
    limit: opts.limit,
    rewind: opts.rewindToFirstPage ? 1 : undefined,
    stream: stream || undefined,
    upcoming_limit: opts.upcomingLimit,
    xconnection: xconnection || undefined,
    xstream: xstream || undefined,
  })) as ExploreTimelinePage;
}

export async function listConnectorSummaries(
  options: { connectionRouteId?: string } = {}
): Promise<RefConnectorSummariesResponse> {
  // When a record subpage knows the connection it wants, pass the route id so
  // the reference projects only that one connection (a 0-or-1 list) instead of
  // running the per-connection fan-out for every configured connection. Unscoped
  // callers (records index, schedules, grant request) omit it and get the full
  // list exactly as before.
  return (await refFetch("/_ref/connectors", {
    connection: options.connectionRouteId,
  })) as RefConnectorSummariesResponse;
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
// facing /deployment page. Shape matches the report returned by
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
    backend: {
      active: "sqlite_fts5" | "postgres_native_fts" | "pg_search_bm25";
      configured: boolean;
      fallback: boolean;
      pg_search: {
        available: boolean;
        state: "not_applicable" | "unavailable" | "available_disabled" | "enabled" | "fallback_unavailable";
      };
    };
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
  auto_resume: {
    confirming_run: { run_id?: string; trace_id?: string } | null;
    error_code?: string;
    error_message?: string;
    object: "connection_self_heal";
    status: "active_run_exists" | "blocked" | "no_satisfied_action" | "started";
    terminal_status?: "failed" | "succeeded";
  } | null;
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
  setupFields: Record<string, string>,
  options: { displayName?: string | null } = {}
): Promise<StaticSecretDraftConnection> {
  return (await refFetch(`/_ref/connectors/${encodeURIComponent(connectorId)}/draft-connection`, undefined, {
    body: JSON.stringify({
      setup_fields: setupFields,
      ...(options.displayName ? { display_name: options.displayName } : {}),
    }),
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
      throw new StaticSecretValidationError(err.message, { cause: err });
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
  | "awaiting_browser_login"
  | "awaiting_credential"
  | "first_sync_failed"
  | "first_sync_pending"
  | "first_sync_running"
  | "first_sync_zero_yield"
  | "paused"
  | "revoked"
  | "unknown";

export type ConnectionSetupKind = "browser_session" | "manual_upload" | "static_secret" | "unknown";

export interface ConnectionSetupStatus {
  account_identity: string | null;
  connection_id: string;
  connector_id: string;
  created_at: string | null;
  credential: {
    captured_at: string | null;
    credential_kind: string | null;
    present: boolean;
    rotated_at: string | null;
  };
  display_name: string | null;
  health_state: string;
  import_receipt: {
    acquisition_method: string | null;
    accepted_count: number | null;
    batch_id: string | null;
    date_range: {
      end: string | null;
      start: string | null;
    } | null;
    detected_format: string | null;
    duplicate_count: number | null;
    estimated_attachments: number | null;
    estimated_chats: number | null;
    estimated_messages: number | null;
    estimated_participants: number | null;
    estimated_points: number | null;
    estimated_segments: number | null;
    failed_count: number | null;
    media_coverage: unknown;
    parsed_count: number | null;
    remediation: string | null;
    skipped_count: number | null;
    status: string | null;
    uploaded_file_name: string | null;
    warnings: string[];
  } | null;
  last_error: {
    reason: string;
    remediation: string;
  } | null;
  object: "connection_setup_status";
  pending: boolean;
  run: {
    finished_at: string | null;
    records_emitted: number | null;
    reported_records_emitted: number | null;
    run_id: string | null;
    started_at: string | null;
    status: string | null;
  } | null;
  running: boolean;
  setup_kind: ConnectionSetupKind;
  setup_material: {
    captured_at: string | null;
    kind: ConnectionSetupKind;
    label: string;
    present: boolean;
  };
  setup_state: StaticSecretSetupStateValue;
  status: string;
  updated_at: string | null;
}

export type StaticSecretSetupStatus = ConnectionSetupStatus;

export async function getConnectionSetupStatus(
  connectionId: string,
  runId?: string | null
): Promise<ConnectionSetupStatus> {
  const suffix = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  return (await refFetch(
    `/_ref/connections/${encodeURIComponent(connectionId)}/setup-status${suffix}`
  )) as ConnectionSetupStatus;
}

export function getStaticSecretSetupStatus(
  connectionId: string,
  runId?: string | null
): Promise<StaticSecretSetupStatus> {
  return getConnectionSetupStatus(connectionId, runId);
}

// ---------------------------------------------------------------------------
// Manual/upload setup: owner-session file capture for manual_or_upload sources
// ---------------------------------------------------------------------------

export interface ManualUploadSetup {
  accepted_file_extensions: string[];
  accepted_file_names: string[];
  acquisition_methods: {
    detail: string | null;
    help_url: string | null;
    label: string;
    platform: string | null;
    posture: string | null;
  }[];
  connector_id: string;
  description: string | null;
  display_name: string;
  help_text: string | null;
  help_url: string | null;
  label: string;
  large_file_fallback: string | null;
  max_file_bytes: number | null;
  object: "manual_upload_setup";
  validation_expectations: string[];
}

export interface ManualUploadDraftConnection {
  batch_id?: string | null;
  connection_id: string;
  connector_id: string;
  connector_instance_id: string;
  display_name: string;
  next_step: {
    kind: "run_connection" | "show_status";
    method: "GET" | "POST";
    reason?: string;
    url: string;
  };
  object: "manual_upload_draft_connection" | "manual_upload_known_artifact";
  receipt?: Record<string, unknown> | null;
  status: "draft" | string;
  uploaded_file_name: string;
  validation?: {
    date_range: { end: string | null; start: string | null };
    detected_format: string;
    estimated_attachments?: number;
    estimated_chats?: number;
    estimated_messages?: number;
    estimated_participants?: number;
    estimated_points?: number;
    estimated_segments?: number;
    estimated_records?: number;
    source_identity?: unknown;
    status: string;
  } | null;
}

export interface ManualUploadValidationPreview {
  connector_id: string;
  display_name: string;
  duplicate: {
    batch_id: string;
    connection_id: string;
    receipt?: Record<string, unknown> | null;
    status: string;
  } | null;
  next_step: {
    kind: "confirm_import" | "show_status";
    method: "GET" | "POST";
    reason?: string;
    url: string;
  };
  object: "manual_upload_validation_preview";
  uploaded_file_name: string;
  validation?: ManualUploadDraftConnection["validation"] & {
    media_coverage?: unknown;
    remediation?: string;
    warnings?: string[];
  };
}

export async function getManualUploadSetup(connectorId: string): Promise<ManualUploadSetup> {
  return (await refFetch(
    `/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-setup`
  )) as ManualUploadSetup;
}

async function postManualUploadFile(
  path: string,
  file: File,
  errorPrefix: string,
  options: { connectionId?: string | null; displayName?: string | null } = {}
): Promise<unknown> {
  const url = new URL(`${getAsInternalUrl()}${path}`);
  url.searchParams.set("file_name", file.name);
  if (options.connectionId) {
    url.searchParams.set("connection_id", options.connectionId);
  }
  if (options.displayName) {
    url.searchParams.set("display_name", options.displayName);
  }
  const init = await withOwnerSessionCookie({
    body: file,
    cache: "no-store",
    method: "POST",
  });
  let res: Response;
  try {
    res = await fetch(url.toString(), init);
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 && isOwnerSessionRequiredBody(body)) {
      await redirectToOwnerLogin();
    }
    throw new RefRequestError(describeErrorText(body, `${errorPrefix} (${res.status})`), res.status, body);
  }
  return res.json();
}

export async function validateManualUploadArtifact(
  connectorId: string,
  file: File,
  options: { connectionId?: string | null; displayName?: string | null } = {}
): Promise<ManualUploadValidationPreview> {
  return (await postManualUploadFile(
    `/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-validation-preview`,
    file,
    "manual upload validation failed",
    options
  )) as ManualUploadValidationPreview;
}

export async function createManualUploadDraftConnection(
  connectorId: string,
  file: File,
  options: { connectionId?: string | null; displayName?: string | null } = {}
): Promise<ManualUploadDraftConnection> {
  return (await postManualUploadFile(
    `/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-draft-connection`,
    file,
    "manual upload failed",
    options
  )) as ManualUploadDraftConnection;
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

export interface UpdatedOwnerClient {
  client_id: string;
  client_name: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * RFC 7592 client-name update (`PATCH /oauth/register/:clientId`). Edits the
 * owner-facing credential label only; scope and bearer material are not
 * editable. The AS bumps `oauth_clients.updated_at`, so the next
 * `listOwnerIssuedClients()` read reflects the rename in one render cycle.
 *
 * Owner-session-gated. `10.C.1`.
 */
export async function updateOwnerClientName(clientId: string, clientName: string): Promise<UpdatedOwnerClient> {
  return (await refFetch(`/oauth/register/${encodeURIComponent(clientId)}`, undefined, {
    body: JSON.stringify({ client_name: clientName }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  })) as UpdatedOwnerClient;
}

/**
 * One active bearer token issued against an owner client. The `token_id_public`
 * is a non-reversible digest of the live bearer — it is a stable revoke handle,
 * never a usable credential. The literal bearer never leaves the AS.
 *
 * `10.C.2`.
 */
export interface OwnerClientToken {
  created_at: string;
  expires_at: string | null;
  object: "owner_client_token";
  token_id_public: string;
  token_kind: string;
}

/**
 * Per-client active-token listing (`GET /_ref/clients/:clientId/tokens?owner=true`).
 * Backs the drilldown a client shows when `active_token_count > 1`. Owner-session-gated.
 * No literal bearer is present in the response.
 */
export async function listOwnerClientTokens(clientId: string): Promise<ListResponse<OwnerClientToken>> {
  return (await refFetch(`/_ref/clients/${encodeURIComponent(clientId)}/tokens`, {
    owner: "true",
  })) as ListResponse<OwnerClientToken>;
}

/**
 * Per-token revoke (`DELETE /_ref/clients/:clientId/tokens/:tokenIdPublic`).
 * Revokes exactly one bearer, addressed by its non-bearer public id, without
 * deleting the client or its other tokens. Owner-session-gated. `10.C.3`.
 */
export async function revokeOwnerClientToken(
  clientId: string,
  tokenIdPublic: string
): Promise<{ object: "owner_client_token_revocation"; revoked: boolean; token_id_public: string }> {
  return (await refFetch(
    `/_ref/clients/${encodeURIComponent(clientId)}/tokens/${encodeURIComponent(tokenIdPublic)}`,
    undefined,
    { method: "DELETE" }
  )) as { object: "owner_client_token_revocation"; revoked: boolean; token_id_public: string };
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
 * add-source authorization records linked by `parent_package_id`.
 * Lineage is grouping/audit metadata only — every source authorization remains
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

  constructor(result: GrantPackageRevokeResult, options?: ErrorOptions) {
    super(formatGrantPackageRevokePartialFailure(result), options);
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
  const failedSummary = failed || "unknown source authorization";
  return `Partial revoke: ${result.revoked_child_count} source authorization${
    result.revoked_child_count === 1 ? "" : "s"
  } revoked; ${result.not_revoked_child_count} not revoked: ${failedSummary}. Access remains active.`;
}

export async function listGrantPackages(): Promise<ListResponse<GrantPackageSummary>> {
  return (await refFetch("/_ref/grant-packages")) as ListResponse<GrantPackageSummary>;
}

export interface GrantPackageCount {
  count: number;
  object: "grant_package_count";
}

/**
 * Cheap grant-package count (`GET /_ref/grant-packages/count`) so the overview
 * can surface package presence/count without paging the full list. Owner-session-gated.
 * `10.C.4`.
 */
export async function getGrantPackageCount(): Promise<GrantPackageCount> {
  return (await refFetch("/_ref/grant-packages/count")) as GrantPackageCount;
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
    const page = await listGrants({ limit: 5, q: grantId });
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
 * Cumulative per-client view across the related access records.
 * Returns null when the access-group id is unknown.
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
        throw new GrantPackageRevokePartialFailureError(result, { cause: err });
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Browser-enrollment shell: in-dashboard browser-bound connector setup
// ---------------------------------------------------------------------------

/**
 * Response from POST /_ref/connectors/:connectorId/browser-enrollment-shell.
 *
 * Creates a draft connection shell for a browser-bound connector. This is the
 * Plaid link_token analog: a short-lived (2h), owner-session-only draft row
 * that the in-dashboard neko browser flow transitions to active once the owner
 * completes login and the connector captures a valid session. Until enrollment
 * completes the shell is invisible to all list/read surfaces.
 */
export interface BrowserEnrollmentShell {
  connection_id: string;
  connector_id: string;
  connector_instance_id: string;
  display_name: string;
  enrollment_expires_at: string;
  next_step: {
    kind: "browser_enrollment_run";
    reason: string;
  };
  object: "browser_enrollment_shell";
  status: "draft";
}

/**
 * Create a browser-enrollment shell for a browser-bound connector.
 *
 * Owner-session cookie required. Returns a draft connection_id + TTL that the
 * browser-session connect page uses to start an enrollment run.
 */
export async function createBrowserEnrollmentShell(
  connectorId: string,
  options: { displayName?: string | null } = {}
): Promise<BrowserEnrollmentShell> {
  const body = options.displayName?.trim() ? { display_name: options.displayName.trim() } : {};
  return (await refFetch(`/_ref/connectors/${encodeURIComponent(connectorId)}/browser-enrollment-shell`, undefined, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })) as BrowserEnrollmentShell;
}

/**
 * Abandon (retire) a browser-enrollment shell when the owner cancels setup.
 * No-op if the shell is already revoked. Typed 409 if enrollment is already
 * complete (shell is active).
 */
export async function abandonBrowserEnrollmentShell(
  connectionId: string
): Promise<{ object: "enrollment_abandoned"; connection_id: string; connector_id: string; status: string }> {
  return (await refFetch(`/_ref/connections/${encodeURIComponent(connectionId)}/abandon-enrollment`, undefined, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  })) as { object: "enrollment_abandoned"; connection_id: string; connector_id: string; status: string };
}

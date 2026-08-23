// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connection health projection.
 *
 * Computes a `ConnectionHealthSnapshot` for a single configured connection
 * from durable evidence inputs:
 *
 *   - the latest run outcome (and prior committed progress);
 *   - scheduler/backoff state (cooling-off, next attempt, give-up streak);
 *   - structured attention evidence (needs_attention lifecycle);
 *   - durable coverage by stream/scope;
 *   - outbox/work state from the local collector or other executors;
 *   - projection freshness for derived read models.
 *
 * The headline state set is canonical and small:
 *
 *     unknown | idle | needs_attention | blocked | cooling_off
 *     | degraded | healthy
 *
 * `syncing` (active work) and `stale` (freshness violation) are NOT
 * headline states. They are exposed as orthogonal axes/badges so the
 * dashboard can render activity/freshness without inventing a new pill
 * every time we add an evidence source.
 *
 * Precedence (from `openspec/.../design.md` Decision: Connection Health
 * Uses Ordered Projection Plus Orthogonal Axes):
 *
 *   1. projection unreliable                       -> unknown
 *   2. required attention open                     -> needs_attention
 *   3. owner-paused                               -> idle
 *   4. give-up streak crossed                      -> blocked
 *   5. affirmative scheduled retry with clean evidence -> cooling_off
 *   6. outbox stalled / coverage/run incomplete    -> degraded
 *   7. current evidence without collection verdict -> unknown
 *   7a. current managed remote-surface evidence absent -> unknown
 *   7b. otherwise-green stale connector that cannot or may-not refresh
 *       unattended (manual / paused / background-unsafe, or assisted-refresh
 *       whose posture predicts bounded owner help)  -> idle (stale advisory)
 *   8. never-run with no stronger evidence         -> idle
 *   9. clean evidence, fresh enough                -> healthy
 *   10. fallback                                  -> unknown
 *
 * The function is **pure**: no I/O, no clock reads. The caller is
 * responsible for collecting durable evidence and passing it in.
 */

import type { EphemeralBrowserRuntimeProjection } from "./browser-surface/ephemeral-health-projection.ts";
import { type BrowserSurfaceRepairEvidence, decideBrowserSurfaceRepair } from "./browser-surface/repair-decision.ts";
import {
  BLOCKED_PROMOTION_THRESHOLD,
  OUTBOX_BLOCKED_BACKLOG_TOLERANCE,
  OUTBOX_STALE_RETRYING_BACKLOG_AGE_MS,
} from "./connection-health-policy.ts";
import { type PendingPressureGap, SOURCE_PRESSURE_GAP_REASONS } from "./scheduler-source-pressure-cooldown.ts";

// ─── Public types ──────────────────────────────────────────────────────────

export type ConnectionHealthState =
  | "blocked"
  | "cooling_off"
  | "degraded"
  | "healthy"
  | "idle"
  | "needs_attention"
  | "unknown";

export type ConnectionConditionType =
  | "AttentionClear"
  | "BacklogClear"
  | "CollectionSucceeded"
  | "CredentialContinuity"
  | "CredentialsValid"
  | "Fresh"
  | "LocalExporterAvailable"
  | "ProjectionReliable"
  | "RemoteSurfaceAvailable"
  | "RetryPolicyClear"
  | "RuntimeAvailable"
  | "ScheduleEligible"
  | "SourceCoverageComplete";

/**
 * Condition status.
 *
 *   - `true`           : the condition holds on current evidence.
 *   - `false`          : the condition is violated on current evidence.
 *   - `unknown`        : the condition is answerable in principle, but current
 *                        evidence does not settle it. A verdict is genuinely
 *                        pending.
 *   - `not_applicable` : the condition cannot apply to this connection at all,
 *                        because the evidence source it reads does not exist
 *                        here (no local-device binding, no managed runtime
 *                        surface, no browser-process continuity to prove). This
 *                        is a *settled* answer, not a pending one.
 *
 * `not_applicable` exists so the projection stops encoding certainty as doubt.
 * A self-hosted deployment with no local collector and no
 * `@opendatalabs/remote-surface` package can never answer `BacklogClear` or
 * `RemoteSurfaceAvailable`; reporting those as `unknown` invited the owner to
 * wait for a verdict that would never arrive. {@link pickSupportingConditionIds}
 * filters these out of the owner-facing supporting list the same way it filters
 * uninteresting `true`+`info` conditions, so a healthy connection shows an
 * honest, near-empty diagnostics list.
 *
 * Classification treats `not_applicable` exactly as it treated the `unknown` it
 * replaces: it is never `true` and never `false`, so no headline state, axis, or
 * healthy-set predicate changes. Only presentation changes.
 */
export type ConnectionConditionStatus = "false" | "not_applicable" | "true" | "unknown";

export type ConnectionConditionSeverity = "blocked" | "error" | "info" | "warning";

export type ConnectionConditionOrigin =
  | "connector"
  | "local_device"
  | "operator"
  | "read_model"
  | "readiness"
  | "remote_surface"
  | "runtime"
  | "scheduler";

export type ConnectionConditionSensitivity = "owner" | "public" | "secret_redacted";

export const CONNECTION_CONDITION_REASONS = Object.freeze({
  ATTENTION_EXPIRED: "attention_expired",
  ATTENTION_REQUIRED: "attention_required",
  BACKOFF_EXPIRED: "backoff_expired",
  BROWSER_RUNTIME_NOT_CONFIGURED: "browser_runtime_not_configured",
  COLLECTION_FAILED: "collection_failed",
  COLLECTION_NOT_OBSERVED: "collection_not_observed",
  COLLECTION_SUCCEEDED: "collection_succeeded",
  COLLECTION_SUCCEEDED_IMPORT_COMPLETE: "collection_succeeded_import_complete",
  COLLECTION_SUCCEEDED_LOCAL_DEVICE: "collection_succeeded_local_device",
  COVERAGE_COMPLETE_UNFILLABLE_ACCOUNTED: "coverage_complete_unfillable_accounted",
  COVERAGE_UNKNOWN: "coverage_unknown",
  COVERAGE_UNKNOWN_STALE_COLLECTOR: "coverage_unknown_stale_collector",
  CREDENTIAL_CONTINUITY_NOT_APPLICABLE: "credential_continuity_not_applicable",
  CREDENTIAL_CONTINUITY_PROVEN: "credential_continuity_proven",
  CREDENTIAL_CONTINUITY_UNPROVEN: "credential_continuity_unproven",
  CREDENTIAL_REJECTED: "credential_rejected",
  CREDENTIAL_REQUIRED: "credential_required",
  CREDENTIALS_ACCEPTED: "credentials_accepted",
  CREDENTIALS_NOT_APPLICABLE_FILE_IMPORT: "credentials_not_applicable_file_import",
  CREDENTIALS_NOT_PROBED: "credentials_not_probed",
  EXTERNAL_TOOL_UNAVAILABLE: "external_tool_unavailable",
  FRESH: "fresh",
  FRESHNESS_NOT_APPLICABLE_COMPLETE: "freshness_not_applicable_complete",
  FRESHNESS_UNKNOWN: "freshness_unknown",
  LOCAL_EXPORTER_ACTIVE: "local_exporter_active",
  LOCAL_EXPORTER_DEAD_LETTER_BACKLOG: "local_exporter_dead_letter_backlog",
  LOCAL_EXPORTER_IDLE: "local_exporter_idle",
  LOCAL_EXPORTER_NOT_APPLICABLE: "local_exporter_not_applicable",
  LOCAL_EXPORTER_STALE_HEARTBEAT: "local_exporter_stale_heartbeat",
  LOCAL_EXPORTER_STALE_PENDING: "local_exporter_stale_pending",
  LOCAL_EXPORTER_STALLED: "local_exporter_stalled",
  LOCAL_EXPORTER_STATE_READ_FAILED: "local_exporter_state_read_failed",
  LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE: "local_exporter_transient_upload_failure",
  LOCAL_EXPORTER_UNKNOWN: "local_exporter_unknown",
  MISSING_BROWSER_SURFACE: "missing_browser_surface",
  NO_ACTIVE_BACKOFF: "no_active_backoff",
  NO_OPEN_ATTENTION: "no_open_attention",
  OUTBOX_ACTIVE: "outbox_active",
  OUTBOX_DEAD_LETTER_BACKLOG: "outbox_dead_letter_backlog",
  OUTBOX_IDLE: "outbox_idle",
  OUTBOX_NOT_APPLICABLE: "outbox_not_applicable",
  OUTBOX_STALE_HEARTBEAT: "outbox_stale_heartbeat",
  OUTBOX_STALE_PENDING: "outbox_stale_pending",
  OUTBOX_STALLED: "outbox_stalled",
  OUTBOX_STATE_READ_FAILED: "outbox_state_read_failed",
  OUTBOX_TRANSIENT_UPLOAD_FAILURE: "outbox_transient_upload_failure",
  OUTBOX_UNKNOWN: "outbox_unknown",
  PROJECTION_CURRENT: "projection_current",
  PROJECTION_SUPERSEDED_BY_DEFINITION_CHANGE: "projection_superseded_by_definition_change",
  PROJECTION_UNRELIABLE: "projection_unreliable",
  REMOTE_SURFACE_AVAILABLE: "remote_surface_available",
  REMOTE_SURFACE_FAILED: "remote_surface_failed",
  REMOTE_SURFACE_NOT_REQUIRED: "remote_surface_not_required",
  REMOTE_SURFACE_UNKNOWN: "remote_surface_unknown",
  RETRY_NOT_APPLICABLE: "retry_not_applicable",
  RUNTIME_AVAILABLE: "runtime_available",
  RUNTIME_BINDING_MISSING: "runtime_binding_missing",
  RUNTIME_NOT_MANAGED: "runtime_not_managed",
  RUNTIME_STATE_UNKNOWN: "runtime_state_unknown",
  RUNTIME_UNAVAILABLE: "runtime_unavailable",
  SCHEDULE_ENABLED: "schedule_enabled",
  SCHEDULE_NOT_CONFIGURED: "schedule_not_configured",
  SCHEDULE_PAUSED: "schedule_paused",
  SCHEDULER_BACKOFF_ACTIVE: "scheduler_backoff_active",
  STALE: "stale",
  STALE_ASSISTED_REFRESH: "stale_assisted_refresh",
  STALE_MANUAL_REFRESH: "stale_manual_refresh",
} as const);

export type SharedConnectionConditionReason =
  (typeof CONNECTION_CONDITION_REASONS)[keyof typeof CONNECTION_CONDITION_REASONS];

const CONDITION_REASON = CONNECTION_CONDITION_REASONS;

export type OwnerActionSurfaceKind =
  | "browser_session"
  | "local_device"
  | "maintainer"
  | "none"
  | "provider_interaction"
  | "runtime_retry"
  | "schedule"
  | "stored_credential";

export interface OwnerActionSurface {
  readonly kind: OwnerActionSurfaceKind;
}

export interface ConnectionConditionRemediation {
  readonly action:
    | "check_runtime"
    | "clear_backlog"
    | "refresh_credentials"
    | "retry_by_runtime"
    | "satisfy_attention"
    | "update_connector"
    | "wait";
  readonly label: string;
  readonly retryable: boolean;
  readonly surface?: OwnerActionSurface;
  readonly target: string | null;
}

export interface ConnectionHealthCondition {
  readonly current: boolean;
  readonly expires_at: string | null;
  readonly id: string;
  readonly message: string;
  readonly observed_at: string | null;
  readonly origin: ConnectionConditionOrigin;
  readonly reason: string;
  /**
   * Closed, sanitized machine-readable cause code (design.md "Orthogonal
   * projection evidence" reason-code vocabulary — e.g. `summary_missing`,
   * `record_checkpoint_lag`, `manifest_unavailable`). `null` for conditions
   * that do not carry evidence-component-level detail; distinct from
   * `reason`, which is the condition's own closed vocabulary
   * (`CONDITION_REASON`) used to build its stable `id`.
   */
  readonly reason_code: string | null;
  readonly remediation: ConnectionConditionRemediation | null;
  readonly sensitivity: ConnectionConditionSensitivity;
  readonly severity: ConnectionConditionSeverity;
  readonly status: ConnectionConditionStatus;
  readonly type: ConnectionConditionType;
}

/** Freshness axis: is the connection's last durable progress within policy? */
export type FreshnessAxis = "fresh" | "stale" | "unknown";

/**
 * Coverage axis: rolled up across all required streams/scopes.
 *
 *   - `complete`        : every required stream has complete evidence
 *   - `partial`         : the last run did not reach a successful terminal state,
 *                         so some required streams' coverage is unproven
 *   - `retryable_gap`   : at least one stream has a pending detail gap with a
 *                         retry path, or a known_gap whose runtime severity is
 *                         `recoverable`/`transient`. The system intends to make
 *                         progress on its own.
 *   - `terminal_gap`    : at least one stream has a known_gap whose runtime
 *                         severity is `actionable` (or an unclassified gap),
 *                         i.e. progress requires owner action / repair.
 *   - `gaps`            : legacy roll-up emitted when gap evidence exists but
 *                         cannot be honestly classified retryable vs terminal.
 *   - `unsupported`     : a required-stream policy is declared `unsupported`
 *                         (the connector implementation cannot collect this
 *                         stream). Accepted-coverage when policy is
 *                         non-required; degrades otherwise.
 *   - `unavailable`     : the upstream source cannot expose the stream for
 *                         this account/configuration. Accepted-coverage
 *                         when policy is non-required.
 *   - `deferred`        : stream collection is intentionally deferred per
 *                         manifest policy.
 *   - `inventory_only`  : only inventory/discovery evidence is collected by
 *                         design; no per-record detail is owed.
 *   - `unknown`         : coverage evidence is missing or unreliable.
 *
 * The `unsupported` / `unavailable` / `deferred` / `inventory_only`
 * values are *accepted-coverage* claims when the manifest declares the
 * stream's `coverage_policy` matches. They are not synonyms for "healthy
 * silently" — the projection only allows them to coexist with a healthy
 * headline when the manifest explicitly accepts the absence. A required
 * stream that is also declared `unsupported` (a contradictory manifest)
 * degrades health rather than projecting green.
 */
export type CoverageAxis =
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

/**
 * Attention axis: rolled up from the structured attention lifecycle.
 *
 *   - `none`         : no open required attention
 *   - `open`         : owner action requested, not yet acknowledged
 *   - `acknowledged` : owner has seen the prompt
 *   - `in_progress`  : owner is actively responding (e.g. OTP entry)
 */
export type AttentionAxis = "acknowledged" | "in_progress" | "none" | "open";

/**
 * Forward disposition: per-stream answer to "what is the next run expected to
 * do on this stream?" for the per-run Collection Report
 * (`define-connector-progress-evidence-contract`).
 *
 *   - `complete`          : no outstanding gap and freshness is fresh or unknown.
 *   - `checking`          : active bounded work is expected to produce coverage
 *                           evidence. This is visibly unknown, but SHALL NOT
 *                           claim a recoverable gap or ask the owner to retry.
 *   - `unmeasured`        : coverage evidence is not available and no active
 *                           work is encoded in this report. This is a resting
 *                           measurement gap, not a checking state.
 *   - `resumable`         : an outstanding gap that ordinary forward collection
 *                           or detail-gap recovery is expected to fill on a later
 *                           run without owner action.
 *   - `awaiting_owner`    : an outstanding gap blocked on structured owner
 *                           attention (credentials, OTP, re-consent, manual step).
 *   - `owner_refresh_due` : no outstanding coverage gap, but retained data is
 *                           stale for a connection that cannot refresh on its own
 *                           (manual / paused / not background-safe), so an
 *                           owner-initiated run is due. Carries the freshness fact
 *                           without re-encoding staleness as a coverage gap.
 *   - `terminal`          : an outstanding gap that no future ordinary run is
 *                           expected to fill without a connector or source change.
 *
 * Coverage completeness and freshness are distinct axes: `owner_refresh_due`
 * keeps the coverage condition `complete` and the freshness axis `stale`. Gaps
 * are evaluated before freshness, so a retryable gap on a stale stream stays
 * `resumable` and is never masked by staleness.
 */
export type ForwardDisposition =
  | "awaiting_owner"
  | "checking"
  | "complete"
  | "owner_refresh_due"
  | "resumable"
  | "terminal"
  | "unmeasured";

/**
 * Outbox / work axis: durable work health for executors that buffer.
 *
 *   - `idle`    : no pending durable work
 *   - `active`  : work is queued or running normally
 *   - `stalled` : leases expired or backlog has stopped draining (degrading)
 *   - `unknown` : outbox evidence is missing or unreliable
 */
export type OutboxAxis = "active" | "idle" | "stalled" | "unknown";

/**
 * Sub-classification of *why* the outbox axis is `stalled`. The axis stays a
 * small four-value enum so existing consumers keep working; the cause carries
 * the distinguishing detail the dashboard needs to avoid one scary "stalled or
 * blocked" message for three genuinely different host-local situations:
 *
 *   - `state_read_failed`  : the device reported a `blocked` heartbeat but has
 *                            no dead letters. The runner refused to advance
 *                            because it could not read prior state (transient
 *                            AS-reach issue, or a removed/inactive source).
 *                            Recovery is to re-run the collector; there is
 *                            nothing to requeue. Mirrors the device-side
 *                            `last_error.kind = "state_read_failed"`.
 *   - `dead_letter_backlog`: the device reported a `blocked` heartbeat *and*
 *                            has dead-lettered rows. Recovery is to retry the
 *                            dead letters, then re-run the collector to drain
 *                            them. Mirrors `last_error.kind =
 *                            "dead_letter_backlog"`.
 *   - `transient_upload_failure`: the device reported dead-lettered rows whose
 *                            complete error summary is transient server/network
 *                            upload failures. The outbox is stalled, but the
 *                            owner cannot fix it; the system should retry.
 *   - `stale_pending`      : pending work exists but the heartbeat has gone
 *                            stale past the freshness threshold, so the
 *                            collector likely died mid-drain. Recovery is to
 *                            re-run the collector on the host.
 *
 * `null` is reserved for non-stalled axes (`idle`/`active`/`unknown`), which
 * never carry a stalled cause.
 */
export type OutboxStalledCause =
  | "dead_letter_backlog"
  | "stale_heartbeat"
  | "stale_pending"
  | "state_read_failed"
  | "transient_upload_failure";

export interface DeadLetterErrorClassEvidence {
  readonly count: number;
  readonly error_class: string;
}

export type OutboxState = "backlog" | "dead_letter" | "drained" | "pending" | "retrying" | "stale" | "unknown";

export interface OutboxDiagnosticCounts {
  readonly backlog_open?: number;
  readonly dead_letter?: number;
  readonly leased?: number;
  readonly oldest_pending_at?: string | null;
  /**
   * `MIN(created_at)` over ready rows that have actually failed at least
   * once (`attempt_count > 0`) — evidence a retry is genuinely stuck, not
   * just that a row is queued. Distinct from `oldest_pending_at`, which
   * also ages with a freshly-enqueued, never-failed row (e.g. a large
   * healthy first drain). Kept for backlog age policy; `oldest_pending_at`
   * remains the ordinary backlog-diagnostics field.
   */
  readonly oldest_retrying_at?: string | null;
  readonly pending?: number;
  readonly retrying?: number;
  readonly stale_leases?: number;
  readonly succeeded?: number;
  readonly total?: number;
}

export function deriveOutboxStateFromDiagnostics(diagnostics: OutboxDiagnosticCounts | null | undefined): OutboxState {
  if (!diagnostics) {
    return "unknown";
  }
  if ((diagnostics.dead_letter ?? 0) > 0) {
    return "dead_letter";
  }
  if ((diagnostics.stale_leases ?? 0) > 0) {
    return "stale";
  }
  if ((diagnostics.retrying ?? 0) > 0) {
    return "retrying";
  }
  if ((diagnostics.pending ?? 0) > 0) {
    return "pending";
  }
  if ((diagnostics.backlog_open ?? 0) > 0) {
    return "backlog";
  }
  return "drained";
}

type OutboxDiagnosticCountField =
  | "backlog_open"
  | "dead_letter"
  | "leased"
  | "pending"
  | "retrying"
  | "stale_leases"
  | "succeeded"
  | "total";

const OUTBOX_DIAGNOSTIC_COUNT_FIELDS: readonly OutboxDiagnosticCountField[] = [
  "backlog_open",
  "dead_letter",
  "leased",
  "pending",
  "retrying",
  "stale_leases",
  "succeeded",
  "total",
];

type OutboxDiagnosticTimestampField = "oldest_pending_at" | "oldest_retrying_at";

const OUTBOX_DIAGNOSTIC_TIMESTAMP_FIELDS: readonly OutboxDiagnosticTimestampField[] = [
  "oldest_pending_at",
  "oldest_retrying_at",
];

/**
 * Roll up several source instances' `OutboxDiagnosticCounts` into one
 * connection-level summary. Pure — no I/O, no clock reads.
 *
 * The numeric count fields are summed; each timestamp field
 * (`oldest_pending_at`, `oldest_retrying_at`) independently takes the
 * earliest non-null value across sources so the connection reports the
 * longest-waiting record/retry. A non-finite or negative count is ignored
 * (treated as absent) rather than poisoning the sum — the store already
 * normalizes counts, but this keeps the helper safe for any caller.
 *
 * Returns `null` when no input carries any numeric count or timestamp, so a
 * connection with only empty/absent diagnostics surfaces no count rollup
 * rather than a misleading all-zero object.
 */
export function rollupOutboxDiagnosticCounts(
  items: readonly (OutboxDiagnosticCounts | null | undefined)[]
): OutboxDiagnosticCounts | null {
  const sums = new Map<OutboxDiagnosticCountField, number>();
  const oldestTimestamps = new Map<OutboxDiagnosticTimestampField, string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    for (const field of OUTBOX_DIAGNOSTIC_COUNT_FIELDS) {
      const value = item[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        continue;
      }
      sums.set(field, (sums.get(field) ?? 0) + value);
    }
    for (const field of OUTBOX_DIAGNOSTIC_TIMESTAMP_FIELDS) {
      const value = item[field];
      const current = oldestTimestamps.get(field);
      if (typeof value === "string" && value.length > 0 && (current === undefined || value < current)) {
        oldestTimestamps.set(field, value);
      }
    }
  }
  if (sums.size === 0 && oldestTimestamps.size === 0) {
    return null;
  }
  const result: OutboxDiagnosticCounts = { ...Object.fromEntries(sums), ...Object.fromEntries(oldestTimestamps) };
  return result;
}

/**
 * Source-pressure detail-gap backlog rollup.
 *
 * The scheduler-managed analogue of the local-device `OutboxDiagnosticCounts`
 * rollup: it answers "how much catch-up is outstanding under source pressure?"
 * for a connection whose run deferred required detail as resumable
 * `DETAIL_GAP` records (reason `upstream_pressure` / `rate_limited`) instead of
 * grinding a throttled account. The numbers are exactly the figures the
 * cross-run cooldown governor (`scheduler-source-pressure-cooldown.ts`) already
 * reasons about; this rollup makes them *visible* on the snapshot without
 * changing any dispatch policy.
 *
 * Honesty contract (see `surface-source-pressure-detail-gap-backlog`):
 *
 *   - The whole object is `null` only when the durable gap evidence cannot be
 *     read (the same fail-open stance the cooldown probe takes). A readable but
 *     empty backlog is a real `0`, never `null` — a UI must be able to tell
 *     "drained" from "unmeasured".
 *   - `pending` is load-bearing and is the count of *pending source-pressure
 *     gaps* only. It is never inferred from collected record counts.
 *   - `pending_is_floor` is `true` when the durable read was bounded and the
 *     returned rows hit that bound, so `pending` is a floor rather than an
 *     exact total. A surface must not present a bounded read as exact.
 *   - `recovered` is optional and `null` when no cheap count-by-status
 *     aggregate is available; otherwise it carries the exact reason-scoped
 *     recovered count supplied by the store projection.
 *   - `max_attempt_count` / `next_attempt_at` mirror the cooldown's
 *     `maxAttemptCount` / earliest gap-authored retry floor. `next_attempt_at`
 *     here is the *backlog's* retry floor (Retry-After / cooldown), which can be
 *     set for a manual connector even when the connection-level
 *     `next_attempt_at` (the scheduler's next automatic dispatch) is `null`.
 *
 * The rollup carries only non-negative integer counts and an optional
 * ISO-8601 timestamp — never a stream body, locator, record payload, source or
 * host name, base URL, token, or per-connector branch.
 */
export interface DetailGapBacklog {
  readonly max_attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly pending: number;
  readonly pending_is_floor: boolean;
  readonly pending_other: number;
  readonly pending_other_is_floor: boolean;
  readonly recovered: number | null;
  /**
   * §10-A/§6.3: count of gaps that are permanently unfillable (404/410/
   * permanent error, recovery budget exhausted). `null` when not computed.
   * When `> 0`, "done" requires acknowledging these — the honest UI copy is
   * "recovered everything still available; N no longer retrievable", never a
   * bare "100% / caught up". Counted separately so terminal gaps neither
   * re-arm the cooldown nor block convergence, and are never silently dropped.
   */
  readonly terminal: number | null;
}

/**
 * Evidence the caller threads in so the projection can expose the
 * source-pressure backlog rollup. The caller (ref-control) reads the durable
 * `connector_detail_gaps` store, decides whether the read was reliable, and
 * passes the bounded pending rows plus the bound it applied. The projection
 * keeps the reason-scoping and floor logic in one pure place
 * ({@link deriveSourcePressureBacklog}); the runtime never reads the store.
 */
export interface ConnectionDetailGapBacklogEvidence {
  /**
   * Bounded list of pending detail gaps for the connection, mapped onto the
   * cooldown governor's `PendingPressureGap` shape. Non-source-pressure gaps
   * MAY be present; {@link deriveSourcePressureBacklog} filters them out so the
   * caller need not pre-filter. Only the `pending`-status rows belong here.
   */
  readonly pendingGaps: readonly PendingPressureGap[];
  /**
   * The `limit` the caller applied when reading the pending gaps. When the
   * bounded read returns this many rows, pending counts are floors
   * (`pending_is_floor` / `pending_other_is_floor`) rather than exact totals.
   * `null`/absent means the read was not bounded (treat the counts as exact).
   */
  readonly readLimit?: number | null;
  /**
   * Optional recovered-gap count from a bounded reason-scoped count-by-status
   * aggregate. `null`/absent when no such aggregate was run; never fabricated.
   */
  readonly recovered?: number | null;
  /**
   * Optional terminal-gap count (§10-A) from a bounded count-by-status
   * aggregate (`status: 'terminal'`). `null`/absent when not computed; never
   * fabricated. Surfaces permanently-unfillable work so the UI tells the truth
   * about 100% (§6.3).
   */
  readonly terminal?: number | null;
  /**
   * `true` when the durable gap evidence could not be read. Mirrors the
   * cooldown probe's fail-open stance: an unreadable store yields a `null`
   * rollup (unmeasured), never a fabricated `0`.
   */
  readonly unreadable: boolean;
}

/**
 * Derive the source-pressure detail-gap backlog rollup from durable gap
 * evidence. Pure — no I/O, no clock reads.
 *
 *   - Returns `null` when the evidence is unreadable (`unreadable: true`).
 *   - Otherwise returns a rollup whose `pending` counts only gaps whose reason
 *     is in {@link SOURCE_PRESSURE_GAP_REASONS}; a readable store with no such
 *     gaps yields a real `0` rollup, distinct from `null`.
 *   - `pending_is_floor` is `true` when a positive read bound was applied and
 *     the count of source-pressure gaps reached it. The bound is the *read*
 *     bound, but the floor flag keys on the source-pressure count actually
 *     observed, because the read returns gaps of every reason and only the
 *     source-pressure subset is counted; reaching the bound means there may be
 *     more pending source-pressure gaps beyond the page.
 *   - `pending_other` counts pending non-source-pressure gaps in the same
 *     bounded read. It is diagnostic honesty only: surfaces use it to avoid
 *     rendering "caught up" while cap/budget-deferred detail gaps remain.
 *   - `max_attempt_count` is the max `attemptCount` across the source-pressure
 *     gaps (mirrors the cooldown governor).
 *   - `next_attempt_at` is the latest gap-authored `nextAttemptAfter` floor
 *     across the source-pressure gaps, or `null` when none is set.
 *   - `recovered` is passed through verbatim (`null` when not computed).
 */
export function deriveSourcePressureBacklog(
  evidence: ConnectionDetailGapBacklogEvidence | null | undefined
): DetailGapBacklog | null {
  if (!evidence || evidence.unreadable) {
    return null;
  }
  const pressureGaps = (evidence.pendingGaps ?? []).filter(
    (gap) => gap && typeof gap.reason === "string" && SOURCE_PRESSURE_GAP_REASONS.has(gap.reason)
  );
  const pending = pressureGaps.length;
  const totalReturned = (evidence.pendingGaps ?? []).length;
  const pendingOther = Math.max(0, totalReturned - pending);
  const maxAttemptCount = pressureGaps.reduce((max, gap) => {
    const attempt = gap.attemptCount;
    if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt < 0) {
      return max;
    }
    return Math.max(max, Math.floor(attempt));
  }, 0);
  const nextAttemptAt = latestNextAttemptAfter(pressureGaps);
  // The read returns gaps of every reason up to `readLimit`. When the *total*
  // returned rows hit that bound, the source-pressure subset may be truncated,
  // even if this page happened to contain zero source-pressure gaps. A full
  // page therefore makes `pending` a floor, never an exact total.
  const readLimit =
    typeof evidence.readLimit === "number" && Number.isFinite(evidence.readLimit) && evidence.readLimit > 0
      ? Math.floor(evidence.readLimit)
      : null;
  const pendingIsFloor = readLimit !== null && totalReturned >= readLimit;
  const pendingOtherIsFloor = pendingOther > 0 && pendingIsFloor;
  const recovered =
    typeof evidence.recovered === "number" && Number.isFinite(evidence.recovered) && evidence.recovered >= 0
      ? Math.floor(evidence.recovered)
      : null;
  const terminal =
    typeof evidence.terminal === "number" && Number.isFinite(evidence.terminal) && evidence.terminal >= 0
      ? Math.floor(evidence.terminal)
      : null;
  return {
    max_attempt_count: maxAttemptCount,
    next_attempt_at: nextAttemptAt,
    pending,
    pending_is_floor: pendingIsFloor,
    pending_other: pendingOther,
    pending_other_is_floor: pendingOtherIsFloor,
    recovered,
    terminal,
  };
}

function latestNextAttemptAfter(gaps: readonly PendingPressureGap[]): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestIso: string | null = null;
  for (const gap of gaps) {
    if (typeof gap.nextAttemptAfter !== "string" || gap.nextAttemptAfter.length === 0) {
      continue;
    }
    const parsed = Date.parse(gap.nextAttemptAfter);
    if (Number.isFinite(parsed) && parsed > latestMs) {
      latestMs = parsed;
      latestIso = gap.nextAttemptAfter;
    }
  }
  return latestIso;
}

/**
 * Remote-surface axis: rolls up the most-urgent browser-surface lease and
 * surface health for a connection.
 *
 *   - `none`     : connector has no managed remote surface (host browser
 *                  or API connector). Routine state; never affects headline.
 *   - `idle`     : connector is managed but has no active lease right now.
 *                  Surfaces may exist but no run is currently leasing one.
 *   - `waiting`  : a lease is queued (e.g. waiting on capacity, surface
 *                  starting). Routine state — does not degrade health.
 *   - `leased`   : a lease is currently held against a ready surface.
 *                  Mirrored on `badges.syncing` when a run is active.
 *   - `failed`   : the most recent non-terminal evidence is a surface
 *                  capacity / readiness / start failure (per design.md:
 *                  "A remote browser surface capacity failure degrades
 *                  the affected connection without changing source
 *                  identity"). Degrades the headline through the
 *                  `degraded` rung when no higher precedence applies.
 *   - `unknown`  : evidence is missing or the store is unreliable.
 */
export type RemoteSurfaceAxis = "failed" | "idle" | "leased" | "none" | "unknown" | "waiting";

/** Connection axes; orthogonal to headline state. */
export interface ConnectionAxes {
  readonly attention: AttentionAxis;
  readonly coverage: CoverageAxis;
  readonly freshness: FreshnessAxis;
  readonly outbox: OutboxAxis;
  readonly remote_surface: RemoteSurfaceAxis;
}

/** Activity badges; never replace the headline pill. */
export interface ConnectionBadges {
  /** Stale freshness — last durable progress is past policy. */
  readonly stale: boolean;
  /** A run or durable work item is currently active for this connection. */
  readonly syncing: boolean;
}

/**
 * Non-secret CTA the dashboard can render when the connection needs the
 * owner to do something. Derived from structured attention evidence by
 * the projection; never carries owner_copy, OTP values, secrets, raw
 * interaction payloads, browser URLs, or attachment refs. The dashboard
 * resolves the actual surface from `action_target` semantics (a stable,
 * non-secret label like `dashboard` / `external_app` / `local_device`).
 *
 * `attention_id` is opaque and safe to expose — it identifies the
 * structured attention record so the dashboard can deep-link to the
 * attention detail view without re-deriving evidence.
 */
export interface NextAction {
  readonly action_target: string | null;
  readonly attention_id: string | null;
  readonly expires_at: string | null;
  /**
   * Durable notification delivery state for the attention prompt
   * driving this CTA. `null` for schedule-fallback CTAs (the precise
   * record is unknown) and for non-attention states. The dashboard
   * uses this to render "we notified you on another device" vs.
   * "delivery failed — open the dashboard" without rereading
   * transport logs. The spec scenario "Notification failure does not
   * cause a run storm" requires this to remain visible even after
   * the push channel rejects delivery.
   */
  readonly notification_state: "acknowledged" | "failed" | "pending" | "sent" | "suppressed" | null;
  readonly owner_action: "act_elsewhere" | "operate_attachment" | "provide_value" | null;
  readonly reason_code: string | null;
  readonly response_contract: "response_required" | "none" | null;
  /**
   * Where the CTA was derived from. `structured` means a durable
   * structured-attention record drove the projection; `schedule_fallback`
   * means only the schedule's `human_attention_needed` flag was
   * available, so the CTA is necessarily coarse and the dashboard should
   * surface a "details unavailable" caveat instead of fabricating
   * precision. `none` is reserved for non-needs-attention states.
   */
  readonly source: "none" | "schedule_fallback" | "structured";
}

/**
 * Diagnostic snapshot of the connection's most-urgent remote-surface
 * lease/surface state. Mirrors the axis with optional detail so the
 * dashboard can render a non-headline badge ("waiting for browser
 * surface", "surface failed: capacity_full") without re-reading the
 * lease store. `null` when the connector is not managed by the
 * remote-surface allocator.
 */
export interface RemoteSurfaceDetail {
  readonly axis: RemoteSurfaceAxis;
  readonly lease_id: string | null;
  readonly lease_status: string | null;
  readonly profile_key: string | null;
  readonly surface_health: "ready" | "starting" | "stopping" | "unhealthy" | null;
  readonly surface_id: string | null;
  readonly wait_reason: string | null;
}

/**
 * Adaptive collection rate controller snapshot, derived by the reference from
 * the connector's `collection_rate` run-trace progress events. Carries only
 * rate numbers and the last back-off reason — no account content, locator,
 * stream body, or per-connector branch. SHALL NOT be exposed to grant-scoped
 * clients (owner-only diagnostic, same policy as `detail_gap_backlog`).
 */
export interface CollectionRateSnapshot {
  /** Rate ceiling: fastest interval (ms) the controller may reach. */
  readonly ceiling_interval_ms: number;
  /** Effective ceiling rate (requests/min). */
  readonly ceiling_rate_per_min: number;
  /** Current learned inter-request interval (ms). */
  readonly current_interval_ms: number;
  /** Current effective rate (requests/min). */
  readonly effective_rate_per_min: number;
  /** Most recent back-off recorded this run, or null when none has fired. */
  readonly last_backoff: {
    readonly at_interval_ms: number;
    readonly reason: string;
  } | null;
}

export interface ConnectionHealthSnapshot {
  readonly axes: ConnectionAxes;
  readonly badges: ConnectionBadges;
  /**
   * Additive, nullable adaptive collection rate controller state
   * ({@link CollectionRateSnapshot}). Derived by the reference from the
   * connector's `collection_rate` run-trace progress events. `null`/omitted
   * when no controller state has been observed (e.g. no recent run, or a
   * reference predating the field). Pure annotation: no classification step
   * reads it; cannot move the headline state or any axis. Owner-only
   * diagnostic. SHALL NOT be exposed to grant-scoped clients.
   */
  readonly collection_rate: CollectionRateSnapshot | null;
  readonly conditions: readonly ConnectionHealthCondition[];
  /**
   * Additive, nullable source-pressure detail-gap backlog rollup
   * ({@link DetailGapBacklog}). `null` when no backlog evidence was supplied
   * or the durable gap store was unreadable; a readable-but-drained backlog is
   * a real `0` pending count. This is owner-only diagnostic scale: it never
   * changes the headline `state`, the coverage/freshness/attention axes, the
   * `forward_disposition`, or `next_action` — those are derived from their
   * existing condition families. It is the scheduler-managed analogue of the
   * local-device outbox-count rollup and is available for manual-refresh
   * connectors that never reach the scheduler `cooling_off` state. Carries only
   * non-negative integer counts and an optional ISO-8601 timestamp; never a
   * stream body, locator, payload, source name, base URL, token, or
   * per-connector branch. SHALL NOT be exposed to grant-scoped clients.
   */
  readonly detail_gap_backlog: DetailGapBacklog | null;
  readonly dominant_condition_id: string | null;
  /**
   * Non-secret current browser-runtime facts. This is owner diagnostic data;
   * the projection itself owns only the runtime axis, not the headline.
   */
  readonly ephemeral_browser_runtime: EphemeralBrowserRuntimeProjection | null;
  /**
   * Connection-level forward disposition: a single owner-facing answer to
   * "what is the next run expected to do?" derived from the coverage,
   * gap-retryability, open-attention, freshness, and refresh-policy evidence
   * the projection already holds. It carries the freshness fact without
   * re-encoding staleness as a coverage gap (`owner_refresh_due`), keeps a
   * retryable gap visible even when stale (`resumable`), and reserves
   * `awaiting_owner` for a real coverage gap blocked on owner attention.
   *
   * This is the connection rollup of the per-stream forward disposition the
   * Collection Report contract defines
   * (`define-connector-progress-evidence-contract`). It reuses the existing
   * coverage/freshness/attention/refresh axes — no new ledger, no protocol
   * change, no new per-run terminal-event field.
   */
  readonly forward_disposition: ForwardDisposition;
  readonly last_success_at: string | null;
  /**
   * Additive, nullable local-device outbox count breakdown carried through
   * from {@link ConnectionOutboxEvidence.counts}. Pure annotation: no
   * classification step reads it, so it cannot move the headline `state`, any
   * axis, any condition, the `forward_disposition`, or `next_action`. It lets
   * the rendered verdict size a dead-letter backlog the system already
   * counted instead of describing it as an unbounded "records". Carries only
   * non-negative integer counts and optional ISO-8601 timestamps; never a
   * stream body, payload, source name, or token. `null` when no trusted
   * device rows stand behind a count.
   */
  readonly local_device_outbox_counts: OutboxDiagnosticCounts | null;
  /** Non-secret CTA. `null` when the connection does not need attention. */
  readonly next_action: NextAction | null;
  readonly next_attempt_at: string | null;
  readonly reason_code: string | null;
  /**
   * Non-headline diagnostic for remote-surface (n.eko) lease/surface
   * state. Mirrors `axes.remote_surface` and is `null` when no evidence
   * was supplied (e.g. host browser / API connectors). Per design.md, a
   * remote-surface capacity failure degrades the connection but does not
   * change source identity — the headline pill still reflects whether
   * the connection itself is healthy, while the surface detail explains
   * the executor-capacity story.
   */
  readonly remote_surface: RemoteSurfaceDetail | null;
  readonly state: ConnectionHealthState;
  readonly supporting_condition_ids: readonly string[];
  /**
   * When `state === "unknown"`, names the evidence source that made the
   * projection unreliable so the UI can show *why*, per spec scenario
   * "Projection evidence is unreliable". Empty otherwise.
   */
  readonly unknown_reasons: readonly string[];
}

// ─── Input evidence shapes ────────────────────────────────────────────────

/**
 * Latest-run evidence summary. The projection only needs the most recent
 * terminal outcome plus whether that run committed gaps. Run history
 * scanning belongs to the caller.
 */
export interface ConnectionRunEvidence {
  readonly hasDegradingGaps: boolean;
  readonly lastSuccessAt: string | null;
  /** `null` when no terminal run has ever completed. */
  readonly latestStatus: "failed" | "succeeded" | null;
  readonly reasonCode: string | null;
}

/**
 * Local-device collection verdict.
 *
 * A local-device collector writes no spine run, so `ConnectionRunEvidence`
 * can never carry a `succeeded` status for it. Its terminal collection
 * evidence is instead the device's own report that it ran and finished
 * cleanly: a trusted idle/drained outbox plus durable coverage diagnostics
 * proving complete coverage. The caller establishes the verdict only when
 * those gates hold AND the connection is local-device-backed
 * (`sourceKind === "local_device"`); the projection trusts the flag and
 * treats `verdict === "succeeded"` as a terminal collection-succeeded
 * outcome equivalent to a run, but only when no run verdict exists (a run
 * is always authoritative). `null`/absent preserves the prior behavior.
 */
export interface ConnectionLocalDeviceCollectionEvidence {
  readonly verdict: "succeeded";
}

/** Scheduler/backoff projection — same shape as `scheduler-backoff.ts`. */
export interface ConnectionBackoffEvidence {
  readonly backoffApplied: boolean;
  readonly consecutiveFailures: number;
  readonly nextRunAt: string | null;
  readonly reasonClass: string | null;
}

/**
 * Structured attention evidence (single most-urgent open prompt).
 *
 * Lifecycle states `resolved`, `expired`, `cancelled`, `superseded` are
 * NOT passed in — they are not "open" attention. The caller filters.
 *
 * `id`, `ownerAction`, `responseContract`, and `sensitivity` are the
 * subset of `AttentionRecord` the projection needs to emit a non-secret
 * `NextAction` CTA. Callers may pass `null` for fields that are not
 * available (e.g. when synthesizing fallback evidence from a schedule's
 * `human_attention_needed` flag rather than from durable attention
 * records); the projection will downgrade the CTA accordingly.
 */
export interface ConnectionAttentionEvidence {
  readonly actionTarget: string | null;
  readonly expiresAt: string | null;
  readonly id: string | null;
  readonly lifecycle: "acknowledged" | "in_progress" | "open";
  /**
   * Durable notification delivery state for the prompt. Forwarded to
   * `NextAction.notification_state`. `null` for fallback evidence
   * synthesized from `human_attention_needed` (no structured record
   * exists, so delivery state is unknown).
   */
  readonly notificationState?: "acknowledged" | "failed" | "pending" | "sent" | "suppressed" | null;
  readonly ownerAction: "act_elsewhere" | "operate_attachment" | "provide_value" | null;
  readonly reasonCode: string | null;
  readonly responseContract: "response_required" | "none" | null;
  /** Causative run id for structured attention, when known. */
  readonly runId: string | null;
  /**
   * Caller has already filtered with `attention.isHealthRelevant`. Marked
   * here for documentation; the projection trusts the filter.
   *
   * `sensitivity` is read so the `next_action` CTA can be suppressed for
   * `secret` records (owner copy / OTP value etc. must never appear in
   * the operator payload).
   */
  readonly sensitivity?: "non_secret" | "none" | "secret";
}

/** Coverage rollup. Caller aggregates per-stream evidence into one axis. */
export interface ConnectionCoverageEvidence {
  readonly axis: CoverageAxis;
  /**
   * `true` when the rollup emitted an accepted-coverage axis
   * (`unsupported`/`unavailable`/`deferred`/`inventory_only`) because of a
   * required stream — i.e. the manifest is contradictory (`required:
   * true` + accepted-absent policy). The projection treats this as
   * degrading, because a load-bearing stream is unaccounted for even
   * though the axis surface names the accepted label.
   *
   * Optional; absent means "the accepted-coverage axis, if any, applies
   * only to non-required streams and does not block healthy".
   */
  readonly requiredButAccepted?: boolean;
  /**
   * `true` only when EVERY outstanding gap behind a `terminal_gap` axis is
   * backed by durable, per-item evidence that the item can never be
   * collected — not merely that recovery has been attempted and failed.
   *
   * The canonical example is Gmail's `attachments` stream: an attachment
   * whose `size_bytes` exceeds the connector's byte cap is a permanent,
   * by-policy skip the connector itself already counts as covered in its
   * own per-run `DETAIL_COVERAGE` accounting (`optionalSkipKeys`) — the
   * gate condition here is just catching up to evidence the connector
   * already has. `size_bytes > max_bytes` is a durable fact recorded once;
   * it does not change on retry, so retrying can never resolve it.
   *
   * This is DELIBERATELY NOT satisfied by "we retried N times and it kept
   * failing", however large N is (see `temporary_unavailable`'s attempt
   * count). Attempt exhaustion proves the current strategy hasn't worked;
   * it does not prove the item is impossible. Only a caller with concrete,
   * per-item durable evidence of impossibility (a recorded byte size against
   * a recorded limit, a provider 410 Gone, etc.) may set this `true` — never
   * an inferred, absent-answer, or attempt-count heuristic. Setting this from
   * a missing answer manufactures exactly the false green
   * `design-notes/source-state-truth-2026-08-18.md`'s safety property
   * forbids.
   *
   * Optional; absent/`false` preserves the shipped behavior exactly — a
   * `terminal_gap` axis blocks `SourceCoverageComplete` regardless of
   * `requiredButAccepted`. Ignored for every axis other than `terminal_gap`;
   * `unsupported`/`unavailable` already have their own accepted-coverage
   * path and a caller has no reason to combine the two.
   */
  readonly unfillableAccounted?: boolean;
  /**
   * `true` when `axis === "unknown"` specifically because a local-device
   * collector's committed coverage snapshot is missing a store the current
   * descriptor authority requires (`deriveLocalCoverageAxis`'s
   * `unreliableReason === "missing_stores"` in `ref-control.ts`) — the
   * collector build genuinely predates the server's coverage requirements
   * and never measured those stores at all. Distinct from every other
   * `unknown` cause (no evidence yet, a stale generation, a malformed
   * snapshot): this one names a concrete, owner-actionable fix (update the
   * collector) instead of leaving the owner to guess why a connection that
   * is visibly collecting still reads "coverage evidence is missing".
   * Optional/absent preserves the prior generic `unknown` message for every
   * other cause.
   */
  readonly unknownStaleCollectorBuild?: boolean;
}

/** Outbox/work rollup from local collector or other durable executor. */
export interface ConnectionOutboxEvidence {
  readonly axis: OutboxAxis;
  /**
   * When `axis === "stalled"`, the distinguishing cause so the projection can
   * render a specific, non-scary message and a cause-matched remediation
   * instead of one generic "stalled or blocked". Ignored for non-stalled
   * axes; absent/`null` means "stalled, cause unknown" and falls back to the
   * generic copy.
   */
  readonly cause?: OutboxStalledCause | null;
  /**
   * The already-rolled-up local-device outbox breakdown
   * (`rollupOutboxDiagnosticCounts` over the trusted heartbeat rows). Purely
   * additive annotation: NO classification step reads it, so it cannot move an
   * axis, a condition, the headline state, or the cause. It exists so the
   * owner-facing remediation summary can BOUND a dead-letter backlog the
   * system already counted — "1 of 10,001" and "8,432 of 10,001" demand
   * completely different reactions, and telling the owner only "records"
   * leaves a known magnitude invisible.
   *
   * Absent/`null` when no trusted device rows stand behind a count. The
   * renderer must fall back to uncounted wording rather than fabricate a
   * zero; see `deadLetterMagnitude` in `rendered-verdict.ts`.
   */
  readonly counts?: OutboxDiagnosticCounts | null;
}

/**
 * Freshness evidence. The caller compares last-successful-progress against
 * the configured freshness policy and emits `fresh | stale | unknown`.
 */
export interface ConnectionFreshnessEvidence {
  readonly axis: FreshnessAxis;
}

/**
 * Acquisition-completeness evidence: whether this connection's data collection
 * is FINISHED by design rather than recurring.
 *
 * A one-time import (`source_kind = 'manual'`) ingests a file the owner
 * supplied and then never collects again. Google Maps Timeline Import holds
 * 299,248 records and WhatsApp-brennan holds 120,042; both have zero rows in
 * `run_history` and no schedule, because there is nothing left to run. Their
 * data is not stale — it is *final*. Asking "is it current?" of a completed
 * import is a category error, and the shipped model answers it `unknown`
 * forever, which the owner reads as "broken".
 *
 * `complete: true` makes freshness `not_applicable` (a settled answer) instead
 * of `unknown` (a pending one), and lets the healthy predicate accept the
 * absence of a freshness proof it can never obtain. It deliberately does NOT
 * relax coverage: a completed import must still prove it ingested what it
 * claimed, so a gap or unknown coverage keeps it out of green.
 *
 * Omit/`null` for every recurring source. That preserves the shipped behavior
 * exactly — staleness still degrades a source the system was supposed to
 * refresh and did not.
 */
export interface ConnectionAcquisitionEvidence {
  readonly complete: boolean;
}

/**
 * Projection-reliability evidence. The caller names every required read
 * model and whether it is currently reliable. Any unreliable required
 * source forces the headline state to `unknown`.
 */
export interface ConnectionProjectionEvidence {
  readonly unreliableSources: readonly string[];
}

/** Schedule policy — only need pause status. */
export interface ConnectionScheduleEvidence {
  readonly enabled: boolean;
}

/**
 * Manifest refresh-policy evidence the projection needs to tell a
 * schedulable/background-safe connection apart from one that is
 * intentionally manual, paused, or background-unsafe.
 *
 * A connector is **manual-refresh-only** when its manifest refresh policy
 * declares `background_safe: false`, `recommended_mode: "manual"`, or
 * `recommended_mode: "paused"` — the refresh-policy values the schedule
 * auto-enroll gate already uses to deny it a background schedule
 * (`auto-enroll-eligible-schedules.ts`). Such a
 * connector cannot make progress on its own: only an owner-initiated run
 * advances its data. The projection trusts these flags from the caller and
 * never re-reads the manifest.
 *
 * The projection uses this only to keep the **freshness** axis honest: a
 * manual-refresh-only connector whose data has aged past its staleness
 * window has not failed — it is simply awaiting a manual run. That surfaces
 * as an owner-action / manual-refresh advisory (an `idle` headline plus the
 * `stale` badge), not a `degraded` pill. A schedulable/background-safe
 * connector still degrades on the same staleness, because the system was
 * supposed to refresh it and did not. Both `null`/absent fields preserve
 * the prior behavior (treated as schedulable).
 *
 * A connector is **assisted-refresh** when it is schedulable
 * (`recommended_mode` automatic/absent and `background_safe !== false`) but
 * its `interaction_posture` predicts the connector will periodically need
 * bounded owner help (credentials, an OTP, or a manual action) before a
 * scheduled refresh can complete — the same posture the run-automation policy
 * projects as `automation_mode: "assisted"` (`run-automation-policy.ts`). Such
 * a connector DOES refresh on its own schedule, so it is not manual-refresh-
 * only; but when its data ages past the staleness window it may simply be
 * between scheduled refreshes awaiting the bounded assistance the manifest
 * itself predicts. Surfacing that as `degraded` — identical to a genuinely
 * broken unattended connector — is dishonest. The projection therefore treats
 * assisted-refresh staleness as the same kind of owner-action advisory it
 * gives a manual connector (an `idle` headline plus the `stale` badge), but
 * only when the connector is otherwise green; every real failure, incomplete
 * coverage, or open attention still degrades or blocks. `interactionPosture`
 * `null`/absent preserves the prior behavior (an automatic/background-safe
 * connector with no assistance posture degrades on staleness, because the
 * system was supposed to refresh it unattended and did not).
 */
export interface ConnectionRefreshEvidence {
  readonly backgroundSafe: boolean | null;
  readonly interactionPosture?: "credentials" | "manual_action_likely" | "none" | "otp_likely" | null;
  readonly recommendedMode: "automatic" | "manual" | "paused" | null;
}

/**
 * Remote-surface evidence rolled up across the connection's most-urgent
 * lease/surface state. The caller (ref-control) reads the durable
 * browser-surface lease store and decides which lease wins; the
 * projection trusts that pick.
 *
 * Carrying details (`leaseId`, `surfaceId`, `waitReason`, `profileKey`)
 * lets the dashboard render a non-headline diagnostic without re-reading
 * the store. They are intentionally non-secret: lease ids and profile
 * keys are opaque identifiers, not credentials.
 */
export interface ConnectionRemoteSurfaceEvidence {
  readonly axis: RemoteSurfaceAxis;
  readonly leaseId: string | null;
  readonly leaseStatus: string | null;
  readonly profileKey: string | null;
  readonly surfaceHealth: "ready" | "starting" | "stopping" | "unhealthy" | null;
  readonly surfaceId: string | null;
  readonly waitReason: string | null;
}

/** Active-work signal for the syncing badge. */
export interface ConnectionActivityEvidence {
  readonly active: boolean;
}

/**
 * Durable stored-credential presence evidence for a connection whose connector
 * can store a credential (a static-secret-capable connector). It is derived from
 * the connector-instance credential store, not from a transient run reason code,
 * so the credential-readiness condition can honestly distinguish "no usable
 * stored credential" (`present: false`) from "stored credential the provider
 * rejected" (`present: true, rejected: true`). Omit/`null` when the connector
 * cannot store a credential or the store was not consulted — the projection then
 * preserves its prior run-reason-derived behavior.
 */
export interface ConnectionCredentialEvidence {
  /** True when the connector can store a credential for this connection. */
  readonly capable: boolean;
  /** True when an active (non-rejected, non-revoked) stored credential exists. */
  readonly present: boolean;
  /** True when a stored credential exists but the provider rejected it. */
  readonly rejected?: boolean;
}

/**
 * Authentication-applicability evidence: whether this connection authenticates
 * to a provider AT ALL.
 *
 * A file-import connector (`setup.modality = 'manual_or_upload'` with no
 * `setup.credential_capture`) parses an artifact the owner already exported and
 * handed over. It holds no credential, opens no session, and contacts no
 * provider — Google Maps Timeline Import and WhatsApp both ingest a local file.
 * There is no authentication to probe, so "are the credentials valid?" has no
 * referent for them. The shipped projection answers it `credentials_not_probed`
 * / `unknown` forever, which reads as an outstanding question that no owner
 * action and no future run can ever close.
 *
 * `authenticates: false` makes `CredentialsValid` `not_applicable` — a settled
 * answer that the question does not apply — instead of `unknown`, a pending one.
 * This is the same distinction {@link ConnectionAcquisitionEvidence} draws for
 * freshness, and it obeys the same safety property: inapplicability may only
 * come from durable evidence that the question is MEANINGLESS, never from the
 * mere absence of an answer. A connector that authenticates but has simply not
 * been probed yet keeps its honest `unknown`.
 *
 * This deliberately grants no exemption from coverage. An import must still
 * prove it ingested what it claimed; see `sourceCoverageCondition`.
 *
 * Omit/`null` for every connector that authenticates, preserving the shipped
 * behavior exactly.
 */
export interface ConnectionAuthenticationEvidence {
  readonly authenticates: boolean;
}

export interface ComputeConnectionHealthInput {
  /**
   * Acquisition-completeness evidence. Present and `complete` only for sources
   * whose collection is finished by design (one-time imports). See
   * {@link ConnectionAcquisitionEvidence}.
   */
  readonly acquisition?: ConnectionAcquisitionEvidence | null;
  readonly activity: ConnectionActivityEvidence | null;
  readonly attention: ConnectionAttentionEvidence | null;
  /**
   * Authentication-applicability evidence. Present and `authenticates: false`
   * only for connectors that contact no provider (file imports). See
   * {@link ConnectionAuthenticationEvidence}.
   */
  readonly authentication?: ConnectionAuthenticationEvidence | null;
  readonly backoff: ConnectionBackoffEvidence | null;
  /**
   * True when this connection has a browser/session repair path. This is a
   * durable connection/runtime capability, not evidence that a browser surface
   * is leased or active right now. The projection intentionally trusts this
   * caller-provided fact rather than reading manifests or runtime state itself.
   *
   * A `session_required` run reason selects browser-session repair only when
   * this is true. Omit it for connectors without a proven browser repair path;
   * that preserves the stored-credential route for otherwise ambiguous session
   * strings.
   */
  readonly browserSessionRepairCapable?: boolean;
  readonly browserSurfaceRepair?: BrowserSurfaceRepairContext | null;
  /**
   * Adaptive collection rate controller snapshot. Passed through verbatim from
   * the caller (the reference derives it from run-trace progress events). Pure
   * annotation: no classification step reads it, so it cannot move the headline
   * state or any axis. `null`/absent yields a `null` rollup on the snapshot.
   */
  readonly collectionRate?: CollectionRateSnapshot | null;
  readonly coverage: ConnectionCoverageEvidence | null;
  /**
   * Durable stored-credential presence evidence. When provided, it lets the
   * credential-readiness condition distinguish "no usable stored credential"
   * from "stored credential rejected" and keeps the credential axis from healing
   * merely because a credential-shaped run reason code aged out. Omit/`null`
   * preserves the prior run-reason-derived behavior.
   */
  readonly credential?: ConnectionCredentialEvidence | null;
  /**
   * Source-pressure detail-gap backlog evidence. The projection derives the
   * additive {@link DetailGapBacklog} rollup from it via
   * {@link deriveSourcePressureBacklog} and attaches it to the snapshot. It is
   * pure annotation: no classification step reads it, so it cannot move the
   * headline state or any axis. `null`/absent yields a `null` rollup.
   */
  readonly detailGapBacklog?: ConnectionDetailGapBacklogEvidence | null;
  readonly ephemeralBrowserRuntime?: EphemeralBrowserRuntimeProjection | null | undefined;
  readonly freshness: ConnectionFreshnessEvidence | null;
  /**
   * True when this connection collects through an enrolled local-device
   * collector, so the local-device outbox axis is a question this deployment can
   * actually answer. Server-side connectors (a browser-backed Reddit connection,
   * for example) have no local collector component at all, and their outbox axis
   * stays `unknown` forever — not because evidence is missing, but because there
   * is no exporter to report one.
   *
   * The projection uses this only to distinguish "no outbox evidence yet" from
   * "this connection has no outbox", which selects `not_applicable` instead of
   * `unknown` for `BacklogClear` / `LocalExporterAvailable`. It never changes the
   * axis, the headline state, or any remediation. Omit/`false` preserves the
   * prior `unknown` behavior for callers that do not know the binding.
   */
  readonly localDeviceBacked?: boolean;
  readonly localDeviceCollection?: ConnectionLocalDeviceCollectionEvidence | null;
  readonly observedAt?: string | null;
  readonly outbox: ConnectionOutboxEvidence | null;
  readonly projection: ConnectionProjectionEvidence | null;
  readonly refresh?: ConnectionRefreshEvidence | null;
  readonly remoteSurface?: ConnectionRemoteSurfaceEvidence | null;
  readonly run: ConnectionRunEvidence | null;
  readonly schedule: ConnectionScheduleEvidence | null;
}

export interface BrowserSurfaceRepairContext {
  readonly connectionId: string;
  readonly evidence: BrowserSurfaceRepairEvidence;
  readonly provider: string;
  readonly repairedProofKeys?: ReadonlySet<string> | readonly string[];
}

// ─── Projection ───────────────────────────────────────────────────────────

interface ClassificationContext {
  readonly axes: ConnectionAxes;
  readonly badges: ConnectionBadges;
  readonly conditionSet: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>;
  readonly conditions: readonly ConnectionHealthCondition[];
  readonly input: ComputeConnectionHealthInput;
  readonly lastSuccessAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly remoteSurface: RemoteSurfaceDetail | null;
}

type ClassificationStep = (
  ctx: ClassificationContext
) => Omit<SnapshotArgs, "conditions" | "dominantConditionId" | "forwardDisposition" | "supportingConditionIds"> | null;

// Ordered precedence: each step returns a snapshot args object when it claims
// the verdict, otherwise null and we fall through to the next step. The order
// encodes UI policy: unreliable evidence beats current owner action beats
// owner pause beats blocking conditions beats retry exhaustion beats degrading
// evidence beats passive backoff beats no-verdict beats healthy. Backoff is
// allowed to claim `cooling_off` only when the evidence-positive degrading
// predicate has no independent collection/runtime failure to report.
const HEALTH_CLASSIFICATION_STEPS: readonly ClassificationStep[] = [
  classifyUnreliableProjection,
  classifyOpenAttention,
  classifyOwnerPaused,
  classifyReadinessBlocked,
  classifyRetryPolicyExhausted,
  classifyDegradedEvidence,
  classifyCoolingOff,
  classifyCurrentEvidenceWithoutVerdict,
  classifyCurrentManagedRuntimeUnknown,
  classifyCurrentManagedRemoteSurfaceUnknown,
  classifyManualStaleAdvisory,
  classifyAssistedStaleAdvisory,
  classifyNeverRunIdle,
  classifyHealthy,
];

export function computeConnectionHealth(input: ComputeConnectionHealthInput): ConnectionHealthSnapshot {
  const axes = projectAxes(input);
  const badges = projectBadges(input, axes);
  const conditions = projectConditions(input, axes);
  const conditionSet = indexConditions(conditions);
  const forwardDisposition = deriveConnectionForwardDisposition(input, conditionSet);
  const collectionRate = input.collectionRate ?? null;
  const detailGapBacklog = deriveSourcePressureBacklog(input.detailGapBacklog ?? null);
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const ephemeralBrowserRuntime = input.ephemeralBrowserRuntime;
  const remoteSurface = projectRemoteSurfaceDetail(input.remoteSurface ?? null);
  const localDeviceOutboxCounts = input.outbox?.counts ?? null;
  const lastSuccessAt = input.run?.lastSuccessAt ?? null;
  const nextAttemptAt = conditionExpired(input.backoff?.nextRunAt ?? null, input.observedAt ?? null)
    ? null
    : (input.backoff?.nextRunAt ?? null);
  const ctx: ClassificationContext = {
    axes,
    badges,
    conditionSet,
    conditions,
    input,
    lastSuccessAt,
    nextAttemptAt,
    remoteSurface,
  };
  const finishWith = (
    args: Omit<SnapshotArgs, "conditions" | "dominantConditionId" | "forwardDisposition" | "supportingConditionIds">
  ): ConnectionHealthSnapshot => {
    const dominantConditionId = pickDominantConditionId(args.state, conditions);
    return snapshot({
      ...args,
      collectionRate,
      conditions,
      detailGapBacklog,
      dominantConditionId,
      ephemeralBrowserRuntime,
      forwardDisposition,
      // Attached at the single funnel every classification step returns
      // through, so the annotation rides along without any step being able to
      // classify on it.
      localDeviceOutboxCounts,
      supportingConditionIds: pickSupportingConditionIds(conditions, dominantConditionId),
    });
  };
  for (const step of HEALTH_CLASSIFICATION_STEPS) {
    const args = step(ctx);
    if (args) {
      return finishWith(args);
    }
  }
  // Fallback -> unknown. Reached when evidence combinations don't line up
  // cleanly (e.g. succeeded run but coverage axis is unknown).
  return finishWith({
    axes,
    badges,
    lastSuccessAt,
    nextAttemptAt,
    reasonCode: null,
    remoteSurface,
    state: "unknown",
    unknownReasons: ["unclassified"],
  });
}

function classifyUnreliableProjection(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 1. Projection unreliable -> unknown. Highest precedence so the UI never
  //    paints a confident pill on top of broken evidence.
  if (ctx.conditionSet.get("ProjectionReliable")?.status !== "false") {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: null,
    remoteSurface: ctx.remoteSurface,
    state: "unknown",
    unknownReasons: canonicalProjectionUnreliableSources(ctx.input.projection?.unreliableSources ?? []),
  };
}

function classifyOpenAttention(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 2. Required attention open -> needs_attention. Current owner action is
  //    actionable even before the first terminal run exists.
  const attention = ctx.conditionSet.get("AttentionClear");
  if (attention?.status !== "false") {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAction: ctx.input.attention ? projectNextAction(ctx.input.attention) : null,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: attention.reason,
    remoteSurface: ctx.remoteSurface,
    state: "needs_attention",
  };
}

function classifyOwnerPaused(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 3. Owner-paused -> idle. Manual pause beats run/coverage/backoff state
  //    because the system is intentionally not making progress.
  if (ctx.conditionSet.get("ScheduleEligible")?.status !== "false") {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: null,
    reasonCode: null,
    remoteSurface: ctx.remoteSurface,
    state: "idle",
  };
}

function classifyReadinessBlocked(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  const blocker = readinessBlockedCondition(ctx.conditions);
  if (!blocker) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: blocker.reason,
    remoteSurface: ctx.remoteSurface,
    state: "blocked",
  };
}

function classifyRetryPolicyExhausted(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 4. Give-up streak crossed -> blocked.
  const retryPolicy = ctx.conditionSet.get("RetryPolicyClear");
  if (!(retryPolicy?.status === "false" && retryPolicy.severity === "blocked")) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: retryPolicy.reason,
    remoteSurface: ctx.remoteSurface,
    state: "blocked",
  };
}

function classifyCoolingOff(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // Backoff currently delaying retry -> cooling_off, but only when it is the
  // sole degrading evidence. Collection, coverage, freshness, and runtime
  // failures are more informative than the scheduler's retry timing. Manual-
  // only unscheduled connectors expose RetryPolicyClear as not_applicable, so
  // they naturally fall through to healthy or the manual stale advisory.
  const retryPolicy = ctx.conditionSet.get("RetryPolicyClear");
  if (
    retryPolicy?.status !== "false" ||
    !hasAffirmativePassiveRecoveryEvidence({
      axes: ctx.axes,
      conditions: ctx.conditions,
      next_attempt_at: ctx.nextAttemptAt,
    })
  ) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: retryPolicy.reason,
    remoteSurface: ctx.remoteSurface,
    state: "cooling_off",
  };
}

function classifyDegradedEvidence(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // Outbox stalled, coverage incomplete, gaps present, or last run failed
  //    -> degraded. Success-with-gaps must not be healthy.
  if (!hasIndependentDegradingEvidence(ctx.conditions)) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: degradedReasonCode(ctx.input),
    remoteSurface: ctx.remoteSurface,
    state: "degraded",
  };
}

function classifyCurrentEvidenceWithoutVerdict(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 6b. If fresh retained/source evidence exists but no terminal collection
  //     verdict exists, the health verdict is unknown, not idle. Local outbox
  //     availability and active draining are orthogonal axis evidence.
  if (
    !(
      ctx.conditionSet.get("CollectionSucceeded")?.status === "unknown" &&
      hasFreshEvidenceWithoutCollectionVerdict(ctx.conditionSet) &&
      !hasActiveLocalDeviceProgressWithoutCollectionVerdict(ctx.conditionSet)
    )
  ) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: null,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: null,
    remoteSurface: ctx.remoteSurface,
    state: "unknown",
    unknownReasons: ["collection"],
  };
}

function classifyCurrentManagedRemoteSurfaceUnknown(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  if (ctx.remoteSurface?.axis !== "unknown") {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: null,
    remoteSurface: ctx.remoteSurface,
    state: "unknown",
    unknownReasons: ["remote_surface"],
  };
}

function classifyCurrentManagedRuntimeUnknown(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  if (!managedRuntimeIsUnknown(ctx)) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: null,
    remoteSurface: ctx.remoteSurface,
    state: "unknown",
    unknownReasons: ["runtime"],
  };
}

function managedRuntimeIsUnknown(ctx: ClassificationContext): boolean {
  const runtime = ctx.input.ephemeralBrowserRuntime;
  return (
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    runtime?.surface_mode !== undefined &&
    runtime.surface_mode !== "none" &&
    ctx.conditionSet.get("RuntimeAvailable")?.status === "unknown"
  );
}

/**
 * Shared body for the two non-degrading stale advisories (manual and
 * assisted). A connector that cannot or may-not refresh purely on its own and
 * whose data has aged past the staleness window is `idle` with a stale
 * advisory, NOT degraded — but only when it is otherwise green. Reaching this
 * step already means no degrading condition fired (`classifyDegradedEvidence`
 * ran first), so coverage is complete, the last collection succeeded, the
 * outbox is not stalled, and no credential/runtime/attention/backoff blocker
 * exists. The only non-green signal is the `info`-severity stale `Fresh`
 * condition carrying `expectedReason`. We require the `CollectionSucceeded` and
 * `SourceCoverageComplete` proofs explicitly so a never-run or unproven
 * connection can never be reclassified out of `unknown`/`idle` by this step.
 */
function classifyStaleAdvisory(
  ctx: ClassificationContext,
  applies: boolean,
  expectedReason: SharedConnectionConditionReason
): ReturnType<ClassificationStep> {
  if (!applies) {
    return null;
  }
  const fresh = ctx.conditionSet.get("Fresh");
  if (fresh?.status !== "false" || fresh.reason !== expectedReason) {
    return null;
  }
  if (
    !(
      conditionIsTrue(ctx.conditionSet, "CollectionSucceeded") &&
      conditionIsTrue(ctx.conditionSet, "SourceCoverageComplete")
    )
  ) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: expectedReason,
    remoteSurface: ctx.remoteSurface,
    state: "idle",
  };
}

function classifyManualStaleAdvisory(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 6b'. Manual / paused / background-unsafe connector that is otherwise green
  //      but whose data has aged past its staleness window -> idle with a
  //      manual-refresh advisory, NOT degraded.
  return classifyStaleAdvisory(
    ctx,
    isManualRefreshOnly(ctx.input.refresh) && !isExplicitOwnerScheduledManual(ctx.input.refresh, ctx.input.schedule),
    CONDITION_REASON.STALE_MANUAL_REFRESH
  );
}

function classifyAssistedStaleAdvisory(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 6b''. Assisted-refresh connector (schedulable, but its interaction_posture
  //       predicts bounded owner help) that is otherwise green but whose data
  //       has aged past its staleness window -> idle with an assisted-refresh
  //       advisory, NOT degraded. It refreshes on schedule and may simply be
  //       between refreshes awaiting the bounded assistance the manifest
  //       predicts; that is honest operation, not a failure. Every real failure
  //       still degraded/blocked above via the ordered precedence.
  return classifyStaleAdvisory(ctx, isAssistedRefresh(ctx.input.refresh), CONDITION_REASON.STALE_ASSISTED_REFRESH);
}

function classifyNeverRunIdle(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 6c. Never run (no terminal evidence yet) -> idle only when no stronger
  //     current evidence exists.
  if (ctx.conditionSet.get("CollectionSucceeded")?.status !== "unknown") {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: null,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: null,
    remoteSurface: ctx.remoteSurface,
    state: "idle",
  };
}

function classifyHealthy(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 7. Healthy requires last run succeeded with no degrading gaps, coverage
  //    complete (not unknown), and fresh freshness (stale is never silently
  //    healthy).
  if (!isHealthyConditionSet(ctx.conditionSet)) {
    return null;
  }
  return {
    axes: ctx.axes,
    badges: ctx.badges,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    reasonCode: null,
    remoteSurface: ctx.remoteSurface,
    state: "healthy",
  };
}

function hasFreshEvidenceWithoutCollectionVerdict(
  conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>
): boolean {
  return conditionIsTrue(conditions, "Fresh");
}

function hasActiveLocalDeviceProgressWithoutCollectionVerdict(
  conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>
): boolean {
  const outbox = conditions.get("BacklogClear");
  return (
    conditionIsTrue(conditions, "LocalExporterAvailable") &&
    outbox?.status === "false" &&
    outbox.reason === CONDITION_REASON.OUTBOX_ACTIVE &&
    outbox.severity === "info"
  );
}

// ─── Axis projection ──────────────────────────────────────────────────────

function projectAxes(input: ComputeConnectionHealthInput): ConnectionAxes {
  return {
    attention: input.attention ? input.attention.lifecycle : "none",
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    coverage: input.coverage?.axis ?? "unknown",
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    freshness: input.freshness?.axis ?? "unknown",
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    outbox: input.outbox?.axis ?? "unknown",
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    remote_surface: input.remoteSurface?.axis ?? "none",
  };
}

function projectRemoteSurfaceDetail(evidence: ConnectionRemoteSurfaceEvidence | null): RemoteSurfaceDetail | null {
  if (!evidence) {
    return null;
  }
  return {
    axis: evidence.axis,
    lease_id: evidence.leaseId,
    lease_status: evidence.leaseStatus,
    profile_key: evidence.profileKey,
    surface_health: evidence.surfaceHealth,
    surface_id: evidence.surfaceId,
    wait_reason: evidence.waitReason,
  };
}

function projectBadges(input: ComputeConnectionHealthInput, axes: ConnectionAxes): ConnectionBadges {
  return {
    stale: axes.freshness === "stale",
    syncing: Boolean(input.activity?.active),
  };
}

function indexConditions(
  conditions: readonly ConnectionHealthCondition[]
): ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition> {
  return new Map(conditions.map((item) => [item.type, item]));
}

function conditionIsFalse(
  conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>,
  type: ConnectionConditionType
): boolean {
  return conditions.get(type)?.status === "false";
}

function conditionIsTrue(
  conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>,
  type: ConnectionConditionType
): boolean {
  return conditions.get(type)?.status === "true";
}

function isDegradingCondition(item: ConnectionHealthCondition): boolean {
  if (item.status !== "false") {
    return false;
  }
  if (item.type === "BacklogClear" && item.severity === "info") {
    return false;
  }
  if (item.type === "ScheduleEligible" || item.type === "AttentionClear" || item.type === "RetryPolicyClear") {
    return false;
  }
  if (item.type === "CredentialsValid") {
    return false;
  }
  return item.severity === "warning" || item.severity === "error" || item.severity === "blocked";
}

/**
 * The evidence-positive passive-recovery authority shared by the connection
 * classifier and downstream owner/fleet projections. Backoff timing is not
 * enough: collection, complete coverage, freshness, an enabled schedule, and
 * a clear owner/runtime boundary must all be current affirmative evidence.
 */
export function hasAffirmativePassiveRecoveryEvidence(
  evidence: Pick<ConnectionHealthSnapshot, "axes" | "conditions" | "next_attempt_at">
): boolean {
  const hasCurrentCondition = (type: ConnectionConditionType, status: ConnectionHealthCondition["status"]): boolean =>
    evidence.conditions.some(
      (candidate) => candidate.current && candidate.type === type && candidate.status === status
    );
  const blockerTypes: readonly ConnectionConditionType[] = [
    "CredentialsValid",
    "ProjectionReliable",
    "RuntimeAvailable",
    "RemoteSurfaceAvailable",
    "LocalExporterAvailable",
  ];
  return (
    evidence.axes.coverage === "complete" &&
    evidence.axes.freshness === "fresh" &&
    evidence.next_attempt_at !== null &&
    hasCurrentCondition("CollectionSucceeded", "true") &&
    hasCurrentCondition("SourceCoverageComplete", "true") &&
    hasCurrentCondition("Fresh", "true") &&
    hasCurrentCondition("ScheduleEligible", "true") &&
    hasCurrentCondition("AttentionClear", "true") &&
    !hasIndependentDegradingEvidence(evidence.conditions) &&
    !blockerTypes.some((type) => hasCurrentCondition(type, "false"))
  );
}

/**
 * The evidence-positive health authority shared by scheduler and fleet
 * projections. Policy-only conditions (`RetryPolicyClear`, `ScheduleEligible`,
 * and `AttentionClear`) do not make a connection degraded; collection,
 * coverage, freshness, runtime, and terminal evidence do.
 */
export function hasIndependentDegradingEvidence(conditions: readonly ConnectionHealthCondition[]): boolean {
  return conditions.some(isDegradingCondition);
}

/**
 * A required condition is satisfied when it is affirmatively `true`, or when it
 * is `not_applicable` — a settled answer that the question does not apply to
 * this connection.
 *
 * `unknown` is NOT satisfaction. That distinction is the whole point: a source
 * whose coverage cannot be proven because its collector is out of date stays
 * out of green, while a completed one-time import that will never refresh is
 * not held to a freshness proof it can never produce.
 */
function conditionIsSettledSatisfied(
  conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>,
  type: ConnectionConditionType
): boolean {
  const status = conditions.get(type)?.status;
  return status === "true" || status === "not_applicable";
}

function isHealthyConditionSet(conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>): boolean {
  return (
    conditionIsTrue(conditions, "CollectionSucceeded") &&
    conditionIsTrue(conditions, "SourceCoverageComplete") &&
    conditionIsSettledSatisfied(conditions, "Fresh") &&
    !conditionIsFalse(conditions, "AttentionClear") &&
    !conditionIsFalse(conditions, "ProjectionReliable") &&
    !conditionIsFalse(conditions, "RetryPolicyClear") &&
    !conditionIsFalse(conditions, "RuntimeAvailable") &&
    !conditionIsFalse(conditions, "RemoteSurfaceAvailable") &&
    !conditionIsFalse(conditions, "LocalExporterAvailable") &&
    conditions.get("BacklogClear")?.severity !== "error"
  );
}

function projectConditions(
  input: ComputeConnectionHealthInput,
  axes: ConnectionAxes
): readonly ConnectionHealthCondition[] {
  const observedAt = input.observedAt ?? input.run?.lastSuccessAt ?? input.backoff?.nextRunAt ?? null;
  // The stalled cause is only meaningful when the axis is actually stalled.
  const stalledCause = axes.outbox === "stalled" ? (input.outbox?.cause ?? null) : null;
  const localDeviceBacked = input.localDeviceBacked === true;
  return [
    projectionReliableCondition(input),
    scheduleEligibleCondition(input),
    retryPolicyClearCondition(input),
    attentionClearCondition(input),
    collectionSucceededCondition(input),
    credentialsValidCondition(input),
    credentialContinuityCondition(input),
    runtimeAvailableCondition(input),
    remoteSurfaceAvailableCondition(input),
    localExporterAvailableCondition(axes, stalledCause, localDeviceBacked),
    sourceCoverageCondition(input, axes),
    freshCondition(input, axes),
    backlogClearCondition(axes, stalledCause, localDeviceBacked),
  ].map((item) => {
    const conditionObservedAt = item.observed_at ?? observedAt;
    return {
      ...item,
      current: conditionIsCurrent(item.expires_at, conditionObservedAt),
      observed_at: conditionObservedAt,
    };
  });
}

function condition(input: {
  readonly type: ConnectionConditionType;
  readonly status: ConnectionConditionStatus;
  readonly severity: ConnectionConditionSeverity;
  readonly reason: string;
  readonly reasonCode?: string | null;
  readonly message: string;
  readonly origin: ConnectionConditionOrigin;
  readonly observedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly sensitivity?: ConnectionConditionSensitivity;
  readonly remediation?: ConnectionConditionRemediation | null;
}): ConnectionHealthCondition {
  return {
    current: true,
    expires_at: input.expiresAt ?? null,
    id: `${input.type}:${input.reason}`,
    message: input.message,
    observed_at: input.observedAt ?? null,
    origin: input.origin,
    reason: input.reason,
    reason_code: input.reasonCode ?? null,
    remediation: input.remediation ?? null,
    sensitivity: input.sensitivity ?? "owner",
    severity: input.severity,
    status: input.status,
    type: input.type,
  };
}

function conditionIsCurrent(expiresAt: string | null, observedAt: string | null): boolean {
  return !conditionExpired(expiresAt, observedAt);
}

function conditionExpired(expiresAt: string | null, observedAt: string | null): boolean {
  if (!expiresAt) {
    return false;
  }
  if (!observedAt) {
    return false;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) {
    return false;
  }
  return expiresAtMs <= observedAtMs;
}

/**
 * Projection sources that a new run must clear, because no amount of waiting
 * can.
 *
 * `terminal_facts_historical` is emitted by `foldTerminalEventFacts` when
 * every terminal event on record carries a manifest generation that is not
 * the connection's current one. The fold is right to refuse it — a
 * prior-generation event is not proof about the current manifest — but the
 * consequence is a state that cannot self-heal: the drain re-reads the same
 * historical events and re-derives the identical verdict forever. Only a
 * fresh successful run, stamped at the current generation, emits the
 * evidence that clears it.
 *
 * Telling the owner to "wait" here is the one instruction guaranteed not to
 * work, which is what made several connections read as an unexplained
 * "Can't collect" indefinitely.
 */
const RUN_CLEARABLE_PROJECTION_SOURCES: ReadonlySet<string> = new Set(["terminal_facts_historical"]);

/**
 * Remediation is a pure function of the condition's `reason`, computed here at
 * projection time — never a static string owned by the condition TYPE.
 *
 * `ProjectionReliable` is `false` for at least two causes that need opposite
 * advice. A projection still catching up clears itself, so "wait" is true. A
 * projection superseded by a definition change never clears on its own, so
 * "wait" is the one instruction guaranteed to fail — it is what left several
 * connections reading "Not measured" for half a day while the owner waited for
 * an event that could not arrive. Binding the remedy to the CONDITION rather
 * than to the CAUSE is the mechanism of that bug, so the two are bound
 * together here instead: one reason, one remedy, no way to add a cause without
 * choosing its advice.
 */
function projectionRemediationForReason(reason: string): ConnectionHealthCondition["remediation"] {
  if (reason === CONDITION_REASON.PROJECTION_SUPERSEDED_BY_DEFINITION_CHANGE) {
    // Same shape as every other owner-runnable remediation in this file (see
    // `stale_manual_refresh` and the retryable-gap coverage condition): the
    // runtime performs the retry, and the console's Refresh CTA is the
    // owner's way to ask for it now.
    return {
      action: "retry_by_runtime",
      label: "Run the connector to rebuild its evidence",
      retryable: true,
      target: "run",
    };
  }
  return {
    action: "wait",
    label: "Wait for the reference read model to refresh",
    retryable: true,
    target: null,
  };
}

function projectionReliableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  // This is the canonical projection-reliability composition boundary. Several
  // failed components can share one closed reason code (for example a repair
  // lock failure); retain first-seen order while exposing each cause once.
  const sources = canonicalProjectionUnreliableSources(input.projection?.unreliableSources ?? []);
  if (sources.length > 0) {
    // "Wait" stays the default, and stays correct whenever ANY source can
    // still clear on its own — a mixed set is only as stuck as its most
    // recoverable member. Only an entirely run-clearable set changes advice.
    const requiresRun = sources.every((source) => RUN_CLEARABLE_PROJECTION_SOURCES.has(source));
    const reason = requiresRun
      ? CONDITION_REASON.PROJECTION_SUPERSEDED_BY_DEFINITION_CHANGE
      : CONDITION_REASON.PROJECTION_UNRELIABLE;
    return condition({
      message: requiresRun
        ? `Projection evidence has not run since the connection's setup changed: ${sources.join(", ")}. A new successful run will restore it.`
        : `Projection evidence is unreliable: ${sources.join(", ")}.`,
      origin: "read_model",
      reason,
      // The first unreliable source is surfaced as the machine-readable
      // reason_code; callers that need the complete set still have the full
      // list in `unreliableSources`/the human-readable `message` below.
      reasonCode: sources[0] ?? null,
      remediation: projectionRemediationForReason(reason),
      severity: "blocked",
      status: "false",
      type: "ProjectionReliable",
    });
  }
  return condition({
    message: "Projection evidence is reliable.",
    origin: "read_model",
    reason: CONDITION_REASON.PROJECTION_CURRENT,
    severity: "info",
    status: "true",
    type: "ProjectionReliable",
  });
}

function canonicalProjectionUnreliableSources(sources: readonly string[]): readonly string[] {
  return [...new Set(sources)];
}

function scheduleEligibleCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  if (!input.schedule) {
    // "There is no schedule row" is a fact the scheduler is certain about, so it
    // must not render as a pending verdict. It is deliberately NOT `false`:
    // `classifyOwnerPaused` treats any false `ScheduleEligible` as an intentional
    // owner pause and would demote an otherwise-healthy connection to `idle`,
    // and `pickDominantConditionId` would surface it as the dominant condition
    // for that idle state. Both would change what the projection claims is true
    // about the connection, which this change must not do.
    //
    // `not_applicable` is the honest encoding for the owner-facing surface: no
    // schedule *policy* applies here yet. The condition drops out of the
    // supporting list rather than sitting there as a permanent "Unknown", and
    // the schedules page remains the place where the owner sets one. The copy
    // states the consequence the owner can act on instead of naming an absent
    // config object.
    return condition({
      message: "No schedule yet — this connection runs only when you sync it.",
      origin: "scheduler",
      reason: CONDITION_REASON.SCHEDULE_NOT_CONFIGURED,
      remediation: {
        action: "wait",
        label: "Set a schedule to refresh this connection automatically",
        retryable: false,
        surface: { kind: "schedule" },
        target: "schedule",
      },
      severity: "info",
      status: "not_applicable",
      type: "ScheduleEligible",
    });
  }
  if (input.schedule.enabled === false) {
    return condition({
      message: "The schedule is paused.",
      origin: "scheduler",
      reason: CONDITION_REASON.SCHEDULE_PAUSED,
      remediation: {
        action: "wait",
        label: "Resume the schedule when fresh data is needed",
        retryable: false,
        target: "schedule",
      },
      severity: "info",
      status: "false",
      type: "ScheduleEligible",
    });
  }
  return condition({
    message: "The schedule is eligible to run.",
    origin: "scheduler",
    reason: CONDITION_REASON.SCHEDULE_ENABLED,
    severity: "info",
    status: "true",
    type: "ScheduleEligible",
  });
}

function retryPolicyClearCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  if (isManualRefreshOnly(input.refresh) && !isExplicitOwnerScheduledManual(input.refresh, input.schedule)) {
    return condition({
      message: "This connection refreshes only when the owner starts it, so scheduler retry timing does not apply.",
      origin: "scheduler",
      reason: CONDITION_REASON.RETRY_NOT_APPLICABLE,
      severity: "info",
      status: "not_applicable",
      type: "RetryPolicyClear",
    });
  }
  if (!input.backoff || conditionExpired(input.backoff.nextRunAt, input.observedAt ?? null)) {
    return condition({
      message: input.backoff
        ? "The previous retry backoff has expired."
        : "No active retry backoff is blocking collection.",
      origin: "scheduler",
      reason: input.backoff ? CONDITION_REASON.BACKOFF_EXPIRED : CONDITION_REASON.NO_ACTIVE_BACKOFF,
      severity: "info",
      status: "true",
      type: "RetryPolicyClear",
    });
  }
  const blocked = input.backoff.consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD;
  const retryable = !blocked;
  return condition({
    expiresAt: input.backoff.nextRunAt,
    message: blocked ? "Retry policy has reached the blocked threshold." : "Retry policy is delaying the next attempt.",
    origin: "scheduler",
    reason: stripClassPrefix(input.backoff.reasonClass) ?? CONDITION_REASON.SCHEDULER_BACKOFF_ACTIVE,
    remediation: {
      action: retryable ? "retry_by_runtime" : "update_connector",
      label: retryable ? "Wait for the scheduled retry" : "Review the repeated scheduler failure",
      retryable,
      target: "schedule",
    },
    severity: blocked ? "blocked" : "warning",
    status: "false",
    type: "RetryPolicyClear",
  });
}

function attentionClearCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  if (!input.attention || conditionExpired(input.attention.expiresAt, input.observedAt ?? null)) {
    return condition({
      message: input.attention
        ? "The previous owner action request has expired."
        : "No owner action is currently required.",
      origin: "runtime",
      reason: input.attention ? CONDITION_REASON.ATTENTION_EXPIRED : CONDITION_REASON.NO_OPEN_ATTENTION,
      severity: "info",
      status: "true",
      type: "AttentionClear",
    });
  }
  return condition({
    expiresAt: input.attention.expiresAt,
    message: "Owner action is required before collection can continue.",
    origin: "runtime",
    reason: input.attention.reasonCode ?? CONDITION_REASON.ATTENTION_REQUIRED,
    remediation: {
      action: "satisfy_attention",
      label: "Open the requested interaction and complete the action",
      retryable: false,
      target: input.attention.actionTarget,
    },
    sensitivity: input.attention.sensitivity === "secret" ? "secret_redacted" : "owner",
    severity: "blocked",
    status: "false",
    type: "AttentionClear",
  });
}

function collectionSucceededCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  if (!input.run || input.run.latestStatus === null) {
    // A local-device collector writes no spine run, so there is no run
    // verdict to read. When the caller has established the local-device
    // collection verdict (trusted idle/drained outbox + complete coverage on
    // a local-device-backed connection), that is the device-side analog of a
    // succeeded run and SHALL satisfy this condition. Gating happens in the
    // caller; the projection trusts the verdict only in the no-run branch so
    // a real run is always authoritative.
    if (input.localDeviceCollection?.verdict === "succeeded") {
      return condition({
        message: "The local collector drained cleanly with complete coverage.",
        observedAt: input.run?.lastSuccessAt ?? null,
        origin: "local_device",
        reason: CONDITION_REASON.COLLECTION_SUCCEEDED_LOCAL_DEVICE,
        severity: "info",
        status: "true",
        type: "CollectionSucceeded",
      });
    }
    // A completed one-time import writes no spine run either: the owner
    // supplied a file, the ingest finished, and there is nothing to schedule.
    // Its completeness declaration is the collection verdict, exactly as the
    // local-device verdict is above. Coverage is still proven independently —
    // the caller only sets `complete` once the import finished ingesting, and
    // `SourceCoverageComplete` is checked separately by the healthy predicate.
    if (input.acquisition?.complete === true) {
      return condition({
        message: "The one-time import finished ingesting.",
        observedAt: input.run?.lastSuccessAt ?? null,
        origin: "connector",
        reason: CONDITION_REASON.COLLECTION_SUCCEEDED_IMPORT_COMPLETE,
        severity: "info",
        status: "true",
        type: "CollectionSucceeded",
      });
    }
    return condition({
      message: "No terminal collection run has been observed.",
      origin: "connector",
      reason: CONDITION_REASON.COLLECTION_NOT_OBSERVED,
      severity: "info",
      status: "unknown",
      type: "CollectionSucceeded",
    });
  }
  if (input.run.latestStatus === "succeeded") {
    return condition({
      message: "The latest terminal collection run succeeded.",
      observedAt: input.run.lastSuccessAt,
      origin: "connector",
      reason: CONDITION_REASON.COLLECTION_SUCCEEDED,
      severity: "info",
      status: "true",
      type: "CollectionSucceeded",
    });
  }
  return condition({
    message: "The latest terminal collection run failed.",
    origin: "connector",
    reason: normalizeConditionReason(input.run.reasonCode, CONDITION_REASON.COLLECTION_FAILED),
    sensitivity: containsSecretLike(input.run.reasonCode) ? "secret_redacted" : "owner",
    severity: "warning",
    status: "false",
    type: "CollectionSucceeded",
  });
}

// A blocked `CredentialsValid` condition for "no usable stored credential": the
// connection can store a credential but none is currently usable (never captured,
// or superseded). Distinct from rejection — nothing was rejected because nothing
// was stored — so the copy and remediation name capturing a credential for the
// existing connection. Still an owner reauth/capture action downstream.
function credentialRequiredCondition(): ConnectionHealthCondition {
  return condition({
    message: "No usable stored credential for this connection.",
    origin: "readiness",
    reason: CONDITION_REASON.CREDENTIAL_REQUIRED,
    remediation: {
      action: "refresh_credentials",
      label: "Reconnect this account",
      retryable: false,
      surface: { kind: "stored_credential" },
      target: "credentials",
    },
    sensitivity: "secret_redacted",
    severity: "blocked",
    status: "false",
    type: "CredentialsValid",
  });
}

// A blocked `CredentialsValid` condition for a rejected stored credential.
// The remediation label matches the rendered verdict's single reconnect CTA
// ("Reconnect this account"). A rejected credential is ONE owner action; the
// older "Reconnect or update …" phrasing read as two, which the owner flagged as
// confusing (PR #164 / unify-source-attention-count-and-labels). See
// reference-connection-health: "Owner actions SHALL be a typed required-action
// list … one unified satisfaction contract".
function credentialRejectedCondition(reason: string | null): ConnectionHealthCondition {
  return condition({
    message: "The source rejected the configured credentials.",
    origin: "readiness",
    reason: normalizeConditionReason(reason, CONDITION_REASON.CREDENTIAL_REJECTED),
    remediation: {
      action: "refresh_credentials",
      label: "Reconnect this account",
      retryable: false,
      surface: { kind: "stored_credential" },
      target: "credentials",
    },
    sensitivity: "secret_redacted",
    severity: "blocked",
    status: "false",
    type: "CredentialsValid",
  });
}

function browserSessionRequiredCondition(reason: string | null): ConnectionHealthCondition {
  return condition({
    message: "The authenticated browser session is not active.",
    origin: "readiness",
    reason: normalizeConditionReason(reason, "session_required"),
    remediation: {
      action: "refresh_credentials",
      label: "Reconnect this account",
      retryable: false,
      surface: { kind: "browser_session" },
      target: "browser_session",
    },
    sensitivity: "secret_redacted",
    severity: "blocked",
    status: "false",
    type: "CredentialsValid",
  });
}

function credentialsNotProvenCondition(): ConnectionHealthCondition {
  return condition({
    message: "Credential validity has not been proven by current evidence.",
    origin: "readiness",
    reason: CONDITION_REASON.CREDENTIALS_NOT_PROBED,
    severity: "info",
    status: "unknown",
    type: "CredentialsValid",
  });
}

// A connection that authenticates to nothing has no credential to probe, so
// "are the credentials valid?" is a category error rather than an open
// question. `not_applicable` is the settled answer; `unknown` would keep an
// unanswerable question open forever. See {@link ConnectionAuthenticationEvidence}.
function credentialsNotApplicableCondition(): ConnectionHealthCondition {
  return condition({
    message: "This source imports a file you provide, so it has no credentials to verify.",
    origin: "readiness",
    reason: CONDITION_REASON.CREDENTIALS_NOT_APPLICABLE_FILE_IMPORT,
    severity: "info",
    status: "not_applicable",
    type: "CredentialsValid",
  });
}

function browserSessionRepairCapabilityUnknownCondition(reason: string): ConnectionHealthCondition {
  return condition({
    message: "The source requires a session, but this connection has no browser-session repair capability.",
    origin: "readiness",
    reason: normalizeConditionReason(reason, "session_required"),
    sensitivity: "secret_redacted",
    severity: "warning",
    status: "unknown",
    type: "CredentialsValid",
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
function credentialsValidCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  const reason = firstReasonCode(input);
  const credential = input.credential ?? null;
  const credentialAbsent = credential?.capable === true && credential.present !== true;
  const credentialRejectedDurably = credential?.capable === true && credential.rejected === true;
  // A connector that authenticates to no provider has no credential to probe.
  // Answered before every other branch because for these connections the
  // question has no referent at all — but deliberately NOT when contradicting
  // evidence exists. A stored credential, or a credential-shaped run reason,
  // means something DID authenticate; the durable declaration is then wrong or
  // stale, and silently converting a real credential problem into
  // `not_applicable` would hide exactly the failure the owner must act on.
  // Evidence wins over declaration, so those cases fall through to the honest
  // classification below.
  if (input.authentication?.authenticates === false && credential === null && !(reason && isCredentialReason(reason))) {
    return credentialsNotApplicableCondition();
  }
  // A credential-shaped run reason is present: classify honestly by durable
  // credential-presence evidence when we have it. No usable stored credential ->
  // Precedence is durable rejection, then applicable static-secret absence,
  // then browser-session repair. Session repair is selected from the caller-
  // provided durable capability, never transient remote-surface occupancy. A
  // typed proof, when supplied, remains a monotonic one-repair authority and
  // can suppress a repair already recorded for that proof.
  if (reason && isCredentialReason(reason)) {
    const browserSessionRepairReason = isBrowserSessionRepairReason(reason);
    const definitiveStoredCredentialRejection = isDefinitiveStoredCredentialRejectionReason(reason);
    // A "stored credential rejected" verdict requires STANDING stored-credential
    // capability for this connection (`credential.capable === true`, set only
    // when `deriveCredentialEvidence` found this connection static-secret-BOUND).
    // A browser-session-bound connection always has `credential === null` — it
    // has no stored credential to reject. Without this guard, a generic/legacy
    // run-reason string containing a definitive auth marker (401/unauthorized)
    // that also happens to name a session failure collapses to the stored-
    // credential surface via `definitiveStoredCredentialRejection`, contradicting
    // the connection's own binding. Durable connection-binding authority wins
    // over message-text pattern-matching, per reference-connection-health:
    // "Stored-credential-presence evidence SHALL be connection-binding-scoped."
    if (credentialRejectedDurably || (definitiveStoredCredentialRejection && credential?.capable === true)) {
      return credentialRejectedCondition(reason);
    }
    if (credentialAbsent) {
      return credentialRequiredCondition();
    }
    if (browserSessionRepairReason && browserSessionRepairAuthorized(input)) {
      return browserSessionRequiredCondition(reason);
    }
    if (browserSessionRepairReason || (definitiveStoredCredentialRejection && input.browserSessionRepairCapable)) {
      if (browserSessionRepairAlreadyRecorded(input)) {
        return credentialsNotProvenCondition();
      }
      if (input.browserSessionRepairCapable === true) {
        // A generic/legacy reason (e.g. a flattened "credential_rejected"
        // literal) carries no session-shaped text of its own when it only
        // reached this branch via the binding-authority guard above, not
        // `browserSessionRepairReason`. Passing it through verbatim would
        // label the condition "credential_rejected" while its remediation
        // says browser_session — a contradiction. Use the honest
        // "session_required" fallback instead of the misleading raw reason.
        return browserSessionRequiredCondition(browserSessionRepairReason ? reason : null);
      }
      return browserSessionRepairCapabilityUnknownCondition(reason);
    }
    if (definitiveStoredCredentialRejection) {
      return credentialRejectedCondition(reason);
    }
    if (credential?.capable === true && credential.present === true && credential.rejected !== true) {
      return credentialsNotProvenCondition();
    }
    return credentialRejectedCondition(reason);
  }
  // No current credential-shaped run reason. When durable credential evidence
  // shows an unresolved credential state, the connection SHALL still project that
  // repair need rather than healing merely because the run reason aged out (or a
  // never-run connection has no reason at all). Evidence-derived, not age-derived.
  if (credentialRejectedDurably) {
    return credentialRejectedCondition(null);
  }
  if (credentialAbsent) {
    return credentialRequiredCondition();
  }
  if (input.run?.latestStatus === "succeeded") {
    return condition({
      message: "The latest successful run proved credentials were accepted.",
      observedAt: input.run.lastSuccessAt,
      origin: "readiness",
      reason: CONDITION_REASON.CREDENTIALS_ACCEPTED,
      severity: "info",
      status: "true",
      type: "CredentialsValid",
    });
  }
  return credentialsNotProvenCondition();
}

function browserSessionRepairAuthorized(input: ComputeConnectionHealthInput): boolean {
  const context = input.browserSurfaceRepair;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (context?.evidence.kind !== "provider_invalidation_proof") {
    return false;
  }
  if (context.evidence.provider !== context.provider) {
    return false;
  }
  return (
    decideBrowserSurfaceRepair({
      connection_id: context.connectionId,
      evidence: context.evidence,
      ...(context.repairedProofKeys ? { repaired_proof_keys: context.repairedProofKeys } : {}),
    }).action === "repair"
  );
}

function browserSessionRepairAlreadyRecorded(input: ComputeConnectionHealthInput): boolean {
  const context = input.browserSurfaceRepair;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (context?.evidence.kind !== "provider_invalidation_proof") {
    return false;
  }
  if (context.evidence.provider !== context.provider) {
    return false;
  }
  return (
    decideBrowserSurfaceRepair({
      connection_id: context.connectionId,
      evidence: context.evidence,
      ...(context.repairedProofKeys ? { repaired_proof_keys: context.repairedProofKeys } : {}),
    }).reason === "already_repaired"
  );
}

/**
 * Process-bound continuity is a diagnostic health overlay, never a repair
 * authority. A provider-specific authenticated-session probe may later supply
 * `continuity_proven`; replacement evidence alone cannot.
 */
function credentialContinuityCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  const continuity = input.ephemeralBrowserRuntime?.credential_continuity;
  if (continuity === "replacement_pending" || continuity === "rehydration_false" || continuity === "indeterminate") {
    return condition({
      message: "Browser-session continuity is not currently proven after a process replacement.",
      origin: "runtime",
      reason: CONDITION_REASON.CREDENTIAL_CONTINUITY_UNPROVEN,
      severity: "warning",
      status: "false",
      type: "CredentialContinuity",
    });
  }
  // The runtime does the work to prove continuity across a process replacement;
  // before this branch existed the answer was computed and then discarded, so a
  // proven session and an unprobed one rendered identically.
  if (continuity === "continuity_proven") {
    return condition({
      message: "Browser-session continuity is proven across the last process replacement.",
      origin: "runtime",
      reason: CONDITION_REASON.CREDENTIAL_CONTINUITY_PROVEN,
      severity: "info",
      status: "true",
      type: "CredentialContinuity",
    });
  }
  // Everything else is `not_applicable` — either the projection said so (any
  // connection that is not browser-runtime backed, or a dynamic runtime with no
  // replacement receipt), or there is no ephemeral runtime projection at all.
  // There is no process-bound session here, so nothing could ever prove or
  // disprove continuity. That is a settled answer, not a pending one.
  return condition({
    message: "This connection has no process-bound browser session, so continuity does not apply.",
    origin: "runtime",
    reason: CONDITION_REASON.CREDENTIAL_CONTINUITY_NOT_APPLICABLE,
    severity: "info",
    status: "not_applicable",
    type: "CredentialContinuity",
  });
}

function runtimeAvailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  return (
    runtimeDependencyUnavailableCondition(input) ??
    managedRuntimeAvailableCondition(input) ??
    legacyRuntimeAvailableCondition(input)
  );
}

function runtimeDependencyUnavailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition | null {
  const readinessReason = firstReasonCode(input);
  const dependencyReason = readinessReason ? runtimeDependencyReason(readinessReason) : null;
  if (!dependencyReason) {
    return null;
  }
  return condition({
    message: "A required collection runtime dependency is unavailable.",
    origin: "runtime",
    reason: dependencyReason,
    remediation: {
      action: "check_runtime",
      label: "Configure the required runtime dependency",
      retryable: false,
      target: "runtime",
    },
    severity: "blocked",
    status: "false",
    type: "RuntimeAvailable",
  });
}

function managedRuntimeAvailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition | null {
  const runtime = input.ephemeralBrowserRuntime;
  if (!runtime) {
    return null;
  }
  if (runtime.surface_mode === "none") {
    return unmanagedEphemeralRuntimeCondition();
  }
  return runtime.health_eligible
    ? availableEphemeralRuntimeCondition(runtime)
    : unavailableEphemeralRuntimeCondition(runtime);
}

function unmanagedEphemeralRuntimeCondition(): ConnectionHealthCondition {
  return condition({
    message: "No managed runtime surface is required for this connection.",
    origin: "runtime",
    reason: CONDITION_REASON.RUNTIME_NOT_MANAGED,
    severity: "info",
    status: "not_applicable",
    type: "RuntimeAvailable",
  });
}

function availableEphemeralRuntimeCondition(runtime: EphemeralBrowserRuntimeProjection): ConnectionHealthCondition {
  return condition({
    expiresAt: runtime.allocator_observation?.expires_at ?? null,
    message: "Current managed browser runtime capability is available.",
    observedAt: runtime.allocator_observation?.observed_at ?? null,
    origin: "runtime",
    reason: CONDITION_REASON.RUNTIME_AVAILABLE,
    severity: "info",
    status: "true",
    type: "RuntimeAvailable",
  });
}

function unavailableEphemeralRuntimeCondition(runtime: EphemeralBrowserRuntimeProjection): ConnectionHealthCondition {
  const observation = runtime.allocator_observation;
  return condition({
    message: "Current managed browser runtime capability is not proven.",
    origin: "runtime",
    reason:
      observation?.status === "unavailable"
        ? CONDITION_REASON.RUNTIME_UNAVAILABLE
        : CONDITION_REASON.RUNTIME_STATE_UNKNOWN,
    remediation: unavailableRuntimeRemediation(observation?.status),
    severity: observation?.status === "unknown" ? "warning" : "error",
    status: observation?.status === "unknown" ? "unknown" : "false",
    type: "RuntimeAvailable",
  });
}

function unavailableRuntimeRemediation(
  status: "available" | "unavailable" | "unknown" | undefined
): ConnectionConditionRemediation | null {
  if (status !== "unavailable") {
    return null;
  }
  return {
    action: "check_runtime",
    label: "Check the browser surface runtime",
    retryable: true,
    target: "remote_surface",
  };
}

function legacyRuntimeAvailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const remoteSurface = input.remoteSurface;
  if (!remoteSurface || remoteSurface.axis === "none") {
    return condition({
      message: "No managed runtime surface is required or observed for this connection.",
      origin: "runtime",
      reason: CONDITION_REASON.RUNTIME_NOT_MANAGED,
      severity: "info",
      status: "not_applicable",
      type: "RuntimeAvailable",
    });
  }
  if (remoteSurface.axis === "failed") {
    return condition({
      message: "The managed runtime surface is not available.",
      origin: "remote_surface",
      reason: normalizeConditionReason(
        remoteSurface.waitReason ?? remoteSurface.leaseStatus,
        CONDITION_REASON.RUNTIME_UNAVAILABLE
      ),
      remediation: {
        action: "check_runtime",
        label: "Check the browser surface runtime",
        retryable: true,
        target: "remote_surface",
      },
      severity: "error",
      status: "false",
      type: "RuntimeAvailable",
    });
  }
  if (remoteSurface.axis === "unknown") {
    return condition({
      message: "Runtime surface evidence is incomplete.",
      origin: "remote_surface",
      reason: CONDITION_REASON.RUNTIME_STATE_UNKNOWN,
      severity: "warning",
      status: "unknown",
      type: "RuntimeAvailable",
    });
  }
  return condition({
    message: "Runtime surface evidence is available.",
    origin: "remote_surface",
    reason: CONDITION_REASON.RUNTIME_AVAILABLE,
    severity: "info",
    status: "true",
    type: "RuntimeAvailable",
  });
}

function remoteSurfaceAvailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  return (
    idleDynamicRuntimeRemoteSurfaceCondition(input.ephemeralBrowserRuntime) ??
    legacyRemoteSurfaceAvailableCondition(input)
  );
}

function idleDynamicRuntimeRemoteSurfaceCondition(
  runtime: EphemeralBrowserRuntimeProjection | null | undefined
): ConnectionHealthCondition | null {
  if (!isIdleDynamicRuntime(runtime)) {
    return null;
  }
  return condition({
    message: "No leased remote browser surface is required while the dynamic runtime is idle.",
    origin: "remote_surface",
    reason: CONDITION_REASON.REMOTE_SURFACE_NOT_REQUIRED,
    severity: "info",
    status: "not_applicable",
    type: "RemoteSurfaceAvailable",
  });
}

function isIdleDynamicRuntime(runtime: EphemeralBrowserRuntimeProjection | null | undefined): boolean {
  return runtime?.surface_mode === "dynamic-managed" && runtime.demand === "none" && runtime.active_lease === null;
}

function legacyRemoteSurfaceAvailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const remoteSurface = input.remoteSurface;
  if (!remoteSurface || remoteSurface.axis === "none") {
    return condition({
      message: "No managed remote browser surface is required or observed for this connection.",
      origin: "remote_surface",
      reason: CONDITION_REASON.REMOTE_SURFACE_NOT_REQUIRED,
      severity: "info",
      status: "not_applicable",
      type: "RemoteSurfaceAvailable",
    });
  }
  if (remoteSurface.axis === "failed") {
    return condition({
      message: "The managed remote browser surface is unavailable.",
      origin: "remote_surface",
      reason: normalizeConditionReason(
        remoteSurface.waitReason ?? remoteSurface.leaseStatus,
        CONDITION_REASON.REMOTE_SURFACE_FAILED
      ),
      remediation: {
        action: "check_runtime",
        label: "Check the browser surface runtime",
        retryable: true,
        target: "remote_surface",
      },
      severity: "error",
      status: "false",
      type: "RemoteSurfaceAvailable",
    });
  }
  if (remoteSurface.axis === "unknown") {
    return condition({
      message: "Remote browser surface evidence is incomplete.",
      origin: "remote_surface",
      reason: CONDITION_REASON.REMOTE_SURFACE_UNKNOWN,
      severity: "warning",
      status: "unknown",
      type: "RemoteSurfaceAvailable",
    });
  }
  return condition({
    message: "Remote browser surface evidence is available.",
    origin: "remote_surface",
    reason: CONDITION_REASON.REMOTE_SURFACE_AVAILABLE,
    severity: "info",
    status: "true",
    type: "RemoteSurfaceAvailable",
  });
}

/**
 * Cause-specific copy for a stalled local-device outbox. Keeps the readiness
 * (`LocalExporterAvailable`) and diagnostic (`BacklogClear`) conditions in
 * lockstep so the dashboard never shows a generic "stalled or blocked"
 * message when the projection actually knows which of three host-local
 * situations applies. The remediation `label` names the exact next step on
 * the host; the console renders the deterministic command separately.
 */
interface StalledCauseCopy {
  readonly action: ConnectionConditionRemediation["action"];
  readonly backlogMessage: string;
  readonly backlogReason: string;
  readonly exporterMessage: string;
  readonly exporterReason: string;
  readonly remediationLabel: string;
  readonly severity: ConnectionConditionSeverity;
}

function stalledCauseCopy(cause: OutboxStalledCause | null): StalledCauseCopy {
  switch (cause) {
    case "state_read_failed":
      return {
        action: "clear_backlog",
        backlogMessage: "The local collector is blocked reading saved state, not waiting on failed uploads.",
        backlogReason: CONDITION_REASON.OUTBOX_STATE_READ_FAILED,
        exporterMessage:
          "The local collector cannot read its last saved state. Run it again on the host; there are no failed uploads to retry.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_STATE_READ_FAILED,
        remediationLabel: "Run the local collector again on the host",
        severity: "error",
      };
    case "dead_letter_backlog":
      return {
        action: "clear_backlog",
        backlogMessage: "The local collector has saved failed uploads waiting to be retried.",
        backlogReason: CONDITION_REASON.OUTBOX_DEAD_LETTER_BACKLOG,
        exporterMessage:
          "The local collector has saved records that failed to upload. Prepare those uploads for retry, then run the collector again on the host.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_DEAD_LETTER_BACKLOG,
        remediationLabel: "Recover local collector uploads",
        severity: "error",
      };
    case "transient_upload_failure":
      return {
        action: "wait",
        backlogMessage: "Local-device uploads are waiting for the server or network to recover.",
        backlogReason: CONDITION_REASON.OUTBOX_TRANSIENT_UPLOAD_FAILURE,
        exporterMessage:
          "The local collector hit temporary server or network errors while uploading. It will retry without owner action.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE,
        remediationLabel: "Wait for upload retry",
        severity: "warning",
      };
    case "stale_pending":
      return {
        action: "clear_backlog",
        backlogMessage: "The local collector has queued work that stopped moving.",
        backlogReason: CONDITION_REASON.OUTBOX_STALE_PENDING,
        exporterMessage:
          "The local collector has queued work but stopped checking in. Run it again on the host to resume uploads.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_STALE_PENDING,
        remediationLabel: "Run the local collector again on the host",
        severity: "error",
      };
    case "stale_heartbeat":
      return {
        action: "clear_backlog",
        backlogMessage: "The local collector has not checked in since it last reported starting or retrying.",
        backlogReason: CONDITION_REASON.OUTBOX_STALE_HEARTBEAT,
        exporterMessage:
          "The local collector reported it was starting or retrying but stopped checking in. Run it again on the host.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_STALE_HEARTBEAT,
        remediationLabel: "Run the local collector again on the host",
        severity: "error",
      };
    default:
      return {
        action: "clear_backlog",
        backlogMessage: "The local collector has work that appears stalled.",
        backlogReason: CONDITION_REASON.OUTBOX_STALLED,
        exporterMessage: "The local collector is not making progress.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_STALLED,
        remediationLabel: "Check the local collector",
        severity: "error",
      };
  }
}

function localExporterAvailableCondition(
  axes: ConnectionAxes,
  stalledCause: OutboxStalledCause | null,
  localDeviceBacked: boolean
): ConnectionHealthCondition {
  switch (axes.outbox) {
    case "idle":
      return condition({
        message: "Local exporter evidence is available and idle.",
        origin: "local_device",
        reason: CONDITION_REASON.LOCAL_EXPORTER_IDLE,
        severity: "info",
        status: "true",
        type: "LocalExporterAvailable",
      });
    case "active":
      return condition({
        message: "Local exporter is draining queued work normally.",
        origin: "local_device",
        reason: CONDITION_REASON.LOCAL_EXPORTER_ACTIVE,
        severity: "info",
        status: "true",
        type: "LocalExporterAvailable",
      });
    case "stalled": {
      const copy = stalledCauseCopy(stalledCause);
      return condition({
        message: copy.exporterMessage,
        origin: "local_device",
        reason: copy.exporterReason,
        remediation: {
          action: copy.action,
          label: copy.remediationLabel,
          retryable: true,
          target: "local_device",
        },
        severity: copy.severity,
        status: "false",
        type: "LocalExporterAvailable",
      });
    }
    default:
      // A connection with no local-device binding has no exporter to report on,
      // so this is settled rather than pending. Keep the honest `unknown` for a
      // local-device-backed connection whose collector simply has not checked in
      // yet — there the evidence really is outstanding.
      return localDeviceBacked
        ? condition({
            message: "No trusted local exporter evidence is available.",
            origin: "local_device",
            reason: CONDITION_REASON.LOCAL_EXPORTER_UNKNOWN,
            severity: "info",
            status: "unknown",
            type: "LocalExporterAvailable",
          })
        : condition({
            message: "This connection collects on the server, so no local exporter applies.",
            origin: "local_device",
            reason: CONDITION_REASON.LOCAL_EXPORTER_NOT_APPLICABLE,
            severity: "info",
            status: "not_applicable",
            type: "LocalExporterAvailable",
          });
  }
}

function sourceCoverageCondition(input: ComputeConnectionHealthInput, axes: ConnectionAxes): ConnectionHealthCondition {
  if (axes.coverage === "unknown") {
    if (input.coverage?.unknownStaleCollectorBuild === true) {
      return condition({
        message: "This local collector build predates coverage evidence the server now requires. Update the collector.",
        origin: "connector",
        reason: CONDITION_REASON.COVERAGE_UNKNOWN_STALE_COLLECTOR,
        remediation: {
          action: "update_connector",
          label: "Update the local collector",
          retryable: false,
          target: "coverage",
        },
        severity: "warning",
        status: "unknown",
        type: "SourceCoverageComplete",
      });
    }
    return condition({
      message: "Source coverage evidence is missing.",
      origin: "connector",
      reason: CONDITION_REASON.COVERAGE_UNKNOWN,
      severity: "warning",
      status: "unknown",
      type: "SourceCoverageComplete",
    });
  }
  // A `terminal_gap` axis whose ENTIRE outstanding shortfall is backed by
  // durable per-item evidence of impossibility (never an attempt count, never
  // an absent answer — see `ConnectionCoverageEvidence.unfillableAccounted`)
  // is coverage the connector has already fully accounted for: it collected
  // everything collectible and can name exactly what it could not and why.
  // This is satisfaction, not exemption — deliberately status `true`, not
  // `not_applicable`, because the question "is coverage complete" has a real
  // yes here, the same way the connector's own per-run DETAIL_COVERAGE already
  // counts a by-policy skip as covered. `requiredButAccepted` (a contradictory
  // manifest) and every other degrading axis are evaluated first and are
  // unaffected — this branch only ever softens `terminal_gap`.
  if (
    axes.coverage === "terminal_gap" &&
    input.coverage?.requiredButAccepted !== true &&
    input.coverage?.unfillableAccounted === true
  ) {
    return condition({
      message:
        "Source coverage is complete: every collectible item was collected, and the rest is permanently uncollectable with a recorded reason.",
      origin: "connector",
      reason: CONDITION_REASON.COVERAGE_COMPLETE_UNFILLABLE_ACCOUNTED,
      severity: "info",
      status: "true",
      type: "SourceCoverageComplete",
    });
  }
  if (input.coverage?.requiredButAccepted === true || isDegradingCoverage(axes.coverage)) {
    return condition({
      message: "Required source coverage is incomplete.",
      origin: "connector",
      reason: axes.coverage,
      remediation: {
        action: axes.coverage === "retryable_gap" ? "retry_by_runtime" : "update_connector",
        // A retryable gap is owner-runnable, same as every other
        // `retry_by_runtime` remediation in this file (see the freshness
        // conditions below): "Wait for detail-gap retry" told the owner to
        // wait while the console's header CTA offered a clickable
        // Retry/Refresh now for the same connection, which read as a
        // contradiction. Match the established "Run the connector ..."
        // phrasing so the tooltip agrees with the button.
        label: axes.coverage === "retryable_gap" ? "Run the connector to retry the gap" : "Review source coverage gaps",
        retryable: axes.coverage === "retryable_gap",
        target: "coverage",
      },
      severity: axes.coverage === "terminal_gap" ? "blocked" : "warning",
      status: "false",
      type: "SourceCoverageComplete",
    });
  }
  return condition({
    message: "Source coverage is complete or accepted by manifest policy.",
    origin: "connector",
    reason: axes.coverage,
    severity: "info",
    status: "true",
    type: "SourceCoverageComplete",
  });
}

/**
 * A connector is manual-refresh-only when its manifest refresh policy
 * declares it cannot be auto-scheduled in the background — either
 * `background_safe: false`, `recommended_mode: "manual"`, or
 * `recommended_mode: "paused"`. These are the same refresh-policy values the
 * projection uses to decide whether stale freshness is an owner-action
 * advisory. Absent/unknown evidence is treated as schedulable (the pre-change
 * behavior), so staleness still degrades unless an explicit owner-created
 * schedule says otherwise.
 */
export function isManualRefreshOnly(refresh: ConnectionRefreshEvidence | null | undefined): boolean {
  if (!refresh) {
    return false;
  }
  return (
    refresh.backgroundSafe === false || refresh.recommendedMode === "manual" || refresh.recommendedMode === "paused"
  );
}

/**
 * A manual-default connector with an owner-created enabled schedule is still
 * scheduled work, not manual-only work. Keep this predicate separate from the
 * conservative refresh recommendation so explicit owner opt-in can be honored
 * without auto-enrolling unscheduled connections.
 */
export function isExplicitOwnerScheduledManual(
  refresh: ConnectionRefreshEvidence | null | undefined,
  schedule: ConnectionScheduleEvidence | null | undefined
): boolean {
  return schedule?.enabled === true && refresh?.recommendedMode === "manual" && refresh?.backgroundSafe === true;
}

/**
 * A connector is **assisted-refresh** when it refreshes on its own schedule
 * (it is NOT manual-refresh-only) yet its `interaction_posture` predicts the
 * connector will periodically need bounded owner help — credentials, an OTP, or
 * a manual action — before a scheduled refresh can complete. This is the
 * projection-side mirror of the run-automation policy's `assisted`
 * automation_mode (`run-automation-policy.ts` `canNotifyDuringRun`): the same
 * three postures that make a run owner-assisted. `none`/`null`/absent posture,
 * or any manual-refresh-only connector, is not assisted-refresh. The projection
 * trusts the caller's flags and never re-reads the manifest.
 */
export function isAssistedRefresh(refresh: ConnectionRefreshEvidence | null | undefined): boolean {
  if (!refresh || isManualRefreshOnly(refresh)) {
    return false;
  }
  const posture = refresh.interactionPosture;
  return posture === "credentials" || posture === "manual_action_likely" || posture === "otp_likely";
}

function freshCondition(input: ComputeConnectionHealthInput, axes: ConnectionAxes): ConnectionHealthCondition {
  // A source whose acquisition is complete by design has no future capture to
  // age against, so freshness is a question that does not apply here rather
  // than one awaiting an answer. This branch is first because a completed
  // import legitimately has no freshness axis at all: it never ran, so the
  // axis is `unknown`, and that `unknown` is certainty, not doubt.
  //
  // Deliberately settled as `not_applicable` rather than `true`: claiming a
  // finished 2023 export is "fresh" would be a second lie replacing the first.
  // The healthy predicate accepts the not-applicable answer instead.
  if (input.acquisition?.complete === true) {
    return condition({
      message: "This is a one-time import — its data is complete and will not refresh.",
      observedAt: input.run?.lastSuccessAt ?? null,
      origin: "connector",
      reason: CONDITION_REASON.FRESHNESS_NOT_APPLICABLE_COMPLETE,
      severity: "info",
      status: "not_applicable",
      type: "Fresh",
    });
  }
  if (axes.freshness === "fresh") {
    return condition({
      message: "Retained data satisfies the freshness policy.",
      observedAt: input.run?.lastSuccessAt ?? null,
      origin: "connector",
      reason: CONDITION_REASON.FRESH,
      severity: "info",
      status: "true",
      type: "Fresh",
    });
  }
  if (axes.freshness === "stale") {
    // A manual / paused / background-unsafe connector cannot auto-refresh, so
    // stale data is not a failure — it is an owner-action advisory unless the
    // owner has explicitly enabled a background-safe schedule. Emit the stale
    // `Fresh` condition at `info` severity so it never trips the degrading
    // threshold; the headline becomes `idle` with a manual-refresh remediation
    // and the `stale` badge stays on. Schedulable / background-safe connectors
    // keep the degrading `warning` stale condition, because the system was
    // supposed to refresh them and did not.
    if (isManualRefreshOnly(input.refresh) && !isExplicitOwnerScheduledManual(input.refresh, input.schedule)) {
      return condition({
        message: "Retained data is stale; this manual connector needs an owner-initiated run to refresh.",
        origin: "connector",
        reason: CONDITION_REASON.STALE_MANUAL_REFRESH,
        remediation: {
          action: "retry_by_runtime",
          label: "Run the connector manually",
          retryable: true,
          target: "run",
        },
        severity: "info",
        status: "false",
        type: "Fresh",
      });
    }
    // An assisted-refresh connector refreshes on its own schedule but may need
    // bounded owner help (credentials / OTP / a manual action) for a scheduled
    // refresh to complete. Stale data is therefore an owner-assistance advisory,
    // not a failure: emit the stale `Fresh` condition at `info` severity so it
    // never trips the degrading threshold. The headline becomes `idle` with the
    // `stale` badge on, exactly like the manual advisory, while the operator
    // copy names scheduled refresh and bounded assistance rather than a manual
    // run. A truly unattended connector (no assistance posture) falls through to
    // the degrading `warning` below, because the system was supposed to refresh
    // it on its own and did not.
    if (isAssistedRefresh(input.refresh)) {
      return condition({
        message:
          "Retained data is stale; this assisted connector refreshes on schedule and may ask for bounded owner help to catch up.",
        origin: "connector",
        reason: CONDITION_REASON.STALE_ASSISTED_REFRESH,
        remediation: { action: "retry_by_runtime", label: "Run the connector now", retryable: true, target: "run" },
        severity: "info",
        status: "false",
        type: "Fresh",
      });
    }
    return condition({
      message: "Retained data is stale for this connection's freshness policy.",
      origin: "connector",
      reason: CONDITION_REASON.STALE,
      remediation: { action: "retry_by_runtime", label: "Run the connector again", retryable: true, target: "run" },
      severity: "warning",
      status: "false",
      type: "Fresh",
    });
  }
  return condition({
    message: "Freshness evidence is missing.",
    origin: "connector",
    reason: CONDITION_REASON.FRESHNESS_UNKNOWN,
    severity: "warning",
    status: "unknown",
    type: "Fresh",
  });
}

/**
 * Inputs to the per-stream forward-disposition derivation. These are exactly the
 * five durable signals the design names: the stream's coverage condition, the
 * retryability of any recorded gap, whether structured owner attention is open,
 * the freshness axis, and the connection's refresh-policy evidence. Keeping the
 * function pure over this struct (rather than over the whole health input) makes
 * every branch unit-testable in isolation and keeps the contract free of run
 * timeline prose.
 *
 * See `define-connector-progress-evidence-contract`.
 */
export interface ForwardDispositionInput {
  /**
   * Whether structured owner attention is open for the connection (missing
   * credentials, a pending OTP, required re-consent, or a manual action).
   */
  readonly attentionOpen: boolean;
  /** The stream's coverage condition from the canonical {@link CoverageAxis}. */
  readonly coverage: CoverageAxis;
  /** The connection's freshness axis from {@link FreshnessAxis}. */
  readonly freshness: FreshnessAxis;
  /**
   * Whether the stream's outstanding gap is recoverable by an ordinary future
   * run (a pending recoverable `DETAIL_GAP` or an ordinary partial boundary).
   * Ignored when the coverage condition carries no outstanding gap.
   */
  readonly gapRetryable: boolean;
  /**
   * The connection's manifest refresh-policy evidence. Used only to decide
   * whether a stale-but-complete stream is owner-refresh-due (manual / paused /
   * not background-safe) or the scheduler's own responsibility (background-safe).
   */
  readonly refresh: ConnectionRefreshEvidence | null;
  /**
   * Durable schedule evidence. When a manual-by-default connector has an
   * explicit owner-created enabled schedule, the refresh policy alone must not
   * force the manual-refresh advisory.
   */
  readonly schedule?: ConnectionScheduleEvidence | null;
  /**
   * Whether the stream's ENTIRE terminal shortfall is backed by durable
   * per-item proof of impossibility — the same already-computed boolean the
   * coverage rollup threads onto `SourceCoverageComplete`
   * (`ConnectionCoverageEvidence.unfillableAccounted`). The sole owner of the
   * predicate is `isStreamFullyUnfillableAccounted`
   * (`server/connector-gap-classification.ts`); this field only carries its
   * verdict, and is never re-derived from gap rows here.
   *
   * Meaningful ONLY paired with the `terminal_gap` condition it was proven
   * against — exactly the pairing `deriveCollectionReportEntryCoverage`
   * (`server/ref-control.ts`) already enforces when it withdraws the claim on a
   * stale evidence scope. `unsupported` and `unavailable` are different claims
   * (the source or connector cannot serve the stream at all, not that a bounded
   * set of items was measured and proven impossible), so they are never
   * softened by this flag.
   *
   * Optional; absent/`false` preserves the shipped behavior exactly.
   */
  readonly unfillableAccounted?: boolean;
}

/**
 * The coverage conditions that represent an outstanding gap the disposition must
 * speak to — the stream is either missing data the run did not establish as
 * covered (the degrading conditions) or stuck on a terminal source/connector
 * limitation (`unsupported` / `unavailable`). The accepted-absence conditions
 * `deferred` and `inventory_only` are deliberately excluded: they owe no further
 * data by manifest policy, so they carry no outstanding gap and resolve to
 * `complete`. `complete` and `unknown` are not gaps either.
 */
function hasOutstandingGap(coverage: CoverageAxis): boolean {
  return (
    coverage === "gaps" ||
    coverage === "partial" ||
    coverage === "retryable_gap" ||
    coverage === "terminal_gap" ||
    coverage === "unsupported" ||
    coverage === "unavailable"
  );
}

/**
 * A `terminal_gap` whose ENTIRE shortfall is proven permanently uncollectable
 * carries no OUTSTANDING gap: there is no future run, owner action, or code fix
 * that could fill it, because the items were measured and shown impossible (a
 * recorded observed size strictly above a recorded cap). The stream owes
 * nothing further, so it must not take the outstanding-gap branch — the same
 * fact `sourceCoverageCondition` already reads to answer `SourceCoverageComplete`
 * with a real `true`. Keeping both readings of the same evidence in agreement is
 * the point: a healthy condition set must not coexist with a `terminal`
 * disposition.
 *
 * Deliberately narrow in exactly the two ways the evidence is narrow:
 *
 *   - ONLY `terminal_gap`. `unsupported` / `unavailable` are claims about the
 *     stream as a whole rather than about a measured set of items, and keep
 *     returning `terminal`.
 *   - ONLY when the proof covers everything. Partial proof is not proof; the
 *     caller's boolean is already all-or-nothing
 *     (`isStreamFullyUnfillableAccounted`), so one unproven terminal gap leaves
 *     this `false` and the stream stays `terminal`.
 *
 * Open owner attention is checked BEFORE this softening in the gap block below,
 * so an attention-blocked connection still reads `awaiting_owner` — accounted
 * coverage is not a reason to stop asking the owner for what they owe.
 */
function isUnfillableAccountedTerminalGap(input: ForwardDispositionInput): boolean {
  return input.coverage === "terminal_gap" && input.unfillableAccounted === true && !input.attentionOpen;
}

/**
 * Derive a stream's forward disposition as a pure function of its coverage
 * condition, gap retryability, open-attention presence, freshness axis, and the
 * connection's refresh policy. First match wins, and gaps are evaluated before
 * freshness so a real coverage gap is never masked by staleness:
 *
 *   0. `terminal_gap` whose whole shortfall is proven unfillable, no
 *      attention                                          -> not a gap; falls to 4/5
 *   1. outstanding gap + open owner attention             -> `awaiting_owner`
 *   2. outstanding recoverable detail gap or ordinary
 *      partial boundary, no attention                     -> `resumable`
 *   3. outstanding terminal/unsupported gap with no
 *      recovery path, no attention                        -> `terminal`
 *   4. no outstanding gap, manual-refresh stale            -> `owner_refresh_due`
 *   5. no outstanding gap                                  -> `complete`
 *
 * `complete` is only reached when the coverage condition itself carries no
 * outstanding gap — it is never inferred from collected count. A stream whose
 * considered denominator is unknown carries an `unmeasured` disposition instead
 * of `complete`, `checking`, or `resumable`.
 *
 * Rule 0 resolves to `complete` rather than a distinct disposition because
 * `complete` already means "no outstanding gap; a future run is not expected to
 * collect anything new", which is precisely true here — it has never meant "no
 * gap was ever recorded". The accepted-absence conditions `deferred` and
 * `inventory_only` already reach `complete` the same way, with a recorded reason
 * for data that will not arrive. The distinguishing fact (WHY nothing is owed)
 * stays on the coverage axis, which reports the dedicated
 * `coverage_complete_unfillable_accounted` reason and keeps the per-stream
 * `coverage_condition: "terminal_gap"` visible; the disposition axis answers
 * only "what does the next run do".
 *
 * See `define-connector-progress-evidence-contract`.
 */
export function deriveForwardDisposition(input: ForwardDispositionInput): ForwardDisposition {
  if (hasOutstandingGap(input.coverage) && !isUnfillableAccountedTerminalGap(input)) {
    // Rule 1: a gap blocked on structured owner attention awaits the owner,
    // regardless of whether the gap would otherwise be retryable. The owner must
    // act before any run can make progress.
    if (input.attentionOpen) {
      return "awaiting_owner";
    }
    // Rule 3 (evaluated first within the gap block): a terminal / unsupported /
    // unavailable condition has no ordinary recovery path and is `terminal`
    // whatever the retryability flag claims. Sources/connectors must change for
    // these to collect.
    if (input.coverage === "terminal_gap" || input.coverage === "unsupported" || input.coverage === "unavailable") {
      return "terminal";
    }
    // Rule 2: a recoverable detail gap or an ordinary partial boundary is filled
    // by a later run without owner action. `partial` and `gaps` are ordinary
    // forward-collection boundaries; `retryable_gap` carries an explicit retry
    // path. An explicitly non-retryable generic gap has no recovery path.
    if (input.coverage === "partial" || input.coverage === "gaps" || input.gapRetryable) {
      return "resumable";
    }
    return "terminal";
  }

  // No outstanding gap. Before reaching `complete`, the coverage condition must
  // itself ESTABLISH completeness — never inferred from collected count. Only
  // `complete` (proven), `deferred`, and `inventory_only` (owe no further data by
  // manifest policy) qualify. An `unknown` coverage condition is absence of
  // evidence, not proof of completeness and not proof of a recoverable gap.
  // Keep it in a resting measurement-gap disposition rather than fabricating
  // `checking` or `resumable`.
  if (input.coverage === "unknown") {
    return "unmeasured";
  }

  // Rule 4: a complete stream on a manual-refresh-only connection whose data has
  // gone stale needs an owner-initiated run — the system will not refresh it on
  // its own. An assisted-refresh connection (schedulable, but whose posture
  // predicts bounded owner help) is likewise owner-refresh-due when stale: it
  // refreshes on schedule but may need the owner's bounded assistance to catch
  // up, so the disposition honestly names an owner-initiated/assisted run rather
  // than re-encoding staleness as a coverage gap. Coverage stays complete; only
  // the disposition carries the freshness fact. A manual-default connector with
  // an explicit owner-created enabled schedule is treated as schedulable here and
  // stays `complete` on the disposition axis (the connection-health projection
  // still raises its stale warning).
  if (
    input.freshness === "stale" &&
    !isExplicitOwnerScheduledManual(input.refresh, input.schedule) &&
    (isManualRefreshOnly(input.refresh) || isAssistedRefresh(input.refresh))
  ) {
    return "owner_refresh_due";
  }

  // Rule 5: established complete coverage (`complete` / `deferred` /
  // `inventory_only`) with fresh, unknown, or schedulable-stale freshness ->
  // `complete`.
  return "complete";
}

/**
 * Map the full connection-health input onto the five disposition signals and
 * derive the connection-level forward disposition. Pure — no I/O, no clock
 * reads — and intentionally separate from the headline classifier so the
 * disposition is a faithful function of the same durable evidence rather than
 * of the headline pill.
 *
 * Signal mapping (each is already durable evidence the projection holds):
 *
 *   - `coverage`      : the rolled-up coverage axis (`unknown` when absent),
 *                       which already encodes retryable vs terminal vs
 *                       accepted-absence. A contradictory manifest that names an
 *                       accepted axis (`unsupported` / `unavailable`) for a
 *                       required stream is carried on the axis itself, so it
 *                       resolves to `terminal` exactly as the per-stream rule
 *                       intends.
 *   - `gapRetryable`  : true only for the explicit `retryable_gap` axis. Other
 *                       gap axes (`partial` / `gaps`) are handled as ordinary
 *                       forward-collection boundaries by the helper, and
 *                       `terminal_gap` is terminal regardless of this flag.
 *   - `attentionOpen` : the SAME signal that drives the `needs_attention`
 *                       headline — the `AttentionClear` condition is `false`
 *                       (an open, non-expired structured attention prompt). This
 *                       keeps the disposition consistent with the pill: an
 *                       attention-blocked gap is `awaiting_owner` exactly when
 *                       the headline is `needs_attention`.
 *   - `freshness`     : the freshness axis (`unknown` when absent).
 *   - `refresh`       : the manifest refresh-policy evidence, used only to tell
 *                       a manual-refresh-stale stream (`owner_refresh_due`) from
 *                       a schedulable-stale one (the scheduler's own job).
 *
 * See `define-connector-progress-evidence-contract`.
 */
function deriveConnectionForwardDisposition(
  input: ComputeConnectionHealthInput,
  conditionSet: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>
): ForwardDisposition {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const coverage: CoverageAxis = input.coverage?.axis ?? "unknown";
  return deriveForwardDisposition({
    attentionOpen: conditionIsFalse(conditionSet, "AttentionClear"),
    coverage,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    freshness: input.freshness?.axis ?? "unknown",
    gapRetryable: coverage === "retryable_gap",
    refresh: input.refresh ?? null,
    schedule: input.schedule ?? null,
    // The SAME already-computed boolean `sourceCoverageCondition` reads for
    // `SourceCoverageComplete`, so the condition set and the disposition can
    // never disagree about a fully-accounted terminal gap. A contradictory
    // manifest (`requiredButAccepted`) is excluded here exactly as it is there:
    // the flag must never become a bypass for a manifest that both requires a
    // stream and accepts its absence.
    unfillableAccounted: input.coverage?.requiredButAccepted !== true && input.coverage?.unfillableAccounted === true,
  });
}

function backlogClearCondition(
  axes: ConnectionAxes,
  stalledCause: OutboxStalledCause | null,
  localDeviceBacked: boolean
): ConnectionHealthCondition {
  switch (axes.outbox) {
    case "idle":
      return condition({
        message: "No local-device outbox backlog is pending.",
        origin: "local_device",
        reason: CONDITION_REASON.OUTBOX_IDLE,
        severity: "info",
        status: "true",
        type: "BacklogClear",
      });
    case "active":
      return condition({
        message: "Local-device outbox work is currently draining.",
        origin: "local_device",
        reason: CONDITION_REASON.OUTBOX_ACTIVE,
        remediation: {
          action: "wait",
          label: "Wait for the local-device outbox to drain",
          retryable: true,
          target: "local_device",
        },
        severity: "info",
        status: "false",
        type: "BacklogClear",
      });
    case "stalled": {
      const copy = stalledCauseCopy(stalledCause);
      return condition({
        message: copy.backlogMessage,
        origin: "local_device",
        reason: copy.backlogReason,
        remediation: {
          action: copy.action,
          label: copy.remediationLabel,
          retryable: true,
          target: "local_device",
        },
        severity: copy.severity,
        status: "false",
        type: "BacklogClear",
      });
    }
    default:
      // Mirrors `localExporterAvailableCondition`: no local-device binding means
      // there is no outbox to have a backlog, which is settled. A bound
      // connection with no heartbeat yet stays honestly `unknown`.
      return localDeviceBacked
        ? condition({
            message: "No trusted local-device outbox evidence is available.",
            origin: "local_device",
            reason: CONDITION_REASON.OUTBOX_UNKNOWN,
            severity: "info",
            status: "unknown",
            type: "BacklogClear",
          })
        : condition({
            message: "This connection collects on the server, so there is no local-device outbox.",
            origin: "local_device",
            reason: CONDITION_REASON.OUTBOX_NOT_APPLICABLE,
            severity: "info",
            status: "not_applicable",
            type: "BacklogClear",
          });
  }
}

function isDegradingCoverage(axis: CoverageAxis): boolean {
  return axis === "gaps" || axis === "partial" || axis === "retryable_gap" || axis === "terminal_gap";
}

function firstReasonCode(input: ComputeConnectionHealthInput): string | null {
  return (
    input.run?.reasonCode ?? stripClassPrefix(input.backoff?.reasonClass ?? null) ?? input.attention?.reasonCode ?? null
  );
}

function isCredentialReason(reason: string): boolean {
  const normalized = conditionClassifierText(reason);
  return (
    normalized.includes("auth") ||
    normalized.includes("credential") ||
    normalized.includes("login") ||
    normalized.includes("reauth") ||
    normalized.includes("session_expired") ||
    normalized.includes("session_required") ||
    normalized.includes("session_failed") ||
    normalized.includes("token") ||
    normalized.includes("bad_credentials") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("invalid_client") ||
    normalized.includes("invalid_token") ||
    normalized.includes("401")
  );
}

function isBrowserSessionRepairReason(reason: string): boolean {
  const normalized = conditionClassifierText(reason);
  return (
    normalized.includes("session_required") ||
    normalized.includes("session_failed") ||
    normalized.includes("session_expired")
  );
}

function isDefinitiveStoredCredentialRejectionReason(reason: string): boolean {
  const normalized = conditionClassifierText(reason);
  return (
    normalized.includes("stored_credential_rejected") ||
    normalized.includes("bad_credentials") ||
    normalized.includes("credential_rejected") ||
    normalized.includes("invalid_password") ||
    normalized.includes("wrong_password") ||
    normalized.includes("401") ||
    normalized.includes("403")
  );
}

function runtimeDependencyReason(reason: string): string | null {
  const normalized = conditionClassifierText(reason);
  if (normalized.includes("browser_runtime_not_configured")) {
    return CONDITION_REASON.BROWSER_RUNTIME_NOT_CONFIGURED;
  }
  if (normalized.includes("missing_browser_surface")) {
    return CONDITION_REASON.MISSING_BROWSER_SURFACE;
  }
  if (normalized.includes("missing_runtime_binding") || normalized.includes("runtime_binding_missing")) {
    return CONDITION_REASON.RUNTIME_BINDING_MISSING;
  }
  if (isExternalToolUnavailableReason(normalized)) {
    return CONDITION_REASON.EXTERNAL_TOOL_UNAVAILABLE;
  }
  return null;
}

function isExternalToolUnavailableReason(normalized: string): boolean {
  return (
    normalized.includes("binary_missing") ||
    normalized.includes("external_tool_missing") ||
    normalized.includes("external_tool_unavailable")
  );
}

function conditionClassifierText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Deliberately keeps literal token-prefix shapes (github_pat_/gho_/ghp_,
// xox[baprs]-) alongside the generic secret-syntax patterns
// (`key: value`/`bearer …`) rather than moving them to a manifest-declared
// list. This is a defense-in-depth leak filter applied to arbitrary
// upstream/connector-authored condition text before it is persisted and
// displayed — it must catch a real secret even when a manifest is stale,
// missing, or the leak comes from a connector whose manifest never declared
// this shape. Trusting only manifest-declared prefixes here would make the
// filter's coverage a function of manifest completeness instead of a fixed
// security invariant. LONG_OPAQUE_CONDITION_PATTERN (below) is the
// content-agnostic backstop for prefix shapes this list doesn't name.
const SECRET_CONDITION_PATTERN =
  /(authorization\s*[:=]|bearer\s+[A-Za-z0-9]|cookie\s*[:=]|credential\s*[:=]|github_pat_|gho_|ghp_|password\s*[:=]|secret\s*[:=]|token\s*[:=]|xox[baprs]-)/i;
const LONG_OPAQUE_CONDITION_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/;

function normalizeConditionReason(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  if (containsSecretLike(value)) {
    return fallback;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function containsSecretLike(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return SECRET_CONDITION_PATTERN.test(value) || LONG_OPAQUE_CONDITION_PATTERN.test(value);
}

function readinessBlockedCondition(conditions: readonly ConnectionHealthCondition[]): ConnectionHealthCondition | null {
  const conditionSet = indexConditions(conditions);
  if (conditionSet.get("CollectionSucceeded")?.status === "true") {
    return null;
  }
  return (
    conditions.find(
      (item) =>
        item.status === "false" &&
        item.severity === "blocked" &&
        (item.type === "CredentialsValid" || item.type === "RuntimeAvailable")
    ) ?? null
  );
}

function pickDominantConditionId(
  state: ConnectionHealthState,
  conditions: readonly ConnectionHealthCondition[]
): string | null {
  const byType = new Map(conditions.map((item) => [item.type, item]));
  switch (state) {
    case "unknown":
      return failingConditionId(byType.get("ProjectionReliable")) ?? unknownConditionId(conditions);
    case "idle":
      // A stale advisory idle (manual-refresh-only or assisted-refresh)
      // surfaces the stale `Fresh` condition so the owner sees "refresh due";
      // a paused-schedule idle surfaces the paused `ScheduleEligible` condition.
      return (
        staleAdvisoryFreshConditionId(byType.get("Fresh")) ??
        conditionId(byType.get("ScheduleEligible"), "false") ??
        null
      );
    case "needs_attention":
      return failingConditionId(byType.get("AttentionClear"));
    case "blocked":
      return (
        failingConditionId(byType.get("CredentialsValid")) ??
        conditionId(byType.get("RuntimeAvailable"), "false") ??
        failingConditionId(byType.get("RetryPolicyClear"))
      );
    case "cooling_off":
      return failingConditionId(byType.get("RetryPolicyClear"));
    case "degraded":
      return firstConditionId(conditions, [
        "RuntimeAvailable",
        "RemoteSurfaceAvailable",
        "LocalExporterAvailable",
        "SourceCoverageComplete",
        "Fresh",
        "BacklogClear",
        "CollectionSucceeded",
      ]);
    case "healthy":
      return null;
    default:
      return null;
  }
}

function pickSupportingConditionIds(
  conditions: readonly ConnectionHealthCondition[],
  dominantConditionId: string | null
): readonly string[] {
  const ids: string[] = [];
  if (dominantConditionId) {
    ids.push(dominantConditionId);
  }
  for (const conditionValue of conditions) {
    if (ids.length >= 6) {
      break;
    }
    if (conditionValue.id === dominantConditionId) {
      continue;
    }
    if (conditionValue.status === "true" && conditionValue.severity === "info") {
      continue;
    }
    // A condition this connection cannot answer is a settled fact, not a pending
    // verdict. Surfacing it would tell the owner to wait for evidence that no
    // deployment change short of enrolling a local collector or installing the
    // remote-surface package could ever produce.
    if (conditionValue.status === "not_applicable") {
      continue;
    }
    ids.push(conditionValue.id);
  }
  return ids;
}

function conditionId(
  conditionValue: ConnectionHealthCondition | undefined,
  status: ConnectionConditionStatus
): string | null {
  return conditionValue?.status === status ? conditionValue.id : null;
}

function failingConditionId(conditionValue: ConnectionHealthCondition | undefined): string | null {
  return conditionId(conditionValue, "false");
}

function staleAdvisoryFreshConditionId(conditionValue: ConnectionHealthCondition | undefined): string | null {
  if (conditionValue?.status !== "false") {
    return null;
  }
  return conditionValue.reason === CONDITION_REASON.STALE_MANUAL_REFRESH ||
    conditionValue.reason === CONDITION_REASON.STALE_ASSISTED_REFRESH
    ? conditionValue.id
    : null;
}

function firstConditionId(
  conditions: readonly ConnectionHealthCondition[],
  types: readonly ConnectionConditionType[]
): string | null {
  for (const type of types) {
    const found = conditions.find((item) => item.type === type && item.status === "false");
    if (found) {
      return found.id;
    }
  }
  return null;
}

function unknownConditionId(conditions: readonly ConnectionHealthCondition[]): string | null {
  return conditions.find((item) => item.status === "unknown")?.id ?? null;
}

function degradedReasonCode(input: ComputeConnectionHealthInput): string | null {
  if (input.run?.reasonCode) {
    return input.run.reasonCode;
  }
  if (input.backoff?.reasonClass) {
    return stripClassPrefix(input.backoff.reasonClass);
  }
  // No run/backoff reason but the remote surface failed — surface that
  // reason so the dashboard can render "surface: surface_unhealthy"
  // instead of an empty reason_code on a degraded pill.
  if (input.remoteSurface?.axis === "failed") {
    const reason = input.remoteSurface.waitReason ?? input.remoteSurface.leaseStatus;
    if (reason) {
      return `remote_surface:${reason}`;
    }
    return CONDITION_REASON.REMOTE_SURFACE_FAILED;
  }
  return null;
}

// ─── Builders ─────────────────────────────────────────────────────────────

interface SnapshotArgs {
  readonly axes: ConnectionAxes;
  readonly badges: ConnectionBadges;
  readonly collectionRate?: CollectionRateSnapshot | null;
  readonly conditions: readonly ConnectionHealthCondition[];
  readonly detailGapBacklog?: DetailGapBacklog | null;
  readonly dominantConditionId: string | null;
  readonly ephemeralBrowserRuntime?: EphemeralBrowserRuntimeProjection | null | undefined;
  readonly forwardDisposition: ForwardDisposition;
  readonly lastSuccessAt: string | null;
  readonly localDeviceOutboxCounts?: OutboxDiagnosticCounts | null;
  readonly nextAction?: NextAction | null;
  readonly nextAttemptAt: string | null;
  readonly reasonCode: string | null;
  readonly remoteSurface?: RemoteSurfaceDetail | null;
  readonly state: ConnectionHealthState;
  readonly supportingConditionIds: readonly string[];
  readonly unknownReasons?: readonly string[];
}

function snapshot(args: SnapshotArgs): ConnectionHealthSnapshot {
  return {
    axes: args.axes,
    badges: args.badges,
    collection_rate: args.collectionRate ?? null,
    conditions: args.conditions,
    detail_gap_backlog: args.detailGapBacklog ?? null,
    dominant_condition_id: args.dominantConditionId,
    ephemeral_browser_runtime: runtimeAnnotationForSnapshot(args.ephemeralBrowserRuntime),
    forward_disposition: args.forwardDisposition,
    last_success_at: args.lastSuccessAt,
    local_device_outbox_counts: args.localDeviceOutboxCounts ?? null,
    next_action: args.nextAction ?? null,
    next_attempt_at: args.nextAttemptAt,
    reason_code: args.reasonCode,
    remote_surface: args.remoteSurface ?? null,
    state: args.state,
    supporting_condition_ids: args.supportingConditionIds,
    unknown_reasons: args.unknownReasons ?? [],
  };
}

/** The owner wire contract represents absent runtime evidence as `null`, never `undefined`. */
function runtimeAnnotationForSnapshot(
  runtime: EphemeralBrowserRuntimeProjection | null | undefined
): EphemeralBrowserRuntimeProjection | null {
  return runtime ?? null;
}

/**
 * Project a non-secret CTA from already-filtered structured attention
 * evidence. Secret-sensitive records yield a CTA with `reason_code` only
 * (and `source: "structured"`), never `owner_copy` or any field that
 * could leak the secret payload — the dashboard renders a generic "Owner
 * action needed" without details. Callers that want stronger suppression
 * should filter the record out entirely before passing it in.
 *
 * When the caller could not supply a structured `id` / `ownerAction`
 * (e.g. the evidence was synthesized from a schedule's
 * `human_attention_needed` flag), the CTA's `source` degrades to
 * `schedule_fallback` so the dashboard can present a caveated label.
 */
function projectNextAction(attention: ConnectionAttentionEvidence): NextAction {
  const isStructured = attention.id !== null && attention.ownerAction !== null;
  const source: NextAction["source"] = isStructured ? "structured" : "schedule_fallback";
  // Schedule-fallback evidence has no durable record, so notification
  // state is unknown — surface `null` rather than fabricating `pending`.
  const notificationState: NextAction["notification_state"] = isStructured
    ? (attention.notificationState ?? "pending")
    : null;
  if (attention.sensitivity === "secret") {
    // Block every potentially-revealing field; keep the bare minimum so
    // the dashboard can still render "owner action needed" with a
    // reason code (which is a controlled enum, not free text).
    return {
      action_target: null,
      attention_id: attention.id,
      expires_at: attention.expiresAt,
      notification_state: notificationState,
      owner_action: attention.ownerAction,
      reason_code: attention.reasonCode,
      response_contract: attention.responseContract,
      source,
    };
  }
  return {
    action_target: attention.actionTarget,
    attention_id: attention.id,
    expires_at: attention.expiresAt,
    notification_state: notificationState,
    owner_action: attention.ownerAction,
    reason_code: attention.reasonCode,
    response_contract: attention.responseContract,
    source,
  };
}

// ─── Outbox axis derivation from device-side heartbeat evidence ───────────

/**
 * Heartbeat evidence the server has legitimately received from an enrolled
 * device for one source instance. The server never reads the device's
 * SQLite outbox directly — these fields are the only legitimate bridge.
 */
export interface HeartbeatOutboxEvidence {
  /**
   * Open-backlog row count the device last reported (from its rolled-up
   * outbox diagnostics `backlog_open` field). For a `gap`-kind row this
   * counts `ready`, `leased`, AND `succeeded` — `succeeded` means the gap
   * NOTIFICATION uploaded, not that the gap is resolved (see
   * `local-device-outbox.ts::countOpenGaps`), so a small nonzero count can be
   * pure debris from a superseded collector attempt rather than a live
   * backlog. Distinguishes that bounded-debris case from a genuine
   * state-read failure when a `blocked` heartbeat carries no dead letters —
   * see `OUTBOX_BLOCKED_BACKLOG_TOLERANCE`. `null`/absent is treated as
   * unknown magnitude, which does NOT get the debris carve-out (conservative:
   * missing evidence classifies as `state_read_failed`, same as before this
   * field existed).
   */
  readonly backlogOpenCount?: number | null;
  /**
   * Dead-lettered record depth the device last reported (from its rolled-up
   * outbox diagnostics). Distinguishes a `blocked` heartbeat that is a pure
   * state-read failure (no dead letters) from one carrying a dead-letter
   * backlog. `null`/absent is treated as zero — a `blocked` heartbeat with no
   * dead-letter evidence is classified `state_read_failed` (subject to the
   * bounded-debris carve-out above).
   */
  readonly deadLetterCount?: number | null;
  readonly deadLetterErrorClasses?: readonly DeadLetterErrorClassEvidence[] | null;
  /**
   * Whether the device + source-instance row constitutes trustworthy
   * evidence (device active, source active, not revoked). The caller
   * decides; the projection trusts the flag.
   */
  readonly evidenceTrusted: boolean;
  /** ISO timestamp of the most recent accepted heartbeat, or null. */
  readonly lastHeartbeatAt: string | null;
  /** Last reported `status` from the heartbeat body. */
  readonly lastHeartbeatStatus: "blocked" | "healthy" | "retrying" | "starting" | "stopped" | null;
  /**
   * ISO timestamp of the oldest still-`ready` outbox row that has actually
   * failed at least once (`attempt_count > 0`), i.e. real retry evidence —
   * NOT the oldest ready row overall. A large healthy first drain enqueues
   * rows that can sit `ready` for hours before their first attempt without
   * ever failing; using the oldest-ready timestamp for an age policy would
   * label that in-progress, never-failed backlog a stuck retry. `null`/
   * absent/unparseable is treated as "no retry-age evidence": the
   * backlog-age check below never fires, so a missing or malformed
   * timestamp fails conservatively (stays at its pre-existing axis) rather
   * than fabricating a stall.
   */
  readonly oldestRetryingAt?: string | null;
  /** Pending durable work depth the device last reported. */
  readonly recordsPending: number | null;
}

/**
 * Outbox axis derivation from server-visible heartbeat evidence.
 *
 * Maps the most recent heartbeat for a connection's source instance onto
 * `idle | active | stalled | unknown`. The mapping is conservative: when
 * evidence is missing or untrustworthy, the axis is `unknown` rather
 * than a false-green `idle`.
 *
 * Stale-heartbeat detection: if pending work is reported and the
 * heartbeat is older than `staleHeartbeatThresholdMs` (an explicit named
 * policy constant passed by the caller), the axis degrades to
 * `stalled`. The same age check applies to a `starting`/`retrying`
 * heartbeat with no pending work reported: those statuses claim
 * in-flight work is happening right now, so a stale one is exactly as
 * dead as a stale `pending` count. Both prevent a connection from
 * sitting in `active` indefinitely after the collector dies (mid-drain,
 * or before it ever reports its first `healthy` heartbeat — e.g. the
 * host or the collector process was killed on restart without a final
 * heartbeat).
 *
 * Stale-backlog detection: a *fresh* heartbeat with pending work does not,
 * by itself, prove the backlog is healthy — an explicit-transient row
 * retries forever by design (see `collector-runner.ts`'s
 * `classifyLocalDeviceFailure`), so a permanently-broken endpoint that
 * happens to fail in a retryable shape (5xx, timeout, network fault) would
 * otherwise sit in `active` forever with a live-looking heartbeat. This
 * check is keyed on `evidence.oldestRetryingAt` — the oldest row with real
 * retry evidence (`attempt_count > 0`), NOT the oldest ready row overall.
 * Age alone cannot answer whether a retry is stuck: a large healthy first
 * drain enqueues rows that sit `ready` for hours before their first
 * attempt without ever failing, and using oldest-ready age would falsely
 * degrade that in-progress, never-failed backlog. When
 * `evidence.oldestRetryingAt` is older than
 * `OUTBOX_STALE_RETRYING_BACKLOG_AGE_MS`, the axis degrades to `stalled`
 * with cause `transient_upload_failure` — the same system-handled,
 * no-owner-action cause already used for a dead-lettered transient-5xx
 * summary, since both describe the same situation: the system, not the
 * owner, owns recovery. A missing or unparseable `oldestRetryingAt` (no row
 * has ever failed) never triggers this path, so an ordinary healthy
 * backlog fails conservatively rather than fabricating a stall.
 *
 * Bounded-debris carve-out for `blocked` heartbeats: a device-side `gap`
 * outbox row counts toward `backlog_open` while `succeeded` — for that
 * row kind, `succeeded` means the gap NOTIFICATION uploaded, not that the
 * gap is resolved (see `local-device-outbox.ts::countOpenGaps`). A failed
 * collector attempt immediately superseded by a successful one leaves
 * exactly this debris behind, and nothing ever re-drains a `succeeded`
 * row, so without this carve-out the connection would sit `stalled`
 * forever despite fully healthy collection evidence. When a `blocked`
 * heartbeat has zero dead letters, a small (`<= OUTBOX_BLOCKED_BACKLOG_
 * TOLERANCE`) `backlogOpenCount`, zero pending records, and a fresh
 * heartbeat, the axis is `idle` rather than `stalled` — the notification
 * already delivered; there is nothing left to retry or drain, and no
 * owner action can resolve a row in a local SQLite file that will never
 * be picked up again. Any of those signals failing (large or unknown
 * backlog count, real pending work, or a stale heartbeat) falls through
 * to the pre-existing `state_read_failed` classification, which stays the
 * conservative default.
 */
export function deriveOutboxAxisFromHeartbeat(
  evidence: HeartbeatOutboxEvidence,
  options: {
    readonly nowIso: string;
    readonly staleHeartbeatThresholdMs: number;
  }
): { axis: OutboxAxis; cause: OutboxStalledCause | null; unreliable: boolean } {
  if (!evidence.evidenceTrusted) {
    return { axis: "unknown", cause: null, unreliable: true };
  }
  if (!evidence.lastHeartbeatAt) {
    return { axis: "unknown", cause: null, unreliable: false };
  }
  const heartbeatAgeMs = ageMs(evidence.lastHeartbeatAt, options.nowIso);
  const pending = evidence.recordsPending ?? 0;
  const heartbeatStale = heartbeatAgeMs !== null && heartbeatAgeMs > options.staleHeartbeatThresholdMs;

  if (evidence.lastHeartbeatStatus === "blocked") {
    return classifyBlockedHeartbeat(evidence, { heartbeatStale, pending });
  }

  if (pending > 0 && heartbeatStale) {
    return { axis: "stalled", cause: "stale_pending", unreliable: false };
  }
  const retryingBacklogAgeMs = ageMs(evidence.oldestRetryingAt ?? null, options.nowIso);
  if (pending > 0 && retryingBacklogAgeMs !== null && retryingBacklogAgeMs > OUTBOX_STALE_RETRYING_BACKLOG_AGE_MS) {
    return { axis: "stalled", cause: "transient_upload_failure", unreliable: false };
  }
  if (evidence.lastHeartbeatStatus === "starting" || evidence.lastHeartbeatStatus === "retrying") {
    if (heartbeatStale) {
      return { axis: "stalled", cause: "stale_heartbeat", unreliable: false };
    }
    return { axis: "active", cause: null, unreliable: false };
  }
  if (pending > 0) {
    return { axis: "active", cause: null, unreliable: false };
  }
  if (evidence.lastHeartbeatStatus === "healthy" || evidence.lastHeartbeatStatus === "stopped") {
    return { axis: "idle", cause: null, unreliable: false };
  }
  return { axis: "unknown", cause: null, unreliable: false };
}

/**
 * Classifies a `blocked` heartbeat: dead letters -> retry+re-run backlog;
 * none -> either a bounded-debris carve-out (`idle`) or a genuine
 * state-read failure. Extracted from `deriveOutboxAxisFromHeartbeat` to
 * keep that function's cognitive complexity within the repo's lint budget.
 */
function classifyBlockedHeartbeat(
  evidence: HeartbeatOutboxEvidence,
  age: { heartbeatStale: boolean; pending: number }
): { axis: OutboxAxis; cause: OutboxStalledCause | null; unreliable: boolean } {
  // A blocked heartbeat with dead letters is a backlog to retry+re-run; a
  // blocked heartbeat with none is a failed state read cleared by re-running.
  // Mirrors the device-side `last_error.kind` split.
  if ((evidence.deadLetterCount ?? 0) > 0) {
    return {
      axis: "stalled",
      cause: deadLetterStalledCause(evidence.deadLetterCount ?? 0, evidence.deadLetterErrorClasses ?? null),
      unreliable: false,
    };
  }
  if (qualifiesForBoundedDebrisCarveOut(evidence, age)) {
    return { axis: "idle", cause: null, unreliable: false };
  }
  return { axis: "stalled", cause: "state_read_failed", unreliable: false };
}

/**
 * Bounded-debris carve-out: a small `backlog_open` count with zero dead
 * letters, zero pending records, and a fresh heartbeat is read as stray
 * gap-NOTIFICATION rows left behind by a superseded attempt (see
 * `OUTBOX_BLOCKED_BACKLOG_TOLERANCE`), not a genuinely unreadable exporter
 * state — the notification already uploaded; nothing is waiting to drain.
 * `backlogOpenCount` absent/null does not qualify (unknown magnitude
 * classifies conservatively, same as before this carve-out existed). A
 * stale heartbeat or nonzero pending work also disqualifies: those are
 * exactly the signals that distinguish "collector genuinely stuck" from
 * "one clean row".
 */
function qualifiesForBoundedDebrisCarveOut(
  evidence: HeartbeatOutboxEvidence,
  age: { heartbeatStale: boolean; pending: number }
): boolean {
  return (
    typeof evidence.backlogOpenCount === "number" &&
    evidence.backlogOpenCount > 0 &&
    evidence.backlogOpenCount <= OUTBOX_BLOCKED_BACKLOG_TOLERANCE &&
    age.pending === 0 &&
    !age.heartbeatStale
  );
}

function deadLetterStalledCause(
  deadLetterCount: number,
  classes: readonly DeadLetterErrorClassEvidence[] | null
): OutboxStalledCause {
  if (isCompleteTransientDeadLetterSummary(deadLetterCount, classes)) {
    return "transient_upload_failure";
  }
  return "dead_letter_backlog";
}

function isCompleteTransientDeadLetterSummary(
  deadLetterCount: number,
  classes: readonly DeadLetterErrorClassEvidence[] | null
): boolean {
  if (deadLetterCount <= 0 || !classes || classes.length === 0) {
    return false;
  }
  const summarizedCount = classes.reduce((total, item) => total + Math.max(0, item.count), 0);
  return (
    summarizedCount >= deadLetterCount && classes.every((item) => isTransientDeadLetterErrorClass(item.error_class))
  );
}

const LOCAL_DEVICE_5XX_PATTERN = /local device request failed:\s*5\d\d/;

function isTransientDeadLetterErrorClass(errorClass: string): boolean {
  const normalized = errorClass.toLowerCase();
  return (
    LOCAL_DEVICE_5XX_PATTERN.test(normalized) ||
    normalized.includes("request timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("fetch failed") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("etimedout") ||
    normalized.includes("eai_again") ||
    normalized.includes("enotfound")
  );
}

function ageMs(iso: string | null, nowIso: string): number | null {
  if (iso === null) {
    return null;
  }
  const observed = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!(Number.isFinite(observed) && Number.isFinite(now))) {
    return null;
  }
  return now - observed;
}

// `scheduler-backoff.ts::reasonClassOf` prefixes the class with `terminal:`,
// `failure:`, or `connector:`. Dashboard wants the raw reason code.
function stripClassPrefix(reasonClass: string | null): string | null {
  if (!reasonClass) {
    return null;
  }
  const colon = reasonClass.indexOf(":");
  if (colon < 0) {
    return reasonClass;
  }
  const suffix = reasonClass.slice(colon + 1);
  return suffix.length > 0 ? suffix : null;
}

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
 *   5. backoff currently delaying retry            -> cooling_off
 *   6. outbox stalled / coverage/run incomplete    -> degraded
 *   7. current evidence without collection verdict -> unknown
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

import { BLOCKED_PROMOTION_THRESHOLD } from "./connection-health-policy.ts";
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
  | "CredentialsValid"
  | "Fresh"
  | "LocalExporterAvailable"
  | "ProjectionReliable"
  | "RemoteSurfaceAvailable"
  | "RetryPolicyClear"
  | "RuntimeAvailable"
  | "ScheduleEligible"
  | "SourceCoverageComplete";

export type ConnectionConditionStatus = "false" | "true" | "unknown";

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
  COLLECTION_SUCCEEDED_LOCAL_DEVICE: "collection_succeeded_local_device",
  COVERAGE_UNKNOWN: "coverage_unknown",
  CREDENTIAL_REJECTED: "credential_rejected",
  CREDENTIALS_ACCEPTED: "credentials_accepted",
  CREDENTIALS_NOT_PROBED: "credentials_not_probed",
  EXTERNAL_TOOL_UNAVAILABLE: "external_tool_unavailable",
  FRESH: "fresh",
  FRESHNESS_UNKNOWN: "freshness_unknown",
  LOCAL_EXPORTER_ACTIVE: "local_exporter_active",
  LOCAL_EXPORTER_DEAD_LETTER_BACKLOG: "local_exporter_dead_letter_backlog",
  LOCAL_EXPORTER_IDLE: "local_exporter_idle",
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
  OUTBOX_STALE_PENDING: "outbox_stale_pending",
  OUTBOX_STALLED: "outbox_stalled",
  OUTBOX_STATE_READ_FAILED: "outbox_state_read_failed",
  OUTBOX_TRANSIENT_UPLOAD_FAILURE: "outbox_transient_upload_failure",
  OUTBOX_UNKNOWN: "outbox_unknown",
  PROJECTION_CURRENT: "projection_current",
  PROJECTION_UNRELIABLE: "projection_unreliable",
  REMOTE_SURFACE_AVAILABLE: "remote_surface_available",
  REMOTE_SURFACE_FAILED: "remote_surface_failed",
  REMOTE_SURFACE_NOT_REQUIRED: "remote_surface_not_required",
  REMOTE_SURFACE_UNKNOWN: "remote_surface_unknown",
  RUNTIME_AVAILABLE: "runtime_available",
  RUNTIME_NOT_MANAGED: "runtime_not_managed",
  RUNTIME_STATE_UNKNOWN: "runtime_state_unknown",
  RUNTIME_UNAVAILABLE: "runtime_unavailable",
  RUNTIME_BINDING_MISSING: "runtime_binding_missing",
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
 *   - `checking`          : coverage evidence is not available yet. This is
 *                           visibly unknown, but SHALL NOT claim a recoverable
 *                           gap or ask the owner to retry.
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
  | "terminal";

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

/**
 * Roll up several source instances' `OutboxDiagnosticCounts` into one
 * connection-level summary. Pure — no I/O, no clock reads.
 *
 * The numeric count fields are summed; `oldest_pending_at` takes the
 * earliest non-null timestamp so the connection reports the longest-waiting
 * record across its sources. A non-finite or negative count is ignored
 * (treated as absent) rather than poisoning the sum — the store already
 * normalizes counts, but this keeps the helper safe for any caller.
 *
 * Returns `null` when no input carries any numeric count, so a connection
 * with only empty/absent diagnostics surfaces no count rollup rather than a
 * misleading all-zero object.
 */
export function rollupOutboxDiagnosticCounts(
  items: readonly (OutboxDiagnosticCounts | null | undefined)[]
): OutboxDiagnosticCounts | null {
  const sums = new Map<OutboxDiagnosticCountField, number>();
  let oldestPendingAt: string | null = null;
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
    if (
      typeof item.oldest_pending_at === "string" &&
      item.oldest_pending_at.length > 0 &&
      (oldestPendingAt === null || item.oldest_pending_at < oldestPendingAt)
    ) {
      oldestPendingAt = item.oldest_pending_at;
    }
  }
  if (sums.size === 0 && oldestPendingAt === null) {
    return null;
  }
  const result: OutboxDiagnosticCounts = Object.fromEntries(sums);
  return oldestPendingAt === null ? result : { ...result, oldest_pending_at: oldestPendingAt };
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
    pending,
    pending_is_floor: pendingIsFloor,
    pending_other: pendingOther,
    pending_other_is_floor: pendingOtherIsFloor,
    max_attempt_count: maxAttemptCount,
    next_attempt_at: nextAttemptAt,
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
}

/**
 * Freshness evidence. The caller compares last-successful-progress against
 * the configured freshness policy and emits `fresh | stale | unknown`.
 */
export interface ConnectionFreshnessEvidence {
  readonly axis: FreshnessAxis;
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

export interface ComputeConnectionHealthInput {
  readonly activity: ConnectionActivityEvidence | null;
  readonly attention: ConnectionAttentionEvidence | null;
  readonly backoff: ConnectionBackoffEvidence | null;
  /**
   * Adaptive collection rate controller snapshot. Passed through verbatim from
   * the caller (the reference derives it from run-trace progress events). Pure
   * annotation: no classification step reads it, so it cannot move the headline
   * state or any axis. `null`/absent yields a `null` rollup on the snapshot.
   */
  readonly collectionRate?: CollectionRateSnapshot | null;
  readonly coverage: ConnectionCoverageEvidence | null;
  /**
   * Source-pressure detail-gap backlog evidence. The projection derives the
   * additive {@link DetailGapBacklog} rollup from it via
   * {@link deriveSourcePressureBacklog} and attaches it to the snapshot. It is
   * pure annotation: no classification step reads it, so it cannot move the
   * headline state or any axis. `null`/absent yields a `null` rollup.
   */
  readonly detailGapBacklog?: ConnectionDetailGapBacklogEvidence | null;
  readonly freshness: ConnectionFreshnessEvidence | null;
  readonly localDeviceCollection?: ConnectionLocalDeviceCollectionEvidence | null;
  readonly observedAt?: string | null;
  readonly outbox: ConnectionOutboxEvidence | null;
  readonly projection: ConnectionProjectionEvidence | null;
  readonly refresh?: ConnectionRefreshEvidence | null;
  readonly remoteSurface?: ConnectionRemoteSurfaceEvidence | null;
  readonly run: ConnectionRunEvidence | null;
  readonly schedule: ConnectionScheduleEvidence | null;
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
// owner pause beats blocking conditions beats retry exhaustion beats backoff
// beats degraded evidence beats no-verdict beats healthy.
const HEALTH_CLASSIFICATION_STEPS: readonly ClassificationStep[] = [
  classifyUnreliableProjection,
  classifyOpenAttention,
  classifyOwnerPaused,
  classifyReadinessBlocked,
  classifyRetryPolicyExhausted,
  classifyCoolingOff,
  classifyDegradedEvidence,
  classifyCurrentEvidenceWithoutVerdict,
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
  const remoteSurface = projectRemoteSurfaceDetail(input.remoteSurface ?? null);
  const lastSuccessAt = input.run?.lastSuccessAt ?? null;
  const nextAttemptAt = conditionExpired(input.backoff?.nextRunAt ?? null, input.observedAt ?? null)
    ? null
    : (input.backoff?.nextRunAt ?? null);
  const ctx: ClassificationContext = {
    axes,
    badges,
    conditions,
    conditionSet,
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
      forwardDisposition,
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
    state: "unknown",
    reasonCode: null,
    lastSuccessAt,
    nextAttemptAt,
    axes,
    badges,
    remoteSurface,
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
    state: "unknown",
    reasonCode: null,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
    unknownReasons: ctx.input.projection?.unreliableSources ?? [],
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
    state: "needs_attention",
    reasonCode: attention.reason,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
    nextAction: ctx.input.attention ? projectNextAction(ctx.input.attention) : null,
  };
}

function classifyOwnerPaused(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 3. Owner-paused -> idle. Manual pause beats run/coverage/backoff state
  //    because the system is intentionally not making progress.
  if (ctx.conditionSet.get("ScheduleEligible")?.status !== "false") {
    return null;
  }
  return {
    state: "idle",
    reasonCode: null,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: null,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
  };
}

function classifyReadinessBlocked(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  const blocker = readinessBlockedCondition(ctx.conditions);
  if (!blocker) {
    return null;
  }
  return {
    state: "blocked",
    reasonCode: blocker.reason,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
  };
}

function classifyRetryPolicyExhausted(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 4. Give-up streak crossed -> blocked.
  const retryPolicy = ctx.conditionSet.get("RetryPolicyClear");
  if (!(retryPolicy?.status === "false" && retryPolicy.severity === "blocked")) {
    return null;
  }
  return {
    state: "blocked",
    reasonCode: retryPolicy.reason,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
  };
}

function classifyCoolingOff(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 5. Backoff currently delaying retry -> cooling_off.
  const retryPolicy = ctx.conditionSet.get("RetryPolicyClear");
  if (retryPolicy?.status !== "false") {
    return null;
  }
  return {
    state: "cooling_off",
    reasonCode: retryPolicy.reason,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
  };
}

function classifyDegradedEvidence(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 6. Outbox stalled, coverage incomplete, gaps present, or last run failed
  //    -> degraded. Success-with-gaps must not be healthy.
  if (!hasDegradingCondition(ctx.conditions)) {
    return null;
  }
  return {
    state: "degraded",
    reasonCode: degradedReasonCode(ctx.input),
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
  };
}

function classifyCurrentEvidenceWithoutVerdict(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 6b. If fresh retained/source evidence exists but no terminal collection
  //     verdict exists, the health verdict is unknown, not idle. Local outbox
  //     availability and active draining are orthogonal axis evidence.
  if (
    !(
      ctx.conditionSet.get("CollectionSucceeded")?.status === "unknown" &&
      hasFreshEvidenceWithoutCollectionVerdict(ctx.conditionSet)
    )
  ) {
    return null;
  }
  return {
    state: "unknown",
    reasonCode: null,
    lastSuccessAt: null,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
    unknownReasons: ["collection"],
  };
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
    state: "idle",
    reasonCode: expectedReason,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
  };
}

function classifyManualStaleAdvisory(ctx: ClassificationContext): ReturnType<ClassificationStep> {
  // 6b'. Manual / paused / background-unsafe connector that is otherwise green
  //      but whose data has aged past its staleness window -> idle with a
  //      manual-refresh advisory, NOT degraded.
  return classifyStaleAdvisory(ctx, isManualRefreshOnly(ctx.input.refresh), CONDITION_REASON.STALE_MANUAL_REFRESH);
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
    state: "idle",
    reasonCode: null,
    lastSuccessAt: null,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
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
    state: "healthy",
    reasonCode: null,
    lastSuccessAt: ctx.lastSuccessAt,
    nextAttemptAt: ctx.nextAttemptAt,
    axes: ctx.axes,
    badges: ctx.badges,
    remoteSurface: ctx.remoteSurface,
  };
}

function hasFreshEvidenceWithoutCollectionVerdict(
  conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>
): boolean {
  return conditionIsTrue(conditions, "Fresh");
}

// ─── Axis projection ──────────────────────────────────────────────────────

function projectAxes(input: ComputeConnectionHealthInput): ConnectionAxes {
  return {
    freshness: input.freshness?.axis ?? "unknown",
    coverage: input.coverage?.axis ?? "unknown",
    attention: input.attention ? input.attention.lifecycle : "none",
    outbox: input.outbox?.axis ?? "unknown",
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
    syncing: Boolean(input.activity?.active),
    stale: axes.freshness === "stale",
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

function hasDegradingCondition(conditions: readonly ConnectionHealthCondition[]): boolean {
  return conditions.some((item) => {
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
  });
}

function isHealthyConditionSet(conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>): boolean {
  return (
    conditionIsTrue(conditions, "CollectionSucceeded") &&
    conditionIsTrue(conditions, "SourceCoverageComplete") &&
    conditionIsTrue(conditions, "Fresh") &&
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
  return [
    projectionReliableCondition(input),
    scheduleEligibleCondition(input),
    retryPolicyClearCondition(input),
    attentionClearCondition(input),
    collectionSucceededCondition(input),
    credentialsValidCondition(input),
    runtimeAvailableCondition(input),
    remoteSurfaceAvailableCondition(input),
    localExporterAvailableCondition(axes, stalledCause),
    sourceCoverageCondition(input, axes),
    freshCondition(input, axes),
    backlogClearCondition(axes, stalledCause),
  ].map((item) => {
    const conditionObservedAt = item.observed_at ?? observedAt;
    return {
      ...item,
      observed_at: conditionObservedAt,
      current: conditionIsCurrent(item.expires_at, conditionObservedAt),
    };
  });
}

function condition(input: {
  readonly type: ConnectionConditionType;
  readonly status: ConnectionConditionStatus;
  readonly severity: ConnectionConditionSeverity;
  readonly reason: string;
  readonly message: string;
  readonly origin: ConnectionConditionOrigin;
  readonly observedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly sensitivity?: ConnectionConditionSensitivity;
  readonly remediation?: ConnectionConditionRemediation | null;
}): ConnectionHealthCondition {
  return {
    id: `${input.type}:${input.reason}`,
    type: input.type,
    status: input.status,
    severity: input.severity,
    reason: input.reason,
    message: input.message,
    origin: input.origin,
    observed_at: input.observedAt ?? null,
    expires_at: input.expiresAt ?? null,
    current: true,
    sensitivity: input.sensitivity ?? "owner",
    remediation: input.remediation ?? null,
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

function projectionReliableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  const sources = input.projection?.unreliableSources ?? [];
  if (sources.length > 0) {
    return condition({
      type: "ProjectionReliable",
      status: "false",
      severity: "blocked",
      reason: CONDITION_REASON.PROJECTION_UNRELIABLE,
      message: `Projection evidence is unreliable: ${sources.join(", ")}.`,
      origin: "read_model",
      remediation: {
        action: "wait",
        label: "Wait for the reference read model to refresh",
        retryable: true,
        target: null,
      },
    });
  }
  return condition({
    type: "ProjectionReliable",
    status: "true",
    severity: "info",
    reason: CONDITION_REASON.PROJECTION_CURRENT,
    message: "Projection evidence is reliable.",
    origin: "read_model",
  });
}

function scheduleEligibleCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  if (!input.schedule) {
    return condition({
      type: "ScheduleEligible",
      status: "unknown",
      severity: "info",
      reason: CONDITION_REASON.SCHEDULE_NOT_CONFIGURED,
      message: "No scheduler policy is configured for this connection.",
      origin: "scheduler",
    });
  }
  if (input.schedule.enabled === false) {
    return condition({
      type: "ScheduleEligible",
      status: "false",
      severity: "info",
      reason: CONDITION_REASON.SCHEDULE_PAUSED,
      message: "The schedule is paused.",
      origin: "scheduler",
      remediation: {
        action: "wait",
        label: "Resume the schedule when fresh data is needed",
        retryable: false,
        target: "schedule",
      },
    });
  }
  return condition({
    type: "ScheduleEligible",
    status: "true",
    severity: "info",
    reason: CONDITION_REASON.SCHEDULE_ENABLED,
    message: "The schedule is eligible to run.",
    origin: "scheduler",
  });
}

function retryPolicyClearCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  if (!input.backoff || conditionExpired(input.backoff.nextRunAt, input.observedAt ?? null)) {
    return condition({
      type: "RetryPolicyClear",
      status: "true",
      severity: "info",
      reason: input.backoff ? CONDITION_REASON.BACKOFF_EXPIRED : CONDITION_REASON.NO_ACTIVE_BACKOFF,
      message: input.backoff
        ? "The previous retry backoff has expired."
        : "No active retry backoff is blocking collection.",
      origin: "scheduler",
    });
  }
  const blocked = input.backoff.consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD;
  const retryable = !blocked;
  return condition({
    type: "RetryPolicyClear",
    status: "false",
    severity: blocked ? "blocked" : "warning",
    reason: stripClassPrefix(input.backoff.reasonClass) ?? CONDITION_REASON.SCHEDULER_BACKOFF_ACTIVE,
    message: blocked ? "Retry policy has reached the blocked threshold." : "Retry policy is delaying the next attempt.",
    origin: "scheduler",
    expiresAt: input.backoff.nextRunAt,
    remediation: {
      action: retryable ? "retry_by_runtime" : "update_connector",
      label: retryable ? "Wait for the scheduled retry" : "Review the repeated scheduler failure",
      retryable,
      target: "schedule",
    },
  });
}

function attentionClearCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  if (!input.attention || conditionExpired(input.attention.expiresAt, input.observedAt ?? null)) {
    return condition({
      type: "AttentionClear",
      status: "true",
      severity: "info",
      reason: input.attention ? CONDITION_REASON.ATTENTION_EXPIRED : CONDITION_REASON.NO_OPEN_ATTENTION,
      message: input.attention
        ? "The previous owner action request has expired."
        : "No owner action is currently required.",
      origin: "runtime",
    });
  }
  return condition({
    type: "AttentionClear",
    status: "false",
    severity: "blocked",
    reason: input.attention.reasonCode ?? CONDITION_REASON.ATTENTION_REQUIRED,
    message: "Owner action is required before collection can continue.",
    origin: "runtime",
    expiresAt: input.attention.expiresAt,
    sensitivity: input.attention.sensitivity === "secret" ? "secret_redacted" : "owner",
    remediation: {
      action: "satisfy_attention",
      label: "Open the requested interaction and complete the action",
      retryable: false,
      target: input.attention.actionTarget,
    },
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
        type: "CollectionSucceeded",
        status: "true",
        severity: "info",
        reason: CONDITION_REASON.COLLECTION_SUCCEEDED_LOCAL_DEVICE,
        message: "The local collector drained cleanly with complete coverage.",
        origin: "local_device",
        observedAt: input.run?.lastSuccessAt ?? null,
      });
    }
    return condition({
      type: "CollectionSucceeded",
      status: "unknown",
      severity: "info",
      reason: CONDITION_REASON.COLLECTION_NOT_OBSERVED,
      message: "No terminal collection run has been observed.",
      origin: "connector",
    });
  }
  if (input.run.latestStatus === "succeeded") {
    return condition({
      type: "CollectionSucceeded",
      status: "true",
      severity: "info",
      reason: CONDITION_REASON.COLLECTION_SUCCEEDED,
      message: "The latest terminal collection run succeeded.",
      origin: "connector",
      observedAt: input.run.lastSuccessAt,
    });
  }
  return condition({
    type: "CollectionSucceeded",
    status: "false",
    severity: "warning",
    reason: normalizeConditionReason(input.run.reasonCode, CONDITION_REASON.COLLECTION_FAILED),
    message: "The latest terminal collection run failed.",
    origin: "connector",
    sensitivity: containsSecretLike(input.run.reasonCode) ? "secret_redacted" : "owner",
  });
}

function credentialsValidCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  const reason = firstReasonCode(input);
  if (reason && isCredentialReason(reason)) {
    return condition({
      type: "CredentialsValid",
      status: "false",
      severity: "blocked",
      reason: normalizeConditionReason(reason, CONDITION_REASON.CREDENTIAL_REJECTED),
      message: "The source rejected the configured credentials.",
      origin: "readiness",
      sensitivity: "secret_redacted",
      remediation: {
        action: "refresh_credentials",
        label: "Reconnect or update the source credentials",
        retryable: false,
        target: "credentials",
      },
    });
  }
  if (input.run?.latestStatus === "succeeded") {
    return condition({
      type: "CredentialsValid",
      status: "true",
      severity: "info",
      reason: CONDITION_REASON.CREDENTIALS_ACCEPTED,
      message: "The latest successful run proved credentials were accepted.",
      origin: "readiness",
      observedAt: input.run.lastSuccessAt,
    });
  }
  return condition({
    type: "CredentialsValid",
    status: "unknown",
    severity: "info",
    reason: CONDITION_REASON.CREDENTIALS_NOT_PROBED,
    message: "Credential validity has not been proven by current evidence.",
    origin: "readiness",
  });
}

function runtimeAvailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  const readinessReason = firstReasonCode(input);
  const dependencyReason = readinessReason ? runtimeDependencyReason(readinessReason) : null;
  if (dependencyReason) {
    return condition({
      type: "RuntimeAvailable",
      status: "false",
      severity: "blocked",
      reason: dependencyReason,
      message: "A required collection runtime dependency is unavailable.",
      origin: "runtime",
      remediation: {
        action: "check_runtime",
        label: "Configure the required runtime dependency",
        retryable: false,
        target: "runtime",
      },
    });
  }
  const remoteSurface = input.remoteSurface;
  if (!remoteSurface || remoteSurface.axis === "none") {
    return condition({
      type: "RuntimeAvailable",
      status: "unknown",
      severity: "info",
      reason: CONDITION_REASON.RUNTIME_NOT_MANAGED,
      message: "No managed runtime surface is required or observed for this connection.",
      origin: "runtime",
    });
  }
  if (remoteSurface.axis === "failed") {
    return condition({
      type: "RuntimeAvailable",
      status: "false",
      severity: "error",
      reason: normalizeConditionReason(
        remoteSurface.waitReason ?? remoteSurface.leaseStatus,
        CONDITION_REASON.RUNTIME_UNAVAILABLE
      ),
      message: "The managed runtime surface is not available.",
      origin: "remote_surface",
      remediation: {
        action: "check_runtime",
        label: "Check the browser surface runtime",
        retryable: true,
        target: "remote_surface",
      },
    });
  }
  if (remoteSurface.axis === "unknown") {
    return condition({
      type: "RuntimeAvailable",
      status: "unknown",
      severity: "warning",
      reason: CONDITION_REASON.RUNTIME_STATE_UNKNOWN,
      message: "Runtime surface evidence is incomplete.",
      origin: "remote_surface",
    });
  }
  return condition({
    type: "RuntimeAvailable",
    status: "true",
    severity: "info",
    reason: CONDITION_REASON.RUNTIME_AVAILABLE,
    message: "Runtime surface evidence is available.",
    origin: "remote_surface",
  });
}

function remoteSurfaceAvailableCondition(input: ComputeConnectionHealthInput): ConnectionHealthCondition {
  const remoteSurface = input.remoteSurface;
  if (!remoteSurface || remoteSurface.axis === "none") {
    return condition({
      type: "RemoteSurfaceAvailable",
      status: "unknown",
      severity: "info",
      reason: CONDITION_REASON.REMOTE_SURFACE_NOT_REQUIRED,
      message: "No managed remote browser surface is required or observed for this connection.",
      origin: "remote_surface",
    });
  }
  if (remoteSurface.axis === "failed") {
    return condition({
      type: "RemoteSurfaceAvailable",
      status: "false",
      severity: "error",
      reason: normalizeConditionReason(
        remoteSurface.waitReason ?? remoteSurface.leaseStatus,
        CONDITION_REASON.REMOTE_SURFACE_FAILED
      ),
      message: "The managed remote browser surface is unavailable.",
      origin: "remote_surface",
      remediation: {
        action: "check_runtime",
        label: "Check the browser surface runtime",
        retryable: true,
        target: "remote_surface",
      },
    });
  }
  if (remoteSurface.axis === "unknown") {
    return condition({
      type: "RemoteSurfaceAvailable",
      status: "unknown",
      severity: "warning",
      reason: CONDITION_REASON.REMOTE_SURFACE_UNKNOWN,
      message: "Remote browser surface evidence is incomplete.",
      origin: "remote_surface",
    });
  }
  return condition({
    type: "RemoteSurfaceAvailable",
    status: "true",
    severity: "info",
    reason: CONDITION_REASON.REMOTE_SURFACE_AVAILABLE,
    message: "Remote browser surface evidence is available.",
    origin: "remote_surface",
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
        exporterMessage:
          "The local collector cannot read its last saved state. Run it again on the host; there are no failed uploads to retry.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_STATE_READ_FAILED,
        backlogMessage: "The local collector is blocked reading saved state, not waiting on failed uploads.",
        backlogReason: CONDITION_REASON.OUTBOX_STATE_READ_FAILED,
        remediationLabel: "Run the local collector again on the host",
        severity: "error",
      };
    case "dead_letter_backlog":
      return {
        action: "clear_backlog",
        exporterMessage:
          "The local collector has saved records that failed to upload. Prepare those uploads for retry, then run the collector again on the host.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_DEAD_LETTER_BACKLOG,
        backlogMessage: "The local collector has saved failed uploads waiting to be retried.",
        backlogReason: CONDITION_REASON.OUTBOX_DEAD_LETTER_BACKLOG,
        remediationLabel: "Recover local collector uploads",
        severity: "error",
      };
    case "transient_upload_failure":
      return {
        action: "wait",
        exporterMessage:
          "The local collector hit temporary server or network errors while uploading. It will retry without owner action.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE,
        backlogMessage: "Local-device uploads are waiting for the server or network to recover.",
        backlogReason: CONDITION_REASON.OUTBOX_TRANSIENT_UPLOAD_FAILURE,
        remediationLabel: "Wait for upload retry",
        severity: "warning",
      };
    case "stale_pending":
      return {
        action: "clear_backlog",
        exporterMessage:
          "The local collector has queued work but stopped checking in. Run it again on the host to resume uploads.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_STALE_PENDING,
        backlogMessage: "The local collector has queued work that stopped moving.",
        backlogReason: CONDITION_REASON.OUTBOX_STALE_PENDING,
        remediationLabel: "Run the local collector again on the host",
        severity: "error",
      };
    default:
      return {
        action: "clear_backlog",
        exporterMessage: "The local collector is not making progress.",
        exporterReason: CONDITION_REASON.LOCAL_EXPORTER_STALLED,
        backlogMessage: "The local collector has work that appears stalled.",
        backlogReason: CONDITION_REASON.OUTBOX_STALLED,
        remediationLabel: "Check the local collector",
        severity: "error",
      };
  }
}

function localExporterAvailableCondition(
  axes: ConnectionAxes,
  stalledCause: OutboxStalledCause | null
): ConnectionHealthCondition {
  switch (axes.outbox) {
    case "idle":
      return condition({
        type: "LocalExporterAvailable",
        status: "true",
        severity: "info",
        reason: CONDITION_REASON.LOCAL_EXPORTER_IDLE,
        message: "Local exporter evidence is available and idle.",
        origin: "local_device",
      });
    case "active":
      return condition({
        type: "LocalExporterAvailable",
        status: "true",
        severity: "info",
        reason: CONDITION_REASON.LOCAL_EXPORTER_ACTIVE,
        message: "Local exporter is draining queued work normally.",
        origin: "local_device",
      });
    case "stalled": {
      const copy = stalledCauseCopy(stalledCause);
      return condition({
        type: "LocalExporterAvailable",
        status: "false",
        severity: copy.severity,
        reason: copy.exporterReason,
        message: copy.exporterMessage,
        origin: "local_device",
        remediation: {
          action: copy.action,
          label: copy.remediationLabel,
          retryable: true,
          target: "local_device",
        },
      });
    }
    default:
      return condition({
        type: "LocalExporterAvailable",
        status: "unknown",
        severity: "info",
        reason: CONDITION_REASON.LOCAL_EXPORTER_UNKNOWN,
        message: "No trusted local exporter evidence is available.",
        origin: "local_device",
      });
  }
}

function sourceCoverageCondition(input: ComputeConnectionHealthInput, axes: ConnectionAxes): ConnectionHealthCondition {
  if (axes.coverage === "unknown") {
    return condition({
      type: "SourceCoverageComplete",
      status: "unknown",
      severity: "warning",
      reason: CONDITION_REASON.COVERAGE_UNKNOWN,
      message: "Source coverage evidence is missing.",
      origin: "connector",
    });
  }
  if (input.coverage?.requiredButAccepted === true || isDegradingCoverage(axes.coverage)) {
    return condition({
      type: "SourceCoverageComplete",
      status: "false",
      severity: axes.coverage === "terminal_gap" ? "blocked" : "warning",
      reason: axes.coverage,
      message: "Required source coverage is incomplete.",
      origin: "connector",
      remediation: {
        action: axes.coverage === "retryable_gap" ? "retry_by_runtime" : "update_connector",
        label: axes.coverage === "retryable_gap" ? "Wait for detail-gap retry" : "Review source coverage gaps",
        retryable: axes.coverage === "retryable_gap",
        target: "coverage",
      },
    });
  }
  return condition({
    type: "SourceCoverageComplete",
    status: "true",
    severity: "info",
    reason: axes.coverage,
    message: "Source coverage is complete or accepted by manifest policy.",
    origin: "connector",
  });
}

/**
 * A connector is manual-refresh-only when its manifest refresh policy
 * declares it cannot be auto-scheduled in the background — either
 * `background_safe: false`, `recommended_mode: "manual"`, or
 * `recommended_mode: "paused"`. These are the same refresh-policy values the
 * schedule auto-enroll gate treats as ineligible for automatic scheduling, so
 * the projection stays consistent with "this connector will never refresh on
 * its own." Absent/unknown evidence is treated as schedulable (the pre-change
 * behavior), so staleness still degrades.
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
  if (axes.freshness === "fresh") {
    return condition({
      type: "Fresh",
      status: "true",
      severity: "info",
      reason: CONDITION_REASON.FRESH,
      message: "Retained data satisfies the freshness policy.",
      origin: "connector",
      observedAt: input.run?.lastSuccessAt ?? null,
    });
  }
  if (axes.freshness === "stale") {
    // A manual / paused / background-unsafe connector cannot auto-refresh, so
    // stale data is not a failure — it is an owner-action advisory. Emit the
    // stale `Fresh` condition at `info` severity so it never trips the
    // degrading threshold; the headline becomes `idle` with a manual-refresh
    // remediation and the `stale` badge stays on. Schedulable / background-
    // safe connectors keep the degrading `warning` stale condition, because
    // the system was supposed to refresh them and did not.
    if (isManualRefreshOnly(input.refresh)) {
      return condition({
        type: "Fresh",
        status: "false",
        severity: "info",
        reason: CONDITION_REASON.STALE_MANUAL_REFRESH,
        message: "Retained data is stale; this manual connector needs an owner-initiated run to refresh.",
        origin: "connector",
        remediation: {
          action: "retry_by_runtime",
          label: "Run the connector manually",
          retryable: true,
          target: "run",
        },
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
        type: "Fresh",
        status: "false",
        severity: "info",
        reason: CONDITION_REASON.STALE_ASSISTED_REFRESH,
        message:
          "Retained data is stale; this assisted connector refreshes on schedule and may ask for bounded owner help to catch up.",
        origin: "connector",
        remediation: { action: "retry_by_runtime", label: "Run the connector now", retryable: true, target: "run" },
      });
    }
    return condition({
      type: "Fresh",
      status: "false",
      severity: "warning",
      reason: CONDITION_REASON.STALE,
      message: "Retained data is stale for this connection's freshness policy.",
      origin: "connector",
      remediation: { action: "retry_by_runtime", label: "Run the connector again", retryable: true, target: "run" },
    });
  }
  return condition({
    type: "Fresh",
    status: "unknown",
    severity: "warning",
    reason: CONDITION_REASON.FRESHNESS_UNKNOWN,
    message: "Freshness evidence is missing.",
    origin: "connector",
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
 * Derive a stream's forward disposition as a pure function of its coverage
 * condition, gap retryability, open-attention presence, freshness axis, and the
 * connection's refresh policy. First match wins, and gaps are evaluated before
 * freshness so a real coverage gap is never masked by staleness:
 *
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
 * considered denominator is unknown carries a `checking` disposition instead of
 * `complete` or `resumable`.
 *
 * See `define-connector-progress-evidence-contract`.
 */
export function deriveForwardDisposition(input: ForwardDispositionInput): ForwardDisposition {
  if (hasOutstandingGap(input.coverage)) {
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
  // Keep it in a checking disposition rather than fabricating `resumable`.
  if (input.coverage === "unknown") {
    return "checking";
  }

  // Rule 4: a complete stream on a manual-refresh-only connection whose data has
  // gone stale needs an owner-initiated run — the system will not refresh it on
  // its own. An assisted-refresh connection (schedulable, but whose posture
  // predicts bounded owner help) is likewise owner-refresh-due when stale: it
  // refreshes on schedule but may need the owner's bounded assistance to catch
  // up, so the disposition honestly names an owner-initiated/assisted run rather
  // than re-encoding staleness as a coverage gap. Coverage stays complete; only
  // the disposition carries the freshness fact. A truly unattended schedulable
  // stream is the scheduler's job and stays `complete` here (the connection-
  // health projection raises its own schedulable-stale warning).
  if (input.freshness === "stale" && (isManualRefreshOnly(input.refresh) || isAssistedRefresh(input.refresh))) {
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
  const coverage: CoverageAxis = input.coverage?.axis ?? "unknown";
  return deriveForwardDisposition({
    coverage,
    gapRetryable: coverage === "retryable_gap",
    attentionOpen: conditionIsFalse(conditionSet, "AttentionClear"),
    freshness: input.freshness?.axis ?? "unknown",
    refresh: input.refresh ?? null,
  });
}

function backlogClearCondition(
  axes: ConnectionAxes,
  stalledCause: OutboxStalledCause | null
): ConnectionHealthCondition {
  switch (axes.outbox) {
    case "idle":
      return condition({
        type: "BacklogClear",
        status: "true",
        severity: "info",
        reason: CONDITION_REASON.OUTBOX_IDLE,
        message: "No local-device outbox backlog is pending.",
        origin: "local_device",
      });
    case "active":
      return condition({
        type: "BacklogClear",
        status: "false",
        severity: "info",
        reason: CONDITION_REASON.OUTBOX_ACTIVE,
        message: "Local-device outbox work is currently draining.",
        origin: "local_device",
        remediation: {
          action: "wait",
          label: "Wait for the local-device outbox to drain",
          retryable: true,
          target: "local_device",
        },
      });
    case "stalled": {
      const copy = stalledCauseCopy(stalledCause);
      return condition({
        type: "BacklogClear",
        status: "false",
        severity: copy.severity,
        reason: copy.backlogReason,
        message: copy.backlogMessage,
        origin: "local_device",
        remediation: {
          action: copy.action,
          label: copy.remediationLabel,
          retryable: true,
          target: "local_device",
        },
      });
    }
    default:
      return condition({
        type: "BacklogClear",
        status: "unknown",
        severity: "info",
        reason: CONDITION_REASON.OUTBOX_UNKNOWN,
        message: "No trusted local-device outbox evidence is available.",
        origin: "local_device",
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
    normalized.includes("token") ||
    normalized.includes("bad_credentials") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("invalid_client") ||
    normalized.includes("invalid_token") ||
    normalized.includes("401")
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
  if (
    normalized.includes("binary_missing") ||
    normalized.includes("external_tool_missing") ||
    normalized.includes("external_tool_unavailable") ||
    normalized.includes("slackdump_missing")
  ) {
    return CONDITION_REASON.EXTERNAL_TOOL_UNAVAILABLE;
  }
  return null;
}

function conditionClassifierText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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
  readonly forwardDisposition: ForwardDisposition;
  readonly lastSuccessAt: string | null;
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
    state: args.state,
    reason_code: args.reasonCode,
    collection_rate: args.collectionRate ?? null,
    conditions: args.conditions,
    detail_gap_backlog: args.detailGapBacklog ?? null,
    dominant_condition_id: args.dominantConditionId,
    forward_disposition: args.forwardDisposition,
    supporting_condition_ids: args.supportingConditionIds,
    last_success_at: args.lastSuccessAt,
    next_action: args.nextAction ?? null,
    next_attempt_at: args.nextAttemptAt,
    axes: args.axes,
    badges: args.badges,
    remote_surface: args.remoteSurface ?? null,
    unknown_reasons: args.unknownReasons ?? [],
  };
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
      owner_action: attention.ownerAction,
      reason_code: attention.reasonCode,
      response_contract: attention.responseContract,
      source,
      notification_state: notificationState,
    };
  }
  return {
    action_target: attention.actionTarget,
    attention_id: attention.id,
    expires_at: attention.expiresAt,
    owner_action: attention.ownerAction,
    reason_code: attention.reasonCode,
    response_contract: attention.responseContract,
    source,
    notification_state: notificationState,
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
   * Dead-lettered record depth the device last reported (from its rolled-up
   * outbox diagnostics). Distinguishes a `blocked` heartbeat that is a pure
   * state-read failure (no dead letters) from one carrying a dead-letter
   * backlog. `null`/absent is treated as zero — a `blocked` heartbeat with no
   * dead-letter evidence is classified `state_read_failed`.
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
 * `stalled`. This prevents a connection from sitting in `active`
 * indefinitely after the collector dies mid-drain.
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
  if (evidence.lastHeartbeatStatus === "blocked") {
    // A blocked heartbeat with dead letters is a backlog to retry+re-run; a
    // blocked heartbeat with none is a failed state read cleared by re-running.
    // Mirrors the device-side `last_error.kind` split.
    const cause: OutboxStalledCause =
      (evidence.deadLetterCount ?? 0) > 0
        ? deadLetterStalledCause(evidence.deadLetterCount ?? 0, evidence.deadLetterErrorClasses ?? null)
        : "state_read_failed";
    return { axis: "stalled", cause, unreliable: false };
  }

  const heartbeatAgeMs = ageMs(evidence.lastHeartbeatAt, options.nowIso);
  const pending = evidence.recordsPending ?? 0;
  const heartbeatStale = heartbeatAgeMs !== null && heartbeatAgeMs > options.staleHeartbeatThresholdMs;

  if (pending > 0 && heartbeatStale) {
    return { axis: "stalled", cause: "stale_pending", unreliable: false };
  }
  if (evidence.lastHeartbeatStatus === "starting" || evidence.lastHeartbeatStatus === "retrying") {
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

function isTransientDeadLetterErrorClass(errorClass: string): boolean {
  const normalized = errorClass.toLowerCase();
  return (
    /local device request failed:\s*5\d\d/.test(normalized) ||
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

function ageMs(iso: string, nowIso: string): number | null {
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

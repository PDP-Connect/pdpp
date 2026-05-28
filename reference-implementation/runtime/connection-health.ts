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
 *   8. never-run with no stronger evidence         -> idle
 *   9. clean evidence, fresh enough                -> healthy
 *   10. fallback                                  -> unknown
 *
 * The function is **pure**: no I/O, no clock reads. The caller is
 * responsible for collecting durable evidence and passing it in.
 */

import { BLOCKED_PROMOTION_THRESHOLD } from "./connection-health-policy.ts";

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
  COVERAGE_UNKNOWN: "coverage_unknown",
  CREDENTIAL_REJECTED: "credential_rejected",
  CREDENTIALS_ACCEPTED: "credentials_accepted",
  CREDENTIALS_NOT_PROBED: "credentials_not_probed",
  EXTERNAL_TOOL_UNAVAILABLE: "external_tool_unavailable",
  FRESH: "fresh",
  FRESHNESS_UNKNOWN: "freshness_unknown",
  LOCAL_EXPORTER_ACTIVE: "local_exporter_active",
  LOCAL_EXPORTER_IDLE: "local_exporter_idle",
  LOCAL_EXPORTER_STALLED: "local_exporter_stalled",
  LOCAL_EXPORTER_UNKNOWN: "local_exporter_unknown",
  MISSING_BROWSER_SURFACE: "missing_browser_surface",
  NO_ACTIVE_BACKOFF: "no_active_backoff",
  NO_OPEN_ATTENTION: "no_open_attention",
  OUTBOX_ACTIVE: "outbox_active",
  OUTBOX_IDLE: "outbox_idle",
  OUTBOX_STALLED: "outbox_stalled",
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
  readonly id: string;
  readonly type: ConnectionConditionType;
  readonly status: ConnectionConditionStatus;
  readonly severity: ConnectionConditionSeverity;
  readonly reason: string;
  readonly message: string;
  readonly origin: ConnectionConditionOrigin;
  readonly observed_at: string | null;
  readonly expires_at: string | null;
  readonly current: boolean;
  readonly sensitivity: ConnectionConditionSensitivity;
  readonly remediation: ConnectionConditionRemediation | null;
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
 * Outbox / work axis: durable work health for executors that buffer.
 *
 *   - `idle`    : no pending durable work
 *   - `active`  : work is queued or running normally
 *   - `stalled` : leases expired or backlog has stopped draining (degrading)
 *   - `unknown` : outbox evidence is missing or unreliable
 */
export type OutboxAxis = "active" | "idle" | "stalled" | "unknown";

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

export interface ConnectionHealthSnapshot {
  readonly axes: ConnectionAxes;
  readonly badges: ConnectionBadges;
  readonly conditions: readonly ConnectionHealthCondition[];
  readonly dominant_condition_id: string | null;
  readonly supporting_condition_ids: readonly string[];
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
  /**
   * Durable notification delivery state for the prompt. Forwarded to
   * `NextAction.notification_state`. `null` for fallback evidence
   * synthesized from `human_attention_needed` (no structured record
   * exists, so delivery state is unknown).
   */
  readonly notificationState?: "acknowledged" | "failed" | "pending" | "sent" | "suppressed" | null;
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
  readonly coverage: ConnectionCoverageEvidence | null;
  readonly freshness: ConnectionFreshnessEvidence | null;
  readonly outbox: ConnectionOutboxEvidence | null;
  readonly projection: ConnectionProjectionEvidence | null;
  readonly remoteSurface?: ConnectionRemoteSurfaceEvidence | null;
  readonly run: ConnectionRunEvidence | null;
  readonly schedule: ConnectionScheduleEvidence | null;
  readonly observedAt?: string | null;
}

// ─── Projection ───────────────────────────────────────────────────────────

export function computeConnectionHealth(input: ComputeConnectionHealthInput): ConnectionHealthSnapshot {
  const axes = projectAxes(input);
  const badges = projectBadges(input, axes);
  const conditions = projectConditions(input, axes);
  const conditionSet = indexConditions(conditions);
  const remoteSurface = projectRemoteSurfaceDetail(input.remoteSurface ?? null);
  const lastSuccessAt = input.run?.lastSuccessAt ?? null;
  const nextAttemptAt = conditionExpired(input.backoff?.nextRunAt ?? null, input.observedAt ?? null)
    ? null
    : (input.backoff?.nextRunAt ?? null);
  const finish = (
    args: Omit<SnapshotArgs, "conditions" | "dominantConditionId" | "supportingConditionIds">
  ): ConnectionHealthSnapshot => {
    const dominantConditionId = pickDominantConditionId(args.state, conditions);
    return snapshot({
      ...args,
      conditions,
      dominantConditionId,
      supportingConditionIds: pickSupportingConditionIds(conditions, dominantConditionId),
    });
  };

  // 1. Projection unreliable -> unknown. Highest precedence so the UI
  //    never paints a confident pill on top of broken evidence.
  if (conditionSet.get("ProjectionReliable")?.status === "false") {
    return finish({
      state: "unknown",
      reasonCode: null,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
      unknownReasons: input.projection?.unreliableSources ?? [],
    });
  }

  // 2. Required attention open -> needs_attention. Current owner action
  //    is actionable even before the first terminal run exists.
  const attention = conditionSet.get("AttentionClear");
  if (attention?.status === "false") {
    return finish({
      state: "needs_attention",
      reasonCode: attention.reason,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
      nextAction: input.attention ? projectNextAction(input.attention) : null,
    });
  }

  // 3. Owner-paused -> idle. Manual pause beats run/coverage/backoff
  //    state because the system is intentionally not making progress.
  if (conditionSet.get("ScheduleEligible")?.status === "false") {
    return finish({
      state: "idle",
      reasonCode: null,
      lastSuccessAt,
      nextAttemptAt: null,
      axes,
      badges,
      remoteSurface,
    });
  }

  const readinessBlocker = readinessBlockedCondition(conditions);
  if (readinessBlocker) {
    return finish({
      state: "blocked",
      reasonCode: readinessBlocker.reason,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 4. Give-up streak crossed -> blocked.
  const retryPolicy = conditionSet.get("RetryPolicyClear");
  if (retryPolicy?.status === "false" && retryPolicy.severity === "blocked") {
    return finish({
      state: "blocked",
      reasonCode: retryPolicy.reason,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 5. Backoff currently delaying retry -> cooling_off.
  if (retryPolicy?.status === "false") {
    return finish({
      state: "cooling_off",
      reasonCode: retryPolicy.reason,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 6. Outbox stalled, coverage incomplete, gaps present, or last run
  //    failed -> degraded. Success-with-gaps must not be healthy.
  if (hasDegradingCondition(conditions)) {
    return finish({
      state: "degraded",
      reasonCode: degradedReasonCode(input),
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 6b. If current local/device evidence exists but no terminal collection
  //     verdict exists, the health verdict is unknown, not idle. Activity
  //     is orthogonal; "Idle" must not masquerade as a health verdict for
  //     a connection that is actively maintained but not fully proven.
  if (
    conditionSet.get("CollectionSucceeded")?.status === "unknown" &&
    hasCurrentEvidenceWithoutCollectionVerdict(conditionSet)
  ) {
    return finish({
      state: "unknown",
      reasonCode: null,
      lastSuccessAt: null,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
      unknownReasons: ["collection"],
    });
  }

  // 6c. Never run (no terminal evidence yet) -> idle only when no
  //     stronger current evidence exists.
  if (conditionSet.get("CollectionSucceeded")?.status === "unknown") {
    return finish({
      state: "idle",
      reasonCode: null,
      lastSuccessAt: null,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 7. Healthy requires:
  //    - last run succeeded with no degrading gaps
  //    - coverage complete (or unknown is NOT acceptable — see below)
  //    - freshness fresh (stale is never silently healthy)
  if (isHealthyConditionSet(conditionSet)) {
    return finish({
      state: "healthy",
      reasonCode: null,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 8. Fallback -> unknown. Reached when evidence combinations don't
  //    line up cleanly (e.g. succeeded run but coverage axis is unknown).
  return finish({
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

function hasCurrentEvidenceWithoutCollectionVerdict(
  conditions: ReadonlyMap<ConnectionConditionType, ConnectionHealthCondition>
): boolean {
  return (
    conditionIsTrue(conditions, "Fresh") ||
    conditionIsTrue(conditions, "LocalExporterAvailable") ||
    conditionIsTrue(conditions, "BacklogClear")
  );
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
  return [
    projectionReliableCondition(input),
    scheduleEligibleCondition(input),
    retryPolicyClearCondition(input),
    attentionClearCondition(input),
    collectionSucceededCondition(input),
    credentialsValidCondition(input),
    runtimeAvailableCondition(input),
    remoteSurfaceAvailableCondition(input),
    localExporterAvailableCondition(axes),
    sourceCoverageCondition(input, axes),
    freshCondition(input, axes),
    backlogClearCondition(axes),
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
  if (!expiresAt || !observedAt) {
    return false;
  }
  const expiresAtMs = Date.parse(expiresAt);
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(observedAtMs)) {
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

function localExporterAvailableCondition(axes: ConnectionAxes): ConnectionHealthCondition {
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
        message: "Local exporter evidence shows active work.",
        origin: "local_device",
      });
    case "stalled":
      return condition({
        type: "LocalExporterAvailable",
        status: "false",
        severity: "error",
        reason: CONDITION_REASON.LOCAL_EXPORTER_STALLED,
        message: "Local exporter work is stalled or blocked.",
        origin: "local_device",
        remediation: {
          action: "clear_backlog",
          label: "Inspect the local collector backlog",
          retryable: true,
          target: "local_device",
        },
      });
    case "unknown":
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

function backlogClearCondition(axes: ConnectionAxes): ConnectionHealthCondition {
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
    case "stalled":
      return condition({
        type: "BacklogClear",
        status: "false",
        severity: "error",
        reason: CONDITION_REASON.OUTBOX_STALLED,
        message: "Local-device outbox work appears stalled.",
        origin: "local_device",
        remediation: {
          action: "clear_backlog",
          label: "Inspect the local collector backlog",
          retryable: true,
          target: "local_device",
        },
      });
    case "unknown":
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
  if (!value) return fallback;
  if (containsSecretLike(value)) return fallback;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function containsSecretLike(value: string | null | undefined): boolean {
  if (!value) return false;
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
      return conditionId(byType.get("ScheduleEligible"), "false") ?? null;
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
    if (ids.length >= 6) break;
    if (conditionValue.id === dominantConditionId) continue;
    if (conditionValue.status === "true" && conditionValue.severity === "info") continue;
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

function firstConditionId(
  conditions: readonly ConnectionHealthCondition[],
  types: readonly ConnectionConditionType[]
): string | null {
  for (const type of types) {
    const found = conditions.find((item) => item.type === type && item.status === "false");
    if (found) return found.id;
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
  readonly conditions: readonly ConnectionHealthCondition[];
  readonly dominantConditionId: string | null;
  readonly supportingConditionIds: readonly string[];
  readonly lastSuccessAt: string | null;
  readonly nextAction?: NextAction | null;
  readonly nextAttemptAt: string | null;
  readonly reasonCode: string | null;
  readonly remoteSurface?: RemoteSurfaceDetail | null;
  readonly state: ConnectionHealthState;
  readonly unknownReasons?: readonly string[];
}

function snapshot(args: SnapshotArgs): ConnectionHealthSnapshot {
  return {
    state: args.state,
    reason_code: args.reasonCode,
    conditions: args.conditions,
    dominant_condition_id: args.dominantConditionId,
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
): { axis: OutboxAxis; unreliable: boolean } {
  if (!evidence.evidenceTrusted) {
    return { axis: "unknown", unreliable: true };
  }
  if (!evidence.lastHeartbeatAt) {
    return { axis: "unknown", unreliable: false };
  }
  if (evidence.lastHeartbeatStatus === "blocked") {
    return { axis: "stalled", unreliable: false };
  }

  const heartbeatAgeMs = ageMs(evidence.lastHeartbeatAt, options.nowIso);
  const pending = evidence.recordsPending ?? 0;
  const heartbeatStale = heartbeatAgeMs !== null && heartbeatAgeMs > options.staleHeartbeatThresholdMs;

  if (pending > 0 && heartbeatStale) {
    return { axis: "stalled", unreliable: false };
  }
  if (evidence.lastHeartbeatStatus === "starting" || evidence.lastHeartbeatStatus === "retrying") {
    return { axis: "active", unreliable: false };
  }
  if (pending > 0) {
    return { axis: "active", unreliable: false };
  }
  if (evidence.lastHeartbeatStatus === "healthy" || evidence.lastHeartbeatStatus === "stopped") {
    return { axis: "idle", unreliable: false };
  }
  return { axis: "unknown", unreliable: false };
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

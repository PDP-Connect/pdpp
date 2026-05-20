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
 *   2. owner-paused or never-run                   -> idle
 *   3. required attention open                     -> needs_attention
 *   4. give-up streak crossed                      -> blocked
 *   5. backoff currently delaying retry            -> cooling_off
 *   6. outbox stalled / coverage/run incomplete    -> degraded
 *   7. clean evidence, fresh enough                -> healthy
 *   8. fallback                                    -> unknown
 *
 * The function is **pure**: no I/O, no clock reads. The caller is
 * responsible for collecting durable evidence and passing it in.
 */

import { BLOCKED_PROMOTION_THRESHOLD } from "./connector-health.ts";

// ─── Public types ──────────────────────────────────────────────────────────

export type ConnectionHealthState =
  | "blocked"
  | "cooling_off"
  | "degraded"
  | "healthy"
  | "idle"
  | "needs_attention"
  | "unknown";

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

/** Scheduler/backoff projection — same shape as `connector-health.ts`. */
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
}

// ─── Projection ───────────────────────────────────────────────────────────

export function computeConnectionHealth(input: ComputeConnectionHealthInput): ConnectionHealthSnapshot {
  const axes = projectAxes(input);
  const badges = projectBadges(input, axes);
  const remoteSurface = projectRemoteSurfaceDetail(input.remoteSurface ?? null);
  const lastSuccessAt = input.run?.lastSuccessAt ?? null;
  const nextAttemptAt = input.backoff?.nextRunAt ?? null;

  // 1. Projection unreliable -> unknown. Highest precedence so the UI
  //    never paints a confident pill on top of broken evidence.
  const unreliable = input.projection?.unreliableSources ?? [];
  if (unreliable.length > 0) {
    return snapshot({
      state: "unknown",
      reasonCode: null,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
      unknownReasons: unreliable,
    });
  }

  // 2. Owner-paused -> idle. Manual pause beats all run/coverage state
  //    because the system is intentionally not making progress.
  if (input.schedule && input.schedule.enabled === false) {
    return snapshot({
      state: "idle",
      reasonCode: null,
      lastSuccessAt,
      nextAttemptAt: null,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 2b. Never run (no terminal evidence yet) -> idle.
  if (!input.run || input.run.latestStatus === null) {
    return snapshot({
      state: "idle",
      reasonCode: null,
      lastSuccessAt: null,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 3. Required attention open -> needs_attention. Beats backoff because
  //    the owner can act to unblock; backoff is just cadence.
  if (input.attention) {
    return snapshot({
      state: "needs_attention",
      reasonCode: input.attention.reasonCode,
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
      nextAction: projectNextAction(input.attention),
    });
  }

  // 4. Give-up streak crossed -> blocked.
  if (input.backoff && input.backoff.consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD) {
    return snapshot({
      state: "blocked",
      reasonCode: stripClassPrefix(input.backoff.reasonClass),
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 5. Backoff currently delaying retry -> cooling_off.
  if (input.backoff?.backoffApplied) {
    return snapshot({
      state: "cooling_off",
      reasonCode: stripClassPrefix(input.backoff.reasonClass),
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
      remoteSurface,
    });
  }

  // 6. Outbox stalled, coverage incomplete, gaps present, or last run
  //    failed -> degraded. Success-with-gaps must not be healthy.
  if (isDegradedShape(input, axes)) {
    return snapshot({
      state: "degraded",
      reasonCode: degradedReasonCode(input),
      lastSuccessAt,
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
  if (isHealthyShape(input, axes)) {
    return snapshot({
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
  return snapshot({
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

// ─── State-shape predicates ───────────────────────────────────────────────

function isDegradedShape(input: ComputeConnectionHealthInput, axes: ConnectionAxes): boolean {
  if (axes.outbox === "stalled") {
    return true;
  }
  // Per design.md "A remote browser surface capacity failure degrades the
  // affected connection without changing source identity": a managed
  // remote-surface in `failed` state (surface_failed lease, or unhealthy
  // surface) degrades the connection. Routine waiting/leased/idle do not.
  if (axes.remote_surface === "failed") {
    return true;
  }
  if (
    axes.coverage === "gaps" ||
    axes.coverage === "partial" ||
    axes.coverage === "retryable_gap" ||
    axes.coverage === "terminal_gap"
  ) {
    return true;
  }
  // Required-but-accepted contradiction: the rollup named an accepted-
  // coverage axis on behalf of a *required* stream, which means a
  // load-bearing stream is unaccounted for. Treat as degraded so the
  // contradictory manifest cannot paint the connection green.
  if (input.coverage?.requiredButAccepted === true && isAcceptedCoverage(axes.coverage)) {
    return true;
  }
  if (axes.freshness === "stale") {
    return true;
  }
  if (input.run?.latestStatus === "failed") {
    return true;
  }
  if (input.run?.latestStatus === "succeeded" && input.run.hasDegradingGaps) {
    return true;
  }
  return false;
}

function isHealthyShape(input: ComputeConnectionHealthInput, axes: ConnectionAxes): boolean {
  if (input.run?.latestStatus !== "succeeded") {
    return false;
  }
  if (input.run.hasDegradingGaps) {
    return false;
  }
  if (!isHealthyCoverage(axes.coverage)) {
    return false;
  }
  // Required-but-accepted contradiction blocks healthy even when the
  // axis itself is in the healthy-compatible set (e.g. `unsupported`).
  if (input.coverage?.requiredButAccepted === true && isAcceptedCoverage(axes.coverage)) {
    return false;
  }
  if (axes.freshness !== "fresh") {
    return false;
  }
  // Coverage and freshness must both be affirmative. If a connection
  // truly has no freshness policy, the caller should pass `fresh`;
  // `unknown` is reserved for missing or unreliable evidence.
  return true;
}

/**
 * Coverage axes that are healthy-compatible. `complete` is the obvious
 * one; the accepted-coverage variants (`unsupported`, `unavailable`,
 * `deferred`, `inventory_only`) are also healthy-compatible because the
 * caller only emits them when the manifest declares the absence as
 * accepted. Required-but-uncollected streams roll up as `terminal_gap`
 * or `partial`, not as one of these axes — except when the manifest is
 * contradictory (required + accepted-absent), in which case
 * `requiredButAccepted` blocks healthy at a higher layer.
 */
function isHealthyCoverage(axis: CoverageAxis): boolean {
  switch (axis) {
    case "complete":
      return true;
    default:
      return isAcceptedCoverage(axis);
  }
}

function isAcceptedCoverage(axis: CoverageAxis): boolean {
  return axis === "deferred" || axis === "inventory_only" || axis === "unavailable" || axis === "unsupported";
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
    return "remote_surface_failed";
  }
  return null;
}

// ─── Builders ─────────────────────────────────────────────────────────────

interface SnapshotArgs {
  readonly axes: ConnectionAxes;
  readonly badges: ConnectionBadges;
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

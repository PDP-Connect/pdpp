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
 *   - `complete`: every required stream has complete or accepted-unavailable evidence
 *   - `partial` : some required streams are still in progress / deferred
 *   - `gaps`    : at least one required stream has a retryable or terminal gap
 *   - `unknown` : coverage evidence is missing or unreliable
 */
export type CoverageAxis = "complete" | "gaps" | "partial" | "unknown";

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

/** Connection axes; orthogonal to headline state. */
export interface ConnectionAxes {
  readonly attention: AttentionAxis;
  readonly coverage: CoverageAxis;
  readonly freshness: FreshnessAxis;
  readonly outbox: OutboxAxis;
}

/** Activity badges; never replace the headline pill. */
export interface ConnectionBadges {
  /** Stale freshness — last durable progress is past policy. */
  readonly stale: boolean;
  /** A run or durable work item is currently active for this connection. */
  readonly syncing: boolean;
}

export interface ConnectionHealthSnapshot {
  readonly axes: ConnectionAxes;
  readonly badges: ConnectionBadges;
  readonly last_success_at: string | null;
  readonly next_attempt_at: string | null;
  readonly reason_code: string | null;
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
 */
export interface ConnectionAttentionEvidence {
  readonly actionTarget: string | null;
  readonly expiresAt: string | null;
  readonly lifecycle: "acknowledged" | "in_progress" | "open";
  readonly reasonCode: string | null;
}

/** Coverage rollup. Caller aggregates per-stream evidence into one axis. */
export interface ConnectionCoverageEvidence {
  readonly axis: CoverageAxis;
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
  readonly run: ConnectionRunEvidence | null;
  readonly schedule: ConnectionScheduleEvidence | null;
}

// ─── Projection ───────────────────────────────────────────────────────────

export function computeConnectionHealth(input: ComputeConnectionHealthInput): ConnectionHealthSnapshot {
  const axes = projectAxes(input);
  const badges = projectBadges(input, axes);
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
    });
  }

  // 5. Backoff currently delaying retry -> cooling_off.
  if (input.backoff && input.backoff.backoffApplied) {
    return snapshot({
      state: "cooling_off",
      reasonCode: stripClassPrefix(input.backoff.reasonClass),
      lastSuccessAt,
      nextAttemptAt,
      axes,
      badges,
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
  if (axes.coverage === "gaps" || axes.coverage === "partial") {
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
  if (axes.coverage !== "complete") {
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

function degradedReasonCode(input: ComputeConnectionHealthInput): string | null {
  if (input.run?.reasonCode) {
    return input.run.reasonCode;
  }
  if (input.backoff?.reasonClass) {
    return stripClassPrefix(input.backoff.reasonClass);
  }
  return null;
}

// ─── Builders ─────────────────────────────────────────────────────────────

interface SnapshotArgs {
  readonly axes: ConnectionAxes;
  readonly badges: ConnectionBadges;
  readonly lastSuccessAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly reasonCode: string | null;
  readonly state: ConnectionHealthState;
  readonly unknownReasons?: readonly string[];
}

function snapshot(args: SnapshotArgs): ConnectionHealthSnapshot {
  return {
    state: args.state,
    reason_code: args.reasonCode,
    last_success_at: args.lastSuccessAt,
    next_attempt_at: args.nextAttemptAt,
    axes: args.axes,
    badges: args.badges,
    unknown_reasons: args.unknownReasons ?? [],
  };
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

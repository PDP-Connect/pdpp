// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-run source-pressure cooldown governor.
 *
 * Problem: a connector run can defer work under upstream/source pressure and
 * still terminate `succeeded`. ChatGPT does exactly this — when a private
 * detail endpoint returns bare 429s, the run degrades the remaining
 * conversations to resumable `DETAIL_GAP` records (reason `upstream_pressure`
 * or `rate_limited`) and exits with a clean `succeeded` status rather than
 * grinding the hot account. That is the correct connector behaviour.
 *
 * But the scheduler's failure-class back-off (`scheduler-backoff.ts`) only
 * counts `failed` records. A `succeeded`-with-pending-pressure run resets the
 * failure streak to zero, so the next scheduled tick fires on the normal
 * interval and re-hits the *same* account-level throttle bucket that is still
 * cooling. Unattended cadence then keeps re-pressuring the source.
 *
 * Solution: a second, independent governor that reads the durable pending
 * pressure gaps for a connection and defers the next *automatic* dispatch with
 * a decaying/exponential inter-run cooldown, capped to a reasonable upper
 * bound. The cooldown grows the longer pressure persists (driven by the gaps'
 * recovery attempt counts) and relaxes the moment the gaps recover (the
 * pending set becomes empty), so a clean/recovered run is never stuck.
 *
 * This module is **pure**, mirroring `scheduler-backoff.ts`: it takes the
 * pending pressure gaps + the connector's base interval and returns a
 * decision. No I/O, no timers, no store access. The scheduler reads the
 * durable gaps through an injected probe and feeds them here; the controller
 * projection feeds the same shape so the dashboard renders an honest
 * `cooling_off` pill instead of bare green while pressure gaps remain.
 *
 * The cooldown is deliberately orthogonal to failure back-off: a connection
 * can be failing (back-off) *and* carrying pressure gaps (cooldown) at the
 * same time. The scheduler takes whichever defers the next run further. The
 * cooldown applies to both scheduled and ordinary manual runs. An explicit
 * `force: true` flag is required to override the cooldown; ordinary `Sync now`
 * is intentionally subject to it so the owner does not accidentally hammer a
 * hot account.
 */

// ─── Pressure reasons ───────────────────────────────────────────────────────

/**
 * Detail-gap reasons that represent account/source-level pressure — the gap
 * was deferred because the upstream throttled or was transiently unavailable,
 * not because of a connector defect or a missing-data decision. Only these
 * reasons drive the cooldown. A gap with any other reason (or none) is ignored
 * here so unrelated gap bookkeeping cannot throttle the schedule.
 *
 * `upstream_pressure` and `rate_limited` are the two source-pressure reasons a
 * connector emits on a `DETAIL_GAP` (see
 * `packages/polyfill-connectors/src/connector-runtime-protocol.ts`).
 */
export const SOURCE_PRESSURE_GAP_REASONS: ReadonlySet<string> = new Set(["rate_limited", "upstream_pressure"]);

// ─── Tunables ──────────────────────────────────────────────────────────────

/**
 * Floor multiplier applied to the base interval the first time pressure gaps
 * are observed (before any recovery attempt has been made against them). At
 * minimum we wait one full base interval beyond the normal cadence so the
 * next tick does not immediately re-hit a bucket that just throttled.
 */
export const DEFAULT_COOLDOWN_MIN_MULTIPLIER = 1;

/**
 * Hard ceiling on the exponent applied to the base interval. The cooldown
 * multiplier is `2^min(attempt, MAX_COOLDOWN_EXP)`. With the default 6h cap
 * below this is rarely binding, but it guards against absurd intervals.
 */
export const DEFAULT_MAX_COOLDOWN_EXP = 6;

/**
 * Absolute ceiling on the cooldown delay (6 hours by default). Source pressure
 * is per-account and time-varying — the 2026-06-02 ChatGPT probes showed it
 * recovers over minutes-to-hours, not days. A 6h cap is well above the
 * observed recovery curve while staying below the failure-back-off 24h cap, so
 * even a persistently-pressured connection is retried a few times a day to
 * pick up recovery without owner intervention.
 */
export const DEFAULT_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// ─── Provider profiles (§10-B, §3 rule 6) ───────────────────────────────────
//
// maxCooldownCycles is a ProviderProfile field. A connector MAY declare its own
// value (ChatGPT does — the registry override below), but it can NEVER opt OUT of
// the §10-B no-progress escalation: `cooldownProfileForConnector` falls every
// unregistered connector back to a conservative `DEFAULT_COOLDOWN_PROFILE`
// (spec §10-A/§10-B "impossible by construction"). This is distinct from the §3
// rule-6 *safety/ban prior* (`pacingMinIntervalMs`, strictly per-provider, no
// default): maxCooldownCycles is a no-progress escalation budget, not a rate
// prior — so a safe shared default is correct, and a SILENT "never escalate"
// (the pre-fix absent → Infinity) is the §10-B bug being closed.

/**
 * ChatGPT cooldown profile for the §10-B no-progress escalation.
 *
 * maxCooldownCycles: after this many consecutive cooldown cycles with zero
 * forward progress, the connection escalates from `cooling_off` →
 * `needs_attention`. Derived from ChatGPT's observed recovery curve:
 * a pressure window that lasts more than ~48h (8 × 6h cooldown cap) has
 * almost certainly stopped recovering on its own — either the endpoint is
 * down or the account access needs renewal. 8 cycles gives a full 48h window
 * before alarming the owner.
 */
export const CHATGPT_COOLDOWN_PROFILE = Object.freeze({
  maxCooldownCycles: 8,
});

/**
 * §10-B "impossible by construction" default cooldown profile.
 *
 * The silent-disable hole (GAP 1, cooldown half): `maxCooldownCycles` used to be
 * an OPTIONAL `ComputeCooldownOptions` field, and the two production call sites
 * (the dashboard projection in controller.ts and the scheduler dispatch in
 * scheduler.ts) passed NOTHING — so the no-progress escalation (§10-B) was never
 * wired at all. A dead-but-429ing provider would render `cooling_off` forever,
 * the exact permanent lie §10-B exists to prevent.
 *
 * The fix mirrors §10-A: the production path ALWAYS resolves a real cooldown
 * profile via `cooldownProfileForConnector` (explicit registry override OR this
 * safe default — never null, never Infinity). A connector can NEVER be on the
 * cooldown path with escalation silently disabled. An unaudited connector
 * escalates after a CONSERVATIVE number of no-progress cycles (more generous
 * than ChatGPT's audited 8, since its real recovery window is unknown) rather
 * than never escalating.
 */
export const DEFAULT_COOLDOWN_PROFILE = Object.freeze({
  maxCooldownCycles: 12,
});

// Per-connector cooldown profile registry. An EXPLICIT entry overrides the
// default cycle budget with the provider's observed recovery-window length. A
// connector NOT listed here does NOT opt out of §10-B escalation — it falls back
// to DEFAULT_COOLDOWN_PROFILE via `cooldownProfileForConnector`. The registry
// value is an override, never a gate (spec §10-B, §3 rule 6).
const COOLDOWN_PROFILES: Readonly<Record<string, { maxCooldownCycles: number }>> = Object.freeze({
  chatgpt: CHATGPT_COOLDOWN_PROFILE,
});

/**
 * Resolve the cooldown profile the production path MUST use. ALWAYS returns a
 * real profile — the explicit per-connector profile when registered, otherwise
 * the safe `DEFAULT_COOLDOWN_PROFILE`. There is no null/Infinity return: a
 * connection can never sit on the cooldown path with §10-B escalation silently
 * off. Matches on the canonical connector key prefix so instance-scoped ids
 * (`chatgpt:default`) resolve to the `chatgpt` profile.
 */
export function cooldownProfileForConnector(connectorId: string | null | undefined): {
  maxCooldownCycles: number;
} {
  if (typeof connectorId === "string" && connectorId) {
    const base = connectorId.split(":")[0]?.split("@")[0];
    const explicit = base ? COOLDOWN_PROFILES[base] : undefined;
    if (explicit) {
      return explicit;
    }
  }
  return DEFAULT_COOLDOWN_PROFILE;
}

/**
 * Loud assertion for the §10-B cooldown profile: a resolved profile MUST carry a
 * finite positive-integer `maxCooldownCycles`. This is the JS-seam equivalent of
 * a build error (the .ts `ProviderCooldownProfile` already types it non-optional)
 * — a caller that reaches the cooldown consumption path with no usable cycle
 * budget fails LOUD here rather than silently defaulting to "never escalate"
 * (the §10-B silent-disable GAP 1 closed).
 */
export function assertCooldownProfile(profile: { maxCooldownCycles?: number } | null | undefined): {
  maxCooldownCycles: number;
} {
  if (
    !profile ||
    typeof profile.maxCooldownCycles !== "number" ||
    !Number.isFinite(profile.maxCooldownCycles) ||
    profile.maxCooldownCycles <= 0
  ) {
    throw new Error(
      "source-pressure cooldown requires a per-provider profile.maxCooldownCycles (finite positive integer); " +
        "resolve it via cooldownProfileForConnector — no silent 'never escalate' (spec §10-B, §3 rule 6)"
    );
  }
  return { maxCooldownCycles: profile.maxCooldownCycles };
}

/**
 * Production entry point for the cross-run source-pressure cooldown: resolves the
 * connector's cooldown profile (never null), asserts it loudly, and computes the
 * decision with §10-B escalation WIRED. The two dashboard/scheduler call sites
 * use this instead of calling `computeSourcePressureCooldown` bare, so a
 * connection on the cooldown path can never have escalation silently disabled.
 *
 * `consecutiveCooldownCycles` is the connection's running count of consecutive
 * no-progress cooldown cycles (0 when not tracked yet); it threads ADDITIVELY —
 * it does not alter the dispatch/drain decision, only the health-state
 * recommendation.
 */
export function computeConnectionSourcePressureCooldown(
  connectorId: string | null | undefined,
  pendingGaps: readonly PendingPressureGap[],
  baseIntervalMs: number,
  lastRunAtMs: number,
  options: ComputeCooldownOptions = {}
): SourcePressureCooldownDecision {
  const { maxCooldownCycles } = assertCooldownProfile(cooldownProfileForConnector(connectorId));
  return computeSourcePressureCooldown(pendingGaps, baseIntervalMs, lastRunAtMs, {
    ...options,
    maxCooldownCycles,
  });
}

/**
 * One pending pressure gap as the governor needs to see it. This is the
 * minimal projection of a `connector_detail_gaps` row (see
 * `reference-implementation/server/stores/connector-detail-gap-store.js`)
 * that drives the cooldown. The scheduler probe and the controller projection
 * both map durable rows onto this shape.
 */
export interface PendingPressureGap {
  /**
   * How many times the runtime has already tried to recover this gap. Drives
   * the exponential growth: a gap that has survived more recovery attempts is
   * more persistent and earns a longer cooldown. Defaults to 0 when absent.
   */
  readonly attemptCount?: number | null;
  /**
   * Last observed provider-pressure timestamp (ISO). Prefer the durable
   * gap's `last_attempt_at`, falling back to `updated_at` when the connector
   * deferred before a retry lease existed.
   */
  readonly lastPressureAt?: string | null;
  /**
   * Optional connector/runtime-authored floor for the next attempt (ISO). When
   * present and later than the computed cooldown, it is honoured as the
   * `nextRunAt`. This lets a connector that *does* learn a concrete wait (e.g.
   * a `Retry-After`) push the schedule out further without the governor
   * guessing.
   */
  readonly nextAttemptAfter?: string | null;
  /** Source-pressure reason. Only `SOURCE_PRESSURE_GAP_REASONS` count. */
  readonly reason: string | null;
}

export interface ComputeCooldownOptions {
  /**
   * §10-B: number of consecutive cooldown cycles (each with ZERO forward
   * progress and ZERO gap recovery) observed so far. When this reaches
   * `maxCooldownCycles`, `recommendedHealthState` escalates from `cooling_off`
   * → `needs_attention` — catching the dead-but-429ing provider that the
   * "source pressure always recovers" rule would otherwise lie about forever.
   *
   * Defaults to 0 (no escalation) when absent — backwards-compatible for
   * callers that do not yet track cycle counts.
   */
  readonly consecutiveCooldownCycles?: number;
  /**
   * Explicit force-override: bypass provider-pressure cooldown entirely.
   * Ordinary manual `Sync now` should NOT set this flag — it is reserved for
   * an explicit "force run despite pressure" action so the owner's default
   * button cannot accidentally hammer a hot account.
   */
  readonly force?: boolean;
  /**
   * §10-B: ceiling on consecutive no-progress cooldown cycles before the
   * connection escalates to `needs_attention`. This is a ProviderProfile field
   * — each provider must declare its own value; there is NO cross-provider
   * default (spec §3 rule 6). When absent (or Infinity), escalation never fires.
   */
  readonly maxCooldownCycles?: number;
  /** Max exponent applied to the base interval. */
  readonly maxCooldownExp?: number;
  /** Absolute ceiling (ms) on the cooldown delay. */
  readonly maxCooldownMs?: number;
  /** Floor multiplier on first observation. */
  readonly minMultiplier?: number;
}

export interface SourcePressureCooldownDecision {
  /** True when the scheduler should defer the next automatic dispatch. */
  readonly cooldownApplied: boolean;
  /** Effective interval (ms) the scheduler should wait from `lastRunAt`. */
  readonly effectiveIntervalMs: number;
  /**
   * Stable identity of this cooldown shape, or null when not cooling. The
   * scheduler dedupes its one-shot cooling-off skip record on this string, so
   * it changes only when the pressure picture meaningfully changes (gap count
   * or persistence), re-arming the audit line. Reasons are sorted so identity
   * is order-independent.
   */
  readonly identity: string | null;
  /**
   * Max recovery-attempt count across the pending pressure gaps. Exposed so
   * the dashboard/audit can show how persistent the pressure is.
   */
  readonly maxAttemptCount: number;
  /** ISO timestamp of when the next dispatch becomes eligible. */
  readonly nextRunAt: string;
  /** Count of pending source-pressure gaps that drove the decision. */
  readonly pendingPressureGapCount: number;
  /**
   * Health-state recommendation for the dashboard pill.
   *   - `"cooling_off"` — source pressure active, expected to recover.
   *   - `"needs_attention"` — §10-B escalation: maxCooldownCycles consecutive
   *     cycles with zero forward progress AND zero gap recovery. The provider
   *     appears dead or the owner's access has expired. Owner action required.
   *   - `null` — no cooldown applied.
   *
   * Source pressure is NEVER `"blocked"` (that is the failure-backoff ladder's
   * domain). But it CAN escalate to `"needs_attention"` when it never actually
   * advances — that is the distinct signal this escalation adds.
   */
  readonly recommendedHealthState: "cooling_off" | "needs_attention" | null;
}

// ─── Core helper ────────────────────────────────────────────────────────────

/**
 * Compute the cross-run cooldown for a connection given its pending durable
 * pressure gaps.
 *
 * @param pendingGaps    Pending detail gaps for *this* connection. Only gaps
 *                       whose reason is in `SOURCE_PRESSURE_GAP_REASONS` are
 *                       counted; everything else is ignored.
 * @param baseIntervalMs The configured scheduling interval (ms).
 * @param lastRunAtMs    Epoch ms of the most recent run; the next-run time is
 *                       computed relative to this. Pass `0` if never run.
 * @param options        Tunables + manual bypass.
 */
export function computeSourcePressureCooldown(
  pendingGaps: readonly PendingPressureGap[],
  baseIntervalMs: number,
  lastRunAtMs: number,
  options: ComputeCooldownOptions = {}
): SourcePressureCooldownDecision {
  const minMultiplier = normalizePositiveInteger(options.minMultiplier, DEFAULT_COOLDOWN_MIN_MULTIPLIER);
  const maxExp = normalizeNonNegativeInteger(options.maxCooldownExp, DEFAULT_MAX_COOLDOWN_EXP);
  const maxMs = normalizeFiniteNonNegativeMs(options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS, DEFAULT_MAX_COOLDOWN_MS);
  const normalizedBaseIntervalMs = normalizeFiniteNonNegativeMs(baseIntervalMs, 0);
  const normalizedLastRunAtMs = normalizeFiniteNonNegativeMs(lastRunAtMs, 0);
  const force = options.force === true;

  // §10-B: no-progress escalation cycle tracking. Defaults to 0 (no escalation)
  // when absent — backwards-compatible for callers that do not track cycles yet.
  const consecutiveCooldownCycles = normalizeNonNegativeInteger(options.consecutiveCooldownCycles ?? undefined, 0);
  // NOTE: this is the low-level PURE computation. It tolerates an absent
  // `maxCooldownCycles` (→ Infinity = no escalation) ONLY so unit tests can
  // exercise the cooldown math in isolation. PRODUCTION CALLERS MUST NOT use
  // this function directly — they must go through `computeConnectionSourcePressureCooldown`,
  // which resolves a required per-provider profile via `assertCooldownProfile`
  // (throws loud on an absent/Infinity ceiling) so §10-B escalation can never be
  // silently disabled. `cooldown-profile-required.test.js` pins that contract.
  const maxCooldownCycles =
    typeof options.maxCooldownCycles === "number" &&
    Number.isFinite(options.maxCooldownCycles) &&
    options.maxCooldownCycles > 0
      ? Math.floor(options.maxCooldownCycles)
      : Number.POSITIVE_INFINITY;

  const pressureGaps = (pendingGaps ?? []).filter(
    (gap) => gap && typeof gap.reason === "string" && SOURCE_PRESSURE_GAP_REASONS.has(gap.reason)
  );

  // Force override or no pressure → no cooldown. A recovered run (pending
  // pressure set becomes empty) lands here, so the connection is never stuck
  // cooling. Ordinary manual runs are NOT given a bypass here — they respect
  // the cooldown just like scheduled runs; only an explicit `force: true` skips
  // it.
  if (force || pressureGaps.length === 0) {
    return {
      cooldownApplied: false,
      pendingPressureGapCount: 0,
      maxAttemptCount: 0,
      effectiveIntervalMs: force ? 0 : normalizedBaseIntervalMs,
      nextRunAt: toIsoTimestamp(force ? 0 : normalizedLastRunAtMs + normalizedBaseIntervalMs),
      identity: null,
      recommendedHealthState: null,
    };
  }

  const maxAttemptCount = pressureGaps.reduce(
    (max, gap) => Math.max(max, normalizeNonNegativeInteger(gap.attemptCount ?? undefined, 0)),
    0
  );

  // Multiplier grows with persistence: 2^attempt, floored at `minMultiplier`,
  // capped at `2^maxExp`. A freshly-observed gap (attempt 0) yields the floor
  // multiplier; each unrecovered run doubles the wait.
  const exponent = Math.min(maxAttemptCount, maxExp);
  const multiplier = Math.max(minMultiplier, 2 ** exponent);
  const rawDelay = normalizedBaseIntervalMs * multiplier;
  const cappedIntervalMs = Math.min(rawDelay, maxMs);

  // Anchor cooldown to the provider-pressure observation itself when present,
  // not to scheduler skip audit rows. Skip rows explain why the scheduler did
  // not run; they are not provider attempts and must not slide the window.
  const anchorMs = maxLastPressureAtMs(pressureGaps) || normalizedLastRunAtMs;

  // Honour a connector/runtime-authored `next_attempt_after` floor when it
  // pushes the schedule out further than our computed cooldown.
  const explicitFloorMs = maxNextAttemptAfterMs(pressureGaps);
  const explicitFloorIntervalMs = Math.max(0, explicitFloorMs - anchorMs);
  const effectiveIntervalMs = Math.max(cappedIntervalMs, explicitFloorIntervalMs);
  const nextRunMs = anchorMs + effectiveIntervalMs;

  const reasonSummary = summarizeReasons(pressureGaps);

  // §10-B: escalate cooling_off → needs_attention when the connection has
  // completed maxCooldownCycles consecutive cycles with zero forward progress
  // AND zero gap recovery. This catches the dead-but-429ing provider whose
  // cooldownApplied is always true but that never actually advances —
  // the case where "resumes automatically" would be a permanent lie.
  const escalated = Number.isFinite(maxCooldownCycles) && consecutiveCooldownCycles >= maxCooldownCycles;
  const recommendedHealthState: "cooling_off" | "needs_attention" = escalated ? "needs_attention" : "cooling_off";

  return {
    cooldownApplied: true,
    pendingPressureGapCount: pressureGaps.length,
    maxAttemptCount,
    effectiveIntervalMs,
    nextRunAt: toIsoTimestamp(nextRunMs),
    identity: `source_pressure:${reasonSummary}:gaps=${pressureGaps.length}:attempt=${maxAttemptCount}`,
    recommendedHealthState,
  };
}

/**
 * True only while the cooldown's computed next-run timestamp is still in the
 * future. `cooldownApplied` means "pending pressure gaps exist"; this helper
 * is the separate dispatch/manual safety predicate that answers "is it too
 * early to try again right now?"
 */
export function isSourcePressureCooldownDeferring(
  decision: SourcePressureCooldownDecision,
  nowMs: number = Date.now()
): boolean {
  if (!decision.cooldownApplied) {
    return false;
  }
  const nextRunMs = Date.parse(decision.nextRunAt);
  if (!Number.isFinite(nextRunMs)) {
    return false;
  }
  return nextRunMs > nowMs;
}

function summarizeReasons(gaps: readonly PendingPressureGap[]): string {
  const reasons = new Set<string>();
  for (const gap of gaps) {
    if (typeof gap.reason === "string") {
      reasons.add(gap.reason);
    }
  }
  return [...reasons].sort().join(",");
}

function maxTimestampFieldMs(
  gaps: readonly PendingPressureGap[],
  field: "nextAttemptAfter" | "lastPressureAt"
): number {
  let max = 0;
  for (const gap of gaps) {
    const value = gap[field];
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    max = Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }
  return max;
}

function maxNextAttemptAfterMs(gaps: readonly PendingPressureGap[]): number {
  return maxTimestampFieldMs(gaps, "nextAttemptAfter");
}

function maxLastPressureAtMs(gaps: readonly PendingPressureGap[]): number {
  return maxTimestampFieldMs(gaps, "lastPressureAt");
}

function normalizeFiniteNonNegativeMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function toIsoTimestamp(epochMs: number): string {
  const safeEpochMs = normalizeFiniteNonNegativeMs(epochMs, 0);
  return new Date(safeEpochMs).toISOString();
}

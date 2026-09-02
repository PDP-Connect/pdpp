// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cadence-relative lateness with hysteresis.
 *
 * `deriveReferenceFreshness` answers one question with one threshold: is the
 * data older than `maximumStalenessSeconds`? That is a single global-ish cliff
 * with no neutral middle, so a source that is merely due for a refresh lands
 * in the same bucket as one that has genuinely stopped.
 *
 * The research is unanimous against that shape. Healthchecks.io, Kubernetes
 * (probes and node lease), Prometheus (`for:`), Grafana, and Datadog all size
 * the threshold as a function of the SOURCE'S OWN cadence and all separate a
 * cheap reversible "late" signal from an expensive "broken" one
 * (`health-banner-staleness-vs-freshness-design-prior-art.md`, PDPP design
 * proposal (c)/(d)). A fixed global threshold misfires exactly the way an
 * overly tight `periodSeconds` does: false alarms on sources whose normal
 * cadence is slower or burstier than the constant assumes.
 *
 * Two nested thresholds, mirroring Kubernetes' node-lease-grace vs
 * pod-eviction split:
 *
 *   on_time   age <= interval x LATE_MULTIPLIER
 *   late      first crossing — NEUTRAL, informational, never a banner
 *   overdue   age  > interval x OVERDUE_MULTIPLIER — MATURE evidence
 *
 * `overdue` is a precondition for escalation, never a cause of it. Per the
 * research's predicate (a), lateness alone must remain structurally incapable
 * of firing the global banner: escalation additionally requires an
 * independently proven owner-actionable cause (expired credentials, a runtime
 * block). A source that is simply late — including one that has SILENTLY
 * STOPPED, which is the case a failure counter can never see because it never
 * fails — stays neutral and keeps retrying.
 *
 * ─── ONE AUTHORITY, NOT TWO AGE MODELS ──────────────────────────────────────
 *
 * Three age-ish inputs now exist. They are deliberately NOT parallel policies;
 * each answers a different question and only one owns escalation:
 *
 *   `maximum_staleness_seconds` (manifest, per connector)
 *       Owns the FRESHNESS AXIS: "is the retained data still current enough to
 *       serve?" Consumed by `deriveReferenceFreshness` -> `Fresh` condition.
 *       A data-quality statement about the records, answerable with no
 *       schedule at all — a manual import has staleness semantics and no
 *       cadence.
 *
 *   `interval_seconds` (schedule, per connection)
 *       The raw cadence fact. Not a policy on its own.
 *
 *   this module
 *       Owns LATENESS: "did the expected collection happen?" A statement about
 *       the SCHEDULE, not the data. It is the ONLY input permitted to gate
 *       escalation on age, via `latenessMayEscalate`.
 *
 * A source can be fresh and late (collected recently, then the scheduler
 * stopped — nothing stale yet, but something IS wrong) or stale and on time
 * (a slow cadence whose data legitimately ages between runs). Collapsing these
 * into one number is what made ordinary lateness indistinguishable from a
 * broken source in the first place. `deriveReferenceFreshness` is deliberately
 * left untouched: this module adds the missing axis rather than redefining the
 * existing one.
 */

/**
 * `1x` — crossing ONE expected interval is neutral `Late`, immediately.
 *
 * The plan is explicit that "crossing one expected interval produces a neutral
 * `Late`-equivalent state, not failure". Delaying even the neutral LABEL until
 * some multiple would hide a plain, true fact the owner is entitled to see:
 * this source was due and has not run. Late is not an alarm — it costs nothing
 * to be honest about, and Healthchecks.io shows exactly this bare "Late" label
 * beside a timestamp.
 *
 * Grace belongs BETWEEN late and escalation, never before late.
 */
export const LATE_MULTIPLIER = 1;

/**
 * `3x` before the lateness is mature — two further intervals of neutral `late`
 * after the first missed beat. This is where the cadence-derived grace and the
 * "repeated/mature evidence" requirement live: a single skipped run can never
 * reach the escalation precondition.
 */
export const OVERDUE_MULTIPLIER = 3;

/**
 * Floor applied ONLY to the overdue/escalation threshold, never to `late`.
 *
 * A source on a 60-second cadence is honestly late 61 seconds after its due
 * time, and saying so is free. But three missed 60-second beats is not mature
 * evidence of anything — it is ordinary scheduler jitter, and escalating on it
 * would flap exactly the way an overly tight `periodSeconds` does. Modelled on
 * Healthchecks.io's guidance to set the grace "a little above the expected
 * duration" rather than proportionally tight at small intervals.
 */
export const MIN_OVERDUE_GRACE_MS = 30 * 60 * 1000;

export type CadenceLateness = "late" | "on_time" | "overdue" | "unknown";

export interface CadenceLatenessInput {
  /** The source's own declared cadence. `null` for a source with no schedule. */
  readonly intervalSeconds: number | null | undefined;
  /** Last successful collection. `null` when the source has never succeeded. */
  readonly lastSuccessAtMs: number | null | undefined;
  readonly nowMs: number;
}

export interface CadenceLatenessVerdict {
  /**
   * When the source stops being `on_time`. Always exposed so the owner can see
   * the number as a plain fact, per the research's rule that freshness is
   * displayed unconditionally and only ESCALATION is conditional.
   */
  readonly lateAfterMs: number | null;
  /** When lateness becomes mature enough to be an escalation precondition. */
  readonly overdueAfterMs: number | null;
  readonly state: CadenceLateness;
}

/**
 * Classify a source's lateness against its OWN cadence.
 *
 * Returns `unknown` — never `late` — when the source has no declared interval
 * or has never succeeded. Absence of a cadence is not evidence of lateness,
 * and treating it as such is how a never-run source gets reported as broken.
 */
export function deriveCadenceLateness(input: CadenceLatenessInput): CadenceLatenessVerdict {
  const { intervalSeconds, lastSuccessAtMs, nowMs } = input;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds <= 0 ||
    typeof lastSuccessAtMs !== "number" ||
    !Number.isFinite(lastSuccessAtMs)
  ) {
    return { lateAfterMs: null, overdueAfterMs: null, state: "unknown" };
  }
  const intervalMs = intervalSeconds * 1000;
  // No floor on `late`: one interval late IS late, and the raw fact is owed to
  // the owner unconditionally. The floor applies only to the mature threshold,
  // which is the one with consequences.
  const lateAfterMs = lastSuccessAtMs + intervalMs * LATE_MULTIPLIER;
  const overdueAfterMs = lastSuccessAtMs + Math.max(intervalMs * OVERDUE_MULTIPLIER, MIN_OVERDUE_GRACE_MS);
  if (nowMs > overdueAfterMs) {
    return { lateAfterMs, overdueAfterMs, state: "overdue" };
  }
  if (nowMs > lateAfterMs) {
    return { lateAfterMs, overdueAfterMs, state: "late" };
  }
  return { lateAfterMs, overdueAfterMs, state: "on_time" };
}

/**
 * Whether cadence lateness may CONTRIBUTE to a banner escalation.
 *
 * Deliberately not "should the banner fire". Even mature lateness is only a
 * precondition: the caller must still have an independently proven
 * owner-actionable or blocked cause. This function exists so that the one
 * place lateness could leak into the verdict axis is named, greppable, and
 * testable — rather than being an inline age comparison somewhere in the
 * rollup.
 */
export function latenessMayEscalate(verdict: CadenceLatenessVerdict): boolean {
  return verdict.state === "overdue";
}

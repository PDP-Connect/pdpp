// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded periodic revalidation for stale SYNTHESIZED owner-action evidence.
 *
 * `owner-action-gate.ts::unresolvedOwnerActionEvidenceFromSummary` re-derives
 * evidence fresh on every probe from the last terminal run's
 * `rendered_verdict.required_actions` / `reason_code` — it has no expiry and
 * no independent timestamp. `pre-run-gate.ts::gateAttention` used to treat it
 * identically to real durable `connector_attention_records` evidence: once
 * observed, the connector was skipped every tick forever, with no way for a
 * fresh run to prove the stale reason wrong.
 *
 * This module decides WHEN a bounded, non-interactive confirming run
 * (`triggerKind: "revalidation"`, see run-automation-policy.ts) is due for a
 * connector currently blocked on SYNTHESIZED evidence — mirroring
 * `scheduler-backoff.ts`'s doubling-and-capped shape, but keyed off the
 * SAME durable `history` the ordinary backoff decision already reads
 * (`runtime.history`, hydrated from `run_history` on restart, so the cadence
 * survives a process restart exactly as well as ordinary backoff does). No
 * new Map, no new table: the two anchors are (1) the single pending-skip
 * record `pre-run-gate.ts` emits the first time it observes this evidence
 * (tagged with a stable, server-owned `error` prefix — never derived from
 * `key`, which is opaque and may be connector-influenced) and (2) any
 * subsequent FAILED confirming-run attempts (tagged via
 * `RunRecord.source.revalidationProbe`, also server-owned). A cleared
 * `notifiedAttentionSkips` dedup cell (pre-run-gate.ts) means `gateAttention`
 * must call this decision on EVERY tick while evidence persists, not just
 * once — the pending-skip record itself is still emitted at most once per
 * evidence-key sighting, exactly like the durable-attention path.
 *
 * Pure: no I/O, no timers, no side effects. `decideSynthesizedRevalidation`
 * takes recent history + now and returns a decision; the pre-run gate
 * consumes it.
 */

import type { RunRecord } from "../scheduler-domain-types.ts";

// ─── Tunables (mirror scheduler-backoff.ts's shape) ────────────────────────

/** Initial cooldown before the first bounded confirming run is admitted. */
export const DEFAULT_INITIAL_REVALIDATION_DELAY_MS = 30 * 60 * 1000; // 30 min

/** Hard ceiling on the exponential multiplier. */
export const DEFAULT_MAX_REVALIDATION_BACKOFF_EXP = 8;

/** Absolute ceiling (ms) on the revalidation cooldown — 24h, same as ordinary backoff's cap, so a stale reason is reprobed at least once a day even while the connection is otherwise `blocked`. */
export const DEFAULT_MAX_REVALIDATION_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stable, server-owned marker prefixed onto the `error` field of the skip
 * record this module's caller emits while a bounded confirming run is not
 * yet due. Never derived from or compared against `evidence.key`/`reason`
 * (connector/owner-influenced, opaque) — this is authored exclusively by
 * `pre-run-gate.ts` and is the sole discriminant `decideSynthesizedRevalidation`
 * uses to identify its own prior skips in `history`.
 */
export const SYNTHESIZED_REVALIDATION_PENDING_MARKER = "synthesized_attention_revalidation_pending";

export interface SynthesizedRevalidationOptions {
  readonly initialDelayMs?: number;
  readonly maxBackoffExp?: number;
  readonly maxDelayMs?: number;
}

export interface SynthesizedRevalidationDecision {
  /** True when a bounded confirming run should be admitted THIS tick. */
  readonly admit: boolean;
  /** Number of consecutive prior FAILED confirming-run attempts observed. */
  readonly attempt: number;
  /** The cooldown (ms) applied before the NEXT confirming run, from the last observed activity. */
  readonly delayMs: number;
  /** ISO timestamp of the next eligible confirming run (informational). */
  readonly nextEligibleAt: string;
}

function isRevalidationPendingSkip(record: RunRecord): boolean {
  return record.status === "skipped" && (record.error ?? "").startsWith(SYNTHESIZED_REVALIDATION_PENDING_MARKER);
}

/**
 * True for a FAILED dispatched confirming run — `RunRecord.source.revalidationProbe`
 * is set only by run-executor.ts's `buildScheduledRunSource` when the call's
 * `triggerKind` was `"revalidation"` (server-owned, never connector-supplied).
 * A failed probe must extend the same streak the pending-skip records anchor
 * (so the doubling backoff actually doubles across repeated failed probes,
 * instead of resetting to the initial delay every time a probe consumes its
 * one admitted attempt and fails) — but a SUCCEEDED probe does NOT match
 * here: a success means the stale reason was disproven, so the next probe
 * for a genuinely new failure must start the streak (and the initial delay)
 * over, exactly like `scheduler-backoff.ts` breaks its streak on success.
 */
function isFailedRevalidationProbe(record: RunRecord): boolean {
  return record.status === "failed" && record.source.revalidationProbe === true;
}

function recordTimestampMs(record: RunRecord): number | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const completed = Date.parse(record.completedAt ?? "");
  if (Number.isFinite(completed)) {
    return completed;
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const started = Date.parse(record.startedAt ?? "");
  return Number.isFinite(started) ? started : null;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeFiniteNonNegativeMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

/**
 * Trailing run of consecutive revalidation-pending skips AND failed
 * revalidation probes for a connector instance, walking `history` newest →
 * oldest and stopping at the first record that is neither (a SUCCEEDED
 * probe, an ordinary scheduled run, or an unrelated skip all break the
 * streak — exactly like `scheduler-backoff.ts`'s same-class-failure walk
 * breaks on a differently classed record).
 *
 * `attempt` counts only FAILED PROBES (not pending-skip records) — the
 * pending skip is emitted once per evidence-key sighting by `gateAttention`
 * (deduped exactly like the durable-attention path was before this fix, so
 * `history` does not gain one row per scheduler tick), so it cannot serve as
 * a per-tick attempt counter; a failed probe is a genuine bounded attempt
 * and IS the right unit for the doubling exponent, mirroring
 * `scheduler-backoff.ts`'s `consecutiveFailures`.
 *
 * `lastActivityAtMs` is the NEWEST timestamp in the trailing run (the most
 * recent pending-skip sighting or failed-probe attempt) — the point the
 * cooldown counts forward from, mirroring ordinary backoff's
 * `lastRunAtMs + effectiveIntervalMs` (elapsed-since-last-activity, not
 * elapsed-since-first-sighting, so tick frequency cannot skew the cadence).
 */
function trailingRevalidationPendingStreak(history: readonly RunRecord[]): {
  readonly attempt: number;
  readonly lastActivityAtMs: number | null;
} {
  let attempt = 0;
  let lastActivityAtMs: number | null = null;
  // biome-ignore lint/style/noIncrementDecrement: Explicit counter update mirrors scheduler-backoff.ts's walk for auditability.
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (!record) {
      break;
    }
    const isFailedProbe = isFailedRevalidationProbe(record);
    if (!(isFailedProbe || isRevalidationPendingSkip(record))) {
      break;
    }
    if (lastActivityAtMs === null) {
      // First (newest) record of the streak anchors the cooldown.
      lastActivityAtMs = recordTimestampMs(record);
    }
    if (isFailedProbe) {
      attempt += 1;
    }
  }
  return { attempt, lastActivityAtMs };
}

function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Decide whether a bounded, non-interactive confirming run is due for
 * synthesized evidence currently blocking automatic dispatch.
 *
 * `history` MUST already be filtered to this connector instance (same
 * convention as `computeNextRunWithBackoff`'s `history` parameter) — the
 * caller (pre-run-gate.ts, via the same `runtime.history` the dispatch
 * governor already filters) owns that scoping.
 */
export function decideSynthesizedRevalidation(
  history: readonly RunRecord[],
  now: number,
  options: SynthesizedRevalidationOptions = {}
): SynthesizedRevalidationDecision {
  const initialDelayMs = normalizeFiniteNonNegativeMs(options.initialDelayMs, DEFAULT_INITIAL_REVALIDATION_DELAY_MS);
  const maxExp = normalizeNonNegativeInteger(options.maxBackoffExp, DEFAULT_MAX_REVALIDATION_BACKOFF_EXP);
  const maxDelayMs = normalizeFiniteNonNegativeMs(options.maxDelayMs, DEFAULT_MAX_REVALIDATION_DELAY_MS);

  const { attempt, lastActivityAtMs } = trailingRevalidationPendingStreak(history);

  if (lastActivityAtMs === null) {
    // No pending-skip or failed-probe activity observed yet: not currently
    // blocked on synthesized evidence, or first sighting is still being
    // recorded by the caller this same tick. Never admit immediately.
    return {
      admit: false,
      attempt,
      delayMs: initialDelayMs,
      nextEligibleAt: toIsoTimestamp(now + initialDelayMs),
    };
  }

  const exponent = Math.min(attempt, maxExp);
  const delayMs = Math.min(initialDelayMs * 2 ** exponent, maxDelayMs);
  const elapsed = now - lastActivityAtMs;
  const admit = elapsed >= delayMs;

  return {
    admit,
    attempt,
    delayMs,
    nextEligibleAt: toIsoTimestamp(lastActivityAtMs + delayMs),
  };
}

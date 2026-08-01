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
 * `scheduler-backoff.ts`'s doubling-and-capped shape.
 *
 * Durability: the cadence anchor is a SEPARATE, explicit, per-connection
 * durable record (`SchedulerStore.getSynthesizedRevalidationState` /
 * `upsertSynthesizedRevalidationState` / `clearSynthesizedRevalidationState`,
 * backed by the `synthesized_revalidation_state` table — see
 * server/stores/scheduler-store.ts) — NOT derived from `runtime.history` /
 * `run_history`. This is deliberate:
 *
 *   - `run_history` hydration is a fleet-global newest-N window
 *     (`schedulerStore.listRunHistory(500)`); a busy fleet can evict a
 *     quiet connector's anchor row before its cooldown elapses, silently
 *     re-arming the initial delay. A dedicated per-connector-instance
 *     row (primary-keyed, one row total) cannot be evicted by unrelated
 *     connector activity.
 *   - `RunRecord.source` on a hydrated history row is reconstructed as
 *     `{ id, kind: "connector" }` only (`fromStoredRunRecord`,
 *     scheduler.ts) — a `source.revalidationProbe` marker embedded in a
 *     persisted `RunRecord` does NOT round-trip through that hydration
 *     path. A dedicated typed column has no such lossy projection.
 *   - A malformed `source_json` value on some OTHER row does not touch
 *     this table at all (row-scoped by connector_instance_id, not a
 *     shared bulk JSON parse across an unrelated read).
 *
 * Pure decision function: no I/O, no timers, no side effects. Takes the
 * durable state record (or null) + now and returns a decision; the
 * pre-run gate reads/writes the durable record around this call.
 */

// ─── Tunables (mirror scheduler-backoff.ts's shape) ────────────────────────

/** Initial cooldown before the first bounded confirming run is admitted. */
export const DEFAULT_INITIAL_REVALIDATION_DELAY_MS = 30 * 60 * 1000; // 30 min

/** Hard ceiling on the exponential multiplier. */
export const DEFAULT_MAX_REVALIDATION_BACKOFF_EXP = 8;

/** Absolute ceiling (ms) on the revalidation cooldown — 24h, same as ordinary backoff's cap, so a stale reason is reprobed at least once a day even while the connection is otherwise `blocked`. */
export const DEFAULT_MAX_REVALIDATION_DELAY_MS = 24 * 60 * 60 * 1000;

export interface SynthesizedRevalidationOptions {
  readonly initialDelayMs?: number;
  readonly maxBackoffExp?: number;
  readonly maxDelayMs?: number;
}

/**
 * The durable per-connection cadence anchor this module reads and advances.
 * Structurally matches `SynthesizedRevalidationStateRecord` (server/stores/
 * scheduler-store.ts) minus the identity columns the caller already owns —
 * defined locally so this pure leaf module has no store-layer import.
 */
export interface SynthesizedRevalidationAnchor {
  /** ISO timestamp of the last observed activity (pending sighting or failed probe). */
  readonly anchorAt: string;
  /** Consecutive prior FAILED confirming-run attempts observed. */
  readonly attempt: number;
}

/**
 * Durable per-connection cadence-anchor persistence for bounded synthesized
 * owner-action revalidation. Backed by `SchedulerStore`'s
 * `synthesized_revalidation_state` methods (server/stores/
 * scheduler-store.ts) — deliberately NOT `runtime.history` (see this
 * module's doc comment for why). Shared by both `pre-run-gate.ts::gateAttention`
 * (the admit/anchor-create/clear path) and `dispatch-governor.ts`'s
 * blocked-tick due-probe (a read-only consult of the same anchor) — defined
 * here, the pure leaf both spokes already import from, so neither spoke
 * gains a new cross-spoke edge.
 */
export interface SynthesizedRevalidationStore {
  clear: (connectorInstanceId: string) => Promise<void> | void;
  get: (
    connectorInstanceId: string
  ) => Promise<SynthesizedRevalidationAnchor | null> | SynthesizedRevalidationAnchor | null;
  upsert: (
    connectorInstanceId: string,
    connectorId: string,
    anchor: SynthesizedRevalidationAnchor
  ) => Promise<void> | void;
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

function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Decide whether a bounded, non-interactive confirming run is due for
 * synthesized evidence currently blocking automatic dispatch.
 *
 * `anchor` is this connector instance's durable cadence record, or `null`
 * when no pending-skip/failed-probe activity has been observed yet (first
 * sighting this tick, or the anchor was cleared by a resolved/succeeded
 * probe). A `null` anchor never admits immediately — the caller is
 * expected to create the anchor on this same tick's pending-skip emission.
 */
export function decideSynthesizedRevalidation(
  anchor: SynthesizedRevalidationAnchor | null,
  now: number,
  options: SynthesizedRevalidationOptions = {}
): SynthesizedRevalidationDecision {
  const initialDelayMs = normalizeFiniteNonNegativeMs(options.initialDelayMs, DEFAULT_INITIAL_REVALIDATION_DELAY_MS);
  const maxExp = normalizeNonNegativeInteger(options.maxBackoffExp, DEFAULT_MAX_REVALIDATION_BACKOFF_EXP);
  const maxDelayMs = normalizeFiniteNonNegativeMs(options.maxDelayMs, DEFAULT_MAX_REVALIDATION_DELAY_MS);

  if (!anchor) {
    return {
      admit: false,
      attempt: 0,
      delayMs: initialDelayMs,
      nextEligibleAt: toIsoTimestamp(now + initialDelayMs),
    };
  }

  const lastActivityAtMs = Date.parse(anchor.anchorAt);
  if (!Number.isFinite(lastActivityAtMs)) {
    // Malformed/unparseable durable timestamp: treat exactly like no
    // anchor rather than crashing the gate or admitting immediately —
    // the caller's next pending-skip sighting re-anchors cleanly.
    return {
      admit: false,
      attempt: anchor.attempt,
      delayMs: initialDelayMs,
      nextEligibleAt: toIsoTimestamp(now + initialDelayMs),
    };
  }

  const attempt = Math.max(0, Math.floor(anchor.attempt));
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

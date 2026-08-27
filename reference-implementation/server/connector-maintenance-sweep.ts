// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-summary maintenance sweep — the single home for every durable
 * mutation that an ordinary `GET /_ref/connectors` (unscoped, paginated, or
 * scoped) used to perform inline: browser-enrollment-shell TTL retirement,
 * due-attention expiry, and connector-summary-evidence reconcile/repair.
 *
 * Terminal-gate revision (2026-07-29): the independent gate proved ordinary
 * GET was not read-only — it retired expired enrollment shells, expired due
 * attention (on the scoped/detail routes), and repaired
 * `connector_summary_evidence` (unbounded on the scoped/detail routes,
 * bounded-but-still-writing on the list routes) on every request. This
 * module is the ONE place those three writes now happen, on a periodic
 * timer plus the existing one-shot startup pass — reusing the SAME generic
 * timer chassis (`runtime/browser-surface-lease-sweep-timer.ts`'s
 * `createBrowserSurfaceLeaseSweepTimer`) the browser-surface-lease sweep
 * already uses, and the SAME resumable bounded-round evidence sweep
 * (`runBoundedSummaryEvidenceSweep` / `runStartupSummaryEvidenceSweepToCompletion`)
 * the startup pass already used — not a new parallel engine, one more
 * `sweep: () => Promise<void>` wired into machinery that already exists.
 *
 * Every sub-sweep here is independently best-effort: one family's failure
 * (e.g. attention-store unavailable) must not block shell retirement or
 * evidence repair from running this tick, and must not throw past this
 * module (the timer's own `onSweepError` handles that, exactly like the
 * browser-surface-lease sweep).
 */

import { retireExpiredBrowserEnrollmentShellsForMaintenance } from "./ref-control.ts";
import { runSearchIndexDirtyReconcileRound } from "./search-index-reconcile.ts";
import { getDefaultConnectorAttentionStore } from "./stores/connector-attention-store.ts";
import {
  type ConnectorMaintenanceCursorLease,
  type ConnectorMaintenanceCursorStore,
  createConnectorMaintenanceCursorStore,
} from "./stores/connector-maintenance-cursor-store.ts";
import {
  createResumableRunHistoryBackfillStage,
  type ResumableRunHistoryBackfillStage,
} from "./stores/run-history-backfill-stage.ts";

export interface ConnectorMaintenanceSweepOptions {
  readonly attentionExpireLimit?: number;
  readonly evidenceSweepLeaseDurationMs?: number;
  readonly evidenceSweepMaxDurationMs?: number;
  readonly evidenceSweepPageSize?: number;
  readonly nowIso?: () => string;
  /**
   * Fires once the eligible dirty backlog has gone `NO_PROGRESS_ALERT_THRESHOLD_PASSES`
   * consecutive rounds without shrinking or a complete-set prune (design
   * reviewer finding P2-4) AND the current round's backlog is still
   * non-zero — never on an already-empty backlog that simply has no work
   * left to do. Best-effort, same posture as `onPhaseError`: never awaited,
   * never allowed to affect sweep control flow. See `roundMadeProgress`'s
   * doc for the exact progress definition and why `repaired > 0` is the
   * wrong signal.
   */
  readonly onNoProgressAlert?: (info: {
    readonly consecutiveNoProgressPasses: number;
    readonly eligibleBacklog: number;
  }) => void;
  readonly onPhaseError?: (
    phase: "attention" | "evidence" | "run_history_backfill" | "search_index_dirty" | "shells",
    err: unknown
  ) => void;
  /** Emits non-secret evidence after the TTL phase actually revoked shells. */
  readonly onShellsRetired?: (info: {
    readonly cause: "ttl_expired";
    readonly connectionIds: readonly string[];
  }) => void;
  readonly runEvidenceSweep: (args: {
    readonly afterId?: string | null;
    readonly firstTranche?: "walk" | "acceleration";
    readonly lease?: ConnectorMaintenanceCursorLease;
    readonly maxDurationMs: number;
    readonly pageSize?: number;
  }) => Promise<unknown>;
  readonly runHistoryBackfillBatchSize?: number;
  readonly runHistoryBackfillMaxDurationMs?: number;
  /**
   * Injectable for tests; defaults to the real fenced-cursor stage
   * (terminal-read-architecture-fable-0730.md §9/R9.2). One more
   * independently best-effort branch on the existing sweep — no new
   * engine, no new table.
   */
  readonly runHistoryBackfillStage?: ResumableRunHistoryBackfillStage;
  readonly searchIndexDirtyReconcileMaxDurationMs?: number;
  readonly searchIndexDirtyReconcilePageSize?: number;
}

interface ResumableEvidenceSweepResult {
  /**
   * Round-level progress fields (design reviewer finding P2-4), read
   * best-effort from the adapter's raw result — `undefined` (never `null`)
   * when the caller's `runEvidenceSweep` did not report them, which
   * `roundMadeProgress` and the no-progress counter both treat as "unknown,
   * assume progress" (fail-open: a caller that doesn't report these fields
   * must never manufacture a false alert). See
   * `runBoundedSummaryEvidenceSweep`'s `BoundedSweepResult.eligibleBacklog`
   * doc for what these fields mean and why.
   */
  readonly eligibleBacklog?: number;
  readonly failed?: number;
  readonly incomplete: boolean;
  readonly prunedComplete?: boolean;
  readonly resumeAfterId: string | null;
}

const DEFAULT_CURSOR_LEASE_DURATION_MS = 30_000;

/**
 * Consecutive no-progress PASSES (transitions between two successive
 * backlog observations that failed to shrink) before the maintenance sweep
 * alerts (design reviewer finding P2-4). `runBoundedSummaryEvidenceSweep`'s
 * own doc documents a HARD 2-ROUND starvation bound between the walk and
 * acceleration tranches: a single round can legitimately report zero
 * backlog movement while that alternation is simply giving the other
 * tranche its turn, and `onPageConverged` publication races
 * (`isExpectedProjectionRace`) can cost a round's progress too. N=3 clears
 * that normal 2-round alternation noise with one round of margin, while
 * still catching a genuinely stuck backlog fast: at the production
 * maintenance-tick interval (`CONNECTOR_MAINTENANCE_SWEEP_INTERVAL_MS`,
 * ~60s in `server/index.ts`), 3 consecutive no-progress PASSES is ~3
 * minutes — versus the real 2026-08-17 incident, which sat unnoticed for
 * over an hour and was only found by manually polling the database.
 *
 * NOTE — a "pass" is a TRANSITION, not a raw round count: the first round
 * this process ever observes a backlog number has nothing to compare
 * against, so it bootstraps the baseline rather than counting as either a
 * progress or a no-progress pass (see `nextNoProgressTrackingState`). A
 * backlog stuck at the same value therefore alerts on its 4th consecutive
 * observed round (1 baseline + 3 non-shrinking transitions) — worst case
 * one extra ~60s tick beyond N, still on the order of minutes, not the real
 * incident's hour-plus.
 */
const NO_PROGRESS_ALERT_THRESHOLD_PASSES = 3;

/** The other tranche — the alternation this module keeps across ticks. */
function otherTranche(tranche: "walk" | "acceleration"): "walk" | "acceleration" {
  return tranche === "walk" ? "acceleration" : "walk";
}

function readResumableEvidenceSweepResult(
  value: unknown,
  currentCursor: string | null
): ResumableEvidenceSweepResult | null {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const result = value as Record<string, unknown>;
  if (typeof result.incomplete !== "boolean") {
    return null;
  }
  if (result.resumeAfterId !== null && typeof result.resumeAfterId !== "string") {
    return null;
  }
  // A complete sweep must clear the cursor. Accepting a cursor here would
  // let a malformed adapter result erase known-good progress and restart a
  // starved fleet on the next periodic tick.
  if (!result.incomplete && result.resumeAfterId !== null) {
    return null;
  }
  // An incomplete first page legitimately resumes from NULL: the bounded
  // sweep uses its cursor-before-page, so a heavy first-page fold must revisit
  // that same page. After a non-null cursor, however, NULL loses known-good
  // progress and remains invalid. The fenced lease is the durable authority
  // for which of those two meanings applies.
  if (result.incomplete && (result.resumeAfterId === "" || (result.resumeAfterId === null && currentCursor !== null))) {
    return null;
  }
  return {
    incomplete: result.incomplete,
    resumeAfterId: result.resumeAfterId as string | null,
    // Optional telemetry fields: read defensively (never rejected as
    // malformed) — an adapter that omits or malshapes them loses only the
    // no-progress ALERT, never the resumable-cursor contract the strict
    // validation above protects.
    ...(typeof result.eligibleBacklog === "number" ? { eligibleBacklog: result.eligibleBacklog } : {}),
    ...(typeof result.failed === "number" ? { failed: result.failed } : {}),
    ...(typeof result.prunedComplete === "boolean" ? { prunedComplete: result.prunedComplete } : {}),
  };
}

/**
 * Progress definition (design reviewer finding P2-4): a round made progress
 * when the eligible dirty backlog genuinely shrank, OR a complete-set orphan
 * prune ran. Read from `ResumableEvidenceSweepResult`'s optional telemetry
 * fields — see that interface's doc for the fail-open "unknown means assume
 * progress" contract when a caller does not report them.
 *
 * Deliberately NOT `repaired > 0`: `onPageConverged` fires once from the
 * walk tranche and once from the acceleration tranche whenever both process
 * the same fleet in one round (a counter hooked there double-counts), and —
 * more fundamentally — `repaired > 0` is satisfied by repairing rows that
 * are immediately re-dirtied by something else, which is exactly the real
 * incident this metric exists to catch: production sat with the dirty
 * backlog pinned at 8 rows for many minutes while passes alternated
 * `repaired: 1` / `repaired: 0`, and every pass reported `incomplete: true`.
 * A round that "repairs" a row without ever reducing the backlog is doing
 * work, not making progress on the thing an operator cares about — whether
 * the backlog is actually draining.
 *
 * Also deliberately NOT cursor movement: `runCursorWalk` does not null its
 * cursor on completing a short page — it sets `cursor = pageIds.at(-1) ??
 * cursor`, then breaks with `coveredCompleteSet = true` on
 * `pageIds.length < pageSize`, leaving the cursor pinned at the LAST id
 * rather than clearing it. A cursor-movement signal would therefore report
 * "no progress" on every round after the walk reaches the end of a short
 * fleet, even though the walk is genuinely complete and converged — a false
 * alarm, not the real incident.
 *
 * Backlog-count-BY-REASON (e.g. "how many of these 8 are re-dirtied vs.
 * genuinely new") is NOT provided and was not attempted: classifying a
 * dirty row's reason requires joining live canonical authorities per
 * candidate, which is exactly the unbounded discovery pass this bounded-
 * sweep architecture exists to avoid paying on every round. The counter
 * below answers "is the backlog stuck", which is what an operator needs to
 * go look — not "why", which needs a targeted investigation regardless.
 */
/*
 * `prunedComplete` counts as progress ONLY while the backlog is empty.
 *
 * Production wedge, 2026-08-21: discovery was cancelled by its per-unit
 * `statement_timeout` on EVERY pass, so 13 dirty rows never cleared and
 * fleet health read 3 healthy / 24 for hours. This counter — which exists
 * precisely to name that condition — never fired once in 6+ hours, because
 * a cancelled discovery is caught and treated as non-fatal, leaving the
 * walk to report a covered, converged fleet (28 instances, pageSize 25).
 * `prunedComplete` was therefore `true` on every pass and reset the counter
 * to 0 before it could ever reach the threshold. The alert was structurally
 * unreachable in exactly the scenario it was written for.
 *
 * "Covered every page" and "the backlog is draining" are different facts.
 * Pruning orphans while a non-empty dirty backlog sits untouched is work,
 * not progress — the same distinction this module already draws for
 * `repaired > 0`. So a completed prune may only mask a stuck backlog when
 * there is no backlog to be stuck.
 */
function roundMadeProgress(
  currentEligibleBacklog: number,
  previousEligibleBacklog: number,
  prunedComplete: boolean
): boolean {
  if (currentEligibleBacklog < previousEligibleBacklog) {
    return true;
  }
  return prunedComplete === true && currentEligibleBacklog === 0;
}

interface NoProgressTrackingState {
  readonly consecutiveNoProgressPasses: number;
  readonly lastEligibleBacklog: number | null;
}

/**
 * Computes the next no-progress-tracking state for one genuinely-run round
 * and fires the alert once the threshold is crossed on a still-non-empty
 * backlog. Extracted from `runEvidenceSweepRound` to keep that function's
 * cognitive complexity within the repo's lint budget — this is pure
 * bookkeeping with no cursor/lease concerns of its own. Returns (rather than
 * mutates) the next state; the caller writes it back into its own closure
 * variables (process-local, same contract as `nextFirstTranche`).
 */
function nextNoProgressTrackingState(
  result: ResumableEvidenceSweepResult,
  state: NoProgressTrackingState,
  onNoProgressAlert?: (info: { readonly consecutiveNoProgressPasses: number; readonly eligibleBacklog: number }) => void
): NoProgressTrackingState {
  if (result.eligibleBacklog === undefined) {
    return state;
  }
  if (state.lastEligibleBacklog === null) {
    // Bootstrap: the first round this process has ever observed a backlog
    // count has nothing to compare against, so it is neither a progress NOR
    // a no-progress pass — it does not consume a slot in the counter (an
    // earlier revision treated it as an implicit "progress" reset, which
    // silently added one extra round of delay before the N=3 threshold
    // could ever be reached — caught by this module's own test suite).
    return { consecutiveNoProgressPasses: 0, lastEligibleBacklog: result.eligibleBacklog };
  }
  const consecutiveNoProgressPasses = roundMadeProgress(
    result.eligibleBacklog,
    state.lastEligibleBacklog,
    result.prunedComplete === true
  )
    ? 0
    : state.consecutiveNoProgressPasses + 1;
  if (result.eligibleBacklog > 0 && consecutiveNoProgressPasses >= NO_PROGRESS_ALERT_THRESHOLD_PASSES) {
    try {
      onNoProgressAlert?.({ consecutiveNoProgressPasses, eligibleBacklog: result.eligibleBacklog });
    } catch {
      // Alerting must never affect sweep control flow.
    }
  }
  return { consecutiveNoProgressPasses, lastEligibleBacklog: result.eligibleBacklog };
}

/**
 * Keeps the bounded sweep's keyset cursor durably across periodic ticks and
 * process restarts. The cursor is an acceleration hint, not correctness
 * state: each page still writes its own durable fold checkpoints. A
 * rejected/malformed result leaves the prior cursor in place (fail closed)
 * rather than silently restarting a starved fleet.
 *
 * Also alternates `firstTranche` across ticks (2026-08-12): in-process
 * closure state, reset on restart — worst case after a restart is one extra
 * tick before alternation resumes, which is bounded and harmless (the walk
 * is a valid `firstTranche` default on its own, exactly the prior
 * behavior). See `runBoundedSummaryEvidenceSweep`'s own doc for why a
 * caller MUST alternate this value for the 2-round starvation bound to
 * hold, and why a shorter sub-deadline for one tranche (an earlier revision
 * of this fix) could not structurally guarantee that bound on its own.
 */
export function createResumableConnectorMaintenanceSweep(
  options: ConnectorMaintenanceSweepOptions,
  cursorStore: ConnectorMaintenanceCursorStore = createConnectorMaintenanceCursorStore()
): {
  readonly getResumeAfterId: () => string | null;
  readonly run: () => Promise<void>;
  readonly runEvidenceSweepRound: (args: {
    readonly afterId?: string | null;
    readonly maxDurationMs: number;
    readonly pageSize?: number;
  }) => Promise<ResumableEvidenceSweepResult | null>;
} {
  let evidenceSweepInFlight = false;
  let observedResumeAfterId: string | null = null;
  let nextFirstTranche: "walk" | "acceleration" = "walk";
  // No-progress tracking (design reviewer finding P2-4): in-process closure
  // state, reset on restart — same bounded-harmless contract as
  // `nextFirstTranche` above (worst case after a restart is losing up to
  // `NO_PROGRESS_ALERT_THRESHOLD_PASSES - 1` rounds of accumulated count,
  // never a false alert, never a missed one beyond that bounded window).
  let noProgressTracking: NoProgressTrackingState = { consecutiveNoProgressPasses: 0, lastEligibleBacklog: null };
  const runEvidenceSweepRound = async (args: {
    readonly afterId?: string | null;
    readonly maxDurationMs: number;
    readonly pageSize?: number;
  }): Promise<ResumableEvidenceSweepResult | null> => {
    if (evidenceSweepInFlight) {
      return null;
    }
    evidenceSweepInFlight = true;
    let lease: Awaited<ReturnType<ConnectorMaintenanceCursorStore["acquire"]>> = null;
    let committed = false;
    // Committed to THIS call's tranche order before the sweep runs, and
    // flipped for the NEXT call regardless of this call's outcome (success,
    // rejection, or throw) — an alternation that silently stalled on one
    // fixed order after a failure would reopen exactly the starvation gap
    // this exists to close.
    const firstTranche = nextFirstTranche;
    nextFirstTranche = otherTranche(firstTranche);
    try {
      const nowIso = options.nowIso?.() ?? new Date().toISOString();
      lease = await cursorStore.acquire({
        leaseDurationMs: options.evidenceSweepLeaseDurationMs ?? DEFAULT_CURSOR_LEASE_DURATION_MS,
        nowIso,
      });
      if (!lease) {
        return null;
      }
      const result = readResumableEvidenceSweepResult(
        await options.runEvidenceSweep({ ...args, afterId: lease.resumeAfterId, firstTranche, lease }),
        lease.resumeAfterId
      );
      if (!result) {
        throw new Error("Maintenance evidence sweep returned an invalid resumable result.");
      }
      // Counter update happens for every genuinely-run round, regardless of
      // whether the cursor commit below succeeds — the round DID run and DID
      // (or did not) make progress; a lost cursor commit is a separate,
      // already-handled concern (the round is simply discarded and retried).
      noProgressTracking = nextNoProgressTrackingState(result, noProgressTracking, options.onNoProgressAlert);
      const nextCursor = result.incomplete ? result.resumeAfterId : null;
      committed = await cursorStore.commit({
        lease,
        resumeAfterId: nextCursor,
        updatedAt: options.nowIso?.() ?? new Date().toISOString(),
      });
      if (!committed) {
        return null;
      }
      observedResumeAfterId = nextCursor;
      return result;
    } finally {
      if (lease && !committed) {
        await cursorStore.release(lease).catch(() => {
          // The bounded lease eventually expires; never mask the sweep error.
        });
      }
      evidenceSweepInFlight = false;
    }
  };
  return {
    getResumeAfterId: () => observedResumeAfterId,
    run: async () => {
      await runConnectorMaintenanceSweep({ ...options, runEvidenceSweep: runEvidenceSweepRound });
    },
    runEvidenceSweepRound,
  };
}

/**
 * Runs one maintenance tick: shell retirement, attention expiry, and one
 * bounded round of evidence reconcile/repair, each independently
 * best-effort. Used both by the periodic timer (one tick per interval) and
 * once at startup before the HTTP listener accepts traffic (so a
 * never-before-observed connection converges before the first read rather
 * than paying inline repair cost — design.md "Startup is acceleration, not
 * authority," now also true of the periodic tick: it accelerates
 * convergence, but an ordinary GET reading momentarily stale evidence
 * between ticks is honest, not a correctness gap).
 *
 * The evidence round's `firstTranche` alternates every tick (owned by
 * `createResumableConnectorMaintenanceSweep`'s closure state, threaded
 * through here via `runEvidenceSweep`), so a fold-heavy walk page that stays
 * incomplete for many consecutive ticks can never deny the dirty-priority
 * acceleration tranche first opportunity for more than one consecutive
 * tick — a hard 2-tick bound, not a soft time reservation. See
 * `runBoundedSummaryEvidenceSweep`'s own ordering comment for the exact
 * starvation mode this closes and why alternation (not a shorter
 * sub-deadline) is what structurally closes it (2026-08-12).
 */
let defaultRunHistoryBackfillStage: ResumableRunHistoryBackfillStage | null = null;
function getDefaultRunHistoryBackfillStage(): ResumableRunHistoryBackfillStage {
  defaultRunHistoryBackfillStage ??= createResumableRunHistoryBackfillStage();
  return defaultRunHistoryBackfillStage;
}

export async function runConnectorMaintenanceSweep(options: ConnectorMaintenanceSweepOptions): Promise<void> {
  const { onPhaseError, nowIso = () => new Date().toISOString() } = options;

  await Promise.all([
    retireExpiredBrowserEnrollmentShellsForMaintenance(nowIso(), null)
      .then((connectionIds) => {
        if (connectionIds.length > 0) {
          options.onShellsRetired?.({ cause: "ttl_expired", connectionIds });
        }
      })
      .catch((err) => {
        onPhaseError?.("shells", err);
      }),
    Promise.resolve(getDefaultConnectorAttentionStore().expireAllDueAttention({ now: nowIso() })).catch((err) => {
      onPhaseError?.("attention", err);
    }),
    options
      .runEvidenceSweep({
        maxDurationMs: options.evidenceSweepMaxDurationMs ?? 2000,
        pageSize: options.evidenceSweepPageSize ?? 25,
      })
      .catch((err) => {
        onPhaseError?.("evidence", err);
      }),
    (options.runHistoryBackfillStage ?? getDefaultRunHistoryBackfillStage())
      .run({
        ...(typeof options.runHistoryBackfillBatchSize === "number"
          ? { batchSize: options.runHistoryBackfillBatchSize }
          : {}),
        maxDurationMs: options.runHistoryBackfillMaxDurationMs ?? 2000,
      })
      .catch((err) => {
        onPhaseError?.("run_history_backfill", err);
      }),
    runSearchIndexDirtyReconcileRound({
      maxDurationMs: options.searchIndexDirtyReconcileMaxDurationMs ?? 2000,
      pageSize: options.searchIndexDirtyReconcilePageSize ?? 25,
    }).catch((err) => {
      onPhaseError?.("search_index_dirty", err);
    }),
  ]);
}

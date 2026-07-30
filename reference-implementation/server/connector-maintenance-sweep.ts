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
import { getDefaultConnectorAttentionStore } from "./stores/connector-attention-store.ts";
import {
  type ConnectorMaintenanceCursorStore,
  createConnectorMaintenanceCursorStore,
} from "./stores/connector-maintenance-cursor-store.ts";

export interface ConnectorMaintenanceSweepOptions {
  readonly attentionExpireLimit?: number;
  readonly evidenceSweepLeaseDurationMs?: number;
  readonly evidenceSweepMaxDurationMs?: number;
  readonly evidenceSweepPageSize?: number;
  readonly nowIso?: () => string;
  readonly onPhaseError?: (phase: "attention" | "evidence" | "shells", err: unknown) => void;
  readonly runEvidenceSweep: (args: {
    readonly afterId?: string | null;
    readonly maxDurationMs: number;
    readonly pageSize?: number;
  }) => Promise<unknown>;
}

interface ResumableEvidenceSweepResult {
  readonly incomplete: boolean;
  readonly resumeAfterId: string | null;
}

const DEFAULT_CURSOR_LEASE_DURATION_MS = 30_000;

function readResumableEvidenceSweepResult(value: unknown): ResumableEvidenceSweepResult | null {
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
  // An incomplete sweep without a cursor is not resumable. Do not replace a
  // known-good cursor with an ambiguous result that would restart the fleet.
  if (result.incomplete && !result.resumeAfterId) {
    return null;
  }
  return { incomplete: result.incomplete, resumeAfterId: result.resumeAfterId as string | null };
}

/**
 * Keeps the bounded sweep's keyset cursor durably across periodic ticks and
 * process restarts. The cursor is an acceleration hint, not correctness
 * state: each page still writes its own durable fold checkpoints. A
 * rejected/malformed result leaves the prior cursor in place (fail closed)
 * rather than silently restarting a starved fleet.
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
        await options.runEvidenceSweep({ ...args, afterId: lease.resumeAfterId })
      );
      if (!result) {
        throw new Error("Maintenance evidence sweep returned an invalid resumable result.");
      }
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
 */
export async function runConnectorMaintenanceSweep(options: ConnectorMaintenanceSweepOptions): Promise<void> {
  const { onPhaseError, nowIso = () => new Date().toISOString() } = options;

  await Promise.all([
    retireExpiredBrowserEnrollmentShellsForMaintenance(nowIso(), null).catch((err) => {
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
  ]);
}

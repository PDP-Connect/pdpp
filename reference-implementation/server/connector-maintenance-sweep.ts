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

export interface ConnectorMaintenanceSweepOptions {
  readonly attentionExpireLimit?: number;
  readonly evidenceSweepMaxDurationMs?: number;
  readonly evidenceSweepPageSize?: number;
  readonly nowIso?: () => string;
  readonly onPhaseError?: (phase: "attention" | "evidence" | "shells", err: unknown) => void;
  readonly runEvidenceSweep: (args: { readonly maxDurationMs: number; readonly pageSize?: number }) => Promise<unknown>;
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

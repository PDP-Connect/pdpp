// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-component helpers for the shared run-row grammar. These live in a sibling
 * module (not run-row.tsx) so that run-row.tsx exports *only* the RunRow
 * component — a requirement for React Fast Refresh, which disables itself for
 * any module that mixes component and non-component exports.
 */

import type { RunSummary } from "../lib/ref-client.ts";

export function browserSurfaceStatusCopy(run: RunSummary): { detail: string; label: string } | null {
  if (!run.browser_surface_status) {
    return null;
  }
  const reason = run.browser_surface_wait_reason
    ? ` Reason: ${run.browser_surface_wait_reason.replaceAll("_", " ")}.`
    : "";
  if (run.browser_surface_status === "waiting_for_browser_surface") {
    return {
      label: "browser queued",
      detail: `Waiting for an available n.eko browser surface. This is runtime resource backpressure, not connector auth or protocol failure.${reason}`,
    };
  }
  if (run.browser_surface_status === "deferred") {
    return {
      label: "browser deferred",
      detail: `Deferred by the n.eko browser-surface lease policy. This is runtime resource backpressure, not connector auth or protocol failure.${reason}`,
    };
  }
  return {
    label: "browser surface",
    detail: `Browser-surface lease status: ${run.browser_surface_status.replaceAll("_", " ")}.${reason}`,
  };
}

export function isAwaitingInteraction(run: RunSummary): boolean {
  return run.needs_input === true;
}

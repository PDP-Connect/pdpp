// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const ACTIVE_RUN_SUMMARY_STATUSES = new Set(["pending", "started", "in_progress"]);

/** Connector-summary liveness from ref-control's `isActiveRunSummaryStatus`. */
export function isActiveConnectorRunSummaryStatus(status: string): boolean {
  return ACTIVE_RUN_SUMMARY_STATUSES.has(status);
}

/** Synthetic scheduler gate decisions have no run id and are not navigable syncs. */
export function connectorRunSummaryId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

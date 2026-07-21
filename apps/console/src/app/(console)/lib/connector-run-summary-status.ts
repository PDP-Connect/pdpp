const ACTIVE_RUN_SUMMARY_STATUSES = new Set(["pending", "started", "in_progress"]);

/** Connector-summary liveness from ref-control's `isActiveRunSummaryStatus`. */
export function isActiveConnectorRunSummaryStatus(status: string): boolean {
  return ACTIVE_RUN_SUMMARY_STATUSES.has(status);
}

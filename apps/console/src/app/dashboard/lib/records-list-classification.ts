import type { ConnectorOverview } from "./rs-client.ts";

const PRIMARY_NO_DATA_HEALTH_STATES = new Set(["blocked", "cooling_off", "degraded", "needs_attention"]);
const PRIMARY_NO_DATA_RUN_STATUSES = new Set(["abandoned", "failed"]);

export function hasLocalDeviceProgressEvidence(overview: ConnectorOverview): boolean {
  const progress = overview.localDeviceProgress;
  if (!progress) {
    return false;
  }
  return Boolean(
    progress.last_ingest_at ||
      progress.last_heartbeat_at ||
      (typeof progress.records_pending === "number" && progress.records_pending > 0) ||
      (typeof progress.source_count === "number" && progress.source_count > 0)
  );
}

export function hasRecordsListProgress(overview: ConnectorOverview): boolean {
  return overview.totalRecords > 0 || hasLocalDeviceProgressEvidence(overview);
}

export function shouldShowInPrimaryConnections(overview: ConnectorOverview): boolean {
  if (hasRecordsListProgress(overview)) {
    return true;
  }
  if (overview.error || overview.isRunning) {
    return true;
  }
  if (overview.lastRun && PRIMARY_NO_DATA_RUN_STATUSES.has(overview.lastRun.status)) {
    return true;
  }
  const healthState = overview.connectionHealth?.state;
  return Boolean(healthState && PRIMARY_NO_DATA_HEALTH_STATES.has(healthState));
}

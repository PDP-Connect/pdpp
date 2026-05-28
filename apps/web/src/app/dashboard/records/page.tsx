import { PageHeader } from "../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { RecordsListView } from "../components/views/records-list-view.tsx";
import { dashboardRoutes } from "../components/views/routes.ts";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  listDeviceExporterSourceInstances,
  type RefConnectorRunSummary,
  type RefConnectorSummary,
} from "../lib/ref-client.ts";
import type { ConnectorOverview } from "../lib/rs-client.ts";
import { RecordsPagePoller } from "./records-page-poller.tsx";

export const dynamic = "force-dynamic";

function toConnectorRunRef(summary: RefConnectorRunSummary | null) {
  if (!summary) {
    return null;
  }
  return {
    run_id: summary.run_id,
    first_at: summary.first_at,
    last_at: summary.last_at,
    event_count: summary.event_count,
    status: summary.status,
    failure_reason: summary.failure_reason,
    known_gaps: summary.known_gaps ?? [],
  };
}

function toConnectorOverview(summary: RefConnectorSummary): ConnectorOverview {
  const lastRun = toConnectorRunRef(summary.last_run);
  const lastSuccessfulRun = toConnectorRunRef(summary.last_successful_run);
  return {
    connectionHealth: summary.connection_health,
    connectionId: summary.connection_id,
    connector: {
      connector_id: summary.connector_id,
      display_name: summary.display_name,
      name: summary.connector_display_name ?? summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    },
    connectorDisplayName: summary.connector_display_name,
    connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
    localDeviceProgress: summary.local_device_progress ?? null,
    retainedBytes: summary.retained_bytes ?? null,
    streams: summary.streams.map((name) => ({
      object: "stream",
      name,
      record_count: 0,
      last_updated: null,
    })),
    streamCount: summary.stream_count,
    totalRetainedBytes: summary.total_retained_bytes,
    totalRecords: summary.total_records,
    lastRun,
    lastSuccessfulRun,
    isRunning: lastRun != null && new Set(["started", "in_progress"]).has(lastRun.status),
  };
}

export default async function RecordsIndexPage() {
  let overviews: ConnectorOverview[];
  // Aggregate `records_pending` across all enrolled local device source
  // instances. The records list otherwise only shows retained-on-server
  // totals, which implies completeness when a local collector still has
  // outbox work to drain. Surfaced honestly in the header; treated as 0
  // when the device-exporter endpoint fails so the rest of the page
  // still renders.
  let pendingOnDevices = 0;
  try {
    const response = await liveDashboardDataSource.listConnectorSummaries();
    overviews = response.data.map(toConnectorOverview);
    try {
      const sources = await listDeviceExporterSourceInstances();
      pendingOnDevices = sources.data.reduce(
        (sum, s) => sum + (typeof s.records_pending === "number" ? s.records_pending : 0),
        0
      );
    } catch {
      // Device-exporter diagnostics are advisory; if they fail we still
      // render the connector list. Per-connection diagnostics surface
      // the underlying error.
      pendingOnDevices = 0;
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Connections" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const runningCount = overviews.filter((o) => o.isRunning).length;

  return (
    <DashboardShell active="records">
      <RecordsListView
        interactive={true}
        overviews={overviews}
        pendingOnDevices={pendingOnDevices}
        pollerSlot={<RecordsPagePoller enabled={runningCount > 0} />}
        routes={dashboardRoutes}
      />
    </DashboardShell>
  );
}

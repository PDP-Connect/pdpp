import { RecordsListView } from "@/app/dashboard/components/views/records-list-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import type { RefConnectorRunSummary, RefConnectorSummary } from "@/app/dashboard/lib/ref-client.ts";
import type { ConnectorOverview } from "@/app/dashboard/lib/rs-client.ts";
import { SandboxShell } from "../_demo/components/shell.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-static";

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
    connector: {
      connector_id: summary.connector_id,
      display_name: summary.display_name,
      name: summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    },
    streams: summary.streams.map((name) => ({
      object: "stream",
      name,
      record_count: 0,
      last_updated: null,
    })),
    totalRecords: summary.total_records,
    lastRun,
    lastSuccessfulRun,
    isRunning: lastRun != null && new Set(["started", "in_progress"]).has(lastRun.status),
  };
}

export default async function SandboxRecordsPage() {
  const response = await sandboxDashboardDataSource.listConnectorSummaries();
  const overviews = response.data.map(toConnectorOverview);
  return (
    <SandboxShell active="records">
      <RecordsListView interactive={false} overviews={overviews} routes={sandboxRoutes} />
    </SandboxShell>
  );
}

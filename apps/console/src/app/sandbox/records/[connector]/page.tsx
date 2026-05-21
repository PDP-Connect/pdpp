import { notFound } from "next/navigation";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { ConnectorDetailView } from "@/app/dashboard/components/views/connector-detail-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { sandboxDashboardDataSource } from "../../_demo/data-source.ts";

export const dynamic = "force-static";

const RECENT_RUNS_LIMIT = 10;

export default async function SandboxConnectorPage({ params }: { params: Promise<{ connector: string }> }) {
  const { connector } = await params;
  const connectorId = decodeURIComponent(connector);
  const ds = sandboxDashboardDataSource;
  const manifests = await ds.listConnectorManifests();
  const manifest = manifests.find((m) => m.connector_id === connectorId);
  if (!manifest) {
    notFound();
  }
  const [streams, overview, runsResp] = await Promise.all([
    ds.listStreams(connectorId),
    ds.getConnectorOverview(manifest),
    ds.listRuns({ connector_id: connectorId, limit: RECENT_RUNS_LIMIT }),
  ]);
  return (
    <DashboardShell active="records" mode="mock-owner">
      <ConnectorDetailView
        manifest={manifest}
        overview={overview}
        recentRuns={runsResp.data}
        routes={sandboxRoutes}
        streams={streams}
      />
    </DashboardShell>
  );
}

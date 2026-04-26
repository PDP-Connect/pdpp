import { notFound } from "next/navigation";
import { ConnectorDetailView } from "@/app/dashboard/components/views/connector-detail-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { SandboxShell } from "../../_demo/components/shell.tsx";
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
    <SandboxShell active="records">
      <ConnectorDetailView
        manifest={manifest}
        overview={overview}
        recentRuns={runsResp.data}
        routes={sandboxRoutes}
        streams={streams}
      />
    </SandboxShell>
  );
}

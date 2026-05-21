import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { StreamRecordsView } from "@/app/dashboard/components/views/stream-records-view.tsx";
import type { StreamManifest } from "@/app/dashboard/lib/rs-client.ts";
import { sandboxDashboardDataSource } from "../../../_demo/data-source.ts";

export const dynamic = "force-static";
const PAGE_SIZE = 50;

export default async function SandboxStreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string; stream: string }>;
  searchParams: Promise<{ cursors?: string; columns?: string }>;
}) {
  const { connector, stream } = await params;
  const { cursors: cursorsParam, columns: columnsParam } = await searchParams;
  const connectorId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const trail = cursorsParam ? cursorsParam.split(",").filter(Boolean) : [];
  const ds = sandboxDashboardDataSource;
  const [page, manifests] = await Promise.all([
    ds.queryRecords(connectorId, streamName, { limit: PAGE_SIZE, cursor: trail.at(-1) }),
    ds.listConnectorManifests(),
  ]);
  const manifest = manifests.find((m) => m.connector_id === connectorId);
  const streamDef = manifest?.streams?.find((s) => s.name === streamName);
  const streamManifest = (streamDef ?? null) as StreamManifest | null;

  return (
    <DashboardShell active="records" mode="mock-owner">
      <StreamRecordsView
        columnsParam={columnsParam}
        connectorId={connectorId}
        page={page}
        routes={sandboxRoutes}
        showHealthLink={false}
        streamManifest={streamManifest}
        streamName={streamName}
        trail={trail}
      />
    </DashboardShell>
  );
}

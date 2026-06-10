import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { SourceSetupCatalog } from "../../components/source-setup-catalog.tsx";
import { buildConnectorCatalog, type ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { listConnectorManifests } from "../../lib/rs-client.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  source_q?: string;
}

export default async function AddSourcePage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let catalog: ConnectorCatalogEntry[] = [];
  try {
    const manifests = await listConnectorManifests();
    catalog = buildConnectorCatalog(manifests);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }
  const sourceQuery = typeof params.source_q === "string" ? params.source_q.trim() : "";
  return (
    <DashboardShell active="records">
      <PageHeader
        breadcrumbs={[
          { href: dashboardRoutes.section.overview, label: "Dashboard" },
          { href: dashboardRoutes.section.records, label: "Sources" },
          { label: "Add source" },
        ]}
        description="Add source accounts that populate this PDPP instance. AI app and agent access is configured separately under Connect AI apps."
        title="Add source"
      />
      <SourceSetupCatalog action={dashboardRoutes.section.addSource} catalog={catalog} query={sourceQuery} />
    </DashboardShell>
  );
}

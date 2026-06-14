import { RecordroomShell } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { ServerUnreachable } from "../../components/shell.tsx";
import { type ExistingSourceSetupLink, SourceSetupCatalog } from "../../components/source-setup-catalog.tsx";
import { buildConnectorCatalog, type ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { listConnectorSummaries, type RefConnectorSummary } from "../../lib/ref-client.ts";
import { listConnectorManifests } from "../../lib/rs-client.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  source_q?: string;
}

function latestImport(summary: RefConnectorSummary): { file: string | null; status: string | null } {
  const batch = summary.acquisition_coverage?.latest_batch ?? null;
  return {
    file: batch?.uploaded_file_name ?? null,
    status: batch?.status ?? null,
  };
}

function buildExistingSourcesByConnector(
  summaries: readonly RefConnectorSummary[]
): Record<string, ExistingSourceSetupLink[]> {
  const grouped: Record<string, ExistingSourceSetupLink[]> = {};
  for (const summary of summaries) {
    if (!summary.connection_id || summary.status === "revoked" || summary.revoked_at) {
      continue;
    }
    const importFacts = latestImport(summary);
    const rows = grouped[summary.connector_id] ?? [];
    rows.push({
      connectionId: summary.connection_id,
      displayName: summary.display_name,
      latestImportFile: importFacts.file,
      latestImportStatus: importFacts.status,
      status: summary.status ?? null,
      totalRecords: summary.total_records,
    });
    grouped[summary.connector_id] = rows;
  }
  for (const rows of Object.values(grouped)) {
    rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return grouped;
}

export default async function AddSourcePage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let catalog: ConnectorCatalogEntry[] = [];
  let existingSourcesByConnector: Record<string, ExistingSourceSetupLink[]> = {};
  try {
    const [manifests, summaries] = await Promise.all([listConnectorManifests(), listConnectorSummaries()]);
    catalog = buildConnectorCatalog(manifests);
    existingSourcesByConnector = buildExistingSourcesByConnector(summaries.data);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShell>
          <ServerUnreachable />
        </RecordroomShell>
      );
    }
    throw err;
  }
  const sourceQuery = typeof params.source_q === "string" ? params.source_q.trim() : "";
  return (
    <RecordroomShell>
      <PageHeader
        breadcrumbs={[
          { href: dashboardRoutes.section.overview, label: "Dashboard" },
          { href: dashboardRoutes.section.records, label: "Sources" },
          { label: "Add source" },
        ]}
        description="Add source accounts that populate this PDPP instance. AI app and agent access is configured separately under Connect AI apps."
        title="Add source"
      />
      <SourceSetupCatalog
        action={dashboardRoutes.section.addSource}
        catalog={catalog}
        existingSourcesByConnector={existingSourcesByConnector}
        query={sourceQuery}
      />
    </RecordroomShell>
  );
}

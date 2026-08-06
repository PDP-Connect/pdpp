// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { existingSourcesByConnectorCatalog } from "../../components/existing-sources-by-connector.ts";
import { ServerUnreachable } from "../../components/shell.tsx";
import { type ExistingSourceSetupLink, SourceSetupCatalog } from "../../components/source-setup-catalog.tsx";
import { buildConnectorCatalog, type ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { listConnectorManifests } from "../../lib/rs-client.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  demo?: string;
  source_q?: string;
}

export default async function AddSourcePage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let catalog: ConnectorCatalogEntry[] = [];
  let existingSourcesByConnector: Record<string, readonly ExistingSourceSetupLink[]> = {};
  if (process.env.NODE_ENV !== "production" && params.demo === "atlas") {
    const demo = await import("./add-source-demo-data.ts");
    ({ catalog, existingSourcesByConnector } = demo.buildAddSourceDemoCatalog());
  } else {
    try {
      const manifests = await listConnectorManifests();
      catalog = buildConnectorCatalog(manifests);
      // EXACT per-connector existing-sources lookup — one `GET
      // /_ref/connections?connector_id=` call per catalog entry (bounded by
      // the registered connector-type catalog size, a few dozen, never by
      // fleet size). Replaces the rejected one-arbitrary-fleet-page
      // `complete`/`existingSourcesIncomplete` stopgap entirely: each
      // connector's existing-sources list is exact by construction, so
      // there is no incompleteness signal left to surface.
      existingSourcesByConnector = await existingSourcesByConnectorCatalog(catalog.map((entry) => entry.connectorKey));
    } catch (err) {
      if (err instanceof ReferenceServerUnreachableError) {
        return (
          <RecordroomShellWithPalette>
            <ServerUnreachable />
          </RecordroomShellWithPalette>
        );
      }
      throw err;
    }
  }

  const sourceQuery = typeof params.source_q === "string" ? params.source_q.trim() : "";
  return (
    <RecordroomShellWithPalette>
      <PageHeader
        breadcrumbs={[
          { href: dashboardRoutes.section.overview, label: "Dashboard" },
          { href: dashboardRoutes.section.records, label: "Sources" },
          { label: "Add source" },
        ]}
        description="Add source accounts that populate this PDPP instance. App and agent access is configured separately under Connect apps."
        title="Add source"
      />
      <SourceSetupCatalog
        action={dashboardRoutes.section.addSource}
        catalog={catalog}
        existingSourcesByConnector={existingSourcesByConnector}
        query={sourceQuery}
      />
    </RecordroomShellWithPalette>
  );
}

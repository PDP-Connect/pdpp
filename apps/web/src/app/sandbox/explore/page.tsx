/**
 * Sandbox Records Explorer — mock-owner mode.
 *
 * Mirrors /dashboard/explore against the deterministic sandbox dataset.
 * No owner auth, no live AS/RS calls.  The RecordsExplorerView component
 * is identical to the live surface so the sandbox shows the same IA shape
 * as a real reference instance.
 *
 * Data assembly (feed loading, peek building, timestamp metadata) lives in
 * explore-data-assembler.ts and is shared with /dashboard/explore so both
 * surfaces stay aligned by construction.
 *
 * Data contract notes:
 *   - listConnectorSummaries / listConnectorManifests / queryRecords /
 *     getRecord / searchRecordsLexical all resolve from sandboxDashboardDataSource.
 *   - isHybridRetrievalAdvertised returns false in the sandbox, so search
 *     always uses the lexical path and never surfaces a hybrid warning.
 *   - The peek readUrl is constructed from the RS endpoint shape with a
 *     clearly illustrative base domain so the visitor sees what a live
 *     instance would issue, without implying a real RS is reachable here.
 */

import { Callout } from "@/app/dashboard/components/primitives.tsx";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { buildExplorerHref, RecordsExplorerView } from "@/app/dashboard/components/views/records-explorer-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { assembleExplorerData } from "@/app/dashboard/explore/explore-data-assembler.ts";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-dynamic";

// Illustrative RS base for the sandbox peek readUrl. Shows the endpoint
// shape a live instance would use without implying a real RS is reachable.
const SANDBOX_RS_EXAMPLE_BASE = "https://rs.pdpp.example";

export default async function SandboxExplorePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    connection?: string | string[];
    stream?: string | string[];
    peek?: string;
    since?: string;
    until?: string;
  }>;
}) {
  const params = await searchParams;
  const data = await assembleExplorerData(params, sandboxDashboardDataSource, SANDBOX_RS_EXAMPLE_BASE);

  return (
    <DashboardShell active="explore" mode="mock-owner">
      <Callout
        className="mb-5"
        description="This view is a seeded sandbox specimen: records are fictional and deterministic, and peek read URLs use rs.pdpp.example to illustrate the live Resource Server shape without implying a reachable owner instance."
        title="Sandbox specimen"
      />
      <RecordsExplorerView data={data} routes={sandboxRoutes} />
      {/* Anchor for `buildExplorerHref` smoke during typecheck. */}
      <span aria-hidden className="hidden" data-explorer-href={buildExplorerHref(sandboxRoutes, {})} />
    </DashboardShell>
  );
}

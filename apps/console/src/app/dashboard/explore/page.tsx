/**
 * Records Explorer — query-driven, connection-aware records browser.
 *
 * Reads through the existing typed wrappers only:
 *   - listConnectorSummaries (_ref/connectors) for the connection facets and
 *     the empty-query recency fan-out.
 *   - listConnectorManifests for the timestamp-field metadata that
 *     pickSearchDisplayTimestamp needs.
 *   - searchRecordsHybrid / searchRecordsLexical for query mode.
 *   - queryRecords for the empty-query fan-out.
 *   - getRecord for the peek panel.
 *
 * No new endpoints.
 *
 * Connection identity rules:
 *   - Empty-query fan-out KNOWS the connection per row. Row key, peek
 *     param, attribution, and full-record link all carry the concrete
 *     `connection_id`.
 *   - Search hits carry `connection_id` whenever the snapshot recorded the
 *     binding (canonical read contract, task 3.2). When present we resolve
 *     directly. Pre-identity snapshots may still omit the field; we fall
 *     back to the visible-set deduction only when exactly one connection of
 *     that connector type is visible ("deduction, not guessing"). Otherwise
 *     the row is connector-scoped and the UI says so.
 *   - Selected-connection chips also fall back to a connector-type post-
 *     filter in search mode because the public surface does not yet narrow
 *     storage fan-in by `connection_id` (canonical read contract, task 3.3
 *     follow-up). The chip label and the spec both call this out instead of
 *     pretending to filter by connection.
 *
 * Data assembly (feed loading, peek building, timestamp metadata) lives in
 * explore-data-assembler.ts so the inline loaders are not duplicated if a
 * second surface ever needs them.
 */

import { buildExplorerHref, RecordsExplorerView } from "@pdpp/operator-ui/components/views/records-explorer-view";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { assembleExplorerData } from "@pdpp/operator-ui/explore/explore-data-assembler";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { getOwnerToken, getRsInternalUrl, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { verifyDashboardSession } from "../lib/verify-session.ts";

export const dynamic = "force-dynamic";

export default async function RecordsExplorerPage({
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
  // Empty-query loads still need the DAL gate; verifying once up front keeps
  // the empty shell consistent with the search route.
  await verifyDashboardSession();
  // Touch the owner token early so we surface "owner token required" through
  // the same code path the other dashboard pages do, rather than dying later
  // in the fan-out.
  await getOwnerToken();

  const params = await searchParams;

  try {
    const data = await assembleExplorerData(params, liveDashboardDataSource, getRsInternalUrl());
    return (
      <DashboardShell active="explore">
        <RecordsExplorerView data={data} routes={dashboardRoutes} />
        {/* Anchor for `buildExplorerHref` smoke during typecheck. */}
        <span aria-hidden className="hidden" data-explorer-href={buildExplorerHref(dashboardRoutes, {})} />
      </DashboardShell>
    );
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="explore">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }
}

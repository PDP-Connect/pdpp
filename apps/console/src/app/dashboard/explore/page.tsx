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

import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { assembleExplorerData } from "@pdpp/operator-ui/explore/explore-data-assembler";
import { Suspense } from "react";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { getOwnerToken, getRsInternalUrl, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { verifyDashboardSession } from "../lib/verify-session.ts";
import { ExploreCanvas } from "./explore-canvas.tsx";
import { buildPeekRelationships, type PeekRelationships } from "./explore-peek-relationships.ts";

/** Parse the peek body JSON the assembler attached, for child → parent links. */
function parsePeekData(bodyJson: string | null): Record<string, unknown> {
  if (!bodyJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(bodyJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const dynamic = "force-dynamic";

type ExploreSearchParams = {
  q?: string;
  connection?: string | string[];
  stream?: string | string[];
  peek?: string;
  since?: string;
  until?: string;
  // Display sort order. Consumed by ExploreCanvas only — the live fetch is
  // always recency-desc; "oldest" reverses the loaded window client-side.
  order?: string;
};

async function ExploreData({
  order,
  params,
}: {
  order: "newest" | "oldest";
  params: ExploreSearchParams;
}) {
  try {
    const data = await assembleExplorerData(params, liveDashboardDataSource, getRsInternalUrl());
    // Relationships for the inspected record come from declared metadata via the
    // SAME `records/lib/relationships.ts` helpers the records detail page uses —
    // resolved server-side here (links are plain serializable data) and passed
    // to the client inspector. Only resolved when a readable record is open.
    let peekRelationships: PeekRelationships | null = null;
    if (data.peek && !data.peek.error && data.peek.connectionId) {
      peekRelationships = await buildPeekRelationships(
        {
          connectorId: data.peek.connectorId,
          connectionId: data.peek.connectionId,
          stream: data.peek.stream,
          recordId: data.peek.recordId,
          data: parsePeekData(data.peek.bodyJson),
        },
        liveDashboardDataSource
      );
    }
    return (
      <ExploreCanvas
        data={data}
        explorePath={dashboardRoutes.section.explore}
        order={order}
        peekRelationships={peekRelationships}
      />
    );
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return <ServerUnreachable />;
    }
    throw err;
  }
}

export default async function RecordsExplorerPage({
  searchParams,
}: {
  searchParams: Promise<ExploreSearchParams>;
}) {
  // Empty-query loads still need the DAL gate; verifying once up front keeps
  // the empty shell consistent with the search route.
  await verifyDashboardSession();
  // Touch the owner token early so we surface "owner token required" through
  // the same code path the other dashboard pages do, rather than dying later
  // in the fan-out.
  await getOwnerToken();

  const params = await searchParams;
  const order = params.order === "oldest" ? "oldest" : "newest";

  return (
    <RecordroomShellWithPalette build="pdpp 0.1.0" host="this server">
      <Suspense fallback={<ListLoadingSkeleton label="records" rows={8} />}>
        <ExploreData order={order} params={params} />
      </Suspense>
    </RecordroomShellWithPalette>
  );
}

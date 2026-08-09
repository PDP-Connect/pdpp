// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Syncs — the Recordroom reskin of the Runs route.
 *
 * Health-first: this surface answers "what was recently collected, and what (in
 * needs my attention?" It fuses three real reference contracts:
 *   - `_ref/runs`       → the runs feed, for per-connection Rhythm + last result
 *   - `_ref/connectors` → per-connection health + schedule + stream list
 * via the pure {@link buildSyncsViewModel}, then renders the {@link SyncsView}
 * (Ink Carbon kit) inside the {@link RecordroomShell}.
 *
 * The route, its `?peek=` deep-link redirect, and the `listRuns` fetch are
 * preserved (a held invariant: the peek redirect must run before any fetch and
 * the page must never pull an inline run timeline).
 *
 * Recent syncs is a real cursor-paginated view over the runs feed (`run_cursor`),
 * with two honest server-side filters — `status` and `connector_id`. `_ref/runs`
 * applies both (see `listRuns`'s `ListQuery`), so every returned row genuinely
 * matches, and the two compose. The source options are projected from the
 * connector-summary page this route already fetches, so the picker can only ever
 * offer connectors the owner really has and the console never holds a connector
 * roster of its own. There is no sort param on `_ref/runs`, so the list is never
 * presented as sortable — it stays newest-first, the one order the feed actually
 * guarantees.
 */

import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { redirect } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPageError,
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "../components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "../components/connector-summary-pager.ts";
import { LivePoller } from "../components/live-poller.tsx";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type ListResponse, listConnectorSummaries, listRuns, type RunSummary } from "../lib/ref-client.ts";
import { DEMO_SYNCS_MODEL } from "./syncs-demo.ts";
import { buildSyncsViewModel } from "./syncs-model.ts";
import { SyncsView } from "./syncs-view.tsx";

const SYNCS_PATH = "/syncs";

export const dynamic = "force-dynamic";
const SYNCS_OVERVIEW_RUN_LIMIT = 25;

interface Params {
  connector_id?: string;
  demo?: string;
  page_cursor?: string;
  peek?: string;
  q?: string;
  run_cursor?: string;
  status?: string;
  [key: string]: string | undefined;
}

function fetchSyncsConnectorsPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  return loadConnectorSummaryPage(pageState, (opts) => listConnectorSummaries(opts));
}

/** Real, honest run-status filter options — every value `_ref/runs` actually recognises. */
const RUN_STATUS_FILTER_OPTIONS = [
  { label: "any outcome", value: "" },
  { label: "succeeded", value: "succeeded" },
  { label: "succeeded with gaps", value: "succeeded_with_gaps" },
  { label: "failed", value: "failed" },
  { label: "cancelled", value: "cancelled" },
  { label: "in progress", value: "in_progress" },
] as const;

/**
 * Source filter options, derived from the SAME bounded connector-summary page
 * the view already renders — not a hardcoded roster, and not connector-specific
 * knowledge held in the console. The reference stays the only authority on
 * which connectors exist; this just projects the identity fields
 * (`connector_id` + `connector_display_name`) it already returned.
 *
 * One option per distinct `connector_id` (a connector with several connections
 * is still one source to filter by), sorted by the label the owner sees. A
 * connector whose current filter value is active but absent from this bounded
 * page is appended, so an in-effect filter is never silently missing from the
 * control that owns it.
 */
function connectorFilterOptions(
  connectors: readonly { connector_display_name?: string; connector_id: string }[],
  activeConnectorId: string | undefined
) {
  const byConnectorId = new Map<string, string>();
  for (const connector of connectors) {
    if (!byConnectorId.has(connector.connector_id)) {
      byConnectorId.set(connector.connector_id, connector.connector_display_name || connector.connector_id);
    }
  }
  if (activeConnectorId && !byConnectorId.has(activeConnectorId)) {
    byConnectorId.set(activeConnectorId, activeConnectorId);
  }
  const options = [...byConnectorId.entries()]
    .map(([value, label]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return options.length > 0 ? [{ label: "any source", value: "" }, ...options] : [];
}

function runListQuery(params: Params) {
  return {
    connector_id: params.connector_id || undefined,
    cursor: params.run_cursor || undefined,
    limit: SYNCS_OVERVIEW_RUN_LIMIT,
    status: params.status || undefined,
  };
}

function isLiveRun(run: RunSummary): boolean {
  return !["cancelled", "completed", "deferred", "failed", "rejected", "succeeded"].includes(run.status);
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  if (params.peek) {
    redirect(dashboardRoutes.run(params.peek));
  }

  // Dev/screenshot affordance: `?demo=...` renders a deterministic seeded model
  // (incl. a source-pressure WAIT card and a genuine reconnect card) so the
  // honesty of the copy is reviewable without a live throttled connection. The
  // real data path is never touched when `demo` is absent.
  if (params.demo) {
    return (
      <RecordroomShellWithPalette>
        <SyncsView model={DEMO_SYNCS_MODEL} seeded />
      </RecordroomShellWithPalette>
    );
  }

  const pageState = parseConnectorSummaryPageState(params);
  let runsResult: ListResponse<RunSummary>;
  let connectorsPage: Awaited<ReturnType<typeof fetchSyncsConnectorsPage>>;
  try {
    [runsResult, connectorsPage] = await Promise.all([
      listRuns(runListQuery(params)),
      fetchSyncsConnectorsPage(pageState),
    ]);
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

  if (connectorsPage.kind === "error") {
    return (
      <RecordroomShellWithPalette>
        <ConnectorSummaryPageError basePath={SYNCS_PATH} currentParams={params} message={connectorsPage.message} />
      </RecordroomShellWithPalette>
    );
  }

  const model = buildSyncsViewModel({
    connectors: connectorsPage.items,
    runs: runsResult.data,
  });

  const liveRunCount = runsResult.data.filter(isLiveRun).length;

  return (
    <RecordroomShellWithPalette>
      <LivePoller enabled={liveRunCount > 0} />
      <SyncsView
        model={model}
        recentSyncsPaging={{
          connectorOptions: connectorFilterOptions(connectorsPage.items, params.connector_id),
          hasMore: runsResult.has_more,
          isPaged: Boolean(params.run_cursor),
          nextCursor: runsResult.next_cursor,
          params,
          statusOptions: RUN_STATUS_FILTER_OPTIONS,
        }}
      />
      <ConnectorSummaryPager
        basePath={SYNCS_PATH}
        currentParams={params}
        hasMore={connectorsPage.hasMore}
        isPaged={isPagedRequest(pageState)}
        nextCursor={connectorsPage.nextCursor}
      />
    </RecordroomShellWithPalette>
  );
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Syncs — the Recordroom reskin of the Runs route.
 *
 * Health-first: this surface answers "what was recently collected, and what (in
 * plain English) needs my hand?" It fuses three real reference contracts:
 *   - `_ref/runs`       → the runs feed, for per-connection Rhythm + last result
 *   - `_ref/connectors` → per-connection health + schedule + stream list
 * via the pure {@link buildSyncsViewModel}, then renders the {@link SyncsView}
 * (Ink Carbon kit) inside the {@link RecordroomShell}.
 *
 * The route, its `?peek=` deep-link redirect, and the `listRuns` fetch are
 * preserved (a held invariant: the peek redirect must run before any fetch and
 * the page must never pull an inline run timeline).
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
import { ServerUnreachable } from "../components/shell.tsx";
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
  status?: string;
  [key: string]: string | undefined;
}

function fetchSyncsConnectorsPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  return loadConnectorSummaryPage(pageState, (opts) => listConnectorSummaries(opts));
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
      listRuns({ limit: SYNCS_OVERVIEW_RUN_LIMIT }),
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
      <SyncsView model={model} />
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

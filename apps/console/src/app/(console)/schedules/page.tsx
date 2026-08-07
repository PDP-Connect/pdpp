// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { SchedulesView } from "@pdpp/operator-ui/components/views/schedules-view";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPageError,
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "../components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "../components/connector-summary-pager.ts";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { listConnectorSummaries } from "../lib/ref-client.ts";
import { ScheduleRow } from "./schedule-row.tsx";
import { SchedulesPoller } from "./schedules-poller.tsx";

const SCHEDULES_PATH = "/schedules";

export const dynamic = "force-dynamic";

function fetchSchedulesPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  return loadConnectorSummaryPage(pageState, (opts) => listConnectorSummaries(opts));
}

export default async function SchedulesPage({ searchParams }: { searchParams?: Promise<{ page_cursor?: string }> }) {
  const params = searchParams ? await searchParams : {};
  const pageState = parseConnectorSummaryPageState(params);

  let page: Awaited<ReturnType<typeof fetchSchedulesPage>>;
  try {
    page = await fetchSchedulesPage(pageState);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Schedules" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (page.kind === "error") {
    return (
      <RecordroomShellWithPalette>
        <PageHeader title="Schedules" />
        <ConnectorSummaryPageError basePath={SCHEDULES_PATH} currentParams={params} message={page.message} />
      </RecordroomShellWithPalette>
    );
  }

  const summaries = page.items;
  const hasActiveRun = summaries.some(
    (s) => typeof s.schedule?.active_run_id === "string" && s.schedule.active_run_id.length > 0
  );

  return (
    <RecordroomShellWithPalette>
      <SchedulesPoller enabled={hasActiveRun} />
      <SchedulesView
        description="Set automatic refresh cadences for your connectors. Keep high-friction ones (banks, browser-based) manual or infrequent."
        renderRow={(summary) => (
          <ScheduleRow
            key={summary.connection_id ?? summary.connector_instance_id ?? summary.connector_id}
            runsHref="/syncs"
            summary={summary}
          />
        )}
        scheduledEmptyHint="Use the buttons below to add a schedule to any connector."
        summaries={[...summaries]}
        unscheduledDescription="These connectors run only when you ask. Use 'Set schedule' to add a cadence, or sync manually from the Records page."
      />
      <ConnectorSummaryPager
        basePath={SCHEDULES_PATH}
        currentParams={params}
        hasMore={page.hasMore}
        isPaged={isPagedRequest(pageState)}
        nextCursor={page.nextCursor}
      />
    </RecordroomShellWithPalette>
  );
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { SchedulesView } from "@pdpp/operator-ui/components/views/schedules-view";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { listConnectorSummaries, type RefConnectorSummary } from "../lib/ref-client.ts";
import { ScheduleRow } from "./schedule-row.tsx";
import { SchedulesPoller } from "./schedules-poller.tsx";

export const dynamic = "force-dynamic";

export default async function SchedulesPage() {
  let summaries: RefConnectorSummary[];
  try {
    const response = await listConnectorSummaries();
    summaries = response.data;
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

  const hasActiveRun = summaries.some((s) => s.schedule?.active_run_id !== null);

  return (
    <RecordroomShellWithPalette>
      <SchedulesPoller enabled={hasActiveRun} />
      <SchedulesView
        description="Set automatic refresh cadences for your connectors. High-friction connectors (banks, browser-based) should be kept manual or low-frequency."
        // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
        renderRow={(summary) => (
          <ScheduleRow
            key={summary.connection_id ?? summary.connector_instance_id ?? summary.connector_id}
            runsHref="/syncs"
            summary={summary}
          />
        )}
        scheduledEmptyHint="Use the buttons below to add a schedule to any connector."
        summaries={summaries}
        unscheduledDescription="These connectors have no automatic schedule. Use 'Set schedule' to add one, or sync manually from the Records page."
      />
    </RecordroomShellWithPalette>
  );
}

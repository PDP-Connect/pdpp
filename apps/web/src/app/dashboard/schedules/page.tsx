import { PageHeader } from "../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { SchedulesView } from "../components/views/schedules-view.tsx";
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
        <DashboardShell active="schedules">
          <PageHeader title="Schedules" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const hasActiveRun = summaries.some((s) => s.schedule?.active_run_id != null);

  return (
    <DashboardShell active="schedules">
      <SchedulesPoller enabled={hasActiveRun} />
      <SchedulesView
        description="Set automatic refresh cadences for your connectors. High-friction connectors (banks, browser-based) should be kept manual or low-frequency."
        renderRow={(summary) => (
          <ScheduleRow
            key={summary.connection_id ?? summary.connector_instance_id ?? summary.connector_id}
            runsHref="/dashboard/runs"
            summary={summary}
          />
        )}
        scheduledEmptyHint="Use the buttons below to add a schedule to any connector."
        summaries={summaries}
        unscheduledDescription="These connectors have no automatic schedule. Use 'Set schedule' to add one, or sync manually from the Records page."
      />
    </DashboardShell>
  );
}

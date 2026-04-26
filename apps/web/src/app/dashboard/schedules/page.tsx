import { DataList, PageHeader, Section } from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
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
        <DashboardShell active="records">
          <PageHeader title="Schedules" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const withSchedule = summaries.filter((s) => s.schedule != null);
  const unscheduled = summaries.filter((s) => s.schedule == null);
  const hasActiveRun = summaries.some((s) => s.schedule?.active_run_id != null);
  const needsHumanCount = summaries.filter((s) => s.schedule?.human_attention_needed).length;

  return (
    <DashboardShell active="records">
      <SchedulesPoller enabled={hasActiveRun} />
      <PageHeader
        count={`${withSchedule.length} scheduled · ${unscheduled.length} unscheduled`}
        description="Set automatic refresh cadences for your connectors. High-friction connectors (banks, browser-based) should be kept manual or low-frequency."
        title="Schedules"
      />

      {needsHumanCount > 0 && (
        <div className="pdpp-caption mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <strong>
            {needsHumanCount} connector{needsHumanCount === 1 ? "" : "s"} need human attention.
          </strong>{" "}
          Automatic runs are paused until you run them manually and provide the required input.
        </div>
      )}

      <Section title={`Scheduled connectors (${withSchedule.length})`}>
        {withSchedule.length === 0 ? (
          <EmptyState
            hint="Use the buttons below to add a schedule to any connector."
            title="No scheduled connectors yet"
          />
        ) : (
          <DataList>
            {withSchedule.map((s) => (
              <ScheduleRow key={s.connector_id} runsHref="/dashboard/runs" summary={s} />
            ))}
          </DataList>
        )}
      </Section>

      {unscheduled.length > 0 && (
        <Section
          description="These connectors have no automatic schedule. Use 'Set schedule' to add one, or sync manually from the Records page."
          title={`Unscheduled connectors (${unscheduled.length})`}
        >
          <DataList>
            {unscheduled.map((s) => (
              <ScheduleRow key={s.connector_id} runsHref="/dashboard/runs" summary={s} />
            ))}
          </DataList>
        </Section>
      )}
    </DashboardShell>
  );
}

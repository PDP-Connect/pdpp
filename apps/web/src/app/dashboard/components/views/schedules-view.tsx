import type { ReactNode } from "react";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { RefConnectorSummary } from "../../lib/ref-client.ts";
import { DataList, PageHeader, Section } from "../primitives.tsx";
import { EmptyState } from "../shell.tsx";

export interface SchedulesViewProps {
  description: string;
  readOnlyNotice?: ReactNode;
  renderRow: (summary: RefConnectorSummary) => ReactNode;
  scheduledEmptyHint?: string;
  summaries: RefConnectorSummary[];
  unscheduledDescription: string;
}

export function SchedulesView({
  description,
  readOnlyNotice,
  renderRow,
  scheduledEmptyHint,
  summaries,
  unscheduledDescription,
}: SchedulesViewProps) {
  const withSchedule = summaries.filter((s) => s.schedule != null);
  const unscheduled = summaries.filter((s) => s.schedule == null);
  const needsHumanCount = summaries.filter((s) => s.schedule?.human_attention_needed).length;

  return (
    <>
      <PageHeader
        count={`${withSchedule.length} scheduled · ${unscheduled.length} unscheduled`}
        description={description}
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

      {readOnlyNotice}

      <Section title={`Scheduled connectors (${withSchedule.length})`}>
        {withSchedule.length === 0 ? (
          <EmptyState hint={scheduledEmptyHint} title="No scheduled connectors yet" />
        ) : (
          <DataList>{withSchedule.map((summary) => renderRow(summary))}</DataList>
        )}
      </Section>

      {unscheduled.length > 0 && (
        <Section description={unscheduledDescription} title={`Unscheduled connectors (${unscheduled.length})`}>
          <DataList>{unscheduled.map((summary) => renderRow(summary))}</DataList>
        </Section>
      )}
    </>
  );
}

export function ScheduleReadRow({ summary }: { summary: RefConnectorSummary }) {
  const { connector_id, display_name, schedule, last_successful_run } = summary;
  return (
    <li>
      <div className="flex flex-col gap-1 px-3 py-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0 flex-1">
            <span className="pdpp-body font-medium text-foreground">{display_name || connector_id}</span>
            <div className="pdpp-caption mt-0.5 truncate font-mono text-muted-foreground">{connector_id}</div>
          </div>
          {schedule && (
            <div className="pdpp-caption shrink-0 text-muted-foreground">
              every {formatInterval(schedule.interval_seconds)}
              {schedule.enabled ? "" : " · paused"}
            </div>
          )}
        </div>
        {last_successful_run && (
          <div className="pdpp-caption text-muted-foreground">
            Last success: <Timestamp value={last_successful_run.last_at} />
          </div>
        )}
      </div>
    </li>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86_400)}d`;
}

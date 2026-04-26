/**
 * Mock-owner schedules page.
 *
 * Read-only view of the demo connector schedules. No mutations — sandbox
 * connectors have no live AS/RS to schedule against.
 */

import { DataList, PageHeader, Section } from "@/app/dashboard/components/primitives.tsx";
import { DashboardShell, EmptyState } from "@/app/dashboard/components/shell.tsx";
import type { RefConnectorSummary } from "@/app/dashboard/lib/ref-client.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-static";

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

function ScheduleReadRow({ summary }: { summary: RefConnectorSummary }) {
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

export default async function SandboxSchedulesPage() {
  const ds = sandboxDashboardDataSource;
  const { data: summaries } = await ds.listConnectorSummaries();

  const withSchedule = summaries.filter((s) => s.schedule != null);
  const unscheduled = summaries.filter((s) => s.schedule == null);

  return (
    <DashboardShell active="schedules" mode="mock-owner">
      <PageHeader
        count={`${withSchedule.length} scheduled · ${unscheduled.length} unscheduled`}
        description="Reference instance schedules. In the live dashboard, owners can set automatic refresh cadences per connector."
        title="Schedules"
      />

      <div className="pdpp-caption mb-6 rounded border border-border/80 bg-muted/40 px-4 py-3 text-muted-foreground">
        Read-only in mock-owner mode. To configure schedules, connect a live reference instance on the{" "}
        <span className="font-medium text-foreground">live dashboard</span>.
      </div>

      <Section title={`Scheduled connectors (${withSchedule.length})`}>
        {withSchedule.length === 0 ? (
          <EmptyState title="No scheduled connectors" />
        ) : (
          <DataList>
            {withSchedule.map((s) => (
              <ScheduleReadRow key={s.connector_id} summary={s} />
            ))}
          </DataList>
        )}
      </Section>

      {unscheduled.length > 0 && (
        <Section
          description="These connectors have no automatic schedule in the reference dataset."
          title={`Unscheduled connectors (${unscheduled.length})`}
        >
          <DataList>
            {unscheduled.map((s) => (
              <ScheduleReadRow key={s.connector_id} summary={s} />
            ))}
          </DataList>
        </Section>
      )}
    </DashboardShell>
  );
}

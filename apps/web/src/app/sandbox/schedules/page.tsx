/**
 * Mock-owner schedules page.
 *
 * Read-only view of the demo connector schedules. No mutations — sandbox
 * connectors have no live AS/RS to schedule against.
 */

import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { ScheduleReadRow, SchedulesView } from "@/app/dashboard/components/views/schedules-view.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-static";

export default async function SandboxSchedulesPage() {
  const ds = sandboxDashboardDataSource;
  const { data: summaries } = await ds.listConnectorSummaries();

  return (
    <DashboardShell active="schedules" mode="mock-owner">
      <SchedulesView
        description="Reference instance schedules. In the live dashboard, owners can set automatic refresh cadences per connector."
        readOnlyNotice={
          <div className="pdpp-caption mb-6 rounded border border-border/80 bg-muted/40 px-4 py-3 text-muted-foreground">
            Read-only in mock-owner mode. To configure schedules, connect a live reference instance on the{" "}
            <span className="font-medium text-foreground">live dashboard</span>.
          </div>
        }
        renderRow={(summary) => <ScheduleReadRow key={summary.connector_id} summary={summary} />}
        summaries={summaries}
        unscheduledDescription="These connectors have no automatic schedule in the reference dataset."
      />
    </DashboardShell>
  );
}

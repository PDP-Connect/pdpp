/**
 * Mock-owner schedules page.
 *
 * Read-only view of the sandbox connector schedules. Live instances expose
 * the same cadence model with owner-write controls.
 */

import { ScheduleReadRow, SchedulesView } from "@pdpp/operator-ui/components/views/schedules-view";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
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
            Schedule controls appear on live reference instances. This profile shows the cadence model and connector
            defaults.
          </div>
        }
        renderRow={(summary) => <ScheduleReadRow key={summary.connector_id} summary={summary} />}
        summaries={summaries}
        unscheduledDescription="These connectors have no automatic schedule in the reference dataset."
      />
    </DashboardShell>
  );
}

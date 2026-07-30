// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

// Mirrors the live reference's own connector-summary page-size ceiling
// (`CONNECTOR_SUMMARY_PAGE_LIMIT_MAX`) — an explicit, bounded request, never
// the bare unparameterized call the gate flagged as the one remaining
// first-party bare-call offender.
const SANDBOX_CONNECTOR_SUMMARY_PAGE_LIMIT = 100;

export default async function SandboxSchedulesPage() {
  const ds = sandboxDashboardDataSource;
  const { data: summaries } = await ds.listConnectorSummaries({ limit: SANDBOX_CONNECTOR_SUMMARY_PAGE_LIMIT });

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

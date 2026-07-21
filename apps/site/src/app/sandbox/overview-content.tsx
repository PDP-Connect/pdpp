/**
 * Mock-owner dashboard overview content.
 *
 * `/sandbox` and the compatibility `/sandbox/overview` route both render this
 * content so the sandbox entrypoint is the dashboard, not a tutorial fork.
 */

import { OverviewView, type OverviewViewData } from "@pdpp/operator-ui/components/views/overview-view";
import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { sandboxDashboardDataSource } from "./_demo/data-source.ts";

async function loadOverview(): Promise<OverviewViewData> {
  const ds = sandboxDashboardDataSource;
  const [summary, failedTraces, failedRuns, revoked, denied, issued, recentRuns] = await Promise.all([
    ds.getDatasetSummary(),
    ds.listTraces({ status: "failed", limit: 5 }),
    ds.listRuns({ status: "failed", limit: 5 }),
    ds.listGrants({ status: "revoked", limit: 5 }),
    ds.listGrants({ status: "denied", limit: 5 }),
    ds.listGrants({ status: "issued", limit: 5 }),
    ds.listRuns({ limit: 8 }),
  ]);
  const recentDecisions = [...revoked.data, ...denied.data, ...issued.data]
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
    .slice(0, 6);
  return {
    summary,
    failedTraces: failedTraces.data,
    failedRuns: failedRuns.data,
    recentDecisions,
    recentRuns: recentRuns.data,
    actionNeeded: failedTraces.data.length + failedRuns.data.length,
  };
}

export async function SandboxOverviewContent() {
  const data = await loadOverview();
  return (
    <DashboardShell active="overview" mode="mock-owner">
      <OverviewView
        data={data}
        description="A local-first operator console for the PDPP reference stack, rendered against deterministic mock AS/RS data."
        routes={sandboxRoutes}
      />
    </DashboardShell>
  );
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    ds.listTraces({ limit: 5, status: "failed" }),
    ds.listRuns({ limit: 5, status: "failed" }),
    ds.listGrants({ limit: 5, status: "revoked" }),
    ds.listGrants({ limit: 5, status: "denied" }),
    ds.listGrants({ limit: 5, status: "issued" }),
    ds.listRuns({ limit: 8 }),
  ]);
  const recentDecisions = [...revoked.data, ...denied.data, ...issued.data]
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
    .slice(0, 6);
  return {
    actionNeeded: failedTraces.data.length + failedRuns.data.length,
    failedRuns: failedRuns.data,
    failedTraces: failedTraces.data,
    recentDecisions,
    recentRuns: recentRuns.data,
    summary,
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

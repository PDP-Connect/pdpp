/**
 * Mock-owner dashboard overview.
 *
 * Same overview the live `/dashboard` operator sees, rendered against the
 * deterministic sandbox data source. Reuses the live shell in mock-owner
 * mode so the visitor's experience is the dashboard, not a tutorial fork.
 */

import type { Metadata } from "next";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { OverviewView, type OverviewViewData } from "@/app/dashboard/components/views/overview-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const metadata: Metadata = {
  title: "PDPP reference instance · Overview",
  description: "Overview of the PDPP reference dashboard, bound to deterministic mock AS/RS data.",
};

export const dynamic = "force-static";

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

export default async function SandboxOverviewPage() {
  const data = await loadOverview();
  return (
    <DashboardShell active="overview" mode="mock-owner">
      <OverviewView
        data={data}
        description="A local-first operator console for the PDPP reference stack. Inspect traces, grants, runs, and retained records."
        routes={sandboxRoutes}
      />
    </DashboardShell>
  );
}

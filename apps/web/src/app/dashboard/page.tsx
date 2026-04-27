import { PageHeader } from "./components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "./components/shell.tsx";
import { OverviewView, type OverviewViewData } from "./components/views/overview-view.tsx";
import { dashboardRoutes } from "./components/views/routes.ts";
import { liveDashboardDataSource } from "./lib/data-source.ts";
import { ReferenceServerUnreachableError } from "./lib/owner-token.ts";

export const dynamic = "force-dynamic";

async function loadOverview(): Promise<OverviewViewData> {
  const ds = liveDashboardDataSource;
  // Scale first. Then the things that need attention: failed traces/runs
  // and recently-decided grants. Recent runs support "what's happening now".
  const [summary, failedTraces, failedRuns, revokedGrants, deniedGrants, issuedGrants, recentRuns] = await Promise.all([
    ds.getDatasetSummary(),
    ds.listTraces({ status: "failed", limit: 5 }),
    ds.listRuns({ status: "failed", limit: 5 }),
    ds.listGrants({ status: "revoked", limit: 5 }),
    ds.listGrants({ status: "denied", limit: 5 }),
    ds.listGrants({ status: "issued", limit: 5 }),
    ds.listRuns({ limit: 8 }),
  ]);

  const recentDecisions = [...revokedGrants.data, ...deniedGrants.data, ...issuedGrants.data]
    .sort((a, b) => {
      if (a.last_at < b.last_at) {
        return 1;
      }
      if (a.last_at > b.last_at) {
        return -1;
      }
      return 0;
    })
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

export default async function DashboardPage() {
  let data: OverviewViewData;
  try {
    data = await loadOverview();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="overview">
          <PageHeader title="Overview" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  return (
    <DashboardShell active="overview">
      <OverviewView
        data={data}
        description="A local-first operator console for the PDPP reference stack. Inspect traces, grants, runs, and retained records."
        routes={dashboardRoutes}
      />
    </DashboardShell>
  );
}

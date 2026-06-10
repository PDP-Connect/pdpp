import { OverviewHero, OverviewHeroError, OverviewHeroPlaceholder } from "@pdpp/operator-ui/components/overview-hero";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import {
  AttentionOverview,
  type AttentionOverviewData,
  AttentionOverviewError,
  AttentionOverviewPlaceholder,
  RecentActivityError,
  RecentActivityOverview,
  type RecentActivityOverviewData,
  RecentActivityPlaceholder,
} from "@pdpp/operator-ui/components/views/overview-view";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { Suspense } from "react";
import { DashboardShell } from "./components/shell.tsx";
import { WebPushSettings } from "./components/web-push-settings.tsx";
import { liveDashboardDataSource } from "./lib/data-source.ts";
import { getWebPushConfig, listWebPushSubscriptions } from "./lib/ref-client.ts";

export const dynamic = "force-dynamic";

function loadDashboardSummary() {
  return liveDashboardDataSource.getDatasetSummary();
}

async function loadAttentionSummary(): Promise<AttentionOverviewData> {
  const ds = liveDashboardDataSource;
  const [failedTraces, failedRuns] = await Promise.all([
    ds.listTraces({ status: "failed", limit: 5 }),
    ds.listRuns({ status: "failed", limit: 5 }),
  ]);
  return {
    failedTraces: failedTraces.data,
    failedRuns: failedRuns.data,
    actionNeeded: failedTraces.data.length + failedRuns.data.length,
  };
}

async function loadRecentActivity(): Promise<RecentActivityOverviewData> {
  const ds = liveDashboardDataSource;
  const [revokedGrants, deniedGrants, issuedGrants, recentRuns] = await Promise.all([
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
    recentDecisions,
    recentRuns: recentRuns.data,
  };
}

async function DatasetSummarySection() {
  try {
    const summary = await loadDashboardSummary();
    return (
      <OverviewHero
        addSourceHref={dashboardRoutes.section.connect}
        exploreHref={dashboardRoutes.section.explore}
        recordsHref={dashboardRoutes.section.records}
        summary={summary}
      />
    );
  } catch (err) {
    return <OverviewHeroError message={err instanceof Error ? err.message : undefined} />;
  }
}

async function AttentionSection() {
  try {
    const data = await loadAttentionSummary();
    return <AttentionOverview data={data} routes={dashboardRoutes} />;
  } catch {
    return <AttentionOverviewError />;
  }
}

async function RecentActivitySection() {
  try {
    const data = await loadRecentActivity();
    return <RecentActivityOverview data={data} routes={dashboardRoutes} />;
  } catch {
    return <RecentActivityError />;
  }
}

async function WebPushSettingsSection() {
  try {
    const [webPush, subscriptions] = await Promise.all([getWebPushConfig(), listWebPushSubscriptions()]);
    return <WebPushSettings config={webPush} subscriptions={subscriptions.data} />;
  } catch {
    return null;
  }
}

export default function DashboardPage() {
  return (
    <DashboardShell active="overview">
      <PageHeader
        description="A local-first operator console for the PDPP reference stack. Inspect traces, grants, runs, and retained records."
        title="Overview"
      />
      <Suspense fallback={<OverviewHeroPlaceholder />}>
        <DatasetSummarySection />
      </Suspense>
      <Suspense fallback={<AttentionOverviewPlaceholder />}>
        <AttentionSection />
      </Suspense>
      <Suspense fallback={<RecentActivityPlaceholder />}>
        <RecentActivitySection />
      </Suspense>
      <Suspense fallback={null}>
        <WebPushSettingsSection />
      </Suspense>
    </DashboardShell>
  );
}

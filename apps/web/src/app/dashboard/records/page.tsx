import Link from "next/link";
import { buttonVariants } from "@/components/ui/button.tsx";
import { DataList, PageHeader, Section } from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { listConnectorSummaries, type RefConnectorRunSummary, type RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorOverview } from "../lib/rs-client.ts";
import { ConnectorRow } from "./connector-row.tsx";
import { RecordsPagePoller } from "./records-page-poller.tsx";

export const dynamic = "force-dynamic";

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

function connectorSortKey(o: ConnectorOverview): [number, number, string] {
  // Primary sort: by urgency. Failed first, then running, then stale
  // (never-run ranks as infinitely stale), then fresh.
  // Secondary sort: oldest last-sync first within each band, so
  // attention flows toward the thing most overdue.
  if (o.lastRun?.status === "failed") {
    return [0, 0, o.connector.connector_id];
  }
  if (o.isRunning) {
    return [1, 0, o.connector.connector_id];
  }
  const lastTs = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
  if (!lastTs) {
    return [2, 0, o.connector.connector_id]; // never run
  }
  return [3, lastTs, o.connector.connector_id];
}

function toConnectorRunRef(summary: RefConnectorRunSummary | null) {
  if (!summary) {
    return null;
  }
  return {
    run_id: summary.run_id,
    first_at: summary.first_at,
    last_at: summary.last_at,
    event_count: summary.event_count,
    status: summary.status,
    failure_reason: summary.failure_reason,
    known_gaps: summary.known_gaps ?? [],
  };
}

function toConnectorOverview(summary: RefConnectorSummary): ConnectorOverview {
  const lastRun = toConnectorRunRef(summary.last_run);
  const lastSuccessfulRun = toConnectorRunRef(summary.last_successful_run);
  return {
    connector: {
      connector_id: summary.connector_id,
      display_name: summary.display_name,
      name: summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    },
    streams: summary.streams.map((name) => ({
      object: "stream",
      name,
      record_count: 0,
      last_updated: null,
    })),
    totalRecords: summary.total_records,
    lastRun,
    lastSuccessfulRun,
    isRunning: lastRun != null && new Set(["started", "in_progress"]).has(lastRun.status),
  };
}

export default async function RecordsIndexPage() {
  let overviews: ConnectorOverview[];
  try {
    const response = await listConnectorSummaries();
    overviews = response.data.map(toConnectorOverview);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Records" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const withData = overviews.filter((o) => o.totalRecords > 0 || o.lastRun);
  const empty = overviews.filter((o) => o.totalRecords === 0 && !o.lastRun && !o.error);

  // Sort the primary list by urgency (failed/running/stale/fresh).
  const sorted = [...withData].sort((a, b) => {
    const [ak, at, an] = connectorSortKey(a);
    const [bk, bt, bn] = connectorSortKey(b);
    if (ak !== bk) {
      return ak - bk;
    }
    if (at !== bt) {
      return at - bt;
    }
    return an.localeCompare(bn);
  });

  const totalRecords = withData.reduce((sum, o) => sum + o.totalRecords, 0);
  const totalStreams = withData.reduce((sum, o) => sum + o.streams.length, 0);

  const now = Date.now();
  const runningCount = withData.filter((o) => o.isRunning).length;
  const failedCount = withData.filter((o) => o.lastRun?.status === "failed").length;
  const syncedRecently = withData.filter((o) => {
    const ts = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
    return ts && now - ts < RECENT_MS;
  }).length;
  const staleCount = withData.filter((o) => {
    const ts = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
    return ts > 0 && now - ts > STALE_MS;
  }).length;
  const noRunHistory = withData.filter((o) => !o.lastRun && o.totalRecords > 0).length;

  return (
    <DashboardShell active="records">
      <RecordsPagePoller enabled={runningCount > 0} />
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records/timeline">
            Activity timeline →
          </Link>
        }
        count={`${totalRecords.toLocaleString()} records · ${totalStreams} streams · ${withData.length} connectors`}
        description="Owner control plane for your connectors. Click Sync now to pull fresh data; drill in to browse streams and records."
        title="Records"
      />

      {/* Vital signs strip — substrate, not decoration. */}
      <section aria-label="Connector health summary" className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <HealthStat label="Connectors" tone="neutral" value={withData.length.toLocaleString()} />
        <HealthStat
          label="Synced last 24h"
          tone={syncedRecently > 0 ? "success" : "neutral"}
          value={syncedRecently.toLocaleString()}
        />
        <HealthStat
          label={freshnessLabel(staleCount, noRunHistory)}
          tone={staleCount > 0 || noRunHistory > 0 ? "warning" : "neutral"}
          value={(staleCount || noRunHistory || 0).toLocaleString()}
        />
        <HealthStat
          label={activityLabel(failedCount, runningCount)}
          tone={activityTone(failedCount, runningCount)}
          value={(failedCount || runningCount || 0).toLocaleString()}
        />
      </section>

      <Section title={`Connectors (${withData.length})`}>
        {withData.length === 0 ? (
          <EmptyState
            hint="Click Sync now on a connector below to pull your first records."
            title="No data ingested yet"
          />
        ) : (
          <DataList>
            {sorted.map((o) => (
              <ConnectorRow key={o.connector.connector_id} overview={o} runsHref="/dashboard/runs" />
            ))}
          </DataList>
        )}
      </Section>

      {empty.length > 0 && (
        <Section
          description="These connectors are registered and can be synced. Click Sync now to pull initial data."
          title={`Registered but never run (${empty.length})`}
        >
          <DataList>
            {empty.map((o) => (
              <ConnectorRow key={o.connector.connector_id} overview={o} runsHref="/dashboard/runs" />
            ))}
          </DataList>
        </Section>
      )}
    </DashboardShell>
  );
}

type HealthStatTone = "neutral" | "success" | "warning" | "danger" | "active";

const HEALTH_STAT_TONE_CLASSES: Record<HealthStatTone, string> = {
  success: "text-emerald-600",
  warning: "text-amber-600",
  danger: "text-destructive",
  active: "text-blue-600",
  neutral: "text-foreground",
};

function freshnessLabel(stale: number, noRunHistory: number): string {
  if (stale > 0) {
    return "Stale >7d";
  }
  if (noRunHistory > 0) {
    return "No run history";
  }
  return "All fresh";
}

function activityLabel(failed: number, running: number): string {
  if (failed > 0) {
    return "Failing";
  }
  if (running > 0) {
    return "Running";
  }
  return "Idle";
}

function activityTone(failed: number, running: number): HealthStatTone {
  if (failed > 0) {
    return "danger";
  }
  if (running > 0) {
    return "active";
  }
  return "neutral";
}

function HealthStat({ label, value, tone }: { label: string; value: string; tone: HealthStatTone }) {
  const toneClass = HEALTH_STAT_TONE_CLASSES[tone];
  return (
    <div className="flex flex-col gap-1 border-border/60 border-l-2 pl-3">
      <span className="pdpp-caption text-muted-foreground">{label}</span>
      <span className={`pdpp-heading tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

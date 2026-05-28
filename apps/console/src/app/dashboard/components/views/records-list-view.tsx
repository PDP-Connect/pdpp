/**
 * Shared records-index view used by /dashboard/records and /sandbox/records.
 *
 * The page fetches connector summaries via its data source, projects them
 * to ConnectorOverview, and passes them in. The view computes the urgency
 * sort, the vital-signs strip, and renders connector rows.
 *
 * The sandbox page passes `interactive: false` so the row's Sync-now
 * button is replaced by a non-mutating "View" link to the connector
 * detail. The live page passes `interactive: true` and keeps the
 * existing client-component ConnectorRow with its server action.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { shouldShowInPrimaryConnections } from "../../lib/records-list-classification.ts";
import type { RefRecordVersionStatsRow } from "../../lib/ref-client.ts";
import type { ConnectorOverview, ConnectorRunRef } from "../../lib/rs-client.ts";
import { ConnectorRow } from "../../records/connector-row.tsx";
import { DataList, PageHeader, Section } from "../primitives.tsx";
import { EmptyState } from "../shell.tsx";
import type { Routes } from "./routes.ts";

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

function connectorSortKey(o: ConnectorOverview): [number, number, string] {
  const key = o.connectionId ?? o.connectorInstanceId ?? o.connector.connector_id;
  if (o.lastRun?.status === "failed") {
    return [0, 0, key];
  }
  if (o.isRunning) {
    return [1, 0, key];
  }
  const lastTs = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
  if (!lastTs) {
    return [2, 0, key];
  }
  return [3, lastTs, key];
}

function overviewRouteId(o: ConnectorOverview): string {
  return o.connectionId ?? o.connectorInstanceId ?? o.connector.connector_id;
}

export function RecordsListView({
  overviews,
  routes,
  interactive,
  pendingOnDevices,
  pollerSlot,
  versionChurnRows,
  now: nowOverride,
}: {
  overviews: ConnectorOverview[];
  routes: Routes;
  /** True for live /dashboard, false for sandbox (no Sync now action). */
  interactive: boolean;
  /**
   * Aggregate `records_pending` across all device source instances. The
   * top-line `totalRecords` only reflects records the server has
   * retained, so this number is the honest delta between "ingested" and
   * "captured by a local collector but still on a device". The live
   * page passes this from `/_ref/device-exporters/source-instances`; the
   * sandbox can omit it (defaults to 0).
   */
  pendingOnDevices?: number;
  /** Optional client-side poller; live dashboard injects RecordsPagePoller. */
  pollerSlot?: ReactNode;
  /** Highest-risk stream-level version churn diagnostics from /_ref/records/version-stats. */
  versionChurnRows?: RefRecordVersionStatsRow[];
  /**
   * Reference "now" in epoch ms for the freshness/staleness labels. The live
   * dashboard wants wall-clock time; the sandbox wants its frozen demo clock
   * so seeded `last_at` values do not drift into "Stale" as wall-clock time
   * advances.
   */
  now?: number;
}) {
  const withData = overviews.filter(shouldShowInPrimaryConnections);
  const empty = overviews.filter((o) => !shouldShowInPrimaryConnections(o));
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
  const totalStreams = withData.reduce((sum, o) => sum + (o.streamCount ?? o.streams.length), 0);

  const now = nowOverride ?? Date.now();
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
    <>
      {pollerSlot}
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={routes.section.explore}>
            Open in Explore →
          </Link>
        }
        count={
          pendingOnDevices && pendingOnDevices > 0
            ? `${totalRecords.toLocaleString()} retained records · ${totalStreams} streams · ${withData.length} connections · +${pendingOnDevices.toLocaleString()} pending on devices`
            : `${totalRecords.toLocaleString()} retained records · ${totalStreams} streams · ${withData.length} connections`
        }
        description={
          interactive
            ? "Owner control plane for your connections. Counts reflect records the server has retained; local-collector backlogs surface as 'pending on devices' here and per-connection below. Click Sync now to pull fresh data; drill in to browse streams and records."
            : "Sandbox demo: deterministic mock connections. Click into a connection to browse streams and records."
        }
        title="Connections"
      />

      {versionChurnRows && versionChurnRows.length > 0 ? <VersionChurnNotice rows={versionChurnRows} /> : null}

      <section aria-label="Connection health summary" className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <HealthStat label="Connections" tone="neutral" value={withData.length.toLocaleString()} />
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

      <Section title={`Connections (${withData.length})`}>
        {withData.length === 0 ? (
          <EmptyState
            hint={
              interactive
                ? "Click Sync now on a connection below to pull your first records."
                : "This sandbox has no seeded data."
            }
            title="No data ingested yet"
          />
        ) : (
          <DataList>
            {sorted.map((o) =>
              interactive ? (
                <ConnectorRow key={overviewRouteId(o)} overview={o} runsHref={routes.section.runs} />
              ) : (
                <ReadOnlyConnectorRow key={overviewRouteId(o)} overview={o} routes={routes} />
              )
            )}
          </DataList>
        )}
      </Section>

      {empty.length > 0 ? (
        <Section
          description={
            interactive
              ? "These connections are registered but have no durable progress yet. Click Sync now to pull initial data, or wait for a local-collector device to push its first records."
              : "These mock connections are registered but have no seeded records."
          }
          title={`No data yet (${empty.length})`}
        >
          <DataList>
            {empty.map((o) =>
              interactive ? (
                <ConnectorRow key={overviewRouteId(o)} overview={o} runsHref={routes.section.runs} />
              ) : (
                <ReadOnlyConnectorRow key={overviewRouteId(o)} overview={o} routes={routes} />
              )
            )}
          </DataList>
        </Section>
      ) : null}
    </>
  );
}

function VersionChurnNotice({ rows }: { rows: RefRecordVersionStatsRow[] }) {
  const strongest = rows[0];
  if (!strongest) {
    return null;
  }
  const high = rows.filter((row) => row.risk_level === "high").length;
  const watch = rows.filter((row) => row.risk_level === "watch").length;
  const label = [
    high > 0 ? `${high} high-risk` : null,
    watch > 0 ? `${watch} watch` : null,
  ].filter(Boolean).join(", ");
  return (
    <section
      aria-label="Record version churn diagnostics"
      className="mb-6 border-[color:var(--warning)] border-l-2 bg-[color:var(--warning)]/5 px-4 py-3 text-[color:var(--warning)]"
    >
      <p className="pdpp-body font-medium">Version churn needs review: {label} stream{rows.length === 1 ? "" : "s"}.</p>
      <p className="pdpp-caption mt-1">
        Highest signal: {strongest.display_name ?? strongest.connector_id ?? strongest.connector_instance_id} /{" "}
        {strongest.stream} has {strongest.versions_per_record.toLocaleString()} retained versions per current record.
      </p>
    </section>
  );
}

/** Read-only sandbox row: no Sync now, no client mutation, just navigate. */
function ReadOnlyConnectorRow({ overview, routes }: { overview: ConnectorOverview; routes: Routes }) {
  const { connector, streamCount, totalRecords, streams, lastRun, lastSuccessfulRun } = overview;
  const detailHref = routes.connector(overviewRouteId(overview));
  const displayName = connector.display_name ?? connector.name ?? connector.connector_id;
  const displayedStreamCount = streamCount ?? streams.length;
  return (
    <li>
      <Link
        className="flex flex-col gap-3 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        href={detailHref}
      >
        <div className="min-w-0 flex-1">
          <span className="pdpp-body block font-medium text-foreground">{displayName}</span>
          <span className="pdpp-caption block truncate font-mono text-muted-foreground">{connector.connector_id}</span>
        </div>
        <div className="pdpp-caption flex shrink-0 flex-col gap-0.5 text-muted-foreground tabular-nums sm:items-end sm:text-right">
          <span>
            {totalRecords.toLocaleString()} records · {displayedStreamCount} stream
            {displayedStreamCount === 1 ? "" : "s"}
          </span>
          <RowFreshness lastRun={lastRun} lastSuccessfulRun={lastSuccessfulRun} />
        </div>
      </Link>
    </li>
  );
}

function RowFreshness({
  lastRun,
  lastSuccessfulRun,
}: {
  lastRun: ConnectorRunRef | null;
  lastSuccessfulRun: ConnectorRunRef | null;
}) {
  if (lastSuccessfulRun) {
    return (
      <span>
        last success: <Timestamp value={lastSuccessfulRun.last_at} />
      </span>
    );
  }
  if (lastRun) {
    return (
      <span>
        last attempt: <Timestamp value={lastRun.last_at} /> · {lastRun.status.replace(/_/g, " ")}
      </span>
    );
  }
  return <span>no scheduler run yet</span>;
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
    return "No scheduler run";
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
  return "No active runs";
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

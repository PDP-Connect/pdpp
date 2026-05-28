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
import type { ConnectorOverview, ConnectorRunRef } from "../../lib/rs-client.ts";
import { ConnectorRow } from "../../records/connector-row.tsx";
import { DataList, PageHeader, Section } from "../primitives.tsx";
import { EmptyState } from "../shell.tsx";
import type { Routes } from "./routes.ts";

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sort connections so the most actionable appear first.
 *
 * Priority order (ascending tier = higher urgency):
 *   0  needs_attention — owner action required now
 *   1  blocked         — stuck, cannot make progress
 *   2  run-history failure (no health projection available)
 *   3  degraded        — partial or incomplete coverage
 *   4  active run in progress
 *   5  cooling_off     - in scheduler backoff
 *   6  no last successful run (awaiting first sync)
 *   7  has successful run (older first - to surface potentially-stale connections)
 *
 * Using the health projection as the authoritative source ensures that a
 * blocked connection without a recent failed run (e.g. credential expiry during
 * a long backoff window) still surfaces before healthy connections.
 */
export function connectorSortKey(o: ConnectorOverview): [number, number, string] {
  const key = o.connectionId ?? o.connectorInstanceId ?? o.connector.connector_id;
  const state = o.connectionHealth?.state;
  if (state === "needs_attention") {
    return [0, 0, key];
  }
  if (state === "blocked") {
    return [1, 0, key];
  }
  // Fall back to run-history failure when no health projection is available.
  if (!state && o.lastRun?.status === "failed") {
    return [2, 0, key];
  }
  if (state === "degraded") {
    return [3, 0, key];
  }
  if (o.isRunning || o.connectionHealth?.badges.syncing) {
    return [4, 0, key];
  }
  if (state === "cooling_off") {
    return [5, 0, key];
  }
  const lastTs = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
  if (!lastTs) {
    return [6, 0, key];
  }
  return [7, lastTs, key];
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
  // Active runs: use health projection syncing badge where available so
  // push-mode local collectors (which bypass scheduler runs) are counted.
  const runningCount = withData.filter((o) => o.isRunning || o.connectionHealth?.badges.syncing).length;
  // Needs attention: health-projection-authoritative blocked/needs_attention,
  // with a fallback to run-history failure when no projection is present.
  const needsAttentionCount = withData.filter((o) => {
    const state = o.connectionHealth?.state;
    if (state === "blocked" || state === "needs_attention") {
      return true;
    }
    if (!state && o.lastRun?.status === "failed") {
      return true;
    }
    return false;
  }).length;
  // Stale: prefer the health projection's freshness axis (policy-aware) over
  // a hard 7-day cutoff, but fall back when no projection is present.
  const staleCount = withData.filter((o) => {
    if (o.connectionHealth?.axes) {
      return o.connectionHealth.axes.freshness === "stale";
    }
    const ts = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
    return ts > 0 && now - ts > STALE_MS;
  }).length;

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

      <section aria-label="Connection health summary" className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <HealthStat label="Connections" tone="neutral" value={withData.length.toLocaleString()} />
        <HealthStat
          label="Needs attention"
          tone={needsAttentionCount > 0 ? "danger" : "neutral"}
          value={needsAttentionCount.toLocaleString()}
        />
        <HealthStat
          label="Running"
          tone={runningCount > 0 ? "active" : "neutral"}
          value={runningCount.toLocaleString()}
        />
        <HealthStat label="Stale" tone={staleCount > 0 ? "warning" : "neutral"} value={staleCount.toLocaleString()} />
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

function HealthStat({ label, value, tone }: { label: string; value: string; tone: HealthStatTone }) {
  const toneClass = HEALTH_STAT_TONE_CLASSES[tone];
  return (
    <div className="flex flex-col gap-1 border-border/60 border-l-2 pl-3">
      <span className="pdpp-caption text-muted-foreground">{label}</span>
      <span className={`pdpp-heading tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

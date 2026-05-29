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

/**
 * Assigns ordinal subtitles to unnamed connections that share a connector
 * type. When a user has two Gmail connections but neither has a custom name,
 * both rows would show "Gmail" for both the headline and the subtitle — making
 * them indistinguishable after the raw connectorInstanceId was removed.
 *
 * For each connector type with ≥2 unnamed members, this mutates
 * `connectorDisplayName` to "<TypeName> · connection N" (1-based, sorted
 * stably by connection ID so the ordinal is deterministic across renders).
 * Single unnamed connections and any connection that already has a distinct
 * display name are left untouched.
 */
function labelConnections(overviews: ConnectorOverview[]): ConnectorOverview[] {
  // Group indices by connector_id where the connection is "unnamed"
  // (display_name equals the connector type name, meaning the RI returned no
  // owner-set label).
  const groups = new Map<string, number[]>();
  for (let i = 0; i < overviews.length; i++) {
    const o = overviews[i];
    if (!o) {
      continue;
    }
    const typeName = o.connectorDisplayName ?? o.connector.name ?? o.connector.connector_id;
    const displayName = o.connector.display_name ?? o.connector.name ?? o.connector.connector_id;
    if (displayName === typeName) {
      const key = o.connector.connector_id;
      const group = groups.get(key);
      if (group) {
        group.push(i);
      } else {
        groups.set(key, [i]);
      }
    }
  }

  // Only act on groups with multiple unnamed connections.
  const result = overviews.slice();
  for (const [, indices] of groups) {
    if (indices.length < 2) {
      continue;
    }
    // Stable sort by connection ID so ordinals are deterministic.
    const connectionId = (idx: number): string => {
      const o = overviews[idx];
      return (o?.connectionId ?? o?.connectorInstanceId ?? o?.connector.connector_id) || "";
    };
    const sorted = indices.slice().sort((a, b) => connectionId(a).localeCompare(connectionId(b)));
    for (let rank = 0; rank < sorted.length; rank++) {
      const idx = sorted[rank];
      if (idx === undefined) {
        continue;
      }
      const o = overviews[idx];
      if (!o) {
        continue;
      }
      const typeName = o.connectorDisplayName ?? o.connector.name ?? o.connector.connector_id;
      result[idx] = { ...o, connectorDisplayName: `${typeName} · connection ${rank + 1}` };
    }
  }
  return result;
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
  const labeled = labelConnections(overviews);
  const withData = labeled.filter(shouldShowInPrimaryConnections);
  const empty = labeled.filter((o) => !shouldShowInPrimaryConnections(o));
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
            ? "Manage your connections and monitor sync health. Retained record counts appear here; local-collector backlogs show as 'pending on devices'. Click Sync now to pull fresh data, or open a connection to browse its streams and records."
            : "Sandbox demo: deterministic mock connections. Click into a connection to browse its streams and records."
        }
        title="Connections"
      />

      {versionChurnRows && versionChurnRows.length > 0 ? <VersionChurnNotice rows={versionChurnRows} /> : null}

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

function HealthStat({ label, value, tone }: { label: string; value: string; tone: HealthStatTone }) {
  const toneClass = HEALTH_STAT_TONE_CLASSES[tone];
  return (
    <div className="flex flex-col gap-1 border-border/60 border-l-2 pl-3">
      <span className="pdpp-caption text-muted-foreground">{label}</span>
      <span className={`pdpp-heading tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

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

import { EmptyState } from "@pdpp/operator-ui/components/empty-state";
import { Callout, DataList, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import type { Routes } from "@pdpp/operator-ui/components/views/routes";
import { formatConnectorKeyForDisplay, formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import {
  localCollectorConnectorLabel,
  SUPPORTED_LOCAL_COLLECTOR_CONNECTORS,
  UNSUPPORTED_ADD_MODALITIES,
} from "../../lib/connection-modality.ts";
import { summarizeConnectionHealth } from "../../lib/connection-summary-stats.ts";
import { shouldShowInPrimaryConnections } from "../../lib/records-list-classification.ts";
import type { RefRecordVersionStatsRow } from "../../lib/ref-client.ts";
import type { ConnectorOverview, ConnectorRunRef } from "../../lib/rs-client.ts";
import { buildChurnDrilldownRows, summarizeVersionChurn } from "../../lib/version-churn-summary.ts";
import { ConnectorRow } from "../../records/connector-row.tsx";

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
 * Copy for the zero-primary empty state. When no-data registrations exist they
 * are listed in their own section below; otherwise the instance has no
 * connections at all and we say so plainly (the add-connection guidance then
 * points at the only supported creation path). Sandbox keeps its own copy.
 */
function resolvePrimaryEmptyHint(interactive: boolean, hasNoDataRegistrations: boolean): string {
  if (!interactive) {
    return "This sandbox has no seeded data.";
  }
  if (hasNoDataRegistrations) {
    return "Registered connections with no durable progress yet are listed below. Sync now a scheduled connector, or wait for a local-collector device to push.";
  }
  return "No connections are registered on this instance yet.";
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
    const typeName = formatConnectorNameForDisplay({
      connectorId: o.connector.connector_id,
      displayName: o.connectorDisplayName,
      name: o.connector.name,
    });
    const displayName = formatConnectorNameForDisplay({
      connectorId: o.connector.connector_id,
      displayName: o.connector.display_name,
      name: o.connector.name,
    });
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
      const typeName = formatConnectorNameForDisplay({
        connectorId: o.connector.connector_id,
        displayName: o.connectorDisplayName,
        name: o.connector.name,
      });
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
   * Reference "now" in epoch ms. Historically used to derive staleness from
   * raw `last_at` age; the summary now reads staleness from the health
   * projection's freshness axis instead (unknown freshness is never treated as
   * stale), so this prop is accepted for caller compatibility but unused. The
   * per-row freshness labels resolve their own timestamps.
   */
  now?: number;
}) {
  const labeled = labelConnections(overviews);
  const primaryConnections = labeled.filter(shouldShowInPrimaryConnections);
  const empty = labeled.filter((o) => !shouldShowInPrimaryConnections(o));
  const sorted = [...primaryConnections].sort((a, b) => {
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

  const totalRecords = primaryConnections.reduce((sum, o) => sum + o.totalRecords, 0);
  const totalStreams = primaryConnections.reduce((sum, o) => sum + (o.streamCount ?? o.streams.length), 0);

  // Summary rollup lives in a pure, importable module so the counter behavior
  // is testable without rendering this JSX component. The summary is lossless:
  // degraded / cooling_off / stalled-outbox connections are surfaced in the
  // attention-visible `degraded` bucket rather than silently excluded, so the
  // strip can never read all-zero attention while degraded cards are visible.
  const summary = summarizeConnectionHealth(labeled);
  const needsAttentionCount = summary.needsAttention;
  const degradedCount = summary.degraded;
  const runningCount = summary.running;
  const staleCount = summary.stale;

  // Name the population the count describes. The summary stat uses the
  // registered total; when no-data registrations exist, the hint explains how
  // many connections are currently surfaced in the primary list.
  const connectionsCountLabel =
    summary.noData > 0
      ? `${summary.registeredTotal} registered connections · ${summary.primaryList} listed`
      : `${summary.registeredTotal} connections`;

  const primaryEmptyHint = resolvePrimaryEmptyHint(interactive, empty.length > 0);

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
            ? `${totalRecords.toLocaleString()} retained records · ${totalStreams} streams · ${connectionsCountLabel} · +${pendingOnDevices.toLocaleString()} pending on devices`
            : `${totalRecords.toLocaleString()} retained records · ${totalStreams} streams · ${connectionsCountLabel}`
        }
        description={
          interactive
            ? "Manage your connections and monitor sync health. Retained record counts appear here; local-collector backlogs show as 'pending on devices'. Where a connector supports an owner-triggered pull, Sync now refetches it; otherwise open a connection to browse its streams and records."
            : "Sandbox demo: deterministic mock connections. Click into a connection to browse its streams and records."
        }
        title="Connections"
      />

      {versionChurnRows && versionChurnRows.length > 0 ? <VersionChurnNotice rows={versionChurnRows} /> : null}

      <section aria-label="Connection health summary" className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <HealthStat
          hint={
            summary.noData > 0
              ? `${summary.primaryList.toLocaleString()} listed · ${summary.noData.toLocaleString()} no data yet`
              : undefined
          }
          label="Connections"
          tone="neutral"
          value={summary.registeredTotal.toLocaleString()}
        />
        <HealthStat
          label="Needs attention"
          tone={needsAttentionCount > 0 ? "danger" : "neutral"}
          value={needsAttentionCount.toLocaleString()}
        />
        <HealthStat
          label="Degraded"
          tone={degradedCount > 0 ? "warning" : "neutral"}
          value={degradedCount.toLocaleString()}
        />
        <HealthStat
          label="Running"
          tone={runningCount > 0 ? "active" : "neutral"}
          value={runningCount.toLocaleString()}
        />
        <HealthStat label="Stale" tone={staleCount > 0 ? "warning" : "neutral"} value={staleCount.toLocaleString()} />
      </section>

      <Section title={`Connections (${primaryConnections.length})`}>
        {primaryConnections.length === 0 ? (
          <>
            <EmptyState hint={primaryEmptyHint} title="No data ingested yet" />
            {interactive && empty.length === 0 ? (
              <AddConnectionGuidance deviceExportersHref={routes.section.deviceExporters} />
            ) : null}
          </>
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
              ? "These connections are registered but have no durable progress yet. A scheduled or owner-triggerable connector pulls its first records on Sync now; a local-collector connection fills in when its device pushes."
              : "These mock connections are registered but have no seeded records."
          }
          title={`No data yet (${empty.length})`}
        >
          {interactive ? <AddConnectionGuidance deviceExportersHref={routes.section.deviceExporters} /> : null}
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

/**
 * Honest add-connection entry point.
 *
 * The owner-agent typed connection-intent route now exists
 * (`POST /v1/owner/connections/intents`), but it is owner-*bearer* REST for
 * trusted local agents — a browser owner session has no owner bearer, so the
 * console must not call it. The proven console creation primitive is the
 * cookie-authed local-collector device enrollment at
 * `/dashboard/device-exporters` (`POST /_ref/device-exporters/enrollment-codes`).
 *
 * This entry point gives owners a *real path*, not a dead button: the connectors
 * the reference can create one-click from here (`claude_code`, `codex`) deep-link
 * into the enrollment form pre-selected; the connectors it does not offer a
 * one-click flow for yet (browser-bound like Amazon, API/network like
 * GitHub/Gmail) are listed honestly with a plain-language reason and a technical
 * primitive in the tooltip — never an implied "Add connection" or "Sync now" that
 * would silently fail. Where a documented owner-run procedure exists today
 * (browser-bound connectors carry a `runbookPath`), the entry surfaces that path
 * so the owner is pointed at the real manual flow instead of a dead end.
 *
 * The supported set and the unsupported reasons come from the shared
 * `connection-modality` module, which is the cookie-session sibling of the
 * backend intent route's classifier — one source of truth across both surfaces
 * (`docs/voice-and-framing.md`: qualify connector claims; name the gap).
 */
function AddConnectionGuidance({ deviceExportersHref }: { deviceExportersHref: string }) {
  return (
    <Callout
      className="mb-4"
      description="Two connector types can be added from the console today by enrolling a local-collector device. Other source classes are listed below with the missing owner-approved flow."
      surface="human"
      title="Add a connection"
    >
      <div className="space-y-3">
        <div>
          <p className="pdpp-caption mb-1.5 font-medium text-foreground">Supported from the console</p>
          <ul className="flex flex-wrap gap-2">
            {SUPPORTED_LOCAL_COLLECTOR_CONNECTORS.map((connectorId) => (
              <li key={connectorId}>
                <Link
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background px-2.5 py-1 text-foreground transition-colors hover:bg-muted/40"
                  href={`${deviceExportersHref}?connector=${encodeURIComponent(connectorId)}`}
                >
                  <span className="pdpp-caption font-medium">{localCollectorConnectorLabel(connectorId)}</span>
                  <code className="pdpp-eyebrow font-mono text-muted-foreground">{connectorId}</code>
                  <span aria-hidden className="text-muted-foreground">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="pdpp-caption mt-1.5 text-muted-foreground">
            Each opens the enrollment form pre-selected. You run the collector on the host that has the data; the
            connection materializes when the device enrolls and ingests.
          </p>
        </div>

        <div>
          <p className="pdpp-caption mb-1.5 font-medium text-foreground">Not supported from the console yet</p>
          <ul className="space-y-1.5">
            {UNSUPPORTED_ADD_MODALITIES.map((entry) => (
              <li className="pdpp-caption text-muted-foreground" key={entry.modality} title={entry.missingPrimitive}>
                <span className="text-foreground">{entry.label}</span>{" "}
                <span className="text-muted-foreground">({entry.examples.join(", ")})</span> — {entry.ownerFacingReason}
                {"."}
                {entry.runbookPath ? (
                  <>
                    {" "}
                    To add one today, follow{" "}
                    <code
                      className="pdpp-eyebrow font-mono text-foreground"
                      data-testid={`runbook-path-${entry.modality}`}
                    >
                      {entry.runbookPath}
                    </code>
                    {"."}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Callout>
  );
}

/**
 * Actionable version-churn notice. The collapsed summary keeps the
 * highest-signal headline; expanding the disclosure reveals every supplied
 * churn row in an operator-readable table (connector/stream, risk, retained
 * versions per record, current/history/key counts, last-history evidence, and a
 * dry-run maintenance command).
 *
 * Built on the native `<details>`/`<summary>` disclosure already used by the
 * connection diagnostics block — no client JS, keyboard-activatable, and
 * screen-reader navigable by default. The `group-open:` Tailwind idiom flips
 * the Show/Hide affordance from the open state.
 *
 * This is metadata only: counts come from `/_ref/records/version-stats`,
 * which never returns record payloads. Copy frames the warning as retained
 * history, not current-data loss.
 */
function VersionChurnNotice({ rows }: { rows: RefRecordVersionStatsRow[] }) {
  const summary = summarizeVersionChurn(rows);
  if (!summary) {
    return null;
  }
  const drilldownRows = buildChurnDrilldownRows(rows);
  return (
    <details
      aria-label="Record version churn diagnostics"
      className="group mb-6 border-[color:var(--warning)] border-l-2 bg-[color:var(--warning)]/5"
      data-testid="version-churn-notice"
    >
      <summary className="flex cursor-pointer items-start justify-between gap-3 px-4 py-3 text-[color:var(--warning)]">
        <span className="min-w-0">
          <span className="pdpp-body block font-medium">{summary.headline}</span>
          <span className="pdpp-caption mt-1 block">{summary.highestSignal}</span>
        </span>
        <span className="pdpp-caption shrink-0 whitespace-nowrap underline-offset-2 group-hover:underline">
          <span className="group-open:hidden">Show streams →</span>
          <span className="hidden group-open:inline">Hide streams</span>
        </span>
      </summary>
      <div className="border-[color:var(--warning)]/30 border-t px-4 py-3">
        <p className="pdpp-caption mb-3 text-muted-foreground">
          These streams retain many historical versions per current record. This is kept{" "}
          <strong className="font-medium text-foreground">change history</strong>, not current data loss — your latest
          records are intact. High churn usually means a connector re-emits unchanged records; compacting history starts
          with a dry-run maintenance check and is a separate, non-destructive operator step.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="pdpp-eyebrow border-border/70 border-b text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium" scope="col">
                  Stream
                </th>
                <th className="py-1.5 pr-3 font-medium" scope="col">
                  Risk
                </th>
                <th className="py-1.5 pr-3 text-right font-medium" scope="col">
                  Versions / record
                </th>
                <th className="py-1.5 pr-3 text-right font-medium" scope="col">
                  Current
                </th>
                <th className="py-1.5 pr-3 text-right font-medium" scope="col">
                  History
                </th>
                <th className="py-1.5 pr-3 text-right font-medium" scope="col">
                  Keys
                </th>
                <th className="py-1.5 font-medium" scope="col">
                  Last history write
                </th>
                <th className="py-1.5 pl-3 font-medium" scope="col">
                  Dry-run command
                </th>
              </tr>
            </thead>
            <tbody className="pdpp-caption divide-y divide-border/60">
              {drilldownRows.map((row) => (
                <tr key={row.key}>
                  <td className="py-2 pr-3 text-foreground">{row.label}</td>
                  <td className="py-2 pr-3">
                    <ChurnRiskBadge risk={row.risk} title={row.reasons ?? undefined} />
                  </td>
                  <td className="py-2 pr-3 text-right text-foreground tabular-nums">{row.versionsPerRecord.label}</td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums ${row.current.unknown ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {row.current.label}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums ${row.history.unknown ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {row.history.label}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums ${row.keys.unknown ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {row.keys.label}
                  </td>
                  <td className="py-2 text-muted-foreground tabular-nums">
                    {row.lastHistoryAt ? <Timestamp value={row.lastHistoryAt} /> : "—"}
                  </td>
                  <td className="max-w-[28rem] py-2 pl-3">
                    <code className="block whitespace-normal rounded border border-border/70 bg-background px-2 py-1 font-mono text-[0.68rem] text-foreground leading-relaxed">
                      {row.dryRunCommand}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

const CHURN_RISK_TONE: Record<RefRecordVersionStatsRow["risk_level"], string> = {
  high: "bg-destructive/10 text-destructive",
  watch: "bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
  normal: "bg-muted text-muted-foreground",
};

function ChurnRiskBadge({ risk, title }: { risk: RefRecordVersionStatsRow["risk_level"]; title?: string }) {
  return (
    <span
      className={`pdpp-eyebrow inline-flex rounded-[3px] px-1.5 py-0.5 font-medium ${CHURN_RISK_TONE[risk]}`}
      title={title}
    >
      {risk}
    </span>
  );
}

/** Read-only sandbox row: no Sync now, no client mutation, just navigate. */
function ReadOnlyConnectorRow({ overview, routes }: { overview: ConnectorOverview; routes: Routes }) {
  const { connector, streamCount, totalRecords, streams, lastRun, lastSuccessfulRun } = overview;
  const detailHref = routes.connector(overviewRouteId(overview));
  const displayName = formatConnectorNameForDisplay({
    connectorId: connector.connector_id,
    displayName: connector.display_name,
    name: connector.name,
  });
  const connectorKey = formatConnectorKeyForDisplay(connector.connector_id);
  const displayedStreamCount = streamCount ?? streams.length;
  return (
    <li>
      <Link
        className="flex flex-col gap-3 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        href={detailHref}
      >
        <div className="min-w-0 flex-1">
          <span className="pdpp-body block font-medium text-foreground">{displayName}</span>
          <span className="pdpp-caption block truncate font-mono text-muted-foreground">{connectorKey}</span>
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

function HealthStat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: HealthStatTone;
  /** Optional sub-label that names the population behind the number. */
  hint?: string;
}) {
  const toneClass = HEALTH_STAT_TONE_CLASSES[tone];
  return (
    <div className="flex flex-col gap-1 border-border/60 border-l-2 pl-3">
      <span className="pdpp-caption text-muted-foreground">{label}</span>
      <span className={`pdpp-heading tabular-nums ${toneClass}`}>{value}</span>
      {hint ? <span className="pdpp-caption text-muted-foreground tabular-nums">{hint}</span> : null}
    </div>
  );
}

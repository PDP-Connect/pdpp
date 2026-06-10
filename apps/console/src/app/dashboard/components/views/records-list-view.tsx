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

import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { EmptyState } from "@pdpp/operator-ui/components/empty-state";
import { DataList, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import type { Routes } from "@pdpp/operator-ui/components/views/routes";
import { formatConnectorKeyForDisplay, formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { ambiguousFallbackLabelKeys } from "../../lib/connection-label-ambiguity.ts";
import { summarizeConnectionHealth } from "../../lib/connection-summary-stats.ts";
import { shouldShowInPrimaryConnections } from "../../lib/records-list-classification.ts";
import type { RefRecordVersionRemediation, RefRecordVersionStatsRow } from "../../lib/ref-client.ts";
import type { ConnectorOverview, ConnectorRunRef } from "../../lib/rs-client.ts";
import {
  buildChurnDrilldownRows,
  type ChurnRemediation,
  summarizeVersionChurn,
} from "../../lib/version-churn-summary.ts";
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
    return "Registered connections with no durable progress yet are listed below. Use Sync now to trigger a scheduled connector's first pull, or wait for a local-collector device to push.";
  }
  return "No data sources are registered on this instance yet.";
}

/**
 * Copy for the "No data yet" section that lists registered-but-empty
 * connections. It must (1) say what the rows are — real connections, not catalog
 * connectors you could add (those stay under Add source) — and (2) name the
 * real removal path: owner-agent connection controls, where revoke stops future
 * collection and delete also erases records. Removal is owner-bearer only, so
 * pointing at the owner agent (not a console action) is the honest framing.
 *
 * The sandbox is mock-backed and cannot create or remove connections, so it gets
 * a plain specimen note with no action guidance.
 */
function resolveNoDataSectionDescription(interactive: boolean): string {
  if (!interactive) {
    return "These mock connections are registered but have no seeded records.";
  }
  return "These sources are registered but have no durable records yet; scheduled connectors add records on their next pull, and local-collector sources fill in when their device pushes. A source you have not connected stays under Add source; to drop one you do not want, ask your owner agent to revoke it (stops future collection) or delete it (also erases its records).";
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
  versionChurnSlot,
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
  /** Advisory diagnostics that should not block the primary connection list. */
  versionChurnSlot?: ReactNode;
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
  // "Label needed — rename" is honest only when a connection's bare type label
  // is ambiguous — two or more unnamed connections of the same connector type.
  // A lone "Amazon" is correctly named; nagging it is noise. This is the same
  // ambiguity that drives the `· connection N` ordinal above, so both surfaces
  // agree. Computed across the full set (not per-row) so a single connection of
  // a type is never told to rename.
  const labelNeededKeys = ambiguousFallbackLabelKeys(labeled);
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
            ? `${summary.registeredTotal} registered sources · ${summary.primaryList} listed`
            : `${summary.registeredTotal} sources`;

  const primaryEmptyHint = resolvePrimaryEmptyHint(interactive, empty.length > 0);

  return (
    <>
      {pollerSlot}
      <PageHeader
        actions={<RecordsHeaderActions interactive={interactive} routes={routes} />}
        count={
          pendingOnDevices && pendingOnDevices > 0
            ? `${totalRecords.toLocaleString()} retained records · ${totalStreams} streams · ${connectionsCountLabel} · +${pendingOnDevices.toLocaleString()} pending on devices`
            : `${totalRecords.toLocaleString()} retained records · ${totalStreams} streams · ${connectionsCountLabel}`
        }
        description={
          interactive
            ? "Manage connected data sources and monitor sync health. Retained record counts appear here; local-collector backlogs show as 'pending on devices'. Where a connector supports an owner-triggered pull, Sync now refetches it; otherwise open a source to browse its streams and records."
            : "Sandbox demo: deterministic mock sources. Click into a source to browse its streams and records."
        }
        title="Sources"
      />

      {versionChurnSlot ??
        (versionChurnRows && versionChurnRows.length > 0 ? <VersionChurnNotice rows={versionChurnRows} /> : null)}

      <section aria-label="Connection health summary" className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <HealthStat
          hint={
            summary.noData > 0
              ? `${summary.primaryList.toLocaleString()} listed · ${summary.noData.toLocaleString()} no data yet`
              : undefined
          }
          label="Sources"
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

      <Section title={`Sources (${primaryConnections.length})`}>
        {primaryConnections.length === 0 ? (
          <EmptyState hint={primaryEmptyHint} title="No data ingested yet" />
        ) : (
          <DataList>
            {sorted.map((o) =>
              interactive ? (
                <ConnectorRow
                  key={overviewRouteId(o)}
                  labelNeeded={labelNeededKeys.has(overviewRouteId(o))}
                  overview={o}
                  runsHref={routes.section.runs}
                />
              ) : (
                <ReadOnlyConnectorRow key={overviewRouteId(o)} overview={o} routes={routes} />
              )
            )}
          </DataList>
        )}
      </Section>

      {empty.length > 0 ? (
        <Section description={resolveNoDataSectionDescription(interactive)} title={`No data yet (${empty.length})`}>
          <DataList>
            {empty.map((o) =>
              interactive ? (
                <ConnectorRow
                  key={overviewRouteId(o)}
                  labelNeeded={labelNeededKeys.has(overviewRouteId(o))}
                  overview={o}
                  runsHref={routes.section.runs}
                />
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
 * Records-index header actions.
 *
 * The persistent "Add source" action is the always-visible header entry.
 * It routes to the unified Connect cockpit, not directly to device enrollment:
 * the cockpit is the single owner-facing place that can search every connector
 * and choose the correct next setup action. The button is gated on
 * `interactive` so the sandbox — which cannot create connections — never shows
 * a dead button.
 */
function RecordsHeaderActions({ interactive, routes }: { interactive: boolean; routes: Routes }) {
  return (
    <>
      {interactive ? (
        <Link
          className={buttonVariants({ variant: "default", size: "sm" })}
          data-testid="add-connection-action"
          href={routes.section.connect}
        >
          Add source
        </Link>
      ) : null}
      <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={routes.section.explore}>
        Open in Explore →
      </Link>
    </>
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
 * screen-reader navigable by default. The `<summary>` carries an explicit,
 * button-styled action so the banner reads as actionable; the `group-open:`
 * Tailwind idiom flips it to "Hide details" when open.
 *
 * Disposition-honest tone: the notice only reads as a warning ("Review version
 * churn") when at least one row is unclassified and genuinely needs review.
 * When every churning stream is already classified — a registered lossless
 * compaction candidate or expected retained point-in-time history — the banner
 * is informational ("Version churn breakdown"), not an alarm, and the lead copy
 * says so. Thresholds are untouched; every non-normal row still appears in the
 * table.
 *
 * This is metadata only: counts come from `/_ref/records/version-stats`,
 * which never returns record payloads. Copy frames the warning as retained
 * history, not current-data loss.
 */
export function VersionChurnNotice({ rows }: { rows: RefRecordVersionStatsRow[] }) {
  const summary = summarizeVersionChurn(rows);
  if (!summary) {
    return null;
  }
  const drilldownRows = buildChurnDrilldownRows(rows);
  const needsReview = summary.needsReview;
  // Warning amber only when something genuinely needs review; otherwise a
  // neutral/border treatment so an owner whose only churn is expected history
  // is not visually alarmed.
  const accent = needsReview ? "var(--warning)" : "var(--border)";
  return (
    <details
      aria-label="Record version churn diagnostics"
      className="group mb-6 border-l-2"
      data-testid="version-churn-notice"
      style={{ borderLeftColor: `color-mix(in srgb, ${accent} 100%, transparent)` }}
    >
      <summary
        className={`flex cursor-pointer items-start justify-between gap-3 px-4 py-3 ${needsReview ? "text-[color:var(--warning)]" : "text-foreground"}`}
        data-testid="version-churn-review-action"
      >
        <span className="min-w-0">
          <span className="pdpp-body block font-medium">{summary.headline}</span>
          <span className="pdpp-caption mt-1 block">{summary.highestSignal}</span>
        </span>
        {/*
         * Explicit, button-styled owner action. The native <summary> is already
         * keyboard-activatable and toggles the disclosure. When review is
         * needed it reads "Review version churn"; when everything is already
         * classified it reads "View breakdown" so the owner can still inspect
         * the rows without being told to "review" history that is expected.
         */}
        <span className="pdpp-caption inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap rounded-md border border-current/40 bg-current/10 px-2.5 py-1 font-medium underline-offset-2 group-hover:bg-current/20">
          <span className="group-open:hidden">{needsReview ? "Review version churn →" : "View breakdown →"}</span>
          <span className="hidden group-open:inline">Hide details</span>
        </span>
      </summary>
      <div className="border-t px-4 py-3" style={{ borderTopColor: `color-mix(in srgb, ${accent} 30%, transparent)` }}>
        <p className="pdpp-caption mb-2 text-muted-foreground">
          These streams retain many historical versions per current record. This is kept{" "}
          <strong className="font-medium text-foreground">change history</strong>, not current data loss — your latest
          records are intact. A churning stream falls into one of four buckets, each with a different disposition. When
          a connector re-emits unchanged records (a no-op or run-clock refresh) on a stream with a registered policy,
          compacting history is safe and starts with a dry-run maintenance check. When such a stream has been
          owner-reviewed and confirmed as expected pre-fix residue (the connector is now fingerprint-correct, dry-run
          shows removableVersions=0), it is marked{" "}
          <strong className="font-medium text-foreground">reviewed residue</strong> — not alarming, safe to leave or
          compact later. When a stream versions on a value that{" "}
          <strong className="font-medium text-foreground">genuinely changes</strong> (a follower count, a member count,
          a balance), that history is real and <strong className="font-medium text-foreground">expected to grow</strong>{" "}
          — it must not be compacted; the durable fix is an append-keyed point-in-time stream. Only a stream that is
          none of these — an <strong className="font-medium text-foreground">unclassified</strong> high-churn row —
          actually needs review.
        </p>
        <p className="pdpp-caption mb-3 text-muted-foreground" data-testid="version-churn-dry-run-safety">
          Rows that show a command are safe to start with: the command is{" "}
          <strong className="font-medium text-foreground">read-only</strong> and prints the compaction plan (versions it
          would remove, bytes it would free) without changing anything — for a{" "}
          <strong className="font-medium text-foreground">compaction candidate</strong> it reports a real plan, and for
          an <strong className="font-medium text-foreground">unclassified</strong> row it confirms whether a policy even
          exists. Nothing is removed until you re-run it with <code className="font-mono text-foreground">--apply</code>
          , which backs up affected rows first. Rows marked{" "}
          <strong className="font-medium text-foreground">not compactable</strong> have no compaction command on purpose
          — compacting them would delete real point-in-time history.
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
                <th className="py-1.5 pr-3 font-medium" scope="col">
                  Disposition
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
                  <td className="py-2 pr-3 text-foreground">
                    {row.connectorInstanceId ? (
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/dashboard/records/${encodeURIComponent(row.connectorInstanceId)}`}
                        title={`Open ${row.label}`}
                      >
                        {row.label}
                      </Link>
                    ) : (
                      row.label
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <ChurnRiskBadge risk={row.risk} title={row.reasons ?? undefined} />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-col items-start gap-1">
                      <ChurnDispositionBadge remediation={row.remediation} />
                      {row.remediationChip ? (
                        <ChurnRemediationBadge action={row.remediationAction} label={row.remediationChip} />
                      ) : null}
                    </div>
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
                    {row.dryRunCommand ? (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-start gap-1.5">
                          <code className="block min-w-0 flex-1 whitespace-normal rounded border border-border/70 bg-background px-2 py-1 font-mono text-[0.68rem] text-foreground leading-relaxed">
                            {row.dryRunCommand}
                          </code>
                          <CopyButton
                            ariaLabel={`Copy dry-run command for ${row.label}`}
                            className="mt-0.5"
                            value={row.dryRunCommand}
                          />
                        </div>
                        {/*
                         * A reviewed-residue row still shows the read-only dry-run
                         * command (it is honest and `--apply` is the owner's lever),
                         * but the remediation line explains that compaction frees
                         * nothing yet (fingerprint pending) or must not run before a
                         * migration (migration pending) — the genuinely rational next
                         * action the command alone does not convey.
                         */}
                        {row.remediationGuidance ? (
                          <p
                            className="pdpp-caption text-muted-foreground leading-relaxed"
                            data-testid="version-churn-remediation-guidance"
                          >
                            {row.remediationGuidance}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p
                        className="pdpp-caption text-muted-foreground leading-relaxed"
                        data-testid="version-churn-not-compactable"
                      >
                        {/*
                         * Non-compactable rows prefer the remediation guidance
                         * (e.g. a recurring snapshot's owner retention-policy line)
                         * over the generic point-in-time guidance, then fall back.
                         */}
                        {row.remediationGuidance ??
                          row.pointInTimeGuidance ??
                          "Not compactable — needs an append-keyed point-in-time stream split, not compaction."}
                      </p>
                    )}
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

/**
 * Per-row remediation disposition: the bucket the row falls into. This is the
 * in-table counterpart to the disposition-honest headline — it lets an operator
 * see at a glance which rows actually need review (unclassified) versus which
 * are expected retained history or known compaction candidates.
 */
const CHURN_DISPOSITION_META: Record<ChurnRemediation, { label: string; tone: string; title: string }> = {
  active_defect_or_unclassified: {
    label: "needs review",
    tone: "bg-destructive/10 text-destructive",
    title:
      "No registered compaction policy and not a known point-in-time or recurring-snapshot stream — investigate as a possible new no-op churn bug or unmodeled real-field stream.",
  },
  lossless_compaction_candidate: {
    label: "compaction candidate",
    tone: "bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
    title:
      "Has a registered, fingerprint-mirrored compaction policy — the dry-run command reports what redundant history it would remove.",
  },
  reviewed_historical_residue: {
    label: "reviewed residue",
    tone: "bg-muted text-muted-foreground",
    title:
      "Owner-reviewed: the compaction policy is registered and the connector is now fingerprint-correct. The dry-run confirms removableVersions=0 — this is pre-fix history that accumulated before the policy was applied. Not actively growing; safe to leave or compact with --apply.",
  },
  point_in_time_retained_history: {
    label: "expected history",
    tone: "bg-muted text-muted-foreground",
    title:
      "Genuine point-in-time observations (a real field that legitimately changes). Expected retained history — not compactable; the sampled metric was split into an append-keyed point-in-time stream and this retained history is its sole surviving copy.",
  },
  recurring_point_in_time_snapshot: {
    label: "recurring snapshot",
    tone: "bg-muted text-muted-foreground",
    title:
      "Recurring point-in-time snapshots — expected retained history. The whole record is the evolving observation (it grows on each real session pass), so it cannot be append-split or compacted. Growth is expected and does not re-alarm.",
  },
};

function ChurnDispositionBadge({ remediation }: { remediation: ChurnRemediation }) {
  const meta = CHURN_DISPOSITION_META[remediation];
  return (
    <span
      className={`pdpp-eyebrow inline-flex whitespace-nowrap rounded-[3px] px-1.5 py-0.5 font-medium ${meta.tone}`}
      title={meta.title}
    >
      {meta.label}
    </span>
  );
}

/**
 * Per-row remediation chip: the operator's available NEXT ACTION, orthogonal to
 * the disposition badge. This is what makes three rows that share the
 * `reviewed_historical_residue` disposition read as three distinct next actions
 * — a connector content fingerprint, an owner-gated migration, or (for a
 * recurring snapshot) an owner retention-policy decision. `none` shows no chip,
 * so this component is only rendered for the three actionable remediations.
 */
const CHURN_REMEDIATION_META: Record<
  Exclude<RefRecordVersionRemediation, "none">,
  { title: string; tone: string }
> = {
  content_fingerprint_pending: {
    tone: "border border-current/30 bg-current/5 text-muted-foreground",
    title:
      "Fingerprint pending — correct on the run clock, but compaction frees nothing here until the connector emits a stable content fingerprint so the volatile blob-identity fields can be excluded losslessly. The fix is connector work, not compaction.",
  },
  owner_migration_pending: {
    tone: "border border-current/30 bg-current/5 text-muted-foreground",
    title:
      "Migration pending — this retained history is the sole surviving copy of real pre-split observations. Do not compact: an owner-gated backfill into the append-keyed home must precede any collapse.",
  },
  owner_retention_policy: {
    tone: "border border-current/30 bg-current/5 text-muted-foreground",
    title:
      "Retention policy — owner decision. Expected recurring snapshot history; the only open lever is whether to bound its growth, which you may decline.",
  },
};

function ChurnRemediationBadge({ action, label }: { action: RefRecordVersionRemediation; label: string }) {
  // `none` advertises no next action, so it carries no chip. The view only
  // renders this when a chip label is present, but guard here too so the type
  // narrows without a non-null assertion.
  if (action === "none") {
    return null;
  }
  const meta = CHURN_REMEDIATION_META[action];
  return (
    <span
      className={`pdpp-eyebrow inline-flex whitespace-nowrap rounded-[3px] px-1.5 py-0.5 font-medium ${meta.tone}`}
      data-testid="version-churn-remediation-chip"
      title={meta.title}
    >
      {label}
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

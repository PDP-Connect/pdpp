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
import { Callout, DataList, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import type { Routes } from "@pdpp/operator-ui/components/views/routes";
import { formatConnectorKeyForDisplay, formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import {
  browserBoundRunbookEntries,
  browserCollectorEntries,
  type ConnectorCatalogEntry,
  localCollectorEntries,
  localCollectorUnprovenEntries,
  staticSecretConnectEntries,
  unsupportedNetworkEntries,
} from "../../lib/connection-catalog.ts";
import { ambiguousFallbackLabelKeys } from "../../lib/connection-label-ambiguity.ts";
import {
  BROWSER_BOUND_RUNBOOK_PATH,
  STATIC_SECRET_ADD_MODALITY,
  UNSUPPORTED_ADD_MODALITIES,
} from "../../lib/connection-modality.ts";
import { summarizeConnectionHealth } from "../../lib/connection-summary-stats.ts";
import { shouldShowInPrimaryConnections } from "../../lib/records-list-classification.ts";
import type { RefRecordVersionStatsRow } from "../../lib/ref-client.ts";
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
  connectorCatalog,
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
   * The connector catalog (every shipped manifest, classified by modality and
   * routed to its honest next step) the add-connection picker renders. Built by
   * the live page from `listConnectorManifests()`; the sandbox omits it (no
   * add-connection surface), so it defaults to an empty list.
   */
  connectorCatalog?: ConnectorCatalogEntry[];
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
      ? `${summary.registeredTotal} registered connections · ${summary.primaryList} listed`
      : `${summary.registeredTotal} connections`;

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
            ? "Manage your connections and monitor sync health. Retained record counts appear here; local-collector backlogs show as 'pending on devices'. Where a connector supports an owner-triggered pull, Sync now refetches it; otherwise open a connection to browse its streams and records."
            : "Sandbox demo: deterministic mock connections. Click into a connection to browse its streams and records."
        }
        title="Connections"
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

      {/*
       * Always-visible on the live list: the honest add-connection guidance is
       * the only surface that names what can be added today (claude_code/codex,
       * one-click) versus what is owner-run-gated (browser-bound like Amazon →
       * runbook path). Rendering it once here — not only inside the empty-state
       * branches — means an owner whose console is already fully populated (no
       * empty-state callout shows) is no longer silently dropped past it by the
       * persistent "Add connection" header button, which deep-links straight to
       * the device-exporters form that only offers the local-collector set. That
       * dead-end was the owner-reported "no obvious way to add a second Amazon".
       */}
      {interactive ? (
        <AddConnectionGuidance catalog={connectorCatalog ?? []} deviceExportersHref={routes.section.deviceExporters} />
      ) : null}

      <Section title={`Connections (${primaryConnections.length})`}>
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
        <Section
          description={
            interactive
              ? "These connections are registered but have no durable progress yet. A scheduled or owner-triggerable connector pulls its first records on Sync now; a local-collector connection fills in when its device pushes."
              : "These mock connections are registered but have no seeded records."
          }
          title={`No data yet (${empty.length})`}
        >
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
 * The persistent "Add connection" action is the always-visible header entry: it
 * deep-links to the proven device-enrollment form, which can only complete the
 * local-collector set (claude_code/codex). On its own that silently dead-ends an
 * owner who wants a browser-bound source (Amazon), so the live list also renders
 * the detailed `AddConnectionGuidance` callout unconditionally (above the
 * Connections section) — it names the supported one-click set and points
 * browser-bound sources at their runbook. The button is gated on `interactive`
 * so the sandbox — which cannot create connections — never shows a dead button.
 */
function RecordsHeaderActions({ interactive, routes }: { interactive: boolean; routes: Routes }) {
  return (
    <>
      {interactive ? (
        <Link
          className={buttonVariants({ variant: "default", size: "sm" })}
          data-testid="add-connection-action"
          href={routes.section.deviceExporters}
        >
          Add connection
        </Link>
      ) : null}
      <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={routes.section.explore}>
        Open in Explore →
      </Link>
    </>
  );
}

/** Owner-facing reason copy for a gated modality, sourced from the shared module. */
function unsupportedModalityCopy(modality: "browser_bound" | "api_network") {
  return UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === modality);
}

/**
 * Honest add-connection picker. The catalog is read server-side from shipped
 * manifests, then rendered as: startable now, manual browser proof, or visible
 * but gated. Gated entries never render enrollment links.
 *
 * Presentation contract (owner feedback: the picker felt "too Amazon-specific,
 * too verbose, confusing"): the ONE easy path — one-click local-collector
 * enrollment — leads and stays open. Every other group (manual browser-collector
 * / Amazon, browser-bound runbook, local-collector unproven, static-secret
 * connect / Gmail+GitHub, api_network unsupported) is honest but secondary, so it
 * lives inside a native `<details>` disclosure that names its count. Collapsing is
 * not omission: each connector is still in the DOM, grouped by modality,
 * keyboard-reachable, with its honest reason and (where it exists) its deep-link —
 * the same standard the version-churn disclosure in this file already meets.
 * Amazon is one entry inside the disclosure, no longer the headline. The
 * static-secret group is a real owner-session creation path (draft → capture →
 * first ingest), surfaced runbook-pointed and live-proof-caveated, NOT deep-linked
 * (Gmail/GitHub are not device-collectors) and NOT flipped to one-click-supported
 * until the live end-to-end proof lands. The honesty model — six dispositions,
 * gated reasons, runbook pointers, exactly-two deep-links — is unchanged.
 */
function AddConnectionGuidance({
  catalog,
  deviceExportersHref,
}: {
  catalog: ConnectorCatalogEntry[];
  deviceExportersHref: string;
}) {
  const localEntries = localCollectorEntries(catalog);
  const localUnproven = localCollectorUnprovenEntries(catalog);
  const browserManualEntries = browserCollectorEntries(catalog);
  const browserRunbook = browserBoundRunbookEntries(catalog);
  const staticSecretEntries = staticSecretConnectEntries(catalog);
  const networkUnsupported = unsupportedNetworkEntries(catalog);
  const browserCopy = unsupportedModalityCopy("browser_bound");
  const networkCopy = unsupportedModalityCopy("api_network");
  const otherCount =
    browserManualEntries.length +
    browserRunbook.length +
    localUnproven.length +
    staticSecretEntries.length +
    networkUnsupported.length;
  return (
    <Callout
      className="mb-4"
      description="Pick a connector to add. The ones below set up here in one step; everything else lives under “Other connectors”, with the manual or not-yet-supported path each one still needs."
      surface="human"
      title="Add a connection"
    >
      <div className="space-y-3">
        {localEntries.length > 0 ? (
          <div>
            <ul className="flex flex-wrap gap-2">
              {localEntries.map((entry) => (
                <li key={entry.connectorKey}>
                  <Link
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background px-2.5 py-1 text-foreground transition-colors hover:bg-muted/40"
                    data-testid={`catalog-local-${entry.connectorKey}`}
                    href={`${deviceExportersHref}?connector=${encodeURIComponent(entry.enrollmentKey ?? entry.connectorKey)}`}
                  >
                    <span className="pdpp-caption font-medium">{entry.displayName}</span>
                    <code className="pdpp-eyebrow font-mono text-muted-foreground">{entry.connectorKey}</code>
                    <span aria-hidden className="text-muted-foreground">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="pdpp-caption mt-1.5 text-muted-foreground">
              Opens the enrollment form pre-selected. Run the collector on the host that has the data.
            </p>
          </div>
        ) : null}

        {otherCount > 0 ? (
          <details className="rounded-md border border-border/60 bg-muted/10" data-testid="add-connection-other">
            <summary
              className="pdpp-caption flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-medium text-foreground marker:hidden [&::-webkit-details-marker]:hidden"
              data-testid="add-connection-other-toggle"
            >
              <span aria-hidden className="text-muted-foreground transition-transform [details[open]_&]:rotate-90">
                ›
              </span>
              Other connectors — owner-run or not yet supported ({otherCount})
            </summary>
            <div className="space-y-3 px-3 pt-1 pb-3">
              {browserManualEntries.length > 0 ? (
                <div>
                  <p className="pdpp-caption mb-1.5 font-medium text-foreground">Manual browser-collector setup</p>
                  <ul className="flex flex-wrap gap-2">
                    {browserManualEntries.map((entry) => (
                      <li key={entry.connectorKey}>
                        <Link
                          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-foreground transition-colors hover:bg-amber-500/15"
                          data-testid={`catalog-browser-manual-${entry.connectorKey}`}
                          href={`${deviceExportersHref}?connector=${encodeURIComponent(entry.enrollmentKey ?? entry.connectorKey)}`}
                        >
                          <span className="pdpp-caption font-medium">{entry.displayName}</span>
                          <code className="pdpp-eyebrow font-mono text-muted-foreground">{entry.connectorKey}</code>
                          <span aria-hidden className="text-muted-foreground">
                            →
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <p className="pdpp-caption mt-1.5 text-muted-foreground">
                    Mints a <code className="font-mono">browser_collector</code> enrollment code. It is not a one-click
                    browser flow; finish the owner-run browser proof with{" "}
                    <code className="pdpp-eyebrow font-mono text-foreground">{BROWSER_BOUND_RUNBOOK_PATH}</code>.
                  </p>
                </div>
              ) : null}

              {browserRunbook.length > 0 ? (
                <div>
                  <p className="pdpp-caption mb-1.5 font-medium text-foreground">Browser-bound — owner-run setup</p>
                  <ul className="flex flex-wrap gap-2">
                    {browserRunbook.map((entry) => (
                      <li
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1"
                        data-testid={`catalog-browser-runbook-${entry.connectorKey}`}
                        key={entry.connectorKey}
                      >
                        <span className="pdpp-caption font-medium text-foreground">{entry.displayName}</span>
                        <code className="pdpp-eyebrow font-mono text-muted-foreground">{entry.connectorKey}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="pdpp-caption mt-1.5 text-muted-foreground">
                    {browserCopy?.ownerFacingReason ??
                      "needs a supported browser-collector run profile before the console can generate setup commands"}
                    . Manual path:{" "}
                    <code className="pdpp-eyebrow font-mono text-foreground" data-testid="runbook-path-browser_bound">
                      {BROWSER_BOUND_RUNBOOK_PATH}
                    </code>
                    {"."}
                  </p>
                </div>
              ) : null}

              {localUnproven.length > 0 ? (
                <div>
                  <p className="pdpp-caption mb-1.5 font-medium text-foreground">
                    Local-collector — not proven here yet
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {localUnproven.map((entry) => (
                      <li
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1"
                        data-testid={`catalog-local-unproven-${entry.connectorKey}`}
                        key={entry.connectorKey}
                      >
                        <span className="pdpp-caption font-medium text-foreground">{entry.displayName}</span>
                        <code className="pdpp-eyebrow font-mono text-muted-foreground">{entry.connectorKey}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="pdpp-caption mt-1.5 text-muted-foreground">
                    Filesystem-class connectors without a committed console enrollment proof yet.
                  </p>
                </div>
              ) : null}

              {staticSecretEntries.length > 0 ? (
                <div>
                  <p className="pdpp-caption mb-1.5 font-medium text-foreground">Static-secret — owner-session setup</p>
                  <ul className="flex flex-wrap gap-2">
                    {staticSecretEntries.map((entry) => (
                      <li
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1"
                        data-testid={`catalog-static-secret-${entry.connectorKey}`}
                        key={entry.connectorKey}
                      >
                        <span className="pdpp-caption font-medium text-foreground">{entry.displayName}</span>
                        <code className="pdpp-eyebrow font-mono text-muted-foreground">{entry.connectorKey}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="pdpp-caption mt-1.5 text-muted-foreground">
                    {STATIC_SECRET_ADD_MODALITY.ownerFacingReason}. Owner runbook:{" "}
                    <code className="pdpp-eyebrow font-mono text-foreground" data-testid="runbook-path-static_secret">
                      {STATIC_SECRET_ADD_MODALITY.runbookPath}
                    </code>
                    {"."}
                  </p>
                </div>
              ) : null}

              {networkUnsupported.length > 0 ? (
                <div>
                  <p className="pdpp-caption mb-1.5 font-medium text-foreground">Not supported from the console yet</p>
                  <ul className="flex flex-wrap gap-2">
                    {networkUnsupported.map((entry) => (
                      <li
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1"
                        data-testid={`catalog-network-${entry.connectorKey}`}
                        key={entry.connectorKey}
                      >
                        <span className="pdpp-caption font-medium text-foreground">{entry.displayName}</span>
                        <code className="pdpp-eyebrow font-mono text-muted-foreground">{entry.connectorKey}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="pdpp-caption mt-1.5 text-muted-foreground" title={networkCopy?.missingPrimitive}>
                    {networkCopy?.ownerFacingReason ??
                      "needs an owner-approved API connection flow; today these connections appear only after a connector has ingested data"}
                    {"."}
                  </p>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
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
          records are intact. A churning stream falls into one of four buckets, each with a different disposition. When a
          connector re-emits unchanged records (a no-op or run-clock refresh) on a stream with a registered policy,
          compacting history is safe and starts with a dry-run maintenance check. When such a stream has been
          owner-reviewed and confirmed as expected pre-fix residue (the connector is now fingerprint-correct, dry-run
          shows removableVersions=0), it is marked{" "}
          <strong className="font-medium text-foreground">reviewed residue</strong> — not alarming, safe to leave or
          compact later. When a stream versions on a value that{" "}
          <strong className="font-medium text-foreground">genuinely changes</strong> (a follower count, a member count, a
          balance), that history is real and <strong className="font-medium text-foreground">expected to grow</strong>{" "}
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
                    <ChurnDispositionBadge remediation={row.remediation} />
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
                    ) : (
                      <p
                        className="pdpp-caption text-muted-foreground leading-relaxed"
                        data-testid="version-churn-not-compactable"
                      >
                        {row.pointInTimeGuidance ??
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
  unclassified: {
    label: "needs review",
    tone: "bg-destructive/10 text-destructive",
    title:
      "No registered compaction policy and not a known point-in-time stream — investigate as a possible new no-op churn bug or unmodeled real-field stream.",
  },
  lossless_compaction_candidate: {
    label: "compaction candidate",
    tone: "bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
    title:
      "Has a registered, fingerprint-mirrored compaction policy — the dry-run command reports what redundant history it would remove.",
  },
  reviewed_compaction_residue: {
    label: "reviewed residue",
    tone: "bg-muted text-muted-foreground",
    title:
      "Owner-reviewed: the compaction policy is registered and the connector is now fingerprint-correct. The dry-run confirms removableVersions=0 — this is pre-fix history that accumulated before the policy was applied. Not actively growing; safe to leave or compact with --apply.",
  },
  point_in_time_real_field: {
    label: "expected history",
    tone: "bg-muted text-muted-foreground",
    title:
      "Genuine point-in-time observations (a real field that legitimately changes). Expected retained history — not compactable; the durable fix is an append-keyed point-in-time stream split.",
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

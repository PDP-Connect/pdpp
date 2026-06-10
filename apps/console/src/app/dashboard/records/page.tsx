import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { Suspense } from "react";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { RecordsListView, VersionChurnNotice } from "../components/views/records-list-view.tsx";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  listDeviceExporterSourceInstances,
  listRecordVersionStats,
  type RefConnectorRunSummary,
  type RefConnectorSummary,
} from "../lib/ref-client.ts";
import type { ConnectorOverview } from "../lib/rs-client.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { buildSourceAddSupport, type SourceAddSupport } from "../lib/source-add-support.ts";
import { RecordsPagePoller } from "./records-page-poller.tsx";

export const dynamic = "force-dynamic";

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
    collectionReport: summary.collection_report ?? null,
    connectionHealth: summary.connection_health,
    connectionId: summary.connection_id,
    connectionStatus: summary.status ?? null,
    connector: {
      connector_id: summary.connector_id,
      display_name: summary.display_name,
      name: summary.connector_display_name ?? summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    },
    connectorDisplayName: summary.connector_display_name,
    connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
    localDeviceProgress: summary.local_device_progress ?? null,
    retainedBytes: summary.retained_bytes ?? null,
    revokedAt: summary.revoked_at ?? null,
    streams: summary.streams.map((name) => ({
      object: "stream",
      name,
      record_count: 0,
      last_updated: null,
    })),
    streamCount: summary.stream_count,
    totalRetainedBytes: summary.total_retained_bytes,
    totalRecords: summary.total_records,
    lastRun,
    lastSuccessfulRun,
    isRunning: lastRun != null && new Set(["started", "in_progress"]).has(lastRun.status),
  };
}

export default async function RecordsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; message?: string }>;
}) {
  const actionParams = searchParams ? await searchParams : {};
  let overviews: ConnectorOverview[];
  // Aggregate `records_pending` across all enrolled local device source
  // instances. The records list otherwise only shows retained-on-server
  // totals, which implies completeness when a local collector still has
  // outbox work to drain. Surfaced honestly in the header; treated as 0
  // when the device-exporter endpoint fails so the rest of the page
  // still renders.
  let pendingOnDevices = 0;
  // The connector summaries and the device-exporter diagnostics are
  // independent reads. Fire the (advisory) device-exporter request
  // concurrently with the (load-bearing) connector-summaries request so the
  // page latency is the slower of the two, not their sum. We pre-attach a
  // `.catch` here so a device-exporter rejection never becomes an unhandled
  // rejection while we await the connector summaries first — it is resolved to
  // a 0 backlog because those diagnostics are advisory.
  const pendingOnDevicesPromise = listDeviceExporterSourceInstances()
    .then((sources) =>
      sources.data.reduce((sum, s) => sum + (typeof s.records_pending === "number" ? s.records_pending : 0), 0)
    )
    .catch(() => 0);
  // The connector manifests drive the per-source "add another account" support
  // projection. This is advisory: it tells the owner whether they can add
  // another account to a source they already have, but the connection list and
  // its health are load-bearing and must render even if the manifest read
  // fails. An empty map degrades to "no add-account affordance shown" rather
  // than a broken page, so resolve a failure to an empty map. Raced with the
  // connector summaries so it never adds page latency.
  let addSupportByConnectorId = new Map<string, SourceAddSupport>();
  const addSupportPromise = listConnectorManifests()
    .then((manifests) => buildSourceAddSupport(manifests))
    .catch(() => new Map<string, SourceAddSupport>());
  try {
    const response = await liveDashboardDataSource.listConnectorSummaries();
    overviews = response.data.map(toConnectorOverview);
    // Device-exporter diagnostics are advisory; if they fail we still render
    // the connector list. Per-connection diagnostics surface the underlying
    // error. The request already raced the connector summaries above.
    pendingOnDevices = await pendingOnDevicesPromise;
    addSupportByConnectorId = await addSupportPromise;
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Sources" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const runningCount = overviews.filter((o) => o.isRunning).length;

  return (
    <DashboardShell active="records">
      <RecordsActionBanner error={actionParams.error} message={actionParams.message} />
      <RecordsListView
        addSupportByConnectorId={addSupportByConnectorId}
        interactive={true}
        overviews={overviews}
        pendingOnDevices={pendingOnDevices}
        pollerSlot={<RecordsPagePoller running={runningCount > 0} />}
        routes={dashboardRoutes}
        versionChurnSlot={
          <Suspense fallback={<VersionChurnFallback />}>
            <VersionChurnSection />
          </Suspense>
        }
      />
    </DashboardShell>
  );
}

function RecordsActionBanner({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) {
    return null;
  }
  return (
    <div
      className={
        error
          ? "pdpp-caption mb-5 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5"
          : "pdpp-caption mb-5 rounded-md border border-emerald-500/30 border-l-4 border-l-emerald-500/60 bg-emerald-500/5 px-4 py-2.5"
      }
      role="status"
    >
      <span className={error ? "font-medium text-destructive" : "font-medium text-emerald-700 dark:text-emerald-400"}>
        {error ?? message}
      </span>
    </div>
  );
}

async function VersionChurnSection() {
  try {
    const churn = await listRecordVersionStats({ limit: 8 });
    const versionChurnRows = churn.data.filter((row) => row.risk_level !== "normal");
    return versionChurnRows.length > 0 ? <VersionChurnNotice rows={versionChurnRows} /> : null;
  } catch {
    return null;
  }
}

function VersionChurnFallback() {
  return (
    <div className="pdpp-caption mb-4 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-muted-foreground">
      Checking retained-history diagnostics...
    </div>
  );
}

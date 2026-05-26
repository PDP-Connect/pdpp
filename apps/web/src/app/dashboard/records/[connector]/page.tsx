import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DataList, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import {
  type DeviceSourceInstance,
  getConnectorSchedule,
  listDeviceExporterSourceInstances,
  listRuns,
  type RefConnectionHealthSnapshot,
  type RefConnectorRunSummary,
  type RefConnectorSummary,
  type RefSchedule,
  type RunSummary,
} from "../../lib/ref-client.ts";
import {
  type ConnectorManifest,
  type ConnectorOverview,
  listConnectorManifests,
  listStreams,
  type StreamSummary,
} from "../../lib/rs-client.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../connection-route.ts";
import { ConnectionDiagnostics } from "./connection-diagnostics.tsx";
import { RenameConnectionButton } from "./rename-connection-button.tsx";
import { SyncNowButton } from "./sync-now-button.tsx";

export const dynamic = "force-dynamic";

const RECENT_RUNS_LIMIT = 10;

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

function toConnectorOverview(summary: RefConnectorSummary, streams: StreamSummary[]): ConnectorOverview {
  const lastRun = toConnectorRunRef(summary.last_run);
  const lastSuccessfulRun = toConnectorRunRef(summary.last_successful_run);
  return {
    connectionHealth: summary.connection_health,
    connectionId: summary.connection_id,
    connector: {
      connector_id: summary.connector_id,
      display_name: summary.display_name,
      name: summary.connector_display_name ?? summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    },
    connectorDisplayName: summary.connector_display_name,
    connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
    streams,
    streamCount: summary.stream_count,
    retainedBytes: summary.retained_bytes ?? null,
    totalRetainedBytes: summary.total_retained_bytes,
    totalRecords: summary.total_records,
    localDeviceProgress: summary.local_device_progress ?? null,
    lastRun,
    lastSuccessfulRun,
    isRunning: lastRun != null && new Set(["started", "in_progress"]).has(lastRun.status),
  };
}

export default async function ConnectorPage({ params }: { params: Promise<{ connector: string }> }) {
  const { connector } = await params;
  const routeId = decodeURIComponent(connector);

  let manifest: ConnectorManifest | undefined;
  let summary: RefConnectorSummary | undefined;
  let connectorId = routeId;
  let connectionId = routeId;
  let connectorInstanceId: string | null = null;
  let streams: StreamSummary[];
  let overview: ConnectorOverview | null = null;
  let recentRuns: RunSummary[] = [];
  let connectionHealth: RefConnectionHealthSnapshot | null = null;
  let schedule: RefSchedule | null = null;
  let scheduleError: string | null = null;
  let sourceInstances: DeviceSourceInstance[] = [];
  let sourceInstancesError: string | null = null;
  try {
    const [resolvedSummary, manifests] = await Promise.all([
      resolveConnectionForRecordsRoute(routeId),
      listConnectorManifests(),
    ]);
    summary = resolvedSummary ?? undefined;
    if (!summary) {
      notFound();
    }
    connectorId = summary.connector_id;
    connectionId = summary.connection_id;
    connectorInstanceId = connectorInstanceIdForConnection(summary);
    manifest =
      manifests.find((m) => m.connector_id === connectorId) ??
      ({
        connector_id: connectorId,
        display_name: summary.connector_display_name ?? summary.display_name,
        name: summary.connector_display_name ?? summary.display_name,
        streams: summary.streams.map((name) => ({ name })),
      } satisfies ConnectorManifest);
    streams = await listStreams(connectorId, { connectorInstanceId });
    overview = toConnectorOverview(summary, streams);
    const runsResp = await listRuns({ connector_id: connectorId, limit: RECENT_RUNS_LIMIT });
    recentRuns = runsResp.data ?? [];

    // Diagnostics evidence. Each branch is independently failable so a
    // device-exporter outage cannot suppress schedule data, and vice
    // versa. Failures surface as honest "unavailable" tooltips rather
    // than silently zeroing the section.
    const [scheduleResult, sourcesResult] = await Promise.allSettled([
      getConnectorSchedule(connectorId, { connectorInstanceId: connectorInstanceId ?? undefined }),
      listDeviceExporterSourceInstances({ connector_instance_id: connectorInstanceId ?? undefined }),
    ]);
    connectionHealth = summary.connection_health ?? null;
    if (scheduleResult.status === "fulfilled") {
      schedule = scheduleResult.value;
    } else {
      scheduleError = errorMessage(scheduleResult.reason);
    }
    if (sourcesResult.status === "fulfilled") {
      sourceInstances = sourcesResult.value.data.filter((s) => s.connector_id === connectorId);
    } else {
      sourceInstancesError = errorMessage(sourcesResult.reason);
    }
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

  const totalRecords = streams.reduce((sum, s) => sum + s.record_count, 0);
  // Prefer the connection's owner-meaningful `display_name` so an owner
  // rename via PATCH /_ref/connections/:id surfaces on the detail title.
  // Falls back to the connector-type label, then the connector id.
  const displayName = summary.display_name ?? manifest.display_name ?? manifest.name ?? connectorId;
  const running = overview?.isRunning ?? false;
  // Source instances surface the device(s) that fed this connection. For
  // filesystem-class collectors (claude_code, codex), the same connector
  // type can be active on multiple devices; without these labels, two
  // claude_code instances are visually indistinguishable.
  const { deviceLabels, pendingOnDevices } = summarizeSourceInstancesForHeader(sourceInstances);
  const headerCount = formatConnectorHeaderCount({
    pendingOnDevices,
    streamCount: streams.length,
    totalRecords,
  });

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <>
            {running && overview?.lastRun ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={`/dashboard/runs/${encodeURIComponent(overview.lastRun.run_id)}`}
              >
                Active run →
              </Link>
            ) : null}
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              href={`/dashboard/runs?connector_id=${encodeURIComponent(connectorId)}`}
            >
              All runs →
            </Link>
            <SyncNowButton
              connectionId={connectorInstanceId}
              connectorId={connectorId}
              displayName={displayName}
              initialRunning={running}
            />
            <RenameConnectionButton connectionId={connectionId} currentDisplayName={displayName} />
          </>
        }
        breadcrumbs={[{ label: "Records", href: "/dashboard/records" }, { label: displayName }]}
        count={headerCount}
        description={
          <ConnectionIdentityLine
            connectionId={connectionId}
            connectorId={connectorId}
            deviceLabels={deviceLabels}
            providerId={manifest.provider_id ?? null}
          />
        }
        title={displayName}
      />

      <ConnectionDiagnostics
        connectionHealth={connectionHealth}
        schedule={schedule}
        scheduleError={scheduleError}
        sourceInstances={sourceInstances}
        sourceInstancesError={sourceInstancesError}
      />

      <Section title={`Streams (${streams.length})`}>
        {streams.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">
            No records for this connector yet. Click Sync now to pull your first data.
          </p>
        ) : (
          <DataList>
            {streams.map((s) => (
              <li key={s.name}>
                <Link
                  className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  href={`/dashboard/records/${encodeURIComponent(connectionId)}/${encodeURIComponent(s.name)}`}
                >
                  <span className="pdpp-body break-all font-medium font-mono">{s.name}</span>
                  <span className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums">
                    <span>{s.record_count.toLocaleString()} records</span>
                    {s.last_updated ? (
                      <>
                        <span aria-hidden>·</span>
                        <Timestamp value={s.last_updated} />
                      </>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>

      <Section
        description="Each run is an artifact you can inspect. Click through for the full trace."
        title={`Recent runs (${recentRuns.length})`}
      >
        {recentRuns.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">No runs yet for this connector.</p>
        ) : (
          <DataList>
            {recentRuns.map((r) => (
              <li key={r.run_id}>
                <Link
                  className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  href={`/dashboard/runs/${encodeURIComponent(r.run_id)}`}
                >
                  <span className="pdpp-caption flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    <span className="font-mono text-muted-foreground text-xs">{r.run_id}</span>
                  </span>
                  <span className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums">
                    <Timestamp value={r.first_at} />
                    <span aria-hidden>·</span>
                    <span>{durationLabel(r.first_at, r.last_at)}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {r.event_count.toLocaleString()} event{r.event_count === 1 ? "" : "s"}
                    </span>
                    {r.failure_reason ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="text-destructive">{r.failure_reason}</span>
                      </>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>
    </DashboardShell>
  );
}

/**
 * Identity line under the connector title. Surfaces:
 * - the durable `connection_id` (also the records-route key);
 * - the connector type when it differs from the connection id (legacy single-instance rows);
 * - the manifest's `provider_id` when present;
 * - the bound device label(s) so two filesystem-class instances of the
 *   same connector type are visually distinguishable.
 *
 * Kept as a small helper to keep `ConnectorPage` under the cognitive
 * complexity budget while still rendering JSX inline.
 */
function ConnectionIdentityLine({
  connectionId,
  connectorId,
  deviceLabels,
  providerId,
}: {
  connectionId: string;
  connectorId: string;
  deviceLabels: readonly string[];
  providerId: string | null;
}) {
  return (
    <>
      <code className="font-mono text-xs">{connectionId}</code>
      {connectionId === connectorId ? null : (
        <>
          {" · "}
          <span>Type: {connectorId}</span>
        </>
      )}
      {providerId ? (
        <>
          {" · "}
          <span>Provider: {providerId}</span>
        </>
      ) : null}
      {deviceLabels.length > 0 ? (
        <>
          {" · "}
          <span data-testid="records-device-labels">
            Device{deviceLabels.length === 1 ? "" : "s"}: {deviceLabels.join(", ")}
          </span>
        </>
      ) : null}
    </>
  );
}

function summarizeSourceInstancesForHeader(sourceInstances: readonly DeviceSourceInstance[]): {
  deviceLabels: string[];
  pendingOnDevices: number;
} {
  const deviceLabels: string[] = [];
  let pendingOnDevices = 0;
  for (const source of sourceInstances) {
    const label = source.display_name ?? source.local_binding_name ?? source.device_id;
    if (typeof label === "string" && label.length > 0) {
      deviceLabels.push(label);
    }
    if (typeof source.records_pending === "number") {
      pendingOnDevices += source.records_pending;
    }
  }
  return { deviceLabels, pendingOnDevices };
}

function formatConnectorHeaderCount({
  pendingOnDevices,
  streamCount,
  totalRecords,
}: {
  pendingOnDevices: number;
  streamCount: number;
  totalRecords: number;
}): string {
  const streamLabel = `${streamCount} stream${streamCount === 1 ? "" : "s"}`;
  const base = `${totalRecords.toLocaleString()} records · ${streamLabel}`;
  if (pendingOnDevices > 0) {
    return `${base} · +${pendingOnDevices.toLocaleString()} pending on devices`;
  }
  return base;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

function durationLabel(firstAt: string, lastAt: string): string {
  const a = Date.parse(firstAt);
  const b = Date.parse(lastAt);
  if (!(Number.isFinite(a) && Number.isFinite(b)) || b < a) {
    return "—";
  }
  const ms = b - a;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) {
    return `${secs}s`;
  }
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

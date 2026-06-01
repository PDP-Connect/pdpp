import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import {
  formatConnectorKeyForDisplay,
  formatConnectorNameForDisplay,
  isFallbackConnectionLabel,
} from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { derivePrimaryRowAction, type PrimaryRowAction } from "../../lib/connection-evidence.ts";
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
import { RenameConnection } from "./rename-connection.tsx";
import { SyncNowButton } from "./sync-now-button.tsx";

export const dynamic = "force-dynamic";

const RECENT_RUNS_LIMIT = 10;

interface ConnectorPageModel {
  connectionHealth: RefConnectionHealthSnapshot | null;
  connectionId: string;
  /**
   * The owner-set `display_name` to seed the rename field, or "" when the
   * current label is a fallback (bare connector type / registry URL) so the
   * operator starts blank instead of re-typing a meaningless default.
   */
  connectionLabelSeed: string;
  connectorId: string;
  connectorInstanceId: string | null;
  deviceLabels: string[];
  displayName: string;
  headerCount: string;
  manifest: ConnectorManifest;
  overview: ConnectorOverview;
  recentRuns: RunSummary[];
  schedule: RefSchedule | null;
  scheduleError: string | null;
  sourceInstances: DeviceSourceInstance[];
  sourceInstancesError: string | null;
  streams: StreamSummary[];
  totalRecords: number;
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

  let model: ConnectorPageModel;
  try {
    model = await loadConnectorPageModel(routeId);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Connections" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  return <ConnectorPageView model={model} />;
}

async function loadConnectorPageModel(routeId: string): Promise<ConnectorPageModel> {
  const [summary, manifests] = await Promise.all([resolveConnectionForRecordsRoute(routeId), listConnectorManifests()]);
  if (!summary) {
    notFound();
  }

  const connectorId = summary.connector_id;
  const connectionId = summary.connection_id;
  const connectorInstanceId = connectorInstanceIdForConnection(summary);
  const manifest =
    manifests.find((m) => m.connector_id === connectorId) ??
    ({
      connector_id: connectorId,
      display_name: summary.connector_display_name ?? summary.display_name,
      name: summary.connector_display_name ?? summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    } satisfies ConnectorManifest);
  const streams = await listStreams(connectorId, { connectorInstanceId });
  const overview = toConnectorOverview(summary, streams);
  const runsResp = await listRuns({ connector_id: connectorId, limit: RECENT_RUNS_LIMIT });
  const recentRuns = runsResp.data ?? [];

  const diagnostics = await loadConnectorDiagnostics(connectorId, connectorInstanceId);
  const totalRecords = streams.reduce((sum, s) => sum + s.record_count, 0);
  const displayName = formatConnectorNameForDisplay({
    connectorId,
    displayName: manifest.display_name,
    name: manifest.name,
  });
  // Source instances surface the device(s) that fed this connection. For
  // filesystem-class collectors (claude_code, codex), the same connector
  // type can be active on multiple devices; without these labels, two
  // claude_code instances are visually indistinguishable.
  const { deviceLabels, pendingOnDevices } = summarizeSourceInstancesForHeader(diagnostics.sourceInstances);
  const headerCount = formatConnectorHeaderCount({
    pendingOnDevices,
    streamCount: streams.length,
    totalRecords,
  });
  // Seed the rename field with the owner-set label only. A fallback label
  // (bare connector type / registry URL) seeds blank so the operator names
  // the connection from scratch rather than editing a meaningless default.
  const connectionLabelSeed = isFallbackConnectionLabel({
    connectorId,
    displayName: summary.display_name,
    name: summary.connector_display_name,
  })
    ? ""
    : (summary.display_name ?? "");

  return {
    connectionHealth: summary.connection_health ?? null,
    connectionId,
    connectorId,
    connectorInstanceId,
    connectionLabelSeed,
    deviceLabels,
    displayName,
    headerCount,
    manifest,
    overview,
    recentRuns,
    streams,
    totalRecords,
    ...diagnostics,
  };
}

async function loadConnectorDiagnostics(
  connectorId: string,
  connectorInstanceId: string | null
): Promise<{
  schedule: RefSchedule | null;
  scheduleError: string | null;
  sourceInstances: DeviceSourceInstance[];
  sourceInstancesError: string | null;
}> {
  let schedule: RefSchedule | null = null;
  let scheduleError: string | null = null;
  let sourceInstances: DeviceSourceInstance[] = [];
  let sourceInstancesError: string | null = null;

  // Diagnostics evidence. Each branch is independently failable so a
  // device-exporter outage cannot suppress schedule data, and vice versa.
  const [scheduleResult, sourcesResult] = await Promise.allSettled([
    getConnectorSchedule(connectorId, { connectorInstanceId: connectorInstanceId ?? undefined }),
    listDeviceExporterSourceInstances({ connector_instance_id: connectorInstanceId ?? undefined }),
  ]);
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

  return { schedule, scheduleError, sourceInstances, sourceInstancesError };
}

function ConnectorPageView({ model }: { model: ConnectorPageModel }) {
  const {
    connectionHealth,
    connectionId,
    connectorId,
    connectorInstanceId,
    connectionLabelSeed,
    deviceLabels,
    displayName,
    headerCount,
    manifest,
    overview,
    recentRuns,
    schedule,
    scheduleError,
    sourceInstances,
    sourceInstancesError,
    streams,
  } = model;
  const running = overview.isRunning;
  // Stable rename selector: prefer the explicit instance id, fall back to the
  // connection id. Both address the same connection on the backend route.
  const renameSelector = connectorInstanceId ?? connectionId;
  // The detail-page primary action is modality-aware for the same reason the
  // records row is (`derivePrimaryRowAction`): existing owner-runnable
  // connections get Sync now, while push-mode local-collector connections render
  // non-clickable guidance because the dashboard cannot remotely pull from the
  // operator's device. Same shared classifier as the row: one source of truth,
  // no scattered string checks.
  const primaryAction = derivePrimaryRowAction({
    connectorId,
    hasLocalDeviceProgress: Boolean(overview.localDeviceProgress),
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
            {primaryAction.kind === "sync" ? (
              <SyncNowButton
                connectionId={connectorInstanceId}
                connectorId={connectorId}
                displayName={displayName}
                initialRunning={running}
              />
            ) : (
              <PrimaryActionNotice action={primaryAction} />
            )}
            <RenameConnection
              connectionId={renameSelector}
              currentLabel={connectionLabelSeed}
              typeName={formatConnectorKeyForDisplay(connectorId)}
            />
          </>
        }
        breadcrumbs={[{ label: "Connections", href: "/dashboard/records" }, { label: displayName }]}
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
        connectionId={connectorInstanceId ?? connectionId}
        localDeviceProgress={overview.localDeviceProgress ?? null}
        schedule={schedule}
        scheduleError={scheduleError}
        sourceInstances={sourceInstances}
        sourceInstancesError={sourceInstancesError}
      />

      <Section title={`Streams (${streams.length})`}>
        {streams.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">{emptyStreamsHint(primaryAction)}</p>
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
 * Empty-streams hint, keyed on the same modality as the header action so a
 * push-mode connection is never told to "Click Sync now" - a button it does not
 * have. Owner-runnable connections keep the original copy.
 */
function emptyStreamsHint(action: PrimaryRowAction): string {
  if (action.kind === "sync") {
    return "No records for this connector yet. Click Sync now to pull your first data.";
  }
  return "No records yet. This connection fills in when its local-collector device pushes data; the dashboard cannot start a run.";
}

/**
 * Honest non-clickable primary action for a connection that cannot be synced
 * from the dashboard. Mirrors the records row's `PrimaryRowActionControl`
 * non-sync branch: push-mode (local-collector) connections show a "waiting for
 * the local device" status. Inert text, never a `<button>`, so it can never
 * reach `runConnectorNowAction`.
 */
function PrimaryActionNotice({ action }: { action: Exclude<PrimaryRowAction, { kind: "sync" }> }) {
  return (
    <span
      className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
      data-testid="detail-action-device-wait"
      title={action.detail}
    >
      {action.label}
    </span>
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
      <span className="inline-flex items-center gap-1 align-middle" data-testid="connection-id-disclosure">
        <code className="font-mono text-xs">{connectionId}</code>
        <CopyButton ariaLabel="Copy connection ID" value={connectionId} />
      </span>
      {connectionId === connectorId ? null : (
        <>
          {" · "}
          <span>Type: {formatConnectorKeyForDisplay(connectorId)}</span>
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

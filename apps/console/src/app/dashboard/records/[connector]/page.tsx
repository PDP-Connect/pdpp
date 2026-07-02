import { buttonVariants, IcTimestamp } from "@pdpp/brand-react";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import {
  formatConnectorKeyForDisplay,
  formatConnectorNameForDisplay,
  isFallbackConnectionLabel,
} from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  canonicalConnectorKey,
  manualUploadSetupFromManifest,
  staticSecretCredentialCaptureFromManifest,
} from "pdpp-reference-implementation/connection-setup-plan";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/shell.tsx";
import {
  formatStreamCollectionFacts,
  indexCollectionReportByStream,
  runStatusWithCollectionReportGaps,
  type StreamCollectionFacts,
} from "../../lib/collection-report.ts";
import {
  type AutoPausedBanner,
  deriveAutoPausedBanner,
  derivePrimaryRowAction,
  deriveStreakDots,
  type PrimaryRowAction,
  type StreakDot,
  summarizeStreakDots,
  syncActionIdleLabel,
} from "../../lib/connection-evidence.ts";
import { isBrowserBoundConnector } from "../../lib/connection-modality.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { isRevokedConnection } from "../../lib/records-list-classification.ts";
import {
  type DeviceSourceInstance,
  getConnectorSchedule,
  listDeviceExporterSourceInstances,
  type RefAcquisitionBatchSummary,
  type RefAcquisitionCoverageSummary,
  type RefCollectionReportEntry,
  type RefConnectionHealthSnapshot,
  type RefConnectorRunSummary,
  type RefConnectorSummary,
  type RefRenderedVerdict,
  type RefRequiredAction,
  type RefSchedule,
  type RunSummary,
} from "../../lib/ref-client.ts";
import {
  type ConnectorManifest,
  type ConnectorOverview,
  listConnectorManifests,
  type StreamSummary,
} from "../../lib/rs-client.ts";
import {
  projectSourceActionability,
  type SourceStreamOwnerActionAvailability,
} from "../../lib/source-actionability.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../connection-route.ts";
import { findManifestForConnectorId } from "../lib/relationships.ts";
import { ConnectionDangerZone } from "./connection-danger-zone.tsx";
import { ConnectionDiagnostics } from "./connection-diagnostics.tsx";
import { RenameConnection } from "./rename-connection.tsx";
import { StreamCollectionFactsLine } from "./stream-collection-facts.tsx";
import { SyncNowButton } from "./sync-now-button.tsx";

export const dynamic = "force-dynamic";

function addSourceHrefForConnector(connectorId: string): string {
  return `/dashboard/records/add?source_q=${encodeURIComponent(connectorId)}`;
}

/**
 * Build the "Update credential" / "Repair" href for an existing static-secret
 * connection. Reuses the same setup form in replace-credential mode, preserving
 * connection_id, records, history, and schedule.
 */
function updateCredentialHref(connectorId: string, connectionId: string): string {
  const key = canonicalConnectorKey(connectorId);
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/dashboard/connect/static-secret/${encodeURIComponent(key)}?${params.toString()}`;
}

/**
 * Build the "Reconnect" href for a browser-bound connection that needs
 * re-authentication. Uses the browser-session connect page in repair mode
 * (?connectionId=<existing>), so the owner's records, history, and schedule
 * are preserved (Plaid update-mode equivalent).
 */
function browserSessionReconnectHref(connectorId: string, connectionId: string): string {
  const key = canonicalConnectorKey(connectorId);
  const params = new URLSearchParams({ connectionId });
  return `/dashboard/connect/browser-session/${encodeURIComponent(key)}?${params.toString()}`;
}

function manualUploadHrefForConnection(
  connectorId: string,
  connectionId: string,
  manifest: ConnectorManifest
): string | null {
  const setup = manualUploadSetupFromManifest(manifest);
  if (!setup?.importDirEnvVar) {
    return null;
  }
  const connectorKey = canonicalConnectorKey(connectorId);
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/dashboard/connect/manual-upload/${encodeURIComponent(connectorKey)}?${params.toString()}`;
}

interface ConnectorPageModel {
  /**
   * Per-stream collection facts derived from the connection summary's
   * `collection_report`, keyed by stream name. Empty when the reference did not
   * return a report (a reference predating
   * `define-connector-progress-evidence-contract`), so the Streams section
   * renders exactly as before in that case.
   */
  collectionFactsByStream: Map<string, StreamCollectionFacts>;
  collectionOwnerActionByStream: SourceStreamOwnerActionAvailability;
  connectionHealth: RefConnectionHealthSnapshot | null;
  connectionId: string;
  /**
   * The owner-set `display_name` to seed the rename field, or "" when the
   * current label is a fallback (bare connector type / registry URL) so the
   * operator starts blank instead of re-typing a meaningless default.
   */
  connectionLabelSeed: string;
  connectionPrimaryAction: RefRequiredAction | null;
  connectionRenderedVerdict: RefRenderedVerdict | null;
  connectorId: string;
  connectorInstanceId: string | null;
  deviceLabels: string[];
  displayName: string;
  headerCount: string;
  manifest: ConnectorManifest;
  manualUploadHref: string | null;
  overview: ConnectorOverview;
  /** Public reference origin, for resolving `<provider-url>` in remediation
   *  command templates. `null` when unavailable → command fails closed. */
  providerOrigin: string | null;
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

function toRunSummaryForConnection(
  connectorId: string,
  connectionId: string,
  summary: RefConnectorRunSummary | null,
  collectionReport: readonly RefCollectionReportEntry[] | null | undefined
): RunSummary | null {
  if (!summary) {
    return null;
  }
  const status = runStatusWithCollectionReportGaps(summary.status, collectionReport);
  return {
    connection_id: connectionId,
    connector_id: connectorId,
    connector_instance_id: connectionId,
    event_count: summary.event_count,
    failure_reason: summary.failure_reason,
    first_at: summary.first_at,
    grant_id: null,
    kinds: [],
    last_at: summary.last_at,
    needs_input: false,
    object: "run_summary",
    run_id: summary.run_id,
    status,
  };
}

function connectionRecentRuns(summary: RefConnectorSummary): RunSummary[] {
  const reportRunId = summary.last_run?.run_id ?? null;
  const collectionReport = summary.collection_report ?? null;
  const byId = new Map<string, RunSummary>();
  for (const run of [
    toRunSummaryForConnection(summary.connector_id, summary.connection_id, summary.last_run, collectionReport),
    toRunSummaryForConnection(
      summary.connector_id,
      summary.connection_id,
      summary.last_successful_run,
      summary.last_successful_run?.run_id === reportRunId ? collectionReport : null
    ),
  ]) {
    if (run) {
      byId.set(run.run_id, run);
    }
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at));
}

function toConnectorOverview(summary: RefConnectorSummary, streams: StreamSummary[]): ConnectorOverview {
  const lastRun = toConnectorRunRef(summary.last_run);
  const lastSuccessfulRun = toConnectorRunRef(summary.last_successful_run);
  return {
    acquisitionCoverage: summary.acquisition_coverage ?? null,
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
    streams,
    streamCount: summary.stream_count,
    retainedBytes: summary.retained_bytes ?? null,
    revokedAt: summary.revoked_at ?? null,
    totalRetainedBytes: summary.total_retained_bytes,
    totalRecords: summary.total_records,
    localDeviceProgress: summary.local_device_progress ?? null,
    lastRun,
    lastSuccessfulRun,
    isRunning: lastRun != null && new Set(["started", "in_progress"]).has(lastRun.status),
  };
}

function streamsFromConnectorSummary(summary: RefConnectorSummary): StreamSummary[] {
  const recordsByStream = new Map((summary.stream_records ?? []).map((record) => [record.stream, record]));
  const orderedNames = new Set<string>();
  const streams: StreamSummary[] = [];

  const pushStream = (name: string) => {
    if (orderedNames.has(name)) {
      return;
    }
    orderedNames.add(name);
    const record = recordsByStream.get(name);
    streams.push({
      name,
      object: "stream",
      record_count: Number(record?.record_count ?? 0),
      last_updated: record?.last_updated ?? null,
    });
  };

  // Preserve manifest/source order for known streams, then append live-only
  // streams from the retained-size projection. Local collectors can retain
  // streams before the committed manifest catches up; hiding those rows makes
  // the owner think records disappeared.
  for (const name of summary.streams) {
    pushStream(name);
  }
  for (const record of summary.stream_records ?? []) {
    pushStream(record.stream);
  }
  return streams;
}

export default async function ConnectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string }>;
  searchParams: Promise<{ demo?: string; error?: string; message?: string }>;
}) {
  const { connector } = await params;
  const routeId = decodeURIComponent(connector);
  const sp = await searchParams;

  let model: ConnectorPageModel;
  if (process.env.NODE_ENV !== "production" && sp.demo === "atlas") {
    model = buildRecoveryDemoModel();
  } else {
    try {
      model = await loadConnectorPageModel(routeId);
    } catch (err) {
      if (err instanceof ReferenceServerUnreachableError) {
        return (
          <RecordroomShellWithPalette>
            <PageHeader title="Sources" />
            <ServerUnreachable />
          </RecordroomShellWithPalette>
        );
      }
      throw err;
    }
  }

  return <ConnectorPageView dangerError={sp.error} dangerMessage={sp.message} model={model} />;
}

function buildRecoveryDemoModel(): ConnectorPageModel {
  const connectionId = "cin_demo_claude_code_workstation";
  const run = {
    connection_id: connectionId,
    connector_id: "claude_code",
    connector_instance_id: connectionId,
    event_count: 14,
    failure_reason: "local collector outbox has dead-lettered rows",
    first_at: "2026-07-01T11:15:00.000Z",
    grant_id: null,
    kinds: ["messages"],
    last_at: "2026-07-01T11:18:00.000Z",
    needs_input: false,
    object: "run_summary" as const,
    run_id: "run_demo_recovery",
    status: "failed",
  };
  const streams: StreamSummary[] = [
    {
      last_updated: "2026-07-01T10:40:00.000Z",
      name: "messages",
      object: "stream",
      record_count: 428,
    },
    {
      last_updated: "2026-06-30T17:12:00.000Z",
      name: "sessions",
      object: "stream",
      record_count: 36,
    },
  ];
  const collectionReport: RefCollectionReportEntry[] = [
    {
      checkpoint: "committed",
      collected: 24,
      considered: 27,
      coverage_condition: "retryable_gap",
      covered: 24,
      forward_disposition: "resumable",
      pending_detail_gaps: 3,
      skipped: null,
      stream: "messages",
    },
  ];
  const collectionFactsByStream = new Map<string, StreamCollectionFacts>(
    collectionReport.map((entry) => [entry.stream, formatStreamCollectionFacts(entry)])
  );
  const renderedVerdict: RefRenderedVerdict = {
    annotations: [{ kind: "freshness", text: "collector checked in 12 minutes ago" }],
    channel: "attention",
    detail: { suppressed: [] },
    forward_statement: "The local collector has saved records that did not upload to this server.",
    pill: { label: "Can't collect", tone: "red" },
    progress: {
      gaps_drained_last_run: null,
      headline: "3 local rows need recovery before collection can resume.",
      last_refreshed_at: "2026-07-01T12:00:00.000Z",
      mode: "local_device",
      records_committed_last_run: 24,
      retained_records: 464,
    },
    required_actions: [
      {
        affects: ["messages"],
        audience: "owner",
        cta: "See recovery steps",
        kind: "retry_gap",
        remediation: {
          cause: "dead_letter_backlog",
          commands: [
            {
              command_template: "pdpp local-collector doctor --source <source-instance-id>",
              kind: "local_collector_doctor",
              label: "Inspect the local queue",
            },
            {
              command_template: "pdpp local-collector retry --source <source-instance-id>",
              kind: "local_collector_retry_dead_letters_apply",
              label: "Retry failed rows",
            },
          ],
          kind: "local_collector_recovery",
          label: "Recover local collector outbox",
          summary: "Run these on the workstation that owns this source.",
          target: { identity_source: "source_instance_bindings", kind: "local_device" },
        },
        satisfied_when: { kind: "gap_recovered" },
        terminal: false,
        urgency: "now",
      },
    ],
    streams: [
      {
        action_ref: 0,
        collected: 24,
        considered: 27,
        coverage: "retryable_gap",
        disposition: "resumable",
        statement: "24 collected; 3 local rows need retry.",
        stream_id: "messages",
      },
    ],
    trace: { demo: true },
  };
  const connectionHealth: RefConnectionHealthSnapshot = {
    axes: {
      attention: "open",
      coverage: "retryable_gap",
      freshness: "stale",
      outbox: "stalled",
    },
    badges: { stale: true, syncing: false },
    conditions: [
      {
        current: true,
        expires_at: null,
        id: "cond_demo_dead_letter",
        message: "The local collector reported dead-lettered rows.",
        observed_at: "2026-07-01T11:58:00.000Z",
        origin: "local_collector",
        reason: "dead_letter_backlog",
        remediation: {
          action: "retry_local_outbox",
          label: "Retry local outbox",
          retryable: true,
          target: "source_instance",
        },
        sensitivity: "owner",
        severity: "blocked",
        status: "true",
        type: "local_collector_dead_letter",
      },
    ],
    detail_gap_backlog: {
      max_attempt_count: 6,
      next_attempt_at: null,
      pending: 3,
      pending_is_floor: false,
      recovered: 0,
      terminal: 0,
    },
    dominant_condition_id: "cond_demo_dead_letter",
    forward_disposition: "awaiting_owner",
    last_success_at: "2026-07-01T10:40:00.000Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: "local_collector_dead_letter",
    state: "needs_attention",
    supporting_condition_ids: ["cond_demo_dead_letter"],
    unknown_reasons: [],
  };
  const sourceInstances: DeviceSourceInstance[] = [
    {
      accepted_record_count: 464,
      connector_id: "claude_code",
      connector_instance_id: connectionId,
      created_at: "2026-06-24T12:00:00.000Z",
      device_id: "device_demo_workstation",
      display_name: "workstation",
      last_error: null,
      last_heartbeat_at: "2026-07-01T11:58:00.000Z",
      last_heartbeat_status: "ok",
      last_ingest_at: "2026-07-01T10:40:00.000Z",
      local_binding_name: "workstation",
      object: "device_source_instance",
      outbox_diagnostics: { dead_letter: 3, pending: 3, total: 27 },
      outbox_state: "dead_letter",
      records_pending: 3,
      rejected_record_count: 3,
      source_instance_id: "src_demo_workstation",
    },
  ];
  const overview = {
    collectionReport,
    connectionHealth,
    connectionId,
    connectionStatus: "active",
    connector: {
      connector_id: "claude_code",
      display_name: "Claude Code",
      name: "Claude Code",
      streams: [{ name: "messages" }, { name: "sessions" }],
    },
    connectorDisplayName: "Claude Code",
    connectorInstanceId: connectionId,
    isRunning: false,
    lastRun: toConnectorRunRef({
      event_count: run.event_count,
      failure_reason: run.failure_reason,
      finished_at: "2026-07-01T11:18:00.000Z",
      first_at: run.first_at,
      last_at: run.last_at,
      run_id: run.run_id,
      started_at: run.first_at,
      status: run.status,
    }),
    lastSuccessfulRun: toConnectorRunRef({
      event_count: 8,
      failure_reason: null,
      finished_at: "2026-07-01T10:40:00.000Z",
      first_at: "2026-07-01T10:39:00.000Z",
      last_at: "2026-07-01T10:40:00.000Z",
      run_id: "run_demo_previous_success",
      started_at: "2026-07-01T10:39:00.000Z",
      status: "succeeded",
    }),
    localDeviceProgress: {
      last_heartbeat_at: "2026-07-01T11:58:00.000Z",
      last_heartbeat_status: "ok",
      last_ingest_at: "2026-07-01T10:40:00.000Z",
      outbox_counts: { dead_letter: 3, pending: 3, total: 27 },
      records_pending: 3,
      source_count: 1,
    },
    streams,
    streamCount: streams.length,
    totalRecords: 464,
    totalRetainedBytes: null,
  };
  return {
    collectionFactsByStream,
    collectionOwnerActionByStream: { messages: true, sessions: true },
    connectionHealth,
    connectionId,
    connectionLabelSeed: "Claude Code workstation",
    connectionPrimaryAction: renderedVerdict.required_actions[0] ?? null,
    connectionRenderedVerdict: renderedVerdict,
    connectorId: "claude_code",
    connectorInstanceId: connectionId,
    deviceLabels: ["workstation"],
    displayName: "Claude Code workstation",
    headerCount: "464 records, 2 streams",
    manifest: {
      connector_id: "claude_code",
      display_name: "Claude Code",
      name: "Claude Code",
      streams: [{ name: "messages" }, { name: "sessions" }],
    },
    manualUploadHref: null,
    overview,
    providerOrigin: "https://pdpp.example.test",
    recentRuns: [run],
    schedule: null,
    scheduleError: null,
    sourceInstances,
    sourceInstancesError: null,
    streams,
    totalRecords: 464,
  };
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
    findManifestForConnectorId(manifests, connectorId) ??
    ({
      connector_id: connectorId,
      display_name: summary.connector_display_name ?? summary.display_name,
      name: summary.connector_display_name ?? summary.display_name,
      streams: summary.streams.map((name) => ({ name })),
    } satisfies ConnectorManifest);
  // The scoped connector summary already carries the retained-size read-model
  // stream projection. Do not call `/v1/streams` here: for high-volume local
  // sources that endpoint re-aggregates current records and has been measured
  // at ~4.5s on the owner detail route. The detail page is an owner/control
  // surface, so using the owner-only summary read-model is the SLVP construction
  // boundary: one cheap projection read, no duplicate expensive RS metadata read.
  const streams = streamsFromConnectorSummary(summary);
  const [diagnostics, providerOrigin] = await Promise.all([
    loadConnectorDiagnostics(connectorId, connectorInstanceId),
    // Resolve the public origin to late-bind `<provider-url>` in remediation
    // command templates. Failure → null → the command fails closed (no broken
    // copy-paste command), never throws and breaks the page.
    getReferencePublicOrigin().catch(() => null),
  ]);
  const overview = toConnectorOverview(summary, streams);
  const recentRuns = connectionRecentRuns(summary);
  const totalRecords = summary.total_records;
  // Per-stream collection facts from the reference's derived `collection_report`
  // (absent on references predating the field → empty map → Streams section
  // renders unchanged). Indexed by stream name to join with the resource-server
  // stream list below.
  const collectionFactsByStream = new Map<string, StreamCollectionFacts>();
  for (const [stream, entry] of indexCollectionReportByStream(summary.collection_report)) {
    collectionFactsByStream.set(stream, formatStreamCollectionFacts(entry));
  }
  const actionability = projectSourceActionability(summary);
  const collectionOwnerActionByStream = actionability.ownerActionByStream;
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
    collectionFactsByStream,
    collectionOwnerActionByStream,
    connectionHealth: summary.connection_health ?? null,
    connectionId,
    connectionPrimaryAction: actionability.primaryAction,
    connectionRenderedVerdict: summary.rendered_verdict ?? null,
    connectorId,
    connectorInstanceId,
    connectionLabelSeed,
    deviceLabels,
    displayName,
    headerCount,
    manifest,
    manualUploadHref: manualUploadHrefForConnection(connectorId, connectionId, manifest),
    overview,
    providerOrigin,
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

function ConnectorPageView({
  model,
  dangerMessage,
  dangerError,
}: {
  model: ConnectorPageModel;
  dangerMessage?: string;
  dangerError?: string;
}) {
  const {
    collectionFactsByStream,
    collectionOwnerActionByStream,
    connectionHealth,
    connectionRenderedVerdict,
    connectionId,
    connectionPrimaryAction,
    connectorId,
    connectorInstanceId,
    connectionLabelSeed,
    deviceLabels,
    displayName,
    headerCount,
    manifest,
    manualUploadHref,
    overview,
    providerOrigin,
    recentRuns,
    schedule,
    scheduleError,
    sourceInstances,
    sourceInstancesError,
    streams,
  } = model;
  const running = overview.isRunning;
  const revoked = isRevokedConnection(overview);
  // Stable rename selector: prefer the explicit instance id, fall back to the
  // connection id. Both address the same connection on the backend route.
  const renameSelector = connectorInstanceId ?? connectionId;
  // Static-secret connections support in-place credential update/repair.
  // Use connectorInstanceId when available (same connection the route is tracking).
  // Browser-bound connectors that declare static-secret setup still use this
  // path; browser-session reconnect is only the fallback for browser-bound
  // connectors with no manifest-owned credential-capture surface.
  const staticSecretCapture = staticSecretCredentialCaptureFromManifest(manifest);
  const credentialUpdateHref = (() => {
    if (staticSecretCapture !== null) {
      return updateCredentialHref(connectorId, connectorInstanceId ?? connectionId);
    }
    if (isBrowserBoundConnector(connectorId)) {
      return browserSessionReconnectHref(connectorId, connectorInstanceId ?? connectionId);
    }
    return null;
  })();
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
  const syncIdleLabel = syncActionIdleLabel(overview.lastRun?.status);
  const streakDots = deriveStreakDots(recentRuns);
  const autoPausedBanner = deriveAutoPausedBanner(schedule);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <ConnectorHeaderActions
            connectionId={connectorInstanceId}
            connectionLabelSeed={connectionLabelSeed}
            connectorId={connectorId}
            credentialUpdateHref={credentialUpdateHref}
            displayName={displayName}
            hasStaticSecretCredentialUpdate={staticSecretCapture !== null}
            manualUploadHref={manualUploadHref}
            overview={overview}
            primaryAction={primaryAction}
            renameSelector={renameSelector}
            renderedAction={connectionPrimaryAction}
            revoked={revoked}
            running={running}
            syncIdleLabel={syncIdleLabel}
          />
        }
        breadcrumbs={[{ label: "Sources", href: "/dashboard/records" }, { label: displayName }]}
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

      {streakDots.length > 0 ? <StreakStrip dots={streakDots} /> : null}

      {revoked ? <RevokedConnectionSection connectorId={connectorId} revokedAt={overview.revokedAt ?? null} /> : null}

      <ConnectionDiagnostics
        connectionHealth={connectionHealth}
        connectionId={connectorInstanceId ?? connectionId}
        connectorId={connectorId}
        localDeviceProgress={overview.localDeviceProgress ?? null}
        providerOrigin={providerOrigin}
        renderedVerdict={connectionRenderedVerdict}
        schedule={schedule}
        scheduleError={scheduleError}
        sourceInstances={sourceInstances}
        sourceInstancesError={sourceInstancesError}
      />

      <AcquisitionCoverageSection
        connectionId={connectorInstanceId ?? connectionId}
        coverage={overview.acquisitionCoverage ?? null}
      />

      <Section
        description={
          collectionFactsByStream.size > 0
            ? "Record counts show what this source currently retains. Coverage and next-run disposition come from the latest collection report; an unknown denominator reads unknown, never complete."
            : undefined
        }
        title={`Streams (${streams.length})`}
      >
        {streams.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">{emptyStreamsHint(primaryAction, syncIdleLabel)}</p>
        ) : (
          <DataList>
            {streams.map((s) => {
              const facts = collectionFactsByStream.get(s.name) ?? null;
              const ownerActionAvailable = collectionOwnerActionByStream[s.name] ?? true;
              return (
                <li key={s.name}>
                  <Link
                    className={`flex flex-col gap-1 px-3 pt-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${
                      facts ? "pb-2" : "pb-3"
                    }`}
                    href={`/dashboard/records/${encodeURIComponent(connectionId)}/${encodeURIComponent(s.name)}`}
                  >
                    <span className="pdpp-body break-all font-medium font-mono">{s.name}</span>
                    <span className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums">
                      <span>{s.record_count.toLocaleString()} records</span>
                      {s.last_updated ? (
                        <>
                          <span aria-hidden>·</span>
                          <IcTimestamp value={s.last_updated} />
                        </>
                      ) : null}
                    </span>
                  </Link>
                  {facts ? (
                    <div className="px-3 pb-3">
                      <StreamCollectionFactsLine facts={facts} ownerActionAvailable={ownerActionAvailable} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </DataList>
        )}
      </Section>

      <RecentRunsSection autoPausedBanner={autoPausedBanner} connectorId={connectorId} recentRuns={recentRuns} />

      <ConnectionDangerZone
        connectionId={connectorInstanceId ?? connectionId}
        error={dangerError}
        message={dangerMessage}
      />
    </RecordroomShellWithPalette>
  );
}

function ConnectorHeaderActions({
  connectionId,
  connectionLabelSeed,
  connectorId,
  credentialUpdateHref,
  displayName,
  hasStaticSecretCredentialUpdate,
  manualUploadHref,
  overview,
  primaryAction,
  renameSelector,
  renderedAction,
  revoked,
  running,
  syncIdleLabel,
}: {
  connectionId: string | null;
  connectionLabelSeed: string;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  hasStaticSecretCredentialUpdate: boolean;
  manualUploadHref: string | null;
  overview: ConnectorOverview;
  primaryAction: PrimaryRowAction;
  renameSelector: string;
  renderedAction: RefRequiredAction | null;
  revoked: boolean;
  running: boolean;
  syncIdleLabel: string;
}) {
  return (
    <>
      {running && overview.lastRun ? (
        <Link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          href={`/dashboard/runs/${encodeURIComponent(overview.lastRun.run_id)}`}
        >
          Active run →
        </Link>
      ) : null}
      <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/runs">
        All runs →
      </Link>
      {/* Update credential: visible on static-secret connections so the owner can
          rotate credentials without breaking the connection. Browser-session
          reconnect remains available only when no stored-credential surface is
          declared for the connector. */}
      {credentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate ? (
        <Link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          href={credentialUpdateHref}
          title="Replace the stored credential for this connection. Records, history, and schedule are preserved."
        >
          Update credential
        </Link>
      ) : null}
      <ConnectorPrimaryHeaderAction
        connectionId={connectionId}
        connectorId={connectorId}
        credentialUpdateHref={credentialUpdateHref}
        displayName={displayName}
        manualUploadHref={manualUploadHref}
        primaryAction={primaryAction}
        renderedAction={renderedAction}
        revoked={revoked}
        running={running}
        syncIdleLabel={syncIdleLabel}
      />
      <RenameConnection
        connectionId={renameSelector}
        currentLabel={connectionLabelSeed}
        typeName={formatConnectorKeyForDisplay(connectorId)}
      />
    </>
  );
}

function ConnectorPrimaryHeaderAction({
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  manualUploadHref,
  primaryAction,
  renderedAction,
  revoked,
  running,
  syncIdleLabel,
}: {
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  manualUploadHref: string | null;
  primaryAction: PrimaryRowAction;
  renderedAction: RefRequiredAction | null;
  revoked: boolean;
  running: boolean;
  syncIdleLabel: string;
}) {
  if (revoked) {
    return (
      <Link
        className={buttonVariants({ variant: "default", size: "sm" })}
        href={addSourceHrefForConnector(connectorId)}
        title="This connection is revoked. Reconnect starts the supported setup path for this source."
      >
        Reconnect
      </Link>
    );
  }
  if (renderedAction) {
    return (
      <RenderedVerdictHeaderAction
        action={renderedAction}
        connectionId={connectionId}
        connectorId={connectorId}
        credentialUpdateHref={credentialUpdateHref}
        displayName={displayName}
        running={running}
      />
    );
  }
  if (primaryAction.kind === "sync") {
    if (manualUploadHref) {
      return (
        <>
          <Link
            className={buttonVariants({ variant: "default", size: "sm" })}
            href={manualUploadHref}
            title="Upload another exported file into this same source. Use Add source only for a different account or identity."
          >
            Add another export
          </Link>
          <SyncNowButton
            connectionId={connectionId}
            connectorId={connectorId}
            displayName={displayName}
            idleLabel="Reprocess all exports"
            initialRunning={running}
            runningLabel="Import running"
            title="Reprocesses files already uploaded for this source. It does not add a new export."
            variant="outline"
          />
        </>
      );
    }
    return (
      <SyncNowButton
        connectionId={connectionId}
        connectorId={connectorId}
        displayName={displayName}
        idleLabel={syncIdleLabel}
        initialRunning={running}
      />
    );
  }
  if (primaryAction.kind === "cooldown_wait") {
    return (
      <CooldownPrimaryAction
        action={primaryAction}
        connectionId={connectionId}
        connectorId={connectorId}
        displayName={displayName}
        running={running}
      />
    );
  }
  return <PrimaryActionNotice action={primaryAction} />;
}

function RenderedVerdictHeaderAction({
  action,
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  running,
}: {
  action: RefRequiredAction;
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  running: boolean;
}) {
  if (action.audience !== "owner" || action.satisfied_when.kind === "none") {
    return (
      <span
        className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
        data-action-audience={action.audience}
        data-action-kind={action.kind}
        data-testid="detail-action-rendered-verdict-status"
        title={action.terminal ? "This action is not owner-repairable." : "The reference is handling this action."}
      >
        {action.cta}
      </span>
    );
  }
  if (action.kind === "reauth") {
    return (
      <Link
        className={buttonVariants({ variant: "default", size: "sm" })}
        data-testid="detail-action-rendered-verdict"
        href={credentialUpdateHref ?? addSourceHrefForConnector(connectorId)}
        title="Reconnect this source while preserving its existing records, history, and schedule when supported."
      >
        {action.cta}
      </Link>
    );
  }
  if (action.kind === "add_info") {
    // A device-local recovery (stalled outbox: the owner runs commands on the
    // host that holds the data) is NOT navigable — there is nothing to click in
    // the dashboard, because the dashboard cannot run a command on the owner's
    // device. Linking it to /runs sends the owner in a circle (detail → runs →
    // detail) chasing a button that can't act. Render it as non-clickable
    // guidance that points to the recovery commands in the diagnostics panel
    // below, the only place the owner can actually act.
    if (action.remediation?.target.kind === "local_device") {
      return (
        <span
          className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
          data-action-kind={action.kind}
          data-action-target="local_device"
          data-testid="detail-action-rendered-verdict-device-local"
          title="Run the recovery commands shown in Diagnostics below, on the host that holds this source's data."
        >
          {action.cta} — see the commands in Diagnostics below
        </span>
      );
    }
    // A non-device add_info genuinely lives on a run (e.g. an OTP/response the
    // owner provides in the run view). There is not yet a connection-scoped
    // Runs filter, so use the neutral Runs surface rather than a connector-type
    // filter that could include sibling sources.
    return (
      <Link
        className={buttonVariants({ variant: "default", size: "sm" })}
        data-testid="detail-action-rendered-verdict"
        href="/dashboard/runs"
        title="Open the run that needs owner input."
      >
        {action.cta}
      </Link>
    );
  }
  return (
    <SyncNowButton
      connectionId={connectionId}
      connectorId={connectorId}
      displayName={displayName}
      idleLabel={action.cta}
      initialRunning={running}
      runningLabel="Repair running"
      title="Runs this source now to satisfy the server-owned required action for the existing connection."
    />
  );
}

function AcquisitionCoverageSection({
  connectionId,
  coverage,
}: {
  connectionId: string;
  coverage: RefAcquisitionCoverageSummary | null;
}) {
  const batches = coverage?.recent_batches ?? [];
  if (batches.length === 0) {
    return null;
  }
  return (
    <Section
      description="Recent acquisition batches for this source. These are coverage receipts, not generic sync status: repeated files, stale exports, and missing optional media stay visible as import facts."
      title="Acquisition coverage"
    >
      <DataList ariaLabel="Acquisition coverage batches">
        {batches.map((batch, index) => (
          <AcquisitionBatchRow batch={batch} connectionId={connectionId} key={batch.batch_id} latest={index === 0} />
        ))}
      </DataList>
    </Section>
  );
}

function AcquisitionBatchRow({
  batch,
  connectionId,
  latest,
}: {
  batch: RefAcquisitionBatchSummary;
  connectionId: string;
  latest: boolean;
}) {
  const lane = acquisitionMethodLabel(batch.acquisition_method);
  const countLabel = acquisitionBatchCountLabel(batch);
  const rangeLabel = acquisitionBatchRangeLabel(batch);
  const mediaLabel = acquisitionMediaCoverageLabel(batch.media_coverage);
  return (
    <li className="px-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="pdpp-body font-medium text-foreground">
            {lane}
            {latest ? <span className="pdpp-caption ml-2 text-muted-foreground">Latest</span> : null}
          </p>
          <p className="pdpp-caption mt-0.5 break-words text-muted-foreground">
            {[batch.uploaded_file_name, batch.detected_format, rangeLabel].filter(Boolean).join(" · ")}
          </p>
          <p className="pdpp-caption mt-1 text-muted-foreground">
            {[batch.status, countLabel, mediaLabel].filter(Boolean).join(" · ")}
          </p>
          {batch.warnings.length > 0 ? (
            <ul className="pdpp-caption mt-2 list-disc space-y-1 pl-4 text-[color:var(--warning)]">
              {batch.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <Link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          href={`/dashboard/connect/status/${encodeURIComponent(connectionId)}`}
        >
          Open receipt
        </Link>
      </div>
    </li>
  );
}

function acquisitionMethodLabel(method: string | null): string {
  switch (method) {
    case "owner_artifact":
      return "Imported export";
    case "device_sync":
      return "Device sync";
    case "device_backup":
      return "Device backup import";
    case "browser_polyfill":
      return "Browser collection";
    case "provider_api":
      return "Provider API window";
    default:
      return method ? method.replaceAll("_", " ") : "Acquisition batch";
  }
}

function acquisitionBatchCountLabel(batch: RefAcquisitionBatchSummary): string | null {
  const parts = [
    countPart(batch.accepted_count, "accepted"),
    countPart(batch.duplicate_count, "duplicate"),
    countPart(batch.skipped_count, "skipped"),
    countPart(batch.failed_count, "failed"),
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  return countPart(batch.parsed_count, "parsed");
}

function countPart(count: number | null, label: string): string | null {
  if (typeof count !== "number" || count <= 0) {
    return null;
  }
  return `${count.toLocaleString()} ${label}`;
}

function acquisitionBatchRangeLabel(batch: RefAcquisitionBatchSummary): string | null {
  if (!(batch.date_range.start || batch.date_range.end)) {
    return null;
  }
  return `${batch.date_range.start ?? "unknown"} to ${batch.date_range.end ?? "unknown"}`;
}

function acquisitionMediaCoverageLabel(mediaCoverage: unknown): string | null {
  if (!mediaCoverage || typeof mediaCoverage !== "object") {
    return null;
  }
  const status = (mediaCoverage as { status?: unknown }).status;
  return typeof status === "string" && status.length > 0 ? `media ${status.replaceAll("_", " ")}` : null;
}

/**
 * Recent runs section with optional auto-paused banner. Extracted to keep
 * `ConnectorPageView` under the cognitive complexity budget while containing
 * the conditional branches needed for the banner and run rows.
 */
function RecentRunsSection({
  autoPausedBanner,
  connectorId,
  recentRuns,
}: {
  autoPausedBanner: AutoPausedBanner | null;
  connectorId: string;
  recentRuns: RunSummary[];
}) {
  return (
    <Section
      description="Only runs already attributed to this source are listed here. Connector-wide runs stay on the Runs page."
      title={`Known source runs (${recentRuns.length})`}
    >
      {recentRuns.length === 0 ? (
        <p className="pdpp-caption text-muted-foreground italic">No attributed runs yet for this source.</p>
      ) : (
        <DataList>
          {autoPausedBanner ? (
            <li data-testid="auto-paused-banner">
              <AutoPausedBannerRow banner={autoPausedBanner} connectorId={connectorId} />
            </li>
          ) : null}
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
                  <IcTimestamp value={r.first_at} />
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
  );
}

/**
 * Empty-streams hint, keyed on the same modality as the header action so a
 * push-mode connection is never told to start a remote run - a button it does
 * not have. Owner-runnable connections use the same idle label as the button,
 * so failed first attempts read as recovery ("Retry sync") instead of a fresh
 * first-time action.
 */
function emptyStreamsHint(action: PrimaryRowAction, syncIdleLabel: string): string {
  if (action.kind === "sync") {
    return `No records for this connector yet. ${syncIdleLabel} to pull your first data.`;
  }
  return "No records yet. This connection fills in when its local-collector device pushes data; the dashboard cannot start a run.";
}

/**
 * Source-pressure cooldown is intentionally not the default sync path: the
 * source has asked PDPP to slow down, so an ordinary run should wait. The owner
 * still gets a separate, named override on the detail page because the backend
 * supports `force: true`; keeping it separate prevents an accidental click from
 * bypassing provider safety.
 */
function CooldownPrimaryAction({
  action,
  connectionId,
  connectorId,
  displayName,
  running,
}: {
  action: Extract<PrimaryRowAction, { kind: "cooldown_wait" }>;
  connectionId: string | null;
  connectorId: string;
  displayName: string;
  running: boolean;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
        data-testid="detail-action-cooldown-wait"
        title={action.detail}
      >
        {action.label}
      </span>
      <SyncNowButton
        connectionId={connectionId}
        connectorId={connectorId}
        displayName={displayName}
        force
        idleLabel="Force run anyway"
        initialRunning={running}
        title="Bypasses the provider-pressure cooldown. Use only if you accept a failed run or more throttling."
        variant="destructive"
      />
    </div>
  );
}

/**
 * Honest non-clickable primary action for a connection that cannot be synced
 * from the dashboard. Mirrors the records row's `PrimaryRowActionControl`
 * non-sync branch: push-mode (local-collector) connections show a "waiting for
 * the local device" status. Inert text, never a `<button>`, so it can never
 * reach `runConnectorNowAction`.
 */
function PrimaryActionNotice({ action }: { action: Exclude<PrimaryRowAction, { kind: "sync" | "cooldown_wait" }> }) {
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

function RevokedConnectionSection({ connectorId, revokedAt }: { connectorId: string; revokedAt: string | null }) {
  return (
    <Section
      description="Future collection is stopped for this connection. Retained records, grants, runs, and audit evidence stay visible; reconnect starts a fresh setup path for this source."
      title="Revoked connection"
    >
      <Link
        className={buttonVariants({ variant: "default", size: "sm" })}
        href={addSourceHrefForConnector(connectorId)}
      >
        Reconnect source
      </Link>
      {revokedAt ? (
        <p className="pdpp-caption mt-3 text-muted-foreground">
          Revoked <IcTimestamp value={revokedAt} />.
        </p>
      ) : null}
    </Section>
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

// ─── Surface 2: 14-day streak strip ──────────────────────────────────────────

function streakDotToneClass(tone: StreakDot["tone"]): string {
  if (tone === "success") {
    return "text-[color:var(--success,theme(colors.emerald.600))]";
  }
  if (tone === "danger") {
    return "text-destructive";
  }
  if (tone === "warning") {
    return "text-[color:var(--warning)]";
  }
  return "text-muted-foreground";
}

/**
 * Compact per-run symbol strip showing the last ≤14 runs at a glance.
 *
 * Design: §B.2 of the mocks. Symbols are ✓ ⚠ ✕ ⊘ ⏸ per decision 8
 * (no sparklines; symbols are scannable and accessible). Renders just below
 * the page header so the operator gets a health fingerprint before diving in.
 */
function StreakStrip({ dots }: { dots: StreakDot[] }) {
  const outcomeLabel = summarizeStreakDots(dots);

  return (
    <div className="flex items-center gap-3 border-border/70 border-b px-4 py-2" data-testid="streak-strip">
      <span className="pdpp-eyebrow text-muted-foreground">Last {dots.length} runs</span>
      <span className="flex items-center gap-1">
        {dots.map((d, i) => (
          <span
            aria-hidden
            className={["font-mono text-sm tabular-nums", streakDotToneClass(d.tone)].join(" ")}
            // biome-ignore lint/suspicious/noArrayIndexKey: positional streak dots have no stable id
            key={i}
            title={`${d.statusLabel} · ${d.at}`}
          >
            {d.symbol}
          </span>
        ))}
      </span>
      <Link className="pdpp-caption ml-auto text-muted-foreground hover:text-foreground" href="/dashboard/runs">
        {outcomeLabel} · Open runs →
      </Link>
    </div>
  );
}

// ─── Surface 3: Auto-paused banner in the run timeline ───────────────────────

/**
 * Amber banner shown at the top of the run timeline when the scheduler has
 * entered back-off after consecutive failures.
 *
 * Design: §D.4 of the mocks. The banner sits above the run rows (before the
 * list), converting a wall of red rows into a legible "the system noticed;
 * here's what it did" moment. The terminal (`blocked`) variant is red-tinted.
 */
function AutoPausedBannerRow({ banner, connectorId }: { banner: AutoPausedBanner; connectorId: string }) {
  const failures = banner.consecutiveFailures;
  const failureNoun = `${failures} consecutive failure${failures === 1 ? "" : "s"}`;
  const reasonSuffix = banner.reasonLabel ? ` of ${banner.reasonLabel}` : "";

  return (
    <div
      className={[
        "mx-4 my-1 rounded px-4 py-3",
        banner.isTerminal
          ? "bg-destructive/10 text-destructive"
          : "bg-[color:var(--warning)]/10 text-[color:var(--warning)]",
      ].join(" ")}
      data-testid="auto-paused-banner-row"
    >
      {banner.isTerminal ? (
        <>
          <span className="pdpp-body font-medium">⊘ Stopped retrying.</span>{" "}
          <span className="pdpp-caption">
            After {failureNoun}
            {reasonSuffix}, automatic attempts are paused.{" "}
            <Link className="underline hover:no-underline" href={addSourceHrefForConnector(connectorId)}>
              Reconnect
            </Link>{" "}
            or try a manual run.
          </span>
        </>
      ) : (
        <>
          <span className="pdpp-body font-medium">
            ⏱ Auto-paused after {failureNoun}
            {reasonSuffix}.
          </span>
          {banner.nextRunAt ? (
            <>
              {" "}
              <span className="pdpp-caption">
                Next retry at <IcTimestamp value={banner.nextRunAt} />.
              </span>
            </>
          ) : null}
        </>
      )}
    </div>
  );
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

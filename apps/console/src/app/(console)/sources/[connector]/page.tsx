// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcTimestamp } from "@pdpp/brand-react";
import type { StreamManifestEntry } from "@pdpp/display";
import {
  formatConnectorKeyForDisplay,
  formatConnectorNameForDisplay,
  isFallbackConnectionLabel,
  streamDisplayLabel,
} from "@pdpp/display";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { buildBreakdownLabel } from "@pdpp/operator-ui/lib/source-storage";
import { formatStorageBytes } from "@pdpp/operator-ui/lib/storage-footprint";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  canonicalConnectorKey,
  manualUploadSetupFromManifest,
  staticSecretCredentialCaptureFromManifest,
} from "pdpp-reference-implementation/connection-setup-plan";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import {
  formatStreamCollectionFacts,
  indexCollectionReportByStream,
  runStatusWithCollectionReportGaps,
  type StreamCollectionFacts,
} from "../../lib/collection-report.ts";
import { getConnectionConfig, listConnectionConfigRevisions } from "../../lib/connection-config-client.ts";
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
import { isBrowserBoundConnector, isBrowserSessionBoundConnection } from "../../lib/connection-modality.ts";
import { connectorRunSummaryId, isActiveConnectorRunSummaryStatus } from "../../lib/connector-run-summary-status.ts";
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
  type RefCoverageHorizon,
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
  isSetupInProgressConnector,
  projectSourceActionability,
  type SourceStreamOwnerActionAvailability,
} from "../../lib/source-actionability.ts";
import { isUnexpectedStreamDeclaration, streamCountLabel } from "../../lib/stream-evidence-state.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../connection-route.ts";
import { findManifestForConnectorId } from "../lib/relationships.ts";
import { formatConnectorHeaderCount } from "../sources-view-model.ts";
import { pauseConnectionAction, resumeConnectionAction, resumeConnectorScheduleAction } from "./actions.ts";
import { acknowledgeConnectionLossAction, confirmCoverageHorizonAction } from "./confirmation-actions.ts";
import type { ConfigRevisionWire, ConnectionConfigWire } from "./connection-config-view-model.ts";
import { ConnectionConfiguration } from "./connection-configuration.tsx";
import { ConnectionConfirmation } from "./connection-confirmation.tsx";
import { ConnectionDangerZone } from "./connection-danger-zone.tsx";
import { ConnectionDiagnostics } from "./connection-diagnostics.tsx";
import { RenameConnection } from "./rename-connection.tsx";
import { StreamCollectionFactsLine } from "./stream-collection-facts.tsx";
import { SyncNowButton } from "./sync-now-button.tsx";

export const dynamic = "force-dynamic";

function addSourceHrefForConnector(connectorId: string): string {
  return `/sources/add?source_q=${encodeURIComponent(connectorId)}`;
}

/**
 * Build the "Update credential" / "Repair" href for an existing static-secret
 * connection. Reuses the same setup form in replace-credential mode, preserving
 * connection_id, records, history, and schedule.
 */
function updateCredentialHref(connectorId: string, connectionId: string): string {
  const key = canonicalConnectorKey(connectorId);
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/connect/static-secret/${encodeURIComponent(key)}?${params.toString()}`;
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
  return `/connect/browser-session/${encodeURIComponent(key)}?${params.toString()}`;
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
  return `/connect/manual-upload/${encodeURIComponent(connectorKey)}?${params.toString()}`;
}

export interface ConnectorPageModel {
  activeRunId: string | null;
  /**
   * Per-stream collection facts derived from the connection summary's
   * `collection_report`, keyed by stream name. Empty when the reference did not
   * return a report (a reference predating
   * `define-connector-progress-evidence-contract`), so the Streams section
   * renders exactly as before in that case.
   */
  collectionFactsByStream: Map<string, StreamCollectionFacts>;
  collectionOwnerActionByStream: SourceStreamOwnerActionAvailability;
  /** The attributed revision ledger, for the history timeline. */
  configRevisions: ConfigRevisionWire[];
  /**
   * The connection's live configuration read (active revision, options schema,
   * and the base a later propose must echo). `null` when the read failed — the
   * configuration panel then says so instead of the page failing.
   */
  configuration: ConnectionConfigWire | null;
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
  /** Current durable horizon disclosures from the reference owner projection. */
  coverageHorizons: readonly RefCoverageHorizon[];
  deviceLabels: string[];
  displayName: string;
  headerCount: string;
  /** Latest-run structured gap evidence; never derived from rendered copy. */
  latestKnownGaps: readonly unknown[] | null | undefined;
  manifest: ConnectorManifest;
  manualUploadHref: string | null;
  overview: ConnectorOverview;
  /** Public reference origin, for resolving `<provider-url>` in remediation
   *  command templates. `null` when unavailable → command fails closed. */
  providerOrigin: string | null;
  recentRuns: RunSummary[];
  /**
   * Retained payload for this connection, already computed onto `overview`
   * (`retainedBytes` / `totalRetainedBytes`) and previously discarded. `null`
   * when the retained-bytes evidence is unobserved/stale/failed — the header
   * then omits the size rather than fabricating a `0 B`.
   */
  retainedStorage: { breakdown: string | null; total: string } | null;
  schedule: RefSchedule | null;
  scheduleError: string | null;
  /** Connection-scoped source-binding kind for binding-first repair routing. */
  sourceBindingKind: string | null;
  sourceInstances: DeviceSourceInstance[];
  sourceInstancesError: string | null;
  streams: StreamSummary[];
  totalRecords: number;
}

function toConnectorRunRef(summary: RefConnectorRunSummary | null) {
  const runId = connectorRunSummaryId(summary?.run_id);
  if (!(summary && runId)) {
    return null;
  }
  return {
    event_count: summary.event_count,
    failure_reason: summary.failure_reason,
    first_at: summary.first_at,
    known_gaps: summary.known_gaps ?? [],
    last_at: summary.last_at,
    run_id: runId,
    status: summary.status,
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
  const runId = connectorRunSummaryId(summary.run_id);
  if (!runId) {
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
    run_id: runId,
    status,
  };
}

function connectionRecentRuns(summary: RefConnectorSummary): RunSummary[] {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
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
    // biome-ignore lint/suspicious/noEqualsToNull: The source-shape regression test requires a nullish guard before reading the durable run status.
    isRunning: lastRun != null && isActiveConnectorRunSummaryStatus(lastRun.status),
    lastRun,
    lastSuccessfulRun,
    localDeviceProgress: summary.local_device_progress ?? null,
    retainedBytes: summary.retained_bytes ?? null,
    revokedAt: summary.revoked_at ?? null,
    streamCount: summary.stream_count,
    streams,
    totalRecords: summary.total_records,
    totalRecordsState: summary.total_records_state,
    totalRetainedBytes: summary.total_retained_bytes,
  };
}

function gapStreamNames(gap: unknown): string[] {
  if (typeof gap === "string") {
    return [gap];
  }
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return [];
  }
  const row = gap as Record<string, unknown>;
  const scope = row.scope && typeof row.scope === "object" && !Array.isArray(row.scope) ? row.scope : null;
  return [row.stream, row.stream_id, row.parent_stream, scope && (scope as Record<string, unknown>).stream].filter(
    (candidate): candidate is string => typeof candidate === "string"
  );
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
      count_state: record?.count_state,
      declaration_state: record?.declaration_state,
      last_updated: record?.last_updated ?? null,
      name,
      object: "stream",
      // An absent retained-size row is NOT zero: the server synthesizes
      // exact-zero rows whenever the retained-size projection is proven
      // fresh/clean, so absence means the count is currently unreliable.
      // A present row's own `record_count` can ALSO genuinely be `null`
      // (count_state: "unobserved"/"stale"/"unknown") — never coerced to a
      // fabricated 0 either.
      record_count: record ? record.record_count : null,
    });
  };

  const pushGapStreams = (gaps: readonly unknown[] | null | undefined) => {
    for (const gap of gaps ?? []) {
      for (const name of gapStreamNames(gap)) {
        pushStream(name);
      }
    }
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
  // Collection facts include streams that were observed without a retained row;
  // the rendered verdict includes server-classified gap streams even when the
  // latest run did not retain a count row. Keep both evidence paths visible.
  for (const entry of summary.collection_report ?? []) {
    pushStream(entry.stream);
  }
  for (const entry of summary.rendered_verdict?.streams ?? []) {
    pushStream(entry.stream_id);
  }
  pushGapStreams(summary.last_run?.known_gaps);
  return streams;
}

export default async function ConnectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string }>;
  searchParams: Promise<{ connection_id?: string; demo?: string; error?: string; message?: string }>;
}) {
  const { connector } = await params;
  const routeId = decodeURIComponent(connector);
  const sp = await searchParams;

  let model: ConnectorPageModel;
  if (process.env.NODE_ENV !== "production" && sp.demo === "atlas") {
    const demo = await import("./source-detail-demo-data.ts");
    model = demo.buildRecoveryDemoModel();
  } else {
    try {
      model = await loadConnectorPageModel(routeId, sp.connection_id ?? null);
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

  // Capture the server render instant so the diagnostics recovery panel can arm
  // its stall watchdog against real time. This page is `force-dynamic`, so the
  // instant is fresh on every request.
  const now = new Date().toISOString();
  return <ConnectorPageView dangerError={sp.error} dangerMessage={sp.message} model={model} now={now} />;
}

async function loadConnectorPageModel(
  routeId: string,
  explicitConnectionId?: string | null
): Promise<ConnectorPageModel> {
  const [summary, manifests] = await Promise.all([
    resolveConnectionForRecordsRoute(routeId, explicitConnectionId),
    listConnectorManifests(),
  ]);
  if (!summary) {
    notFound();
  }
  // A draft connection has no health/coverage/schedule evidence to render on
  // this detail page yet — its one durable status surface is
  // `/connect/status/:id`, which already resolves `draft` for both
  // static-secret and browser-enrollment-shell setup. Redirect here rather
  // than rendering a half-populated page, so direct/bookmarked navigation to
  // a fresh connection's `/sources/:id` lands the owner on the correct
  // "Continue setup" surface instead of a misleading empty detail view. Use
  // the resolved `connection_id`, not the raw route segment: `routeId` may be
  // a connector-key fallback (e.g. `/sources/gmail`), which setup-status does
  // not accept. See fix-pending-connection-discovery design.
  if (isSetupInProgressConnector(summary)) {
    redirect(`/connect/status/${encodeURIComponent(summary.connection_id)}`);
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
  // `connectorInstanceIdForConnection` already falls back to `connection_id`,
  // so this is the concrete instance selector the config routes resolve.
  const configConnectionId = connectorInstanceId;
  const [diagnostics, providerOrigin, configuration, configRevisions] = await Promise.all([
    loadConnectorDiagnostics(connectorId, connectorInstanceId),
    // Resolve the public origin to late-bind `<provider-url>` in remediation
    // command templates. Failure → null → the command fails closed (no broken
    // copy-paste command), never throws and breaks the page.
    getReferencePublicOrigin().catch(() => null),
    // Configuration reads join this existing phase rather than adding a serial
    // await — `page-performance.test.ts` pins that shape. Both degrade to null
    // on failure: a connector whose manifest declares a malformed
    // `options_schema` answers 400, and that must cost the owner the
    // configuration panel only, never the health and streams they opened this
    // page for.
    getConnectionConfig(configConnectionId).catch(() => null),
    listConnectionConfigRevisions(configConnectionId).catch(() => []),
  ]);
  const { schedule } = diagnostics;
  const overview = toConnectorOverview(summary, streams);
  const recentRuns = connectionRecentRuns(summary);
  const latestKnownGaps = summary.last_run?.known_gaps;
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
    totalRecordsState: summary.total_records_state,
  });
  // The retained payload for this connection was already projected onto the
  // overview and then discarded by every renderer. Surface it in the header.
  // `total_retained_bytes` is `null` whenever the retained-bytes evidence is
  // unobserved/stale/failed, so absence hides the line rather than rendering
  // a fabricated `0 B`. This is a LOGICAL payload size — it is deliberately
  // not compared here against any physical on-disk figure.
  const retainedTotal = overview.totalRetainedBytes;
  const retainedStorage =
    typeof retainedTotal === "number" && Number.isFinite(retainedTotal) && retainedTotal >= 0
      ? { breakdown: buildBreakdownLabel(overview.retainedBytes), total: formatStorageBytes(retainedTotal) }
      : null;
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
    activeRunId: schedule?.active_run_id ?? null,
    configRevisions,
    configuration,
    collectionFactsByStream,
    collectionOwnerActionByStream,
    connectionHealth: summary.connection_health ?? null,
    connectionId,
    connectionLabelSeed,
    connectionPrimaryAction: actionability.primaryAction,
    connectionRenderedVerdict: summary.rendered_verdict ?? null,
    connectorId,
    connectorInstanceId,
    coverageHorizons: summary.coverage_horizons ?? [],
    deviceLabels,
    displayName,
    headerCount,
    latestKnownGaps,
    manifest,
    manualUploadHref: manualUploadHrefForConnection(connectorId, connectionId, manifest),
    overview,
    providerOrigin,
    recentRuns,
    retainedStorage,
    // Connection-scoped binding kind, so repair routing is binding-first (a
    // browser-session connection reconnects its session, not a static secret).
    sourceBindingKind: summary.source_binding_kind ?? null,
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

function resolveActiveRunNavigation(input: { overview: ConnectorOverview; scheduleActiveRunId: string | null }): {
  activeRunHref: string | null;
  running: boolean;
} {
  const activeRunId =
    input.scheduleActiveRunId ??
    (input.overview.isRunning && input.overview.lastRun ? input.overview.lastRun.run_id : null);
  return {
    activeRunHref: activeRunId ? `/syncs/${encodeURIComponent(activeRunId)}` : null,
    running: activeRunId !== null || input.overview.isRunning,
  };
}

function resolveCredentialUpdateHref({
  browserSessionRepairHref,
  sessionBound,
  storedCredentialUpdateHref,
}: {
  browserSessionRepairHref: string | null;
  sessionBound: boolean;
  storedCredentialUpdateHref: string | null;
}): string | null {
  if (sessionBound) {
    return browserSessionRepairHref;
  }
  if (storedCredentialUpdateHref !== null) {
    return storedCredentialUpdateHref;
  }
  return browserSessionRepairHref;
}

function StreamDisplayName({
  displayLabel,
  name,
  unexpected,
}: {
  displayLabel: string;
  name: string;
  unexpected: boolean;
}) {
  return (
    <span className="pdpp-body break-all font-medium font-mono" title={displayLabel === name ? undefined : name}>
      {displayLabel}
      {unexpected ? (
        <span
          className="ml-1.5 align-middle text-[color:var(--warning)]"
          data-testid="stream-unexpected-declaration"
          title="This stream has canonical or retained data, but the current manifest no longer declares it."
        >
          (undeclared)
        </span>
      ) : null}
    </span>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this server view intentionally composes the detail evidence panels and their binding-aware actions in one owner-visible route.
function ConnectorPageView({
  model,
  dangerMessage,
  dangerError,
  now,
}: {
  model: ConnectorPageModel;
  dangerMessage?: string;
  dangerError?: string;
  /** Server render instant (ISO-8601) for the diagnostics recovery stall watchdog. */
  now: string;
}) {
  const {
    activeRunId: scheduleActiveRunId,
    collectionFactsByStream,
    collectionOwnerActionByStream,
    configRevisions,
    configuration,
    connectionHealth,
    connectionRenderedVerdict,
    connectionId,
    connectionPrimaryAction,
    connectorId,
    connectorInstanceId,
    connectionLabelSeed,
    coverageHorizons,
    deviceLabels,
    displayName,
    headerCount,
    latestKnownGaps,
    manifest,
    manualUploadHref,
    overview,
    providerOrigin,
    recentRuns,
    retainedStorage,
    schedule,
    scheduleError,
    sourceBindingKind,
    sourceInstances,
    sourceInstancesError,
    streams,
  } = model;
  const { activeRunHref, running } = resolveActiveRunNavigation({
    overview,
    scheduleActiveRunId,
  });
  const revoked = isRevokedConnection(overview);
  const paused = !revoked && overview.connectionStatus === "paused";
  // A recovered historical-archive row: paused (never revoked), landed by the
  // archive-recovery operation rather than an owner revoke. It gets the
  // credential-repair notice INSTEAD of a plain Resume action — see
  // `PausedHistoricalArchiveSection`'s doc comment for why resuming such a row
  // without first repairing its credential would just fail on the next run.
  const pausedHistoricalArchive = paused && sourceBindingKind === "historical_archive";
  // Every OTHER paused row — including one the owner paused deliberately — gets
  // a real Resume action. Without this, a `paused` connection outside the
  // archive-recovery journey would be visible but unrecoverable from the
  // console, which is the dead end pause/resume exists to remove.
  const pausedResumable = paused && !pausedHistoricalArchive;
  // Pause is offered only on a connection that is actually collecting. A
  // draft/revoked/already-paused row has nothing to pause, and the route would
  // answer `connector_instance_not_active` anyway.
  const pausable = !(revoked || paused) && overview.connectionStatus === "active";
  // Stable rename selector: prefer the explicit instance id, fall back to the
  // connection id. Both address the same connection on the backend route.
  const renameSelector = connectorInstanceId ?? connectionId;
  // Connection-binding-first repair routing. A connection BOUND as a browser
  // session (`browser_collector`/`browser_enrollment_shell`) authenticates by
  // owner-authenticated browser session, so its repair is browser/session
  // repair — even when the connector ALSO supports a static-secret credential
  // (e.g. a ChatGPT connection that logs in via SSO through the browser). Only a
  // connection that is NOT browser-session-bound routes to static-secret capture.
  // The connection binding wins over the connector-level static-secret capability
  // and `isBrowserBoundConnector` facts.
  const sessionBound = isBrowserSessionBoundConnection(sourceBindingKind);
  const staticSecretCapture = staticSecretCredentialCaptureFromManifest(manifest);
  const repairConnectionId = connectorInstanceId ?? connectionId;
  const storedCredentialUpdateHref =
    staticSecretCapture === null ? null : updateCredentialHref(connectorId, repairConnectionId);
  const browserSessionRepairHref =
    sessionBound || isBrowserBoundConnector(connectorId)
      ? browserSessionReconnectHref(connectorId, repairConnectionId)
      : null;
  const credentialUpdateHref = resolveCredentialUpdateHref({
    browserSessionRepairHref,
    sessionBound,
    storedCredentialUpdateHref,
  });
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
  const primaryActionSurface = connectionPrimaryAction?.surface?.kind ?? null;
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
  const manifestStreams = Array.isArray(manifest.streams) ? manifest.streams : [];
  const streamLabelsByName = new Map(
    manifestStreams.map(
      (stream) => [stream.name, streamDisplayLabel(stream.name, stream as StreamManifestEntry)] as const
    )
  );

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <ConnectorHeaderActions
            activeRunHref={activeRunHref}
            browserSessionRepairHref={browserSessionRepairHref}
            connectionId={connectorInstanceId}
            connectorId={connectorId}
            credentialUpdateHref={credentialUpdateHref}
            displayName={displayName}
            hasStaticSecretCredentialUpdate={
              storedCredentialUpdateHref !== null && !sessionBound && primaryActionSurface !== "stored_credential"
            }
            manualUploadHref={manualUploadHref}
            primaryAction={primaryAction}
            renderedAction={connectionPrimaryAction}
            revoked={revoked}
            running={running}
            storedCredentialUpdateHref={storedCredentialUpdateHref}
            syncIdleLabel={syncIdleLabel}
          />
        }
        breadcrumbs={[{ href: "/sources", label: "Sources" }, { label: displayName }]}
        count={
          retainedStorage === null ? (
            headerCount
          ) : (
            <>
              {headerCount}
              <span
                className="ml-3 text-muted-foreground/70"
                data-testid="header-retained-bytes"
                title={retainedStorage.breakdown ?? undefined}
              >
                {retainedStorage.total} retained
              </span>
            </>
          )
        }
        description={
          <ConnectionIdentityLine
            connectionId={connectionId}
            connectorId={connectorId}
            deviceLabels={deviceLabels}
            providerId={manifest.provider_id ?? null}
          />
        }
        title={
          <span className="inline-flex items-center gap-2">
            {displayName}
            <RenameConnection
              connectionId={renameSelector}
              currentLabel={connectionLabelSeed}
              displayName={displayName}
              typeName={formatConnectorKeyForDisplay(connectorId)}
            />
          </span>
        }
      />

      {streakDots.length > 0 ? <StreakStrip dots={streakDots} /> : null}

      {revoked ? <RevokedConnectionSection connectorId={connectorId} revokedAt={overview.revokedAt ?? null} /> : null}

      {pausedHistoricalArchive ? <PausedHistoricalArchiveSection credentialUpdateHref={credentialUpdateHref} /> : null}

      {pausedResumable ? <PausedConnectionSection connectionId={renameSelector} /> : null}

      <AcquisitionCoverageSection
        connectionId={connectorInstanceId ?? connectionId}
        coverage={overview.acquisitionCoverage ?? null}
      />

      <ConnectionConfirmation
        acknowledgeConnectionLossAction={acknowledgeConnectionLossAction}
        acknowledgedLoss={connectionRenderedVerdict?.detail.acknowledged_loss ?? null}
        confirmCoverageHorizonAction={confirmCoverageHorizonAction}
        connectionId={connectorInstanceId ?? connectionId}
        error={dangerError}
        latestKnownGaps={latestKnownGaps}
        message={dangerMessage}
        pendingHorizons={coverageHorizons}
      />

      <Section
        description={
          collectionFactsByStream.size > 0
            ? 'Record counts show what this source currently retains. Coverage and next-run disposition come from the latest collection report; when the total is unmeasured, coverage reads "not measured", never complete.'
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
              const countLabel = streamCountLabel(s);
              const unexpected = isUnexpectedStreamDeclaration(s.declaration_state);
              const displayLabel = streamLabelsByName.get(s.name) ?? s.name;
              return (
                <li key={s.name}>
                  <Link
                    className={`flex flex-col gap-1 px-3 pt-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${
                      facts ? "pb-2" : "pb-3"
                    }`}
                    href={`/sources/${encodeURIComponent(connectionId)}/${encodeURIComponent(s.name)}`}
                  >
                    <StreamDisplayName displayLabel={displayLabel} name={s.name} unexpected={unexpected} />
                    <span
                      className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums"
                      data-count-state={s.count_state ?? "unknown_state"}
                    >
                      <span
                        className={countLabel.tone === "warning" ? "text-[color:var(--warning)]" : undefined}
                        title={countLabel.title || undefined}
                      >
                        {countLabel.text}
                      </span>
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

      {/* Configuration belongs to the source, not to Deployment: this route
          already owns the connection's identity, health, coverage, streams and
          runs, so moving settings elsewhere would make the owner carry that
          identity across a context switch. It sits above diagnostics because it
          is owner-decision content, and above the danger zone because it is not
          destructive. */}
      {configuration ? (
        <ConnectionConfiguration
          config={configuration}
          connectionId={connectorInstanceId ?? connectionId}
          connectorId={connectorId}
          revisions={configRevisions}
        />
      ) : null}

      {/* Diagnostics is operator-debug detail. It sat first, above the
          streams and runs an owner actually opens this page for, so the
          page led with its least-wanted content. It now follows them. */}
      <ConnectionDiagnostics
        connectionHealth={connectionHealth}
        connectionId={connectorInstanceId ?? connectionId}
        connectorId={connectorId}
        localDeviceProgress={overview.localDeviceProgress ?? null}
        now={now}
        providerOrigin={providerOrigin}
        renderedVerdict={connectionRenderedVerdict}
        schedule={schedule}
        scheduleError={scheduleError}
        sourceInstances={sourceInstances}
        sourceInstancesError={sourceInstancesError}
      />

      {pausable ? <PauseConnectionSection connectionId={renameSelector} /> : null}

      <ConnectionDangerZone
        connectionId={connectorInstanceId ?? connectionId}
        error={dangerError}
        message={dangerMessage}
      />
    </RecordroomShellWithPalette>
  );
}

function ConnectorHeaderActions({
  activeRunHref,
  browserSessionRepairHref,
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  hasStaticSecretCredentialUpdate,
  manualUploadHref,
  primaryAction,
  renderedAction,
  revoked,
  running,
  storedCredentialUpdateHref,
  syncIdleLabel,
}: {
  activeRunHref: string | null;
  browserSessionRepairHref: string | null;
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  hasStaticSecretCredentialUpdate: boolean;
  manualUploadHref: string | null;
  primaryAction: PrimaryRowAction;
  renderedAction: RefRequiredAction | null;
  revoked: boolean;
  running: boolean;
  storedCredentialUpdateHref: string | null;
  syncIdleLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      {activeRunHref ? (
        <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={activeRunHref} prefetch={false}>
          Active sync →
        </Link>
      ) : null}
      <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/syncs">
        All syncs →
      </Link>
      {/* Update credential: visible on static-secret connections so the owner can
          rotate credentials without breaking the connection. Browser-session
          reconnect remains available only when no stored-credential surface is
          declared for the connector. */}
      {storedCredentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate ? (
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={storedCredentialUpdateHref}
          title="Replace the stored credential for this connection. Records, history, and schedule are preserved."
        >
          Update credential
        </Link>
      ) : null}
      <ConnectorPrimaryHeaderAction
        browserSessionRepairHref={browserSessionRepairHref}
        connectionId={connectionId}
        connectorId={connectorId}
        credentialUpdateHref={credentialUpdateHref}
        displayName={displayName}
        manualUploadHref={manualUploadHref}
        primaryAction={primaryAction}
        renderedAction={renderedAction}
        revoked={revoked}
        running={running}
        storedCredentialUpdateHref={storedCredentialUpdateHref}
        syncIdleLabel={syncIdleLabel}
      />
    </div>
  );
}

function ConnectorPrimaryHeaderAction({
  browserSessionRepairHref,
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  manualUploadHref,
  primaryAction,
  renderedAction,
  revoked,
  running,
  storedCredentialUpdateHref,
  syncIdleLabel,
}: {
  browserSessionRepairHref: string | null;
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  manualUploadHref: string | null;
  primaryAction: PrimaryRowAction;
  renderedAction: RefRequiredAction | null;
  revoked: boolean;
  running: boolean;
  storedCredentialUpdateHref: string | null;
  syncIdleLabel: string;
}) {
  const renderedOwnerAction =
    renderedAction && renderedAction.audience === "owner" && renderedAction.satisfied_when.kind !== "none"
      ? renderedAction
      : null;

  if (revoked) {
    return (
      <Link
        className={buttonVariants({ size: "sm", variant: "default" })}
        href={addSourceHrefForConnector(connectorId)}
        title="This connection is revoked. Reconnect starts the supported setup path for this source."
      >
        Reconnect
      </Link>
    );
  }
  if (renderedOwnerAction) {
    return (
      <RenderedVerdictHeaderAction
        action={renderedOwnerAction}
        browserSessionRepairHref={browserSessionRepairHref}
        connectionId={connectionId}
        connectorId={connectorId}
        credentialUpdateHref={credentialUpdateHref}
        displayName={displayName}
        running={running}
        storedCredentialUpdateHref={storedCredentialUpdateHref}
      />
    );
  }
  if (primaryAction.kind === "sync") {
    if (manualUploadHref) {
      return (
        <>
          <Link
            className={buttonVariants({ size: "sm", variant: "default" })}
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

function reauthActionPresentation({
  action,
  browserSessionRepairHref,
  connectorId,
  credentialUpdateHref,
  storedCredentialUpdateHref,
}: {
  action: RefRequiredAction;
  browserSessionRepairHref: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  storedCredentialUpdateHref: string | null;
}): { href: string; label: string; title: string } {
  const fallbackHref = credentialUpdateHref ?? addSourceHrefForConnector(connectorId);
  switch (action.surface?.kind) {
    case "stored_credential":
      return {
        href: storedCredentialUpdateHref ?? fallbackHref,
        label: "Update credential",
        title: "Replace the stored credential for this connection. Records, history, and schedule are preserved.",
      };
    case "browser_session":
      return {
        href: browserSessionRepairHref ?? fallbackHref,
        label: action.cta,
        title: "Open the secure browser session for this connection. Records, history, and schedule are preserved.",
      };
    case "provider_interaction":
      // The interaction dock lives on the RUN, not the connection: a provider
      // interaction (OTP, CAPTCHA, device approval, manual sign-in) can only be
      // completed while that run is still waiting, and the run's assistance
      // window expires. Without this case the chip fell to `default` and sent
      // the owner to the add-source page — a live "Complete the requested
      // action" prompt that led away from the only surface that could satisfy
      // it, while the run timed out. `target.run_id` is already on the action
      // (`exactSyncTargetFromAttention`), so the destination needs no new data.
      return {
        href:
          action.target?.kind === "sync" && action.target.run_id
            ? `/syncs/${encodeURIComponent(action.target.run_id)}/stream`
            : fallbackHref,
        label: action.cta,
        title: "Open the live run and complete the step this provider is waiting on.",
      };
    default:
      return {
        href: fallbackHref,
        label: action.cta,
        title: "Repair this source while preserving its existing records, history, and schedule when supported.",
      };
  }
}

function RenderedVerdictHeaderAction({
  action,
  browserSessionRepairHref,
  connectionId,
  connectorId,
  credentialUpdateHref,
  displayName,
  running,
  storedCredentialUpdateHref,
}: {
  action: RefRequiredAction;
  browserSessionRepairHref: string | null;
  connectionId: string | null;
  connectorId: string;
  credentialUpdateHref: string | null;
  displayName: string;
  running: boolean;
  storedCredentialUpdateHref: string | null;
}) {
  if (action.audience !== "owner" || action.satisfied_when.kind === "none") {
    return null;
  }
  if (action.kind === "reauth") {
    const repair = reauthActionPresentation({
      action,
      browserSessionRepairHref,
      connectorId,
      credentialUpdateHref,
      storedCredentialUpdateHref,
    });
    return (
      <Link
        className={buttonVariants({ size: "sm", variant: "default" })}
        data-testid="detail-action-rendered-verdict"
        href={repair.href}
        title={repair.title}
      >
        {repair.label}
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
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
    // A non-device add_info is only clickable when the server attached a
    // validated exact sync target from structured attention. Otherwise the
    // action remains plain text; the console must not invent a generic
    // /syncs fallback for a connection-scoped owner prompt.
    if (action.target?.kind !== "sync") {
      return (
        <span
          className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
          data-testid="detail-action-rendered-verdict"
        >
          {action.cta}
        </span>
      );
    }
    // A validated sync target is NOT enough on its own: the run must still be
    // waiting. `exactSyncTargetFromAttention` reads `run_id` off the attention
    // record with no liveness check, and an `expired` record keeps its `run_id`
    // forever — so a concluded run still produced a `/syncs/<id>` link. The
    // owner clicked "Complete the requested action" and nothing happened,
    // because the run that owned the interaction had already ended and taken
    // the interaction with it (production, ChatGPT chaka.dondo@gmail.com: three
    // consecutive `expired` attention records, each still carrying a run id).
    //
    // With no live run there is nothing to complete. The honest destination is
    // the surface that can re-establish the session so a NEW run can ask again.
    if (!running) {
      return browserSessionRepairHref === null ? (
        <span
          className="pdpp-caption max-w-[18rem] text-right text-muted-foreground"
          data-action-stale-target="true"
          data-testid="detail-action-rendered-verdict"
        >
          {action.cta} — no run is waiting right now
        </span>
      ) : (
        <Link
          className={buttonVariants({ size: "sm", variant: "default" })}
          data-action-stale-target="true"
          data-testid="detail-action-rendered-verdict"
          href={browserSessionRepairHref}
          title="No run is waiting right now. Open the secure browser session to sign in again; the next run will pick up from there."
        >
          {action.cta}
        </Link>
      );
    }
    return (
      <Link
        className={buttonVariants({ size: "sm", variant: "default" })}
        data-testid="detail-action-rendered-verdict"
        href={`/syncs/${encodeURIComponent(action.target.run_id)}`}
      >
        {action.cta}
      </Link>
    );
  }
  if (action.kind === "reattach_schedule") {
    // The owner paused this connection's automatic schedule. `Sync now`
    // would run once but leave the schedule disabled — it does not satisfy
    // `schedule_attached_and_enabled`, the action's real contract. Wire the
    // existing `resumeConnectorScheduleAction` server action (already
    // reaches the real instance-scoped `/schedule/resume` endpoint) instead
    // of falling through to the sync-now button below.
    return (
      <form action={resumeConnectorScheduleAction}>
        <input name="connector_id" type="hidden" value={connectorId} />
        {connectionId ? <input name="connection_id" type="hidden" value={connectionId} /> : null}
        <IcButton data-testid="detail-action-reattach-schedule" size="sm" type="submit" variant="default">
          {action.cta}
        </IcButton>
      </form>
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
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={`/connect/status/${encodeURIComponent(connectionId)}`}
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
  const { status } = mediaCoverage as { status?: unknown };
  return typeof status === "string" && status.length > 0 ? `media ${status.replaceAll("_", " ")}` : null;
}

/**
 * Recent syncs section with optional auto-paused banner. Extracted to keep
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
      description="Only syncs already attributed to this source are listed here. Connector-wide syncs stay on the Syncs page."
      title={`Known source syncs (${recentRuns.length})`}
    >
      {recentRuns.length === 0 ? (
        <p className="pdpp-caption text-muted-foreground italic">No attributed syncs yet for this source.</p>
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
                href={`/syncs/${encodeURIComponent(r.run_id)}`}
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

/**
 * Notice for a recovered historical-archive connection: paused (never
 * revoked) with `source_binding.kind === 'historical_archive'`. This is the
 * ONLY owner-facing surface for the archive-reconnect journey — there is no
 * separate "Resume" button, because a recovered row typically carries no
 * surviving credential, and resuming without one would just flip the row to
 * `active` and then fail on the next run. Instead this reuses the SAME
 * `credentialUpdateHref` the detail page already computes for repair
 * (static-secret capture or browser-session reconnect, whichever this
 * connection's binding requires) — the server-side capture/run hooks resume
 * the row automatically once a working credential lands, so the owner makes
 * one decision (repair the credential) and the resume follows as its result,
 * never a second manual step.
 */
/**
 * Notice + Resume action for an ordinarily paused connection — one the owner
 * paused deliberately, as opposed to a recovered archive row (which gets
 * {@link PausedHistoricalArchiveSection} and its credential-repair route
 * instead). Stating what was KEPT is the point of the copy: the owner needs to
 * see that pausing cost them nothing before they trust the button that undoes
 * it, and that pause is not the same act as revoke.
 *
 * Renders unconditionally for a paused, non-archive row: unlike the archive
 * notice there is no href that can be missing, so this can never silently
 * render nothing and strand the connection.
 */
function PausedConnectionSection({ connectionId }: { connectionId: string | null }) {
  return (
    <Section
      description="Collection is paused. Your records, schedule, and sign-in are kept — resume to start collecting again."
      title="This source is paused"
    >
      <form action={resumeConnectionAction}>
        {connectionId ? <input name="connection_id" type="hidden" value={connectionId} /> : null}
        <IcButton data-testid="detail-action-resume-connection" size="sm" type="submit" variant="default">
          Resume collecting
        </IcButton>
      </form>
    </Section>
  );
}

/**
 * Pause control for a connection that is actively collecting. Deliberately
 * NOT in the danger zone with revoke/delete, and deliberately unconfirmed:
 * pause changes no data and is undone by one click on the same page, so the
 * confirmation ceremony those destructive actions require would be friction
 * with nothing to protect. The copy names the reversibility and contrasts
 * pause with revoke, so the owner can tell the two apart before acting.
 */
function PauseConnectionSection({ connectionId }: { connectionId: string | null }) {
  return (
    <Section
      description="Stop collecting from this source for now. Your records, schedule, and sign-in are kept, and you can resume any time. To end this connection instead, revoke it below."
      title="Pause collecting"
    >
      <form action={pauseConnectionAction}>
        {connectionId ? <input name="connection_id" type="hidden" value={connectionId} /> : null}
        <IcButton data-testid="detail-action-pause-connection" size="sm" type="submit" variant="ghost">
          Pause collecting
        </IcButton>
      </form>
    </Section>
  );
}

function PausedHistoricalArchiveSection({ credentialUpdateHref }: { credentialUpdateHref: string | null }) {
  if (!credentialUpdateHref) {
    return null;
  }
  return (
    <Section
      description="Reconnect this account to continue collecting. Existing records and this connection are preserved."
      title="Reconnect to resume this source"
    >
      <Link className={buttonVariants({ size: "sm", variant: "default" })} href={credentialUpdateHref}>
        Reconnect
      </Link>
    </Section>
  );
}

function RevokedConnectionSection({ connectorId, revokedAt }: { connectorId: string; revokedAt: string | null }) {
  return (
    <Section
      description="Future collection is stopped for this connection. Retained records, grants, runs, and audit evidence stay visible; reconnect starts a fresh setup path for this source."
      title="Revoked connection"
    >
      <Link
        className={buttonVariants({ size: "sm", variant: "default" })}
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
            key={i}
            title={`${d.statusLabel} · ${d.at}`}
          >
            {d.symbol}
          </span>
        ))}
      </span>
      <Link className="pdpp-caption ml-auto text-muted-foreground hover:text-foreground" href="/syncs">
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

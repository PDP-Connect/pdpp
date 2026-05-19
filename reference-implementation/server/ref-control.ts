// Reference-only HTTP control-plane projections.
//
// These helpers back the `/_ref/connectors*`, `/_ref/approvals`, and
// `/_ref/records/timeline` routes. They read from the configured reference
// storage substrate and the spine correlation index, then shape the result
// into the JSON envelopes the dashboard consumes.
//
// Not a PDPP protocol surface: these are debugging / operator views the
// reference implementation exposes for its own dashboard. Clients must
// not depend on the response shape.

import { allowUnboundedReadAcknowledged, getOne, iterateDynamicSqlAcknowledged, referenceQueries } from "../lib/db.ts";
import { listSpineCorrelations, type SpineSummary } from "../lib/spine.ts";
import {
  computeConnectionHealth,
  type ConnectionHealthSnapshot,
  type CoverageAxis,
  type FreshnessAxis,
} from "../runtime/connection-health.ts";
import { getConnectorManifest } from "./auth.js";
import { deriveReferenceFreshness, type ReferenceFreshness } from "./freshness.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";
import { listAllStreams } from "./records.js";
import {
  chooseDisplayTimestamp,
  compareTimestampValues,
  type ManifestStreamLike,
  pickSemanticTimestamp,
  type SemanticTimestamp,
  timestampWithinWindow,
} from "./ref-record-utils.ts";

// ─── Shared domain types ────────────────────────────────────────────────────

interface ManifestStream extends ManifestStreamLike {
  name: string;
  semantics?: string;
}

type ConnectorManifest = {
  connector_id?: string;
  capabilities?: Record<string, unknown>;
  display_name?: string;
  profiles?: { id: string }[];
  protocol_version?: string | null;
  runtime_requirements?: {
    bindings?: Record<string, unknown>;
  };
  streams?: ManifestStream[];
  version?: string;
} & Record<string, unknown>;

interface ConnectorRow {
  readonly connector_id: string;
  readonly manifest: string;
}

const NON_PUBLIC_CONNECTOR_ID_PARTS = ["manual_action_stub", "manual-action-stub", "stream-test-stub"];

interface StreamAggregateRow {
  readonly last_updated: string | null;
  readonly record_count: number;
  readonly stream: string;
}

type Freshness = ReferenceFreshness;

interface RecordProjection {
  readonly byStream: Map<string, StreamProjection>;
  readonly freshness: Freshness;
  readonly totalRecords: number;
}

interface StreamProjection {
  readonly freshness: Freshness;
  readonly last_updated: string | null;
  readonly record_count: number;
}

interface RecordProjectionRow {
  readonly last_updated: string | null;
  readonly record_count: number | string | null;
  readonly stream: string;
}

interface ManifestExcerpt {
  readonly connector_id: string | undefined;
  readonly display_name: string;
  readonly profile_ids: string[];
  readonly protocol_version: string | null;
  readonly version: string | undefined;
}

interface StreamSummary {
  readonly freshness: Freshness;
  readonly last_updated: string | null;
  readonly name: string;
  readonly object: "stream";
  readonly record_count: number;
  readonly semantics: string | null;
}

interface ConnectorRunSummary {
  readonly event_count: number;
  readonly failure_reason: string | null;
  readonly finished_at: string | null;
  readonly first_at: string;
  readonly known_gaps: unknown[];
  readonly last_at: string;
  readonly run_id: string | undefined;
  readonly started_at: string;
  readonly status: string;
}

interface ScheduleLike {
  getSchedule(connectorId: string): Promise<unknown>;
}

interface ControllerLike {
  getSchedule?(connectorId: string): Promise<unknown>;
}

export interface ConnectorSummary {
  readonly connection_health: ConnectionHealthSnapshot;
  readonly connection_id: string;
  readonly connector_id: string;
  readonly display_name: string;
  readonly freshness: Freshness;
  readonly last_run: ConnectorRunSummary | null;
  readonly last_successful_run: ConnectorRunSummary | null;
  readonly manifest_version: string | null;
  readonly refresh_policy: unknown;
  readonly schedule: unknown;
  readonly streams: string[];
  readonly total_records: number;
}

export interface ConnectorDetail {
  readonly connection_health: ConnectionHealthSnapshot;
  readonly connection_id: string;
  readonly connector_id: string;
  readonly display_name: string;
  readonly freshness: Freshness;
  readonly last_run: ConnectorRunSummary | null;
  readonly last_successful_run: ConnectorRunSummary | null;
  readonly manifest_excerpt: ManifestExcerpt;
  readonly manifest_version: string | null;
  readonly object: "ref_connector_detail";
  readonly recent_runs: ConnectorRunSummary[];
  readonly schedule: unknown;
  // Detail carries richer per-stream projection; the list surface
  // (ConnectorSummary) only needs the stream name array.
  readonly streams: StreamSummary[];
  readonly total_records: number;
}

interface PendingConsentRow {
  readonly approval_id: string | null;
  readonly created_at: string;
  readonly device_code: string;
  readonly params_json: string;
  readonly user_code: string;
}

interface PendingOwnerDeviceRow {
  readonly approval_id: string | null;
  readonly client_id: string;
  readonly created_at: string;
  readonly device_code: string;
  readonly user_code: string;
}

interface ConsentRequestEnvelope {
  client?: { client_id?: string };
  selection?: {
    access_mode?: string;
    purpose_code?: string;
    purpose_description?: string;
    streams?: unknown[];
  };
  source_binding?: { kind?: string; id?: string };
}

interface SourcePreview {
  readonly id: string;
  readonly kind: "connector" | "provider_native";
}

interface ConsentApproval {
  readonly approval_id: string;
  readonly client_id: string | null;
  readonly created_at: string;
  readonly grant_preview: {
    readonly access_mode: string | null;
    readonly purpose_code: string | null;
    readonly purpose_description: string | null;
    readonly source: SourcePreview | null;
    readonly streams: unknown[];
  };
  readonly kind: "consent";
  readonly object: "approval";
  // request_uri is intentionally projected as null on the operator console.
  // The canonical request_uri embeds the live device_code, which (via
  // `/consent/approve`) is bearer-equivalent. Owner approve/deny flows
  // resolve approval_id -> device_code on the AS side.
  readonly request_uri: null;
  // user_code is intentionally NOT projected. It is the human verifier
  // shown during the device flow and combined with owner-session auth
  // becomes part of the takeover chain. The dashboard's owner approve/deny
  // path uses approval_id instead.
  readonly user_code: null;
}

interface OwnerDeviceApproval {
  readonly approval_id: string;
  readonly client_id: string;
  readonly created_at: string;
  readonly grant_preview: null;
  readonly kind: "owner_device";
  readonly object: "approval";
  readonly request_uri: null;
  readonly user_code: null;
}

type Approval = ConsentApproval | OwnerDeviceApproval;

export interface TimelineOptions {
  connectorId?: string | null;
  limit?: number;
  order?: "asc" | "desc";
  since?: string | null;
  stream?: string | null;
  timestampMode?: "emitted" | "native";
  until?: string | null;
}

export interface TimelineEntry {
  readonly connector_id: string;
  readonly data: unknown;
  readonly display_timestamp: string;
  readonly emitted_at: string;
  readonly id: string;
  readonly object: "timeline_entry";
  readonly semantic_timestamp: SemanticTimestamp | null;
  readonly stream: string;
  readonly version: number | null;
}

export interface TimelineResponse {
  readonly data: TimelineEntry[];
  readonly meta: {
    readonly bounded: true;
    readonly filters: {
      readonly connector_id: string | null;
      readonly since: string | null;
      readonly stream: string | null;
      readonly until: string | null;
    };
    readonly limit: number;
    readonly ordering: string;
    readonly timestamp_mode: "emitted" | "native";
  };
  readonly object: "list";
}

// ─── Named controller-plane errors ──────────────────────────────────────────

export class RefControlError extends Error {
  readonly code: "connector_invalid" | "not_found";
  constructor(message: string, code: "connector_invalid" | "not_found") {
    super(message);
    this.code = code;
    this.name = "RefControlError";
  }
}

function parseManifest(raw: string, connectorId: string): ConnectorManifest {
  try {
    return JSON.parse(raw) as ConnectorManifest;
  } catch {
    throw new RefControlError(
      `Connector manifest for ${connectorId} is malformed or no longer valid`,
      "connector_invalid"
    );
  }
}

function buildFreshness(lastUpdated: string | null = null): Freshness {
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

interface RunTerminalEventRow {
  readonly data_json: string | null;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly status: string;
}

/**
 * Extract `known_gaps` from a run's terminal event without scanning the
 * run's full event list. The single SQL lookup is bounded by the SQL
 * `LIMIT 1` clause; for runs without a terminal event yet (still in
 * progress, or controller_restarted), returns an empty list.
 */
async function extractKnownGapsForRun(runId: string): Promise<unknown[]> {
  const row = isPostgresStorageBackend()
    ? ((
        await postgresQuery(
          `SELECT data_json::text AS data_json, event_type, occurred_at, status
         FROM spine_events
         WHERE run_id = $1
           AND (event_type = 'run.completed'
                OR event_type = 'run.failed'
                OR event_type = 'run.cancelled')
         ORDER BY event_seq DESC
         LIMIT 1`,
          [runId]
        )
      ).rows[0] as RunTerminalEventRow | undefined)
    : getOne<RunTerminalEventRow>(referenceQueries.spineGetRunTerminalEvent, [runId]);
  if (!row?.data_json) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    return [];
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).known_gaps)) {
    return (parsed as { known_gaps: unknown[] }).known_gaps;
  }
  return [];
}

async function toConnectorRunSummary(summary: SpineSummary | null): Promise<ConnectorRunSummary | null> {
  if (!summary) {
    return null;
  }
  const runId = summary.id || summary.run_id || null;
  return {
    run_id: runId || undefined,
    status: summary.status,
    started_at: summary.first_at,
    finished_at: summary.status === "pending" ? null : summary.last_at,
    first_at: summary.first_at,
    last_at: summary.last_at,
    event_count: summary.event_count,
    failure_reason: summary.failure?.reason || null,
    known_gaps: runId ? await extractKnownGapsForRun(runId) : [],
  };
}

async function getLatestRunSummary(
  connectorId: string,
  status: string | null = null
): Promise<ConnectorRunSummary | null> {
  const filters = status
    ? { sourceKind: "connector", sourceId: connectorId, status, limit: 1 }
    : { sourceKind: "connector", sourceId: connectorId, limit: 1 };
  const { summaries } = await listSpineCorrelations("run", filters);
  return toConnectorRunSummary(summaries[0] ?? null);
}

async function getConnectorRecordProjection(connectorId: string): Promise<RecordProjection> {
  const rows: RecordProjectionRow[] = isPostgresStorageBackend()
    ? (await listAllStreams(connectorId)).map(
        (row: { name: string; record_count: number; last_updated: string | null }) => ({
          stream: row.name,
          record_count: row.record_count,
          last_updated: row.last_updated,
        })
      )
    : allowUnboundedReadAcknowledged<StreamAggregateRow>(referenceQueries.recordsAggregateStreamsByConnector, [
        connectorId,
      ]);
  const byStream = new Map<string, StreamProjection>();
  let latest: string | null = null;
  for (const row of rows) {
    const recordCount = Number(row.record_count || 0);
    const lastUpdated = row.last_updated || null;
    byStream.set(row.stream, {
      record_count: recordCount,
      last_updated: lastUpdated,
      freshness: buildFreshness(lastUpdated),
    });
    if (lastUpdated && (!latest || lastUpdated > latest)) {
      latest = lastUpdated;
    }
  }
  return {
    byStream,
    freshness: buildFreshness(latest),
    totalRecords: rows.reduce((sum, row) => sum + Number(row.record_count || 0), 0),
  };
}

function buildManifestExcerpt(manifest: ConnectorManifest): ManifestExcerpt {
  return {
    connector_id: manifest.connector_id,
    display_name: manifest.display_name || manifest.connector_id || "",
    version: manifest.version,
    protocol_version: manifest.protocol_version || null,
    profile_ids: Array.isArray(manifest.profiles) ? manifest.profiles.map((profile) => profile.id) : [],
  };
}

function buildStreamSummary(
  stream: { name: string; semantics?: string },
  live: StreamProjection | null = null,
  connectorFreshness: Freshness | null = null
): StreamSummary {
  return {
    object: "stream",
    name: stream.name,
    semantics: stream.semantics || null,
    record_count: live?.record_count || 0,
    last_updated: live?.last_updated || null,
    freshness: connectorFreshness || live?.freshness || { status: "unknown" },
  };
}

async function listRegisteredConnectorRows(): Promise<readonly ConnectorRow[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT connector_id, manifest::text AS manifest
       FROM connectors
       ORDER BY connector_id`
    );
    return result.rows as ConnectorRow[];
  }
  // REVIEWED-BOUNDED: connectors table is O(registered providers); whole-table scan is acceptable.
  return allowUnboundedReadAcknowledged<ConnectorRow>(referenceQueries.listRegisteredConnectors);
}

export function isPublicReferenceConnector(row: ConnectorRow, manifest: ConnectorManifest): boolean {
  const connectorId = row.connector_id || manifest.connector_id || "";
  if (NON_PUBLIC_CONNECTOR_ID_PARTS.some((part) => connectorId.includes(part))) {
    return false;
  }

  const publicListing = manifest.capabilities?.public_listing;
  if (publicListing && typeof publicListing === "object" && !Array.isArray(publicListing)) {
    const listing = publicListing as { listed?: unknown; status?: unknown };
    if (listing.listed === true) {
      return true;
    }
    if (listing.listed === false || listing.status === "unproven") {
      return false;
    }
  }

  const localDeviceBinding = manifest.runtime_requirements?.bindings?.local_device;
  if (
    localDeviceBinding &&
    typeof localDeviceBinding === "object" &&
    !Array.isArray(localDeviceBinding) &&
    (localDeviceBinding as { required?: unknown }).required === true
  ) {
    return false;
  }

  return true;
}

function getScheduleFrom(controller: ControllerLike | null | undefined, connectorId: string): Promise<unknown> {
  if (controller && typeof controller.getSchedule === "function") {
    return (controller as ScheduleLike).getSchedule(connectorId);
  }
  return Promise.resolve(null);
}

function extractRefreshPolicy(manifest: ConnectorManifest): unknown {
  const caps = manifest.capabilities as Record<string, unknown> | undefined;
  if (!caps || typeof caps !== "object") {
    return null;
  }
  return caps.refresh_policy ?? null;
}

function getMaximumStalenessSeconds(refreshPolicy: unknown): number | null {
  if (!refreshPolicy || typeof refreshPolicy !== "object" || Array.isArray(refreshPolicy)) {
    return null;
  }
  const value = (refreshPolicy as { maximum_staleness_seconds?: unknown }).maximum_staleness_seconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function mapFreshnessAxis(freshness: Freshness): FreshnessAxis {
  if (freshness.status === "current") {
    return "fresh";
  }
  if (freshness.status === "stale") {
    return "stale";
  }
  return "unknown";
}

function hasDegradingKnownGap(run: ConnectorRunSummary | null): boolean {
  if (!run) {
    return false;
  }
  return run.known_gaps.some((gap) => {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      return true;
    }
    const severity = (gap as { severity?: unknown }).severity;
    return severity !== "informational" && severity !== "recoverable";
  });
}

function firstDegradingKnownGapReason(run: ConnectorRunSummary | null): string | null {
  if (!run) {
    return null;
  }
  for (const gap of run.known_gaps) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      return null;
    }
    const severity = (gap as { severity?: unknown }).severity;
    if (severity === "informational" || severity === "recoverable") {
      continue;
    }
    const reason = (gap as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return reason;
    }
  }
  return null;
}

function mapCoverageAxis(lastRun: ConnectorRunSummary | null): CoverageAxis {
  if (!lastRun) {
    return "unknown";
  }
  if (hasDegradingKnownGap(lastRun)) {
    return "gaps";
  }
  if (lastRun.status === "succeeded" || lastRun.status === "success") {
    return "complete";
  }
  if (lastRun.status === "failed" || lastRun.status === "cancelled" || lastRun.status === "abandoned") {
    return "partial";
  }
  return "unknown";
}

function mapRunStatus(status: string | null | undefined): "failed" | "succeeded" | null {
  if (!status) {
    return null;
  }
  if (status === "succeeded" || status === "success") {
    return "succeeded";
  }
  if (status === "failed" || status === "cancelled" || status === "abandoned") {
    return "failed";
  }
  return null;
}

function asScheduleRecord(schedule: unknown): Record<string, unknown> | null {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return null;
  }
  return schedule as Record<string, unknown>;
}

function asBackoffRecord(schedule: Record<string, unknown> | null): Record<string, unknown> | null {
  const backoff = schedule?.scheduler_backoff;
  if (!backoff || typeof backoff !== "object" || Array.isArray(backoff)) {
    return null;
  }
  return backoff as Record<string, unknown>;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function projectConnectorSummaryConnectionHealth(input: {
  readonly freshness: Freshness;
  readonly lastRun: ConnectorRunSummary | null;
  readonly lastSuccessfulRun: ConnectorRunSummary | null;
  readonly schedule: unknown;
}): ConnectionHealthSnapshot {
  const schedule = asScheduleRecord(input.schedule);
  const schedulerBackoff = asBackoffRecord(schedule);
  const humanAttentionNeeded = schedule?.human_attention_needed === true;
  const activeRunId = typeof schedule?.active_run_id === "string" && schedule.active_run_id ? schedule.active_run_id : null;
  const nextDueAt = typeof schedule?.next_due_at === "string" ? schedule.next_due_at : null;
  const lastErrorCode = typeof schedule?.last_error_code === "string" ? schedule.last_error_code : null;
  const scheduleLastSuccessfulAt =
    typeof schedule?.last_successful_at === "string" ? schedule.last_successful_at : null;
  const backoffConsecutiveFailures = readNumber(schedulerBackoff?.consecutive_failures) ?? 0;
  const backoffNextRunAt = typeof schedulerBackoff?.next_run_at === "string" ? schedulerBackoff.next_run_at : nextDueAt;
  const backoffReasonClass =
    typeof schedulerBackoff?.reason_class === "string" ? schedulerBackoff.reason_class : lastErrorCode;
  const schedulerFailureStatus =
    schedulerBackoff && (schedulerBackoff.backoff_applied === true || backoffConsecutiveFailures > 0) ? "failed" : null;
  return computeConnectionHealth({
    activity: { active: activeRunId !== null },
    attention: humanAttentionNeeded
      ? {
          actionTarget: null,
          expiresAt: null,
          lifecycle: "open",
          reasonCode: lastErrorCode ?? "needs_human_attention",
        }
      : null,
    backoff: schedulerBackoff || nextDueAt
      ? {
          backoffApplied: schedulerBackoff?.backoff_applied === true,
          consecutiveFailures: backoffConsecutiveFailures,
          nextRunAt: backoffNextRunAt,
          reasonClass: backoffReasonClass,
        }
      : null,
    coverage: { axis: mapCoverageAxis(input.lastRun) },
    freshness: { axis: mapFreshnessAxis(input.freshness) },
    outbox: { axis: "unknown" },
    projection: { unreliableSources: [] },
    run: {
      hasDegradingGaps: hasDegradingKnownGap(input.lastRun),
      lastSuccessAt: input.lastSuccessfulRun?.last_at ?? scheduleLastSuccessfulAt,
      latestStatus: mapRunStatus(input.lastRun?.status) ?? schedulerFailureStatus,
      reasonCode: input.lastRun?.failure_reason ?? firstDegradingKnownGapReason(input.lastRun) ?? lastErrorCode,
    },
    schedule: schedule ? { enabled: schedule.enabled !== false } : null,
  });
}

function buildConnectorFreshness({
  lastRun,
  lastSuccessfulRun,
  live,
  refreshPolicy,
}: {
  lastRun: ConnectorRunSummary | null;
  lastSuccessfulRun: ConnectorRunSummary | null;
  live: RecordProjection;
  refreshPolicy: unknown;
}): Freshness {
  return deriveReferenceFreshness({
    lastAttemptedAt: lastRun?.last_at ?? null,
    lastAttemptStatus: lastRun?.status ?? null,
    lastSuccessfulRunAt: lastSuccessfulRun?.last_at ?? null,
    maximumStalenessSeconds: getMaximumStalenessSeconds(refreshPolicy),
    recordLastUpdatedAt: live.freshness.captured_at ?? null,
  });
}

export function listConnectorSummaries(controller?: ControllerLike | null): Promise<ConnectorSummary[]> {
  return listRegisteredConnectorRows().then((rows) =>
    Promise.all(
      rows.map(async (row) => {
        const manifest = parseManifest(row.manifest, row.connector_id);
        if (!isPublicReferenceConnector(row, manifest)) {
          return null;
        }
        const live = await getConnectorRecordProjection(row.connector_id);
        const [schedule, lastRun, lastSuccessfulRun] = await Promise.all([
          getScheduleFrom(controller, row.connector_id),
          getLatestRunSummary(row.connector_id),
          getLatestRunSummary(row.connector_id, "succeeded"),
        ]);
        const refreshPolicy = extractRefreshPolicy(manifest);
        const freshness = buildConnectorFreshness({
          lastRun,
          lastSuccessfulRun,
          live,
          refreshPolicy,
        });
        const connectionHealth = projectConnectorSummaryConnectionHealth({
          freshness,
          lastRun,
          lastSuccessfulRun,
          schedule,
        });
        return {
          connection_id: row.connector_id,
          connection_health: connectionHealth,
          connector_id: row.connector_id,
          display_name: manifest.display_name || row.connector_id,
          manifest_version: manifest.version || null,
          streams: (manifest.streams || []).map((stream) => stream.name),
          total_records: live.totalRecords,
          freshness,
          refresh_policy: refreshPolicy,
          schedule,
          last_run: lastRun,
          last_successful_run: lastSuccessfulRun,
        };
      })
    ).then((summaries) => summaries.filter((summary): summary is ConnectorSummary => summary !== null))
  );
}

export async function getConnectorDetail(
  connectorId: string,
  controller?: ControllerLike | null
): Promise<ConnectorDetail> {
  const manifest = (await getConnectorManifest(connectorId)) as ConnectorManifest | null;
  if (!manifest) {
    throw new RefControlError(`Unknown connector: ${connectorId}`, "not_found");
  }
  const live = await getConnectorRecordProjection(connectorId);
  const [schedule, lastRun, lastSuccessfulRun] = await Promise.all([
    getScheduleFrom(controller, connectorId),
    getLatestRunSummary(connectorId),
    getLatestRunSummary(connectorId, "succeeded"),
  ]);
  const refreshPolicy = extractRefreshPolicy(manifest);
  const freshness = buildConnectorFreshness({
    lastRun,
    lastSuccessfulRun,
    live,
    refreshPolicy,
  });
  const connectionHealth = projectConnectorSummaryConnectionHealth({
    freshness,
    lastRun,
    lastSuccessfulRun,
    schedule,
  });
  return {
    object: "ref_connector_detail",
    connection_id: connectorId,
    connection_health: connectionHealth,
    connector_id: connectorId,
    display_name: manifest.display_name || connectorId,
    manifest_version: manifest.version || null,
    total_records: live.totalRecords,
    freshness,
    schedule,
    last_run: lastRun,
    last_successful_run: lastSuccessfulRun,
    recent_runs: lastRun ? [lastRun] : [],
    manifest_excerpt: buildManifestExcerpt(manifest),
    streams: (manifest.streams || []).map((stream) =>
      buildStreamSummary(stream, live.byStream.get(stream.name) || null, freshness)
    ),
  };
}

function buildConsentApproval(row: PendingConsentRow): ConsentApproval | null {
  // approval_id is populated for every row created after the
  // device-code-exposure fix. Pre-existing rows from an older DB schema
  // have approval_id = NULL; we drop those from the projection rather
  // than fall back to device_code, because device_code on this surface
  // is the security defect we are fixing.
  if (!row.approval_id) {
    return null;
  }
  const request = parseManifest(row.params_json, `pending consent ${row.approval_id}`) as ConsentRequestEnvelope;
  const source = sourcePreviewFromConsentRequest(request);
  return {
    object: "approval",
    approval_id: row.approval_id,
    kind: "consent",
    client_id: request.client?.client_id || null,
    request_uri: null,
    user_code: null,
    created_at: row.created_at,
    grant_preview: {
      access_mode: request.selection?.access_mode || null,
      purpose_code: request.selection?.purpose_code || null,
      purpose_description: request.selection?.purpose_description || null,
      source,
      streams: request.selection?.streams || [],
    },
  };
}

function sourcePreviewFromConsentRequest(request: ConsentRequestEnvelope): SourcePreview | null {
  const source = request.source_binding;
  if (source?.kind === "connector" && source.id) {
    return { kind: "connector", id: source.id };
  }
  if (source?.kind === "provider_native" && source.id) {
    return { kind: "provider_native", id: source.id };
  }
  return null;
}

function buildOwnerDeviceApproval(row: PendingOwnerDeviceRow): OwnerDeviceApproval | null {
  if (!row.approval_id) {
    return null;
  }
  return {
    object: "approval",
    approval_id: row.approval_id,
    kind: "owner_device",
    client_id: row.client_id,
    request_uri: null,
    user_code: null,
    created_at: row.created_at,
    grant_preview: null,
  };
}

export function listPendingApprovals(): Promise<Approval[]> {
  const now = new Date().toISOString();
  if (isPostgresStorageBackend()) {
    return Promise.all([
      postgresQuery(
        `SELECT device_code, user_code, params_json::text AS params_json, created_at, approval_id
         FROM pending_consents
         WHERE status = 'pending'
           AND expires_at > $1
         ORDER BY created_at DESC`,
        [now]
      ),
      postgresQuery(
        `SELECT device_code, user_code, client_id, created_at, approval_id
         FROM owner_device_auth
         WHERE status = 'pending'
           AND expires_at > $1
         ORDER BY created_at DESC`,
        [now]
      ),
    ]).then(([pendingConsentsResult, pendingDevicesResult]) => {
      const approvals: Approval[] = [
        ...(pendingConsentsResult.rows as PendingConsentRow[])
          .map(buildConsentApproval)
          .filter((a): a is ConsentApproval => a !== null),
        ...(pendingDevicesResult.rows as PendingOwnerDeviceRow[])
          .map(buildOwnerDeviceApproval)
          .filter((a): a is OwnerDeviceApproval => a !== null),
      ];
      approvals.sort((left, right) => {
        if (left.created_at === right.created_at) {
          return 0;
        }
        return left.created_at < right.created_at ? 1 : -1;
      });
      return approvals;
    });
  }
  // REVIEWED-BOUNDED: pending consents form a human-driven queue trimmed by the
  // expires_at predicate; the table cannot meaningfully exceed dozens of rows.
  const pendingConsents = allowUnboundedReadAcknowledged<PendingConsentRow>(
    referenceQueries.approvalsListPendingConsents,
    [now]
  );
  // REVIEWED-BOUNDED: in-flight owner CLI device flows form a human-driven queue
  // trimmed by the expires_at predicate; the table cannot meaningfully exceed
  // dozens of rows.
  const pendingDevices = allowUnboundedReadAcknowledged<PendingOwnerDeviceRow>(
    referenceQueries.approvalsListPendingOwnerDevices,
    [now]
  );
  const approvals: Approval[] = [
    ...pendingConsents.map(buildConsentApproval).filter((a): a is ConsentApproval => a !== null),
    ...pendingDevices.map(buildOwnerDeviceApproval).filter((a): a is OwnerDeviceApproval => a !== null),
  ];
  approvals.sort((left, right) => {
    if (left.created_at === right.created_at) {
      return 0;
    }
    return left.created_at < right.created_at ? 1 : -1;
  });
  return Promise.resolve(approvals);
}

// ─── Records timeline ───────────────────────────────────────────────────────

const SAFE_JSON_FIELD_RE = /^[A-Za-z_][A-Za-z_0-9]*$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeJsonPathExpr(field: string, label: string): string {
  if (typeof field !== "string" || !SAFE_JSON_FIELD_RE.test(field)) {
    throw new Error(`[ref-control] Unsafe JSON field ${label}: ${JSON.stringify(field)}`);
  }
  return `json_extract(record_json, '$.${field}')`;
}

/**
 * Normalize caller-supplied `since`/`until` values for SQL comparison. Mirrors
 * what `ref-record-utils::parseDateLike` does for the JS post-filter: a
 * bare `YYYY-MM-DD` value expands to the start (since) or end (until) of the
 * day so ISO-datetime-valued rows on the boundary match as intended.
 */
function expandBoundary(value: string | null | undefined, boundary: "end" | "start"): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return value ?? null;
  }
  const trimmed = value.trim();
  if (!DATE_ONLY_RE.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}${boundary === "end" ? "T23:59:59.999Z" : "T00:00:00.000Z"}`;
}

interface PairRow {
  readonly connector_id: string;
  readonly stream: string;
}

/**
 * Enumerate the (connector_id, stream) pairs we need to query, narrowed by
 * caller-supplied filters. Cheap: records(connector_id, stream) is indexed,
 * and the count of pairs is on the order of (registered connectors × streams
 * per connector) — dozens, not thousands.
 */
const TIMELINE_PAIR_ENUMERATION_LIMIT = 1024;

function enumerateCandidatePairs(
  connectorId: string | null,
  stream: string | null
): { connectorId: string; stream: string }[] {
  const where: string[] = ["deleted = 0"];
  const binds: (number | string)[] = [];
  if (connectorId) {
    where.push("connector_id = ?");
    binds.push(connectorId);
  }
  if (stream) {
    where.push("stream = ?");
    binds.push(stream);
  }
  // REVIEWED-DYNAMIC: WHERE clause varies with caller-supplied connectorId/stream
  // filters, so the artifact registry cannot validate a fixed SQL string here.
  // The LIMIT ? guard caps the worst case at TIMELINE_PAIR_ENUMERATION_LIMIT
  // distinct (connector_id, stream) pairs; realistic load is dozens.
  const sql = `
    SELECT DISTINCT connector_id, stream
    FROM records
    WHERE ${where.join(" AND ")}
    LIMIT ?
  `;
  const pairs: { connectorId: string; stream: string }[] = [];
  for (const row of iterateDynamicSqlAcknowledged<PairRow>(sql, [...binds, TIMELINE_PAIR_ENUMERATION_LIMIT])) {
    pairs.push({ connectorId: row.connector_id, stream: row.stream });
  }
  return pairs;
}

interface TimelineQueryRow {
  readonly connector_id: string;
  readonly emitted_at: string;
  readonly record_json: string | null;
  readonly record_key: string;
  readonly stream: string;
  readonly version: number | null;
}

function buildTimelineSql({
  manifestStream,
  timestampMode,
  since,
  until,
  orderDir,
}: {
  manifestStream: ManifestStreamLike | null;
  orderDir: "ASC" | "DESC";
  since: string | null;
  timestampMode: "emitted" | "native";
  until: string | null;
}): { sql: string; binds: (number | string)[]; timestampExpr: string } {
  // Keep this dynamic SQL inline: optional time-window predicates, native
  // timestamp JSON fields, and caller-selected order direction change the
  // statement shape in ways that are easier to audit beside the validation.
  const semanticField =
    timestampMode === "native" ? manifestStream?.consent_time_field || manifestStream?.cursor_field || null : null;
  const timestampExpr = semanticField
    ? `COALESCE(NULLIF(${safeJsonPathExpr(semanticField, "semantic_time_field")}, ''), emitted_at)`
    : "emitted_at";

  const where: string[] = ["connector_id = ?", "stream = ?", "deleted = 0"];
  const binds: (number | string)[] = [];

  if (since) {
    where.push(`${timestampExpr} >= ?`);
    const expanded = expandBoundary(since, "start");
    if (expanded !== null) {
      binds.push(expanded);
    }
  }
  if (until) {
    where.push(`${timestampExpr} <= ?`);
    const expanded = expandBoundary(until, "end");
    if (expanded !== null) {
      binds.push(expanded);
    }
  }

  const sql = `
      SELECT connector_id, stream, record_key, record_json, emitted_at, version
      FROM records
      WHERE ${where.join(" AND ")}
      ORDER BY ${timestampExpr} ${orderDir}, emitted_at ${orderDir}, record_key ${orderDir}
      LIMIT ?
    `;
  return { sql, binds, timestampExpr };
}

function comparePrimaryDesc(order: "asc" | "desc", left: TimelineEntry, right: TimelineEntry): number {
  const primary = compareTimestampValues(left.display_timestamp, right.display_timestamp);
  if (primary !== 0) {
    return order === "asc" ? primary : -primary;
  }
  if (left.emitted_at !== right.emitted_at) {
    return order === "asc"
      ? compareTimestampValues(left.emitted_at, right.emitted_at)
      : compareTimestampValues(right.emitted_at, left.emitted_at);
  }
  return order === "asc"
    ? String(left.id).localeCompare(String(right.id))
    : String(right.id).localeCompare(String(left.id));
}

/**
 * `/_ref/records/timeline` body builder.
 *
 * Reads per-(connector, stream) slices with SQL-side `since`/`until`
 * filtering against either the manifest-declared `consent_time_field`/
 * `cursor_field` (native mode) or `emitted_at` (emitted mode). Merges
 * them, applies a final JS window check for date-only boundaries, and
 * clips to the caller's `limit`.
 *
 * Route contract preserved: returns `{object: 'list', data, meta}` with the
 * same entry shape (connector_id, stream, id, emitted_at, version, data,
 * semantic_timestamp, display_timestamp).
 */
function rowPassesWindow(
  timestampMode: "emitted" | "native",
  semanticTimestamp: SemanticTimestamp | null,
  emittedAt: string,
  since: string | null,
  until: string | null
): boolean {
  // Final-pass JS window check — covers the edge case where the SQL
  // compared ISO strings lexically but `since`/`until` used a date-only
  // value (`YYYY-MM-DD`); timestampWithinWindow normalizes those to
  // day boundaries.
  if (timestampMode === "native") {
    const candidate = semanticTimestamp?.value || emittedAt;
    return timestampWithinWindow(candidate, since, until);
  }
  return timestampWithinWindow(emittedAt, since, until);
}

function buildTimelineEntry(
  row: TimelineQueryRow,
  manifestStream: ManifestStreamLike | null,
  timestampMode: "emitted" | "native"
): TimelineEntry | null {
  const recordData: unknown = row.record_json ? JSON.parse(row.record_json) : null;
  const semanticTimestamp = pickSemanticTimestamp(manifestStream ?? null, recordData);
  const displayTimestamp = chooseDisplayTimestamp({
    semanticTimestamp,
    emittedAt: row.emitted_at,
    mode: timestampMode,
  });
  return {
    object: "timeline_entry",
    connector_id: row.connector_id,
    stream: row.stream,
    id: row.record_key,
    emitted_at: row.emitted_at,
    version: row.version,
    data: recordData,
    semantic_timestamp: semanticTimestamp,
    display_timestamp: displayTimestamp,
  };
}

async function collectPairEntries(
  pair: { connectorId: string; stream: string },
  opts: {
    orderDir: "ASC" | "DESC";
    perPairLimit: number;
    since: string | null;
    timestampMode: "emitted" | "native";
    until: string | null;
  }
): Promise<TimelineEntry[]> {
  const manifest = (await getConnectorManifest(pair.connectorId)) as ConnectorManifest | null;
  const manifestStream = manifest?.streams?.find((item) => item.name === pair.stream) ?? null;

  const { sql, binds } = buildTimelineSql({
    manifestStream,
    timestampMode: opts.timestampMode,
    since: opts.since,
    until: opts.until,
    orderDir: opts.orderDir,
  });

  const entries: TimelineEntry[] = [];
  // REVIEWED-DYNAMIC: WHERE/ORDER BY shape is selected by buildTimelineSql from
  // manifest-driven timestamp expressions and caller-supplied since/until/order
  // values, so the artifact registry cannot validate this SQL up front. The
  // statement embeds a trailing LIMIT ? bound by perPairLimit, which the caller
  // derives from the request's `limit` field.
  for (const row of iterateDynamicSqlAcknowledged<TimelineQueryRow>(sql, [
    pair.connectorId,
    pair.stream,
    ...binds,
    opts.perPairLimit,
  ])) {
    const entry = buildTimelineEntry(row, manifestStream, opts.timestampMode);
    if (!entry) {
      continue;
    }
    if (!rowPassesWindow(opts.timestampMode, entry.semantic_timestamp, entry.emitted_at, opts.since, opts.until)) {
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Substrate read for the `ref.records.timeline` operation.
 *
 * Returns the merged-and-sorted timeline entries for the given window,
 * without applying the final limit slice or assembling the envelope —
 * the operation module
 * (`reference-implementation/operations/ref-records-timeline/index.ts`)
 * owns that shape. Returning a slightly-over-limit collection here is
 * intentional: the operation re-clips, and an explorer caller (e.g. a
 * future operation behavior test) can ask for the full pre-clip set.
 */
export async function collectRecordsTimelineEntries({
  connectorId = null,
  stream = null,
  since = null,
  until = null,
  limit = 50,
  order = "desc",
  timestampMode = "native",
}: TimelineOptions = {}): Promise<TimelineEntry[]> {
  const pairs = enumerateCandidatePairs(connectorId, stream);
  const perPairLimit = Math.max(limit * 2, 10);
  const orderDir: "ASC" | "DESC" = order === "asc" ? "ASC" : "DESC";

  const perPair = await Promise.all(
    pairs.map((pair) => collectPairEntries(pair, { orderDir, perPairLimit, since, timestampMode, until }))
  );
  const collected = perPair.flat();

  collected.sort((left, right) => comparePrimaryDesc(order, left, right));

  return collected;
}

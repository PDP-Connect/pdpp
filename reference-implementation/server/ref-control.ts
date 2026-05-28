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

import type { BrowserSurface, BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";
import { allowUnboundedReadAcknowledged, getOne, iterateDynamicSqlAcknowledged, referenceQueries } from "../lib/db.ts";
import { listSpineCorrelations, type SpineSummary } from "../lib/spine.ts";
import { type AttentionRecord, isHealthRelevant, type OwnerAction } from "../runtime/attention.ts";
import { readBrowserSurfaceProfileKey } from "../runtime/browser-surface-profile-key.ts";
import {
  type ConnectionAttentionEvidence,
  type ConnectionHealthSnapshot,
  type ConnectionRemoteSurfaceEvidence,
  type CoverageAxis,
  computeConnectionHealth,
  deriveOutboxAxisFromHeartbeat,
  type FreshnessAxis,
  type NextAction,
  type OutboxAxis,
} from "../runtime/connection-health.ts";
import { getConnectorManifest } from "./auth.js";
import { deriveReferenceFreshness, type ReferenceFreshness } from "./freshness.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";
import {
  chooseDisplayTimestamp,
  compareTimestampValues,
  type ManifestStreamLike,
  pickSemanticTimestamp,
  type SemanticTimestamp,
  timestampWithinWindow,
} from "./ref-record-utils.ts";
import { listRetainedSizeConnections, listRetainedSizeStreams } from "./retained-size-read-model.js";
import { getDefaultBrowserSurfaceLeaseStore } from "./stores/browser-surface-lease-store.ts";
import { getDefaultConnectorAttentionStore } from "./stores/connector-attention-store.js";
import { getDefaultConnectorDetailGapStore } from "./stores/connector-detail-gap-store.js";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "./stores/connector-instance-store.js";
import { getDefaultDeviceExporterStore } from "./stores/device-exporter-store.js";

// ─── Shared domain types ────────────────────────────────────────────────────

interface ManifestStream extends ManifestStreamLike {
  /**
   * Accepted-coverage policy for the stream. Default (absent) means
   * `collect`: the connector intends to collect this stream and any
   * absence is a gap. Other values declare the absence as accepted:
   *
   *   - `unsupported`    : the connector implementation cannot collect
   *                        this stream and that limit is known/accepted
   *   - `unavailable`    : the upstream source cannot expose the stream
   *                        for this account/configuration
   *   - `deferred`       : collection is intentionally deferred per policy
   *   - `inventory_only` : only inventory/discovery is owed; no detail
   *
   * Combining `required: true` with an accepted-coverage policy is
   * contradictory (a stream cannot be both load-bearing and accepted-
   * absent) and degrades health rather than projecting green.
   */
  coverage_policy?: "collect" | "deferred" | "inventory_only" | "unavailable" | "unsupported";
  name: string;
  /**
   * Required-stream policy. Defaults to `true` when absent so that streams
   * declared in a manifest without explicit policy are treated as
   * load-bearing for connection health. Manifest authors opt OUT of
   * required-stream policy by setting `required: false` (i.e. the stream
   * is documented but not load-bearing).
   */
  required?: boolean;
  semantics?: string;
}

type AcceptedCoveragePolicy = "deferred" | "inventory_only" | "unavailable" | "unsupported";

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

const NON_PUBLIC_CONNECTOR_ID_PARTS = [
  "manual_action_stub",
  "manual-action-stub",
  "stream-test-stub",
  "pg_runtime_",
  "pg_canonical_",
  "pg_expand_",
];
const REFERENCE_OWNER_SUBJECT_ID = "owner_local";

type Freshness = ReferenceFreshness;

interface RecordProjection {
  readonly byStream: Map<string, StreamProjection>;
  readonly freshness: Freshness;
  readonly retainedBytes: RetainedBytesBreakdown | null;
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

export interface RetainedBytesBreakdown {
  readonly blob_bytes: number;
  readonly record_changes_json_bytes: number;
  readonly record_json_bytes: number;
  readonly total_bytes: number;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly displayName: string;
  readonly ownerSubjectId: string;
  readonly revokedAt: string | null;
  readonly sourceKind: string;
  readonly status: string;
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

interface PendingDetailGapSummary {
  readonly connector_instance_id?: unknown;
  readonly next_attempt_after?: unknown;
  readonly reason?: unknown;
  readonly source?: unknown;
  readonly status?: unknown;
  readonly stream?: unknown;
}

interface DetailGapProjection {
  readonly gaps: readonly PendingDetailGapSummary[];
  readonly unreliable: boolean;
}

interface ConnectorDetailGapStoreLike {
  listPendingGaps(input: {
    connectorId: string;
    connectorInstanceId?: string;
    limit?: number;
  }): Promise<readonly PendingDetailGapSummary[]> | readonly PendingDetailGapSummary[];
  listPendingGapsForConnector?: (
    connectorId: string,
    options?: { limit?: number }
  ) => Promise<readonly PendingDetailGapSummary[]> | readonly PendingDetailGapSummary[];
}

interface ScheduleLike {
  getSchedule(connectorId: string, options?: { readonly connectorInstanceId?: string }): Promise<unknown>;
}

interface ControllerLike {
  getSchedule?(connectorId: string): Promise<unknown>;
}

/**
 * Durable progress evidence sourced from device-side heartbeats and
 * outboxes. Surfaced for local-device connections that bypass
 * `scheduler_run_history` (records are pushed from a device outbox).
 *
 * The dashboard renders these without inventing precision: "last checked: X"
 * for heartbeat evidence and "last ingest: X" for ingest-batch evidence.
 * When no trusted heartbeat row exists for the `connector_instance_id`, the
 * field is `null` and the dashboard falls back to its existing
 * scheduler-based labels.
 *
 * Scoped strictly to `connector_instance_id` to prevent one device's
 * heartbeat from painting another device's pill.
 */
export interface LocalDeviceProgress {
  readonly last_heartbeat_at: string | null;
  readonly last_heartbeat_status: string | null;
  readonly last_ingest_at: string | null;
  readonly records_pending: number | null;
  readonly source_count: number;
}

export interface ConnectorSummary {
  readonly connection_health: ConnectionHealthSnapshot;
  readonly connection_id: string;
  readonly connector_display_name: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly display_name: string;
  readonly freshness: Freshness;
  readonly last_run: ConnectorRunSummary | null;
  readonly last_successful_run: ConnectorRunSummary | null;
  /**
   * Push-mode (local-device exporter) durable progress evidence. `null`
   * for scheduler-managed connections and for local-device connections
   * with no trusted heartbeat row yet.
   */
  readonly local_device_progress: LocalDeviceProgress | null;
  readonly manifest_version: string | null;
  /**
   * Top-level mirror of `connection_health.next_action`. Mirrored at the
   * row level so the dashboard list view does not have to peer inside
   * the health snapshot to render a CTA chip. `null` when the
   * connection does not need owner action.
   */
  readonly next_action: NextAction | null;
  readonly refresh_policy: unknown;
  /**
   * Storage bytes by retention class. `total_retained_bytes` is kept for
   * compatibility; this breakdown lets the operator distinguish current live
   * records from retained change history.
   */
  readonly retained_bytes?: RetainedBytesBreakdown | null;
  readonly schedule: unknown;
  readonly stream_count?: number;
  readonly streams: string[];
  readonly total_records: number;
  readonly total_retained_bytes?: number | null;
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
  /** See `ConnectorSummary.next_action`. */
  readonly next_action: NextAction | null;
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

async function getRetainedBytesForConnection(connectorInstanceId: string): Promise<RetainedBytesBreakdown | null> {
  const row = (await listRetainedSizeConnections({ connectorInstanceId }))[0] as
    | {
        current_record_json_bytes?: number;
        record_history_json_bytes?: number;
        blob_bytes?: number;
      }
    | undefined;
  if (!row) {
    return null;
  }
  const recordJsonBytes = Number(row.current_record_json_bytes || 0);
  const recordChangesJsonBytes = Number(row.record_history_json_bytes || 0);
  const blobBytes = Number(row.blob_bytes || 0);
  return {
    blob_bytes: blobBytes,
    record_changes_json_bytes: recordChangesJsonBytes,
    record_json_bytes: recordJsonBytes,
    total_bytes: recordJsonBytes + recordChangesJsonBytes + blobBytes,
  };
}

async function getConnectorRecordProjection(
  connectorId: string,
  connectorInstanceId?: string
): Promise<RecordProjection> {
  let rows: RecordProjectionRow[];
  if (connectorInstanceId) {
    rows = (await listRetainedSizeStreams({ connectorInstanceId })).map(
      (row: { stream: string; record_count?: number }) => ({
        stream: row.stream,
        record_count: Number(row.record_count || 0),
        last_updated: null,
      })
    ) as RecordProjectionRow[];
  } else {
    rows = (await listRetainedSizeStreams({}))
      .filter((row: { connector_id?: string }) => row.connector_id === connectorId)
      .map((row: { stream: string; record_count?: number }) => ({
        stream: row.stream,
        record_count: Number(row.record_count || 0),
        last_updated: null,
      })) as RecordProjectionRow[];
  }
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
    retainedBytes: connectorInstanceId ? await getRetainedBytesForConnection(connectorInstanceId) : null,
    totalRecords: rows.reduce((sum, row) => sum + Number(row.record_count || 0), 0),
  };
}

interface AttentionStoreProjection {
  readonly records: readonly AttentionRecord[];
  readonly unreliable: boolean;
}

interface ConnectorAttentionStoreLike {
  listOpenAttentionForConnection(input: {
    connectorId: string;
    connectorInstanceId?: string;
    limit?: number;
  }): Promise<readonly AttentionRecord[]> | readonly AttentionRecord[];
}

/**
 * Bounded read for the durable structured-attention store keyed by
 * connector id (and, when available, connector_instance_id).
 *
 * Returns `{ records, unreliable: false }` when the read succeeded —
 * including when the store has no open attention rows. Returns
 * `{ records: [], unreliable: true }` when the underlying store throws,
 * so callers must mark the projection as `unreliable` to avoid a false
 * healthy when attention evidence cannot be read.
 */
export async function getConnectorAttentionProjection(
  connectorId: string,
  options: { readonly connectorInstanceId?: string } = {}
): Promise<AttentionStoreProjection> {
  try {
    const store = getDefaultConnectorAttentionStore() as ConnectorAttentionStoreLike;
    const request: { connectorId: string; connectorInstanceId?: string; limit?: number } = {
      connectorId,
      limit: 50,
    };
    if (options.connectorInstanceId !== undefined) {
      request.connectorInstanceId = options.connectorInstanceId;
    }
    const records = await Promise.resolve(store.listOpenAttentionForConnection(request));
    return { records, unreliable: false };
  } catch {
    return { records: [], unreliable: true };
  }
}

async function getConnectorDetailGapProjection(
  connectorId: string,
  connectorInstanceId?: string
): Promise<DetailGapProjection> {
  try {
    const store = getDefaultConnectorDetailGapStore() as ConnectorDetailGapStoreLike;
    // Operator-console projection must surface pending gaps from every
    // configured source instance (e.g. one device per local Codex/Claude
    // install). `listPendingGaps` requires a single
    // `connectorInstanceId` and silently falls back to the default-account
    // connection when none is given — which drops every real per-device gap from the
    // dashboard. Prefer the connector-wide listing when the store exposes
    // it.
    let gaps: readonly PendingDetailGapSummary[];
    if (connectorInstanceId) {
      gaps = await Promise.resolve(store.listPendingGaps({ connectorId, connectorInstanceId, limit: 100 }));
    } else if (typeof store.listPendingGapsForConnector === "function") {
      gaps = await Promise.resolve(store.listPendingGapsForConnector(connectorId, { limit: 100 }));
    } else {
      gaps = await Promise.resolve(store.listPendingGaps({ connectorId, limit: 100 }));
    }
    return {
      gaps,
      unreliable: false,
    };
  } catch {
    return { gaps: [], unreliable: true };
  }
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

function getConnectorInstanceStore() {
  return isPostgresStorageBackend() ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
}

function recordStorageConnectorIdForConnection(instance: ConnectorInstanceRow): string {
  if (instance.sourceKind === "local_device") {
    return `local-device:${encodeURIComponent(instance.connectorId)}`;
  }
  return instance.connectorId;
}

async function listConnectorInstanceRowsForDashboard(
  registeredRows: readonly ConnectorRow[]
): Promise<readonly ConnectorInstanceRow[]> {
  const store = getConnectorInstanceStore();
  const instances = await store.listByOwner(REFERENCE_OWNER_SUBJECT_ID);
  const active = instances.filter(
    (instance: ConnectorInstanceRow) => instance.status !== "revoked" && !instance.revokedAt
  );
  if (active.length > 0) {
    return active;
  }

  // Materialize a default-account connection for each registered
  // connector that lacks an owner-configured instance row. The dashboard
  // then projects exclusively from connector_instances.
  const now = new Date().toISOString();
  const ensured = await Promise.all(
    registeredRows.map(async (row): Promise<ConnectorInstanceRow | null> => {
      const manifest = parseManifest(row.manifest, row.connector_id);
      return await store.ensureDefaultAccountConnection({
        ownerSubjectId: REFERENCE_OWNER_SUBJECT_ID,
        connectorId: row.connector_id,
        displayName: manifest.display_name || row.connector_id,
        now,
      });
    })
  );
  return ensured.filter(
    (instance): instance is ConnectorInstanceRow =>
      instance !== null && instance.status !== "revoked" && !instance.revokedAt
  );
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

  // Catalog visibility is explicit opt-in only. A connector without
  // capabilities.public_listing.listed === true is hidden by default.
  return false;
}

function getScheduleFrom(
  controller: ControllerLike | null | undefined,
  connectorId: string,
  options: { readonly connectorInstanceId?: string } = {}
): Promise<unknown> {
  if (controller && typeof controller.getSchedule === "function") {
    return (controller as ScheduleLike).getSchedule(connectorId, options);
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

function hasPendingDetailGap(gaps: readonly PendingDetailGapSummary[] = []): boolean {
  return gaps.length > 0;
}

function hasDegradingKnownGap(run: ConnectorRunSummary | null): boolean {
  if (!run) {
    return false;
  }
  return run.known_gaps.some(isDegradingKnownGap);
}

function isDegradingKnownGap(gap: unknown): boolean {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return true;
  }
  const severity = (gap as { severity?: unknown }).severity;
  return severity !== "informational" && severity !== "recoverable";
}

/**
 * Decide whether `run.known_gaps` contains at least one *terminal* gap —
 * one whose severity is `actionable` (owner-fixable, no automated retry)
 * or unclassified. `transient` gaps are runtime-retried so they roll up
 * under `retryable_gap` instead. `informational` and `recoverable`
 * gaps don't degrade health per the connection-health coverage policy
 * and are ignored here.
 */
function hasTerminalKnownGap(run: ConnectorRunSummary | null): boolean {
  if (!run) {
    return false;
  }
  return run.known_gaps.some((gap) => {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      // Unclassified gap shape — be conservative and treat as terminal so
      // we never silently paint over evidence we can't read.
      return true;
    }
    const severity = (gap as { severity?: unknown }).severity;
    if (severity === "actionable") {
      return true;
    }
    // Any other unknown severity counts as terminal (conservative);
    // recognized non-degrading and retryable severities are not terminal.
    return severity !== "informational" && severity !== "recoverable" && severity !== "transient";
  });
}

function firstPendingDetailGapReason(gaps: readonly PendingDetailGapSummary[] = []): string | null {
  for (const gap of gaps) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      continue;
    }
    if (typeof gap.reason === "string" && gap.reason.length > 0) {
      return gap.reason;
    }
    if (typeof gap.stream === "string" && gap.stream.length > 0) {
      return `detail_gap:${gap.stream}`;
    }
  }
  return gaps.length > 0 ? "detail_gap_pending" : null;
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

/**
 * Roll per-stream evidence into the connection-scoped coverage axis.
 *
 * Stream/scope boundary: each `pendingDetailGap` and each `known_gap` is
 * already scoped to a stream (and, for detail gaps, parent_stream and
 * record_key as well). When *any* stream has pending durable retry
 * intent, we surface `retryable_gap` so a list row can never paint an
 * otherwise-clean run green over a pending backlog. When the only gap
 * evidence is terminal (owner-action required, or unclassified shape),
 * we surface `terminal_gap`. If both flavors exist, `terminal_gap`
 * dominates because it is the more urgent claim.
 *
 * Pending detail gaps are themselves runtime-retryable: the store only
 * surfaces rows with `status = 'pending'`, and the runtime has a retry
 * loop keyed on `next_attempt_after`. They never roll up as terminal on
 * their own — only the known_gap severity can promote to terminal.
 *
 * Manifest-declared accepted-coverage:
 *
 *   - A stream may declare `coverage_policy` of `unsupported`,
 *     `unavailable`, `deferred`, or `inventory_only`. When the run has
 *     no degrading gaps and at least one stream declares such a policy,
 *     the rollup surfaces the most-precise accepted-coverage label
 *     (precedence: `unsupported` > `unavailable` > `deferred` >
 *     `inventory_only`). Headline state can still be healthy because
 *     the manifest declared the absence as accepted.
 *
 *   - A stream that is declared BOTH `required: true` AND an accepted-
 *     coverage policy is contradictory (load-bearing AND accepted-
 *     absent). We surface the accepted-coverage label but record that
 *     the rollup is contradictory by also degrading via the
 *     `requiredButUnsupported` channel — see callers.
 */
function mapCoverageAxis(
  lastRun: ConnectorRunSummary | null,
  pendingDetailGaps: readonly PendingDetailGapSummary[] = [],
  manifestStreams: readonly ManifestStream[] = []
): CoverageAxis {
  const hasDetailGap = hasPendingDetailGap(pendingDetailGaps);
  const hasTerminal = hasTerminalKnownGap(lastRun);
  const hasRetryable = lastRun ? lastRun.known_gaps.some((gap) => isRetryableKnownGap(gap)) : false;
  // Contradictory manifest (required AND accepted-absent) takes precedence
  // over the success path so a misconfigured manifest can never paint
  // green. The label still names the declared accepted-coverage policy
  // so the dashboard can show *why* the projection refused to go green.
  const requiredAccepted = pickRequiredAcceptedCoverage(manifestStreams);
  if (requiredAccepted !== null) {
    return requiredAccepted;
  }
  if (hasTerminal) {
    return "terminal_gap";
  }
  if (hasDetailGap || hasRetryable) {
    return "retryable_gap";
  }
  if (!lastRun) {
    return "unknown";
  }
  if (lastRun.status === "succeeded" || lastRun.status === "success") {
    // Promote an accepted-coverage label only when the success path is
    // otherwise clean; this surfaces the most-precise honest claim
    // ("we accept that `messages` is unsupported on this connector")
    // without inventing precision the run did not justify.
    const accepted = pickAcceptedCoverage(manifestStreams);
    return accepted ?? "complete";
  }
  if (lastRun.status === "failed" || lastRun.status === "cancelled" || lastRun.status === "abandoned") {
    return "partial";
  }
  return "unknown";
}

/**
 * Precedence: `unsupported` is the strongest accepted-coverage claim
 * (connector cannot collect by design), then `unavailable` (source-side
 * limit), then `deferred` (intentionally postponed), then
 * `inventory_only` (least surprising — only inventory was ever owed).
 */
const ACCEPTED_COVERAGE_PRECEDENCE: readonly AcceptedCoveragePolicy[] = [
  "unsupported",
  "unavailable",
  "deferred",
  "inventory_only",
];

function pickAcceptedCoverage(streams: readonly ManifestStream[]): AcceptedCoveragePolicy | null {
  if (streams.length === 0) {
    return null;
  }
  const seen = new Set<AcceptedCoveragePolicy>();
  for (const stream of streams) {
    const policy = readAcceptedCoveragePolicy(stream);
    if (policy !== null) {
      seen.add(policy);
    }
  }
  for (const policy of ACCEPTED_COVERAGE_PRECEDENCE) {
    if (seen.has(policy)) {
      return policy;
    }
  }
  return null;
}

/**
 * Same precedence as `pickAcceptedCoverage`, but only considers streams
 * that are *both* declared `required: true` AND have an accepted-
 * coverage policy. This is the contradictory-manifest signal: the
 * connector simultaneously claims the stream is load-bearing AND
 * accepted-absent, so the projection refuses to project healthy.
 */
function pickRequiredAcceptedCoverage(streams: readonly ManifestStream[]): AcceptedCoveragePolicy | null {
  if (streams.length === 0) {
    return null;
  }
  const seen = new Set<AcceptedCoveragePolicy>();
  for (const stream of streams) {
    if (!isRequiredStream(stream)) {
      continue;
    }
    const policy = readAcceptedCoveragePolicy(stream);
    if (policy !== null) {
      seen.add(policy);
    }
  }
  for (const policy of ACCEPTED_COVERAGE_PRECEDENCE) {
    if (seen.has(policy)) {
      return policy;
    }
  }
  return null;
}

function readAcceptedCoveragePolicy(stream: ManifestStream | undefined): AcceptedCoveragePolicy | null {
  if (!stream || typeof stream !== "object") {
    return null;
  }
  const value = stream.coverage_policy;
  if (value === "unsupported" || value === "unavailable" || value === "deferred" || value === "inventory_only") {
    return value;
  }
  return null;
}

function isRequiredStream(stream: ManifestStream | undefined): boolean {
  if (!stream || typeof stream !== "object") {
    return false;
  }
  // Default to required when absent so a manifest-declared stream is
  // load-bearing unless explicitly opted out.
  return stream.required !== false;
}

/**
 * Build the projection's coverage evidence: the axis plus the
 * `requiredButAccepted` contradiction signal. The signal is only set
 * when at least one *required* stream declares an accepted-coverage
 * policy; the connection-health projection then refuses to project
 * healthy even though the axis name is `unsupported`/`unavailable`/
 * `deferred`/`inventory_only`.
 */
function buildCoverageEvidence(
  lastRun: ConnectorRunSummary | null,
  pendingDetailGaps: readonly PendingDetailGapSummary[],
  manifestStreams: readonly ManifestStream[]
): { axis: CoverageAxis; requiredButAccepted: boolean } {
  const axis = mapCoverageAxis(lastRun, pendingDetailGaps, manifestStreams);
  const requiredButAccepted = pickRequiredAcceptedCoverage(manifestStreams) !== null;
  return { axis, requiredButAccepted };
}

/**
 * `transient` severity is the runtime's signal that the gap is
 * actively being re-tried without owner intervention. Per
 * the connection-health coverage policy, `recoverable` means the
 * gap has already been recovered (non-degrading) and `informational`
 * means the gap is out of scope by design (non-degrading); neither
 * counts as a retryable gap for the coverage axis rollup.
 */
function isRetryableKnownGap(gap: unknown): boolean {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return false;
  }
  const severity = (gap as { severity?: unknown }).severity;
  return severity === "transient";
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

function readIsoMillis(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function schedulerFailureAnchorMillis(schedule: Record<string, unknown> | null): number | null {
  const candidates = [readIsoMillis(schedule?.last_finished_at), readIsoMillis(schedule?.last_started_at)].filter(
    (value): value is number => value !== null
  );
  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

function succeededRunSupersedesSchedulerBackoff(
  lastRun: ConnectorRunSummary | null,
  schedule: Record<string, unknown> | null
): boolean {
  if (lastRun?.status !== "succeeded") {
    return false;
  }
  const runMillis = readIsoMillis(lastRun.last_at);
  const failureAnchor = schedulerFailureAnchorMillis(schedule);
  return runMillis !== null && (failureAnchor === null || runMillis >= failureAnchor);
}

/**
 * Stale-heartbeat threshold used by the outbox axis derivation. A
 * heartbeat older than this window with pending work present is treated
 * as stalled rather than active, so a collector that died mid-drain
 * does not sit forever in `active`. Chosen as a conservative single
 * constant for the milestone; future work may tune per-connector once
 * connection-scoped policy lands.
 */
export const OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS = 30 * 60 * 1000;

interface HeartbeatRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string | null;
  readonly deviceId: string;
  readonly deviceRevokedAt: string | null;
  readonly deviceStatus: string;
  readonly lastHeartbeatAt: string | null;
  readonly lastHeartbeatStatus: string | null;
  readonly lastIngestAt: string | null;
  readonly recordsPending: number | null;
  readonly sourceInstanceId: string;
  readonly sourceStatus: string;
  readonly updatedAt: string | null;
}

/**
 * Roll up per-source-instance heartbeat evidence into a single
 * connection outbox axis.
 *
 * - If no source instances exist for the connector, return `unknown`
 *   without marking the projection unreliable: the connector simply
 *   has no enrolled device-side collector, so no honest outbox claim
 *   can be made. The headline stays driven by the other axes.
 * - If at least one trusted source heartbeat exists, project each one
 *   and roll up: `stalled` dominates `active` dominates `idle`;
 *   any `unreliable: true` adds `outbox` to `unreliableSources`.
 */
interface OutboxAxisAccumulator {
  anyTrustedEvidence: boolean;
  anyUnreliable: boolean;
  sawTrustedIdle: boolean;
  sawTrustedUnknown: boolean;
  severity: "active" | "stalled" | null;
}

function escalateOutboxAxisSeverity(
  current: "active" | "stalled" | null,
  rowAxis: OutboxAxis
): "active" | "stalled" | null {
  if (rowAxis === "stalled") {
    return "stalled";
  }
  if (rowAxis === "active" && current !== "stalled") {
    return "active";
  }
  return current;
}

function accumulateOutboxAxisRow(acc: OutboxAxisAccumulator, row: HeartbeatRow, nowIso: string): void {
  const trusted = row.deviceStatus === "active" && row.sourceStatus === "active" && row.deviceRevokedAt === null;
  if (trusted) {
    acc.anyTrustedEvidence = true;
  }
  const result = deriveOutboxAxisFromHeartbeat(
    {
      evidenceTrusted: trusted,
      lastHeartbeatAt: row.lastHeartbeatAt,
      lastHeartbeatStatus: normalizeHeartbeatStatusForAxis(row.lastHeartbeatStatus),
      recordsPending: row.recordsPending,
    },
    {
      nowIso,
      staleHeartbeatThresholdMs: OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS,
    }
  );
  if (result.unreliable) {
    acc.anyUnreliable = true;
  }
  if (!trusted) {
    return;
  }
  acc.severity = escalateOutboxAxisSeverity(acc.severity, result.axis);
  if (result.axis === "idle") {
    acc.sawTrustedIdle = true;
  } else if (result.axis === "unknown") {
    acc.sawTrustedUnknown = true;
  }
}

export function projectConnectorOutboxAxisFromHeartbeats(
  heartbeats: readonly HeartbeatRow[],
  options: { readonly nowIso: string }
): { axis: OutboxAxis; unreliable: boolean; hasEvidence: boolean } {
  if (heartbeats.length === 0) {
    return { axis: "unknown", unreliable: false, hasEvidence: false };
  }
  // Track each trusted row's contribution separately. We can only claim
  // `idle` when every trusted row reports idle; a trusted row whose
  // heartbeat we have never observed (axis = unknown) must not be
  // silently treated as idle, or a dead collector with no record of life
  // would paint the connection green.
  const acc: OutboxAxisAccumulator = {
    anyUnreliable: false,
    anyTrustedEvidence: false,
    sawTrustedIdle: false,
    sawTrustedUnknown: false,
    severity: null,
  };
  for (const row of heartbeats) {
    accumulateOutboxAxisRow(acc, row, options.nowIso);
  }
  // If every row is untrusted (e.g. all sources/devices revoked), there
  // is no honest evidence — keep `unknown` rather than implying idle.
  if (!acc.anyTrustedEvidence) {
    return { axis: "unknown", unreliable: acc.anyUnreliable, hasEvidence: false };
  }
  if (acc.severity !== null) {
    return { axis: acc.severity, unreliable: acc.anyUnreliable, hasEvidence: true };
  }
  // No trusted instance is actively working or stalled. We can only
  // promise `idle` when every trusted instance reported idle — a missing
  // heartbeat on any trusted instance keeps the axis `unknown`.
  if (acc.sawTrustedIdle && !acc.sawTrustedUnknown) {
    return { axis: "idle", unreliable: acc.anyUnreliable, hasEvidence: true };
  }
  return { axis: "unknown", unreliable: acc.anyUnreliable, hasEvidence: acc.sawTrustedIdle };
}

function normalizeHeartbeatStatusForAxis(
  value: string | null
): "blocked" | "healthy" | "retrying" | "starting" | "stopped" | null {
  switch (value) {
    case "blocked":
    case "healthy":
    case "retrying":
    case "starting":
    case "stopped":
      return value;
    default:
      return null;
  }
}

/**
 * Pull device-side source-instance heartbeat evidence for `connectorId`
 * from the device-exporter store and project the rollup outbox axis.
 *
 * Returns `unknown` (with `unreliable: false`) when the connector has
 * no enrolled device — that is honest absence of evidence, not a
 * projection failure. Returns `unreliable: true` only when the store
 * read itself fails or named evidence is untrustworthy.
 */
export async function getConnectorOutboxAxis(
  connectorId: string,
  options: { readonly connectorInstanceId?: string | null } = {}
): Promise<{ axis: OutboxAxis; heartbeats: readonly HeartbeatRow[]; unreliable: boolean }> {
  const store = getDefaultDeviceExporterStore();
  if (typeof store.listSourceInstanceHeartbeatsByConnector !== "function") {
    return { axis: "unknown", heartbeats: [], unreliable: false };
  }
  const connectorInstanceId = options.connectorInstanceId ?? null;
  try {
    // Scope to a single `connector_instance_id` when the caller knows it.
    // Two enrolled devices that share a `connector_id` (e.g. two Claude
    // Code laptops) project independent rows; without this scope a stalled
    // heartbeat on device A would degrade device B's connection-health pill.
    const rows = (await store.listSourceInstanceHeartbeatsByConnector(
      connectorId,
      connectorInstanceId === null ? undefined : { connectorInstanceId }
    )) as readonly HeartbeatRow[];
    const result = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: new Date().toISOString() });
    return { axis: result.axis, heartbeats: rows, unreliable: result.unreliable };
  } catch {
    return { axis: "unknown", heartbeats: [], unreliable: true };
  }
}

/**
 * Project a single `LocalDeviceProgress` from already-collected heartbeat
 * rows. Pure — the caller (typically `getConnectorOutboxAxis`) is
 * responsible for scoping the rows to one `connector_instance_id`.
 *
 * Returns `null` when no trusted source rows exist; we do not surface
 * device-side progress derived solely from revoked / inactive rows.
 */
export function projectLocalDeviceProgress(heartbeats: readonly HeartbeatRow[]): LocalDeviceProgress | null {
  const trusted = heartbeats.filter(
    (row) => row.deviceStatus === "active" && row.sourceStatus === "active" && row.deviceRevokedAt === null
  );
  if (trusted.length === 0) {
    return null;
  }
  let lastHeartbeatAt: string | null = null;
  let lastHeartbeatStatus: string | null = null;
  let lastIngestAt: string | null = null;
  let recordsPending = 0;
  let sawPending = false;
  for (const row of trusted) {
    if (row.lastHeartbeatAt !== null && (lastHeartbeatAt === null || row.lastHeartbeatAt > lastHeartbeatAt)) {
      lastHeartbeatAt = row.lastHeartbeatAt;
      lastHeartbeatStatus = row.lastHeartbeatStatus;
    }
    if (row.lastIngestAt !== null && (lastIngestAt === null || row.lastIngestAt > lastIngestAt)) {
      lastIngestAt = row.lastIngestAt;
    }
    if (typeof row.recordsPending === "number") {
      recordsPending += row.recordsPending;
      sawPending = true;
    }
  }
  return {
    last_heartbeat_at: lastHeartbeatAt,
    last_heartbeat_status: lastHeartbeatStatus,
    last_ingest_at: lastIngestAt,
    records_pending: sawPending ? recordsPending : null,
    source_count: trusted.length,
  };
}

function combineUnreliableSources(
  detailGapsUnreliable: boolean,
  outboxUnreliable: boolean,
  attentionUnreliable = false,
  remoteSurfaceUnreliable = false
): readonly string[] {
  const sources: string[] = [];
  if (detailGapsUnreliable) {
    sources.push("detail_gaps");
  }
  if (outboxUnreliable) {
    sources.push("outbox");
  }
  if (attentionUnreliable) {
    sources.push("attention_store");
  }
  if (remoteSurfaceUnreliable) {
    sources.push("remote_surface_store");
  }
  return sources;
}

/**
 * Lifecycles the connection-health projection treats as "open" for a
 * structured attention record. `attention.isHealthRelevant` enforces
 * additional axes-based filtering on top of this.
 */
const OPEN_LIFECYCLES = new Set(["acknowledged", "in_progress", "open"]);

/**
 * Pick the single most-urgent health-relevant structured attention record
 * for a connection, and project it onto the
 * `ConnectionAttentionEvidence` shape the runtime expects. Falls back to
 * the schedule's `human_attention_needed` flag when no structured record
 * is present, so the projection stays compatible with controllers that
 * have not yet adopted the durable attention store.
 *
 * The fallback emits a `ConnectionAttentionEvidence` with `id: null` and
 * `ownerAction: null`, which causes
 * `connection-health::projectNextAction` to mark the CTA's `source` as
 * `schedule_fallback` — the dashboard renders a caveated "owner action
 * needed" without inventing precision the evidence cannot support.
 *
 * Returns `null` when there is no open attention and no schedule flag,
 * so the projection falls through to the next precedence rung.
 */
function selectAttentionEvidence(input: {
  readonly attentionRecords: readonly AttentionRecord[];
  readonly humanAttentionNeeded: boolean;
  readonly lastErrorCode: string | null;
  readonly nowIso: string;
}): ConnectionAttentionEvidence | null {
  const candidates = input.attentionRecords.filter(
    (record) => OPEN_LIFECYCLES.has(record.lifecycle) && isHealthRelevant(record, input.nowIso)
  );
  const [first, ...restCandidates] = candidates;
  if (first) {
    const picked = pickMostUrgentAttention([first, ...restCandidates]);
    return {
      actionTarget: picked.action_target,
      expiresAt: picked.expires_at,
      id: picked.id,
      lifecycle: picked.lifecycle as ConnectionAttentionEvidence["lifecycle"],
      ownerAction: ownerActionForEvidence(picked.owner_action),
      reasonCode: picked.reason_code,
      responseContract: picked.response_contract,
      sensitivity: picked.sensitivity,
      notificationState: pickedNotificationState(picked),
    };
  }
  if (input.humanAttentionNeeded) {
    return {
      actionTarget: null,
      expiresAt: null,
      id: null,
      lifecycle: "open",
      ownerAction: null,
      reasonCode: input.lastErrorCode ?? "needs_human_attention",
      responseContract: null,
      notificationState: null,
    };
  }
  return null;
}

/**
 * Pick the most-urgent record from a non-empty list of health-relevant
 * candidates. Urgency ordering:
 *
 *   1. `response_required` beats observability-only.
 *   2. Blocked posture beats running.
 *   3. Sooner expiry beats later/no expiry.
 *   4. Earliest `created_at` as a stable tiebreak (don't flip CTAs on
 *      every refresh when two records are equally urgent).
 */
function pickMostUrgentAttention(records: readonly [AttentionRecord, ...AttentionRecord[]]): AttentionRecord {
  // The list is small (<= number of open attention records per
  // connection — typically 0-2); a single reduce over the non-empty
  // tuple keeps the urgency comparator local.
  const [head, ...rest] = records;
  return rest.reduce((best, candidate) => (compareAttentionUrgency(best, candidate) <= 0 ? best : candidate), head);
}

function compareAttentionUrgency(a: AttentionRecord, b: AttentionRecord): number {
  const aResp = a.response_contract === "response_required" ? 1 : 0;
  const bResp = b.response_contract === "response_required" ? 1 : 0;
  if (aResp !== bResp) {
    return bResp - aResp;
  }
  const aBlocked = a.progress_posture === "blocked" ? 1 : 0;
  const bBlocked = b.progress_posture === "blocked" ? 1 : 0;
  if (aBlocked !== bBlocked) {
    return bBlocked - aBlocked;
  }
  const aExpiry = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY;
  const bExpiry = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY;
  if (aExpiry !== bExpiry) {
    return aExpiry - bExpiry;
  }
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

function ownerActionForEvidence(action: OwnerAction): ConnectionAttentionEvidence["ownerAction"] {
  if (action === "none") {
    return null;
  }
  return action;
}

/**
 * Read the durable notification axis off the persisted attention record.
 * Older rows persisted before the `notification_state` field landed
 * default to `"pending"` so the projection stays honest without
 * fabricating delivery evidence. Returns a non-null, non-undefined
 * value so the projection contract stays exact.
 */
function pickedNotificationState(
  record: AttentionRecord
): "acknowledged" | "failed" | "pending" | "sent" | "suppressed" {
  const raw = (record as { notification_state?: unknown }).notification_state;
  if (raw === "acknowledged" || raw === "failed" || raw === "pending" || raw === "sent" || raw === "suppressed") {
    return raw;
  }
  return "pending";
}

/**
 * Roll the browser-surface lease store's per-connector evidence into a
 * single {@link ConnectionRemoteSurfaceEvidence} the connection-health
 * projection consumes.
 *
 * Live evidence sources:
 *
 *   - `browser_surfaces` rows — durable surface instances and their
 *     `health` (`ready | starting | stopping | unhealthy`). An
 *     `unhealthy` surface is the canonical live failure signal: when
 *     the allocator marks a surface unhealthy, the runtime turns any
 *     in-flight lease terminal and stops dispatching new runs at it
 *     until it heals or is replaced.
 *   - `listNonTerminalLeases()` — leases currently queued, starting,
 *     or held against a surface. Terminal failure rows
 *     (`surface_failed`) are not returned here; their effect is
 *     reflected in the surface row's `health` instead.
 *
 * Urgency rollup (one axis per connection, most-urgent first):
 *
 *   1. any unhealthy surface or any non-terminal lease whose backing
 *      surface is unhealthy -> `failed` (design.md: capacity failure
 *      degrades the connection);
 *   2. an active `leased` lease against a ready surface -> `leased`;
 *   3. a `waiting_for_browser_surface` / `starting_surface` lease ->
 *      `waiting`;
 *   4. a managed surface with no active lease -> `idle`;
 *   5. no rows at all -> `none` (host browser / API connector).
 *
 * When the store throws, we return `{ axis: "unknown", unreliable: true }`
 * so the projection can mark `remote_surface_store` as an unreliable
 * source and route the headline to `unknown` rather than silently
 * accepting a stale axis.
 */
export interface ConnectorBrowserSurfaceProjection {
  readonly evidence: ConnectionRemoteSurfaceEvidence | null;
  readonly unreliable: boolean;
}

interface BrowserSurfaceLeaseStoreReader {
  listNonTerminalLeases(): Promise<readonly BrowserSurfaceLease[]>;
  listSurfaces(): Promise<readonly BrowserSurface[]>;
}

const ACTIVE_WAITING_LEASE_STATUSES = new Set<BrowserSurfaceLease["status"]>([
  "waiting_for_browser_surface",
  "starting_surface",
]);

function rankRemoteSurfaceLease(status: BrowserSurfaceLease["status"]): number {
  // Lower rank = more urgent. `leased` above `waiting` so an operator
  // viewing a connection sees "running" before "queued" when both
  // exist; the waiting variants share a rung.
  if (status === "leased") {
    return 0;
  }
  if (status === "starting_surface") {
    return 1;
  }
  if (status === "waiting_for_browser_surface") {
    return 2;
  }
  return 3;
}

function pickMostUrgentLease(leases: readonly BrowserSurfaceLease[]): BrowserSurfaceLease | null {
  if (leases.length === 0) {
    return null;
  }
  const [mostUrgent] = [...leases].sort((a, b) => {
    const r = rankRemoteSurfaceLease(a.status) - rankRemoteSurfaceLease(b.status);
    if (r !== 0) {
      return r;
    }
    // Stable secondary: most-recent requested_at first.
    const at = Date.parse(b.requested_at) - Date.parse(a.requested_at);
    return Number.isFinite(at) ? at : 0;
  });
  return mostUrgent ?? null;
}

function surfaceRecencyMs(surface: BrowserSurface): number {
  const lastUsed = Date.parse(surface.last_used_at);
  if (Number.isFinite(lastUsed)) {
    return lastUsed;
  }
  const created = Date.parse(surface.created_at);
  return Number.isFinite(created) ? created : 0;
}

function pickMostRecentSurface(surfaces: readonly BrowserSurface[]): BrowserSurface | null {
  if (surfaces.length === 0) {
    return null;
  }
  const [mostRecent] = [...surfaces].sort((a, b) => {
    const at = surfaceRecencyMs(b) - surfaceRecencyMs(a);
    if (at !== 0) {
      return at;
    }
    return b.surface_id.localeCompare(a.surface_id);
  });
  return mostRecent ?? null;
}

/**
 * Project the most-urgent remote-surface evidence for a single connector
 * id from the durable browser-surface lease store. Returns `null`
 * evidence for connectors that have no managed remote surface at all
 * (host browser / API connectors), so they cannot be silently degraded
 * by the absence of a lease/surface row.
 */
function projectActiveBrowserSurfaceLease(
  picked: BrowserSurfaceLease,
  surface: BrowserSurface | undefined
): ConnectorBrowserSurfaceProjection | null {
  if (surface?.health === "unhealthy") {
    return {
      evidence: {
        axis: "failed",
        leaseId: picked.lease_id,
        leaseStatus: picked.status,
        profileKey: surface.profile_key,
        surfaceHealth: surface.health,
        surfaceId: surface.surface_id,
        waitReason: "surface_unhealthy",
      },
      unreliable: false,
    };
  }
  if (picked.status === "leased") {
    return {
      evidence: {
        axis: "leased",
        leaseId: picked.lease_id,
        leaseStatus: picked.status,
        profileKey: picked.profile_key,
        surfaceHealth: surface?.health ?? null,
        surfaceId: picked.surface_id ?? null,
        waitReason: null,
      },
      unreliable: false,
    };
  }
  if (ACTIVE_WAITING_LEASE_STATUSES.has(picked.status)) {
    return {
      evidence: {
        axis: "waiting",
        leaseId: picked.lease_id,
        leaseStatus: picked.status,
        profileKey: picked.profile_key,
        surfaceHealth: surface?.health ?? null,
        surfaceId: picked.surface_id ?? null,
        waitReason: picked.wait_reason ?? null,
      },
      unreliable: false,
    };
  }
  return null;
}

function projectFallbackBrowserSurfaceFromSurface(surface: BrowserSurface): ConnectorBrowserSurfaceProjection {
  if (surface.health === "unhealthy") {
    return {
      evidence: {
        axis: "failed",
        leaseId: surface.active_lease_id ?? null,
        leaseStatus: null,
        profileKey: surface.profile_key,
        surfaceHealth: surface.health,
        surfaceId: surface.surface_id,
        waitReason: "surface_unhealthy",
      },
      unreliable: false,
    };
  }
  return {
    evidence: {
      axis: "idle",
      leaseId: null,
      leaseStatus: null,
      profileKey: surface.profile_key,
      surfaceHealth: surface.health,
      surfaceId: surface.surface_id,
      waitReason: null,
    },
    unreliable: false,
  };
}

const BROWSER_SURFACE_UNRELIABLE_PROJECTION: ConnectorBrowserSurfaceProjection = {
  evidence: {
    axis: "unknown",
    leaseId: null,
    leaseStatus: null,
    profileKey: null,
    surfaceHealth: null,
    surfaceId: null,
    waitReason: null,
  },
  unreliable: true,
};

const BROWSER_SURFACE_UNKNOWN_PROJECTION: ConnectorBrowserSurfaceProjection = {
  evidence: {
    axis: "unknown",
    leaseId: null,
    leaseStatus: null,
    profileKey: null,
    surfaceHealth: null,
    surfaceId: null,
    waitReason: null,
  },
  unreliable: false,
};

export async function getConnectorBrowserSurfaceProjection(
  connectorId: string,
  options: { readonly profileKey?: string | null; readonly store?: BrowserSurfaceLeaseStoreReader } = {}
): Promise<ConnectorBrowserSurfaceProjection> {
  const store = options.store ?? (getDefaultBrowserSurfaceLeaseStore() as BrowserSurfaceLeaseStoreReader);
  let leases: readonly BrowserSurfaceLease[];
  let surfaces: readonly BrowserSurface[];
  try {
    [leases, surfaces] = await Promise.all([store.listNonTerminalLeases(), store.listSurfaces()]);
  } catch {
    return BROWSER_SURFACE_UNRELIABLE_PROJECTION;
  }

  const matchesProfile = (profileKey: string | null | undefined): boolean =>
    !options.profileKey || profileKey === options.profileKey;
  const connectorLeases = leases.filter(
    (lease) => lease.connector_id === connectorId && matchesProfile(lease.profile_key)
  );
  const connectorSurfaces = surfaces.filter(
    (surface) => surface.connector_id === connectorId && matchesProfile(surface.profile_key)
  );

  if (connectorLeases.length === 0 && connectorSurfaces.length === 0) {
    // Host browser / API connector — no managed remote surface. Routine
    // absence of evidence, not unreliable evidence.
    return { evidence: null, unreliable: false };
  }

  // 1-2. Active lease evidence is the freshest signal. A stale unhealthy
  // surface from an earlier failed launch must not poison a connection that
  // subsequently leased a ready surface successfully.
  const picked = pickMostUrgentLease(connectorLeases);
  if (picked) {
    const surface = picked.surface_id ? connectorSurfaces.find((s) => s.surface_id === picked.surface_id) : undefined;
    const projection = projectActiveBrowserSurfaceLease(picked, surface);
    if (projection) {
      return projection;
    }
  }

  // 3. Managed surface present, no active lease. Treat the most recent
  // surface as current evidence; old unhealthy rows are diagnostic
  // history, not the present runtime state.
  const surface = pickMostRecentSurface(connectorSurfaces);
  if (surface) {
    return projectFallbackBrowserSurfaceFromSurface(surface);
  }

  // No surface row and no recognized lease status — conservative `unknown`
  // so the dashboard surfaces the gap rather than painting false-green over
  // evidence we cannot classify.
  return BROWSER_SURFACE_UNKNOWN_PROJECTION;
}
export function projectConnectorSummaryConnectionHealth(input: {
  /**
   * Durable structured attention records the caller has already filtered
   * to this connection. The projection picks the most urgent
   * health-relevant record via `attention.isHealthRelevant`. When
   * omitted, the schedule's `human_attention_needed` flag is the only
   * (coarse) fallback.
   */
  readonly attentionRecords?: readonly AttentionRecord[];
  readonly freshness: Freshness;
  readonly lastRun: ConnectorRunSummary | null;
  readonly lastSuccessfulRun: ConnectorRunSummary | null;
  /**
   * Manifest-declared streams. The projection reads each stream's
   * `required` flag and `coverage_policy` to roll up accepted-coverage
   * labels (`unsupported`, `unavailable`, `deferred`, `inventory_only`)
   * and to detect contradictory `required: true` + accepted-absent
   * declarations. Optional; omitting it preserves the prior behavior
   * (coverage axis ignores manifest policy).
   */
  readonly manifestStreams?: readonly ManifestStream[];
  /**
   * Wall-clock anchor for attention expiry/health-relevance checks.
   * Defaults to `new Date().toISOString()`; tests pass a fixed value.
   */
  readonly nowIso?: string;
  readonly outbox?: { axis: OutboxAxis };
  readonly pendingDetailGaps?: readonly PendingDetailGapSummary[];
  /**
   * Pre-projected browser-surface evidence for the connection. The list
   * and detail operations read it via
   * {@link getConnectorBrowserSurfaceProjection}; tests pass synthetic
   * evidence. `null` means "host browser / API connector, no managed
   * remote surface" and never affects headline state. Omit the field
   * entirely for callers that have not opted into the remote-surface
   * axis.
   */
  readonly remoteSurface?: ConnectionRemoteSurfaceEvidence | null;
  readonly unreliableSources?: readonly string[];
  readonly schedule: unknown;
}): ConnectionHealthSnapshot {
  const schedule = asScheduleRecord(input.schedule);
  const schedulerBackoff = asBackoffRecord(schedule);
  const staleSchedulerBackoff = succeededRunSupersedesSchedulerBackoff(input.lastRun, schedule);
  const effectiveSchedulerBackoff = staleSchedulerBackoff ? null : schedulerBackoff;
  const pendingDetailGaps = input.pendingDetailGaps ?? [];
  const humanAttentionNeeded = schedule?.human_attention_needed === true;
  const activeRunId =
    typeof schedule?.active_run_id === "string" && schedule.active_run_id ? schedule.active_run_id : null;
  const nextDueAt = !staleSchedulerBackoff && typeof schedule?.next_due_at === "string" ? schedule.next_due_at : null;
  const lastErrorCode =
    !staleSchedulerBackoff && typeof schedule?.last_error_code === "string" ? schedule.last_error_code : null;
  const scheduleLastSuccessfulAt =
    typeof schedule?.last_successful_at === "string" ? schedule.last_successful_at : null;
  const backoffEvidence = projectSchedulerBackoffEvidence({
    effectiveSchedulerBackoff,
    lastErrorCode,
    nextDueAt,
  });
  const nowIso = input.nowIso ?? new Date().toISOString();
  const attention = selectAttentionEvidence({
    attentionRecords: input.attentionRecords ?? [],
    humanAttentionNeeded,
    lastErrorCode,
    nowIso,
  });
  return computeConnectionHealth({
    activity: { active: activeRunId !== null },
    attention,
    backoff: backoffEvidence.backoff,
    coverage: buildCoverageEvidence(input.lastRun, pendingDetailGaps, input.manifestStreams ?? []),
    freshness: { axis: mapFreshnessAxis(input.freshness) },
    outbox: input.outbox ?? { axis: "unknown" },
    projection: { unreliableSources: input.unreliableSources ?? [] },
    remoteSurface: input.remoteSurface ?? null,
    run: {
      hasDegradingGaps: hasPendingDetailGap(pendingDetailGaps) || hasDegradingKnownGap(input.lastRun),
      lastSuccessAt: input.lastSuccessfulRun?.last_at ?? scheduleLastSuccessfulAt,
      latestStatus: mapRunStatus(input.lastRun?.status) ?? backoffEvidence.schedulerFailureStatus,
      reasonCode:
        input.lastRun?.failure_reason ??
        firstDegradingKnownGapReason(input.lastRun) ??
        firstPendingDetailGapReason(pendingDetailGaps) ??
        lastErrorCode,
    },
    schedule: schedule ? { enabled: schedule.enabled !== false } : null,
    observedAt: nowIso,
  });
}

interface BackoffEvidenceProjection {
  readonly backoff: {
    readonly backoffApplied: boolean;
    readonly consecutiveFailures: number;
    readonly nextRunAt: string | null;
    readonly reasonClass: string | null;
  } | null;
  readonly schedulerFailureStatus: "failed" | null;
}

function projectSchedulerBackoffEvidence(input: {
  readonly effectiveSchedulerBackoff: ReturnType<typeof asBackoffRecord>;
  readonly lastErrorCode: string | null;
  readonly nextDueAt: string | null;
}): BackoffEvidenceProjection {
  const { effectiveSchedulerBackoff, lastErrorCode, nextDueAt } = input;
  const backoffConsecutiveFailures = readNumber(effectiveSchedulerBackoff?.consecutive_failures) ?? 0;
  const hasRetryBackoffEvidence =
    effectiveSchedulerBackoff !== null &&
    (effectiveSchedulerBackoff.backoff_applied === true || backoffConsecutiveFailures > 0);
  if (!hasRetryBackoffEvidence) {
    return { backoff: null, schedulerFailureStatus: null };
  }
  const backoffNextRunAt =
    typeof effectiveSchedulerBackoff?.next_run_at === "string" ? effectiveSchedulerBackoff.next_run_at : nextDueAt;
  const backoffReasonClass =
    typeof effectiveSchedulerBackoff?.reason_class === "string"
      ? effectiveSchedulerBackoff.reason_class
      : lastErrorCode;
  return {
    backoff: {
      backoffApplied: effectiveSchedulerBackoff?.backoff_applied === true,
      consecutiveFailures: backoffConsecutiveFailures,
      nextRunAt: backoffNextRunAt,
      reasonClass: backoffReasonClass,
    },
    schedulerFailureStatus: "failed",
  };
}

function buildConnectorFreshness({
  lastRun,
  lastSuccessfulRun,
  live,
  refreshPolicy,
  lastHeartbeatAt,
}: {
  lastRun: ConnectorRunSummary | null;
  lastSuccessfulRun: ConnectorRunSummary | null;
  live: RecordProjection;
  refreshPolicy: unknown;
  /**
   * For local-device (push-mode) connections there is no scheduler run
   * to anchor freshness. A recent healthy heartbeat is evidence the
   * collector checked in, so use it as a fallback `recordLastUpdatedAt`
   * when no run-based timestamp is available. Omit or pass `null` for
   * scheduler-managed connections.
   */
  lastHeartbeatAt?: string | null;
}): Freshness {
  // For local-device connections with no scheduler run, prefer the
  // heartbeat timestamp as a freshness anchor. A recent heartbeat is
  // honest evidence the collector is alive even if no new data arrived.
  const recordLastUpdatedAt =
    lastRun == null && lastHeartbeatAt != null ? lastHeartbeatAt : (live.freshness.captured_at ?? null);
  return deriveReferenceFreshness({
    lastAttemptedAt: lastRun?.last_at ?? null,
    lastAttemptStatus: lastRun?.status ?? null,
    lastSuccessfulRunAt: lastSuccessfulRun?.last_at ?? null,
    maximumStalenessSeconds: getMaximumStalenessSeconds(refreshPolicy),
    recordLastUpdatedAt,
  });
}

/**
 * Per-connector projection work fanout. Each list row triggers schedule,
 * run-spine, detail-gap, and heartbeat-rollup reads; without a bound the
 * dashboard's list call hits the DB with O(connectors × per-connector
 * queries) requests in flight at once. Eight is small enough to keep the
 * SQLite/Postgres work pool from thrashing while still letting most
 * deployments overlap most projections.
 */
export const LIST_CONNECTOR_SUMMARIES_CONCURRENCY = 8;

/**
 * Bounded parallel map. Preserves input order in the output, runs at
 * most `limit` workers at a time, and exposes a `peakInFlight` counter
 * via the optional `onProgress` hook so tests can prove the bound holds.
 *
 * Intentionally minimal: no dependency, no early-exit semantics, no
 * AbortSignal. Failures reject the returned promise once any in-flight
 * worker finishes; pending work is still drained to avoid hanging
 * connections, matching the prior `Promise.all` behavior.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { readonly onInFlightChange?: (inFlight: number) => void } = {}
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let inFlight = 0;
  let firstError: unknown = null;
  const onChange = options.onInFlightChange;
  const runOne = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      inFlight++;
      onChange?.(inFlight);
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      try {
        results[index] = await worker(item, index);
      } catch (err) {
        if (firstError === null) {
          firstError = err;
        }
      } finally {
        inFlight--;
        onChange?.(inFlight);
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < effectiveLimit; i++) {
    workers.push(runOne());
  }
  await Promise.all(workers);
  if (firstError !== null) {
    throw firstError;
  }
  return results;
}

export interface ListConnectorSummariesOptions {
  readonly concurrency?: number;
  /** Test hook: invoked whenever the in-flight worker count changes. */
  readonly onInFlightChange?: (inFlight: number) => void;
}

export async function listConnectorSummaries(
  controller?: ControllerLike | null,
  options: ListConnectorSummariesOptions = {}
): Promise<ConnectorSummary[]> {
  const connectorRows = await listRegisteredConnectorRows();
  const manifestsByConnectorId = new Map(
    connectorRows.map((row) => [row.connector_id, parseManifest(row.manifest, row.connector_id)])
  );
  const rows = await listConnectorInstanceRowsForDashboard(connectorRows);
  const summaries = await mapWithConcurrency(
    rows,
    options.concurrency ?? LIST_CONNECTOR_SUMMARIES_CONCURRENCY,
    async (instance): Promise<ConnectorSummary | null> => {
      const connectorId = instance.connectorId;
      const connectorInstanceId = instance.connectorInstanceId;
      const manifest = manifestsByConnectorId.get(connectorId);
      if (!manifest) {
        return null;
      }
      if (!isPublicReferenceConnector({ connector_id: connectorId, manifest: JSON.stringify(manifest) }, manifest)) {
        return null;
      }
      const live = await getConnectorRecordProjection(
        recordStorageConnectorIdForConnection(instance),
        connectorInstanceId
      );
      const [schedule, lastRun, lastSuccessfulRun, detailGaps, outbox, attention, remoteSurface] = await Promise.all([
        getScheduleFrom(controller, connectorId, { connectorInstanceId }),
        getLatestRunSummary(connectorId),
        getLatestRunSummary(connectorId, "succeeded"),
        getConnectorDetailGapProjection(connectorId, connectorInstanceId),
        getConnectorOutboxAxis(connectorId, { connectorInstanceId }),
        getConnectorAttentionProjection(connectorId, { connectorInstanceId }),
        getConnectorBrowserSurfaceProjection(connectorId, {
          profileKey: readBrowserSurfaceProfileKey(connectorId, connectorInstanceId, manifest),
        }),
      ]);
      const refreshPolicy = extractRefreshPolicy(manifest);
      const localDeviceProgress =
        instance.sourceKind === "local_device" ? projectLocalDeviceProgress(outbox.heartbeats) : null;
      // A heartbeat can satisfy freshness only when it represents a healthy
      // check with no known local backlog. Active/pending outboxes still show
      // progress via the outbox axis rather than a false "fresh" claim.
      const canUseHeartbeatForFreshness =
        localDeviceProgress?.last_heartbeat_status === "healthy" &&
        (localDeviceProgress.records_pending == null || localDeviceProgress.records_pending === 0);
      const freshnessHeartbeatAt = canUseHeartbeatForFreshness ? localDeviceProgress.last_heartbeat_at : null;
      const freshness = buildConnectorFreshness({
        lastRun,
        lastSuccessfulRun,
        live,
        refreshPolicy,
        lastHeartbeatAt: freshnessHeartbeatAt,
      });
      const connectionHealth = projectConnectorSummaryConnectionHealth({
        attentionRecords: attention.records,
        freshness,
        lastRun,
        lastSuccessfulRun,
        manifestStreams: manifest.streams ?? [],
        outbox: { axis: outbox.axis },
        pendingDetailGaps: detailGaps.gaps,
        remoteSurface: remoteSurface.evidence,
        unreliableSources: combineUnreliableSources(
          detailGaps.unreliable,
          outbox.unreliable,
          attention.unreliable,
          remoteSurface.unreliable
        ),
        schedule,
      });
      const connectorDisplayName = manifest.display_name || connectorId;
      return {
        connection_id: connectorInstanceId,
        connection_health: connectionHealth,
        connector_display_name: connectorDisplayName,
        connector_id: connectorId,
        connector_instance_id: connectorInstanceId,
        display_name: instance.displayName || connectorDisplayName,
        local_device_progress: localDeviceProgress,
        manifest_version: manifest.version || null,
        next_action: connectionHealth.next_action,
        retained_bytes: live.retainedBytes,
        streams: (manifest.streams || []).map((stream) => stream.name),
        stream_count: live.byStream.size,
        total_records: live.totalRecords,
        total_retained_bytes: live.retainedBytes?.total_bytes ?? null,
        freshness,
        refresh_policy: refreshPolicy,
        schedule,
        last_run: lastRun,
        last_successful_run: lastSuccessfulRun,
      };
    },
    options.onInFlightChange ? { onInFlightChange: options.onInFlightChange } : {}
  );
  return summaries.filter((summary): summary is ConnectorSummary => summary !== null);
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
  const [schedule, lastRun, lastSuccessfulRun, detailGaps, outbox, attention, remoteSurface] = await Promise.all([
    getScheduleFrom(controller, connectorId),
    getLatestRunSummary(connectorId),
    getLatestRunSummary(connectorId, "succeeded"),
    getConnectorDetailGapProjection(connectorId),
    getConnectorOutboxAxis(connectorId),
    getConnectorAttentionProjection(connectorId),
    getConnectorBrowserSurfaceProjection(connectorId),
  ]);
  const refreshPolicy = extractRefreshPolicy(manifest);
  const freshness = buildConnectorFreshness({
    lastRun,
    lastSuccessfulRun,
    live,
    refreshPolicy,
  });
  const connectionHealth = projectConnectorSummaryConnectionHealth({
    attentionRecords: attention.records,
    freshness,
    lastRun,
    lastSuccessfulRun,
    manifestStreams: manifest.streams ?? [],
    outbox: { axis: outbox.axis },
    pendingDetailGaps: detailGaps.gaps,
    remoteSurface: remoteSurface.evidence,
    unreliableSources: combineUnreliableSources(
      detailGaps.unreliable,
      outbox.unreliable,
      attention.unreliable,
      remoteSurface.unreliable
    ),
    schedule,
  });
  return {
    object: "ref_connector_detail",
    connection_id: connectorId,
    connection_health: connectionHealth,
    connector_id: connectorId,
    display_name: manifest.display_name || connectorId,
    manifest_version: manifest.version || null,
    next_action: connectionHealth.next_action,
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

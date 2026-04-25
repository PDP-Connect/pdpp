// Reference-only HTTP control-plane projections.
//
// These helpers back the `/_ref/connectors*`, `/_ref/approvals`, and
// `/_ref/records/timeline` routes. They read from the reference sqlite
// substrate (connectors, records, pending_consents, owner_device_auth)
// and the spine correlation index, then shape the result into the JSON
// envelopes the dashboard consumes.
//
// Not a PDPP protocol surface: these are debugging / operator views the
// reference implementation exposes for its own dashboard. Clients must
// not depend on the response shape.

import { listSpineCorrelations, listSpineEvents, type SpineEventRecord, type SpineSummary } from "../lib/spine.ts";
import { buildPendingConsentRequestUri, getConnectorManifest } from "./auth.js";
import { getDb } from "./db.js";
import { referenceQueries } from "./queries/index.ts";
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
  display_name?: string;
  profiles?: { id: string }[];
  protocol_version?: string | null;
  streams?: ManifestStream[];
  version?: string;
} & Record<string, unknown>;

interface ConnectorRow {
  readonly connector_id: string;
  readonly manifest: string;
}

interface StreamAggregateRow {
  readonly last_updated: string | null;
  readonly record_count: number;
  readonly stream: string;
}

interface Freshness {
  readonly captured_at?: string;
  readonly last_attempted_at?: string;
  readonly status: "unknown";
}

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
  readonly connector_id: string;
  readonly display_name: string;
  readonly freshness: Freshness;
  readonly last_run: ConnectorRunSummary | null;
  readonly last_successful_run: ConnectorRunSummary | null;
  readonly manifest_version: string | null;
  readonly schedule: unknown;
  readonly streams: string[];
  readonly total_records: number;
}

export interface ConnectorDetail {
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
  readonly created_at: string;
  readonly device_code: string;
  readonly params_json: string;
  readonly user_code: string;
}

interface PendingOwnerDeviceRow {
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
  source_binding?: { connector_id?: string; provider_id?: string };
  storage_binding?: { connector_id?: string };
}

interface ConsentApproval {
  readonly approval_id: string;
  readonly client_id: string | null;
  readonly created_at: string;
  readonly grant_preview: {
    readonly access_mode: string | null;
    readonly connector_id: string | null;
    readonly provider_id: string | null;
    readonly purpose_code: string | null;
    readonly purpose_description: string | null;
    readonly streams: unknown[];
  };
  readonly kind: "consent";
  readonly object: "approval";
  readonly request_uri: string;
  readonly user_code: string;
}

interface OwnerDeviceApproval {
  readonly approval_id: string;
  readonly client_id: string;
  readonly created_at: string;
  readonly grant_preview: null;
  readonly kind: "owner_device";
  readonly object: "approval";
  readonly request_uri: null;
  readonly user_code: string;
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

// Minimal structural interface for better-sqlite3 statements; keeps the
// test shim story the same as in controller.ts.
interface PreparedStatement {
  all<T = unknown>(...params: unknown[]): T[];
  iterate<T = unknown>(...params: unknown[]): Iterable<T>;
}

interface RefControlDatabase {
  prepare(sql: string): PreparedStatement;
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
  if (!lastUpdated) {
    return { status: "unknown" };
  }
  return {
    status: "unknown",
    captured_at: lastUpdated,
    last_attempted_at: lastUpdated,
  };
}

function extractKnownGaps(events: readonly SpineEventRecord[]): unknown[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || (event.event_type !== "run.completed" && event.event_type !== "run.failed")) {
      continue;
    }
    const data = event.data;
    if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).known_gaps)) {
      return (data as { known_gaps: unknown[] }).known_gaps;
    }
    return [];
  }
  return [];
}

async function toConnectorRunSummary(summary: SpineSummary | null): Promise<ConnectorRunSummary | null> {
  if (!summary) {
    return null;
  }
  const runId = summary.id || summary.run_id || null;
  const events = runId ? await listSpineEvents({ runId }) : [];
  return {
    run_id: runId || undefined,
    status: summary.status,
    started_at: summary.first_at,
    finished_at: summary.status === "pending" ? null : summary.last_at,
    first_at: summary.first_at,
    last_at: summary.last_at,
    event_count: summary.event_count,
    failure_reason: summary.failure?.reason || null,
    known_gaps: extractKnownGaps(events),
  };
}

async function getLatestRunSummary(
  connectorId: string,
  status: string | null = null
): Promise<ConnectorRunSummary | null> {
  const filters = status ? { connectorId, status, limit: 1 } : { connectorId, limit: 1 };
  const { summaries } = await listSpineCorrelations("run", filters);
  return toConnectorRunSummary(summaries[0] ?? null);
}

function getConnectorRecordProjection(connectorId: string): RecordProjection {
  const db = getDb() as RefControlDatabase;
  const rows = db
    .prepare(
      `
    SELECT
      stream,
      COUNT(*) AS record_count,
      MAX(emitted_at) AS last_updated
    FROM records
    WHERE connector_id = ?
      AND deleted = 0
    GROUP BY stream
  `
    )
    .all<StreamAggregateRow>(connectorId);
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
  live: StreamProjection | null = null
): StreamSummary {
  return {
    object: "stream",
    name: stream.name,
    semantics: stream.semantics || null,
    record_count: live?.record_count || 0,
    last_updated: live?.last_updated || null,
    freshness: live?.freshness || { status: "unknown" },
  };
}

function listRegisteredConnectorRows(): ConnectorRow[] {
  const db = getDb() as RefControlDatabase;
  return db.prepare(referenceQueries.listRegisteredConnectors.sql).all<ConnectorRow>();
}

function getScheduleFrom(controller: ControllerLike | null | undefined, connectorId: string): Promise<unknown> {
  if (controller && typeof controller.getSchedule === "function") {
    return (controller as ScheduleLike).getSchedule(connectorId);
  }
  return Promise.resolve(null);
}

export function listConnectorSummaries(controller?: ControllerLike | null): Promise<ConnectorSummary[]> {
  const rows = listRegisteredConnectorRows();
  return Promise.all(
    rows.map(async (row) => {
      const manifest = parseManifest(row.manifest, row.connector_id);
      const live = getConnectorRecordProjection(row.connector_id);
      const [schedule, lastRun, lastSuccessfulRun] = await Promise.all([
        getScheduleFrom(controller, row.connector_id),
        getLatestRunSummary(row.connector_id),
        getLatestRunSummary(row.connector_id, "succeeded"),
      ]);
      return {
        connector_id: row.connector_id,
        display_name: manifest.display_name || row.connector_id,
        manifest_version: manifest.version || null,
        streams: (manifest.streams || []).map((stream) => stream.name),
        total_records: live.totalRecords,
        freshness: live.freshness,
        schedule,
        last_run: lastRun,
        last_successful_run: lastSuccessfulRun,
      };
    })
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
  const live = getConnectorRecordProjection(connectorId);
  const [schedule, lastRun, lastSuccessfulRun] = await Promise.all([
    getScheduleFrom(controller, connectorId),
    getLatestRunSummary(connectorId),
    getLatestRunSummary(connectorId, "succeeded"),
  ]);
  return {
    object: "ref_connector_detail",
    connector_id: connectorId,
    display_name: manifest.display_name || connectorId,
    manifest_version: manifest.version || null,
    total_records: live.totalRecords,
    freshness: live.freshness,
    schedule,
    last_run: lastRun,
    last_successful_run: lastSuccessfulRun,
    recent_runs: lastRun ? [lastRun] : [],
    manifest_excerpt: buildManifestExcerpt(manifest),
    streams: (manifest.streams || []).map((stream) =>
      buildStreamSummary(stream, live.byStream.get(stream.name) || null)
    ),
  };
}

function buildConsentApproval(row: PendingConsentRow): ConsentApproval {
  const request = parseManifest(row.params_json, `pending consent ${row.device_code}`) as ConsentRequestEnvelope;
  return {
    object: "approval",
    approval_id: row.device_code,
    kind: "consent",
    client_id: request.client?.client_id || null,
    request_uri: buildPendingConsentRequestUri(row.device_code),
    user_code: row.user_code,
    created_at: row.created_at,
    grant_preview: {
      connector_id: request.source_binding?.connector_id || request.storage_binding?.connector_id || null,
      provider_id: request.source_binding?.provider_id || null,
      access_mode: request.selection?.access_mode || null,
      purpose_code: request.selection?.purpose_code || null,
      purpose_description: request.selection?.purpose_description || null,
      streams: request.selection?.streams || [],
    },
  };
}

function buildOwnerDeviceApproval(row: PendingOwnerDeviceRow): OwnerDeviceApproval {
  return {
    object: "approval",
    approval_id: row.device_code,
    kind: "owner_device",
    client_id: row.client_id,
    request_uri: null,
    user_code: row.user_code,
    created_at: row.created_at,
    grant_preview: null,
  };
}

export function listPendingApprovals(): Promise<Approval[]> {
  const db = getDb() as RefControlDatabase;
  const now = new Date().toISOString();
  const pendingConsents = db
    .prepare(
      `
    SELECT device_code, user_code, params_json, created_at
    FROM pending_consents
    WHERE status = 'pending'
      AND expires_at > ?
    ORDER BY created_at DESC
  `
    )
    .all<PendingConsentRow>(now);
  const pendingDevices = db
    .prepare(
      `
    SELECT device_code, user_code, client_id, created_at
    FROM owner_device_auth
    WHERE status = 'pending'
      AND expires_at > ?
    ORDER BY created_at DESC
  `
    )
    .all<PendingOwnerDeviceRow>(now);
  const approvals: Approval[] = [
    ...pendingConsents.map(buildConsentApproval),
    ...pendingDevices.map(buildOwnerDeviceApproval),
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
function enumerateCandidatePairs(
  db: RefControlDatabase,
  connectorId: string | null,
  stream: string | null
): { connectorId: string; stream: string }[] {
  const where: string[] = ["deleted = 0"];
  const binds: string[] = [];
  if (connectorId) {
    where.push("connector_id = ?");
    binds.push(connectorId);
  }
  if (stream) {
    where.push("stream = ?");
    binds.push(stream);
  }
  const rows = db
    .prepare(
      `
    SELECT DISTINCT connector_id, stream
    FROM records
    WHERE ${where.join(" AND ")}
  `
    )
    .all<PairRow>(...binds);
  return rows.map((row) => ({ connectorId: row.connector_id, stream: row.stream }));
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
  db: RefControlDatabase,
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

  const stmt = db.prepare(sql);
  const entries: TimelineEntry[] = [];
  for (const row of stmt.iterate<TimelineQueryRow>(pair.connectorId, pair.stream, ...binds, opts.perPairLimit)) {
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

export async function listRecordsTimeline({
  connectorId = null,
  stream = null,
  since = null,
  until = null,
  limit = 50,
  order = "desc",
  timestampMode = "native",
}: TimelineOptions = {}): Promise<TimelineResponse> {
  const db = getDb() as RefControlDatabase;
  const pairs = enumerateCandidatePairs(db, connectorId, stream);
  const perPairLimit = Math.max(limit * 2, 10);
  const orderDir: "ASC" | "DESC" = order === "asc" ? "ASC" : "DESC";

  const perPair = await Promise.all(
    pairs.map((pair) => collectPairEntries(db, pair, { orderDir, perPairLimit, since, timestampMode, until }))
  );
  const collected = perPair.flat();

  collected.sort((left, right) => comparePrimaryDesc(order, left, right));

  return {
    object: "list",
    data: collected.slice(0, limit),
    meta: {
      bounded: true,
      ordering: `semantic_or_emitted ${order}`,
      limit,
      timestamp_mode: timestampMode,
      filters: {
        connector_id: connectorId,
        stream,
        since,
        until,
      },
    },
  };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-backed disclosure spine primitives.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import { randomUUID } from "node:crypto";

import { postgresQuery } from "../server/postgres-storage.ts";

type SourceKind = "connector" | "provider_native";
type JsonObject = Record<string, unknown>;
type QueryParameter = string | number | string[] | null;
type CorrelationKind = "grant" | "run" | "trace";
type CorrelationColumn = "grant_id" | "run_id" | "trace_id";

interface SpineEventInput {
  readonly actor_id?: string | null;
  readonly actor_type?: string | null;
  readonly client_id?: string | null;
  readonly data?: unknown;
  readonly event_id?: string | null;
  readonly event_type?: string | null;
  readonly grant_id?: string | null;
  readonly interaction_id?: string | null;
  readonly object_id?: string | null;
  readonly object_type?: string | null;
  readonly occurred_at?: string | null;
  readonly request_id?: string | null;
  readonly run_id?: string | null;
  readonly scenario_id?: string | null;
  readonly source_id?: string | null;
  readonly source_kind?: SourceKind | string | null;
  readonly status?: string | null;
  readonly stream_id?: string | null;
  readonly subject_id?: string | null;
  readonly subject_type?: string | null;
  readonly token_id?: string | null;
  readonly trace_id?: string | null;
  readonly version?: string | null;
}

interface SourceObject {
  readonly id: string;
  readonly kind: SourceKind;
}

interface NormalizedSpineEvent {
  readonly actor_id: string;
  readonly actor_type: string;
  readonly client_id: string | null;
  readonly connector_instance_id: string | null;
  readonly data_json: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly grant_id: string | null;
  readonly interaction_id: string | null;
  readonly object_id: string;
  readonly object_type: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly scenario_id: string;
  readonly source_id: string | null;
  readonly source_kind: SourceKind | null;
  readonly status: string;
  readonly stream_id: string | null;
  readonly subject_id: string | null;
  readonly subject_type: string | null;
  readonly token_id: string | null;
  readonly trace_id: string;
  readonly version: string;
}

interface SpineEventRow {
  readonly actor_id: string;
  readonly actor_type: string;
  readonly client_id: string | null;
  readonly connector_instance_id: string | null;
  readonly data_json: string | null;
  readonly event_id: string;
  readonly event_seq: number | null;
  readonly event_type: string;
  readonly grant_id: string | null;
  readonly interaction_id: string | null;
  readonly object_id: string;
  readonly object_type: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly scenario_id: string;
  readonly source_id: string | null;
  readonly source_kind: SourceKind | null;
  readonly status: string;
  readonly stream_id: string | null;
  readonly subject_id: string | null;
  readonly subject_type: string | null;
  readonly token_id: string | null;
  readonly trace_id: string;
  readonly version: string;
}

interface SpineEventRecord {
  readonly actor_id: string;
  readonly actor_type: string;
  readonly client_id: string | null;
  readonly data: unknown;
  readonly event_id: string;
  readonly event_type: string;
  readonly grant_id: string | null;
  readonly interaction_id: string | null;
  readonly object_id: string;
  readonly object_type: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly scenario_id: string;
  readonly source_id: string | null;
  readonly source_kind: SourceKind | null;
  readonly status: string;
  readonly stream_id: string | null;
  readonly subject_id: string | null;
  readonly subject_type: string | null;
  readonly token_id: string | null;
  readonly trace_id: string;
  readonly version: string;
}

interface SpineEventPageOptions {
  readonly cursor?: string | null;
  readonly limit?: number | string | null;
}

interface SpineCorrelationFilters {
  readonly clientId?: string | null;
  readonly cursor?: string | null;
  readonly grantId?: string | null;
  readonly limit?: number | string | null;
  readonly q?: string | null;
  readonly since?: string | null;
  readonly sourceId?: string | null;
  readonly sourceKind?: SourceKind | string | null;
  readonly status?: string | null;
  readonly until?: string | null;
}

interface SummaryAggregate {
  readonly event_count?: number;
  readonly first_at?: string;
  readonly id?: string;
  readonly last_at?: string;
}

interface Summary {
  readonly actor_id: string | null;
  readonly actor_type: string | null;
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: string;
  readonly browser_surface_wait_reason?: string;
  readonly client?: ClientMetadata | null;
  readonly client_id: string | null;
  readonly connection_id?: string | null;
  readonly connector_id: string | null;
  readonly connector_instance_id?: string | null;
  readonly event_count: number;
  readonly failure: FailureSummary | null;
  readonly first_at: string | null;
  readonly grant_id: string | null;
  readonly grant_package_id?: string | null;
  readonly id?: string;
  readonly kinds: string[];
  readonly last_at: string | null;
  readonly needs_input: boolean;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly source: SourceObject | null;
  readonly source_id: string | null;
  readonly source_kind: SourceKind | null;
  readonly status: string;
  readonly trace_id: string | null;
}

interface FailureSummary {
  readonly event_type: string;
  readonly reason: string | null;
}

interface ClientMetadata {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly registration_mode: string | null;
}

interface CorrelationAggregateRow extends SummaryAggregate {
  readonly event_count: number;
  readonly first_at: string;
  readonly id: string;
  readonly last_at: string;
}

interface RecentCorrelationRow {
  readonly event_seq: number | null;
  readonly id: string | null;
  readonly occurred_at: string;
}

interface LifecycleEventRow {
  readonly actor_id: string;
  readonly data_json: string | null;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly status: string;
  readonly trace_id: string;
}

interface GrantPackageRow {
  readonly grant_id: string | null;
  readonly package_id: string | null;
}

interface OAuthClientRow {
  readonly client_id: string;
  readonly metadata_json: string | null;
  readonly registration_mode: string | null;
}

const COLUMN_BY_KIND: Record<CorrelationKind, CorrelationColumn> = {
  grant: "grant_id",
  run: "run_id",
  trace: "trace_id",
};

function correlationColumn(kind: string): CorrelationColumn | null {
  return kind === "grant" || kind === "run" || kind === "trace" ? COLUMN_BY_KIND[kind] : null;
}

function correlationKind(kind: string): CorrelationKind | null {
  return kind === "grant" || kind === "run" || kind === "trace" ? kind : null;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function defaultString(value: string | null | undefined, fallback: string | (() => string)): string {
  return value || (typeof fallback === "function" ? fallback() : fallback);
}

function optionalString(value: string | null | undefined): string | null {
  return value || null;
}

function isSourceKind(value: unknown): value is SourceKind {
  return value === "connector" || value === "provider_native";
}

function normalizeSourceObject(value: unknown): SourceObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as JsonObject;
  const kind = isSourceKind(source.kind) ? source.kind : null;
  const id = nonEmptyString(source.id);
  if (kind && id) {
    return { id, kind };
  }

  const legacyKind = isSourceKind(source.binding_kind) ? source.binding_kind : null;
  if (legacyKind === "connector") {
    const connectorId = nonEmptyString(source.connector_id);
    return connectorId ? { id: connectorId, kind: "connector" } : null;
  }
  if (legacyKind === "provider_native") {
    const providerId = nonEmptyString(source.provider_id);
    return providerId ? { id: providerId, kind: "provider_native" } : null;
  }

  const connectorId = nonEmptyString(source.connector_id);
  const providerId = nonEmptyString(source.provider_id);
  if (connectorId && !providerId) {
    return { id: connectorId, kind: "connector" };
  }
  if (providerId && !connectorId) {
    return { id: providerId, kind: "provider_native" };
  }
  return null;
}

function deriveSource(input: SpineEventInput, actorType: string, actorId: string): SourceObject | null {
  const explicitKind = isSourceKind(input.source_kind) ? input.source_kind : null;
  const explicitId = nonEmptyString(input.source_id);
  if (explicitKind && explicitId) {
    return { id: explicitId, kind: explicitKind };
  }

  const data = asObject(input.data);
  const source = normalizeSourceObject(data.source) || normalizeSourceObject(data.source_binding);
  if (source) {
    return source;
  }

  const connectorId = nonEmptyString(data.connector_id);
  const providerId = nonEmptyString(data.provider_id);
  if (connectorId && !providerId) {
    return { id: connectorId, kind: "connector" };
  }
  if (providerId && !connectorId) {
    return { id: providerId, kind: "provider_native" };
  }
  if (actorType === "runtime" && actorId) {
    return { id: actorId, kind: "connector" };
  }
  return null;
}

function serializeData(inputData: unknown, source: SourceObject | null): string {
  const data = { ...asObject(inputData) };
  if (source) {
    data.source = source;
  }
  return JSON.stringify(data);
}

/**
 * The connection an event's `data` payload attributes to, or `null` when it
 * names none. Mirrors `readEventConnectionId` in
 * connector-summary-read-model.ts and lib/spine.ts's
 * `deriveConnectorInstanceIdFromEventInput` exactly (same field precedence)
 * — all three must agree on where connection identity lives in the payload.
 */
function deriveConnectorInstanceId(input: SpineEventInput): string | null {
  const data = asObject(input.data);
  return nonEmptyString(data.connector_instance_id) || nonEmptyString(data.connection_id);
}

function sourceColumns(source: SourceObject | null): Pick<NormalizedSpineEvent, "source_id" | "source_kind"> {
  return source ? { source_id: source.id, source_kind: source.kind } : { source_id: null, source_kind: null };
}

function normalize(input: SpineEventInput = {}): NormalizedSpineEvent {
  const at = defaultString(input.occurred_at, nowIso);
  const actorType = defaultString(input.actor_type, "system");
  const actorId = defaultString(input.actor_id, "system");
  const source = deriveSource(input, actorType, actorId);
  return {
    actor_id: actorId,
    actor_type: actorType,
    client_id: optionalString(input.client_id),
    connector_instance_id: deriveConnectorInstanceId(input),
    data_json: serializeData(input.data, source),
    event_id: defaultString(input.event_id, () => eventId("evt")),
    event_type: defaultString(input.event_type, "event"),
    grant_id: optionalString(input.grant_id),
    interaction_id: optionalString(input.interaction_id),
    object_id: defaultString(input.object_id, () => eventId("obj")),
    object_type: defaultString(input.object_type, "object"),
    occurred_at: at,
    recorded_at: nowIso(),
    request_id: optionalString(input.request_id),
    run_id: optionalString(input.run_id),
    scenario_id: defaultString(input.scenario_id, "default"),
    ...sourceColumns(source),
    status: defaultString(input.status, "ok"),
    stream_id: optionalString(input.stream_id),
    subject_id: optionalString(input.subject_id),
    subject_type: optionalString(input.subject_type),
    token_id: optionalString(input.token_id),
    trace_id: defaultString(input.trace_id, () => eventId("trace")),
    version: defaultString(input.version, "1"),
  };
}

function hydrate(row: SpineEventRow | undefined): SpineEventRecord | null {
  if (!row) {
    return null;
  }
  return {
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    client_id: row.client_id,
    data: typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json,
    event_id: row.event_id,
    event_type: row.event_type,
    grant_id: row.grant_id,
    interaction_id: row.interaction_id,
    object_id: row.object_id,
    object_type: row.object_type,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
    request_id: row.request_id,
    run_id: row.run_id,
    scenario_id: row.scenario_id,
    source_id: row.source_id,
    source_kind: row.source_kind,
    status: row.status,
    stream_id: row.stream_id,
    subject_id: row.subject_id,
    subject_type: row.subject_type,
    token_id: row.token_id,
    trace_id: row.trace_id,
    version: row.version,
  };
}

function sourceFromEvent(event: SpineEventRecord): SourceObject | null {
  const sourceKind = isSourceKind(event.source_kind) ? event.source_kind : null;
  if (sourceKind && event.source_id) {
    return { id: event.source_id, kind: sourceKind };
  }

  const data = asObject(event.data);
  const source = normalizeSourceObject(data.source) || normalizeSourceObject(data.source_binding);
  if (source) {
    return source;
  }

  const connectorId = nonEmptyString(data.connector_id);
  const providerId = nonEmptyString(data.provider_id);
  if (connectorId && !providerId) {
    return { id: connectorId, kind: "connector" };
  }
  if (providerId && !connectorId) {
    return { id: providerId, kind: "provider_native" };
  }
  if (event.actor_type === "runtime" && event.actor_id) {
    return { id: event.actor_id, kind: "connector" };
  }
  return null;
}

function findLatestBrowserSurfaceProjection(events: SpineEventRecord[]): JsonObject | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event?.event_type?.startsWith("run.browser_surface_")) {
      continue;
    }
    const projection = asObject(event.data).browser_surface;
    if (projection && typeof projection === "object" && !Array.isArray(projection)) {
      return projection as JsonObject;
    }
  }
  return null;
}

const BROWSER_SURFACE_PROJECTION_KEYS = [
  "browser_surface_status",
  "browser_surface_wait_reason",
  "browser_surface_lease_id",
  "browser_surface_profile_key",
];

function pickBrowserSurfaceFields(projection: JsonObject | null): Record<string, string> {
  if (!projection) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const key of BROWSER_SURFACE_PROJECTION_KEYS) {
    const value = projection[key];
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function connectionIdFromBrowserSurfaceProfileKey(projection: JsonObject | null): string | null {
  const profileKey = projection?.browser_surface_profile_key;
  if (typeof profileKey !== "string" || profileKey.length === 0) {
    return null;
  }
  const suffix = profileKey.split(":").at(-1);
  return suffix?.startsWith("cin_") ? suffix : null;
}

function connectionIdFromEventData(event: SpineEventRecord): string | null {
  const data =
    event.data && typeof event.data === "object" && !Array.isArray(event.data) ? (event.data as JsonObject) : null;
  if (!data) {
    return null;
  }
  if (typeof data.connection_id === "string" && data.connection_id.length > 0) {
    return data.connection_id;
  }
  if (typeof data.connector_instance_id === "string" && data.connector_instance_id.length > 0) {
    return data.connector_instance_id;
  }
  return null;
}

function findFirstConnectionId(events: SpineEventRecord[]): string | null {
  for (const event of events) {
    const connectionId = connectionIdFromEventData(event);
    if (connectionId) {
      return connectionId;
    }
  }
  return null;
}

function encodeEventCursor(eventSeq: number | null | undefined): string | null {
  return eventSeq === null || eventSeq === undefined
    ? null
    : Buffer.from(JSON.stringify({ event_seq: Number(eventSeq) })).toString("base64url");
}

function decodeEventCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number(decoded.event_seq) || 0;
  } catch {
    return 0;
  }
}

function encodeSummaryCursor(summary: Summary | null | undefined): string | null {
  return summary ? `${summary.last_at}::${summary.id}` : null;
}

// Run-terminal event types — kept aligned with lib/spine.ts
// RUN_TERMINAL_EVENT_TYPES. Reference: docs/run-reconciliation-design-brief.md §3.7.
const RUN_TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled", "run.abandoned"]);
const RUN_TERMINAL_EVENT_TYPE_LIST = [...RUN_TERMINAL_EVENT_TYPES];
const SUMMARY_EVENT_HEAD_LIMIT = 5000;
const SUMMARY_EVENT_TAIL_LIMIT = 200;
const RECENT_CORRELATION_SCAN_CHUNK = 1000;
const RECENT_CORRELATION_SCAN_FALLBACK_AFTER = 100_000;

async function hasPostgresActiveRunLease(runId: string | null): Promise<boolean> {
  if (!runId) {
    return false;
  }
  const result = await postgresQuery("SELECT 1 AS active FROM controller_active_runs WHERE run_id = $1 LIMIT 1", [
    runId,
  ]);
  return result.rows.length > 0;
}

// Postgres mirror of `queries/spine/get-run-terminal-event.sql`: the run's
// most-recent terminal event (`ORDER BY event_seq DESC LIMIT 1`) over the
// terminal event types, or `null` when the run has no terminal event. The
// `LIMIT 1` keeps this independent of the run's event count — it never
// scans the full event list and never depends on a timeline page window.
export async function postgresGetRunTerminalEvent(runId: string | null): Promise<LifecycleEventRow | null> {
  if (!runId) {
    return null;
  }
  const result = await postgresQuery<LifecycleEventRow>(
    `SELECT event_type, status, data_json::text AS data_json, occurred_at, trace_id, actor_id
     FROM spine_events
     WHERE run_id = $1 AND event_type = ANY($2::text[])
     ORDER BY event_seq DESC
     LIMIT 1`,
    [runId, RUN_TERMINAL_EVENT_TYPE_LIST]
  );
  return result.rows[0] ?? null;
}

// Postgres mirror of `queries/spine/get-run-started-event.sql`: the run's
// `run.started` event (`ORDER BY event_seq ASC LIMIT 1`), or `null` when
// the run never reached the runtime's start emit (e.g. a launch failure
// before spawn). Bounded by `LIMIT 1` like the terminal lookup above.
export async function postgresGetRunStartedEvent(runId: string | null): Promise<LifecycleEventRow | null> {
  if (!runId) {
    return null;
  }
  const result = await postgresQuery<LifecycleEventRow>(
    `SELECT event_type, status, data_json::text AS data_json, occurred_at, trace_id, actor_id
     FROM spine_events
     WHERE run_id = $1 AND event_type = 'run.started'
     ORDER BY event_seq ASC
     LIMIT 1`,
    [runId]
  );
  return result.rows[0] ?? null;
}

interface SummaryEventFields {
  readonly failureEvent: SpineEventRecord | undefined;
  readonly first: SpineEventRecord | null;
  readonly hasRunStarted: boolean;
  readonly kinds: string[];
  readonly last: SpineEventRecord | null;
  readonly needsInput: boolean;
}

function selectSummaryEventFields(events: SpineEventRecord[]): SummaryEventFields {
  const first = events[0] ?? null;
  const last = events.at(-1) ?? first;
  const kinds = [...new Set(events.map((event) => event.event_type).filter(Boolean))];
  const failureEvent = events.find((event) => event.status === "failed" || event.status === "rejected");
  const hasRunStarted = events.some((event) => event.event_type === "run.started");
  const needsInput = events.some((event) => event.status === "needs_input");
  return { failureEvent, first, hasRunStarted, kinds, last, needsInput };
}

interface SummarySourceProjection {
  readonly connector: SourceObject | null;
  readonly source: SourceObject | null;
}

function selectSummarySourceProjection(events: SpineEventRecord[]): SummarySourceProjection {
  const sources = events.map(sourceFromEvent).filter(isPresent);
  const source = sources[0] || null;
  const connector = sources.find((candidate) => candidate.kind === "connector") || null;
  return { connector, source };
}

interface SummaryBrowserSurfaceProjection {
  readonly browserSurfaceFields: Record<string, string>;
  readonly connectionId: string | null;
}

function pickSummaryBrowserSurfaceProjection(events: SpineEventRecord[]): SummaryBrowserSurfaceProjection {
  const browserSurface = findLatestBrowserSurfaceProjection(events);
  const connectionId = findFirstConnectionId(events) ?? connectionIdFromBrowserSurfaceProfileKey(browserSurface);
  return {
    browserSurfaceFields: pickBrowserSurfaceFields(browserSurface),
    connectionId,
  };
}

function latestRunTerminalStatus(events: SpineEventRecord[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && RUN_TERMINAL_EVENT_TYPES.has(event.event_type) && event.status && event.status !== "unknown") {
      return event.status;
    }
  }
  return null;
}

function latestKnownEventStatus(events: SpineEventRecord[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.status && event.status !== "unknown") {
      return event.status;
    }
  }
  return "unknown";
}

async function projectSummaryStatus(id: string, events: SpineEventRecord[]): Promise<string> {
  // Status projection — mirror lib/spine.ts summarizeEvents logic.
  //
  // Run-correlation summaries must reflect the run's lifecycle status
  // (run.completed / run.failed / run.cancelled / run.abandoned), NOT
  // the status of incidental sub-resource events that happen to share
  // the run_id (e.g. run.batch_ingested, which carries status:'succeeded'
  // per batch — and would mislabel an in-flight run as succeeded if used
  // as the fallback). See docs/run-reconciliation-design-brief.md §3.7.
  const terminalStatus = latestRunTerminalStatus(events);
  if (terminalStatus) {
    return terminalStatus;
  }

  const hasRunStarted = events.some((event) => event.event_type === "run.started");
  if (hasRunStarted) {
    // Pass 2 (fallback): no run-terminal event yet. A started run is only
    // in progress while controller_active_runs still carries its lease;
    // otherwise it is an orphan and must not keep owner surfaces live.
    // Non-run correlations still use the most recent non-"unknown" status.
    const runId = events.find((event) => event.run_id)?.run_id || id || null;
    return (await hasPostgresActiveRunLease(runId)) ? "in_progress" : "failed";
  }

  return latestKnownEventStatus(events);
}

function assembleSummaryObject(
  id: string,
  aggregate: SummaryAggregate,
  events: SpineEventRecord[],
  eventFields: SummaryEventFields,
  sourceProjection: SummarySourceProjection,
  browserSurfaceProjection: SummaryBrowserSurfaceProjection,
  status: string
): Summary {
  const { failureEvent, first, hasRunStarted, kinds, last, needsInput } = eventFields;
  const { connector, source } = sourceProjection;
  const { connectionId, browserSurfaceFields } = browserSurfaceProjection;
  let failure: FailureSummary | null = null;
  if (failureEvent) {
    const failureData = asObject(failureEvent.data);
    failure = {
      event_type: failureEvent.event_type,
      reason: typeof failureData.reason === "string" ? failureData.reason : null,
    };
  } else if (status === "failed" && hasRunStarted) {
    failure = {
      event_type: "run.started",
      reason: "orphaned_started_run",
    };
  }
  return {
    actor_id: last?.actor_id || null,
    actor_type: last?.actor_type || null,
    client_id: last?.client_id || null,
    id,
    ...(connectionId ? { connection_id: connectionId, connector_instance_id: connectionId } : {}),
    connector_id: connector?.id || null,
    event_count: Number(aggregate.event_count) || events.length,
    failure,
    first_at: aggregate.first_at || first?.occurred_at || null,
    grant_id: last?.grant_id || null,
    kinds,
    last_at: aggregate.last_at || last?.occurred_at || null,
    needs_input: needsInput,
    request_id: last?.request_id || null,
    run_id: last?.run_id || null,
    source,
    source_id: source?.id || null,
    source_kind: source?.kind || null,
    status,
    trace_id: last?.trace_id || null,
    ...browserSurfaceFields,
  };
}

async function summarizeRows(id: string, rows: SpineEventRow[], aggregate: SummaryAggregate = {}): Promise<Summary> {
  const events = rows.map(hydrate).filter(isPresent);
  const eventFields = selectSummaryEventFields(events);
  const sourceProjection = selectSummarySourceProjection(events);
  const browserSurfaceProjection = pickSummaryBrowserSurfaceProjection(events);
  const status = await projectSummaryStatus(id, events);
  return assembleSummaryObject(id, aggregate, events, eventFields, sourceProjection, browserSurfaceProjection, status);
}

// Total order policy (must match the SQL ORDER BY clauses in
// fetchRowsForSummaries below, and lib/spine.ts's SQLite equivalent): null
// event_seq sorts LAST regardless of ascending/descending direction, then
// numeric event_seq, then event_id as the final deterministic tie-break.
// event_seq is never actually null on Postgres (BIGSERIAL NOT NULL) or on a
// fresh SQLite install, but legacy SQLite rows predating the event_seq
// column can carry a genuine SQL NULL, and this must not be conflated with
// numeric 0 (see mergeEventRows below for the historical bug this guards).
function isNullSeq(eventSeq: number | null | undefined): boolean {
  return eventSeq === null || eventSeq === undefined;
}

function compareEventRowOrder(a: SpineEventRow, b: SpineEventRow): number {
  const aNull = isNullSeq(a.event_seq);
  const bNull = isNullSeq(b.event_seq);
  const nullDiff = Number(aNull) - Number(bNull);
  const seqDiff = aNull || bNull ? nullDiff : Number(a.event_seq) - Number(b.event_seq);
  return seqDiff === 0 ? String(a.event_id).localeCompare(String(b.event_id)) : seqDiff;
}

export function mergeEventRows(rows: SpineEventRow[]): SpineEventRow[] {
  // Dedup key must be event_id, not a numeric coercion of event_seq: a SQL
  // NULL event_seq comes back as JS `null`, and `Number(null) === 0` (finite,
  // not NaN), so keying on `Number(event_seq)` collapsed every distinct
  // legacy row sharing a null/duplicate event_seq onto the same map key —
  // silently dropping all but the last. event_id is the primary key, always
  // present and unique, so it can never cause this collision.
  const byId = new Map<string, SpineEventRow>();
  for (const row of rows) {
    if (!row) {
      continue;
    }
    byId.set(row.event_id, row);
  }
  return [...byId.values()].sort(compareEventRowOrder);
}

// Portable null-last total order, ascending: rows with a null event_seq
// always sort after every row with a non-null event_seq, in both the ASC
// and DESC forms below (matching compareEventRowOrder's JS semantics, and
// the SQLite ORDER BY fragments in lib/spine.ts's loadEventsForSummaries).
// This does NOT rely on Postgres's or SQLite's default NULL ordering (which
// differ: Postgres sorts NULL last on ASC/first on DESC by default; SQLite
// sorts NULL first on ASC/last on DESC by default) — the `(event_seq IS
// NULL)` boolean expression pins the same behavior on both backends
// regardless of engine default.
// event_id is the final tie-break: always present and unique, so it fully
// determines order whenever event_seq is null or (in principle) duplicated.
const EVENT_ROW_ORDER_ASC = "(event_seq IS NULL), event_seq ASC, event_id ASC";
const EVENT_ROW_ORDER_DESC = "(event_seq IS NULL), event_seq DESC, event_id DESC";

function groupEventRowsByCorrelationId(rows: SpineEventRow[], column: CorrelationColumn): Map<string, SpineEventRow[]> {
  const byId = new Map<string, SpineEventRow[]>();
  for (const row of rows) {
    const id = row[column];
    if (!id) {
      continue;
    }
    const existing = byId.get(id);
    if (existing) {
      existing.push(row);
    } else {
      byId.set(id, [row]);
    }
  }
  return byId;
}

function mergeRunEventWindows(
  ids: string[],
  windows: SpineEventRow[][],
  column: CorrelationColumn
): Map<string, SpineEventRow[]> {
  const byId = new Map<string, SpineEventRow[]>(ids.map((id) => [id, []]));
  for (const window of windows) {
    for (const row of window) {
      const id = row[column];
      if (id) {
        byId.get(id)?.push(row);
      }
    }
  }
  const merged = new Map<string, SpineEventRow[]>();
  for (const [id, rows] of byId) {
    merged.set(id, mergeEventRows(rows));
  }
  return merged;
}

// Batched form of the old per-row fetchRowsForSummary: fetches head/tail/
// terminal windows for every id in one round trip each (instead of 1-3 round
// trips per row), using a partitioned window function to keep the same
// per-id LIMIT semantics. Returns a Map<id, rows[]> so callers can look up
// each row's events the same way the per-row version did.
async function fetchRowsForSummaries(
  kind: CorrelationKind,
  column: CorrelationColumn,
  ids: string[]
): Promise<Map<string, SpineEventRow[]>> {
  if (ids.length === 0) {
    return new Map();
  }

  // The window function's ORDER BY only decides which rows have rn <= N
  // (partition membership) — it makes no promise about the order rows come
  // back in. summarizeRows relies on array order (first/last event, reverse
  // scans for status/browser-surface state), so the outer SELECT needs its
  // own explicit ORDER BY the same way the old per-row `ORDER BY event_seq
  // ASC` query did.
  const head = await postgresQuery<SpineEventRow>(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY ${EVENT_ROW_ORDER_ASC}) AS rn
       FROM spine_events
       WHERE ${column} = ANY($1)
     ) ranked
     WHERE rn <= $2
     ORDER BY ${column}, ${EVENT_ROW_ORDER_ASC}`,
    [ids, SUMMARY_EVENT_HEAD_LIMIT]
  );
  if (kind !== "run") {
    return groupEventRowsByCorrelationId(head.rows, column);
  }

  // Same null-last total order as the head query above, for the same
  // reason: without it, which rows land inside the tail/terminal LIMIT is
  // underspecified whenever event_seq ties or is null for more rows than the
  // window can hold. mergeEventRows sorts the final merged array by the same
  // policy regardless, so an outer ORDER BY here is not load-bearing for
  // correctness — it's added anyway so every batched query in this function
  // carries the same explicit-ordering discipline, rather than some of them
  // relying on a downstream sort to paper over their own unordered output.
  const [tail, terminal] = await Promise.all([
    postgresQuery<SpineEventRow>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY ${EVENT_ROW_ORDER_DESC}) AS rn
         FROM spine_events
         WHERE ${column} = ANY($1)
       ) ranked
       WHERE rn <= $2
       ORDER BY ${column}, ${EVENT_ROW_ORDER_DESC}`,
      [ids, SUMMARY_EVENT_TAIL_LIMIT]
    ),
    postgresQuery<SpineEventRow>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY ${EVENT_ROW_ORDER_DESC}) AS rn
         FROM spine_events
         WHERE ${column} = ANY($1) AND event_type = ANY($2::text[])
       ) ranked
       WHERE rn <= 10
       ORDER BY ${column}, ${EVENT_ROW_ORDER_DESC}`,
      [ids, RUN_TERMINAL_EVENT_TYPE_LIST]
    ),
  ]);

  return mergeRunEventWindows(ids, [head.rows, tail.rows, terminal.rows], column);
}

function hasOnlyFirstPageRecentFilters(filters: SpineCorrelationFilters): boolean {
  return !(
    filters.cursor ||
    filters.since ||
    filters.until ||
    filters.status ||
    filters.clientId ||
    filters.sourceKind ||
    filters.sourceId ||
    filters.grantId ||
    filters.q
  );
}

function compareSummaryRows(a: SummaryAggregate, b: SummaryAggregate): number {
  const lastAt = String(b.last_at || "").localeCompare(String(a.last_at || ""));
  if (lastAt !== 0) {
    return lastAt;
  }
  return String(a.id || "").localeCompare(String(b.id || ""));
}

interface RecentCorrelationScanState {
  readonly beforeAt: string | null;
  readonly beforeSeq: number | null;
  readonly scanned: number;
  readonly seen: Map<string, string>;
}

async function scanRecentCorrelationRows(
  column: CorrelationColumn,
  limit: number,
  state: RecentCorrelationScanState
): Promise<Map<string, string> | null> {
  const params: QueryParameter[] = [];
  let cursorSql = "";
  if (state.beforeAt !== null && state.beforeSeq !== null) {
    params.push(state.beforeAt, state.beforeSeq);
    cursorSql = "AND (occurred_at < $1 OR (occurred_at = $1 AND event_seq < $2))";
  }
  params.push(Math.max(RECENT_CORRELATION_SCAN_CHUNK, limit * 20));
  const limitPlaceholder: string = `$${params.length}`;
  const result = await postgresQuery<RecentCorrelationRow>(
    `SELECT ${column} AS id, occurred_at, event_seq
     FROM spine_events
     WHERE ${column} IS NOT NULL
       ${cursorSql}
     ORDER BY occurred_at DESC, event_seq DESC
     LIMIT ${limitPlaceholder}`,
    params
  );
  if (result.rows.length === 0) {
    return state.seen;
  }

  for (const row of result.rows) {
    if (row.id && !state.seen.has(row.id)) {
      state.seen.set(row.id, row.occurred_at);
    }
  }
  const scanned = state.scanned + result.rows.length;
  const ordered = [...state.seen.entries()].map(([id, last_at]) => ({ id, last_at })).sort(compareSummaryRows);
  if (ordered.length >= limit + 1) {
    const boundary = ordered[Math.min(limit, ordered.length - 1)]?.last_at;
    const lastRow = result.rows.at(-1);
    if (boundary && String(lastRow?.occurred_at || "") < String(boundary)) {
      return state.seen;
    }
  }
  if (scanned >= RECENT_CORRELATION_SCAN_FALLBACK_AFTER) {
    return null;
  }

  const last = result.rows.at(-1);
  if (!last) {
    return state.seen;
  }
  return scanRecentCorrelationRows(column, limit, {
    beforeAt: last.occurred_at,
    beforeSeq: Number(last.event_seq || 0),
    scanned,
    seen: state.seen,
  });
}

async function listRecentCorrelationAggregates(
  column: CorrelationColumn,
  limit: number
): Promise<CorrelationAggregateRow[] | null> {
  const seen = await scanRecentCorrelationRows(column, limit, {
    beforeAt: null,
    beforeSeq: null,
    scanned: 0,
    seen: new Map<string, string>(),
  });
  if (seen === null) {
    return null;
  }

  const orderedIds = [...seen.entries()]
    .map(([id, last_at]) => ({ id, last_at }))
    .sort(compareSummaryRows)
    .slice(0, limit + 1)
    .map((row) => row.id);
  if (orderedIds.length === 0) {
    return [];
  }
  const placeholders = orderedIds.map((_, i) => `$${i + 1}`).join(", ");
  const aggregate = await postgresQuery<CorrelationAggregateRow>(
    `SELECT ${column} AS id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*)::int AS event_count
     FROM spine_events
     WHERE ${column} IN (${placeholders})
     GROUP BY ${column}`,
    orderedIds
  );
  const byId = new Map(aggregate.rows.map((row) => [row.id, row]));
  return orderedIds
    .map((id) => byId.get(id))
    .filter(isPresent)
    .sort(compareSummaryRows);
}

export async function postgresEmitSpineEvent(input: SpineEventInput = {}): Promise<SpineEventRecord | null> {
  const event = normalize(input);
  const result = await postgresQuery<SpineEventRow>(
    `INSERT INTO spine_events (
       event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, subject_type, subject_id, object_type, object_id,
       status, request_id, grant_id, run_id, source_kind, source_id, client_id, stream_id,
       token_id, interaction_id, connector_instance_id, data_json, version
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24::jsonb, $25
     )
     RETURNING *`,
    [
      event.event_id,
      event.event_type,
      event.occurred_at,
      event.recorded_at,
      event.scenario_id,
      event.trace_id,
      event.actor_type,
      event.actor_id,
      event.subject_type,
      event.subject_id,
      event.object_type,
      event.object_id,
      event.status,
      event.request_id,
      event.grant_id,
      event.run_id,
      event.source_kind,
      event.source_id,
      event.client_id,
      event.stream_id,
      event.token_id,
      event.interaction_id,
      event.connector_instance_id,
      event.data_json,
      event.version,
    ]
  );
  return hydrate(result.rows[0]);
}

export async function postgresListSpineEventsPage(
  kind: string,
  id: string,
  opts: SpineEventPageOptions = {}
): Promise<{ events: SpineEventRecord[]; limit: number; next_cursor: string | null; truncated: boolean }> {
  const column = correlationColumn(kind);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 500));
  if (!column) {
    return { events: [], limit, next_cursor: null, truncated: false };
  }
  const cursorSeq = decodeEventCursor(opts.cursor);
  const result = await postgresQuery<SpineEventRow>(
    `SELECT * FROM spine_events
     WHERE ${column} = $1 AND event_seq > $2
     ORDER BY event_seq ASC
     LIMIT $3`,
    [id, cursorSeq, limit + 1]
  );
  const truncated = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    events: rows.map(hydrate).filter(isPresent),
    limit,
    next_cursor: truncated ? encodeEventCursor(last?.event_seq) : null,
    truncated,
  };
}

/**
 * Look up the parent grant-package id for each grant id. The binding
 * fact lives on `grant_package_members`; the package's MCP refresh
 * token carries `tokens.package_id` but has a NULL `grant_id`, so a
 * tokens-side lookup misses every child grant. Returns a `Map<grantId,
 * packageId>` containing only grants that are package-bound. Used by
 * `listSpineCorrelations` to decorate grant rows on the operator
 * surface; called once per page so the join cost stays bounded.
 */
export async function postgresGrantPackageIdsForGrants(grantIds: string[]): Promise<Map<string, string>> {
  if (!Array.isArray(grantIds) || grantIds.length === 0) {
    return new Map();
  }
  const placeholders = grantIds.map((_, i) => `$${i + 1}`).join(", ");
  const result = await postgresQuery<GrantPackageRow>(
    `SELECT grant_id, package_id
       FROM grant_package_members
       WHERE grant_id IN (${placeholders})`,
    grantIds
  );
  const out = new Map<string, string>();
  for (const row of result.rows) {
    if (row.grant_id && row.package_id && !out.has(row.grant_id)) {
      out.set(row.grant_id, row.package_id);
    }
  }
  return out;
}

function clientMetadataFromOAuthRow(row: OAuthClientRow): ClientMetadata {
  let metadata: JsonObject = {};
  try {
    metadata = typeof row.metadata_json === "string" ? asObject(JSON.parse(row.metadata_json)) : {};
  } catch {
    metadata = {};
  }
  const clientName =
    typeof metadata.client_name === "string" && metadata.client_name.trim() ? metadata.client_name.trim() : null;
  return {
    client_id: row.client_id,
    client_name: clientName,
    registration_mode:
      typeof row.registration_mode === "string" && row.registration_mode ? row.registration_mode : null,
  };
}

/**
 * Look up registered OAuth client metadata for the current page of grant
 * summaries. This is reference-operator display metadata only; the verified
 * identity remains the grant summary's top-level `client_id`.
 */
export async function postgresClientMetadataForClients(clientIds: string[]): Promise<Map<string, ClientMetadata>> {
  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    return new Map();
  }
  const placeholders = clientIds.map((_, i) => `$${i + 1}`).join(", ");
  const result = await postgresQuery<OAuthClientRow>(
    `SELECT client_id, registration_mode, metadata_json::text AS metadata_json
       FROM oauth_clients
       WHERE client_id IN (${placeholders})`,
    clientIds
  );
  const out = new Map<string, ClientMetadata>();
  for (const row of result.rows) {
    if (row.client_id && !out.has(row.client_id)) {
      out.set(row.client_id, clientMetadataFromOAuthRow(row));
    }
  }
  return out;
}

function annotateGrantPackageId(summary: Summary, packageByGrant: Map<string, string>): Summary {
  if (!summary) {
    return summary;
  }
  const gid = summary.grant_id || summary.id;
  const packageId = gid ? packageByGrant.get(gid) : null;
  return packageId ? { ...summary, grant_package_id: packageId } : summary;
}

function annotateClientMetadata(summary: Summary, clientById: Map<string, ClientMetadata>): Summary {
  if (!summary.client_id) {
    return summary;
  }
  const client = clientById.get(summary.client_id);
  return client ? { ...summary, client } : summary;
}

interface CorrelationAggregateQuery {
  readonly params: QueryParameter[];
  readonly sql: string;
}

function buildCorrelationAggregateQuery(
  column: CorrelationColumn,
  filters: SpineCorrelationFilters,
  limit: number
): CorrelationAggregateQuery {
  const whereParts = [`${column} IS NOT NULL`];
  const params: QueryParameter[] = [];
  if (filters.clientId) {
    params.push(filters.clientId);
    whereParts.push(`client_id = $${params.length}`);
  }
  if (filters.sourceKind) {
    params.push(String(filters.sourceKind));
    whereParts.push(`source_kind = $${params.length}`);
  }
  if (filters.sourceId) {
    params.push(filters.sourceId);
    whereParts.push(`source_id = $${params.length}`);
  }
  if (filters.grantId && column !== "grant_id") {
    params.push(filters.grantId);
    whereParts.push(`grant_id = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${String(filters.q)}%`);
    whereParts.push(`${column} LIKE $${params.length}`);
  }

  const havingParts: string[] = [];
  if (filters.since) {
    params.push(filters.since);
    havingParts.push(`MAX(occurred_at) >= $${params.length}`);
  }
  if (filters.until) {
    params.push(filters.until);
    havingParts.push(`MIN(occurred_at) <= $${params.length}`);
  }
  const havingSql = havingParts.length > 0 ? ` HAVING ${havingParts.join(" AND ")}` : "";
  params.push(limit + 1);
  const limitPlaceholder = `$${params.length}`;
  return {
    params,
    sql: `SELECT ${column} AS id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*)::int AS event_count
       FROM spine_events
       WHERE ${whereParts.join(" AND ")}
       GROUP BY ${column}${havingSql}
       ORDER BY last_at DESC, id ASC
       LIMIT ${limitPlaceholder}`,
  };
}

async function loadCorrelationAggregates(
  column: CorrelationColumn,
  filters: SpineCorrelationFilters,
  limit: number
): Promise<CorrelationAggregateRow[]> {
  if (hasOnlyFirstPageRecentFilters(filters)) {
    const recent = await listRecentCorrelationAggregates(column, limit);
    if (recent !== null) {
      return recent;
    }
  }
  const query = buildCorrelationAggregateQuery(column, filters, limit);
  const result = await postgresQuery<CorrelationAggregateRow>(query.sql, query.params);
  return result.rows;
}

async function decorateCorrelationSummaries(kind: CorrelationKind, summaries: Summary[]): Promise<Summary[]> {
  let decorated = summaries;
  if (kind === "grant" && summaries.length > 0) {
    const ids = summaries
      .map((summary) => summary.grant_id || summary.id)
      .filter((value): value is string => Boolean(value));
    const packageByGrant = await postgresGrantPackageIdsForGrants(ids);
    if (packageByGrant.size > 0) {
      decorated = decorated.map((summary) => annotateGrantPackageId(summary, packageByGrant));
    }
  }

  if ((kind === "grant" || kind === "trace") && decorated.length > 0) {
    const clientIds = [
      ...new Set(decorated.map((summary) => summary.client_id).filter((value): value is string => Boolean(value))),
    ];
    const clientById = await postgresClientMetadataForClients(clientIds);
    if (clientById.size > 0) {
      decorated = decorated.map((summary) => annotateClientMetadata(summary, clientById));
    }
  }
  return decorated;
}

export async function postgresListSpineCorrelations(
  kind: string,
  filters: SpineCorrelationFilters = {}
): Promise<{ hasMore: boolean; nextCursor: string | null; summaries: Summary[] }> {
  const column = correlationColumn(kind);
  const key = correlationKind(kind);
  if (!(column && key)) {
    return { hasMore: false, nextCursor: null, summaries: [] };
  }
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 500));

  // Page-scope filters (applied after the aggregation): status filter is
  // applied against the summary's projected run-status, so it must run
  // after summarizeRows. The SQLite path does the same.
  const resultRows = await loadCorrelationAggregates(column, filters, limit);
  const pageRows = resultRows.slice(0, limit);
  const eventsById = await fetchRowsForSummaries(
    key,
    column,
    pageRows.map((row) => row.id)
  );
  let summaries = await Promise.all(pageRows.map((row) => summarizeRows(row.id, eventsById.get(row.id) || [], row)));

  if (filters.status) {
    const wanted = String(filters.status);
    summaries = summaries.filter((s) => s && s.status === wanted);
  }

  summaries = await decorateCorrelationSummaries(key, summaries);

  const hasMore = resultRows.length > limit;
  return {
    hasMore,
    nextCursor: hasMore ? encodeSummaryCursor(summaries.at(-1)) : null,
    summaries,
  };
}

interface SearchExactRow {
  readonly grant_id: string | null;
  readonly run_id: string | null;
  readonly trace_id: string | null;
}

interface ExactMatch {
  readonly id: string;
  readonly kind: CorrelationKind;
}

function exactSpineMatch(query: string, row: SearchExactRow | undefined): ExactMatch | null {
  if (row?.trace_id === query) {
    return { id: query, kind: "trace" };
  }
  if (row?.grant_id === query) {
    return { id: query, kind: "grant" };
  }
  if (row?.run_id === query) {
    return { id: query, kind: "run" };
  }
  return null;
}

async function searchSpineSummaries(kind: CorrelationKind, like: string): Promise<Summary[]> {
  const column = COLUMN_BY_KIND[kind];
  const correlations = await postgresQuery<CorrelationAggregateRow>(
    `SELECT ${column} AS id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*)::int AS event_count
     FROM spine_events
     WHERE ${column} ILIKE $1
     GROUP BY ${column}
     ORDER BY id ASC
     LIMIT 25`,
    [like]
  );
  const eventsById = await fetchRowsForSummaries(
    kind,
    column,
    correlations.rows.map((row) => row.id)
  );
  return Promise.all(correlations.rows.map((row) => summarizeRows(row.id, eventsById.get(row.id) || [], row)));
}

export async function postgresSearchSpine(query: unknown): Promise<{
  exact: ExactMatch | null;
  grants: Summary[];
  runs: Summary[];
  traces: Summary[];
}> {
  const q = String(query || "").trim();
  if (!q) {
    return { exact: null, grants: [], runs: [], traces: [] };
  }
  const exactResult = await postgresQuery<SearchExactRow>(
    `SELECT trace_id, grant_id, run_id
     FROM spine_events
     WHERE trace_id = $1 OR grant_id = $1 OR run_id = $1
     LIMIT 1`,
    [q]
  );
  const [exactRow] = exactResult.rows;
  const exact = exactSpineMatch(q, exactRow);

  const like = `%${q}%`;

  return {
    exact,
    grants: await searchSpineSummaries("grant", like),
    runs: await searchSpineSummaries("run", like),
    traces: await searchSpineSummaries("trace", like),
  };
}

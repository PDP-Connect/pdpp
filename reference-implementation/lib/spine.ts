// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { getDb } from "../server/db.js";
import { isPostgresStorageBackend } from "../server/postgres-storage.js";
import {
  execNamedOn,
  getMany,
  getOne,
  iterateDynamicSqlAcknowledged,
  type Page,
  referenceQueries,
  decodeCursor as wrapperDecodeCursor,
} from "./db.ts";
import {
  postgresEmitSpineEvent,
  postgresGetRunStartedEvent,
  postgresGetRunTerminalEvent,
  postgresListSpineCorrelations,
  postgresListSpineEventsPage,
  postgresSearchSpine,
} from "./postgres-spine.js";

/**
 * Narrow shape of the `better-sqlite3` database the spine module actually
 * exercises. We do not `import type Database from "better-sqlite3"` here so
 * this module stays typeable without depending on the native-addon types
 * being resolvable from the linter's sandbox; db.js supplies the real handle.
 */
interface SpinePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(params: object): void;
}

interface BetterSqliteDatabase {
  prepare(sql: string): SpinePreparedStatement;
}

export const DEFAULT_SCENARIO_ID = "scn_reference_default";
const SPINE_VERSION = "reference.spine.v1";

export type SpineDatabase = BetterSqliteDatabase;

export type SpineCorrelationKey = "trace" | "grant" | "run";

type SourceKind = "connector" | "provider_native";

export interface SourceObject {
  readonly id: string;
  readonly kind: SourceKind;
}

export interface SpineTraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

/**
 * Input shape accepted by `emitSpineEvent`. All fields are optional:
 * `normalizeSpineEventInput` fills in IDs and default actor/subject/object tags.
 * `data` is serialized into `data_json` for storage.
 */
export interface SpineEventInput {
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

/**
 * Persisted spine event record as written to `spine_events` and as returned by
 * `listSpineEvents` (with `data_json` re-hydrated into `data`).
 */
export interface SpineEventRecord {
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

interface NormalizedSpineEvent {
  readonly actor_id: string;
  readonly actor_type: string;
  readonly client_id: string | null;
  readonly connector_instance_id: string | null;
  readonly data_json: string;
  readonly event_id: string;
  readonly event_type: string | null;
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
  readonly data_json: string | null;
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

export interface SpineEventFilters {
  readonly eventType?: string | null;
  readonly grantId?: string | null;
  readonly runId?: string | null;
  readonly traceId?: string | null;
}

export interface SpineCorrelationFilters {
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

export interface SpineFailureSummary {
  readonly event_type: string;
  readonly reason: string | null;
}

export interface SpineClientMetadata {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly registration_mode: string | null;
}

export interface SpineSummary {
  actor_id: string;
  actor_type: string;
  browser_surface_lease_id?: string;
  browser_surface_profile_key?: string;
  browser_surface_status?: string;
  browser_surface_wait_reason?: string;
  client?: SpineClientMetadata | null;
  client_id: string | null;
  connection_id?: string | null;
  connector_id: string | null;
  connector_instance_id?: string | null;
  event_count: number;
  failure: SpineFailureSummary | null;
  first_at: string;
  grant_id: string | null;
  /**
   * Parent grant-package id when the grant's binding token carries
   * `package_id`. Populated by `listSpineCorrelations` for kind=`grant`
   * via a per-row tokens lookup. Surfaced on `_ref/grants` as an
   * optional field; pre-package-aware consumers ignore it.
   */
  grant_package_id?: string | null;
  id?: string;
  kinds: string[];
  last_at: string;
  needs_input: boolean;
  request_id: string | null;
  run_id: string | null;
  source: SourceObject | null;
  source_id: string | null;
  source_kind: SourceKind | null;
  status: string;
  trace_id: string | null;
}

export interface SpineCorrelationPage {
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly summaries: SpineSummary[];
}

export interface SpineSearchResult {
  readonly exact: { readonly kind: SpineCorrelationKey; readonly id: string } | null;
  readonly grants: SpineSummary[];
  readonly runs: SpineSummary[];
  readonly traces: SpineSummary[];
}

export function generateSpineId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParse(raw: string | null | undefined, fallback: unknown = null): unknown {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function createTraceContext({
  scenarioId = DEFAULT_SCENARIO_ID,
}: {
  scenarioId?: string;
} = {}): SpineTraceContext {
  return {
    scenario_id: scenarioId,
    trace_id: generateSpineId("trc"),
    request_id: generateSpineId("req"),
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asSourceKind(value: unknown): SourceKind | null {
  return value === "connector" || value === "provider_native" ? value : null;
}

function normalizeSourceObject(value: unknown): SourceObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const kind = asSourceKind(source.kind);
  const id = asOptionalString(source.id);
  if (kind && id) {
    return { kind, id };
  }

  const legacyKind = asSourceKind(source.binding_kind);
  if (legacyKind === "connector") {
    const id = asOptionalString(source.connector_id);
    return id ? { kind: "connector", id } : null;
  }
  if (legacyKind === "provider_native") {
    const id = asOptionalString(source.provider_id);
    return id ? { kind: "provider_native", id } : null;
  }

  const connectorId = asOptionalString(source.connector_id);
  const providerId = asOptionalString(source.provider_id);
  if (connectorId && !providerId) {
    return { kind: "connector", id: connectorId };
  }
  if (providerId && !connectorId) {
    return { kind: "provider_native", id: providerId };
  }
  return null;
}

function deriveSourceFromEventInput(input: SpineEventInput, actorType: string, actorId: string): SourceObject | null {
  const explicitKind = asSourceKind(input.source_kind);
  const explicitId = asOptionalString(input.source_id);
  if (explicitKind && explicitId) {
    return { kind: explicitKind, id: explicitId };
  }

  const data =
    input.data && typeof input.data === "object" && !Array.isArray(input.data)
      ? (input.data as Record<string, unknown>)
      : null;
  const source = normalizeSourceObject(data?.source) ?? normalizeSourceObject(data?.source_binding);
  if (source) {
    return source;
  }

  const connectorId = asOptionalString(data?.connector_id);
  const providerId = asOptionalString(data?.provider_id);
  if (connectorId && !providerId) {
    return { kind: "connector", id: connectorId };
  }
  if (providerId && !connectorId) {
    return { kind: "provider_native", id: providerId };
  }
  if (actorType === "runtime" && actorId) {
    return { kind: "connector", id: actorId };
  }
  return null;
}

/**
 * The connection an event's `data` payload attributes to, or `null` when it
 * names none. Mirrors `readEventConnectionId` in
 * connector-summary-read-model.ts exactly (same field precedence) — that
 * reader is what ultimately consumes this value once promoted to the
 * `spine_events.connector_instance_id` column, so the two must agree on
 * where connection identity lives in the payload. Most spine event types
 * (grants, tokens, interactions, traces) carry no connection attribution and
 * correctly return null here.
 */
function deriveConnectorInstanceIdFromEventInput(input: SpineEventInput): string | null {
  const data =
    input.data && typeof input.data === "object" && !Array.isArray(input.data)
      ? (input.data as Record<string, unknown>)
      : null;
  if (!data) {
    return null;
  }
  return asOptionalString(data.connector_instance_id) ?? asOptionalString(data.connection_id);
}

function serializeSpineEventData(inputData: unknown, source: SourceObject | null): string {
  const data =
    inputData && typeof inputData === "object" && !Array.isArray(inputData)
      ? { ...(inputData as Record<string, unknown>) }
      : {};
  if (source) {
    data.source = source;
  }
  return JSON.stringify(data);
}

function normalizeSpineEventInput(input: SpineEventInput): NormalizedSpineEvent {
  const occurredAt = asString(input.occurred_at, nowIso());
  const actorType = asString(input.actor_type, "system");
  const actorId = asString(input.actor_id, "pdpp_reference");
  const source = deriveSourceFromEventInput(input, actorType, actorId);
  return {
    event_id: asString(input.event_id, generateSpineId("evt")),
    event_type: asOptionalString(input.event_type),
    occurred_at: occurredAt,
    recorded_at: nowIso(),
    scenario_id: asString(input.scenario_id, DEFAULT_SCENARIO_ID),
    trace_id: asString(input.trace_id, generateSpineId("trc")),
    actor_type: actorType,
    actor_id: actorId,
    subject_type: asOptionalString(input.subject_type),
    subject_id: asOptionalString(input.subject_id),
    object_type: asString(input.object_type, "event"),
    object_id: asString(input.object_id, generateSpineId("obj")),
    status: asString(input.status, "succeeded"),
    request_id: asOptionalString(input.request_id),
    grant_id: asOptionalString(input.grant_id),
    run_id: asOptionalString(input.run_id),
    source_kind: source?.kind ?? null,
    source_id: source?.id ?? null,
    client_id: asOptionalString(input.client_id),
    stream_id: asOptionalString(input.stream_id),
    token_id: asOptionalString(input.token_id),
    interaction_id: asOptionalString(input.interaction_id),
    connector_instance_id: deriveConnectorInstanceIdFromEventInput(input),
    data_json: serializeSpineEventData(input.data, source),
    version: asString(input.version, SPINE_VERSION),
  };
}

/**
 * Emit a spine event synchronously. Declared `async` for backwards-compatible
 * return shape (callers already `await` it); internally the `better-sqlite3`
 * INSERT is synchronous, so the returned Promise resolves on the next tick
 * with no I/O wait. That means callers inside a `db.transaction(fn)` block
 * can either call this without `await` or use the synchronous insert path
 * directly — the DB write has already happened when the call returns.
 */
/**
 * Process-local boot-epoch singleton.
 *
 * Set once per process by `startServer` after `controller.booted` is
 * emitted (see docs/run-reconciliation-design-brief.md §3.4). Read by
 * `runConnector` and any other `run.started` emitter to stamp events.
 *
 * Stays unset until `setCurrentBootEpoch` is called — `emitSpineEvent`
 * will reject `run.started` emissions until then (see
 * `assertRunStartedIsStamped`).
 */
let currentBootEpoch: BootEpoch | null = null;

export interface BootEpoch {
  readonly boot_epoch: string;
  readonly controller_id: string;
  readonly seq: number;
}

export function setCurrentBootEpoch(epoch: BootEpoch): void {
  if (!epoch.boot_epoch || typeof epoch.boot_epoch !== "string") {
    throw new Error("setCurrentBootEpoch: boot_epoch must be a non-empty string");
  }
  if (typeof epoch.seq !== "number" || !Number.isFinite(epoch.seq) || epoch.seq < 1) {
    throw new Error("setCurrentBootEpoch: seq must be a positive integer");
  }
  if (!epoch.controller_id || typeof epoch.controller_id !== "string") {
    throw new Error("setCurrentBootEpoch: controller_id must be a non-empty string");
  }
  currentBootEpoch = { ...epoch };
}

export function getCurrentBootEpoch(): BootEpoch | null {
  return currentBootEpoch;
}

export function clearCurrentBootEpoch(): void {
  currentBootEpoch = null;
}
export function emitSpineEvent(
  input: SpineEventInput = {},
  dbHandle: SpineDatabase | null = null
): Promise<SpineEventRecord | null> {
  try {
    assertRunStartedIsStamped(input);
  } catch (e) {
    return Promise.reject(e);
  }

  if (!dbHandle && isPostgresStorageBackend()) {
    return postgresEmitSpineEvent(input) as Promise<SpineEventRecord | null>;
  }

  const db = dbHandle ?? (getDb() as SpineDatabase | undefined);
  if (!db) {
    return Promise.resolve(null);
  }
  const event = normalizeSpineEventInput(input);

  execNamedOn(db, referenceQueries.spineInsertEvent, event);

  return Promise.resolve(hydrateNormalizedEvent(event));
}

/**
 * Boot-epoch reconciliation invariant — spine-layer enforcement.
 *
 * Every `run.started` event MUST be stamped with the current boot's
 * `boot_epoch` (UUID) and `seq` (monotonic integer) in `data_json`.
 * The runtime controller (`startServer` in `reference-implementation/
 * server/index.js`) populates the singleton at boot; `runConnector`
 * reads it when emitting `run.started`. Anything that bypasses that
 * path — test fixtures, import scripts, future code paths — would
 * silently corrupt the orphan-recovery invariant by emitting events
 * that look prior-epoch forever and get re-abandoned every boot.
 *
 * Failing loudly here makes stamping a property of the spine schema
 * (enforced at every write), not a runtime convention.
 *
 * See docs/run-reconciliation-design-brief.md §3.3.
 *
 * `data` may be absent on legacy callers; the check is keyed off
 * `event_type` so non-run events are unaffected.
 */
function assertRunStartedIsStamped(input: SpineEventInput): void {
  if (input.event_type !== "run.started") {
    return;
  }
  const data = (input.data ?? {}) as Record<string, unknown>;
  const epoch = data.boot_epoch;
  const seq = data.seq;
  if (typeof epoch !== "string" || epoch.length === 0) {
    throw new Error(
      "emitSpineEvent: run.started requires data.boot_epoch (string uuid); controller singleton not initialized? " +
        "See docs/run-reconciliation-design-brief.md §3.3."
    );
  }
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 1) {
    throw new Error(
      "emitSpineEvent: run.started requires data.seq (positive integer); controller singleton not initialized? " +
        "See docs/run-reconciliation-design-brief.md §3.3."
    );
  }
}

function hydrateNormalizedEvent(event: NormalizedSpineEvent): SpineEventRecord {
  return {
    event_id: event.event_id,
    event_type: event.event_type ?? "",
    occurred_at: event.occurred_at,
    recorded_at: event.recorded_at,
    scenario_id: event.scenario_id,
    trace_id: event.trace_id,
    actor_type: event.actor_type,
    actor_id: event.actor_id,
    subject_type: event.subject_type,
    subject_id: event.subject_id,
    object_type: event.object_type,
    object_id: event.object_id,
    status: event.status,
    request_id: event.request_id,
    grant_id: event.grant_id,
    run_id: event.run_id,
    source_kind: event.source_kind,
    source_id: event.source_id,
    client_id: event.client_id,
    stream_id: event.stream_id,
    token_id: event.token_id,
    interaction_id: event.interaction_id,
    data: safeJsonParse(event.data_json, {}),
    version: event.version,
  };
}

function hydrateRows(rows: readonly SpineEventRow[]): SpineEventRecord[] {
  return rows.map((row) => ({
    event_id: row.event_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
    scenario_id: row.scenario_id,
    trace_id: row.trace_id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    object_type: row.object_type,
    object_id: row.object_id,
    status: row.status,
    request_id: row.request_id,
    grant_id: row.grant_id,
    run_id: row.run_id,
    source_kind: row.source_kind,
    source_id: row.source_id,
    client_id: row.client_id,
    stream_id: row.stream_id,
    token_id: row.token_id,
    interaction_id: row.interaction_id,
    data: safeJsonParse(row.data_json, {}),
    version: row.version,
  }));
}

/**
 * Spine event list, paginated. The triple `(kind, id)` selects which
 * correlation column is queried; `opts.limit` and `opts.cursor` thread
 * through the bounded-statement wrapper. `cursor` is opaque (produced
 * by a prior call's `nextCursor`). Used by the public `_ref` timeline
 * routes and by the per-correlation summarizers.
 *
 * The legacy `eventType` and bare-else (full-table) filters from the
 * pre-bounded `listSpineEvents` are intentionally not supported here:
 * neither had a non-test production caller, and both are unbounded
 * scans of the spine.
 *
 * The query lives in `server/queries/spine/list-events-by-{kind}-id.sql`
 * and is enforced by the registry's `LIMIT ?`-or-`@bounded_by` check.
 */
export type SpineCorrelationKind = "trace" | "grant" | "run";

export interface SpineEventPageOptions {
  readonly cursor?: string | null;
  readonly limit: number;
}

export interface SpineEventPage {
  readonly events: readonly SpineEventRecord[];
  readonly limit: number;
  readonly next_cursor: string | null;
  readonly truncated: boolean;
}

const PER_KIND_QUERY = {
  trace: referenceQueries.spineListEventsByTraceId,
  grant: referenceQueries.spineListEventsByGrantId,
  run: referenceQueries.spineListEventsByRunId,
} as const;

function decodeEventSeqFromCursor(cursor: string | null | undefined): number {
  // First page: `event_seq > 0` returns every row (event_seq is assigned
  // monotonically starting at 1). Cursors carry the last observed
  // event_seq so the next page picks up where we left off. The cursor is
  // opaque to clients and refers only to stable logical ordering — never
  // SQLite `rowid`.
  // Spec: openspec/changes/replace-spine-rowid-cursor-with-event-seq/specs/
  //       reference-implementation-architecture/spec.md
  if (!cursor) {
    return 0;
  }
  const decoded = wrapperDecodeCursor(cursor);
  return decoded.r;
}

/**
 * `getMany` returns rows as `Record<string, unknown>` because the
 * wrapper's generic only constrains "the shape has indexable string
 * keys." better-sqlite3 hands back plain objects whose keys are the
 * SELECTed columns; for `SELECT event_seq AS id, *` against
 * `spine_events`, those columns are exactly the `SpineEventRow` shape
 * plus an `id` (the event_seq projection used by the cursor builder).
 * The cast here is structural, not lossy.
 */
// The wrapper's `Page<R extends Record<string, unknown>>` generic can't
// know that this specific query selects the SpineEventRow shape; the
// SELECT is fixed in the .sql artifact. Reinterpret here at the
// boundary, cast through `unknown` to keep TS structurally honest.
type SpineEventRowProjection = readonly Record<string, unknown>[];
const asSpineEventRows = (rows: SpineEventRowProjection): SpineEventRow[] => rows as unknown as SpineEventRow[];

export function listSpineEventsPage(
  kind: SpineCorrelationKind,
  id: string,
  opts: SpineEventPageOptions
): SpineEventPage {
  if (isPostgresStorageBackend()) {
    return postgresListSpineEventsPage(kind, id, opts) as unknown as SpineEventPage;
  }

  const cursorEventSeq = decodeEventSeqFromCursor(opts.cursor ?? null);
  const query = PER_KIND_QUERY[kind];
  const page: Page<Record<string, unknown>> = getMany(query, [id, cursorEventSeq], {
    limit: opts.limit,
  });
  return {
    events: hydrateRows(asSpineEventRows(page.rows)),
    truncated: page.truncated,
    next_cursor: page.nextCursor,
    limit: opts.limit,
  };
}

/**
 * Window-independent terminal status for a run. One of `completed`,
 * `failed`, `cancelled`, `abandoned`, or `null` when the run has no
 * terminal event yet.
 */
export type RunTerminalStatus = "completed" | "failed" | "cancelled" | "abandoned";

interface RunLifecycleEventRow {
  readonly actor_id?: string | null;
  readonly data_json?: string | null;
  readonly event_type: string;
  readonly occurred_at?: string | null;
  readonly trace_id?: string | null;
}

const RUN_TERMINAL_EVENT_TYPE_TO_STATUS: Record<string, RunTerminalStatus> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.browser_surface_failed": "failed",
  "run.cancelled": "cancelled",
  "run.abandoned": "abandoned",
};

/**
 * Bounded single-event projection of a run lifecycle milestone
 * (`run.started` or the most-recent terminal event). `data` is the
 * event's parsed `data_json` payload (`null` when absent or malformed);
 * `actor_id` carries the connector id the runtime stamped on the event.
 * Consumed by the `GET /_ref/runs/:runId` run-handle status route.
 */
export interface RunLifecycleEventSummary {
  readonly actor_id: string | null;
  readonly data: Record<string, unknown> | null;
  readonly event_type: string;
  readonly occurred_at: string | null;
  readonly trace_id: string | null;
}

function summarizeRunLifecycleRow(row: RunLifecycleEventRow | null | undefined): RunLifecycleEventSummary | null {
  if (!row || typeof row.event_type !== "string") {
    return null;
  }
  let data: Record<string, unknown> | null = null;
  if (typeof row.data_json === "string" && row.data_json) {
    try {
      const parsed: unknown = JSON.parse(row.data_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed payloads read as "no data", never as a thrown 500.
    }
  }
  return {
    actor_id: typeof row.actor_id === "string" && row.actor_id ? row.actor_id : null,
    data,
    event_type: row.event_type,
    occurred_at: typeof row.occurred_at === "string" && row.occurred_at ? row.occurred_at : null,
    trace_id: typeof row.trace_id === "string" && row.trace_id ? row.trace_id : null,
  };
}

async function fetchRunTerminalEventRow(runId: string): Promise<RunLifecycleEventRow | null> {
  if (!runId) {
    return null;
  }
  const row = isPostgresStorageBackend()
    ? ((await postgresGetRunTerminalEvent(runId)) as RunLifecycleEventRow | null | undefined)
    : getOne<RunLifecycleEventRow>(referenceQueries.spineGetRunTerminalEvent, [runId]);
  return row ?? null;
}

/**
 * Resolve a run's terminal status from its most-recent terminal spine
 * event, independent of any paginated timeline window. Uses the bounded
 * `ORDER BY event_seq DESC LIMIT 1` terminal-event query
 * (`queries/spine/get-run-terminal-event.sql` for SQLite,
 * `postgresGetRunTerminalEvent` for Postgres) — it never scans the run's
 * full event list and never depends on `limit`/`cursor`. Returns `null`
 * when the run has no terminal event (still active / in progress).
 */
export async function getRunTerminalStatus(runId: string): Promise<RunTerminalStatus | null> {
  const row = await fetchRunTerminalEventRow(runId);
  if (!row) {
    return null;
  }
  return RUN_TERMINAL_EVENT_TYPE_TO_STATUS[row.event_type] ?? null;
}

/**
 * Full bounded projection of a run's most-recent terminal event
 * (status + occurred_at + connector/trace identity + parsed payload).
 * Same `LIMIT 1` read as `getRunTerminalStatus`; returns `null` when
 * the run has no terminal event yet.
 */
export async function getRunTerminalEvent(
  runId: string
): Promise<(RunLifecycleEventSummary & { readonly status: RunTerminalStatus }) | null> {
  const summary = summarizeRunLifecycleRow(await fetchRunTerminalEventRow(runId));
  if (!summary) {
    return null;
  }
  const status = RUN_TERMINAL_EVENT_TYPE_TO_STATUS[summary.event_type];
  if (!status) {
    return null;
  }
  return { ...summary, status };
}

/**
 * Bounded projection of a run's `run.started` event
 * (`queries/spine/get-run-started-event.sql` for SQLite,
 * `postgresGetRunStartedEvent` for Postgres; `ORDER BY event_seq ASC
 * LIMIT 1`). Returns `null` when the run never reached the runtime's
 * start emit — e.g. a launch failure before the connector child spawned.
 */
export async function getRunStartedEvent(runId: string): Promise<RunLifecycleEventSummary | null> {
  if (!runId) {
    return null;
  }
  const row = isPostgresStorageBackend()
    ? ((await postgresGetRunStartedEvent(runId)) as RunLifecycleEventRow | null | undefined)
    : getOne<RunLifecycleEventRow>(referenceQueries.spineGetRunStartedEvent, [runId]);
  return summarizeRunLifecycleRow(row);
}

/**
 * Summary cap. Internal callers (`listSpineCorrelations`, `searchSpine`)
 * fetch up to this many events per correlation row to compute summaries.
 * The number is generous enough to fit every current real-world run
 * (largest observed: 2,542 events) and bounded enough to prevent the
 * archived V8-scavenger pathology from re-emerging via a per-row scan.
 *
 * If a correlation's true event count exceeds this cap, summaries
 * computed from the truncated sample may miss connector_id, terminal
 * failure label, or interaction state that lives beyond the window.
 * The SQL aggregate's `event_count` remains accurate; only the
 * derived-from-events fields can degrade. A future change should
 * replace per-row hydration with two bounded queries (first events +
 * last events) feeding a refactored `summarizeEventsBounded`. Tracked
 * in `bound-spine-and-record-read-paths/tasks.md` § Deferred follow-up.
 */
const SUMMARY_EVENT_CAP = 5000;

// Portable null-last total order, ascending: rows with a null event_seq
// always sort after every row with a non-null event_seq. This does NOT rely
// on SQLite's default NULL ordering (NULL sorts first on ASC by default) —
// the `(event_seq IS NULL)` expression pins the same null-last behavior
// SQLite and Postgres share here (see EVENT_ROW_ORDER_ASC in
// lib/postgres-spine.js, which both databases must encode identically).
// event_id is the final tie-break: always present and unique, so it fully
// determines order whenever event_seq is null or (in principle) duplicated.
const EVENT_ROW_ORDER_ASC = "(event_seq IS NULL), event_seq ASC, event_id ASC";

/**
 * Fetches the first-`SUMMARY_EVENT_CAP` event window for every id in one
 * query instead of one query per id. Mirrors the Postgres
 * `fetchRowsForSummaries` batching (`lib/postgres-spine.js`) — a
 * `ROW_NUMBER() OVER (PARTITION BY ...)` keeps the same per-id LIMIT
 * semantics a per-row `LIMIT ?` query would have.
 */
function loadEventsForSummaries(kind: SpineCorrelationKind, ids: readonly string[]): Map<string, SpineEventRecord[]> {
  const byId = new Map<string, SpineEventRecord[]>();
  if (ids.length === 0) {
    return byId;
  }
  const column = CORRELATION_COLUMN[kind];
  const placeholders = ids.map(() => "?").join(", ");
  // REVIEWED-DYNAMIC: IN-list cardinality is page-bounded by the caller
  // (aggregate rows already capped at `sqlLimit`, itself a small multiple
  // of clampLimit's ≤500 ceiling); `column` is drawn from the fixed
  // CORRELATION_COLUMN map, never caller input.
  //
  // The window function's ORDER BY only decides which rows have rn <= N
  // (partition membership) — it makes no promise about the order rows come
  // back in. summarizeEvents relies on array order (first/last event,
  // reverse scans for status), so the outer SELECT needs its own explicit
  // ORDER BY the same way the old per-row `ORDER BY event_seq ASC` query did.
  const rows = [
    ...iterateDynamicSqlAcknowledged<Record<string, unknown>>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY ${EVENT_ROW_ORDER_ASC}) AS rn
         FROM spine_events
         WHERE ${column} IN (${placeholders})
       ) ranked
       WHERE rn <= ?
       ORDER BY ${column}, ${EVENT_ROW_ORDER_ASC}`,
      [...ids, SUMMARY_EVENT_CAP]
    ),
  ];
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const id of ids) {
    grouped.set(id, []);
  }
  for (const row of rows) {
    const id = row[column] as string;
    grouped.get(id)?.push(row);
  }
  for (const [id, idRows] of grouped) {
    byId.set(id, hydrateRows(asSpineEventRows(idRows)));
  }
  return byId;
}

/**
 * Aggregate spine events into per-correlation summaries.
 *
 * Reference-only helper used by the `_ref` list surfaces.
 */
function connectorIdFromEvent(ev: SpineEventRecord): string | null {
  if (ev.source_kind === "connector" && ev.source_id) {
    return ev.source_id;
  }
  if (ev.actor_type === "runtime" && ev.actor_id) {
    return ev.actor_id;
  }
  const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
  if (typeof d.connector_id === "string") {
    return d.connector_id;
  }
  const sourceBinding = d.source_binding;
  if (sourceBinding && typeof sourceBinding === "object") {
    const id = (sourceBinding as Record<string, unknown>).connector_id;
    if (typeof id === "string") {
      return id;
    }
  }
  const source = d.source;
  if (source && typeof source === "object") {
    const normalized = normalizeSourceObject(source);
    if (normalized?.kind === "connector") {
      return normalized.id;
    }
  }
  return null;
}

function sourceFromEvent(ev: SpineEventRecord): SourceObject | null {
  const sourceKind = asSourceKind(ev.source_kind);
  if (sourceKind && ev.source_id) {
    return { kind: sourceKind, id: ev.source_id };
  }
  const data = ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : {};
  const source = normalizeSourceObject(data.source) ?? normalizeSourceObject(data.source_binding);
  if (source) {
    return source;
  }
  if (typeof data.connector_id === "string") {
    return { kind: "connector", id: data.connector_id };
  }
  if (typeof data.provider_id === "string") {
    return { kind: "provider_native", id: data.provider_id };
  }
  if (ev.actor_type === "runtime" && ev.actor_id) {
    return { kind: "connector", id: ev.actor_id };
  }
  return null;
}

function pickFirstNonNull<T extends keyof SpineEventRecord>(
  events: readonly SpineEventRecord[],
  key: T
): SpineEventRecord[T] | null {
  for (const ev of events) {
    const value = ev[key];
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}
// RUN_TERMINAL_EVENT_TYPES — the canonical set of terminal events for a
// run lifecycle. `run.browser_surface_failed` is a terminal pre-launch
// failure: the connector never receives a browser surface, so no later
// `run.failed` event will arrive from connector execution. All run-status
// projection code must read from this set; never hardcode subset checks like
// `["completed", "failed"]` elsewhere.
const RUN_TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
]);

// Walk events newest-first and pick the most recent status that satisfies
// `accept`. Returns `null` when no event matches.
function findLatestStatus(
  events: readonly SpineEventRecord[],
  accept: (event: SpineEventRecord) => boolean
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!(ev && accept(ev))) {
      continue;
    }
    const s = ev.status;
    if (s && s !== "unknown") {
      return s;
    }
  }
  return null;
}

// Run-correlation summaries must reflect the run's lifecycle status
// (`run.completed` / `run.failed`), NOT the status of incidental sub-resource
// events that happen to share the run_id (e.g. `run.stream_session_resolved`,
// which carries `status: "completed"` when an *operator-side* stream cleanly
// closes — independent of whether the connector run itself succeeded).
// Without this filter, a run that emits both `run.failed` AND a
// `run.stream_session_resolved` (status="completed") would surface as
// "completed" in the dashboard, which is dishonest about the real outcome.
//
// Note: this is a targeted patch over a deeper design tension — the spine
// event model conflates run-lifecycle status with sub-resource status under
// a single `status` column. The deeper fix is for the spec to distinguish
// run-terminal events from sub-resource events explicitly. Tracked in
// `openspec/changes/refine-spine-status-semantics-for-mixed-correlations/`.
//
// A started run with no terminal event is only live if the controller still
// has an active lease for its run_id. Without that lease, it is an orphaned
// started run and must not keep the dashboard auto-polling indefinitely.
function hasActiveRunLease(runId: string | null): boolean {
  if (!runId) {
    return false;
  }
  const db = getDb() as SpineDatabase | undefined;
  if (!db) {
    return false;
  }
  const row = db.prepare("SELECT 1 AS active FROM controller_active_runs WHERE run_id = ? LIMIT 1").get(runId) as
    | { readonly active?: number }
    | undefined;
  return Boolean(row);
}

function pickSummaryStatus(events: readonly SpineEventRecord[]): string {
  const terminalStatus = findLatestStatus(events, (ev) => RUN_TERMINAL_EVENT_TYPES.has(ev.event_type));
  if (terminalStatus) {
    return terminalStatus;
  }

  const runId = pickFirstNonNull(events, "run_id") as string | null;
  if (events.some((ev) => ev.event_type === "run.started")) {
    return hasActiveRunLease(runId) ? "in_progress" : "failed";
  }

  return findLatestStatus(events, () => true) ?? "unknown";
}

function findFirstConnectorId(events: readonly SpineEventRecord[]): string | null {
  for (const ev of events) {
    const c = connectorIdFromEvent(ev);
    if (c) {
      return c;
    }
  }
  return null;
}

function findFirstSource(events: readonly SpineEventRecord[]): SourceObject | null {
  for (const ev of events) {
    const s = sourceFromEvent(ev);
    if (s) {
      return s;
    }
  }
  return null;
}

function findLatestBrowserSurfaceProjection(events: readonly SpineEventRecord[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event?.event_type?.startsWith("run.browser_surface_")) {
      continue;
    }
    const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : null;
    const projection = data?.browser_surface;
    if (projection && typeof projection === "object" && !Array.isArray(projection)) {
      return projection as Record<string, unknown>;
    }
  }
  return null;
}

const BROWSER_SURFACE_PROJECTION_KEYS = [
  "browser_surface_status",
  "browser_surface_wait_reason",
  "browser_surface_lease_id",
  "browser_surface_profile_key",
] as const;

function pickBrowserSurfaceFields(projection: Record<string, unknown> | null): Record<string, string> {
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

function connectionIdFromBrowserSurfaceProfileKey(projection: Record<string, unknown> | null): string | null {
  const profileKey = projection?.browser_surface_profile_key;
  if (typeof profileKey !== "string" || profileKey.length === 0) {
    return null;
  }
  const suffix = profileKey.split(":").at(-1);
  return suffix?.startsWith("cin_") ? suffix : null;
}

function connectionIdFromEventData(event: SpineEventRecord): string | null {
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : null;
  if (!data) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.connection_id === "string" && record.connection_id.length > 0) {
    return record.connection_id;
  }
  if (typeof record.connector_instance_id === "string" && record.connector_instance_id.length > 0) {
    return record.connector_instance_id;
  }
  return null;
}

function findFirstConnectionId(events: readonly SpineEventRecord[]): string | null {
  for (const event of events) {
    const connectionId = connectionIdFromEventData(event);
    if (connectionId) {
      return connectionId;
    }
  }
  return null;
}

function summarizeEvents(events: readonly SpineEventRecord[]): SpineSummary | null {
  if (events.length === 0) {
    return null;
  }
  const first = events[0];
  const last = events.at(-1);
  if (!(first && last)) {
    return null;
  }
  const kinds = Array.from(new Set(events.map((e) => e.event_type))).slice(0, 16);
  const status = pickSummaryStatus(events);
  const terminalFailure = events.find((e) => e.status === "failed" || e.status === "rejected");
  const inferredOrphanFailure =
    !terminalFailure && status === "failed" && events.some((e) => e.event_type === "run.started")
      ? { event_type: "run.started", reason: "orphaned_started_run" }
      : null;
  const source = findFirstSource(events);
  const browserSurface = findLatestBrowserSurfaceProjection(events);
  const connectionId = findFirstConnectionId(events) ?? connectionIdFromBrowserSurfaceProfileKey(browserSurface);

  return {
    first_at: first.occurred_at,
    last_at: last.occurred_at,
    event_count: events.length,
    status,
    kinds,
    needs_input: hasPendingRunInteraction(events, status),
    request_id: pickFirstNonNull(events, "request_id") as string | null,
    grant_id: pickFirstNonNull(events, "grant_id") as string | null,
    trace_id: pickFirstNonNull(events, "trace_id") as string | null,
    run_id: pickFirstNonNull(events, "run_id") as string | null,
    client_id: pickFirstNonNull(events, "client_id") as string | null,
    source,
    source_kind: source?.kind ?? null,
    source_id: source?.id ?? null,
    connector_id: findFirstConnectorId(events),
    ...(connectionId
      ? { connection_id: connectionId, connector_instance_id: connectionId }
      : {}),
    actor_type: first.actor_type,
    actor_id: first.actor_id,
    ...pickBrowserSurfaceFields(browserSurface),
    failure: terminalFailure
      ? {
          event_type: terminalFailure.event_type,
          reason: readFailureReason(terminalFailure.data),
        }
      : inferredOrphanFailure,
  };
}

function hasPendingRunInteraction(events: readonly SpineEventRecord[], status: string): boolean {
  if (["succeeded", "failed", "cancelled", "rejected"].includes(status)) {
    return false;
  }

  const completed = new Set(
    events
      .filter((event) => event.event_type === "run.interaction_completed")
      .map((event) => event.interaction_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.event_type !== "run.interaction_required") {
      continue;
    }
    if (typeof event.interaction_id !== "string" || event.interaction_id.length === 0) {
      continue;
    }
    return !completed.has(event.interaction_id);
  }

  return false;
}

function readFailureReason(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const d = data as Record<string, unknown>;
  if (typeof d.reason === "string") {
    return d.reason;
  }
  if (typeof d.failure_reason === "string") {
    return d.failure_reason;
  }
  return null;
}

function decodeCursor(cursor: string | null | undefined): string | null {
  return cursor || null;
}

function applyFilters(summary: SpineSummary, filters: SpineCorrelationFilters): boolean {
  if (filters.status && summary.status !== filters.status) {
    return false;
  }
  if (filters.since && summary.last_at < filters.since) {
    return false;
  }
  if (filters.until && summary.first_at > filters.until) {
    return false;
  }
  if (filters.clientId && summary.client_id !== filters.clientId) {
    return false;
  }
  if (filters.sourceKind && summary.source_kind !== filters.sourceKind) {
    return false;
  }
  if (filters.sourceId && summary.source_id !== filters.sourceId) {
    return false;
  }
  if (filters.grantId && summary.grant_id !== filters.grantId) {
    return false;
  }
  return true;
}

type GrantLifecycleKind = "revoked" | "denied" | "failed" | "issued" | null;

const DENIED_EVENT_TYPES = new Set(["grant.denied", "consent.denied"]);
const FAILED_EVENT_TYPES = new Set(["grant.rejected", "request.rejected"]);
const FAILED_STATUSES = new Set(["rejected", "failed"]);

function classifyGrantEvent(ev: SpineEventRecord): GrantLifecycleKind {
  const t = ev.event_type;
  if (!t) {
    return null;
  }
  if (t === "grant.revoked" || ev.status === "revoked") {
    return "revoked";
  }
  if (DENIED_EVENT_TYPES.has(t)) {
    return "denied";
  }
  if (FAILED_EVENT_TYPES.has(t) || FAILED_STATUSES.has(ev.status)) {
    return "failed";
  }
  if (t === "grant.issued" || ev.status === "issued") {
    return "issued";
  }
  return null;
}

function deriveGrantLifecycleStatus(events: readonly SpineEventRecord[]): string {
  // Pick the most advanced terminal state across the grant's event history.
  // Order of precedence (strongest wins): revoked > denied > failed/rejected > issued > pending.
  let status = "pending";
  for (const ev of events) {
    const kind = classifyGrantEvent(ev);
    if (kind === "revoked") {
      return "revoked";
    }
    if (kind === "denied" && status !== "revoked") {
      status = "denied";
    } else if (kind === "failed" && (status === "pending" || status === "issued")) {
      status = "failed";
    } else if (kind === "issued" && status === "pending") {
      status = "issued";
    }
  }
  return status;
}

const CORRELATION_COLUMN: Record<SpineCorrelationKey, "trace_id" | "grant_id" | "run_id"> = {
  trace: "trace_id",
  grant: "grant_id",
  run: "run_id",
};

const CORRELATION_KIND_FOR_COLUMN: Record<"trace_id" | "grant_id" | "run_id", SpineCorrelationKind> = {
  trace_id: "trace",
  grant_id: "grant",
  run_id: "run",
};

interface CorrelationAggregateRow {
  readonly event_count: number;
  readonly first_at: string;
  readonly id: string;
  readonly last_at: string;
}

function parseCursor(raw: string | null): { lastAt: string | null; id: string | null } {
  if (!raw) {
    return { lastAt: null, id: null };
  }
  const sep = raw.indexOf("::");
  if (sep <= 0) {
    return { lastAt: null, id: null };
  }
  return { lastAt: raw.slice(0, sep), id: raw.slice(sep + 2) };
}

function clampLimit(raw: unknown): number {
  const value = Number(raw) || 50;
  return Math.max(1, Math.min(value, 500));
}

/**
 * SQL-level aggregation of spine events into per-correlation summaries.
 *
 * Shape:
 *   1. SQL `GROUP BY <correlation_column>` with bounded aggregates and SQL
 *      LIMIT/ORDER BY. `since`/`until`/`status` (strict — i.e., existence of
 *      any matching event) push into the WHERE clause. `clientId`/`sourceKind`/
 *      `sourceId`/`grantId` are event-column equality filters pushed into WHERE too.
 *   2. SQL `q` narrowing via LIKE on the indexed correlation columns.
 *      Secondary-field LIKE (request_id / client_id / source_id) stays as a
 *      page-scope filter in JS to avoid a Cartesian product in the GROUP BY.
 *   3. Page-scope hydration: for the at-most-`limit` group ids, fetch their
 *      events via `listSpineEventsSync` and run `summarizeEvents` /
 *      `deriveGrantLifecycleStatus` to produce the same response shape.
 *   4. Page-scope JS filters: fuzzy `q` match on secondary fields.
 *
 * Backwards-compatible return shape: `{summaries, hasMore, nextCursor}`. The
 * cursor remains `"<last_at>::<id>"`.
 */
export function listSpineCorrelations(
  key: SpineCorrelationKey | string,
  filters: SpineCorrelationFilters = {}
): Promise<SpineCorrelationPage> {
  if (isPostgresStorageBackend()) {
    return postgresListSpineCorrelations(key, filters) as Promise<SpineCorrelationPage>;
  }
  return Promise.resolve(listSpineCorrelationsSqlite(key, filters));
}

interface CorrelationAggregateSql {
  readonly binds: (string | number)[];
  readonly sql: string;
}

// Builds the GROUP-BY aggregate query that narrows correlations before
// per-id event hydration. SQL filters cover columns that are constant across
// every event in a correlation (client_id, source_kind/id, grant_id),
// since/until become HAVING clauses over MIN/MAX(occurred_at), and the q
// LIKE applies only to the indexed correlation column. Secondary-field q
// matching stays in the per-row page-scope pass.
function buildCorrelationAggregateSql(
  column: string,
  filters: SpineCorrelationFilters,
  sqlLimit: number
): CorrelationAggregateSql {
  const whereParts: string[] = [`${column} IS NOT NULL`];
  const whereBinds: (string | number)[] = [];
  const havingParts: string[] = [];
  const havingBinds: (string | number)[] = [];

  if (filters.since) {
    havingParts.push("MAX(occurred_at) >= ?");
    havingBinds.push(filters.since);
  }
  if (filters.until) {
    havingParts.push("MIN(occurred_at) <= ?");
    havingBinds.push(filters.until);
  }
  if (filters.clientId) {
    whereParts.push("client_id = ?");
    whereBinds.push(filters.clientId);
  }
  if (filters.sourceKind) {
    whereParts.push("source_kind = ?");
    whereBinds.push(String(filters.sourceKind));
  }
  if (filters.sourceId) {
    whereParts.push("source_id = ?");
    whereBinds.push(filters.sourceId);
  }
  if (filters.grantId && column !== "grant_id") {
    whereParts.push("grant_id = ?");
    whereBinds.push(filters.grantId);
  }
  if (filters.q) {
    whereParts.push(`${column} LIKE ?`);
    whereBinds.push(`%${String(filters.q)}%`);
  }

  const { lastAt: cursorLastAt, id: cursorId } = parseCursor(decodeCursor(filters.cursor));
  if (cursorLastAt && cursorId) {
    havingParts.push(`(MAX(occurred_at) < ? OR (MAX(occurred_at) = ? AND ${column} < ?))`);
    havingBinds.push(cursorLastAt, cursorLastAt, cursorId);
  }
  const havingSql = havingParts.length > 0 ? ` HAVING ${havingParts.join(" AND ")}` : "";

  const sql = `
    SELECT
      ${column} AS id,
      MIN(occurred_at) AS first_at,
      MAX(occurred_at) AS last_at,
      COUNT(*) AS event_count
    FROM spine_events
    WHERE ${whereParts.join(" AND ")}
    GROUP BY ${column}${havingSql}
    ORDER BY last_at DESC, id DESC
    LIMIT ?
  `;
  return { sql, binds: [...whereBinds, ...havingBinds, sqlLimit] };
}

function matchesSecondaryQ(summary: SpineSummary, id: string, q: string | null | undefined): boolean {
  if (!q) {
    return true;
  }
  const needle = String(q).toLowerCase();
  const hay =
    `${id} ${summary.request_id || ""} ${summary.grant_id || ""} ${summary.run_id || ""} ${summary.client_id || ""} ${summary.source_id || ""}`.toLowerCase();
  return hay.includes(needle);
}

function hydrateAggregateRow(
  aggRow: CorrelationAggregateRow,
  key: SpineCorrelationKey | string,
  filters: SpineCorrelationFilters,
  eventsById: ReadonlyMap<string, SpineEventRecord[]>
): SpineSummary | null {
  const events = eventsById.get(aggRow.id) ?? [];
  if (events.length === 0) {
    return null;
  }
  const s = summarizeEvents(events);
  if (!s) {
    return null;
  }
  s.id = aggRow.id;
  // The hydration sample is capped; the aggregate row carries the full
  // correlation extent computed by SQL.
  s.first_at = aggRow.first_at;
  s.last_at = aggRow.last_at;
  s.event_count = aggRow.event_count;
  if (key === "grant") {
    s.status = deriveGrantLifecycleStatus(events);
  }
  if (!applyFilters(s, filters)) {
    return null;
  }
  if (!matchesSecondaryQ(s, aggRow.id, filters.q)) {
    return null;
  }
  return s;
}

// For grant correlations, attach the grant_package_id when the grant is a
// member of a package. The membership lookup is one query per page row,
// guarded by a non-null grant id.
function attachGrantPackageMembership(summaries: readonly SpineSummary[]): void {
  for (const s of summaries) {
    const gid = s.grant_id ?? s.id ?? null;
    if (!gid) {
      continue;
    }
    const row = getOne<{ readonly package_id: string | null }>(
      referenceQueries.authGrantPackageMembersGetPackageIdByGrant,
      [gid]
    );
    if (row?.package_id) {
      s.grant_package_id = row.package_id;
    }
  }
}

interface RegisteredClientMetadataRow {
  readonly client_id: string;
  readonly metadata_json: string | null;
  readonly registration_mode: string | null;
}

function clientMetadataFromOAuthRow(row: RegisteredClientMetadataRow): SpineClientMetadata {
  const metadata = safeJsonParse(row.metadata_json, {}) as Record<string, unknown>;
  const clientName =
    typeof metadata.client_name === "string" && metadata.client_name.trim() ? metadata.client_name.trim() : null;
  return {
    client_id: row.client_id,
    client_name: clientName,
    registration_mode:
      typeof row.registration_mode === "string" && row.registration_mode ? row.registration_mode : null,
  };
}

function attachClientMetadata(summaries: readonly SpineSummary[]): void {
  const clientIds = Array.from(
    new Set(
      summaries
        .map((s) => s.client_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  );
  if (clientIds.length === 0) {
    return;
  }
  const placeholders = clientIds.map(() => "?").join(", ");
  // REVIEWED-DYNAMIC: IN-list cardinality is page-bounded by clampLimit (≤500);
  // values are bound parameters and LIMIT is the same page-bound cardinality.
  const rows = [
    ...iterateDynamicSqlAcknowledged<RegisteredClientMetadataRow>(
      `SELECT client_id, registration_mode, metadata_json
       FROM oauth_clients
       WHERE client_id IN (${placeholders})
       LIMIT ?`,
      [...clientIds, clientIds.length]
    ),
  ];
  const byClientId = new Map(rows.map((row) => [row.client_id, clientMetadataFromOAuthRow(row)]));
  for (const summary of summaries) {
    if (summary.client_id) {
      summary.client = byClientId.get(summary.client_id) ?? null;
    }
  }
}

function listSpineCorrelationsSqlite(
  key: SpineCorrelationKey | string,
  filters: SpineCorrelationFilters
): SpineCorrelationPage {
  const empty: SpineCorrelationPage = { summaries: [], hasMore: false, nextCursor: null };
  if (!(getDb() as SpineDatabase | undefined)) {
    return empty;
  }
  const column = CORRELATION_COLUMN[key as SpineCorrelationKey];
  if (!column) {
    return empty;
  }

  const limit = clampLimit(filters.limit);
  // Over-fetch by a generous multiplier so the remaining page-scope JS filters
  // (status, connectorId for non-run correlations, fuzzy q on secondary fields)
  // have room to reject without under-filling the response.
  const sqlLimit = limit * 4;

  const { sql, binds } = buildCorrelationAggregateSql(column, filters, sqlLimit);
  const aggRows = [...iterateDynamicSqlAcknowledged<CorrelationAggregateRow>(sql, binds)];

  const correlationKind = CORRELATION_KIND_FOR_COLUMN[column];
  const eventsById = loadEventsForSummaries(
    correlationKind,
    aggRows.map((row) => row.id)
  );
  const summaries: SpineSummary[] = [];
  for (const aggRow of aggRows) {
    const summary = hydrateAggregateRow(aggRow, key, filters, eventsById);
    if (!summary) {
      continue;
    }
    summaries.push(summary);
    if (summaries.length >= limit + 1) {
      break;
    }
  }

  const hasMore = summaries.length > limit;
  const page = summaries.slice(0, limit);
  const tail = page.at(-1);
  const nextCursor = hasMore && tail ? `${tail.last_at}::${tail.id ?? ""}` : null;

  if (key === "grant" && page.length > 0) {
    attachGrantPackageMembership(page);
  }
  if ((key === "grant" || key === "trace") && page.length > 0) {
    attachClientMetadata(page);
  }

  return { summaries: page, hasMore, nextCursor };
}

interface SpineSearchBySecondaryRow {
  readonly trace_id: string | null;
}

/**
 * SQL-indexed search across spine_events. Exact match uses equality on the
 * indexed (trace_id, grant_id, run_id) columns and a fallback equality on
 * request_id. Fuzzy matches use LIKE on each indexed column; we fetch at
 * most `limit + 1` distinct ids per column and summarize them page-scope.
 */
export function searchSpine(query: unknown): Promise<SpineSearchResult> {
  if (isPostgresStorageBackend()) {
    return postgresSearchSpine(query) as Promise<SpineSearchResult>;
  }
  return Promise.resolve(searchSpineSqlite(query));
}

function searchSpineSqlite(query: unknown): SpineSearchResult {
  const db = getDb() as SpineDatabase | undefined;
  const empty: SpineSearchResult = { exact: null, traces: [], grants: [], runs: [] };
  if (!db) {
    return empty;
  }
  const q = String(query || "").trim();
  if (!q) {
    return empty;
  }

  return {
    exact: findExactMatch(q),
    traces: summariesForLike("trace_id", q),
    grants: summariesForLike("grant_id", q),
    runs: summariesForLike("run_id", q),
  };
}

function findExactMatch(q: string): { kind: SpineCorrelationKey; id: string } | null {
  const columns: readonly { column: "trace_id" | "grant_id" | "run_id"; kind: SpineCorrelationKey }[] = [
    { column: "trace_id", kind: "trace" },
    { column: "grant_id", kind: "grant" },
    { column: "run_id", kind: "run" },
  ];

  for (const { column, kind } of columns) {
    const row = getOne(EXACT_MATCH_QUERY[column], [q]);
    if (row) {
      return { kind, id: q };
    }
  }
  // request_id is un-indexed but small-cardinality; the lookup is bounded.
  const fallback = getOne<SpineSearchBySecondaryRow>(referenceQueries.spineSearchFindTraceIdByRequestId, [q]);
  if (fallback?.trace_id) {
    return { kind: "trace", id: fallback.trace_id };
  }
  return null;
}

interface SpineSearchLikeRow {
  readonly id: string;
  readonly last_at: string;
}

const EXACT_MATCH_QUERY = {
  trace_id: referenceQueries.spineSearchFindTraceId,
  grant_id: referenceQueries.spineSearchFindGrantId,
  run_id: referenceQueries.spineSearchFindRunId,
} as const;

const LIKE_SUMMARY_QUERY = {
  trace_id: referenceQueries.spineSearchListTraceSummariesByLike,
  grant_id: referenceQueries.spineSearchListGrantSummariesByLike,
  run_id: referenceQueries.spineSearchListRunSummariesByLike,
} as const;

function summariesForLike(column: "trace_id" | "grant_id" | "run_id", q: string): SpineSummary[] {
  const like = `%${q}%`;
  const page = getMany<Record<string, unknown>>(LIKE_SUMMARY_QUERY[column], [like], { limit: 10 });
  const idRows = page.rows as unknown as SpineSearchLikeRow[];

  const correlationKind = CORRELATION_KIND_FOR_COLUMN[column];
  const eventsById = loadEventsForSummaries(
    correlationKind,
    idRows.map((row) => row.id)
  );
  const out: SpineSummary[] = [];
  for (const { id } of idRows) {
    const events = eventsById.get(id) ?? [];
    if (events.length === 0) {
      continue;
    }
    const s = summarizeEvents(events);
    if (!s) {
      continue;
    }
    s.id = id;
    if (column === "grant_id") {
      s.status = deriveGrantLifecycleStatus(events);
    }
    out.push(s);
  }
  return out;
}

import { randomBytes } from "node:crypto";
import { getDb } from "../server/db.js";
import { getMany, type Page, referenceQueries, decodeCursor as wrapperDecodeCursor } from "./db.ts";

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
  readonly provider_id?: string | null;
  readonly request_id?: string | null;
  readonly run_id?: string | null;
  readonly scenario_id?: string | null;
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
  readonly provider_id: string | null;
  readonly recorded_at: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly scenario_id: string;
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
  readonly data_json: string;
  readonly event_id: string;
  readonly event_type: string | null;
  readonly grant_id: string | null;
  readonly interaction_id: string | null;
  readonly object_id: string;
  readonly object_type: string;
  readonly occurred_at: string;
  readonly provider_id: string | null;
  readonly recorded_at: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly scenario_id: string;
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
  readonly provider_id: string | null;
  readonly recorded_at: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly scenario_id: string;
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
  readonly connectorId?: string | null;
  readonly cursor?: string | null;
  readonly grantId?: string | null;
  readonly limit?: number | string | null;
  readonly providerId?: string | null;
  readonly q?: string | null;
  readonly since?: string | null;
  readonly status?: string | null;
  readonly until?: string | null;
}

export interface SpineFailureSummary {
  readonly event_type: string;
  readonly reason: string | null;
}

export interface SpineSummary {
  actor_id: string;
  actor_type: string;
  client_id: string | null;
  connector_id: string | null;
  event_count: number;
  failure: SpineFailureSummary | null;
  first_at: string;
  grant_id: string | null;
  id?: string;
  kinds: string[];
  last_at: string;
  needs_input: boolean;
  provider_id: string | null;
  request_id: string | null;
  run_id: string | null;
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

function normalizeSpineEventInput(input: SpineEventInput): NormalizedSpineEvent {
  const occurredAt = asString(input.occurred_at, nowIso());
  return {
    event_id: asString(input.event_id, generateSpineId("evt")),
    event_type: asOptionalString(input.event_type),
    occurred_at: occurredAt,
    recorded_at: nowIso(),
    scenario_id: asString(input.scenario_id, DEFAULT_SCENARIO_ID),
    trace_id: asString(input.trace_id, generateSpineId("trc")),
    actor_type: asString(input.actor_type, "system"),
    actor_id: asString(input.actor_id, "pdpp_reference"),
    subject_type: asOptionalString(input.subject_type),
    subject_id: asOptionalString(input.subject_id),
    object_type: asString(input.object_type, "event"),
    object_id: asString(input.object_id, generateSpineId("obj")),
    status: asString(input.status, "succeeded"),
    request_id: asOptionalString(input.request_id),
    grant_id: asOptionalString(input.grant_id),
    run_id: asOptionalString(input.run_id),
    provider_id: asOptionalString(input.provider_id),
    client_id: asOptionalString(input.client_id),
    stream_id: asOptionalString(input.stream_id),
    token_id: asOptionalString(input.token_id),
    interaction_id: asOptionalString(input.interaction_id),
    data_json: JSON.stringify(input.data ?? {}),
    version: asString(input.version, SPINE_VERSION),
  };
}

const INSERT_SPINE_EVENT_SQL = `
  INSERT INTO spine_events(
    event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
    actor_type, actor_id, subject_type, subject_id, object_type, object_id,
    status, request_id, grant_id, run_id, provider_id, client_id, stream_id,
    token_id, interaction_id, data_json, version
  ) VALUES (
    @event_id, @event_type, @occurred_at, @recorded_at, @scenario_id, @trace_id,
    @actor_type, @actor_id, @subject_type, @subject_id, @object_type, @object_id,
    @status, @request_id, @grant_id, @run_id, @provider_id, @client_id, @stream_id,
    @token_id, @interaction_id, @data_json, @version
  )
`;

/**
 * Emit a spine event synchronously. Declared `async` for backwards-compatible
 * return shape (callers already `await` it); internally the `better-sqlite3`
 * INSERT is synchronous, so the returned Promise resolves on the next tick
 * with no I/O wait. That means callers inside a `db.transaction(fn)` block
 * can either call this without `await` or use the synchronous insert path
 * directly — the DB write has already happened when the call returns.
 */
// biome-ignore lint/suspicious/useAwait: see doc-comment — historical async signature kept for call-site compatibility.
export async function emitSpineEvent(
  input: SpineEventInput = {},
  dbHandle: SpineDatabase | null = null
): Promise<SpineEventRecord | null> {
  const db = dbHandle ?? (getDb() as SpineDatabase | undefined);
  if (!db) {
    return null;
  }
  const event = normalizeSpineEventInput(input);

  db.prepare(INSERT_SPINE_EVENT_SQL).run(event);

  return hydrateNormalizedEvent(event);
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
    provider_id: event.provider_id,
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
    provider_id: row.provider_id,
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

function decodeRowidFromCursor(cursor: string | null | undefined): number {
  // First page: rowid > 0 returns every row. Cursors carry the last
  // observed rowid so the next page picks up where we left off.
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
 * SELECTed columns; for `SELECT rowid, *` against `spine_events`,
 * those columns are exactly the `SpineEventRow` shape plus a `rowid`.
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
  const cursorRowid = decodeRowidFromCursor(opts.cursor ?? null);
  const query = PER_KIND_QUERY[kind];
  const page: Page<Record<string, unknown>> = getMany(query, [id, cursorRowid], {
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

function loadEventsForSummary(kind: SpineCorrelationKind, id: string): SpineEventRecord[] {
  // First page only; the wrapper's MAX_PAGE_LIMIT bounds the read at
  // `SUMMARY_EVENT_CAP`. We deliberately do NOT page through additional
  // events here — a correlation that overflows the cap is already
  // pathological and should be inspected via the paginated timeline
  // surface, not summarized synchronously.
  const page = listSpineEventsPage(kind, id, { limit: SUMMARY_EVENT_CAP });
  return [...page.events];
}

/**
 * Aggregate spine events into per-correlation summaries.
 *
 * Reference-only helper used by the `_ref` list surfaces.
 */
function connectorIdFromEvent(ev: SpineEventRecord): string | null {
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
    const id = (source as Record<string, unknown>).connector_id;
    if (typeof id === "string") {
      return id;
    }
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

  let status = "unknown";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) {
      continue;
    }
    const s = ev.status;
    if (s && s !== "unknown") {
      status = s;
      break;
    }
  }

  const terminalFailure = events.find((e) => e.status === "failed" || e.status === "rejected");
  const needs_input = hasPendingRunInteraction(events, status);

  let connector_id: string | null = null;
  for (const ev of events) {
    const c = connectorIdFromEvent(ev);
    if (c) {
      connector_id = c;
      break;
    }
  }

  return {
    first_at: first.occurred_at,
    last_at: last.occurred_at,
    event_count: events.length,
    status,
    kinds,
    needs_input,
    request_id: pickFirstNonNull(events, "request_id") as string | null,
    grant_id: pickFirstNonNull(events, "grant_id") as string | null,
    trace_id: pickFirstNonNull(events, "trace_id") as string | null,
    run_id: pickFirstNonNull(events, "run_id") as string | null,
    client_id: pickFirstNonNull(events, "client_id") as string | null,
    provider_id: pickFirstNonNull(events, "provider_id") as string | null,
    connector_id,
    actor_type: first.actor_type,
    actor_id: first.actor_id,
    failure: terminalFailure
      ? {
          event_type: terminalFailure.event_type,
          reason: readFailureReason(terminalFailure.data),
        }
      : null,
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
  if (filters.providerId && summary.provider_id !== filters.providerId) {
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
 *      any matching event) push into the WHERE clause. `clientId`/`providerId`/
 *      `grantId` are event-column equality filters pushed into WHERE too.
 *   2. SQL `q` narrowing via LIKE on the indexed correlation columns.
 *      Secondary-field LIKE (request_id / client_id / provider_id) stays as a
 *      page-scope filter in JS to avoid a Cartesian product in the GROUP BY.
 *   3. Page-scope hydration: for the at-most-`limit` group ids, fetch their
 *      events via `listSpineEventsSync` and run `summarizeEvents` /
 *      `deriveGrantLifecycleStatus` to produce the same response shape.
 *   4. Page-scope JS filters: `connectorId` (derived from event JSON) and
 *      the fuzzy `q` match on secondary fields.
 *
 * Backwards-compatible return shape: `{summaries, hasMore, nextCursor}`. The
 * cursor remains `"<last_at>::<id>"`.
 */
// biome-ignore lint/suspicious/useAwait: historical async signature kept for call-site compatibility.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SQL+JS pagination flow is inherent; further decomposition would hide the WHERE/HAVING/cursor/page-filter interactions.
export async function listSpineCorrelations(
  key: SpineCorrelationKey | string,
  filters: SpineCorrelationFilters = {}
): Promise<SpineCorrelationPage> {
  const db = getDb() as SpineDatabase | undefined;
  const empty: SpineCorrelationPage = { summaries: [], hasMore: false, nextCursor: null };
  if (!db) {
    return empty;
  }
  const column = CORRELATION_COLUMN[key as SpineCorrelationKey];
  if (!column) {
    return empty;
  }

  const limit = clampLimit(filters.limit);

  const whereParts: string[] = [`${column} IS NOT NULL`];
  const whereBinds: (string | number)[] = [];

  // since/until: test against MAX/MIN respectively, done as HAVING after GROUP BY.
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

  // Event-column equality filters. Valid because these columns tag the event
  // and every event in a correlation carries the same value (or null) for them.
  if (filters.clientId) {
    whereParts.push("client_id = ?");
    whereBinds.push(filters.clientId);
  }
  if (filters.providerId) {
    whereParts.push("provider_id = ?");
    whereBinds.push(filters.providerId);
  }
  if (filters.grantId && column !== "grant_id") {
    whereParts.push("grant_id = ?");
    whereBinds.push(filters.grantId);
  }
  if (filters.connectorId && key === "run") {
    whereParts.push(
      "run_id IN (SELECT run_id FROM spine_events WHERE run_id IS NOT NULL AND actor_type = 'runtime' AND actor_id = ?)"
    );
    whereBinds.push(filters.connectorId);
  }

  // q narrowing on the indexed correlation column. Secondary-field LIKE stays
  // in the page-scope pass below.
  if (filters.q) {
    whereParts.push(`${column} LIKE ?`);
    whereBinds.push(`%${String(filters.q)}%`);
  }

  // Cursor seek: pages are ordered by (last_at DESC, id DESC) for stability.
  const { lastAt: cursorLastAt, id: cursorId } = parseCursor(decodeCursor(filters.cursor));

  // Over-fetch by a generous multiplier so the remaining page-scope JS filters
  // (status, connectorId for non-run correlations, fuzzy q on secondary fields)
  // have room to reject without under-filling the response.
  const sqlLimit = limit * 4;

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

  const aggRows = db.prepare(sql).all(...whereBinds, ...havingBinds, sqlLimit) as CorrelationAggregateRow[];

  const correlationKind = CORRELATION_KIND_FOR_COLUMN[column];
  const summaries: SpineSummary[] = [];

  for (const aggRow of aggRows) {
    const events = loadEventsForSummary(correlationKind, aggRow.id);
    if (events.length === 0) {
      continue;
    }
    const s = summarizeEvents(events);
    if (!s) {
      continue;
    }
    s.id = aggRow.id;
    if (key === "grant") {
      s.status = deriveGrantLifecycleStatus(events);
    }

    if (!applyFilters(s, filters)) {
      continue;
    }
    if (filters.connectorId && s.connector_id !== filters.connectorId) {
      continue;
    }
    if (filters.q) {
      const needle = String(filters.q).toLowerCase();
      const hay =
        `${aggRow.id} ${s.request_id || ""} ${s.grant_id || ""} ${s.run_id || ""} ${s.client_id || ""} ${s.provider_id || ""}`.toLowerCase();
      if (!hay.includes(needle)) {
        continue;
      }
    }

    summaries.push(s);
    if (summaries.length >= limit + 1) {
      break;
    }
  }

  const hasMore = summaries.length > limit;
  const page = summaries.slice(0, limit);
  const tail = page.at(-1);
  const nextCursor = hasMore && tail ? `${tail.last_at}::${tail.id ?? ""}` : null;
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
// biome-ignore lint/suspicious/useAwait: historical async signature kept for call-site compatibility.
export async function searchSpine(query: unknown): Promise<SpineSearchResult> {
  const db = getDb() as SpineDatabase | undefined;
  const empty: SpineSearchResult = { exact: null, traces: [], grants: [], runs: [] };
  if (!db) {
    return empty;
  }
  const q = String(query || "").trim();
  if (!q) {
    return empty;
  }

  const exactMatch = findExactMatch(db, q);

  return {
    exact: exactMatch,
    traces: summariesForLike(db, "trace_id", q),
    grants: summariesForLike(db, "grant_id", q),
    runs: summariesForLike(db, "run_id", q),
  };
}

function findExactMatch(db: SpineDatabase, q: string): { kind: SpineCorrelationKey; id: string } | null {
  const columns: readonly { column: "trace_id" | "grant_id" | "run_id"; kind: SpineCorrelationKey }[] = [
    { column: "trace_id", kind: "trace" },
    { column: "grant_id", kind: "grant" },
    { column: "run_id", kind: "run" },
  ];

  for (const { column, kind } of columns) {
    const row = db.prepare(`SELECT 1 FROM spine_events WHERE ${column} = ? LIMIT 1`).get(q);
    if (row) {
      return { kind, id: q };
    }
  }
  // request_id is un-indexed but small-cardinality; the lookup is bounded.
  const fallback = db
    .prepare("SELECT trace_id FROM spine_events WHERE request_id = ? AND trace_id IS NOT NULL LIMIT 1")
    .get(q) as SpineSearchBySecondaryRow | undefined;
  if (fallback?.trace_id) {
    return { kind: "trace", id: fallback.trace_id };
  }
  return null;
}

interface SpineSearchLikeRow {
  readonly id: string;
  readonly last_at: string;
}

function summariesForLike(db: SpineDatabase, column: "trace_id" | "grant_id" | "run_id", q: string): SpineSummary[] {
  const like = `%${q}%`;
  const idRows = db
    .prepare(
      `SELECT DISTINCT ${column} AS id, MAX(occurred_at) AS last_at
         FROM spine_events
        WHERE ${column} IS NOT NULL
          AND ${column} LIKE ?
        GROUP BY ${column}
        ORDER BY last_at DESC
        LIMIT 10`
    )
    .all(like) as SpineSearchLikeRow[];

  const correlationKind = CORRELATION_KIND_FOR_COLUMN[column];
  const out: SpineSummary[] = [];
  for (const { id } of idRows) {
    const events = loadEventsForSummary(correlationKind, id);
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

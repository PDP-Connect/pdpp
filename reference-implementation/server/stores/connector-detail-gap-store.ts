// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

// Type definitions for store interface
interface DetailGap {
  attempt_count: number;
  connector_id: string;
  connector_instance_id: string;
  created_at: string;
  detail_locator: unknown;
  discovered_run_id: string | null;
  gap_id: string;
  grant_id: string | null;
  last_attempt_at: string | null;
  last_error: unknown;
  last_run_id: string | null;
  lease_attempted: boolean;
  lease_expires_at: string | null;
  lease_id: string | null;
  // CAS recovery lease (see claimPendingGaps/releaseLeasedGaps): the run-owned
  // token that gates every attempt/outcome transition while a gap is served
  // in_progress. Null when the gap is not currently leased.
  lease_run_id: string | null;
  list_cursor: unknown;
  next_attempt_after: string | null;
  parent_stream: string | null;
  reason: string | null;
  record_key: string | null;
  recovered_run_id: string | null;
  scope: unknown;
  source: unknown;
  status: string;
  stream: string;
  updated_at: string;
}

// Raw `connector_detail_gaps` row shape (both engines: SQLite `SELECT *` /
// Postgres `SELECT * ... RETURNING *`), consumed by `rowToGap`. Column
// definitions: `server/db.js` (SQLite DDL) and `server/postgres-storage.js`
// (Postgres DDL) — the two are kept column-identical.
interface DetailGapRow {
  attempt_count: number;
  connector_id: string;
  connector_instance_id: string;
  created_at: string;
  detail_locator_json: string | null;
  discovered_run_id: string | null;
  gap_id: string;
  grant_id: string | null;
  last_attempt_at: string | null;
  last_error_json: string | null;
  last_run_id: string | null;
  lease_attempted: number;
  lease_expires_at: string | null;
  lease_id: string | null;
  lease_run_id: string | null;
  list_cursor_json: string | null;
  next_attempt_after: string | null;
  parent_stream: string | null;
  reason: string | null;
  record_key: string | null;
  recovered_run_id: string | null;
  scope_json: string | null;
  source_json: string;
  status: string;
  stream: string;
  updated_at: string;
}

// Input accepted by `upsertPendingGap` / `normalizeGapInput`. Every field is
// caller-optional except `connectorId` and `stream` (enforced at runtime by
// `deriveGapIdentity`); `connectorInstanceId` defaults to the deterministic
// default-account instance when absent.
interface UpsertGapInput {
  connectorId?: string | null;
  connectorInstanceId?: string | null;
  detailLocator?: unknown;
  discoveredRunId?: string | null;
  gapId?: string | null;
  grantId?: string | null;
  lastError?: unknown;
  lastRunId?: string | null;
  listCursor?: unknown;
  nextAttemptAfter?: string | null;
  now?: string | null;
  parentStream?: string | null;
  reason?: string | null;
  recordKey?: unknown;
  scope?: unknown;
  source?: unknown;
  stream?: string | null;
}

// Normalized/derived shape produced by `normalizeGapInput`, consumed by both
// backend `upsertPendingGap` implementations.
interface NormalizedGapInput {
  connectorId: string;
  connectorInstanceId: string;
  detailLocator: unknown;
  discoveredRunId: string | null;
  gapId: string;
  grantId: string | null;
  lastError: unknown;
  lastRunId: string | null;
  listCursor: unknown;
  nextAttemptAfter: string | null;
  now: string;
  parentStream: string | null;
  reason: string | null;
  recordKey: string | null;
  scope: unknown;
  source: unknown;
  stream: string;
}

// Options accepted by `markGapStatus`.
interface MarkGapStatusOptions {
  lastError?: unknown;
  nextAttemptAfter?: string | null;
  now?: string;
  reason?: string | null;
  runId?: string | null;
}

// Normalized shape produced by `normalizeGapStatusMutation`.
interface GapStatusMutation {
  attemptDelta: number;
  gapId: string;
  lastErrorJson: string | null;
  nextAttemptAfter: string | null;
  now: string;
  reason: string | null;
  recoveredRunId: string | null;
  runId: string | null;
  status: string;
}

// Scope for the pending-gap listing query, normalized by
// `normalizePendingGapScope`.
interface PendingGapScope {
  connectorId: string;
  connectorInstanceId: string;
  eligibleAt: string;
  grantId: string | null;
  limit: number;
  streamList: string[] | null;
}

// Scope for the quarantined-terminal-gap requeue, normalized by
// `normalizeQuarantinedRequeueScope`.
interface QuarantinedRequeueScope {
  connectorId: string;
  connectorInstanceId: string;
  limit: number;
  now: string;
  reason: string;
  streams: string[] | null;
}

interface RequeueResult {
  matched: number;
  requeued: number;
}

interface CountByStream {
  count: number;
  stream: string;
}

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import { DEFAULT_QUARANTINE_POLICY } from "../../runtime/recovery-quarantine.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../owner-auth.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";
import { makeDefaultAccountConnectorInstanceId } from "./connector-instance-store.ts";

const VALID_STATUSES = new Set(["pending", "in_progress", "recovered", "terminal"]);
const SECRET_KEY_PATTERN =
  /(authorization|bearer|cookie|token|secret|password|credential|request_body|body|payload|raw|private)/i;
const URL_KEY_PATTERN = /(url|uri|href|endpoint)/i;
const MAX_STRING_LENGTH = 300;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 5;
const PENDING_GAP_ROTATION_WINDOW_SECONDS = 15 * 60;
const PENDING_GAP_MAX_AGE_BUCKETS = 8;
// A row's own `attempt_count` term in the selection rank is clamped at the
// quarantine no-progress threshold. The age bonus is capped at
// `PENDING_GAP_MAX_AGE_BUCKETS`, so without this clamp a row served past the
// threshold keeps climbing `attempt_count` on every re-defer and its rank
// gets strictly worse forever — permanently sinking it behind the rest of
// the backlog. Once starved that way it is never selected again, so it can
// never reach `maybeQuarantineGap` (runtime/recovery-quarantine.ts) either,
// which only evaluates a row when it IS selected and re-defers. Clamping the
// attempt_count term at the SAME threshold quarantine uses means a row can
// never rank worse than a fresh threshold-attempt row: once it ages back to
// the front (the same mechanism that already rescues old rows from a
// fresh-arrival flood), it is selected once more and either recovers or
// crosses the quarantine threshold and terminalizes. This only ever raises
// (never lowers) the effective rank of a row already past its no-progress
// budget — ordering for every row under the threshold is unaffected.
const PENDING_GAP_ATTEMPT_RANK_CLAMP = DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts;
const SAFE_ROUTE_TEMPLATE_KEY_PATTERN = /^(endpoint_route|route_template)$/i;
const SAFE_ROUTE_TEMPLATE_PATTERN = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[A-Za-z0-9._~!$&'()*+,;=:@/%{}-]+$/;

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hashIdentity(parts: unknown): string {
  return `gap_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

/**
 * The stable natural-identity component that distinguishes one detail gap from
 * another WITHIN a `(connector_instance_id, grant_id, stream, parent_stream)`
 * scope.
 *
 * When a `record_key` is present it is the identity — the `detail_locator_json`
 * is deliberately excluded because the locator SHAPE is volatile (connectors
 * add fields like `order_date` over time). Hashing the whole locator into
 * identity meant a locator-schema change minted a NEW identity for the SAME
 * record, orphaning the old-shape pending row so it could never be closed when
 * the record was later recovered under the new shape.
 *
 * When `record_key` is absent the locator text is the only disambiguator, so it
 * is retained. BOTH branches are namespaced with a disjoint prefix (`key:` vs
 * `loc:`) so a record_key whose literal value starts with `loc:` can never
 * collide with a locator-only gap (and vice versa).
 *
 * The value is `NULLIF`-normalized so a NULL/empty `record_key` is never a
 * uniqueness loophole. The DB identity index applies the same branch logic; for
 * locator-only JSON, storage-backend JSON text canonicalization remains the
 * uniqueness authority.
 */
export function detailGapIdentityKey(recordKey: unknown, detailLocatorText: unknown): string {
  const key = nonEmptyString(recordKey);
  if (key) {
    return `key:${key}`;
  }
  return `loc:${detailLocatorText === null || detailLocatorText === undefined ? "" : detailLocatorText}`;
}

function defaultConnectorInstanceId(connectorId: string): string {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

function safeUrlSummary(value: unknown): Record<string, string> | string {
  try {
    const parsed = new URL(value as string);
    return {
      host: parsed.hostname || "",
      path_hash: createHash("sha256")
        .update(parsed.pathname || "/")
        .digest("hex")
        .slice(0, 16),
      // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
      scheme: parsed.protocol.replace(/:$/, ""),
    };
  } catch {
    return "[redacted-url]";
  }
}

function isSafeRouteTemplate(value: unknown, keyName: unknown): boolean {
  return (
    SAFE_ROUTE_TEMPLATE_KEY_PATTERN.test(keyName as string) &&
    SAFE_ROUTE_TEMPLATE_PATTERN.test(value as string) &&
    !(value as string).includes("?") &&
    !(value as string).includes("#") &&
    !(value as string).includes("//")
  );
}

function isSimpleMetadataValue(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "boolean" || typeof value === "number";
}

function sanitizeStringMetadata(value: string, keyName: unknown): unknown {
  if (isSafeRouteTemplate(value, keyName)) {
    return value;
  }
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  if (/^https?:\/\//i.test(value) || URL_KEY_PATTERN.test(keyName as string)) {
    return safeUrlSummary(value);
  }
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH - 1)}…` : value;
}

function sanitizeArrayMetadata(value: unknown[], depth: number, keyName: unknown): unknown[] {
  return value
    .slice(0, MAX_ARRAY_LENGTH)
    .map((entry) => sanitizeDetailGapMetadata(entry, depth + 1, keyName as string));
}

function sanitizeObjectMetadata(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizeDetailGapMetadata(entry, depth + 1, key);
  }
  return out;
}

export function sanitizeDetailGapMetadata(value: unknown, depth = 0, keyName = ""): unknown {
  if (isSimpleMetadataValue(value)) {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeStringMetadata(value, keyName);
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return sanitizeArrayMetadata(value, depth, keyName);
  }
  if (typeof value !== "object") {
    return null;
  }
  return sanitizeObjectMetadata(value as Record<string, unknown>, depth);
}

function encodeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  return JSON.parse(value as string);
}

function deriveGapIdentity(input: UpsertGapInput): {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
} {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const connectorId = nonEmptyString(input?.connectorId);
  const connectorInstanceId =
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    nonEmptyString(input?.connectorInstanceId) || (connectorId ? defaultConnectorInstanceId(connectorId) : null);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const stream = nonEmptyString(input?.stream);
  if (!connectorId) {
    throw new Error("connector detail gap requires connectorId");
  }
  if (!connectorInstanceId) {
    throw new Error("connector detail gap requires connectorInstanceId");
  }
  if (!stream) {
    throw new Error("connector detail gap requires stream");
  }
  return { connectorId, connectorInstanceId, stream };
}

function deriveGapId(
  input: UpsertGapInput,
  connectorInstanceId: string,
  grantId: string | null,
  stream: string,
  parentStream: string | null,
  recordKey: string | null,
  detailLocator: unknown
): string {
  // Identity intentionally EXCLUDES the volatile locator when a record_key is
  // present (see `detailGapIdentityKey`), so a locator-schema change (e.g. a
  // connector adding `order_date`) re-upserts the SAME identity instead of
  // orphaning the old-shape pending row.
  const identityKey = detailGapIdentityKey(recordKey, encodeJson(detailLocator));
  return input.gapId || hashIdentity([connectorInstanceId, grantId || "", stream, parentStream || "", identityKey]);
}

function normalizeGapMetadata(
  input: UpsertGapInput,
  connectorId: string
): {
  source: unknown;
  detailLocator: unknown;
  listCursor: unknown;
  scope: unknown;
  lastError: unknown;
} {
  return {
    detailLocator: sanitizeDetailGapMetadata(input.detailLocator ?? null),
    lastError: sanitizeDetailGapMetadata(input.lastError ?? null),
    listCursor: sanitizeDetailGapMetadata(input.listCursor ?? null),
    scope: sanitizeDetailGapMetadata(input.scope ?? null),
    source: sanitizeDetailGapMetadata(input.source || { id: connectorId, kind: "connector" }),
  };
}

function normalizeGapInput(input: UpsertGapInput): NormalizedGapInput {
  const { connectorId, connectorInstanceId, stream } = deriveGapIdentity(input);
  const metadata = normalizeGapMetadata(input, connectorId);
  const grantId = nonEmptyString(input.grantId);
  const parentStream = nonEmptyString(input.parentStream);
  const recordKey = input.recordKey === null || input.recordKey === undefined ? null : String(input.recordKey);
  const reason = nonEmptyString(input.reason) || null;
  const now = input.now || nowIso();
  const gapId = deriveGapId(
    input,
    connectorInstanceId,
    grantId,
    stream,
    parentStream,
    recordKey,
    metadata.detailLocator
  );

  return {
    connectorId,
    connectorInstanceId,
    detailLocator: metadata.detailLocator,
    discoveredRunId: nonEmptyString(input.discoveredRunId),
    gapId,
    grantId,
    lastError: metadata.lastError,
    lastRunId: nonEmptyString(input.lastRunId) || nonEmptyString(input.discoveredRunId),
    listCursor: metadata.listCursor,
    nextAttemptAfter: nonEmptyString(input.nextAttemptAfter),
    now,
    parentStream,
    reason,
    recordKey,
    scope: metadata.scope,
    source: metadata.source,
    stream,
  };
}

function nullableGapRowValue<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function rowToGap(row: DetailGapRow | null): DetailGap | null {
  if (!row) {
    return null;
  }
  return {
    attempt_count: row.attempt_count,
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    created_at: row.created_at,
    detail_locator: parseJson(row.detail_locator_json),
    discovered_run_id: nullableGapRowValue(row.discovered_run_id),
    gap_id: row.gap_id,
    grant_id: nullableGapRowValue(row.grant_id),
    last_attempt_at: nullableGapRowValue(row.last_attempt_at),
    last_error: parseJson(row.last_error_json),
    last_run_id: nullableGapRowValue(row.last_run_id),
    lease_attempted: Number(row.lease_attempted || 0) === 1,
    lease_expires_at: nullableGapRowValue(row.lease_expires_at),
    lease_id: nullableGapRowValue(row.lease_id),
    lease_run_id: nullableGapRowValue(row.lease_run_id),
    list_cursor: parseJson(row.list_cursor_json),
    next_attempt_after: nullableGapRowValue(row.next_attempt_after),
    parent_stream: nullableGapRowValue(row.parent_stream),
    reason: nullableGapRowValue(row.reason),
    record_key: nullableGapRowValue(row.record_key),
    recovered_run_id: nullableGapRowValue(row.recovered_run_id),
    scope: parseJson(row.scope_json),
    source: parseJson(row.source_json),
    status: row.status,
    stream: row.stream,
    updated_at: row.updated_at,
  };
}

function firstSqliteRow(sql: string, params: readonly (string | number | null)[] = []): DetailGapRow | null {
  for (const row of iterateDynamicSqlAcknowledged<DetailGapRow>(sql, params)) {
    return row;
  }
  return null;
}

/**
 * Coerce a SQL `COUNT(*)` scalar into a finite non-negative integer. SQLite
 * returns it as a JS number; the Postgres `pg` driver returns a `bigint` as a
 * string. A NaN / negative / unparseable value throws so the caller can keep
 * the optional `recovered` rollup `null` (unmeasured) rather than surface a
 * fabricated count.
 */
function coerceCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`connector detail gap count is not a non-negative integer: ${String(value)}`);
  }
  return Math.floor(n);
}

/**
 * Normalize the reason list for a reason-scoped count. Returns a de-duped array
 * of non-empty strings, or `null` when no usable reason is supplied (the caller
 * treats `null` as "no reason scope" and counts every reason).
 */
function normalizeReasonScope(reasons: unknown): string[] | null {
  if (!Array.isArray(reasons)) {
    return null;
  }
  const out = [...new Set(reasons.filter((reason): reason is string => typeof reason === "string" && !!reason))];
  return out.length ? out : null;
}

function normalizeStreamScope(streams: unknown): string[] | null {
  if (!Array.isArray(streams)) {
    return null;
  }
  const out = [...new Set(streams.filter((stream): stream is string => typeof stream === "string" && !!stream))];
  return out.length ? out : null;
}

function normalizeGapMutationLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) {
    return 100;
  }
  return Math.max(1, Math.min(Math.floor(n), 500));
}

function assertValidGapStatus(status: unknown): asserts status is string {
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    throw new Error(`Unsupported connector detail gap status: ${String(status)}`);
  }
}

function optionalSqlPlaceholders(values: readonly unknown[] | null | undefined): string | null {
  return values?.length ? values.map(() => "?").join(", ") : null;
}

// Stay below SQLite's historical 999-variable floor after reserving values
// for eligibility, ordering, and the per-connection limit.
const SQLITE_BATCH_INSTANCE_ID_CHUNK_SIZE = 900;
const SQLITE_BATCH_REASON_CHUNK_SIZE = 98;

function exactConnectorInstanceIds(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map(nonEmptyString).filter((value): value is string => value !== null))];
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}

// One SQLite bind-limited chunk of the `countGapsByStatusByStreamForConnectorInstanceIds`
// aggregate: queries a single chunk of connector-instance ids and merges its
// stream-count rows into the caller-owned accumulator. Carries no lease/CAS
// semantics.
function mergeSqliteGapCountsByStream(
  result: Map<string, Map<string, number>>,
  connectorInstanceIdChunk: readonly string[],
  status: string
): void {
  const placeholders = connectorInstanceIdChunk.map(() => "?").join(", ");
  const rows = iterateDynamicSqlAcknowledged<{ connector_instance_id: string; stream: string; gap_count: number }>(
    `SELECT connector_instance_id, stream, COUNT(*) AS gap_count FROM connector_detail_gaps
     WHERE connector_instance_id IN (${placeholders}) AND status = ?
     GROUP BY connector_instance_id, stream`,
    [...connectorInstanceIdChunk, status]
  );
  for (const row of rows) {
    const counts = result.get(row.connector_instance_id) ?? new Map<string, number>();
    counts.set(row.stream, coerceCount(row.gap_count));
    result.set(row.connector_instance_id, counts);
  }
}

// De-dupes the caller-supplied reason filter and splits it into SQLite
// bind-limited chunks, matching the connector-instance-id chunking above. An
// absent/empty filter still yields one "no reason scope" pass (`[null]`) so
// `mergeSqliteGapCountsByStatus` always has exactly one iteration to run per
// instance-id chunk.
function chunkedReasonScope(reasons: readonly string[] | null | undefined): (readonly string[] | null)[] {
  const reasonValues = [...new Set((reasons ?? []).filter((reason): reason is string => typeof reason === "string"))];
  return reasonValues.length ? chunked(reasonValues, SQLITE_BATCH_REASON_CHUNK_SIZE) : [null];
}

// One SQLite bind-limited (instance-id chunk × reason chunk) cell of the
// `countGapsByStatusForConnectorInstanceIds` aggregate: queries a single
// chunk pair and sums its counts into the caller-owned accumulator. Carries
// no lease/CAS semantics.
function mergeSqliteGapCountsByStatus(
  result: Map<string, number>,
  connectorInstanceIdChunk: readonly string[],
  status: string,
  reasonChunk: readonly string[] | null
): void {
  const placeholders = connectorInstanceIdChunk.map(() => "?").join(", ");
  const reasonPlaceholders = optionalSqlPlaceholders(reasonChunk);
  const rows = iterateDynamicSqlAcknowledged<{ connector_instance_id: string; gap_count: number }>(
    `SELECT connector_instance_id, COUNT(*) AS gap_count FROM connector_detail_gaps
     WHERE connector_instance_id IN (${placeholders}) AND status = ?
     ${reasonPlaceholders ? `AND reason IN (${reasonPlaceholders})` : ""}
     GROUP BY connector_instance_id`,
    [...connectorInstanceIdChunk, status, ...(reasonChunk ?? [])]
  );
  for (const row of rows) {
    result.set(row.connector_instance_id, (result.get(row.connector_instance_id) ?? 0) + coerceCount(row.gap_count));
  }
}

// One SQLite bind-limited instance-id chunk of the
// `countGapsByStatusForConnectorInstanceIds` aggregate: runs every reason
// chunk against this single instance-id chunk. Carries no lease/CAS
// semantics.
function mergeSqliteGapCountsForInstanceIdChunk(
  result: Map<string, number>,
  connectorInstanceIdChunk: readonly string[],
  status: string,
  reasonChunks: readonly (readonly string[] | null)[]
): void {
  for (const reasonChunk of reasonChunks) {
    mergeSqliteGapCountsByStatus(result, connectorInstanceIdChunk, status, reasonChunk);
  }
}

// One SQLite bind-limited chunk of the
// `listPendingGapsByConnectorInstanceIds` per-instance top-N selection:
// queries a single chunk of connector-instance ids (using the SAME
// `pendingGapOrderBySql` rotation-with-age ranking every other pending-gap
// read uses) and groups its rows into the caller-owned per-instance
// accumulator. Carries no lease/CAS semantics.
function mergeSqlitePendingGapsByConnectorInstanceId(
  result: Map<string, DetailGap[]>,
  connectorInstanceIdChunk: readonly string[],
  eligibleAt: string,
  bounded: number
): void {
  const placeholders = connectorInstanceIdChunk.map(() => "?").join(", ");
  const rows = [
    ...iterateDynamicSqlAcknowledged<DetailGapRow>(
      `WITH ranked AS (
       SELECT connector_detail_gaps.*, ROW_NUMBER() OVER (
         PARTITION BY connector_instance_id
         ORDER BY ${pendingGapOrderBySql(false)}
       ) AS row_number
       FROM connector_detail_gaps
       WHERE connector_instance_id IN (${placeholders})
         AND status = 'pending'
         AND (next_attempt_after IS NULL OR next_attempt_after <= ?)
     ) SELECT * FROM ranked WHERE row_number <= ? ORDER BY connector_instance_id, row_number`,
      [eligibleAt, ...connectorInstanceIdChunk, eligibleAt, bounded]
    ),
  ];
  mergeGapRowsByConnectorInstanceId(result, rows);
}

// Result of the page-scoped terminal-gap read. `gapsByConnectorInstanceId`
// carries only instances whose terminal gaps were read IN FULL;
// `truncatedConnectorInstanceIds` names the instances whose row count exceeded
// the per-instance cap, and those instances appear in neither map — they are
// unmeasured, not empty. Keeping the two apart at the store boundary is what
// stops a caller from mistaking "no rows returned" for "no terminal gaps".
export interface TerminalGapPageRead {
  readonly gapsByConnectorInstanceId: ReadonlyMap<string, readonly DetailGap[]>;
  readonly truncatedConnectorInstanceIds: ReadonlySet<string>;
}

// Per-instance row cap for `listTerminalGapsByConnectorInstanceIds`. The
// single-connection read (`listTerminalGapsForConnector`) caps at 500; a page
// read fans that out across every connection on the page, so the per-instance
// cap is deliberately smaller. It is a *detection* bound, not a silent
// truncation: the query selects one row PAST the cap so the caller can tell
// "this instance had at most `cap` terminal gaps and you have all of them"
// apart from "there were more and you are holding a partial set". Fleet-wide
// terminal-gap volume is order-10s per connection, so a real page never
// reaches this.
const TERMINAL_GAP_PAGE_ROWS_PER_INSTANCE = 200;

// Clamp a caller-supplied per-instance cap into [1, TERMINAL_GAP_PAGE_ROWS_PER_INSTANCE].
// The ceiling is the store's, not the caller's: a page read must never be
// talked into an unbounded scan. Tests lower it to exercise truncation.
function normalizeTerminalGapRowsPerInstance(rowsPerInstance: unknown): number {
  const n = Number(rowsPerInstance);
  if (!Number.isFinite(n)) {
    return TERMINAL_GAP_PAGE_ROWS_PER_INSTANCE;
  }
  return Math.max(1, Math.min(Math.floor(n), TERMINAL_GAP_PAGE_ROWS_PER_INSTANCE));
}

// Splits an over-cap instance's rows out of a per-instance accumulator.
// Selecting `cap + 1` rows per instance means an instance that comes back with
// MORE than `cap` rows is provably truncated: we return its identity in
// `truncatedConnectorInstanceIds` and drop its rows entirely rather than hand
// the caller a partial set. A partial terminal-gap set cannot support an
// "every gap in this stream is proven unfillable" verdict — the unproven row
// could be exactly the one past the cap — so "unmeasured" is the only honest
// answer. Trimming to `cap` and staying silent would be the false-green this
// whole read path exists to refuse.
function partitionTruncatedTerminalGaps(gapsByInstanceId: Map<string, DetailGap[]>, cap: number): Set<string> {
  const truncated = new Set<string>();
  for (const [connectorInstanceId, gaps] of gapsByInstanceId) {
    if (gaps.length > cap) {
      truncated.add(connectorInstanceId);
      gapsByInstanceId.delete(connectorInstanceId);
    }
  }
  return truncated;
}

// One SQLite bind-limited chunk of the
// `listTerminalGapsByConnectorInstanceIds` per-instance selection: queries a
// single chunk of connector-instance ids, taking `cap + 1` rows per instance
// so the caller can detect truncation (see
// `partitionTruncatedTerminalGaps`). Ordered by `stream, gap_id` to match the
// single-connection `listTerminalGapsForConnector` read, so the two paths see
// the same rows in the same order for the same data. Carries no lease/CAS
// semantics — read-only.
function mergeSqliteTerminalGapsByConnectorInstanceId(
  result: Map<string, DetailGap[]>,
  connectorInstanceIdChunk: readonly string[],
  perInstanceRowBudget: number
): void {
  const placeholders = connectorInstanceIdChunk.map(() => "?").join(", ");
  // REVIEWED-DYNAMIC: bounded status='terminal' read over the store-owned
  // detail-gap table, scoped to an explicit connector-instance-id set. Feeds
  // the unfillable-proof classifier only — read-only.
  const rows = [
    ...iterateDynamicSqlAcknowledged<DetailGapRow>(
      `WITH ranked AS (
       SELECT connector_detail_gaps.*, ROW_NUMBER() OVER (
         PARTITION BY connector_instance_id
         ORDER BY stream, gap_id
       ) AS row_number
       FROM connector_detail_gaps
       WHERE connector_instance_id IN (${placeholders})
         AND status = 'terminal'
     ) SELECT * FROM ranked WHERE row_number <= ? ORDER BY connector_instance_id, row_number`,
      [...connectorInstanceIdChunk, perInstanceRowBudget]
    ),
  ];
  mergeGapRowsByConnectorInstanceId(result, rows);
}

// Groups a batch of already-ranked/limited detail-gap rows by their durable
// connector-instance identity, merging into a caller-owned accumulator.
// Shared by both backends' `listPendingGapsByConnectorInstanceIds`: the
// SQLite path calls this once per bind-limited chunk, the Postgres path
// (which has no bind limit) calls it once for the whole row set via
// `groupGapRowsByConnectorInstanceId` below. Carries no lease/CAS semantics —
// pure row-shape regrouping after the ordering/limit decision has already
// been made by the SQL query.
function mergeGapRowsByConnectorInstanceId(result: Map<string, DetailGap[]>, rows: readonly DetailGapRow[]): void {
  for (const row of rows) {
    const gap = rowToGap(row) as DetailGap;
    const gaps = result.get(gap.connector_instance_id) ?? [];
    gaps.push(gap);
    result.set(gap.connector_instance_id, gaps);
  }
}

function groupGapRowsByConnectorInstanceId(rows: readonly DetailGapRow[]): Map<string, DetailGap[]> {
  const result = new Map<string, DetailGap[]>();
  mergeGapRowsByConnectorInstanceId(result, rows);
  return result;
}

// `NULLIF(last_attempt_at, '')` normalizes an empty-string last_attempt_at to
// NULL before the COALESCE fallback to created_at, on BOTH engines. Not
// reachable today (last_attempt_at is only ever NULL or a non-empty ISO
// string — see the `options.now || nowIso()` writes in markGapStatus), but an
// engine-specific empty-string special-case would otherwise be a silent trap:
// SQLite's bare COALESCE treats '' as a real (non-NULL) value and ages from
// epoch 1970, while Postgres's NULLIF'd COALESCE falls back to created_at.
function pendingGapOrderBySql(isPostgres: boolean): string {
  if (isPostgres) {
    return `
        (
          LEAST(attempt_count, ${PENDING_GAP_ATTEMPT_RANK_CLAMP}) - LEAST(
            ${PENDING_GAP_MAX_AGE_BUCKETS},
            COALESCE(
              FLOOR(EXTRACT(EPOCH FROM ($4::timestamptz - COALESCE(NULLIF(last_attempt_at, ''), created_at)::timestamptz)) / ${PENDING_GAP_ROTATION_WINDOW_SECONDS}),
              0
            )
          )
        ),
        COALESCE(NULLIF(last_attempt_at, ''), created_at),
        gap_id
      `;
  }
  return `
        (
          MIN(attempt_count, ${PENDING_GAP_ATTEMPT_RANK_CLAMP}) - MIN(
            ${PENDING_GAP_MAX_AGE_BUCKETS},
            COALESCE(
              CAST((unixepoch(?) - unixepoch(COALESCE(NULLIF(last_attempt_at, ''), created_at))) / ${PENDING_GAP_ROTATION_WINDOW_SECONDS} AS INTEGER),
              0
            )
          )
        ),
        COALESCE(NULLIF(last_attempt_at, ''), created_at),
        gap_id
      `;
}

function normalizePendingGapScope(
  rawInput: { connectorInstanceId?: string | null } | undefined,
  connectorId: string,
  grantId: string | null,
  streams: unknown,
  limit: number,
  now: unknown
): PendingGapScope {
  const connectorInstanceId = nonEmptyString(rawInput?.connectorInstanceId) || defaultConnectorInstanceId(connectorId);
  const eligibleAt = nonEmptyString(now) || nowIso();
  const streamList = Array.isArray(streams)
    ? streams.filter((stream): stream is string => typeof stream === "string" && !!stream)
    : null;
  return {
    connectorId,
    connectorInstanceId,
    eligibleAt,
    grantId,
    limit: Math.max(1, Math.min(limit, 500)),
    streamList,
  };
}

function normalizeGapStatusMutation(gapId: string, status: string, options: MarkGapStatusOptions): GapStatusMutation {
  assertValidGapStatus(status);
  const now = options.now || nowIso();
  const attemptDelta = status === "in_progress" ? 1 : 0;
  const recoveredRunId = status === "recovered" ? nonEmptyString(options.runId) : null;
  const reason = nonEmptyString(options.reason);
  return {
    attemptDelta,
    gapId,
    lastErrorJson: encodeJson(sanitizeDetailGapMetadata(options.lastError ?? null)),
    nextAttemptAfter: nonEmptyString(options.nextAttemptAfter),
    now,
    reason,
    recoveredRunId,
    runId: nonEmptyString(options.runId),
    status,
  };
}

interface DetailGapLease {
  gapId: string;
  leaseId: string;
  runId: string;
}

function normalizeLease(
  lease: { gapId?: unknown; leaseId?: unknown; runId?: unknown } | null | undefined
): DetailGapLease {
  const gapId = nonEmptyString(lease?.gapId);
  const runId = nonEmptyString(lease?.runId);
  const leaseId = nonEmptyString(lease?.leaseId);
  if (!(gapId && runId && leaseId)) {
    throw new Error("detail-gap lease requires gapId, runId, and leaseId");
  }
  return { gapId, leaseId, runId };
}

/**
 * Terminal `reason` values this repair tool is allowed to reopen, and why.
 *
 * Every value here means "the terminal state can plausibly have been caused
 * by a connector/runtime defect that has since been fixed" — retrying is a
 * legitimate re-measurement, not wishful thinking:
 *   - `quarantined`   — a per-item no-progress budget was exhausted without
 *     ever recording a reason (the original defect this tool was built for).
 *   - `temporary_unavailable` — the row's own class name says "this may
 *     resolve"; it was terminalized only because it exhausted a bounded
 *     attempt budget while looking transient, not because of any proof of
 *     permanence.
 *   - `retry_exhausted` / `run_cap_deferred` — same shape: a bounded budget
 *     ran out on a signal that was never non-transient.
 *
 * Deliberately EXCLUDED — durable-impossibility reasons a bulk reopen must
 * never touch:
 *   - `not_found` / `gone` / `permanent_forbidden` — `classifyRecoveryError`
 *     (server/stores/terminal-gap-classifier.ts) only assigns these from an
 *     explicit non-transient HTTP signal (404/410/permanent-403). Reopening
 *     a proven-gone resource just re-wastes the recovery budget confirming
 *     it is still gone.
 *   - `too_large` — Gmail's `AttachmentTooLargeError` terminal class. A
 *     `too_large` row can carry durable per-item proof (observed byte size
 *     recorded strictly greater than the configured cap — see
 *     `isProvenUnfillableGap` in `server/connector-gap-classification.ts`):
 *     requeuing a 29 MB attachment against a 25 MB cap can never converge,
 *     it would just spin the recovery budget forever. This generic bulk
 *     path has no way to check that per-row proof safely, so the reason is
 *     refused categorically rather than requeued speculatively. (A prior,
 *     narrowly-scoped one-off bridge — `too_large` + unproven rows only,
 *     Gmail/attachments-locked — existed for exactly this distinction; see
 *     commit 10ed92599. That per-row-proof check does not exist on this
 *     branch, so this tool does not attempt to replicate it.)
 *   - `auth_failure` — requires owner re-authentication, not a data retry;
 *     silently requeuing it would not fix anything and would mask that the
 *     owner still needs to act.
 *   - `not_available_in_mode` / `out_of_scope` / `user_disabled` —
 *     informational, by-design terminal states, not failures to retry.
 */
export const TERMINAL_REQUEUE_REASON_ALLOWLIST: ReadonlySet<string> = new Set([
  "quarantined",
  "retry_exhausted",
  "run_cap_deferred",
  "temporary_unavailable",
]);

/** Durable-impossibility reasons called out by name in refusal errors, so an operator sees WHY, not just a generic rejection. */
const TERMINAL_REQUEUE_REASON_IMPOSSIBILITY_NOTE: ReadonlyMap<string, string> = new Map([
  ["too_large", "carries a durable size-vs-cap proof and can never converge on retry"],
  ["not_found", "is a proven-gone resource (404); retrying only re-confirms it is gone"],
  ["gone", "is a proven-gone resource (410); retrying only re-confirms it is gone"],
  ["permanent_forbidden", "is a proven-permanent access denial; retrying cannot change that"],
  ["auth_failure", "requires owner re-authentication, not a data retry"],
]);

function assertRequeueableReason(reason: string): void {
  if (TERMINAL_REQUEUE_REASON_ALLOWLIST.has(reason)) {
    return;
  }
  const note = TERMINAL_REQUEUE_REASON_IMPOSSIBILITY_NOTE.get(reason);
  throw new Error(
    note
      ? `refusing to requeue terminal reason '${reason}': ${note}`
      : `refusing to requeue terminal reason '${reason}': not in the allowed set (${[
          ...TERMINAL_REQUEUE_REASON_ALLOWLIST,
        ].join(", ")})`
  );
}

function requeueReasonForQuarantinedGap(gap: DetailGap): string {
  const lastError =
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    gap?.last_error && typeof gap.last_error === "object" ? (gap.last_error as Record<string, unknown>) : null;
  const previousReason = nonEmptyString(lastError?.reason);
  if (
    previousReason === "retry_exhausted" ||
    previousReason === "temporary_unavailable" ||
    previousReason === "run_cap_deferred"
  ) {
    return previousReason;
  }
  return "temporary_unavailable";
}

/**
 * The reason to stamp on a row being requeued out of terminal. `quarantined`
 * rows get the special unwrap ({@link requeueReasonForQuarantinedGap}): the
 * quarantine path always stamps `reason = 'quarantined'` regardless of what
 * looked transient beforehand, so the row's OWN `last_error.reason` is the
 * only place the pre-quarantine class survives. Every other allowed terminal
 * reason (`temporary_unavailable`, `retry_exhausted`, `run_cap_deferred`) IS
 * already its own honest class — a bounded-budget exhaustion on a signal
 * that was never proven non-transient — so requeuing simply keeps it.
 */
function requeueReasonForGap(gap: DetailGap, scopeReason: string): string {
  return scopeReason === "quarantined" ? requeueReasonForQuarantinedGap(gap) : scopeReason;
}

/**
 * Audit trail written into the requeued row's `last_error`, so the operator
 * repair is visible in the row's own history rather than silently
 * overwriting the evidence that got it terminalized. `class` names the
 * scope's own reason so a `temporary_unavailable` requeue reads honestly
 * (not as a borrowed "quarantine" label) — `retry_requested` for every
 * allowed reason, `quarantine_retry_requested` kept as the exact prior
 * string when the scope reason is `quarantined` so historical row shapes
 * and any consumer keyed on that literal are unaffected.
 */
function buildQuarantineRetryLastError(gap: DetailGap, now: string, scopeReason: string): unknown {
  const prior =
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    gap?.last_error && typeof gap.last_error === "object" ? (gap.last_error as Record<string, unknown>) : {};
  return sanitizeDetailGapMetadata({
    class: scopeReason === "quarantined" ? "quarantine_retry_requested" : `${scopeReason}_retry_requested`,
    previous_class: typeof prior.class === "string" ? prior.class : null,
    previous_failure_class: typeof prior.failure_class === "string" ? prior.failure_class : null,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    previous_reason: gap?.reason ?? null,
    requeued_at: now,
  });
}

function normalizeQuarantinedRequeueScope(
  connectorId: unknown,
  connectorInstanceId: unknown,
  options: { limit?: unknown; now?: unknown; reason?: unknown; streams?: unknown } = {}
): QuarantinedRequeueScope {
  const cid = nonEmptyString(connectorId);
  if (!cid) {
    throw new Error("requeueQuarantinedTerminalGapsForConnectorInstance requires connectorId");
  }
  const reason = nonEmptyString(options.reason) || "quarantined";
  assertRequeueableReason(reason);
  return {
    connectorId: cid,
    connectorInstanceId: nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(cid),
    limit: normalizeGapMutationLimit(options.limit),
    now: nonEmptyString(options.now) || nowIso(),
    reason,
    streams: normalizeStreamScope(options.streams),
  };
}

function sqliteQuarantinedRequeueRows(scope: QuarantinedRequeueScope): DetailGap[] {
  const streamPlaceholders = optionalSqlPlaceholders(scope.streams);
  // REVIEWED-DYNAMIC: bounded repair selection for terminal detail gaps
  // whose reason is on the operator-requeueable allowlist (asserted by
  // `normalizeQuarantinedRequeueScope` before this ever runs — `too_large`,
  // `not_found`, `gone`, `permanent_forbidden`, and `auth_failure` can never
  // reach this query). Only non-payload row metadata is read and the caller
  // must scope by one connector instance; terminal rows are never
  // blanket-reset across reasons or instances.
  return [
    ...iterateDynamicSqlAcknowledged<DetailGapRow>(
      `
    SELECT * FROM connector_detail_gaps
    WHERE connector_id = ?
      AND connector_instance_id = ?
      AND status = 'terminal'
      AND reason = ?
      ${streamPlaceholders ? `AND stream IN (${streamPlaceholders})` : ""}
    ORDER BY updated_at, created_at
    LIMIT ?
  `,
      [scope.connectorId, scope.connectorInstanceId, scope.reason, ...(scope.streams ?? []), scope.limit]
    ),
  ].map((row) => rowToGap(row) as DetailGap);
}

function requeueSqliteQuarantinedRows(rows: DetailGap[], scope: QuarantinedRequeueScope): RequeueResult {
  let requeued = 0;
  for (const gap of rows) {
    // REVIEWED-DYNAMIC: scoped status reset for operator-approved retry of
    // an allowlisted terminal reason after a connector/runtime fix. The
    // WHERE clause re-checks `reason = scope.reason` (not just `status =
    // 'terminal'`) so a row that changed reason between the read and this
    // write is never silently requeued under the wrong class.
    const result = execDynamicSqlAcknowledged(
      `
      UPDATE connector_detail_gaps
      SET status = 'pending',
          reason = ?,
          attempt_count = 0,
          last_attempt_at = NULL,
          next_attempt_after = NULL,
          last_error_json = ?,
          updated_at = ?
      WHERE gap_id = ?
        AND connector_id = ?
        AND connector_instance_id = ?
        AND status = 'terminal'
        AND reason = ?
    `,
      [
        requeueReasonForGap(gap, scope.reason),
        encodeJson(buildQuarantineRetryLastError(gap, scope.now, scope.reason)),
        scope.now,
        gap.gap_id,
        scope.connectorId,
        scope.connectorInstanceId,
        scope.reason,
      ]
    );
    requeued += Number(result.changes || 0);
  }
  return { matched: rows.length, requeued };
}

async function postgresQuarantinedRequeueRows(scope: QuarantinedRequeueScope): Promise<DetailGap[]> {
  const result = await postgresQuery(
    `
    SELECT * FROM connector_detail_gaps
    WHERE connector_id = $1
      AND connector_instance_id = $2
      AND status = 'terminal'
      AND reason = $3
      AND ($4::text[] IS NULL OR stream = ANY($4::text[]))
    ORDER BY updated_at, created_at
    LIMIT $5
  `,
    [scope.connectorId, scope.connectorInstanceId, scope.reason, scope.streams, scope.limit]
  );
  return (result.rows as DetailGapRow[]).map((row) => rowToGap(row) as DetailGap);
}

async function requeuePostgresQuarantinedRows(
  rows: DetailGap[],
  scope: QuarantinedRequeueScope
): Promise<RequeueResult> {
  let requeued = 0;
  for (const gap of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const updated = await postgresQuery(
      `
      UPDATE connector_detail_gaps
      SET status = 'pending',
          reason = $1,
          attempt_count = 0,
          last_attempt_at = NULL,
          next_attempt_after = NULL,
          last_error_json = $2::jsonb,
          updated_at = $3
      WHERE gap_id = $4
        AND connector_id = $5
        AND connector_instance_id = $6
        AND status = 'terminal'
        AND reason = $7
    `,
      [
        requeueReasonForGap(gap, scope.reason),
        encodeJson(buildQuarantineRetryLastError(gap, scope.now, scope.reason)),
        scope.now,
        gap.gap_id,
        scope.connectorId,
        scope.connectorInstanceId,
        scope.reason,
      ]
    );
    requeued += Number(updated.rowCount || 0);
  }
  return { matched: rows.length, requeued };
}

export function createSqliteConnectorDetailGapStore() {
  return {
    // Leasing is not an attempt. Every claimed gap moves pending → in_progress
    // under a run-owned lease id via a CAS UPDATE, so a stale/concurrent claim
    // can never take a row another run already owns.
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async claimPendingGaps(
      gapIds: readonly (string | null | undefined)[],
      {
        runId,
        leaseId,
        leaseExpiresAt,
      }: {
        leaseExpiresAt?: string | null;
        leaseId?: string | null;
        runId?: string | null;
      } = {}
    ): Promise<string[]> {
      const owner = normalizeLease({ gapId: "claim-owner", leaseId, runId });
      const expiresAt = nonEmptyString(leaseExpiresAt);
      if (!expiresAt) {
        throw new Error("detail-gap lease requires leaseExpiresAt");
      }
      const claimedGapIds: string[] = [];
      for (const gapId of gapIds || []) {
        const id = nonEmptyString(gapId);
        if (!id) {
          continue;
        }
        const result = execDynamicSqlAcknowledged(
          `
          UPDATE connector_detail_gaps
          SET status = 'in_progress', lease_run_id = ?, lease_id = ?, lease_attempted = 0,
              lease_expires_at = ?, updated_at = ?
          WHERE gap_id = ? AND status = 'pending'
        `,
          [owner.runId, owner.leaseId, expiresAt, nowIso(), id]
        );
        if (Number(result.changes || 0) === 1) {
          claimedGapIds.push(id);
        }
      }
      return claimedGapIds;
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async countGapsByStatusByStreamForConnector(
      connectorId: string,
      {
        status,
        connectorInstanceId = null,
      }: {
        status: string;
        connectorInstanceId?: string | null;
      }
    ): Promise<CountByStream[]> {
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Unsupported connector detail gap status: ${status}`);
      }
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      // REVIEWED-DYNAMIC: bounded grouped count-by-status aggregate over the
      // store-owned detail-gap table; only stream names and counts are returned.
      const rows = [
        ...iterateDynamicSqlAcknowledged<{ stream: string; gap_count: number }>(
          `
        SELECT stream, COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = ?
          AND (? IS NULL OR connector_instance_id = ?)
        GROUP BY stream
        ORDER BY stream
      `,
          [connectorId, status, scopedConnectorInstanceId, scopedConnectorInstanceId]
        ),
      ];
      return rows.map((row) => ({ count: coerceCount(row.gap_count ?? 0), stream: row.stream }));
    },

    countGapsByStatusByStreamForConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { status }: { status: string }
    ): Promise<Map<string, Map<string, number>>> {
      assertValidGapStatus(status);
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return Promise.resolve(new Map());
      }
      const result = new Map<string, Map<string, number>>();
      for (const chunk of chunked(ids, SQLITE_BATCH_INSTANCE_ID_CHUNK_SIZE)) {
        mergeSqliteGapCountsByStream(result, chunk, status);
      }
      return Promise.resolve(result);
    },

    // Exact reason-scoped count-by-status across every connector instance for a
    // connector type. The operator-console source-pressure backlog rollup uses
    // this for its optional `recovered` count: a single bounded aggregate that
    // returns only a scalar integer (no row bodies, locators, or payloads), in
    // the same connector-wide + reason scope the `pending` projection reads.
    // Throws on a malformed count so the caller can keep `recovered` `null`.
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async countGapsByStatusForConnector(
      connectorId: string,
      {
        status,
        reasons = null,
        connectorInstanceId = null,
      }: {
        status: string;
        reasons?: string[] | null;
        connectorInstanceId?: string | null;
      }
    ): Promise<number> {
      assertValidGapStatus(status);
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      const reasonScope = normalizeReasonScope(reasons);
      const reasonPlaceholders = optionalSqlPlaceholders(reasonScope);
      // REVIEWED-DYNAMIC: bounded reason-scoped count-by-status aggregate over
      // the store-owned detail-gap table; only a scalar count is returned.
      const row = firstSqliteRow(
        `
        SELECT COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = ?
          AND (? IS NULL OR connector_instance_id = ?)
          ${reasonScope ? `AND reason IN (${reasonPlaceholders})` : ""}
      `,
        [connectorId, status, scopedConnectorInstanceId, scopedConnectorInstanceId, ...(reasonScope ?? [])]
      );
      return coerceCount((row as unknown as { gap_count?: number } | null)?.gap_count ?? 0);
    },

    countGapsByStatusForConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { reasons = null, status }: { reasons?: readonly string[] | null; status: string }
    ): Promise<Map<string, number>> {
      assertValidGapStatus(status);
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return Promise.resolve(new Map());
      }
      const result = new Map<string, number>();
      // 900 instance ids + status + at most 98 reason values stays at the
      // historical SQLite 999-bind floor. Summing disjoint reason chunks
      // preserves the count for an arbitrarily long caller-supplied filter.
      const reasonChunks = chunkedReasonScope(reasons);
      for (const chunk of chunked(ids, SQLITE_BATCH_INSTANCE_ID_CHUNK_SIZE)) {
        mergeSqliteGapCountsForInstanceIdChunk(result, chunk, status, reasonChunks);
      }
      return Promise.resolve(result);
    },

    // Single-row read by gap id, or null if absent. Used by the §10-A terminal
    // classifier to read attempt_count BEFORE deciding to terminalize — a
    // read-then-decide pattern that avoids a write-then-rollback window where a
    // concurrent reader (or a crash between writes) could observe a gap as
    // terminal that should still be pending.
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async getGapById(gapId: string): Promise<DetailGap | null> {
      const id = nonEmptyString(gapId);
      if (!id) {
        return null;
      }
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned detail-gap table.
      return rowToGap(firstSqliteRow("SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1", [id]));
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async listPendingGaps(
      options: {
        connectorId: string;
        grantId?: string | null;
        streams?: string[] | null;
        limit?: number;
        now?: string;
        connectorInstanceId?: string | null;
      } = { connectorId: "" }
    ): Promise<DetailGap[]> {
      const { connectorId, grantId = null, streams = null, limit = 100, now = nowIso() } = options;
      const scope = normalizePendingGapScope(options, connectorId, grantId, streams, limit, now);
      const streamPlaceholders = optionalSqlPlaceholders(scope.streamList);
      // REVIEWED-DYNAMIC: bounded pending-gap recovery selection over the
      // store-owned table. The order rotates with age: newer zero-attempt
      // work stays near the front, but older eligible rows gain priority over
      // time so a steady stream of fresh work cannot starve already-waiting
      // gaps. `next_attempt_after` still gates eligibility before the order
      // applies.
      const rows = [
        ...iterateDynamicSqlAcknowledged<DetailGapRow>(
          `
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = ?
          AND connector_id = ?
          AND (? IS NULL OR grant_id = ?)
          AND status = 'pending'
          AND (next_attempt_after IS NULL OR next_attempt_after <= ?)
          ${streamPlaceholders ? `AND stream IN (${streamPlaceholders})` : ""}
        ORDER BY ${pendingGapOrderBySql(false)}
        LIMIT ?
      `,
          [
            scope.connectorInstanceId,
            scope.connectorId,
            scope.grantId,
            scope.grantId,
            scope.eligibleAt,
            ...(scope.streamList ?? []),
            scope.eligibleAt,
            scope.limit,
          ]
        ),
      ];
      return rows.map((row) => rowToGap(row) as DetailGap);
    },

    // Page-scoped summary evidence. Each map is keyed only by the durable
    // connection identity; callers must not fall back to connector_id.
    listPendingGapsByConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { limit = 100, now = nowIso() }: { limit?: number; now?: string } = {}
    ): Promise<Map<string, DetailGap[]>> {
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return Promise.resolve(new Map());
      }
      const bounded = Math.max(1, Math.min(limit, 500));
      const eligibleAt = nonEmptyString(now) || nowIso();
      const result = new Map<string, DetailGap[]>();
      for (const chunk of chunked(ids, SQLITE_BATCH_INSTANCE_ID_CHUNK_SIZE)) {
        mergeSqlitePendingGapsByConnectorInstanceId(result, chunk, eligibleAt, bounded);
      }
      return Promise.resolve(result);
    },

    // Diagnostic listing across all connector instances for a connector type.
    // Used by the operator-console projection so per-source-instance gaps
    // (e.g. one device per local Codex install) are not silently dropped
    // when the projection has no single instance to filter by.
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async listPendingGapsForConnector(
      connectorId: string,
      { limit = 100 }: { limit?: number } = {}
    ): Promise<DetailGap[]> {
      // REVIEWED-DYNAMIC: bounded diagnostics scan of pending gaps for one connector type.
      const rows = [
        ...iterateDynamicSqlAcknowledged<DetailGapRow>(
          `
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = 'pending'
        ORDER BY created_at
        LIMIT ?
      `,
          [connectorId, Math.max(1, Math.min(limit, 500))]
        ),
      ];
      return rows.map((row) => rowToGap(row) as DetailGap);
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async listPendingGapsForConnectorInstance(
      connectorId: string,
      connectorInstanceId: string,
      { limit = 100 }: { limit?: number } = {}
    ): Promise<DetailGap[]> {
      // REVIEWED-DYNAMIC: bounded diagnostics scan of pending gaps for one connection.
      const rows = [
        ...iterateDynamicSqlAcknowledged<DetailGapRow>(
          `
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = ?
          AND connector_instance_id = ?
          AND status = 'pending'
        ORDER BY created_at
        LIMIT ?
      `,
          [connectorId, connectorInstanceId, Math.max(1, Math.min(limit, 500))]
        ),
      ];
      return rows.map((row) => rowToGap(row) as DetailGap);
    },

    // Page-scoped batch analogue of `listTerminalGapsForConnector`, keyed only
    // by durable connection identity (never connector_id). See
    // `TERMINAL_GAP_PAGE_ROWS_PER_INSTANCE` / `partitionTruncatedTerminalGaps`
    // for the truncation contract: an instance whose terminal gaps exceed the
    // per-instance cap is reported in `truncatedConnectorInstanceIds` with NO
    // rows, so the caller reads it as unmeasured instead of deciding a
    // proof verdict from a partial set.
    listTerminalGapsByConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { rowsPerInstance = TERMINAL_GAP_PAGE_ROWS_PER_INSTANCE }: { rowsPerInstance?: number } = {}
    ): Promise<TerminalGapPageRead> {
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return Promise.resolve({ gapsByConnectorInstanceId: new Map(), truncatedConnectorInstanceIds: new Set() });
      }
      const cap = normalizeTerminalGapRowsPerInstance(rowsPerInstance);
      const gapsByConnectorInstanceId = new Map<string, DetailGap[]>();
      for (const chunk of chunked(ids, SQLITE_BATCH_INSTANCE_ID_CHUNK_SIZE)) {
        mergeSqliteTerminalGapsByConnectorInstanceId(gapsByConnectorInstanceId, chunk, cap + 1);
      }
      return Promise.resolve({
        gapsByConnectorInstanceId,
        truncatedConnectorInstanceIds: partitionTruncatedTerminalGaps(gapsByConnectorInstanceId, cap),
      });
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async listTerminalGapsForConnector(
      connectorId: string,
      options: { connectorInstanceId?: string | null; limit?: number } = {}
    ): Promise<DetailGap[]> {
      const scopedConnectorInstanceId = nonEmptyString(options.connectorInstanceId);
      const limit = Math.max(1, Math.min(Math.floor(Number(options.limit) || 500), 1000));
      // REVIEWED-DYNAMIC: bounded status='terminal' read over the store-owned
      // detail-gap table, scoped to one connector (and optionally one
      // instance). Feeds the unfillable-proof classifier only — no
      // lease/CAS semantics, read-only.
      const rows = [
        ...iterateDynamicSqlAcknowledged<DetailGapRow>(
          `
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = ?
          AND status = 'terminal'
          AND (? IS NULL OR connector_instance_id = ?)
        ORDER BY stream, gap_id
        LIMIT ?
      `,
          [connectorId, scopedConnectorInstanceId, scopedConnectorInstanceId, limit]
        ),
      ];
      return rows.map((row) => rowToGap(row) as DetailGap);
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async markGapStatus(gapId: string, status: string, options: MarkGapStatusOptions = {}): Promise<DetailGap | null> {
      const mutation = normalizeGapStatusMutation(gapId, status, options);
      // `reason` is COALESCE-updated: only overwritten when the caller supplies
      // one (e.g. the quarantine path stamps `reason = 'quarantined'` so the
      // durable class the recovery-decision classifier reads matches the
      // terminal transition). Absent → the existing reason is preserved.
      // REVIEWED-DYNAMIC: status mutation for the store-owned detail-gap table.
      execDynamicSqlAcknowledged(
        `
        UPDATE connector_detail_gaps
        SET status = ?,
            reason = COALESCE(?, reason),
            attempt_count = attempt_count + ?,
            last_attempt_at = CASE WHEN ? = 1 THEN ? ELSE last_attempt_at END,
            next_attempt_after = ?,
            last_error_json = ?,
            last_run_id = COALESCE(?, last_run_id),
            recovered_run_id = COALESCE(?, recovered_run_id),
            updated_at = ?
        WHERE gap_id = ?
      `,
        [
          mutation.status,
          mutation.reason,
          mutation.attemptDelta,
          mutation.attemptDelta,
          mutation.now,
          mutation.nextAttemptAfter,
          mutation.lastErrorJson,
          mutation.runId,
          mutation.recoveredRunId,
          mutation.now,
          mutation.gapId,
        ]
      );
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned detail-gap table.
      return rowToGap(firstSqliteRow("SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1", [gapId]));
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async markLeasedGapAttempt(lease: {
      gapId?: unknown;
      leaseId?: unknown;
      runId?: unknown;
    }): Promise<DetailGap | null> {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = execDynamicSqlAcknowledged(
        `
        UPDATE connector_detail_gaps
        SET attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN ? ELSE last_attempt_at END,
            lease_attempted = 1, updated_at = ?
        WHERE gap_id = ? AND status = 'in_progress'
          AND lease_run_id = ? AND lease_id = ?
      `,
        [now, now, owner.gapId, owner.runId, owner.leaseId]
      );
      if (Number(result.changes || 0) !== 1) {
        return null;
      }
      return rowToGap(firstSqliteRow("SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1", [owner.gapId]));
    },

    // Reclaim only an expired owner lease. A different live run is not evidence
    // of a crash and must never be stolen merely because its run id differs.
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async reclaimStrandedInProgressGaps({
      connectorId,
      connectorInstanceId,
      grantId,
    }: {
      connectorId: string;
      connectorInstanceId?: string | null;
      currentRunId?: string;
      grantId?: string | null;
    }): Promise<void> {
      const cii = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(connectorId);
      const now = nowIso();
      // REVIEWED-DYNAMIC: bulk status reset for stranded in_progress gaps whose
      // owner lease has expired.
      execDynamicSqlAcknowledged(
        `
        UPDATE connector_detail_gaps
        SET status = 'pending', updated_at = ?
        WHERE connector_instance_id = ?
          AND connector_id = ?
          AND (? IS NULL OR grant_id = ?)
          AND status = 'in_progress'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `,
        [now, cii, connectorId, grantId ?? null, grantId ?? null, now]
      );
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async releaseLeasedGaps(leases: readonly { gapId?: unknown; leaseId?: unknown; runId?: unknown }[]): Promise<{
      attemptedUnsettled: number;
      lost: number;
      released: number;
    }> {
      let released = 0;
      let lost = 0;
      let attemptedUnsettled = 0;
      for (const lease of leases || []) {
        const owner = normalizeLease(lease);
        const row = firstSqliteRow(
          `
          SELECT lease_attempted FROM connector_detail_gaps
          WHERE gap_id = ? AND status = 'in_progress' AND lease_run_id = ? AND lease_id = ?
        `,
          [owner.gapId, owner.runId, owner.leaseId]
        ) as unknown as { lease_attempted?: number } | null;
        if (!row) {
          lost += 1;
          continue;
        }
        const result = execDynamicSqlAcknowledged(
          `
          UPDATE connector_detail_gaps
          SET status = 'pending', lease_run_id = NULL, lease_id = NULL, lease_attempted = 0,
              lease_expires_at = NULL, updated_at = ?
          WHERE gap_id = ? AND status = 'in_progress' AND lease_run_id = ? AND lease_id = ?
        `,
          [nowIso(), owner.gapId, owner.runId, owner.leaseId]
        );
        if (Number(result.changes || 0) === 1) {
          released += 1;
          attemptedUnsettled += Number(row.lease_attempted || 0) === 1 ? 1 : 0;
        } else {
          lost += 1;
        }
      }
      return { attemptedUnsettled, lost, released };
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async requeueQuarantinedTerminalGapsForConnectorInstance(
      connectorId: string,
      connectorInstanceId: string,
      options: { limit?: number; now?: string; reason?: string; streams?: string[] | null } = {}
    ): Promise<RequeueResult> {
      const scope = normalizeQuarantinedRequeueScope(connectorId, connectorInstanceId, options);
      return requeueSqliteQuarantinedRows(sqliteQuarantinedRequeueRows(scope), scope);
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async settleLeasedGapPending(
      lease: { gapId?: unknown; leaseId?: unknown; runId?: unknown },
      input: UpsertGapInput
    ): Promise<DetailGap | null> {
      const owner = normalizeLease(lease);
      const gap = normalizeGapInput(input);
      const detailLocatorJson = encodeJson(gap.detailLocator);
      const result = execDynamicSqlAcknowledged(
        `
        UPDATE connector_detail_gaps
        SET source_json = ?, detail_locator_json = ?, list_cursor_json = ?, scope_json = ?, reason = ?,
            status = 'pending', next_attempt_after = ?, last_error_json = ?, last_run_id = ?,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN ? ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = ?
        WHERE gap_id = ? AND status = 'in_progress'
          AND lease_run_id = ? AND lease_id = ?
      `,
        [
          encodeJson(gap.source),
          detailLocatorJson,
          encodeJson(gap.listCursor),
          encodeJson(gap.scope),
          gap.reason,
          gap.nextAttemptAfter,
          encodeJson(gap.lastError),
          gap.lastRunId,
          gap.now,
          gap.now,
          owner.gapId,
          owner.runId,
          owner.leaseId,
        ]
      );
      if (Number(result.changes || 0) !== 1) {
        return null;
      }
      return rowToGap(firstSqliteRow("SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1", [owner.gapId]));
    },

    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async settleLeasedGapRecovered(lease: {
      gapId?: unknown;
      leaseId?: unknown;
      runId?: unknown;
    }): Promise<DetailGap | null> {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = execDynamicSqlAcknowledged(
        `
        UPDATE connector_detail_gaps
        SET status = 'recovered', recovered_run_id = ?, last_run_id = ?,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN ? ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = ?
        WHERE gap_id = ? AND status = 'in_progress'
          AND lease_run_id = ? AND lease_id = ?
      `,
        [owner.runId, owner.runId, now, now, owner.gapId, owner.runId, owner.leaseId]
      );
      if (Number(result.changes || 0) !== 1) {
        return null;
      }
      return rowToGap(firstSqliteRow("SELECT * FROM connector_detail_gaps WHERE gap_id = ? LIMIT 1", [owner.gapId]));
    },
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
    async upsertPendingGap(input: UpsertGapInput): Promise<DetailGap | null> {
      const gap = normalizeGapInput(input);
      const detailLocatorJson = encodeJson(gap.detailLocator);
      // REVIEWED-DYNAMIC: connector_detail_gaps is owned by this store and
      // not yet represented in the static query registry.
      execDynamicSqlAcknowledged(
        `
        INSERT INTO connector_detail_gaps(
          gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key,
          detail_locator_json, list_cursor_json, scope_json, reason, status, attempt_count,
          next_attempt_after, last_error_json, discovered_run_id, last_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gap_id) DO UPDATE SET
          source_json = excluded.source_json,
          detail_locator_json = excluded.detail_locator_json,
          list_cursor_json = excluded.list_cursor_json,
          scope_json = excluded.scope_json,
          reason = excluded.reason,
          -- §10-A: 'terminal' is always sticky — a terminalized gap must not be
          -- silently resurrected into the fillable-pending set by a re-upsert.
          -- 'recovered' is sticky ONLY against a re-upsert from the SAME run
          -- that recovered it (an ordinary-forward-pass re-defer with no new
          -- attempt evidence, per the original §10-A regression) — i.e. a
          -- NON-NULL 'recovered_run_id' that matches 'excluded.last_run_id'
          -- exactly. A NULL 'recovered_run_id' (a run-id-less recovery, e.g.
          -- the local-collector policy-budget path in
          -- 'ref-device-exporters.ts:recoverLocalCollectorGap', which marks a
          -- gap recovered with '{}' — no spine run backs it) carries no
          -- same-attempt context to compare against, so SQL's 'NULL = x'
          -- already evaluates false/unmatched for every 'x' here — the row is
          -- NEVER treated as a same-attempt re-defer and always reopens on the
          -- next re-upsert. Do not special-case NULL as a stickiness
          -- wildcard: an earlier revision did 'recovered_run_id IS NULL OR
          -- ...', which made every run-id-less recovery sticky FOREVER
          -- (P1 review finding, reproduced locally: a gap recovered via
          -- 'markGapStatus(id, 'recovered', {})' never reopened on a later
          -- 'upsertPendingGap' with a real 'lastRunId') — the exact opposite
          -- of the reopen-on-later-evidence rule this fix exists to enforce.
          -- A re-upsert from a LATER run (or ANY re-upsert of a null-run-id
          -- recovery) reopens the row to 'pending': the connector is
          -- reporting, with fresh attempt evidence, that a previously-closed
          -- record is missing again — treating that as permanently satisfied
          -- silently strands it outside both the pending-retry queue and the
          -- quarantine escalation path forever (live Amazon order_items
          -- evidence: 12 order ids stuck 'recovered' while DETAIL_COVERAGE
          -- reported them uncovered on every run for weeks).
          status = CASE
            WHEN connector_detail_gaps.status = 'terminal' THEN 'terminal'
            WHEN connector_detail_gaps.status = 'recovered'
              AND connector_detail_gaps.recovered_run_id = excluded.last_run_id
              THEN 'recovered'
            ELSE 'pending'
          END,
          next_attempt_after = excluded.next_attempt_after,
          last_error_json = excluded.last_error_json,
          last_run_id = excluded.last_run_id,
          updated_at = excluded.updated_at
        -- Identity conflict target = the natural key, with the volatile locator
        -- dropped when a record_key exists (see detailGapIdentityKey). This is
        -- what closes the locator-drift orphan class: a re-discovery under a new
        -- locator shape re-upserts the SAME row instead of inserting a duplicate.
        ON CONFLICT(connector_instance_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), CASE WHEN nullif(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || ifnull(detail_locator_json, '') END) DO UPDATE SET
          source_json = excluded.source_json,
          detail_locator_json = excluded.detail_locator_json,
          list_cursor_json = excluded.list_cursor_json,
          scope_json = excluded.scope_json,
          reason = excluded.reason,
          -- §10-A: see the mirrored ON CONFLICT(gap_id) branch above for the
          -- reopen-on-later-run rationale and the NULL-recovered_run_id
          -- non-wildcard rule (a run-id-less recovery is never same-attempt).
          status = CASE
            WHEN connector_detail_gaps.status = 'terminal' THEN 'terminal'
            WHEN connector_detail_gaps.status = 'recovered'
              AND connector_detail_gaps.recovered_run_id = excluded.last_run_id
              THEN 'recovered'
            ELSE 'pending'
          END,
          next_attempt_after = excluded.next_attempt_after,
          last_error_json = excluded.last_error_json,
          last_run_id = excluded.last_run_id,
          updated_at = excluded.updated_at
      `,
        [
          gap.gapId,
          gap.connectorId,
          gap.connectorInstanceId,
          gap.grantId,
          encodeJson(gap.source),
          gap.stream,
          gap.parentStream,
          gap.recordKey,
          detailLocatorJson,
          encodeJson(gap.listCursor),
          encodeJson(gap.scope),
          gap.reason,
          gap.nextAttemptAfter,
          encodeJson(gap.lastError),
          gap.discoveredRunId,
          gap.lastRunId,
          gap.now,
          gap.now,
        ]
      );
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned detail-gap table.
      // Look up by the identity expression (NOT the locator): on a locator-drift
      // re-upsert the stored row updates to the newer locator shape, so a
      // locator-based lookup against the old shape would miss.
      return rowToGap(
        firstSqliteRow(
          `
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = ?
          AND ifnull(grant_id, '') = ?
          AND stream = ?
          AND ifnull(parent_stream, '') = ?
          AND CASE WHEN nullif(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || ifnull(detail_locator_json, '') END = ?
        LIMIT 1
      `,
          [
            gap.connectorInstanceId,
            gap.grantId || "",
            gap.stream,
            gap.parentStream || "",
            detailGapIdentityKey(gap.recordKey, detailLocatorJson),
          ]
        )
      );
    },
  };
}

export function createPostgresConnectorDetailGapStore() {
  return {
    // Leasing is not an attempt. Every claimed gap moves pending → in_progress
    // under a run-owned lease id via a CAS UPDATE, so a stale/concurrent claim
    // can never take a row another run already owns.
    async claimPendingGaps(
      gapIds: readonly (string | null | undefined)[],
      {
        runId,
        leaseId,
        leaseExpiresAt,
      }: {
        leaseExpiresAt?: string | null;
        leaseId?: string | null;
        runId?: string | null;
      } = {}
    ): Promise<string[]> {
      const owner = normalizeLease({ gapId: "claim-owner", leaseId, runId });
      const expiresAt = nonEmptyString(leaseExpiresAt);
      if (!expiresAt) {
        throw new Error("detail-gap lease requires leaseExpiresAt");
      }
      const claimedGapIds: string[] = [];
      for (const gapId of gapIds || []) {
        const id = nonEmptyString(gapId);
        if (!id) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        const result = await postgresQuery(
          `
          UPDATE connector_detail_gaps
          SET status = 'in_progress', lease_run_id = $1, lease_id = $2, lease_attempted = 0,
              lease_expires_at = $3, updated_at = $4
          WHERE gap_id = $5 AND status = 'pending'
          RETURNING gap_id
        `,
          [owner.runId, owner.leaseId, expiresAt, nowIso(), id]
        );
        if (result.rows[0]?.gap_id) {
          claimedGapIds.push(result.rows[0].gap_id);
        }
      }
      return claimedGapIds;
    },

    async countGapsByStatusByStreamForConnector(
      connectorId: string,
      {
        status,
        connectorInstanceId = null,
      }: {
        status: string;
        connectorInstanceId?: string | null;
      }
    ): Promise<CountByStream[]> {
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Unsupported connector detail gap status: ${status}`);
      }
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      const result = await postgresQuery(
        `
        SELECT stream, COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = $2
          AND ($3::text IS NULL OR connector_instance_id = $3)
        GROUP BY stream
        ORDER BY stream
      `,
        [connectorId, status, scopedConnectorInstanceId]
      );
      return (result.rows as { stream: string; gap_count: number }[]).map((row) => ({
        count: coerceCount(row.gap_count ?? 0),
        stream: row.stream,
      }));
    },

    async countGapsByStatusByStreamForConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { status }: { status: string }
    ): Promise<Map<string, Map<string, number>>> {
      assertValidGapStatus(status);
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return new Map();
      }
      const query = await postgresQuery<{ connector_instance_id: string; stream: string; gap_count: number }>(
        `SELECT connector_instance_id, stream, COUNT(*) AS gap_count FROM connector_detail_gaps
         WHERE connector_instance_id = ANY($1::text[]) AND status = $2
         GROUP BY connector_instance_id, stream`,
        [ids, status]
      );
      const result = new Map<string, Map<string, number>>();
      for (const row of query.rows) {
        const counts = result.get(row.connector_instance_id) ?? new Map<string, number>();
        counts.set(row.stream, coerceCount(row.gap_count));
        result.set(row.connector_instance_id, counts);
      }
      return result;
    },

    async countGapsByStatusForConnector(
      connectorId: string,
      {
        status,
        reasons = null,
        connectorInstanceId = null,
      }: {
        status: string;
        reasons?: string[] | null;
        connectorInstanceId?: string | null;
      }
    ): Promise<number> {
      assertValidGapStatus(status);
      const reasonScope = normalizeReasonScope(reasons);
      const scopedConnectorInstanceId = nonEmptyString(connectorInstanceId);
      // Bounded reason-scoped count-by-status aggregate (Postgres analogue of
      // the SQLite path). `$3::text[]` is `NULL` when no reason scope is given,
      // so the predicate counts every reason; otherwise it restricts to the
      // supplied source-pressure reasons. Only a scalar count is returned.
      const result = await postgresQuery(
        `
        SELECT COUNT(*) AS gap_count FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = $2
          AND ($3::text[] IS NULL OR reason = ANY($3::text[]))
          AND ($4::text IS NULL OR connector_instance_id = $4)
      `,
        [connectorId, status, reasonScope, scopedConnectorInstanceId]
      );
      return coerceCount(result.rows[0]?.gap_count ?? 0);
    },

    async countGapsByStatusForConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { reasons = null, status }: { reasons?: readonly string[] | null; status: string }
    ): Promise<Map<string, number>> {
      assertValidGapStatus(status);
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return new Map();
      }
      const query = await postgresQuery<{ connector_instance_id: string; gap_count: number }>(
        `SELECT connector_instance_id, COUNT(*) AS gap_count FROM connector_detail_gaps
         WHERE connector_instance_id = ANY($1::text[]) AND status = $2
           AND ($3::text[] IS NULL OR reason = ANY($3::text[]))
         GROUP BY connector_instance_id`,
        [ids, status, reasons?.length ? reasons : null]
      );
      return new Map(query.rows.map((row) => [row.connector_instance_id, coerceCount(row.gap_count)] as const));
    },

    // Single-row read by gap id, or null if absent. See the SQLite path for the
    // read-then-decide rationale (§10-A terminal classifier).
    async getGapById(gapId: string): Promise<DetailGap | null> {
      const id = nonEmptyString(gapId);
      if (!id) {
        return null;
      }
      const result = await postgresQuery<DetailGapRow>(
        "SELECT * FROM connector_detail_gaps WHERE gap_id = $1 LIMIT 1",
        [id]
      );
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },

    async listPendingGaps(
      options: {
        connectorId: string;
        grantId?: string | null;
        streams?: string[] | null;
        limit?: number;
        now?: string;
        connectorInstanceId?: string | null;
      } = { connectorId: "" }
    ): Promise<DetailGap[]> {
      const { connectorId, grantId = null, streams = null, limit = 100, now = nowIso() } = options;
      const connectorInstanceId =
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        nonEmptyString(options?.connectorInstanceId) || defaultConnectorInstanceId(connectorId);
      const eligibleAt = nonEmptyString(now) || nowIso();
      const result = await postgresQuery<DetailGapRow>(
        `
        SELECT * FROM connector_detail_gaps
        WHERE connector_instance_id = $1
          AND connector_id = $2
          AND ($3::text IS NULL OR grant_id = $3)
          AND status = 'pending'
          AND (next_attempt_after IS NULL OR next_attempt_after <= $4)
          AND ($5::text[] IS NULL OR stream = ANY($5::text[]))
        ORDER BY ${pendingGapOrderBySql(true)}
        LIMIT $6
      `,
        [
          connectorInstanceId,
          connectorId,
          grantId,
          eligibleAt,
          Array.isArray(streams) && streams.length ? streams : null,
          Math.max(1, Math.min(limit, 500)),
        ]
      );
      return (result.rows as DetailGapRow[]).map((row) => rowToGap(row) as DetailGap);
    },

    async listPendingGapsByConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { limit = 100, now = nowIso() }: { limit?: number; now?: string } = {}
    ): Promise<Map<string, DetailGap[]>> {
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return new Map();
      }
      const bounded = Math.max(1, Math.min(limit, 500));
      const eligibleAt = nonEmptyString(now) || nowIso();
      const query = await postgresQuery<DetailGapRow>(
        `WITH ranked AS (
           SELECT connector_detail_gaps.*, ROW_NUMBER() OVER (
             PARTITION BY connector_instance_id
             ORDER BY ${pendingGapOrderBySql(true)}
           ) AS row_number
           FROM connector_detail_gaps
           WHERE connector_instance_id = ANY($1::text[])
             AND status = 'pending'
             AND (next_attempt_after IS NULL OR next_attempt_after <= $2)
         ) SELECT * FROM ranked WHERE row_number <= $3 ORDER BY connector_instance_id, row_number`,
        [ids, eligibleAt, bounded, eligibleAt]
      );
      return groupGapRowsByConnectorInstanceId(query.rows as DetailGapRow[]);
    },

    async listPendingGapsForConnector(
      connectorId: string,
      { limit = 100 }: { limit?: number } = {}
    ): Promise<DetailGap[]> {
      const result = await postgresQuery<DetailGapRow>(
        `
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = 'pending'
        ORDER BY created_at
        LIMIT $2
      `,
        [connectorId, Math.max(1, Math.min(limit, 500))]
      );
      return (result.rows as DetailGapRow[]).map((row) => rowToGap(row) as DetailGap);
    },

    async listPendingGapsForConnectorInstance(
      connectorId: string,
      connectorInstanceId: string,
      { limit = 100 }: { limit?: number } = {}
    ): Promise<DetailGap[]> {
      const result = await postgresQuery<DetailGapRow>(
        `
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = $1
          AND connector_instance_id = $2
          AND status = 'pending'
        ORDER BY created_at
        LIMIT $3
      `,
        [connectorId, connectorInstanceId, Math.max(1, Math.min(limit, 500))]
      );
      return (result.rows as DetailGapRow[]).map((row) => rowToGap(row) as DetailGap);
    },

    // Postgres analogue of the SQLite page-scoped terminal-gap read. Same
    // `cap + 1` truncation-detection contract, same `stream, gap_id` ordering
    // as `listTerminalGapsForConnector`; no bind-limit chunking is needed
    // because `= ANY($1::text[])` binds the whole id set as one parameter.
    async listTerminalGapsByConnectorInstanceIds(
      connectorInstanceIds: readonly (string | null | undefined)[],
      { rowsPerInstance = TERMINAL_GAP_PAGE_ROWS_PER_INSTANCE }: { rowsPerInstance?: number } = {}
    ): Promise<TerminalGapPageRead> {
      const ids = exactConnectorInstanceIds(connectorInstanceIds);
      if (!ids.length) {
        return { gapsByConnectorInstanceId: new Map(), truncatedConnectorInstanceIds: new Set() };
      }
      const cap = normalizeTerminalGapRowsPerInstance(rowsPerInstance);
      const query = await postgresQuery<DetailGapRow>(
        `WITH ranked AS (
           SELECT connector_detail_gaps.*, ROW_NUMBER() OVER (
             PARTITION BY connector_instance_id
             ORDER BY stream, gap_id
           ) AS row_number
           FROM connector_detail_gaps
           WHERE connector_instance_id = ANY($1::text[])
             AND status = 'terminal'
         ) SELECT * FROM ranked WHERE row_number <= $2 ORDER BY connector_instance_id, row_number`,
        [ids, cap + 1]
      );
      const gapsByConnectorInstanceId = groupGapRowsByConnectorInstanceId(query.rows as DetailGapRow[]);
      return {
        gapsByConnectorInstanceId,
        truncatedConnectorInstanceIds: partitionTruncatedTerminalGaps(gapsByConnectorInstanceId, cap),
      };
    },

    async listTerminalGapsForConnector(
      connectorId: string,
      options: { connectorInstanceId?: string | null; limit?: number } = {}
    ): Promise<DetailGap[]> {
      const scopedConnectorInstanceId = nonEmptyString(options.connectorInstanceId);
      const limit = Math.max(1, Math.min(Math.floor(Number(options.limit) || 500), 1000));
      const result = await postgresQuery<DetailGapRow>(
        `
        SELECT * FROM connector_detail_gaps
        WHERE connector_id = $1
          AND status = 'terminal'
          AND ($2::text IS NULL OR connector_instance_id = $2)
        ORDER BY stream, gap_id
        LIMIT $3
      `,
        [connectorId, scopedConnectorInstanceId, limit]
      );
      return (result.rows as DetailGapRow[]).map((row) => rowToGap(row) as DetailGap);
    },

    async markGapStatus(gapId: string, status: string, options: MarkGapStatusOptions = {}): Promise<DetailGap | null> {
      const mutation = normalizeGapStatusMutation(gapId, status, options);
      // `reason` is COALESCE-updated (see the SQLite path): only overwritten
      // when supplied, so the quarantine transition can stamp the durable
      // `quarantined` class while ordinary status mutations preserve it.
      const result = await postgresQuery<DetailGapRow>(
        `
        UPDATE connector_detail_gaps
        SET status = $1,
            reason = COALESCE($9, reason),
            attempt_count = attempt_count + $2,
            last_attempt_at = CASE WHEN $2 = 1 THEN $3 ELSE last_attempt_at END,
            next_attempt_after = $4,
            last_error_json = $5::jsonb,
            last_run_id = COALESCE($6, last_run_id),
            recovered_run_id = COALESCE($7, recovered_run_id),
            updated_at = $3
        WHERE gap_id = $8
        RETURNING *
      `,
        [
          mutation.status,
          mutation.attemptDelta,
          mutation.now,
          mutation.nextAttemptAfter,
          mutation.lastErrorJson,
          mutation.runId,
          mutation.recoveredRunId,
          mutation.gapId,
          mutation.reason,
        ]
      );
      return rowToGap(result.rows[0] ?? null);
    },

    async markLeasedGapAttempt(lease: {
      gapId?: unknown;
      leaseId?: unknown;
      runId?: unknown;
    }): Promise<DetailGap | null> {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = await postgresQuery<DetailGapRow>(
        `
        UPDATE connector_detail_gaps
        SET attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN $1 ELSE last_attempt_at END,
            lease_attempted = 1, updated_at = $1
        WHERE gap_id = $2 AND status = 'in_progress' AND lease_run_id = $3 AND lease_id = $4
        RETURNING *
      `,
        [now, owner.gapId, owner.runId, owner.leaseId]
      );
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },

    // Reclaim only an expired owner lease. A different live run is not evidence
    // of a crash and must never be stolen merely because its run id differs.
    async reclaimStrandedInProgressGaps({
      connectorId,
      connectorInstanceId,
      grantId,
    }: {
      connectorId: string;
      connectorInstanceId?: string | null;
      currentRunId?: string;
      grantId?: string | null;
    }): Promise<void> {
      const cii = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(connectorId);
      const now = nowIso();
      await postgresQuery(
        `
        UPDATE connector_detail_gaps
        SET status = 'pending', updated_at = $1
        WHERE connector_instance_id = $2
          AND connector_id = $3
          AND ($4::text IS NULL OR grant_id = $4)
          AND status = 'in_progress'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= $5
      `,
        [now, cii, connectorId, grantId ?? null, now]
      );
    },

    async releaseLeasedGaps(leases: readonly { gapId?: unknown; leaseId?: unknown; runId?: unknown }[]): Promise<{
      attemptedUnsettled: number;
      lost: number;
      released: number;
    }> {
      let released = 0;
      let lost = 0;
      let attemptedUnsettled = 0;
      for (const lease of leases || []) {
        const owner = normalizeLease(lease);
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        const result = await postgresQuery(
          `
          WITH leased AS (
            SELECT gap_id, lease_attempted
            FROM connector_detail_gaps
            WHERE gap_id = $2 AND status = 'in_progress' AND lease_run_id = $3 AND lease_id = $4
            FOR UPDATE
          )
          UPDATE connector_detail_gaps
          SET status = 'pending', lease_run_id = NULL, lease_id = NULL, lease_attempted = 0,
              lease_expires_at = NULL, updated_at = $1
          FROM leased
          WHERE connector_detail_gaps.gap_id = leased.gap_id
          RETURNING leased.lease_attempted
        `,
          [nowIso(), owner.gapId, owner.runId, owner.leaseId]
        );
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const row = result.rows[0];
        if (!row) {
          lost += 1;
          continue;
        }
        released += 1;
        attemptedUnsettled += Number(row.lease_attempted || 0) === 1 ? 1 : 0;
      }
      return { attemptedUnsettled, lost, released };
    },

    async requeueQuarantinedTerminalGapsForConnectorInstance(
      connectorId: string,
      connectorInstanceId: string,
      options: { limit?: number; now?: string; reason?: string; streams?: string[] | null } = {}
    ): Promise<RequeueResult> {
      const scope = normalizeQuarantinedRequeueScope(connectorId, connectorInstanceId, options);
      return requeuePostgresQuarantinedRows(await postgresQuarantinedRequeueRows(scope), scope);
    },

    async settleLeasedGapPending(
      lease: { gapId?: unknown; leaseId?: unknown; runId?: unknown },
      input: UpsertGapInput
    ): Promise<DetailGap | null> {
      const owner = normalizeLease(lease);
      const gap = normalizeGapInput(input);
      const result = await postgresQuery<DetailGapRow>(
        `
        UPDATE connector_detail_gaps
        SET source_json = $1::jsonb, detail_locator_json = $2::jsonb, list_cursor_json = $3::jsonb,
            scope_json = $4::jsonb, reason = $5, status = 'pending', next_attempt_after = $6,
            last_error_json = $7::jsonb, last_run_id = $8,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN $9 ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = $9
        WHERE gap_id = $10 AND status = 'in_progress' AND lease_run_id = $11 AND lease_id = $12
        RETURNING *
      `,
        [
          JSON.stringify(gap.source),
          encodeJson(gap.detailLocator),
          encodeJson(gap.listCursor),
          JSON.stringify(gap.scope),
          gap.reason,
          gap.nextAttemptAfter,
          encodeJson(gap.lastError),
          gap.lastRunId,
          gap.now,
          owner.gapId,
          owner.runId,
          owner.leaseId,
        ]
      );
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },

    async settleLeasedGapRecovered(lease: {
      gapId?: unknown;
      leaseId?: unknown;
      runId?: unknown;
    }): Promise<DetailGap | null> {
      const owner = normalizeLease(lease);
      const now = nowIso();
      const result = await postgresQuery<DetailGapRow>(
        `
        UPDATE connector_detail_gaps
        SET status = 'recovered', recovered_run_id = $1, last_run_id = $1,
            attempt_count = attempt_count + CASE WHEN lease_attempted = 0 THEN 1 ELSE 0 END,
            last_attempt_at = CASE WHEN lease_attempted = 0 THEN $2 ELSE last_attempt_at END,
            lease_run_id = NULL, lease_id = NULL, lease_attempted = 0, lease_expires_at = NULL,
            updated_at = $2
        WHERE gap_id = $3 AND status = 'in_progress' AND lease_run_id = $1 AND lease_id = $4
        RETURNING *
      `,
        [owner.runId, now, owner.gapId, owner.leaseId]
      );
      return result.rows[0] ? rowToGap(result.rows[0]) : null;
    },
    async upsertPendingGap(input: UpsertGapInput): Promise<DetailGap | null> {
      const gap = normalizeGapInput(input);
      const result = await postgresQuery<DetailGapRow>(
        `
        INSERT INTO connector_detail_gaps(
          gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key,
          detail_locator_json, list_cursor_json, scope_json, reason, status, attempt_count,
          next_attempt_after, last_error_json, discovered_run_id, last_run_id, created_at, updated_at
        ) VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, 'pending', 0, $13, $14::jsonb, $15, $16, $17, $17)
        -- Identity conflict target = the natural key, with the volatile locator
        -- dropped when a record_key exists (see detailGapIdentityKey). Closes the
        -- locator-drift orphan class: a re-discovery under a new locator shape
        -- re-upserts the SAME row instead of inserting a duplicate.
        ON CONFLICT (connector_instance_id, COALESCE(grant_id, ''), stream, COALESCE(parent_stream, ''), (CASE WHEN NULLIF(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || COALESCE(detail_locator_json::text, '') END)) DO UPDATE SET
          source_json = EXCLUDED.source_json,
          detail_locator_json = EXCLUDED.detail_locator_json,
          list_cursor_json = EXCLUDED.list_cursor_json,
          scope_json = EXCLUDED.scope_json,
          reason = EXCLUDED.reason,
          -- §10-A: 'terminal' is always sticky — a terminalized gap must not be
          -- silently resurrected into the fillable-pending set by a re-upsert.
          -- 'recovered' is sticky ONLY against a re-upsert from the SAME run
          -- that recovered it (an ordinary-forward-pass re-defer with no new
          -- attempt evidence, per the original §10-A regression) — i.e. a
          -- NON-NULL 'recovered_run_id' that matches 'EXCLUDED.last_run_id'
          -- exactly. A NULL 'recovered_run_id' (a run-id-less recovery, e.g.
          -- the local-collector policy-budget path in
          -- 'ref-device-exporters.ts:recoverLocalCollectorGap', which marks a
          -- gap recovered with '{}' — no spine run backs it) carries no
          -- same-attempt context to compare against, so SQL's 'NULL = x'
          -- already evaluates false/unmatched for every 'x' here — the row is
          -- NEVER treated as a same-attempt re-defer and always reopens on the
          -- next re-upsert. Do not special-case NULL as a stickiness
          -- wildcard: an earlier revision did 'recovered_run_id IS NULL OR
          -- ...', which made every run-id-less recovery sticky FOREVER
          -- (P1 review finding) — the exact opposite of the reopen-on-later-
          -- evidence rule this fix exists to enforce. A re-upsert from a
          -- LATER run (or ANY re-upsert of a null-run-id recovery) reopens
          -- the row to 'pending': the connector is reporting, with fresh
          -- attempt evidence, that a previously-closed record is missing
          -- again — treating that as permanently satisfied silently strands
          -- it outside both the pending-retry queue and the quarantine
          -- escalation path forever (live Amazon order_items evidence: 12
          -- order ids stuck 'recovered' while DETAIL_COVERAGE reported them
          -- uncovered on every run for weeks).
          status = CASE
            WHEN connector_detail_gaps.status = 'terminal' THEN 'terminal'
            WHEN connector_detail_gaps.status = 'recovered'
              AND connector_detail_gaps.recovered_run_id = EXCLUDED.last_run_id
              THEN 'recovered'
            ELSE 'pending'
          END,
          next_attempt_after = EXCLUDED.next_attempt_after,
          last_error_json = EXCLUDED.last_error_json,
          last_run_id = EXCLUDED.last_run_id,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
        [
          gap.gapId,
          gap.connectorId,
          gap.connectorInstanceId,
          gap.grantId,
          JSON.stringify(gap.source),
          gap.stream,
          gap.parentStream,
          gap.recordKey,
          encodeJson(gap.detailLocator),
          encodeJson(gap.listCursor),
          encodeJson(gap.scope),
          gap.reason,
          gap.nextAttemptAfter,
          encodeJson(gap.lastError),
          gap.discoveredRunId,
          gap.lastRunId,
          gap.now,
        ]
      );
      return rowToGap(result.rows[0] ?? null);
    },
  };
}

export function createConnectorDetailGapStore(): unknown {
  return isPostgresStorageBackend() ? createPostgresConnectorDetailGapStore() : createSqliteConnectorDetailGapStore();
}

let defaultStore: unknown = null;
let defaultBackend: string | null = null;

export function getDefaultConnectorDetailGapStore(): unknown {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultBackend !== backend) {
    defaultStore = createConnectorDetailGapStore();
    defaultBackend = backend;
  }
  return defaultStore;
}

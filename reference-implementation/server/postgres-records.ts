// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-backed record and blob runtime capabilities.
 *
 * This module intentionally sits behind the existing async record/blob
 * capability functions. Operation modules keep receiving host-provided
 * capabilities and do not import this file.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import { createHash } from "node:crypto";
import {
  buildLimitClampedWarning,
  clampRecordsPageLimit,
  enforceConnectionNarrowing,
  projectStorageDisplayName,
  resolveRequestConnectionId,
} from "./connection-id-request.ts";
import { assertConnectorInstanceWritableStatus } from "./connector-instance-admission.ts";
import {
  type ConnectorInstanceWriteOwnership,
  withConnectorInstanceWrite,
} from "./connector-instance-write-coordinator.ts";
import { canonicalConnectorKey } from "./connector-key.ts";
import { assertGrantedManifestReadAuthority, assertManifestReadAuthority } from "./manifest-read-authority.ts";
import {
  isPostgresStorageBackend,
  postgresQuery as rawPostgresQuery,
  withPostgresTransaction,
} from "./postgres-storage.ts";
import {
  assertRecordIdentity,
  assertSafeJsonField,
  buildEffectiveFilter,
  normalizeExpandRequest,
  normalizePrimaryKey,
} from "./record-expand-helpers.ts";
import {
  assertFieldPath,
  assertFieldVisibleToGrant,
  assertReadableStringField,
  buildWindowEnvelope,
  classifyFieldType,
  fieldWindowError,
  normalizeWindowSelector,
} from "./record-field-window.ts";
import { compileRequestFilters, nonNullSchemaTypes, passesRequestFilters, passesTimeRange } from "./record-filters.ts";
import {
  getChangeHistoryLimit,
  nowIso,
  resolveStorageConnectorId,
  resolveStorageConnectorInstanceId,
} from "./storage-utils.ts";
import { createPostgresConnectorInstanceStore } from "./stores/connector-instance-store.ts";
import { advancePostgresDeviceIngestPrefix } from "./stores/device-exporter-store.ts";

type JsonObject = Record<string, unknown>;
const SAFE_JSON_FIELD = /^[A-Za-z0-9_]+$/;
const RECORD_TIME_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
type PostgresAdmissionLockedPhaseHook = (point: string, context: Record<string, unknown>) => Promise<void> | void;

let postgresAdmissionLockedPhaseHook: PostgresAdmissionLockedPhaseHook | null = null;

/** Test-only seam after transaction-native connector-instance admission locks its row. */
export function __setPostgresAdmissionLockedPhaseHookForTest(hook: unknown): void {
  postgresAdmissionLockedPhaseHook = typeof hook === "function" ? (hook as PostgresAdmissionLockedPhaseHook) : null;
}

async function maybePostgresAdmissionLockedPhase(point: string, context: Record<string, unknown>): Promise<void> {
  await postgresAdmissionLockedPhaseHook?.(point, context);
}

async function sequentially<T>(items: readonly T[], visit: (item: T) => Promise<void>): Promise<void> {
  const item = items.at(0);
  if (item === undefined) {
    return;
  }
  await visit(item);
  await sequentially(items.slice(1), visit);
}

interface PgClient {
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: PgRow[]; rowCount: number | null }>;
}

async function postgresQuery(
  text: string,
  values: unknown[] = []
): Promise<{ rows: PgRow[]; rowCount: number | null }> {
  const result = await rawPostgresQuery<PgRow>(text, values);
  return { rowCount: result.rowCount, rows: result.rows };
}

interface ManifestStream {
  consent_time_field?: string;
  cursor_field?: string;
  name?: string;
  primary_key?: string | string[];
  schema?: { required?: string[]; properties?: Record<string, FieldSchema> };
}

interface FieldSchema {
  format?: string;
  type?: string | string[];
  [key: string]: unknown;
}

interface ConnectorManifest {
  connector_id?: string;
  connector_key?: string;
  streams?: ManifestStream[];
}

interface StreamGrant {
  fields?: string[] | null;
  name: string;
  resources?: string[];
  time_range?: { since?: string; until?: string } | null;
}

interface ConnectorGrant {
  streams: StreamGrant[];
}

interface RecordIdentity {
  connectionId: string;
  displayName?: string;
}

interface PgRow {
  __fk?: string | null;
  __rn?: number;
  binding_inserted?: boolean;
  blob_bytes?: number | string;
  blob_id?: string;
  bytes?: number | string;
  connector_count?: number | string;
  connector_id?: string;
  connector_instance_id?: string;
  consent_time_value?: string | null;
  count?: number | string;
  cursor_value?: string | null;
  data?: Buffer;
  deleted?: boolean;
  deleted_at?: string | null;
  earliest?: Date | string | null;
  earliest_ingested_at?: string | null;
  emitted_at: string;
  field_text?: string | null;
  field_type?: string;
  is_identical?: boolean;
  last_updated?: string | null;
  latest?: Date | string | null;
  latest_ingested_at?: string | null;
  manifest?: unknown;
  match_pos?: number | string | null;
  max_time?: string | null;
  max_version?: number | string;
  mime_type?: string | null;
  min_time?: string | null;
  min_version?: number | string;
  name?: string;
  primary_key_text?: string;
  record_changes_json_bytes?: number | string;
  record_count?: number | string;
  record_json: unknown;
  record_json_bytes?: number | string;
  record_key: string;
  semantic_time?: string | null;
  sha256?: string;
  size_bytes?: number | string;
  stream?: string;
  stream_count?: number | string;
  streams?: unknown;
  total?: number | string;
  total_chars?: number | string | null;
  value?: number | string;
  version?: number | string;
  window_text?: string | null;
}

interface EffectiveFilter {
  fields?: string[] | null;
  resources?: string[] | null;
  timeRange?: { since?: string; until?: string } | null;
}

interface CompiledFilter {
  field: string;
  fieldSchema?: FieldSchema;
  kind: string;
  operators?: Record<string, unknown>;
  value?: unknown;
}

interface ResolvedSort {
  direction: "ASC" | "DESC";
  field: string;
}

interface QueryRequestParams extends Record<string, unknown> {
  changes_since?: string;
  connection_id?: string;
  connector_instance_id?: string;
  count?: string;
  cursor?: string;
  expand?: unknown;
  expand_limit?: number;
  fields?: string[];
  filter?: Record<string, unknown>;
  limit?: number | string;
  order?: string;
  sort?: string | string[];
  window?: string;
}

type ExpansionEntry = ReturnType<typeof normalizeExpandRequest>[number];

interface ResponseRecord extends JsonObject {
  expanded?: JsonObject;
}

interface ResponseRow {
  record_key: string;
  responseRecord: ResponseRecord;
}

interface RecordSnapshot {
  data: JsonObject | null;
  deleted: boolean;
  deleted_at: string | null;
  emitted_at: string;
  record_key: string;
  version: number;
}

interface PgQueryError extends Error {
  code?: string;
  param?: string;
  statusCode?: number;
}

interface IngestRecord {
  data?: JsonObject;
  emitted_at?: string;
  key: unknown;
  op?: "upsert" | "delete";
  stream: string;
}

interface IngestOptions {
  attemptContext?: DeviceAttemptContext | null;
  deviceReservation?: JsonObject & { inputIndex: number };
  requireConnectionAdmission?: boolean;
}

interface IngestOutcome {
  accepted: boolean;
  changed: boolean;
  retainedSizeDelta?: JsonObject;
  self_healed?: boolean;
  version?: number;
}

interface DurableIngestOutcome {
  kind: "noop" | "changed";
  op?: "upsert" | "delete";
  retainedSizeDelta?: JsonObject;
  selfHeal?: boolean;
  version?: number;
}

interface WindowSelector {
  after?: number;
  before?: number;
  limit: number;
  limitClamped: boolean;
  mode: "offset" | "query";
  offset: number;
  query?: string;
}

/**
 * Resolve `(connection_id, display_name)` identity for a postgres-backed
 * record read. Returns `null` when the binding is absent and a
 * `display_name`-less identity when the store row has only a placeholder
 * label. Mirrors `resolveRecordIdentityForBinding` in records.ts so the
 * Postgres branch decorates records the same shape SQLite emits.
 */
async function resolveRecordIdentityForBinding(
  connectorInstanceId: string,
  connectorId: string | null
): Promise<RecordIdentity | null> {
  if (!connectorInstanceId) {
    return null;
  }
  const identity: RecordIdentity = { connectionId: connectorInstanceId };
  try {
    const store = createPostgresConnectorInstanceStore();
    const instance = await store.get(connectorInstanceId);
    if (instance) {
      const displayName = projectStorageDisplayName(instance.displayName, {
        connectorId: connectorId || instance.connectorId,
        connectorInstanceId,
      });
      if (displayName) {
        identity.displayName = displayName;
      }
    }
  } catch {
    // Identity lookup failures degrade to connection_id-only decoration.
  }
  return identity;
}

// Canonical public-read graded-count vocabulary. Mirrors
// `SUPPORTED_COUNT_KINDS` in records.ts. Kept in sync by duplication so
// postgres-records.ts does not import from records.ts (records.ts
// dispatches into postgres-records.ts — the dep must run one way only).
//
// Spec: openspec/changes/canonicalize-public-read-contract/specs/
//       reference-implementation-architecture/spec.md
//       (#"Counts are opt-in and cost-graded").
const SUPPORTED_COUNT_KINDS_PG = new Set(["none", "estimated", "exact"]);

function invalidQueryError(message: string, code = "invalid_request"): PgQueryError {
  const err: PgQueryError = new Error(message);
  err.code = code;
  return err;
}

/**
 * Validate the requested count grade against the canonical
 * `none|estimated|exact` vocabulary. Empty / absent passes through;
 * the server applies `none` as the default. Mirrors the SQLite path.
 */
function validateCountKind(value: unknown): void {
  if (value === null || value === undefined || value === "") {
    return;
  }
  if (typeof value !== "string" || !SUPPORTED_COUNT_KINDS_PG.has(value)) {
    throw invalidQueryError(`count must be one of: ${[...SUPPORTED_COUNT_KINDS_PG].join(", ")}`);
  }
}

// Canonical `window` opt-in vocabulary, mirrored from records.ts's
// `SUPPORTED_WINDOW_KINDS` (see the one-way-dependency note above). The
// Postgres list path validates the `window` value with the same strict
// discipline as the SQLite path AND computes `meta.window` to parity via
// computePostgresRecordWindow: a JSON-extract min/max scan over the logical
// `consent_time_field` whose timestamp normalization matches the SQLite
// reference's `new Date(...)` parse.
//
// Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
//       reference-implementation-architecture/spec.md
//       (#"The record-list read MAY expose bounded window aggregate metadata").
const SUPPORTED_WINDOW_KINDS_PG = new Set(["none", "exact"]);

/**
 * Validate the requested window grade against the canonical `none|exact`
 * vocabulary. Empty / absent / `none` passes through (the server omits
 * `meta.window`); any other value is a typed invalid-query error. Mirrors the
 * SQLite path's `validateWindowKind`.
 */
function validateWindowKind(value: unknown): void {
  if (value === null || value === undefined || value === "") {
    return;
  }
  if (typeof value !== "string" || !SUPPORTED_WINDOW_KINDS_PG.has(value)) {
    throw invalidQueryError(`window must be one of: ${[...SUPPORTED_WINDOW_KINDS_PG].join(", ")}`);
  }
}

function rejectListOnlyParamsForChangesFeed(requestParams: QueryRequestParams): void {
  const unsupported: string[] = [];
  for (const key of ["sort", "count", "order", "window"]) {
    if (requestParams[key] !== null && requestParams[key] !== undefined && requestParams[key] !== "") {
      unsupported.push(key);
    }
  }
  if (!unsupported.length) {
    return;
  }
  throw invalidQueryError(
    `${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not supported with changes_since`,
    "invalid_request"
  );
}

/**
 * Validate the canonical `sort` parameter against the manifest stream's
 * declared cursor field, and return the resolved direction the runtime
 * will apply. Mirrors `validateCanonicalSort` in records.ts for the
 * Postgres-backed path — sign-prefix controls direction, the only
 * advertised sortable field is the stream's cursor field, and anything
 * else is rejected with a typed `invalid_sort` error.
 *
 * Returns `null` when no `sort` is supplied, or
 *   `{ field, direction: 'ASC' | 'DESC' }`.
 */
function validateCanonicalSort(value: unknown, manifestStream: ManifestStream | null): ResolvedSort | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const entries = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return null;
  }
  const cursorField = manifestStream?.cursor_field || null;
  const sortableFields = cursorField ? new Set([cursorField]) : new Set();
  let resolved: ResolvedSort | null = null;
  for (const entry of entries) {
    const direction = entry.startsWith("-") ? "DESC" : "ASC";
    const field = direction === "DESC" ? entry.slice(1) : entry;
    if (!field) {
      const err = invalidQueryError("Empty sort field", "invalid_sort");
      err.param = "sort";
      throw err;
    }
    if (sortableFields.size === 0 || !sortableFields.has(field)) {
      const err = invalidQueryError(
        `Sort field '${field}' is not advertised as sortable; check /v1/schema for the canonical sort vocabulary.`,
        "invalid_sort"
      );
      err.param = "sort";
      throw err;
    }
    if (resolved && resolved.direction !== direction) {
      const err = invalidQueryError(`Conflicting sort directions for field '${field}'`, "invalid_sort");
      err.param = "sort";
      throw err;
    }
    resolved = { direction, field };
  }
  return resolved;
}

function parsePageOrder(rawOrder: unknown): "ASC" | "DESC" {
  if (rawOrder === null || rawOrder === undefined || rawOrder === "") {
    return "DESC";
  }
  if (rawOrder === "asc") {
    return "ASC";
  }
  if (rawOrder === "desc") {
    return "DESC";
  }
  throw invalidQueryError("order must be asc or desc");
}

/**
 * Resolve the effective list order from the canonical `sort` parameter
 * and the legacy `order` parameter. Mirrors `resolveListOrder` in
 * records.ts: canonical `sort` wins; legacy `order` is honored only when
 * `sort` is absent; if both are sent and disagree, reject with
 * `invalid_sort` rather than silently picking one.
 */
function resolveListOrder(rawOrder: unknown, resolvedSort: ResolvedSort | null): "ASC" | "DESC" {
  if (resolvedSort) {
    if (rawOrder !== null && rawOrder !== undefined && rawOrder !== "") {
      const legacyOrder = parsePageOrder(rawOrder);
      if (legacyOrder !== resolvedSort.direction) {
        const err = invalidQueryError(
          `sort and order disagree: sort resolves to ${resolvedSort.direction}, order=${rawOrder}. Send only canonical \`sort\`.`,
          "invalid_sort"
        );
        err.param = "sort";
        throw err;
      }
    }
    return resolvedSort.direction;
  }
  return parsePageOrder(rawOrder);
}

function mergeMetaCount(existingMeta: unknown, count: unknown): JsonObject {
  const base: JsonObject =
    existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? { ...(existingMeta as JsonObject) }
      : {};
  base.count = count;
  return base;
}

function mergeMetaWindow(existingMeta: unknown, window: unknown): JsonObject {
  const base: JsonObject =
    existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
      ? { ...(existingMeta as JsonObject) }
      : {};
  base.window = window;
  return base;
}
const KEY_SEPARATOR = "\u0001";
let postgresRecordSortBackfillPhaseHook: ((point: string, context: JsonObject) => Promise<void> | void) | null = null;

/** Test-only seam for deterministic registration/backfill ordering. */
export function __setPostgresRecordSortBackfillPhaseHookForTest(
  hook: ((point: string, context: JsonObject) => Promise<void> | void) | null
): void {
  postgresRecordSortBackfillPhaseHook = typeof hook === "function" ? hook : null;
}

async function maybePostgresRecordSortBackfillPhaseForTest(point: string, context: JsonObject): Promise<void> {
  await postgresRecordSortBackfillPhaseHook?.(point, context);
}

function encodeKey(key: unknown): string {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function decodeKey(keyStr: string): string | string[] {
  try {
    const parsed = JSON.parse(keyStr);
    return Array.isArray(parsed) ? parsed : keyStr;
  } catch {
    return keyStr;
  }
}

function getStreamGrant(grant: ConnectorGrant, stream: string): StreamGrant {
  const streamGrant = grant.streams.find((entry) => entry.name === stream);
  if (!streamGrant) {
    const err: PgQueryError = new Error(`Stream '${stream}' not in grant`);
    err.code = "grant_stream_not_allowed";
    throw err;
  }
  return streamGrant;
}

function getManifestStream(manifest: ConnectorManifest | null, stream: string): ManifestStream | null {
  return manifest?.streams?.find((entry) => entry.name === stream) || null;
}

function requiredFieldsFor(manifestStream: ManifestStream | null): string[] {
  return Array.isArray(manifestStream?.schema?.required) ? manifestStream.schema.required : [];
}

function primaryKeyFieldsFor(manifestStream: ManifestStream | null): string[] {
  const primary = manifestStream?.primary_key;
  if (Array.isArray(primary)) {
    return primary;
  }
  if (typeof primary === "string") {
    return [primary];
  }
  return ["id"];
}

function fieldsFor(
  streamGrant: StreamGrant,
  requestFields: string[] | null | undefined,
  requiredFields: string[]
): string[] | null {
  let effective: string[] | null = null;
  if (Array.isArray(streamGrant.fields) && streamGrant.fields.length > 0) {
    effective = [...streamGrant.fields];
  }
  if (Array.isArray(requestFields) && requestFields.length > 0) {
    if (effective) {
      const grantedFields = effective;
      const unauthorized = requestFields.filter((field) => !grantedFields.includes(field));
      if (unauthorized.length > 0) {
        const err: PgQueryError = new Error(`Fields not in grant: ${unauthorized.join(", ")}`);
        err.code = "field_not_granted";
        throw err;
      }
      effective = requestFields.filter((field) => grantedFields.includes(field));
    } else {
      effective = [...requestFields];
    }
  }
  if (effective) {
    const seen = new Set(effective);
    for (const required of requiredFields) {
      if (!seen.has(required)) {
        effective.push(required);
        seen.add(required);
      }
    }
  }
  return effective;
}

function projectFields(data: JsonObject | null, fields: string[] | null): JsonObject | null {
  if (!(fields && data)) {
    return data;
  }
  const out: JsonObject = {};
  for (const field of fields) {
    if (Object.hasOwn(data, field)) {
      out[field] = data[field];
    }
  }
  return out;
}

function primaryKeyText(data: JsonObject | null, recordKey: string, manifestStream: ManifestStream | null): string {
  const parts = primaryKeyFieldsFor(manifestStream).map((field) => {
    const value = data?.[field];
    return value === undefined || value === null ? recordKey : value;
  });
  return parts.map((part) => String(part ?? "")).join(KEY_SEPARATOR);
}

function cursorValue(data: JsonObject | null, manifestStream: ManifestStream | null): string | null {
  const field = manifestStream?.cursor_field;
  if (!field) {
    return null;
  }
  const value = data?.[field];
  return value === undefined || value === null ? null : String(value);
}

// Below this, a numeric timestamp is treated as Unix SECONDS; at or above it, as
// Unix MILLISECONDS. Mirrors search-record-timestamps.ts and the SQLite ingest
// path in records.ts so all three coerce timestamps identically.
const SEMANTIC_TIME_EPOCH_MS_THRESHOLD = 1e12;

function coerceSemanticTimeValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value >= SEMANTIC_TIME_EPOCH_MS_THRESHOLD ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

// SEMANTIC time (when the thing happened) to stamp on a record at ingest, for
// the Explore merged-timeline sort. Resolves the manifest consent_time_field
// (preferred) then cursor_field from `data`, coerced epoch-aware, falling back
// to `effectiveEmittedAt` when no semantic field is declared or the value is
// missing/unparseable. Never empty. Mirrors computeIngestSemanticTime in the
// SQLite path (records.ts).
function semanticTimeValue(data: unknown, manifestStream: ManifestStream | null, effectiveEmittedAt: string): string {
  if (!data || typeof data !== "object") {
    return effectiveEmittedAt;
  }
  const dataObject = data as JsonObject;
  const candidates: string[] = [];
  for (const field of [manifestStream?.consent_time_field, manifestStream?.cursor_field]) {
    if (typeof field === "string" && field && !candidates.includes(field)) {
      candidates.push(field);
    }
  }
  for (const field of candidates) {
    const coerced = coerceSemanticTimeValue(dataObject[field]);
    if (coerced) {
      return coerced;
    }
  }
  return effectiveEmittedAt;
}

const manifestStreamCache = new Map<string, ManifestStream | null>();

function manifestStreamFromFacts(facts: {
  consentTimeField?: string | null;
  cursorField?: string | null;
  primaryKey?: string | string[] | null;
}): ManifestStream {
  return {
    ...(facts.consentTimeField ? { consent_time_field: facts.consentTimeField } : {}),
    ...(facts.cursorField ? { cursor_field: facts.cursorField } : {}),
    ...(facts.primaryKey ? { primary_key: facts.primaryKey } : {}),
  };
}

function manifestStreamCacheKey(connectorId: string, stream: string): string {
  return `${connectorId}\u0000${stream}`;
}

export function invalidatePostgresRecordManifestCache(connectorId: string | null = null): void {
  if (!connectorId) {
    manifestStreamCache.clear();
    return;
  }
  const prefix = `${connectorId}\u0000`;
  for (const key of manifestStreamCache.keys()) {
    if (key.startsWith(prefix)) {
      manifestStreamCache.delete(key);
    }
  }
}

function normalizeManifestRow(row: PgRow | null | undefined): ConnectorManifest | null {
  if (!row?.manifest) {
    return null;
  }
  if (typeof row.manifest === "string") {
    try {
      return JSON.parse(row.manifest);
    } catch {
      return null;
    }
  }
  return row.manifest;
}

async function getCachedPostgresManifestStream(connectorId: string, stream: string): Promise<ManifestStream | null> {
  const key = manifestStreamCacheKey(connectorId, stream);
  if (manifestStreamCache.has(key)) {
    return manifestStreamCache.get(key) ?? null;
  }

  const result = await postgresQuery(
    `SELECT manifest
       FROM connectors
      WHERE connector_id = $1`,
    [connectorId]
  );
  const manifest = normalizeManifestRow((result.rows[0] as PgRow | undefined) ?? undefined);
  const manifestStream = getManifestStream(manifest, stream);
  manifestStreamCache.set(key, manifestStream);
  return manifestStream;
}

function manifestConnectorId(manifest: ConnectorManifest | null | undefined): string | null {
  const raw = manifest?.connector_key || manifest?.connector_id;
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  return canonicalConnectorKey(raw) ?? raw.trim();
}

/**
 * Repair manifest-derived cursor values without entering the ingest writer
 * fence. The update is set-based and derives its value from each row's
 * current JSON payload, so a manifest refresh can restore the canonical sort
 * key while retrieval-index maintenance is intentionally disabled.
 */
export async function postgresBackfillRecordCursorValuesForManifest(
  manifest: ConnectorManifest
): Promise<{ updated: number }> {
  if (!isPostgresStorageBackend()) {
    return { updated: 0 };
  }
  const connectorId = manifestConnectorId(manifest);
  if (!(connectorId && Array.isArray(manifest.streams))) {
    return { updated: 0 };
  }

  const streamFacts = manifest.streams
    .map((manifestStream) => ({
      cursorField: safeJsonField(manifestStream?.cursor_field),
      stream: typeof manifestStream?.name === "string" ? manifestStream.name : null,
    }))
    .filter((facts): facts is { cursorField: string; stream: string } => Boolean(facts.stream && facts.cursorField));

  const updated = await streamFacts.reduce(async (previous, { stream, cursorField }) => {
    const total = await previous;
    const result = await postgresQuery(
      `UPDATE records
          SET cursor_value = CASE
                WHEN record_json ? $3 THEN record_json ->> $3
                ELSE NULL
              END
        WHERE connector_id = $1
          AND stream = $2
          AND deleted = FALSE
          AND cursor_value IS DISTINCT FROM CASE
                WHEN record_json ? $3 THEN record_json ->> $3
                ELSE NULL
              END`,
      [connectorId, stream, cursorField]
    );
    return total + Number(result.rowCount || 0);
  }, Promise.resolve(0));
  return { updated };
}

export async function postgresBackfillRecordSortPositionsForManifest(
  manifest: ConnectorManifest
): Promise<{ updated: number }> {
  const connectorId = manifestConnectorId(manifest);
  if (!(connectorId && Array.isArray(manifest.streams))) {
    return { updated: 0 };
  }

  const streamFacts = manifest.streams
    .map((manifestStream) => ({
      consentTimeField: safeJsonField(manifestStream?.consent_time_field),
      cursorField: safeJsonField(manifestStream?.cursor_field),
      primaryKey: primaryKeyFieldsFor(manifestStream),
      stream: typeof manifestStream?.name === "string" ? manifestStream.name : null,
    }))
    .filter((facts): facts is typeof facts & { stream: string } => typeof facts.stream === "string");
  if (streamFacts.length === 0) {
    return { updated: 0 };
  }

  // Enumerate once, then retain one fence while repairing every manifest
  // stream for that instance. Cursor, primary key, and semantic time are all
  // manifest-derived durable facts; keep them coherent with one generation
  // without allocating a new record version or emitting a notification.
  const instances = await postgresQuery(
    `SELECT DISTINCT connector_instance_id
       FROM records
      WHERE connector_id = $1
        AND stream = ANY($2::text[])
      ORDER BY connector_instance_id`,
    [connectorId, streamFacts.map(({ stream }) => stream)]
  );
  const backfillStream = (connectorInstanceId: string, facts: (typeof streamFacts)[number]): Promise<number> => {
    const manifestStream = manifestStreamFromFacts(facts);
    const backfillPage = async (afterRecordKey: string | null): Promise<number> => {
      const page = await postgresQuery(
        `SELECT record_key, record_json::text AS record_json, emitted_at,
                cursor_value, primary_key_text, semantic_time
           FROM records
          WHERE connector_id = $1
            AND connector_instance_id = $2
            AND stream = $3
            AND deleted = FALSE
            AND ($4::text IS NULL OR record_key > $4)
          ORDER BY record_key
          LIMIT 256`,
        [connectorId, connectorInstanceId, facts.stream, afterRecordKey]
      );
      if (page.rows.length === 0) {
        return 0;
      }
      const updatedInPage = await page.rows.reduce(async (previous, row) => {
        const total = await previous;
        const data = typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
        const cursor = cursorValue(data, manifestStream);
        const primary = primaryKeyText(data, row.record_key, manifestStream);
        const semanticTime = semanticTimeValue(data, manifestStream, row.emitted_at);
        const result = await postgresQuery(
          `UPDATE records
              SET cursor_value = $5, primary_key_text = $6, semantic_time = $7
            WHERE connector_id = $1
              AND connector_instance_id = $2
              AND record_key = $3
              AND stream = $4
              AND deleted = FALSE
              AND (cursor_value IS DISTINCT FROM $5
                OR primary_key_text IS DISTINCT FROM $6
                OR semantic_time IS DISTINCT FROM $7)`,
          [connectorId, connectorInstanceId, row.record_key, facts.stream, cursor, primary, semanticTime]
        );
        return total + Number(result.rowCount || 0);
      }, Promise.resolve(0));
      const lastRow = page.rows.at(-1);
      if (page.rows.length < 256 || !lastRow?.record_key) {
        return updatedInPage;
      }
      return updatedInPage + (await backfillPage(lastRow.record_key));
    };
    return backfillPage(null);
  };
  const updated = await instances.rows.reduce(async (previous, { connector_instance_id: connectorInstanceId }) => {
    const total = await previous;
    if (!connectorInstanceId) {
      return total;
    }
    await maybePostgresRecordSortBackfillPhaseForTest("before-instance-fence", { connectorId, connectorInstanceId });
    const instanceUpdated = await withConnectorInstanceWrite(connectorInstanceId, async () => {
      await maybePostgresRecordSortBackfillPhaseForTest("inside-instance-fence", { connectorId, connectorInstanceId });
      return streamFacts.reduce(
        async (streamPrevious, facts) => (await streamPrevious) + (await backfillStream(connectorInstanceId, facts)),
        Promise.resolve(0)
      );
    });
    return total + instanceUpdated;
  }, Promise.resolve(0));
  invalidatePostgresRecordManifestCache(connectorId);
  return { updated };
}

/**
 * Resolve skipped final device-ingest keys from the current authoritative Postgres
 * projection and repair the manifest-derived columns in the same transaction.
 * The caller holds the connector-instance fence (or the records module has
 * re-entered it), so a retry cannot read one payload and repair indexes from a
 * different writer's payload. This is deliberately version-free: it repairs
 * cursor/primary-key/semantic facts only and never appends history or emits a
 * client event.
 */
type StorageTarget =
  | string
  | {
      connector_id?: string;
      connectorId?: string;
      connector_instance_id?: string;
      connectorInstanceId?: string;
    }
  | null
  | undefined;

interface DevicePrepareRecord {
  data?: JsonObject;
  emitted_at?: string;
  key: unknown;
  op?: "upsert" | "delete";
  stream: string;
}

interface DevicePreparePlanEntry {
  record: DevicePrepareRecord;
  [key: string]: unknown;
}

interface DeviceAttemptStreamFacts {
  consentTimeField?: string | null;
  cursorField?: string | null;
  primaryKey?: string | string[];
}

interface DeviceAttemptContext {
  streams?: Record<string, DeviceAttemptStreamFacts>;
}

export function postgresPrepareDeviceFinalRecords(
  storageTarget: StorageTarget,
  plan: DevicePreparePlanEntry[],
  attemptContext: DeviceAttemptContext | null | undefined
): Promise<DevicePreparePlanEntry[]> {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId ?? "");
  return withPostgresTransaction(async (client) => {
    const result: DevicePreparePlanEntry[] = [];
    await plan.reduce(async (previous, entry) => {
      await previous;
      const input = entry.record;
      const recordKey = encodeKey(input.key);
      const currentResult = await client.query(
        `SELECT record_json, emitted_at, deleted
           FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
          FOR UPDATE`,
        [connectorInstanceId, input.stream, recordKey]
      );
      const current = currentResult.rows[0] || null;
      if (!current || current.deleted) {
        result.push({
          ...entry,
          record: { ...input, data: {}, op: "delete" },
        });
        return;
      }

      const data = (
        typeof current.record_json === "string" ? JSON.parse(current.record_json) : current.record_json
      ) as JsonObject;
      const facts = attemptContext?.streams?.[input.stream] ?? null;
      const manifestStream = facts ? manifestStreamFromFacts(facts) : null;
      const semanticTime = semanticTimeValue(data, manifestStream, current.emitted_at || input.emitted_at || nowIso());
      const cursor = cursorValue(data, manifestStream);
      const primary = primaryKeyText(data, recordKey, manifestStream);
      await client.query(
        `UPDATE records
            SET cursor_value = $4,
                primary_key_text = $5,
                semantic_time = $6
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
            AND deleted = FALSE`,
        [connectorInstanceId, input.stream, recordKey, cursor, primary, semanticTime]
      );
      result.push({
        ...entry,
        record: {
          ...input,
          data,
          emitted_at: current.emitted_at || input.emitted_at,
          op: "upsert",
        },
      });
    }, Promise.resolve());
    return result;
  });
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(token: string): JsonObject | null {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function responseRecord({
  stream,
  row,
  fields,
  identity = null,
}: {
  stream: string;
  row: PgRow;
  fields: string[] | null;
  identity?: RecordIdentity | null;
}): ResponseRecord {
  const record = {
    data: projectFields(row.record_json as JsonObject | null, fields),
    emitted_at: row.emitted_at,
    id: row.record_key,
    object: "record",
    stream,
  };
  decorateRecordWithConnectionIdentity(record, identity);
  return record;
}

function deletedResponseRecord({
  stream,
  row,
  identity = null,
}: {
  stream: string;
  row: PgRow;
  identity?: RecordIdentity | null;
}): ResponseRecord {
  const record = {
    deleted: true,
    deleted_at: row.deleted_at || row.emitted_at,
    emitted_at: row.emitted_at,
    id: row.record_key,
    object: "record",
    stream,
  };
  decorateRecordWithConnectionIdentity(record, identity);
  return record;
}

/**
 * Attach canonical `connection_id` and the deprecated `connector_instance_id`
 * alias to a response record when the runtime knows the binding without
 * guessing. Mirrors `decorateRecordWithConnectionIdentity` in records.ts so
 * Postgres-backed responses match SQLite-backed responses.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 */
function decorateRecordWithConnectionIdentity(record: JsonObject | null, identity: RecordIdentity | null): void {
  if (!(record && identity)) {
    return;
  }
  const connectionId = typeof identity.connectionId === "string" ? identity.connectionId.trim() : "";
  if (connectionId) {
    record.connection_id = connectionId;
    record.connector_instance_id = connectionId;
  }
  const displayName = typeof identity.displayName === "string" ? identity.displayName.trim() : "";
  if (displayName) {
    record.display_name = displayName;
  }
}

function postgresRangeCastForField(fieldSchema: FieldSchema | null | undefined): string {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) {
    return "text";
  }
  const [only] = [...types];
  if (only === "integer" || only === "number") {
    return "numeric";
  }
  if (only === "string" && fieldSchema?.format === "date") {
    return "date";
  }
  if (only === "string" && fieldSchema?.format === "date-time") {
    return "timestamptz";
  }
  return "text";
}

function buildRangeFilterClauses(
  filter: CompiledFilter,
  rawFilter: Record<string, unknown> | null | undefined,
  params: unknown[]
): string[] {
  const rawOperators = rawFilter?.[filter.field];
  const rawOperatorMap: Record<string, unknown> =
    rawOperators && typeof rawOperators === "object" && !Array.isArray(rawOperators)
      ? (rawOperators as Record<string, unknown>)
      : {};
  const operators = filter.operators ?? {};
  const cast = postgresRangeCastForField(filter.fieldSchema);
  const fieldExpr = jsonStringExpr(filter.field);
  const lhs = `${fieldExpr}::${cast}`;
  const clauses = [`record_json ? '${filter.field}'`, `${fieldExpr} IS NOT NULL`];
  for (const op of ["gte", "gt", "lte", "lt"]) {
    if (!Object.hasOwn(operators, op)) {
      continue;
    }
    const operator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
    const value = Object.hasOwn(rawOperatorMap, op) ? rawOperatorMap[op] : operators[op];
    params.push(value);
    clauses.push(`${lhs} ${operator} $${params.length}::${cast}`);
  }
  return clauses;
}

function buildFilterClause(
  compiledFilters: CompiledFilter[],
  rawFilter: Record<string, unknown> | null | undefined,
  params: unknown[]
): string {
  if (!Array.isArray(compiledFilters) || compiledFilters.length === 0) {
    return "";
  }
  const clauses: string[] = [];
  for (const filter of compiledFilters) {
    assertSafeJsonField(filter.field, "filter");
    if (filter.kind === "range") {
      clauses.push(...buildRangeFilterClauses(filter, rawFilter, params));
      continue;
    }
    const fieldExpr = jsonStringExpr(filter.field);
    params.push(filter.value);
    clauses.push(`${fieldExpr} = $${params.length}`);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

export function __buildPostgresFilterClauseForTest(
  filter: Record<string, unknown>,
  streamGrant: StreamGrant,
  manifestStream: ManifestStream | null
): { clause: string; params: unknown[] } {
  const compiledFilters = compileRequestFilters(filter, streamGrant, manifestStream ?? {});
  const params: unknown[] = [];
  return {
    clause: buildFilterClause(compiledFilters, filter, params),
    params,
  };
}

function appendGrantVisibilityClauses(
  whereParts: string[],
  params: unknown[],
  effective: EffectiveFilter,
  manifestStream: ManifestStream | null
): void {
  const consentTimeField = manifestStream?.consent_time_field || null;
  if (effective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, "consent_time_field");
    const ctExpr = jsonStringExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (effective.timeRange.since !== null && effective.timeRange.since !== undefined) {
      params.push(new Date(effective.timeRange.since).toISOString());
      whereParts.push(`${ctExpr} >= $${params.length}`);
    }
    if (effective.timeRange.until !== null && effective.timeRange.until !== undefined) {
      params.push(new Date(effective.timeRange.until).toISOString());
      whereParts.push(`${ctExpr} < $${params.length}`);
    }
  }

  if (effective.resources && effective.resources.length > 0) {
    params.push(effective.resources);
    whereParts.push(`record_key = ANY($${params.length}::text[])`);
  }
}

function isVisiblePostgresSnapshot(
  snapshot: RecordSnapshot | null,
  effective: EffectiveFilter,
  consentTimeField: string | null
): boolean {
  if (!snapshot || snapshot.deleted || !snapshot.data) {
    return false;
  }
  if (effective.resources && !effective.resources.includes(snapshot.record_key)) {
    return false;
  }
  if (
    effective.timeRange &&
    consentTimeField &&
    !passesTimeRange(snapshot.data, effective.timeRange, consentTimeField)
  ) {
    return false;
  }
  return true;
}

async function getPostgresSnapshotAtVersion(
  connectorInstanceId: string,
  stream: string,
  recordKey: string,
  version: number
): Promise<RecordSnapshot | null> {
  if (!Number.isInteger(version) || version < 0) {
    return null;
  }
  const result = await postgresQuery(
    `SELECT version, record_json, emitted_at, deleted, deleted_at
       FROM record_changes
      WHERE connector_instance_id = $1
        AND stream = $2
        AND record_key = $3
        AND version <= $4
      ORDER BY version DESC
      LIMIT 1`,
    [connectorInstanceId, stream, recordKey, version]
  );
  const [row] = result.rows;
  if (!row) {
    return null;
  }
  return {
    data: row.record_json && typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json,
    deleted: row.deleted === true,
    deleted_at: row.deleted_at ?? null,
    emitted_at: row.emitted_at,
    record_key: recordKey,
    version: Number(row.version),
  };
}

function safeJsonField(field: unknown): string | null {
  if (!(typeof field === "string" && field && SAFE_JSON_FIELD.test(field))) {
    return null;
  }
  return field as string;
}

function recordOrderExpressions(manifestStream: ManifestStream | null): { cursorSql: string; primarySql: string } {
  const cursorField = safeJsonField(manifestStream?.cursor_field);
  return {
    cursorSql: cursorField ? "cursor_value" : "emitted_at",
    primarySql: "primary_key_text",
  };
}

function rejectExpandWithChangesSince(requestParams: QueryRequestParams): void {
  if (requestParams.changes_since === null || requestParams.changes_since === undefined) {
    return;
  }
  if (
    (requestParams.expand === null || requestParams.expand === undefined) &&
    (requestParams.expand_limit === null || requestParams.expand_limit === undefined)
  ) {
    return;
  }
  const err: PgQueryError = new Error("expand is not supported with changes_since");
  err.code = "invalid_expand";
  throw err;
}

function jsonStringExpr(field: string): string {
  // record_json is JSONB on Postgres; `->>` returns the field as text.
  // Field comes from the manifest and is re-validated against SAFE_JSON_FIELD
  // before reaching this builder, so quoting it as a SQL literal is safe.
  assertSafeJsonField(field, "json_string");
  return `(record_json->>'${field}')`;
}

function childResponseRecord({
  stream,
  row,
  fields,
}: {
  stream: string;
  row: PgRow;
  fields: string[] | null;
}): ResponseRecord {
  const rawData = typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
  return {
    data: projectFields(rawData, fields),
    emitted_at: row.emitted_at,
    id: row.record_key,
    object: "record",
    stream,
  };
}

/**
 * Postgres equivalent of `records.ts#hydrateExpandedRelations`.
 *
 * For each requested expansion, runs one window-function batched query
 * to fetch child rows for the entire parent page in a single round
 * trip. Children are partitioned by foreign key and ranked by the child
 * stream's manifest-declared (cursor_field, primary_key) basis so the
 * per-parent slice and per-parent `has_more` signal match the SQLite
 * engine. Grant projection (`fields`, `time_range`, `resources`) is
 * enforced in SQL exactly as the SQLite path enforces it.
 *
 * Throws `invalid_expand` if the child manifest is missing or declares
 * a child stream whose foreign-key/primary-key fields fail the
 * SAFE_JSON_FIELD regex.
 *
 * Spec: openspec/changes/add-postgres-expand-hydration/specs/
 *       reference-implementation-architecture/spec.md
 */
async function hydratePostgresExpandedRelations({
  connectorInstanceId,
  expansions,
  parentRows,
  manifest,
}: {
  connectorInstanceId: string;
  expansions: ExpansionEntry[];
  parentRows: ResponseRow[];
  manifest: ConnectorManifest | null;
}): Promise<void> {
  if (!(expansions.length && parentRows.length)) {
    return;
  }
  await sequentially(expansions, (expansion) =>
    hydratePostgresExpansion({ connectorInstanceId, expansion, manifest, parentRows })
  );
}

function resolvePostgresExpansionFields(
  expansion: ExpansionEntry,
  manifest: ConnectorManifest | null
): {
  childEffective: EffectiveFilter;
  childFields: string[] | null;
  childStream: string;
  consentTimeField: string | null;
  cursorField: string | null;
  foreignKeyField: string;
  primaryKeyField: string;
} {
  const childStream = expansion.relationship.stream;
  const childManifestStream = manifest?.streams?.find((entry) => entry.name === childStream);
  if (!childManifestStream) {
    const err: PgQueryError = new Error(`Expand relation '${expansion.name}' targets unknown stream '${childStream}'`);
    err.code = "invalid_expand";
    throw err;
  }
  const foreignKeyField = expansion.relationship.foreign_key;
  assertSafeJsonField(foreignKeyField, "foreign_key");
  if (typeof foreignKeyField !== "string") {
    throw invalidQueryError("Expand relation foreign_key must be a string", "invalid_expand");
  }
  let primaryKeyFields: string[];
  if (Array.isArray(childManifestStream.primary_key)) {
    primaryKeyFields = childManifestStream.primary_key;
  } else if (typeof childManifestStream.primary_key === "string") {
    primaryKeyFields = [childManifestStream.primary_key];
  } else {
    primaryKeyFields = ["id"];
  }
  if (primaryKeyFields.length === 0) {
    const err: PgQueryError = new Error(
      `Expand relation '${expansion.name}' child '${childStream}' is missing a primary_key`
    );
    err.code = "invalid_expand";
    throw err;
  }
  if (primaryKeyFields.length > 1) {
    const err: PgQueryError = new Error(
      `Expand relation '${expansion.name}' child '${childStream}' uses a multi-part primary_key (not implemented)`
    );
    err.code = "invalid_expand";
    throw err;
  }
  const [primaryKeyField] = primaryKeyFields;
  if (!primaryKeyField) {
    throw invalidQueryError("Expand relation primary_key is empty", "invalid_expand");
  }
  assertSafeJsonField(primaryKeyField, "primary_key");
  const childRequiredFields = Array.isArray(childManifestStream.schema?.required)
    ? childManifestStream.schema.required
    : [];
  const childEffective = buildEffectiveFilter(
    expansion.childGrant,
    {},
    childRequiredFields
  ) as unknown as EffectiveFilter;
  return {
    childEffective,
    childFields: childEffective.fields ?? null,
    childStream,
    consentTimeField: childManifestStream.consent_time_field || null,
    cursorField: childManifestStream.cursor_field || null,
    foreignKeyField,
    primaryKeyField,
  };
}

function attachPostgresExpansionRows(
  expansion: ExpansionEntry,
  parentRows: ResponseRow[],
  childFields: string[] | null,
  childStream: string,
  resultRows: PgRow[]
): void {
  const buckets = new Map<string, PgRow[]>();
  for (const row of resultRows) {
    const fk = row.__fk === null ? "" : String(row.__fk);
    if (!buckets.has(fk)) {
      buckets.set(fk, []);
    }
    buckets.get(fk)?.push(row);
  }
  for (const parentRow of parentRows) {
    if (!parentRow.responseRecord.expanded) {
      parentRow.responseRecord.expanded = {};
    }
    const matches = buckets.get(parentRow.record_key) || [];
    if (expansion.relationship.cardinality === "has_one") {
      const [first] = matches;
      parentRow.responseRecord.expanded[expansion.name] = first
        ? childResponseRecord({ fields: childFields, row: first, stream: childStream })
        : null;
      continue;
    }
    const sliced = matches.slice(0, expansion.limit);
    parentRow.responseRecord.expanded[expansion.name] = {
      data: sliced.map((row) => childResponseRecord({ fields: childFields, row, stream: childStream })),
      has_more: matches.length > expansion.limit,
      object: "list",
    };
  }
}

async function hydratePostgresExpansion({
  connectorInstanceId,
  expansion,
  parentRows,
  manifest,
}: {
  connectorInstanceId: string;
  expansion: ExpansionEntry;
  parentRows: ResponseRow[];
  manifest: ConnectorManifest | null;
}): Promise<void> {
  if (!parentRows.length) {
    return;
  }

  const { childEffective, childFields, childStream, consentTimeField, cursorField, foreignKeyField, primaryKeyField } =
    resolvePostgresExpansionFields(expansion, manifest);

  const fkExpr = jsonStringExpr(foreignKeyField);
  const pkExpr = jsonStringExpr(primaryKeyField);

  // Build ORDER BY: cursor first (nulls last), then primary key.
  const orderByParts: string[] = [];
  if (cursorField) {
    const cursorExpr = jsonStringExpr(cursorField);
    orderByParts.push(`${cursorExpr} ASC NULLS LAST`);
  }
  orderByParts.push(`${pkExpr} ASC`);
  const orderBySql = orderByParts.join(", ");

  const params: unknown[] = [connectorInstanceId, childStream];
  const whereParts = ["connector_instance_id = $1", "stream = $2", "deleted = FALSE"];

  if (childEffective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, "consent_time_field");
    const ctExpr = jsonStringExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (childEffective.timeRange.since !== null && childEffective.timeRange.since !== undefined) {
      params.push(new Date(childEffective.timeRange.since).toISOString());
      whereParts.push(`${ctExpr} >= $${params.length}`);
    }
    if (childEffective.timeRange.until !== null && childEffective.timeRange.until !== undefined) {
      params.push(new Date(childEffective.timeRange.until).toISOString());
      whereParts.push(`${ctExpr} < $${params.length}`);
    }
  }

  if (childEffective.resources && childEffective.resources.length > 0) {
    params.push(childEffective.resources);
    whereParts.push(`record_key = ANY($${params.length}::text[])`);
  }

  // Parent foreign-key narrowing — one batched IN-list per relation.
  const parentKeys = parentRows.map((row) => row.record_key);
  params.push(parentKeys);
  whereParts.push(`${fkExpr} = ANY($${params.length}::text[])`);

  // Per-partition cap.
  //   has_one  → rn = 1   (take one per parent).
  //   has_many → rn <= limit + 1   (+1 gives the caller a `has_more` signal).
  const rankBound = expansion.relationship.cardinality === "has_one" ? 1 : expansion.limit + 1;
  params.push(rankBound);

  const sql = `
      WITH ranked AS (
        SELECT
          record_key,
          record_json,
          emitted_at,
          ${fkExpr} AS __fk,
          ROW_NUMBER() OVER (
            PARTITION BY ${fkExpr}
            ORDER BY ${orderBySql}
          ) AS __rn
        FROM records
        WHERE ${whereParts.join(" AND ")}
      )
      SELECT record_key, record_json, emitted_at, __fk
      FROM ranked
      WHERE __rn <= $${params.length}
    `;

  const result = await postgresQuery(sql, params);

  attachPostgresExpansionRows(expansion, parentRows, childFields, childStream, result.rows);
}

/**
 * Atomically allocate the next stream version for a
 * `(connector_instance_id, stream)` pair, strictly above every durable
 * floor: the `version_counter` row, the max retained `record_changes`
 * version, and the max current `records` version.
 *
 * The plain `max_version + 1` counter bump is unsafe whenever the counter
 * has fallen *behind* the durable history/current state — observed live as
 * GitHub current-projection drift where `records.version` and
 * `record_changes.version` were already ahead of `version_counter.max_version`
 * (counter lagging by one). An unanchored-row self-heal then re-allocated an
 * already-used stream version, and the subsequent `record_changes` insert
 * collided on `PRIMARY KEY(connector_instance_id, stream, version)`, rejecting
 * the row inside an otherwise-"succeeded" batch.
 *
 * Construction (single statement, concurrency-safe):
 *   - `GREATEST(counter, max(record_changes.version), max(records.version))+1`
 *     is computed in one INSERT…ON CONFLICT…RETURNING. The two `MAX`
 *     subqueries are correlated to the scoped pair and `COALESCE`d to 0 so an
 *     empty history/current set degrades to the pure counter behavior.
 *   - On first allocation (no conflicting row) the floor is taken in the
 *     `VALUES` subselects; on conflict the `ON CONFLICT DO UPDATE` re-reads
 *     `version_counter.max_version` (now row-locked) and folds the same two
 *     floors back in.
 *   - Two concurrent allocators serialize on the `version_counter` row lock
 *     the upsert takes, and `version_counter.max_version` is always part of
 *     the `GREATEST`, so the second allocator observes the first's committed
 *     increment and cannot return the same version. The history/current
 *     floors only ever raise the result; they never let it repeat.
 *
 * Mirrors the SQLite reference allocator's intent (single durable
 * statement, no read-then-write window); the floor folding is Postgres-only
 * because the live drift was Postgres-only.
 */
async function allocateNextVersion(
  client: PgClient,
  connectorId: string,
  connectorInstanceId: string,
  stream: string
): Promise<number> {
  const result = await client.query(
    `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
     VALUES (
       $1, $2, $3,
       GREATEST(
         1,
         COALESCE((SELECT MAX(version) FROM record_changes
                    WHERE connector_instance_id = $2 AND stream = $3), 0) + 1,
         COALESCE((SELECT MAX(version) FROM records
                    WHERE connector_instance_id = $2 AND stream = $3), 0) + 1
       )
     )
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET max_version = GREATEST(
             version_counter.max_version,
             COALESCE((SELECT MAX(version) FROM record_changes
                        WHERE connector_instance_id = version_counter.connector_instance_id
                          AND stream = version_counter.stream), 0),
             COALESCE((SELECT MAX(version) FROM records
                        WHERE connector_instance_id = version_counter.connector_instance_id
                          AND stream = version_counter.stream), 0)
           ) + 1
     RETURNING max_version`,
    [connectorId, connectorInstanceId, stream]
  );
  const allocated = result.rows[0]?.max_version;
  if (allocated === null) {
    throw new Error("Postgres version allocation returned no version");
  }
  return Number(allocated);
}

async function repairPostgresIdenticalIngest({
  client,
  connectorInstanceId,
  current,
  options,
  recordKey,
  stream,
  storedCursorValue,
  storedPrimaryKeyText,
  storedSemanticTime,
}: {
  client: PgClient;
  connectorInstanceId: string;
  current: PgRow | null;
  options: IngestOptions;
  recordKey: string;
  stream: string;
  storedCursorValue: string | null;
  storedPrimaryKeyText: string;
  storedSemanticTime: string | null;
}): Promise<"noop" | "normal" | "self_heal"> {
  if (!current || current.deleted || !current.is_identical) {
    return "normal";
  }
  const anchorResult = await client.query(
    `SELECT 1 FROM record_changes
      WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND version = $4
      LIMIT 1`,
    [connectorInstanceId, stream, recordKey, current.version]
  );
  if (anchorResult.rows.length === 0) {
    return "self_heal";
  }
  if (options.attemptContext) {
    await client.query(
      `UPDATE records
          SET cursor_value = $4,
              primary_key_text = $5,
              semantic_time = $6
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
          AND deleted = FALSE`,
      [connectorInstanceId, stream, recordKey, storedCursorValue, storedPrimaryKeyText, storedSemanticTime]
    );
  }
  return "noop";
}

async function prunePostgresRecordChanges({
  changeHistoryLimit,
  client,
  connectorInstanceId,
  nextVersion,
  stream,
}: {
  changeHistoryLimit: number;
  client: PgClient;
  connectorInstanceId: string;
  nextVersion: number;
  stream: string;
}): Promise<{ bytes: number; rows: number }> {
  if (changeHistoryLimit <= 0) {
    return { bytes: 0, rows: 0 };
  }
  const cutoff = nextVersion - changeHistoryLimit;
  const pruned = await client.query(
    `SELECT COUNT(*)::bigint AS count,
            COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS bytes
       FROM record_changes rc
      WHERE rc.connector_instance_id = $1 AND rc.stream = $2 AND rc.version <= $3
        AND NOT EXISTS (
          SELECT 1 FROM records r
           WHERE r.connector_instance_id = rc.connector_instance_id
             AND r.stream = rc.stream
             AND r.record_key = rc.record_key
             AND r.version = rc.version
        )`,
    [connectorInstanceId, stream, cutoff]
  );
  await client.query(
    `DELETE FROM record_changes rc
     WHERE rc.connector_instance_id = $1 AND rc.stream = $2 AND rc.version <= $3
       AND NOT EXISTS (
         SELECT 1 FROM records r
          WHERE r.connector_instance_id = rc.connector_instance_id
            AND r.stream = rc.stream
            AND r.record_key = rc.record_key
            AND r.version = rc.version
       )`,
    [connectorInstanceId, stream, cutoff]
  );
  return {
    bytes: Number(pruned.rows[0]?.bytes || 0),
    rows: Number(pruned.rows[0]?.count || 0),
  };
}

async function resolvePostgresIngestManifestStream(
  connectorId: string,
  stream: string,
  attemptStreamFacts: ManifestStream | null
): Promise<ManifestStream | null> {
  return attemptStreamFacts ?? (await getCachedPostgresManifestStream(connectorId, stream));
}

async function writePostgresIngestMutation({
  client,
  connectorId,
  connectorInstanceId,
  effectiveEmittedAt,
  nextVersion,
  op,
  recordJson,
  recordKey,
  stream,
  storedCursorValue,
  storedPrimaryKeyText,
  storedSemanticTime,
  current,
}: {
  client: PgClient;
  connectorId: string | null;
  connectorInstanceId: string;
  effectiveEmittedAt: string;
  nextVersion: number;
  op: "upsert" | "delete";
  recordJson: string | null;
  recordKey: string;
  stream: string;
  storedCursorValue: string | null;
  storedPrimaryKeyText: string;
  storedSemanticTime: string | null;
  current: PgRow | null;
}): Promise<number> {
  let nextRecordJsonBytes = 0;
  if (op === "delete") {
    await client.query(
      `UPDATE records
       SET connector_id = $6, deleted = TRUE, deleted_at = $4, emitted_at = $4, version = $5
       WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
      [connectorInstanceId, stream, recordKey, effectiveEmittedAt, nextVersion, connectorId]
    );
    await client.query(
      `INSERT INTO record_changes
         (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, TRUE, $7)`,
      [
        connectorId,
        connectorInstanceId,
        stream,
        recordKey,
        nextVersion,
        JSON.stringify(current?.record_json),
        effectiveEmittedAt,
      ]
    );
  } else {
    const stored = await client.query(
      `INSERT INTO records
         (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text, semantic_time)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $8, $9, $10)
       ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE
         SET connector_id = EXCLUDED.connector_id,
             record_json = EXCLUDED.record_json,
             emitted_at = EXCLUDED.emitted_at,
             version = EXCLUDED.version,
             deleted = FALSE,
             deleted_at = NULL,
             cursor_value = EXCLUDED.cursor_value,
             primary_key_text = EXCLUDED.primary_key_text,
             semantic_time = EXCLUDED.semantic_time
       RETURNING COALESCE(octet_length(record_json::text), 0)::bigint AS record_json_bytes`,
      [
        connectorId,
        connectorInstanceId,
        stream,
        recordKey,
        recordJson,
        effectiveEmittedAt,
        nextVersion,
        storedCursorValue,
        storedPrimaryKeyText,
        storedSemanticTime,
      ]
    );
    nextRecordJsonBytes = Number(stored.rows[0]?.record_json_bytes || 0);
    await client.query(
      `INSERT INTO record_changes
         (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
      [connectorId, connectorInstanceId, stream, recordKey, nextVersion, recordJson, effectiveEmittedAt]
    );
  }

  return nextRecordJsonBytes;
}

export async function postgresIngestRecord(
  storageTarget: StorageTarget,
  record: IngestRecord,
  options: IngestOptions = {}
): Promise<IngestOutcome> {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId ?? "");
  const { stream, key, data, emitted_at: emittedAt, op = "upsert" } = record;
  const recordKey = encodeKey(key);
  const recordJson = data ? JSON.stringify(data) : null;

  // Validate record identity against the manifest-declared primary_key (covers
  // non-`id` and compound keys), via the same shared guard the SQLite store
  // uses. Falls back to the legacy data.id check when no primary_key is known.
  const attemptStreamFacts = options.attemptContext?.streams?.[stream] ?? null;
  const resolvedConnectorId = connectorId ?? "";
  const identityManifestStream = await resolvePostgresIngestManifestStream(
    resolvedConnectorId,
    stream,
    attemptStreamFacts ? manifestStreamFromFacts(attemptStreamFacts) : null
  );
  assertRecordIdentity(normalizePrimaryKey(identityManifestStream?.primary_key), key, data ?? null);

  const effectiveEmittedAt = emittedAt || nowIso();
  const changeHistoryLimit = getChangeHistoryLimit();
  let manifestStream: ManifestStream | null = null;
  if (op !== "delete") {
    manifestStream = attemptStreamFacts
      ? manifestStreamFromFacts(attemptStreamFacts)
      : await getCachedPostgresManifestStream(resolvedConnectorId, stream);
  }
  const storedCursorValue = op === "delete" ? null : cursorValue(data ?? null, manifestStream);
  const storedPrimaryKeyText = op === "delete" ? recordKey : primaryKeyText(data ?? null, recordKey, manifestStream);
  // SEMANTIC time for the Explore merged-timeline sort (upserts only; a delete
  // keeps the row's existing semantic_time). Falls back to emitted_at.
  const storedSemanticTime =
    op === "delete" ? null : semanticTimeValue(data ?? null, manifestStream, effectiveEmittedAt);

  const outcome = await withPostgresTransaction<DurableIngestOutcome>(async (client) => {
    if (options.requireConnectionAdmission) {
      const admission = await client.query<{ status: string }>(
        "SELECT status FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
        [connectorInstanceId]
      );
      assertConnectorInstanceWritableStatus(admission.rows[0]?.status ?? null, connectorInstanceId);
      await maybePostgresAdmissionLockedPhase("after-connector-instance-admission-lock", { connectorInstanceId });
    }
    const finishDurableOutcome = async (value: DurableIngestOutcome): Promise<DurableIngestOutcome> => {
      if (options.deviceReservation) {
        await advancePostgresDeviceIngestPrefix(
          client,
          options.deviceReservation,
          options.deviceReservation.inputIndex
        );
      }
      return value;
    };
    // No-op equivalence is computed at the `jsonb` level via a server-side
    // `record_json = $::jsonb` comparison. The naive `JSON.stringify` of
    // the JS object node-postgres parses out of jsonb does not round-trip
    // to the bytes the connector emitted: Postgres' `::text` output adds
    // whitespace and the parsed object's key order matches Postgres'
    // internal storage. Either gap silently turns identical re-ingests
    // into version churn, observed in production as Slack `workspace`
    // accumulating 31k+ versions of the same payload. `jsonb` equality is
    // structural and ignores both incidental layout differences.
    const currentResult = await client.query(
      `SELECT record_json,
              deleted,
              version,
              COALESCE(octet_length(record_json::text), 0)::bigint AS record_json_bytes,
              ($4::jsonb IS NOT DISTINCT FROM record_json) AS is_identical
       FROM records
       WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
       FOR UPDATE`,
      [connectorInstanceId, stream, recordKey, recordJson]
    );
    const current = currentResult.rows[0] || null;

    if (op === "delete" && (!current || current.deleted)) {
      return finishDurableOutcome({ kind: "noop" });
    }

    const ingestDisposition =
      op === "delete"
        ? "normal"
        : await repairPostgresIdenticalIngest({
            client,
            connectorInstanceId,
            current,
            options,
            recordKey,
            storedCursorValue,
            storedPrimaryKeyText,
            storedSemanticTime,
            stream,
          });
    if (ingestDisposition === "noop") {
      return finishDurableOutcome({ kind: "noop" });
    }
    const selfHeal = ingestDisposition === "self_heal";

    const nextVersion = await allocateNextVersion(client, resolvedConnectorId, connectorInstanceId, stream);
    const currentRecordJsonBytes = current && !current.deleted ? Number(current.record_json_bytes || 0) : 0;
    const nextRecordJsonBytes = await writePostgresIngestMutation({
      client,
      connectorId,
      connectorInstanceId,
      current,
      effectiveEmittedAt,
      nextVersion,
      op,
      recordJson,
      recordKey,
      storedCursorValue,
      storedPrimaryKeyText,
      storedSemanticTime,
      stream,
    });

    const insertedChangeJsonBytes = op === "delete" ? currentRecordJsonBytes : nextRecordJsonBytes;
    const { bytes: prunedBytesForDelta, rows: prunedRowsForDelta } = await prunePostgresRecordChanges({
      changeHistoryLimit,
      client,
      connectorInstanceId,
      nextVersion,
      stream,
    });

    return finishDurableOutcome({
      kind: "changed",
      op,
      retainedSizeDelta: {
        connectorId,
        connectorInstanceId,
        currentRecordJsonBytesDelta:
          op === "delete" ? -currentRecordJsonBytes : nextRecordJsonBytes - currentRecordJsonBytes,
        recordCountDelta: (() => {
          if (op === "delete") {
            return -1;
          }
          if (current?.deleted) {
            return 1;
          }
          return current ? 0 : 1;
        })(),
        recordHistoryCountDelta: 1 - prunedRowsForDelta,
        recordHistoryJsonBytesDelta: insertedChangeJsonBytes - prunedBytesForDelta,
        stream,
      },
      selfHeal,
      version: nextVersion,
    });
  });

  if (outcome.kind === "noop") {
    return { accepted: true, changed: false };
  }
  // Preserve the version allocated by the authoritative transaction until the
  // composition seam has emitted its after-commit notification.  HTTP callers
  // do not serialize this adapter result, but dropping the field here made
  // every PostgreSQL notification publish version 0 while SQLite published the
  // real stream version.
  const result: IngestOutcome = {
    accepted: true,
    changed: true,
    ...(outcome.retainedSizeDelta ? { retainedSizeDelta: outcome.retainedSizeDelta } : {}),
    ...(outcome.version === undefined ? {} : { version: outcome.version }),
  };
  if (outcome.selfHeal) {
    result.self_healed = true;
  }
  return result;
}

export function postgresDeleteRecord(
  storageTarget: StorageTarget,
  stream: string,
  recordId: string
): Promise<IngestOutcome> {
  return postgresIngestRecord(storageTarget, {
    data: {},
    key: decodeKey(recordId),
    op: "delete",
    stream,
  });
}

interface RecordListResponse extends JsonObject {
  data: ResponseRecord[];
  has_more: boolean;
  meta?: JsonObject;
  next_changes_since?: string;
  next_cursor?: string;
  object: "list";
}

async function visiblePostgresChange({
  row,
  connectorInstanceId,
  stream,
  decodedVersion,
  effective,
  consentTimeField,
  compiledFilters,
  identity,
}: {
  row: PgRow;
  connectorInstanceId: string;
  stream: string;
  decodedVersion: number;
  effective: EffectiveFilter;
  consentTimeField: string | null;
  compiledFilters: Parameters<typeof passesRequestFilters>[1];
  identity: RecordIdentity | null;
}): Promise<ResponseRecord | null> {
  const previous = await getPostgresSnapshotAtVersion(connectorInstanceId, stream, row.record_key, decodedVersion);
  const current = await getPostgresSnapshotAtVersion(connectorInstanceId, stream, row.record_key, Number(row.version));
  const previousVisible = isVisiblePostgresSnapshot(previous, effective, consentTimeField);
  const currentVisible = isVisiblePostgresSnapshot(current, effective, consentTimeField);
  if (row.deleted) {
    return previous && previousVisible && passesRequestFilters(previous.data, compiledFilters)
      ? deletedResponseRecord({ identity, row, stream })
      : null;
  }
  if (!(current && currentVisible && passesRequestFilters(current.data, compiledFilters))) {
    return null;
  }
  const fields = effective.fields ?? null;
  const previousProjection = previous && previousVisible ? projectFields(previous.data, fields) : null;
  const currentProjection = projectFields(current.data, fields);
  if (previousProjection && JSON.stringify(previousProjection) === JSON.stringify(currentProjection)) {
    return null;
  }
  return responseRecord({
    fields: null,
    identity,
    row: { ...row, record_json: currentProjection },
    stream,
  });
}

async function queryPostgresChangesSince({
  compiledFilters,
  connectorInstanceId,
  effective,
  identity,
  manifestStream,
  requestParams,
  requestWarnings,
  stream,
}: {
  compiledFilters: Parameters<typeof passesRequestFilters>[1];
  connectorInstanceId: string;
  effective: EffectiveFilter;
  identity: RecordIdentity | null;
  manifestStream: ManifestStream | null;
  requestParams: QueryRequestParams;
  requestWarnings: unknown[];
  stream: string;
}): Promise<RecordListResponse> {
  rejectListOnlyParamsForChangesFeed(requestParams);
  const changesSince = requestParams.changes_since;
  const decoded = changesSince === "beginning" ? { v: 0 } : decodeCursor(changesSince ?? "");
  const decodedVersion = decoded && typeof decoded.v === "number" ? decoded.v : null;
  if (decodedVersion === null || !Number.isInteger(decodedVersion)) {
    const err: PgQueryError = new Error("Malformed changes_since cursor");
    err.code = "invalid_cursor";
    throw err;
  }
  const maxResult = await postgresQuery(
    "SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2",
    [connectorInstanceId, stream]
  );
  const sessionMax = maxResult.rows[0] ? Number(maxResult.rows[0].max_version) : 0;
  const minChangeResult = await postgresQuery(
    `SELECT MIN(version)::bigint AS min_version
       FROM record_changes
      WHERE connector_instance_id = $1 AND stream = $2`,
    [connectorInstanceId, stream]
  );
  const minVersion =
    minChangeResult.rows[0]?.min_version === null || minChangeResult.rows[0]?.min_version === undefined
      ? null
      : Number(minChangeResult.rows[0].min_version);
  if (minVersion !== null && decodedVersion < minVersion - 1) {
    const err: PgQueryError = new Error("changes_since cursor is too old; full re-sync required");
    err.code = "cursor_expired";
    throw err;
  }
  const rows = await postgresQuery(
    `SELECT DISTINCT ON (record_key)
            record_key, record_json, deleted, deleted_at, emitted_at, version
     FROM record_changes
     WHERE connector_instance_id = $1 AND stream = $2
       AND version > $3 AND version <= $4
     ORDER BY record_key, version DESC`,
    [connectorInstanceId, stream, decodedVersion, sessionMax]
  );
  const sorted = [...rows.rows].sort((a, b) => Number(a.version) - Number(b.version));
  const consentTimeField = manifestStream?.consent_time_field || null;
  const visibleChanges: ResponseRecord[] = [];
  await sorted.reduce(async (previous, row) => {
    await previous;
    const visible = await visiblePostgresChange({
      compiledFilters,
      connectorInstanceId,
      consentTimeField,
      decodedVersion,
      effective,
      identity,
      row,
      stream,
    });
    if (visible) {
      visibleChanges.push(visible);
    }
  }, Promise.resolve());
  const response: RecordListResponse = {
    data: visibleChanges,
    has_more: false,
    next_changes_since: encodeCursor({ v: sessionMax }),
    object: "list",
  };
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

async function queryPostgresRecordPage({
  connectorInstanceId,
  countParams,
  countWhere,
  cursorSql,
  effective,
  expansions,
  fields,
  identity,
  limit,
  manifest,
  manifestStream,
  order,
  primarySql,
  requestParams,
  requestWarnings,
  stream,
}: {
  connectorInstanceId: string;
  countParams: unknown[];
  countWhere: string;
  cursorSql: string;
  effective: EffectiveFilter;
  expansions: ExpansionEntry[];
  fields: string[] | null;
  identity: RecordIdentity | null;
  limit: number;
  manifest: ConnectorManifest | null;
  manifestStream: ManifestStream | null;
  order: "asc" | "desc";
  primarySql: string;
  requestParams: QueryRequestParams;
  requestWarnings: unknown[];
  stream: string;
}): Promise<RecordListResponse> {
  let cursorPosition: JsonObject | null = null;
  if (requestParams.cursor) {
    cursorPosition = decodeCursor(requestParams.cursor);
    if (cursorPosition?.k !== "pg:records" || cursorPosition.order !== order) {
      const err: PgQueryError = new Error("Malformed cursor");
      err.code = "invalid_cursor";
      throw err;
    }
  }
  const params: unknown[] = [...countParams];
  let where = countWhere;
  if (cursorPosition) {
    params.push(cursorPosition.cursor_value, cursorPosition.primary_key_text);
    if (order === "asc") {
      where += ` AND (
        (${cursorSql} = $${params.length - 1} AND ${primarySql} > $${params.length})
        OR (${cursorSql} IS NOT NULL AND ${cursorSql} > $${params.length - 1})
        OR (${cursorSql} IS NULL AND $${params.length - 1} IS NOT NULL)
      )`;
    } else {
      where += ` AND (
        (${cursorSql} = $${params.length - 1} AND ${primarySql} < $${params.length})
        OR (${cursorSql} IS NOT NULL AND ${cursorSql} < $${params.length - 1})
      )`;
    }
  }
  const dir = order === "asc" ? "ASC" : "DESC";
  const nulls = order === "asc" ? "NULLS LAST" : "NULLS FIRST";
  params.push(limit + 1);
  const result = await postgresQuery(
    `SELECT record_key, record_json, emitted_at,
            ${cursorSql} AS cursor_value,
            ${primarySql} AS primary_key_text
     FROM records
     ${where}
     ORDER BY ${cursorSql} ${dir} ${nulls}, ${primarySql} ${dir}
     LIMIT $${params.length}`,
    params
  );
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  const responseRows = pageRows.map((row) => ({
    record_key: row.record_key,
    responseRecord: responseRecord({ fields, identity, row, stream }),
  }));
  await hydratePostgresExpandedRelations({ connectorInstanceId, expansions, manifest, parentRows: responseRows });
  const response: RecordListResponse = {
    data: responseRows.map((entry) => entry.responseRecord),
    has_more: hasMore,
    object: "list",
  };
  if (hasMore && pageRows.length > 0) {
    const last = pageRows.at(-1);
    if (!last) {
      throw new Error("Postgres records page unexpectedly had no last row");
    }
    response.next_cursor = encodeCursor({
      cursor_value: last.cursor_value ?? null,
      k: "pg:records",
      order,
      primary_key_text: last.primary_key_text,
    });
  }
  const countOutcome = await computePostgresGradedRecordCount({
    connectorInstanceId,
    countParams,
    countWhere,
    effective,
    requestParams,
    stream,
  });
  if (countOutcome) {
    response.meta = mergeMetaCount(response.meta, countOutcome.count);
  }
  const windowOutcome = await computePostgresRecordWindow({
    consentTimeField: manifestStream?.consent_time_field || null,
    countParams,
    countWhere,
    requestParams,
  });
  if (windowOutcome) {
    response.meta = mergeMetaWindow(response.meta, windowOutcome);
  }
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

export async function postgresQueryRecords(
  storageTarget: StorageTarget,
  stream: string,
  grant: ConnectorGrant,
  requestParams: QueryRequestParams = {},
  manifest: ConnectorManifest | null = null
): Promise<RecordListResponse> {
  assertManifestReadAuthority(manifest, stream, { actor: "internal" });
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId ?? "");
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const fields = fieldsFor(streamGrant, requestParams.fields, requiredFieldsFor(manifestStream));
  const effective = buildEffectiveFilter(
    streamGrant,
    {},
    requiredFieldsFor(manifestStream)
  ) as unknown as EffectiveFilter;
  effective.fields = fields;
  const compiledFilters = compileRequestFilters(requestParams.filter, streamGrant, manifestStream ?? {});
  const { cursorSql, primarySql } = recordOrderExpressions(manifestStream);

  // Canonical contract enforcement: `count` and `sort` go through the same
  // validation discipline as the SQLite reference path, regardless of
  // which branch (changes_since vs. paginated list) we end up taking.
  // `sort` (sign-prefix over the advertised cursor field) controls
  // direction; legacy `order=` is honored only when `sort` is absent. If
  // both disagree we reject with `invalid_sort` rather than silently
  // picking one — the public-read contract forbids silent no-ops.
  //
  // Spec: openspec/changes/canonicalize-public-read-contract/specs/
  //       reference-implementation-architecture/spec.md
  //       (#"Sort", #"Counts").
  validateCountKind(requestParams.count);
  // Validate the `window` opt-in with the same strict discipline as `count`.
  // A valid `window=exact` produces `meta.window` to parity with SQLite via
  // computePostgresRecordWindow below.
  validateWindowKind(requestParams.window);
  const resolvedSort = validateCanonicalSort(requestParams.sort, manifestStream);
  const orderDirection = resolveListOrder(requestParams.order, resolvedSort);
  const order = orderDirection === "ASC" ? "asc" : "desc";
  const { limit, clamped: limitClamped, requested: requestedLimit } = clampRecordsPageLimit(requestParams.limit);
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  if (limitClamped && requestedLimit !== null) {
    requestWarnings.push(buildLimitClampedWarning(requestedLimit));
  }
  enforceConnectionNarrowing(requestParams, connectorInstanceId);
  const identity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);

  rejectExpandWithChangesSince(requestParams);
  // Resolve and validate expansions up front so misuse rejects before any
  // SQL runs. SQLite path does the same in records.ts#normalizeExpandRequest.
  const expansions = normalizeExpandRequest(
    requestParams as Parameters<typeof normalizeExpandRequest>[0],
    stream,
    grant,
    manifestStream as unknown as Parameters<typeof normalizeExpandRequest>[3],
    order === "asc" ? "ASC" : "DESC"
  );

  if (requestParams.changes_since !== null && requestParams.changes_since !== undefined) {
    return queryPostgresChangesSince({
      compiledFilters,
      connectorInstanceId,
      effective,
      identity,
      manifestStream,
      requestParams,
      requestWarnings,
      stream,
    });
  }

  const params: unknown[] = [connectorInstanceId, stream];
  const whereParts = ["connector_instance_id = $1", "stream = $2", "deleted = FALSE"];
  appendGrantVisibilityClauses(whereParts, params, effective, manifestStream);
  let where = `WHERE ${whereParts.join(" AND ")}`;
  where += buildFilterClause(compiledFilters, requestParams.filter, params);
  // Snapshot the filter-only WHERE clause / params for the graded-count
  // query. The count MUST reflect matching visible rows BEFORE pagination
  // or the cursor — matching the SQLite semantics in
  // `countVisibleRecordsForStream` — so the cursor narrowing below is
  // intentionally excluded.
  const countWhere = where;
  const countParams = [...params];

  return queryPostgresRecordPage({
    connectorInstanceId,
    countParams,
    countWhere,
    cursorSql,
    effective,
    expansions,
    fields,
    identity,
    limit,
    manifest,
    manifestStream,
    order,
    primarySql,
    requestParams,
    requestWarnings,
    stream,
  });
}

// Compute the bounded `meta.window` aggregate for the Postgres list path,
// mirroring computeRecordWindow in records.ts: `total` is the count of
// grant-visible rows under the same WHERE clause as the graded count, and
// `earliest_at`/`latest_at` are the min/max of the manifest's
// consent_time_field over those rows. Returns null when window is not
// requested. Closes the parity gap where the Postgres path omitted meta.window.
async function computePostgresRecordWindow({
  requestParams,
  countWhere,
  countParams,
  consentTimeField,
}: {
  requestParams: QueryRequestParams;
  countWhere: string;
  countParams: unknown[];
  consentTimeField: string | null;
}): Promise<JsonObject | null> {
  const requested = typeof requestParams.window === "string" ? requestParams.window : null;
  if (!requested || requested === "none") {
    return null;
  }

  // total uses the identical grant-visible scope the count query uses.
  const totalResult = await postgresQuery(`SELECT COUNT(*)::bigint AS total FROM records ${countWhere}`, countParams);
  const total = Number(totalResult.rows[0]?.total || 0);
  const window: JsonObject = { total };

  if (consentTimeField) {
    assertSafeJsonField(consentTimeField, "consent_time_field");
    const ctExpr = jsonStringExpr(consentTimeField);
    // MIN/MAX must compare CHRONOLOGICALLY, not lexicographically. Plain text
    // MIN/MAX picks the wrong bound for non-UTC offsets (e.g. a "...T00:00-07:00"
    // string sorts before "...T06:00+00:00" textually but is later in time), and
    // a lexically-small non-date string (e.g. "-bad-date") would win MIN and
    // then fail to parse, silently dropping bounds. Cast to timestamptz so
    // Postgres orders by instant, and use pg_input_is_valid so unparseable rows
    // are skipped instead of aborting the query, mirroring the SQLite path's
    // per-row `Number.isNaN(...) ? continue` behavior. timestamptz results come
    // back UTC-normalized, so downstream new Date(...).toISOString() is correct.
    const validTimestamp = `pg_input_is_valid(${ctExpr}, 'timestamp with time zone')`;
    const boundsResult = await postgresQuery(
      `SELECT MIN((${ctExpr})::timestamptz) AS earliest, MAX((${ctExpr})::timestamptz) AS latest
         FROM records ${countWhere}
        AND ${ctExpr} IS NOT NULL AND ${ctExpr} <> '' AND ${validTimestamp}`,
      countParams
    );
    const earliest = boundsResult.rows[0]?.earliest;
    const latest = boundsResult.rows[0]?.latest;
    if (
      (typeof earliest === "string" || earliest instanceof Date) &&
      (typeof latest === "string" || latest instanceof Date)
    ) {
      // Normalize to ISO 8601 UTC, matching the SQLite path's new Date(...) form.
      const earliestMs = earliest instanceof Date ? earliest.getTime() : new Date(earliest).getTime();
      const latestMs = latest instanceof Date ? latest.getTime() : new Date(latest).getTime();
      if (!(Number.isNaN(earliestMs) || Number.isNaN(latestMs))) {
        window.earliest_at = new Date(earliestMs).toISOString();
        window.latest_at = new Date(latestMs).toISOString();
      }
    }
  }
  return window;
}

/**
 * Compute the requested graded count for a Postgres-backed records list
 * response. Mirrors `computeGradedRecordCount` in records.ts:
 *
 *   - absent or `none`: return `null` (callers omit `meta.count`).
 *   - `exact`:     `{ count: { kind: 'exact', value } }`.
 *   - `estimated`: `{ count: { kind: 'exact', value } }` (silent upgrade).
 *
 * `count_downgraded` is reserved for the strict case where the server
 * actually returns a *lower* grade than requested. Returning a
 * higher-fidelity grade than asked for is not a downgrade, so this
 * helper does not emit a warning either.
 *
 * The count uses the filter-only WHERE clause (no cursor narrowing), so
 * the value reflects matching visible rows BEFORE pagination — matching
 * the SQLite semantics of `countVisibleRecordsForStream`.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract design.md
 *       (#"Counts") and specs/reference-implementation-architecture/
 *       spec.md (#"Requested count is downgraded").
 */
function hasRequestFilters(requestParams: QueryRequestParams): boolean {
  const { filter } = requestParams;
  return !!filter && typeof filter === "object" && !Array.isArray(filter) && Object.keys(filter).length > 0;
}

async function readProjectedRecordCount({
  connectorInstanceId,
  stream,
  requestParams,
  effective,
}: {
  connectorInstanceId: string;
  stream: string;
  requestParams: QueryRequestParams;
  effective: EffectiveFilter;
}): Promise<number | null> {
  if (hasRequestFilters(requestParams)) {
    return null;
  }
  if (effective.timeRange) {
    return null;
  }
  if (Array.isArray(effective.resources) && effective.resources.length > 0) {
    return null;
  }

  const result = await postgresQuery(
    `SELECT record_count
       FROM retained_size_stream
      WHERE connector_instance_id = $1
        AND stream = $2
        AND dirty = 0`,
    [connectorInstanceId, stream]
  );
  const value = Number(result.rows[0]?.record_count);
  return Number.isFinite(value) ? value : null;
}

async function computePostgresGradedRecordCount({
  requestParams,
  countWhere,
  countParams,
  connectorInstanceId,
  stream,
  effective,
}: {
  requestParams: QueryRequestParams;
  countWhere: string;
  countParams: unknown[];
  connectorInstanceId: string;
  stream: string;
  effective: EffectiveFilter;
}): Promise<{ count: { kind: "exact"; value: number } } | null> {
  const requested = typeof requestParams.count === "string" ? requestParams.count : null;
  if (!requested || requested === "none") {
    return null;
  }

  const projectedValue = await readProjectedRecordCount({
    connectorInstanceId,
    effective,
    requestParams,
    stream,
  });
  if (projectedValue !== null) {
    return { count: { kind: "exact", value: projectedValue } };
  }

  const result = await postgresQuery(`SELECT COUNT(*)::bigint AS value FROM records ${countWhere}`, countParams);
  const value = Number(result.rows[0]?.value || 0);

  if (requested === "exact" || requested === "estimated") {
    return { count: { kind: "exact", value } };
  }
  return null;
}

/**
 * Attach a `meta.warnings[]` envelope to a public-read response only when
 * the runtime has non-empty structured warnings to surface. Mirrors
 * `attachRequestWarningsToResponse` in records.ts.
 */
function attachRequestWarningsToResponse(response: JsonObject, warnings: unknown[]): void {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return;
  }
  const existingMeta: JsonObject | null =
    response.meta && typeof response.meta === "object" && !Array.isArray(response.meta)
      ? (response.meta as JsonObject)
      : null;
  const existingWarnings = existingMeta && Array.isArray(existingMeta.warnings) ? existingMeta.warnings : [];
  response.meta = {
    ...(existingMeta || {}),
    warnings: [...existingWarnings, ...warnings],
  };
}

export async function postgresGetRecord(
  storageTarget: StorageTarget,
  stream: string,
  recordId: string,
  grant: ConnectorGrant,
  manifest: ConnectorManifest | null = null,
  requestParams: QueryRequestParams = {}
): Promise<ResponseRecord> {
  assertManifestReadAuthority(manifest, stream, { actor: "internal" });
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId ?? "");
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const fields = fieldsFor(streamGrant, null, requiredFieldsFor(manifestStream));
  const effective = buildEffectiveFilter(
    streamGrant,
    {},
    requiredFieldsFor(manifestStream)
  ) as unknown as EffectiveFilter;
  effective.fields = fields;
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);
  // Single-record fetch does not support changes_since, so only validate
  // expansion request shape here.
  const expansions = normalizeExpandRequest(
    requestParams as Parameters<typeof normalizeExpandRequest>[0],
    stream,
    grant,
    manifestStream as unknown as Parameters<typeof normalizeExpandRequest>[3],
    "ASC"
  );
  const result = await postgresQuery(
    `SELECT record_key, record_json, emitted_at
     FROM records
     WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
    [connectorInstanceId, stream, recordId]
  );
  const [row] = result.rows;
  if (!row) {
    const err: PgQueryError = new Error("Record not found");
    err.code = "not_found";
    throw err;
  }
  if (effective.resources && !effective.resources.includes(row.record_key)) {
    const err: PgQueryError = new Error("Record not found");
    err.code = "not_found";
    throw err;
  }
  if (effective.timeRange && manifestStream?.consent_time_field) {
    const rawData = typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
    if (!passesTimeRange(rawData, effective.timeRange, manifestStream.consent_time_field)) {
      const err: PgQueryError = new Error("Record not found");
      err.code = "not_found";
      throw err;
    }
  }
  const identity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);
  const response = responseRecord({ fields, identity, row, stream });
  if (expansions.length) {
    await hydratePostgresExpandedRelations({
      connectorInstanceId,
      expansions,
      manifest,
      parentRows: [{ record_key: row.record_key, responseRecord: response }],
    });
  }
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

function assertPostgresFieldWindowAuthority(manifest: ConnectorManifest | null, stream: string): void {
  try {
    assertManifestReadAuthority(manifest, stream, { actor: "internal" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const queryError = error as PgQueryError;
      if (queryError.code === "stream_not_declared") {
        throw fieldWindowError(queryError.code, queryError.message, queryError.statusCode ?? 400);
      }
    }
    throw error;
  }
}

async function fetchPostgresFieldWindowRow({
  connectorInstanceId,
  consentTimeField,
  fieldPath,
  recordId,
  selector,
  stream,
}: {
  connectorInstanceId: string;
  consentTimeField: string | null;
  fieldPath: string;
  recordId: string;
  selector: WindowSelector;
  stream: string;
}): Promise<PgRow | undefined> {
  const query = selector.mode === "query" ? selector.query : null;
  const result = await postgresQuery(
    `WITH selected AS (
       SELECT record_key, jsonb_typeof(record_json -> $4::text) AS field_type,
              record_json ->> $4::text AS field_text,
              CASE WHEN $6::text IS NULL THEN NULL ELSE record_json ->> $6::text END AS consent_time_value
       FROM records
       WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE
       LIMIT 1
     ), positioned AS (
       SELECT record_key, field_type, field_text,
              CASE WHEN field_type = 'string' THEN char_length(field_text) ELSE NULL END AS total_chars,
              CASE WHEN $5::text IS NOT NULL AND field_type = 'string'
                THEN strpos(lower(field_text), lower($5::text)) ELSE NULL END AS match_pos,
              consent_time_value
       FROM selected
     )
     SELECT record_key, field_type, total_chars,
            CASE WHEN field_type = 'string' AND ($5::text IS NULL OR match_pos > 0)
              THEN substring(field_text FROM CASE
                WHEN $5::text IS NOT NULL THEN greatest(1, match_pos - $7::integer)
                ELSE $8::integer END FOR $9::integer)
              ELSE NULL END AS window_text,
            match_pos, consent_time_value
     FROM positioned`,
    [
      connectorInstanceId,
      stream,
      recordId,
      fieldPath,
      query,
      consentTimeField,
      selector.mode === "query" ? (selector.before ?? 0) : 0,
      selector.mode === "query" ? 1 : selector.offset + 1,
      selector.limit,
    ]
  );
  return result.rows[0];
}

function assertPostgresFieldWindowRowVisible(
  row: PgRow,
  effective: EffectiveFilter,
  consentTimeField: string | null
): void {
  if (effective.resources && !effective.resources.includes(row.record_key)) {
    throw fieldWindowError("not_found", "Record not found", 404);
  }
  if (effective.timeRange && consentTimeField) {
    const consentData = { [consentTimeField]: row.consent_time_value };
    if (!passesTimeRange(consentData, effective.timeRange, consentTimeField)) {
      throw fieldWindowError("not_found", "Record not found", 404);
    }
  }
}

export async function postgresGetRecordFieldWindow(
  storageTarget: StorageTarget,
  stream: string,
  recordId: string,
  fieldPath: string,
  grant: ConnectorGrant,
  manifest: ConnectorManifest | null = null,
  requestParams: QueryRequestParams = {}
): Promise<JsonObject> {
  assertPostgresFieldWindowAuthority(manifest, stream);
  assertFieldPath(fieldPath);
  const selector = normalizeWindowSelector(
    requestParams as Parameters<typeof normalizeWindowSelector>[0]
  ) as unknown as WindowSelector;

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId ?? "");
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const effective = buildEffectiveFilter(
    streamGrant,
    {},
    requiredFieldsFor(manifestStream)
  ) as unknown as EffectiveFilter;

  assertFieldVisibleToGrant(fieldPath, effective.fields);

  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);

  const consentTimeField = manifestStream?.consent_time_field || null;
  const row = await fetchPostgresFieldWindowRow({
    connectorInstanceId,
    consentTimeField,
    fieldPath,
    recordId,
    selector,
    stream,
  });
  if (!row) {
    throw fieldWindowError("not_found", "Record not found", 404);
  }

  assertPostgresFieldWindowRowVisible(row, effective, consentTimeField);

  const fieldClass = classifyFieldType(row.field_type);
  assertReadableStringField(fieldPath, fieldClass);
  const matchStart = selector.mode === "query" ? Number(row.match_pos) - 1 : null;
  if (selector.mode === "query" && (matchStart === null || !Number.isFinite(matchStart) || matchStart < 0)) {
    throw fieldWindowError("query_not_found", `q was not found in field '${fieldPath}'`, 404);
  }
  const queryMatchStart = matchStart ?? 0;
  const windowOffset =
    selector.mode === "query" ? Math.max(0, queryMatchStart - (selector.before ?? 0)) : selector.offset;

  const window = buildWindowEnvelope({
    limit: selector.limit,
    matchEndChars: selector.mode === "query" ? queryMatchStart + (selector.query?.length ?? 0) : null,
    matchStartChars: selector.mode === "query" ? queryMatchStart : null,
    offset: windowOffset,
    text: row.window_text ?? "",
    totalChars: Number(row.total_chars ?? 0),
  });

  const warnings = [...requestWarnings];
  if (selector.limitClamped) {
    warnings.push({ code: "limit_clamped", message: `limit_chars clamped to ${selector.limit}`, param: "limit_chars" });
  }

  return {
    field_path: fieldPath,
    field_type: fieldClass,
    record_key: row.record_key,
    warnings,
    window,
  };
}

export async function postgresListAllStreams(storageTarget: StorageTarget): Promise<PgRow[]> {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId ?? "");
  const result = await postgresQuery(
    `SELECT stream AS name, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
     FROM records
     WHERE connector_instance_id = $1 AND deleted = FALSE
     GROUP BY stream
     ORDER BY stream`,
    [connectorInstanceId]
  );
  return result.rows;
}

export async function postgresListStreams(
  storageTarget: StorageTarget,
  grant: ConnectorGrant,
  manifest: ConnectorManifest | null = null
): Promise<JsonObject[]> {
  assertGrantedManifestReadAuthority(manifest, grant, null);
  const rows = await postgresListAllStreams(storageTarget);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return grant.streams.map((streamGrant) => {
    const manifestStream = getManifestStream(manifest, streamGrant.name);
    const stored = byName.get(streamGrant.name);
    return {
      last_updated: stored?.last_updated || null,
      name: streamGrant.name,
      record_count: stored?.record_count || 0,
      schema: manifestStream?.schema || null,
    };
  });
}

export function postgresDeleteAllRecords(storageTarget: StorageTarget, stream: string): Promise<number> {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId ?? "");
  return withPostgresTransaction(async (client) => {
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM records
       WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE`,
      [connectorInstanceId, stream]
    );
    const deletedRecordCount = Number(countResult.rows[0]?.count || 0);
    await advancePostgresRecordResetGenerationForStreams(client, connectorInstanceId, [stream]);
    await deletePostgresRecordTailForPair(client, connectorInstanceId, stream);
    return deletedRecordCount;
  });
}

/**
 * Advance `connector_instances.record_reset_generation` by the count of
 * distinct candidate streams that, BEFORE this reset's deletes run in the
 * same transaction, have either a `version_counter` row or a live
 * (non-deleted) canonical record. This is the union rule from
 * design.md's "Exact reset-safe record checkpoint": a stream whose counter
 * was already lost still counts if it has live records, so a subsequent
 * reset+reinsertion can never reproduce the earlier composite checkpoint.
 * A no-op reset (neither input present for any candidate) advances nothing.
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
async function advancePostgresRecordResetGenerationForStreams(
  client: PgClient,
  connectorInstanceId: string,
  streams: string[]
): Promise<void> {
  if (streams.length === 0) {
    return;
  }
  const countersResult = await client.query(
    "SELECT DISTINCT stream FROM version_counter WHERE connector_instance_id = $1 AND stream = ANY($2::text[])",
    [connectorInstanceId, streams]
  );
  const withCounter = new Set(
    countersResult.rows.map((row) => row.stream).filter((stream): stream is string => typeof stream === "string")
  );
  const remaining = streams.filter((stream) => !withCounter.has(stream));
  let withLiveRecord = new Set<string>();
  if (remaining.length > 0) {
    const liveResult = await client.query(
      `SELECT DISTINCT stream FROM records
        WHERE connector_instance_id = $1 AND stream = ANY($2::text[]) AND deleted = FALSE`,
      [connectorInstanceId, remaining]
    );
    withLiveRecord = new Set(
      liveResult.rows.map((row) => row.stream).filter((stream): stream is string => typeof stream === "string")
    );
  }
  const touchedCount = withCounter.size + withLiveRecord.size;
  if (touchedCount === 0) {
    return;
  }
  await client.query(
    "UPDATE connector_instances SET record_reset_generation = record_reset_generation + $1 WHERE connector_instance_id = $2",
    [touchedCount, connectorInstanceId]
  );
}

/**
 * Delete the durable record-tail rows for a single
 * `(connector_instance_id, stream)` pair: record_changes, records,
 * version_counter, and the lexical/semantic search tables scoped to that
 * stream. Mirrors the SQLite per-stream delete shape, which clears the
 * core record tables and lets the outer caller decide whether to also drop
 * blob_bindings (per-stream owner reset does not; per-connector
 * invalidation does).
 *
 * The pg pool's prepared-statement protocol rejects multi-statement
 * parameterized queries, so each DELETE is its own statement. The caller
 * shares one transactional client so the set is atomic.
 *
 * Stays inside the Postgres records boundary so raw SQL does not scatter
 * through higher layers (see design.md alternatives considered).
 */
async function deletePostgresRecordTailForPair(
  client: PgClient,
  connectorInstanceId: string,
  stream: string
): Promise<void> {
  const semanticScopePrefix = `[${JSON.stringify(stream)},`;
  await client.query("DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await client.query("DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await client.query("DELETE FROM version_counter WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await client.query("DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await client.query("DELETE FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await client.query("DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2", [
    connectorInstanceId,
    `${semanticScopePrefix}%`,
  ]);
  await client.query("DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
  await client.query("DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2", [
    connectorInstanceId,
    stream,
  ]);
}

interface BlobPersistArgs {
  connectorId: string;
  connectorInstanceId?: string | null;
  coordinatorOwnership?: ConnectorInstanceWriteOwnership | null;
  data: Buffer | Uint8Array;
  mimeType: string;
  recordKey: string;
  stream: string;
}

interface BlobPersistResult {
  binding_inserted: boolean;
  blob_id: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
}

export function postgresPersistContentAddressedBlob({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  mimeType,
  data,
  coordinatorOwnership = null,
}: BlobPersistArgs): Promise<BlobPersistResult> {
  const effectiveConnectorInstanceId = connectorInstanceId || resolveStorageConnectorInstanceId(null, connectorId);
  return withConnectorInstanceWrite(
    effectiveConnectorInstanceId,
    () =>
      postgresPersistContentAddressedBlobWithinFence({
        connectorId,
        connectorInstanceId: effectiveConnectorInstanceId,
        data,
        mimeType,
        recordKey,
        stream,
      }),
    coordinatorOwnership ?? undefined
  );
}

async function postgresPersistContentAddressedBlobWithinFence({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  mimeType,
  data,
}: Omit<BlobPersistArgs, "coordinatorOwnership">): Promise<BlobPersistResult> {
  const effectiveConnectorInstanceId = connectorInstanceId || resolveStorageConnectorInstanceId(null, connectorId);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobId = `blob_sha256_${sha256}`;
  const sizeBytes = bytes.byteLength;

  const row = await withPostgresTransaction(async (client) => {
    await client.query(
      `INSERT INTO blobs
         (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (blob_id) DO NOTHING`,
      [blobId, connectorId, effectiveConnectorInstanceId, stream, recordKey, mimeType, sizeBytes, sha256, bytes]
    );
    const stored = await client.query("SELECT blob_id, mime_type, size_bytes, sha256 FROM blobs WHERE blob_id = $1", [
      blobId,
    ]);
    const [storedRow] = stored.rows;
    if (!storedRow || storedRow.sha256 !== sha256 || Number(storedRow.size_bytes) !== sizeBytes) {
      const err: PgQueryError = new Error("Blob storage collision");
      err.code = "api_error";
      throw err;
    }
    // json_path = '@record' marks this as a record-level attachment-style
    // binding (the blob belongs to the record as a whole). The
    // migrate-storage tool uses RFC 6901 JSON Pointers for field-level
    // extractions. See docs/reference/binary-content-invariant-design-brief.md §4.6.
    const binding = await client.query(
      `INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES ($1, $2, $3, $4, $5, '@record')
       ON CONFLICT DO NOTHING
       RETURNING blob_id`,
      [blobId, connectorId, effectiveConnectorInstanceId, stream, recordKey]
    );
    return { ...storedRow, binding_inserted: (binding.rowCount ?? 0) > 0 };
  });

  return {
    binding_inserted: Boolean(row.binding_inserted),
    blob_id: blobId,
    mime_type: row.mime_type || mimeType,
    sha256,
    size_bytes: Number(row.size_bytes),
  };
}

export async function postgresLoadContentAddressedBlob(blobId: string): Promise<PgRow | null> {
  const result = await postgresQuery(
    `SELECT blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data
     FROM blobs
     WHERE blob_id = $1`,
    [blobId]
  );
  return result.rows[0] || null;
}

export async function postgresListBlobBindings(
  blobId: string,
  { limit = 1024 }: { limit?: number } = {}
): Promise<PgRow[]> {
  const result = await postgresQuery(
    `SELECT connector_id, connector_instance_id, stream, record_key
     FROM (
       SELECT connector_id, connector_instance_id, stream, record_key FROM blobs WHERE blob_id = $1
       UNION
       SELECT connector_id, connector_instance_id, stream, record_key FROM blob_bindings WHERE blob_id = $1
     ) bindings
     ORDER BY connector_id, connector_instance_id, stream, record_key
     LIMIT $2`,
    [blobId, limit]
  );
  return result.rows;
}

export async function postgresGetDatasetRecordsAggregate() {
  const result = await postgresQuery(`
    SELECT
      COUNT(*)::int AS record_count,
      COUNT(DISTINCT connector_instance_id)::int AS connector_count,
      COUNT(DISTINCT connector_instance_id || ':' || stream)::int AS stream_count,
      COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS record_json_bytes,
      MIN(emitted_at) AS earliest_ingested_at,
      MAX(emitted_at) AS latest_ingested_at
    FROM records
    WHERE deleted = FALSE
  `);
  const [row] = result.rows;
  return {
    connector_count: Number(row?.connector_count || 0),
    earliest_ingested_at: row?.earliest_ingested_at || null,
    latest_ingested_at: row?.latest_ingested_at || null,
    record_count: Number(row?.record_count || 0),
    record_json_bytes: Number(row?.record_json_bytes || 0),
    stream_count: Number(row?.stream_count || 0),
  };
}

export async function postgresGetDatasetRecordChangesBytes() {
  const result = await postgresQuery(`
    SELECT COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS record_changes_json_bytes
    FROM record_changes
  `);
  return Number(result.rows[0]?.record_changes_json_bytes || 0);
}

export async function postgresGetDatasetBlobBytes() {
  const result = await postgresQuery("SELECT COALESCE(SUM(size_bytes), 0)::bigint AS blob_bytes FROM blobs");
  return Number(result.rows[0]?.blob_bytes || 0);
}

async function postgresRecordTimeBoundsForManifestRow(
  row: PgRow,
  manifest: ConnectorManifest
): Promise<{ earliest: string | null; latest: string | null }> {
  let earliest: string | null = null;
  let latest: string | null = null;
  await (manifest.streams ?? []).reduce(async (previous, stream) => {
    await previous;
    const field = stream?.consent_time_field;
    const streamName = stream?.name;
    if (typeof field !== "string" || !field || typeof streamName !== "string" || !RECORD_TIME_FIELD.test(field)) {
      return;
    }
    const result = await postgresQuery(
      `SELECT
         MIN(record_json ->> $1) AS min_time,
         MAX(record_json ->> $1) AS max_time
       FROM records
       WHERE connector_id = $2
         AND stream = $3
         AND deleted = FALSE
         AND record_json ? $1`,
      [field, row.connector_id, streamName]
    );
    const minTime = typeof result.rows[0]?.min_time === "string" ? result.rows[0].min_time : null;
    const maxTime = typeof result.rows[0]?.max_time === "string" ? result.rows[0].max_time : null;
    if (minTime && (earliest === null || minTime < earliest)) {
      earliest = minTime;
    }
    if (maxTime && (latest === null || maxTime > latest)) {
      latest = maxTime;
    }
  }, Promise.resolve());
  return { earliest, latest };
}

export async function postgresGetDatasetRecordTimeBounds() {
  const connectors = await postgresQuery(
    `SELECT connector_id, manifest
     FROM connectors
     ORDER BY connector_id`
  );

  let earliest: string | null = null;
  let latest: string | null = null;
  await connectors.rows.reduce(async (previous, row) => {
    await previous;
    const manifest = normalizeManifestRow(row);
    if (!Array.isArray(manifest?.streams)) {
      return;
    }
    const bounds = await postgresRecordTimeBoundsForManifestRow(row, manifest);
    const { earliest: nextEarliest, latest: nextLatest } = bounds;
    if (nextEarliest && (earliest === null || nextEarliest < earliest)) {
      earliest = nextEarliest;
    }
    if (nextLatest && (latest === null || nextLatest > latest)) {
      latest = nextLatest;
    }
  }, Promise.resolve());

  return { earliest, latest };
}

export async function postgresListDatasetTopConnectorCandidates() {
  const result = await postgresQuery(`
    SELECT connector_id, COUNT(*)::int AS record_count
    FROM records
    WHERE deleted = FALSE
    GROUP BY connector_id
    ORDER BY record_count DESC, connector_id ASC
  `);
  return result.rows.map((row) => ({
    connector_id: row.connector_id,
    record_count: Number(row.record_count || 0),
  }));
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Retained-size read model — reference-only, owner-facing.
 *
 * Backs the bounded `_ref` retained-size reads at global, connection, and
 * stream grain. The active storage backend (SQLite default, Postgres when
 * PDPP_STORAGE_BACKEND=postgres) owns the projection rows, so a Postgres
 * deployment never serves stale SQLite projection rows as live truth.
 *
 * Spec: openspec/changes/add-retained-size-read-model/
 */

import type { PoolClient } from "pg";
import { getDb } from "./db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.ts";

type SqlValue = string | number | boolean | bigint | null | undefined;
type RetainedSizeScope = "connection" | "stream" | "record" | "blob";
type RetainedSizeMeasure =
  | "total_retained_bytes"
  | "current_record_json_bytes"
  | "record_history_json_bytes"
  | "blob_bytes"
  | "record_count"
  | "record_history_count"
  | "blob_count";
type RetainedSizeNumericMeasure = Exclude<RetainedSizeMeasure, "total_retained_bytes">;
type ProjectionError = Error & { code?: string };

interface RetainedSizeRow {
  blob_id?: string | null;
  computed_at?: string | null;
  connector_id?: string | null;
  connector_instance_id?: string | null;
  dirty?: number | boolean | null;
  grain_key?: string | null;
  measure?: RetainedSizeMeasure | string | null;
  metadata_json?: string | Record<string, unknown> | null;
  rank?: number | string | null;
  record_family?: string | null;
  record_key?: string | null;
  scope?: RetainedSizeScope | string | null;
  stream?: string | null;
  [field: string]: SqlValue | Record<string, unknown>;
}

type RetainedSizeMeasures = Record<RetainedSizeNumericMeasure, number>;

interface RetainedSizeDelta {
  blobBytesDelta?: number | null;
  blobCountDelta?: number | null;
  connectorId?: string | null;
  connectorInstanceId?: string | null;
  currentRecordJsonBytesDelta?: number | null;
  recordCountDelta?: number | null;
  recordHistoryCountDelta?: number | null;
  recordHistoryJsonBytesDelta?: number | null;
  stream?: string | null;
}

interface NormalizedRetainedSizeDelta {
  blob_bytes_delta: number;
  blob_count_delta: number;
  connector_id: string | null;
  connector_instance_id: string | null;
  current_record_json_bytes_delta: number;
  record_count_delta: number;
  record_history_count_delta: number;
  record_history_json_bytes_delta: number;
  stream: string | null;
}

interface ConnectionFilter {
  connectorInstanceId?: string | null | undefined;
}
interface StreamFilter extends ConnectionFilter {
  connectorId?: string | null | undefined;
  stream?: string | null | undefined;
}
interface RecordFamilyFilter extends ConnectionFilter {
  recordFamily?: string | null | undefined;
  stream?: string | null | undefined;
}
interface TopFilter {
  limit?: unknown;
  measure?: RetainedSizeMeasure | string;
  scope?: RetainedSizeScope | string;
}
interface OptionalFilterValues {
  [key: string]: string | null | undefined;
}
type SqlFilter = readonly [string, string];
interface Metadata {
  computed_at?: string | null;
  last_error: string | null;
  rebuild_status: string;
  stale_since: string | null;
  state: string;
}
interface StreamAggregate extends RetainedSizeMeasures {
  connector_id: string;
  connector_instance_id: string;
  stream: string;
}
interface ConnectionAggregate extends RetainedSizeMeasures {
  connector_id: string;
  connector_instance_id: string;
}
interface AggregateSourceRow extends RetainedSizeRow {
  connector_id: string;
  connector_instance_id: string;
  stream: string;
}
type DeltaField =
  | "current_record_json_bytes_delta"
  | "record_history_json_bytes_delta"
  | "blob_bytes_delta"
  | "record_count_delta"
  | "record_history_count_delta"
  | "blob_count_delta";

const GLOBAL_KEY = "global";
// Bound the top-N response. Bigger limits invite cardinality blow-ups and
// turn an owner introspection read into a corpus scan. 25 covers the
// useful "what's eating my dataset" question without becoming a query
// builder.
const MAX_TOP_LIMIT = 25;
const DEFAULT_TOP_LIMIT = 10;
const VALID_TOP_SCOPES = new Set<RetainedSizeScope>(["connection", "stream", "record", "blob"]);
const VALID_TOP_MEASURES = new Set<RetainedSizeMeasure>([
  "total_retained_bytes",
  "current_record_json_bytes",
  "record_history_json_bytes",
  "blob_bytes",
  "record_count",
  "record_history_count",
  "blob_count",
]);
const RETAINED_SIZE_MEASURE_FIELDS: readonly RetainedSizeNumericMeasure[] = [
  "current_record_json_bytes",
  "record_history_json_bytes",
  "blob_bytes",
  "record_count",
  "record_history_count",
  "blob_count",
];
const STREAM_FILTER_FIELDS: readonly (readonly [keyof StreamFilter, string])[] = [
  ["connectorInstanceId", "connector_instance_id"],
  ["connectorId", "connector_id"],
  ["stream", "stream"],
];
const RECORD_FAMILY_FILTER_FIELDS: readonly (readonly [keyof RecordFamilyFilter, string])[] = [
  ["connectorInstanceId", "connector_instance_id"],
  ["stream", "stream"],
  ["recordFamily", "record_family"],
];
const RETAINED_SIZE_DELTA_FIELDS: readonly (readonly [keyof RetainedSizeDelta, DeltaField])[] = [
  ["currentRecordJsonBytesDelta", "current_record_json_bytes_delta"],
  ["recordHistoryJsonBytesDelta", "record_history_json_bytes_delta"],
  ["blobBytesDelta", "blob_bytes_delta"],
  ["recordCountDelta", "record_count_delta"],
  ["recordHistoryCountDelta", "record_history_count_delta"],
  ["blobCountDelta", "blob_count_delta"],
];

function nowIso(): string {
  return new Date().toISOString();
}

function runSequentially<T>(
  items: readonly T[],
  action: (item: T, index: number) => void | Promise<void>
): Promise<void> {
  return items.reduce((previous, item, index) => previous.then(() => action(item, index)), Promise.resolve());
}

function sanitizeProjectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || "unknown error");
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 240);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function emptyMeasures(): RetainedSizeMeasures {
  return {
    blob_bytes: 0,
    blob_count: 0,
    current_record_json_bytes: 0,
    record_count: 0,
    record_history_count: 0,
    record_history_json_bytes: 0,
  };
}

function numericMeasures(row: RetainedSizeRow): RetainedSizeMeasures {
  const measures = {} as RetainedSizeMeasures;
  for (const field of RETAINED_SIZE_MEASURE_FIELDS) {
    measures[field] = Number(row[field] || 0);
  }
  return measures;
}

function collectOptionalFilters(
  values: OptionalFilterValues,
  fields: readonly (readonly [string, string])[]
): SqlFilter[] {
  const filters: SqlFilter[] = [];
  for (const [inputName, columnName] of fields) {
    const value = values[inputName];
    if (value) {
      filters.push([columnName, value]);
    }
  }
  return filters;
}

function postgresWhereClause(filters: readonly SqlFilter[]): string {
  return filters.length ? `WHERE ${filters.map(([column], index) => `${column} = $${index + 1}`).join(" AND ")}` : "";
}

function sqliteWhereClause(filters: readonly SqlFilter[]): string {
  return filters.length ? ` WHERE ${filters.map(([column]) => `${column} = ?`).join(" AND ")}` : "";
}

function filterValues(filters: readonly SqlFilter[]): string[] {
  return filters.map(([, value]) => value);
}

function totalBytesFromMeasures(m: RetainedSizeMeasures): number {
  return (
    Number(m.current_record_json_bytes || 0) + Number(m.record_history_json_bytes || 0) + Number(m.blob_bytes || 0)
  );
}

function defaultMetadata(at: string): Metadata {
  return {
    last_error: null,
    rebuild_status: "idle",
    stale_since: at,
    state: "rebuilding",
  };
}

// ---------------------------------------------------------------------------
// Domain-local store
//
// One named, per-domain store with two dialect adapters selected ONCE via
// isPostgresStorageBackend(). Dialect SQL moves VERBATIM from the old inline
// branches. Adapters return RAW rows / perform writes; row-shaping
// (shapeGlobalRow, shapeConnectionRow, ...) and the best-effort try/catch
// wrappers on markers stay CALLER-SIDE.
// ---------------------------------------------------------------------------

function createRetainedSizePostgresStore() {
  return {
    async getGlobalRow() {
      const result = await postgresQuery(
        `SELECT current_record_json_bytes, record_history_json_bytes, blob_bytes,
                record_count, record_history_count, blob_count,
                dirty, computed_at, metadata_json
           FROM retained_size_global
          WHERE projection_key = $1`,
        [GLOBAL_KEY]
      );
      return result.rows[0];
    },
    async listConnectionRows({ connectorInstanceId }: ConnectionFilter = {}) {
      const params: string[] = [];
      let where = "";
      if (connectorInstanceId) {
        params.push(connectorInstanceId);
        where = `WHERE connector_instance_id = $${params.length}`;
      }
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id,
                current_record_json_bytes, record_history_json_bytes, blob_bytes,
                record_count, record_history_count, blob_count,
                dirty, computed_at
           FROM retained_size_connection
           ${where}
           ORDER BY connector_instance_id ASC`,
        params
      );
      return result.rows;
    },
    async listRecordFamilyRows({ connectorInstanceId, stream, recordFamily }: RecordFamilyFilter = {}) {
      const filters = collectOptionalFilters(
        { connectorInstanceId, recordFamily, stream },
        RECORD_FAMILY_FILTER_FIELDS
      );
      const params = filterValues(filters);
      const where = postgresWhereClause(filters);
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, stream, record_family,
                current_record_json_bytes, record_history_json_bytes, blob_bytes,
                record_count, record_history_count, blob_count,
                dirty, computed_at
           FROM retained_size_record_family
           ${where}
           ORDER BY connector_instance_id ASC, stream ASC, record_family ASC`,
        params
      );
      return result.rows;
    },
    async listStreamRows({ connectorInstanceId, connectorId, stream }: StreamFilter = {}) {
      const filters = collectOptionalFilters({ connectorId, connectorInstanceId, stream }, STREAM_FILTER_FIELDS);
      const params = filterValues(filters);
      const where = postgresWhereClause(filters);
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, stream,
                current_record_json_bytes, record_history_json_bytes, blob_bytes,
                record_count, record_history_count, blob_count,
                dirty, computed_at
           FROM retained_size_stream
           ${where}
           ORDER BY connector_instance_id ASC, stream ASC`,
        params
      );
      return result.rows;
    },
    async listTopRows({ scope, measure, limit }: Required<Pick<TopFilter, "scope" | "measure">> & { limit: number }) {
      const result = await postgresQuery(
        `SELECT scope, measure, rank, grain_key,
                connector_instance_id, connector_id, stream, record_key, blob_id,
                current_record_json_bytes, record_history_json_bytes, blob_bytes,
                total_retained_bytes, record_count, record_history_count, blob_count,
                dirty, computed_at, metadata_json
           FROM retained_size_top_rows
          WHERE scope = $1 AND measure = $2
          ORDER BY rank ASC
          LIMIT $3`,
        [scope, measure, limit]
      );
      return result.rows;
    },
    async markConnectionRowsDirty({ connectorInstanceId }: { connectorInstanceId: string }) {
      await postgresQuery("UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
      await postgresQuery("UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
    },
    async markStreamRowsDirty({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) {
      await postgresQuery(
        "UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = $1 AND stream = $2",
        [connectorInstanceId, stream]
      );
      await postgresQuery("UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
    },
    async updateGlobalFresh({ at, metadataJson }: { at: string; metadataJson: string }) {
      await postgresQuery(
        `UPDATE retained_size_global SET dirty = 0, computed_at = $1, metadata_json = $2::jsonb
          WHERE projection_key = $3`,
        [at, metadataJson, GLOBAL_KEY]
      );
    },
    async upsertGlobalDirty({ at, metadataJson }: { at: string; metadataJson: string }) {
      await postgresQuery(
        `INSERT INTO retained_size_global(
           projection_key, dirty, computed_at, metadata_json
         )
         VALUES($1, 1, $2, $3::jsonb)
         ON CONFLICT (projection_key) DO UPDATE SET
           dirty = 1,
           computed_at = COALESCE(retained_size_global.computed_at, $2),
           metadata_json = $3::jsonb`,
        [GLOBAL_KEY, at, metadataJson]
      );
    },
    async upsertGlobalFailed({ at, metadataJson }: { at: string; metadataJson: string }) {
      await postgresQuery(
        `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
         VALUES($1, 1, $2, $3::jsonb)
         ON CONFLICT (projection_key) DO UPDATE SET
           dirty = 1,
           metadata_json = $3::jsonb`,
        [GLOBAL_KEY, at, metadataJson]
      );
    },
    async upsertGlobalRebuilding({ at, metadataJson }: { at: string; metadataJson: string }) {
      await postgresQuery(
        `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
         VALUES($1, 1, $2, $3::jsonb)
         ON CONFLICT (projection_key) DO UPDATE SET
           metadata_json = $3::jsonb`,
        [GLOBAL_KEY, at, metadataJson]
      );
    },
  };
}

function createRetainedSizeSqliteStore() {
  return {
    getGlobalRow() {
      return getDb()
        .prepare(
          `SELECT current_record_json_bytes, record_history_json_bytes, blob_bytes,
                  record_count, record_history_count, blob_count,
                  dirty, computed_at, metadata_json
             FROM retained_size_global
            WHERE projection_key = ?`
        )
        .get(GLOBAL_KEY);
    },
    listConnectionRows({ connectorInstanceId }: ConnectionFilter = {}) {
      const db = getDb();
      return connectorInstanceId
        ? db
            .prepare(
              `SELECT connector_instance_id, connector_id,
                    current_record_json_bytes, record_history_json_bytes, blob_bytes,
                    record_count, record_history_count, blob_count,
                    dirty, computed_at
               FROM retained_size_connection
              WHERE connector_instance_id = ?
              ORDER BY connector_instance_id ASC`
            )
            .all(connectorInstanceId)
        : db
            .prepare(
              `SELECT connector_instance_id, connector_id,
                    current_record_json_bytes, record_history_json_bytes, blob_bytes,
                    record_count, record_history_count, blob_count,
                    dirty, computed_at
               FROM retained_size_connection
              ORDER BY connector_instance_id ASC`
            )
            .all();
    },
    listRecordFamilyRows({ connectorInstanceId, stream, recordFamily }: RecordFamilyFilter = {}) {
      const db = getDb();
      let sql = `SELECT connector_instance_id, connector_id, stream, record_family,
                        current_record_json_bytes, record_history_json_bytes, blob_bytes,
                        record_count, record_history_count, blob_count,
                        dirty, computed_at
                   FROM retained_size_record_family`;
      const filters = collectOptionalFilters(
        { connectorInstanceId, recordFamily, stream },
        RECORD_FAMILY_FILTER_FIELDS
      );
      const params = filterValues(filters);
      sql += sqliteWhereClause(filters);
      sql += " ORDER BY connector_instance_id ASC, stream ASC, record_family ASC";
      return db.prepare(sql).all(...params);
    },
    listStreamRows({ connectorInstanceId, connectorId, stream }: StreamFilter = {}) {
      const db = getDb();
      let sql = `SELECT connector_instance_id, connector_id, stream,
                        current_record_json_bytes, record_history_json_bytes, blob_bytes,
                        record_count, record_history_count, blob_count,
                        dirty, computed_at
                 FROM retained_size_stream`;
      const filters = collectOptionalFilters({ connectorId, connectorInstanceId, stream }, STREAM_FILTER_FIELDS);
      const params = filterValues(filters);
      sql += sqliteWhereClause(filters);
      sql += " ORDER BY connector_instance_id ASC, stream ASC";
      return db.prepare(sql).all(...params);
    },
    listTopRows({ scope, measure, limit }: Required<Pick<TopFilter, "scope" | "measure">> & { limit: number }) {
      return getDb()
        .prepare(
          `SELECT scope, measure, rank, grain_key,
                  connector_instance_id, connector_id, stream, record_key, blob_id,
                  current_record_json_bytes, record_history_json_bytes, blob_bytes,
                  total_retained_bytes, record_count, record_history_count, blob_count,
                  dirty, computed_at, metadata_json
             FROM retained_size_top_rows
            WHERE scope = ? AND measure = ?
            ORDER BY rank ASC
            LIMIT ?`
        )
        .all(scope, measure, limit);
    },
    markConnectionRowsDirty({ connectorInstanceId }: { connectorInstanceId: string }) {
      getDb()
        .prepare("UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = ?")
        .run(connectorInstanceId);
      getDb()
        .prepare("UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = ?")
        .run(connectorInstanceId);
    },
    markStreamRowsDirty({ connectorInstanceId, stream }: { connectorInstanceId: string; stream: string }) {
      getDb()
        .prepare("UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = ? AND stream = ?")
        .run(connectorInstanceId, stream);
      getDb()
        .prepare("UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = ?")
        .run(connectorInstanceId);
    },
    updateGlobalFresh({ at, metadataJson }: { at: string; metadataJson: string }) {
      getDb()
        .prepare(
          `UPDATE retained_size_global SET dirty = 0, computed_at = ?, metadata_json = ?
            WHERE projection_key = ?`
        )
        .run(at, metadataJson, GLOBAL_KEY);
    },
    upsertGlobalDirty({ at, metadataJson }: { at: string; metadataJson: string }) {
      getDb()
        .prepare(
          `INSERT INTO retained_size_global(
             projection_key, dirty, computed_at, metadata_json
           )
           VALUES(?, 1, ?, ?)
           ON CONFLICT(projection_key) DO UPDATE SET
             dirty = 1,
             computed_at = COALESCE(computed_at, ?),
             metadata_json = ?`
        )
        .run(GLOBAL_KEY, at, metadataJson, at, metadataJson);
    },
    upsertGlobalFailed({ at, metadataJson }: { at: string; metadataJson: string }) {
      getDb()
        .prepare(
          `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
           VALUES(?, 1, ?, ?)
           ON CONFLICT(projection_key) DO UPDATE SET
             dirty = 1,
             metadata_json = excluded.metadata_json`
        )
        .run(GLOBAL_KEY, at, metadataJson);
    },
    upsertGlobalRebuilding({ at, metadataJson }: { at: string; metadataJson: string }) {
      getDb()
        .prepare(
          `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
           VALUES(?, 1, ?, ?)
           ON CONFLICT(projection_key) DO UPDATE SET
             metadata_json = excluded.metadata_json`
        )
        .run(GLOBAL_KEY, at, metadataJson);
    },
  };
}

function getRetainedSizeStore() {
  return isPostgresStorageBackend() ? createRetainedSizePostgresStore() : createRetainedSizeSqliteStore();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getRetainedSizeGlobal() {
  const row = await getRetainedSizeStore().getGlobalRow();
  return shapeGlobalRow(row as RetainedSizeRow | undefined);
}

function shapeGlobalRow(row: RetainedSizeRow | undefined) {
  if (!row) {
    return shapeMissingGlobalRow();
  }
  return shapePresentGlobalRow(row);
}

function shapePresentGlobalRow(row: RetainedSizeRow) {
  const measures = numericMeasures(row);
  const metadata = parseMetadata(row.metadata_json) || defaultMetadata(row.computed_at || nowIso());
  return {
    grain: "global",
    ...measures,
    computed_at: row.computed_at || null,
    dirty: Number(row.dirty || 0) !== 0,
    metadata: { ...metadata, computed_at: row.computed_at || metadata.computed_at || null },
    total_retained_bytes: totalBytesFromMeasures(measures),
  };
}

function shapeMissingGlobalRow() {
  const at = nowIso();
  const measures = emptyMeasures();
  return {
    grain: "global",
    ...measures,
    computed_at: null,
    dirty: true,
    metadata: { ...defaultMetadata(at), computed_at: null },
    total_retained_bytes: 0,
  };
}

function parseMetadata(value: string | Record<string, unknown> | null | undefined): Metadata | null {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value as unknown as Metadata;
  }
  return parseJson<Metadata | null>(String(value), null);
}

export async function listRetainedSizeConnections({ connectorInstanceId }: ConnectionFilter = {}) {
  const rows = await getRetainedSizeStore().listConnectionRows({ connectorInstanceId });
  return (rows as RetainedSizeRow[]).map(shapeConnectionRow);
}

function shapeConnectionRow(row: RetainedSizeRow) {
  const measures = numericMeasures(row);
  return {
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    grain: "connection",
    ...measures,
    computed_at: row.computed_at || null,
    dirty: Number(row.dirty || 0) !== 0,
    total_retained_bytes: totalBytesFromMeasures(measures),
  };
}

export async function listRetainedSizeStreams({ connectorInstanceId, connectorId, stream }: StreamFilter = {}) {
  const rows = await getRetainedSizeStore().listStreamRows({ connectorId, connectorInstanceId, stream });
  return (rows as RetainedSizeRow[]).map(shapeStreamRow);
}

export async function listRetainedSizeRecordFamilies({
  connectorInstanceId,
  stream,
  recordFamily,
}: RecordFamilyFilter = {}) {
  const rows = await getRetainedSizeStore().listRecordFamilyRows({
    connectorInstanceId,
    recordFamily,
    stream,
  });
  return (rows as RetainedSizeRow[]).map(shapeRecordFamilyRow);
}

function shapeStreamRow(row: RetainedSizeRow) {
  const measures = numericMeasures(row);
  return {
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    grain: "stream",
    stream: row.stream,
    ...measures,
    computed_at: row.computed_at || null,
    dirty: Number(row.dirty || 0) !== 0,
    total_retained_bytes: totalBytesFromMeasures(measures),
  };
}

function shapeRecordFamilyRow(row: RetainedSizeRow) {
  const stream = shapeStreamRow(row);
  return {
    ...stream,
    grain: "record_family",
    record_family: row.record_family,
  };
}

export function clampTopLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TOP_LIMIT;
  }
  return Math.min(MAX_TOP_LIMIT, Math.max(1, Math.floor(parsed)));
}

export function isValidTopScope(value: unknown): value is RetainedSizeScope {
  return typeof value === "string" && VALID_TOP_SCOPES.has(value as RetainedSizeScope);
}

export function isValidTopMeasure(value: unknown): value is RetainedSizeMeasure {
  return typeof value === "string" && VALID_TOP_MEASURES.has(value as RetainedSizeMeasure);
}

export async function listRetainedSizeTop({ scope, measure, limit }: TopFilter = {}) {
  if (!isValidTopScope(scope)) {
    const err: ProjectionError = new Error(`unsupported retained-size top-N scope '${scope}'`);
    err.code = "invalid_request";
    throw err;
  }
  if (!isValidTopMeasure(measure)) {
    const err: ProjectionError = new Error(`unsupported retained-size top-N measure '${measure}'`);
    err.code = "invalid_request";
    throw err;
  }
  const effectiveLimit = clampTopLimit(limit);

  const rows = await getRetainedSizeStore().listTopRows({
    limit: effectiveLimit,
    measure,
    scope,
  });
  return (rows as RetainedSizeRow[]).map(shapeTopRow);
}

function shapeTopRow(row: RetainedSizeRow) {
  const measures = numericMeasures(row);
  const leadingFields = {
    grain: row.scope,
    grain_key: row.grain_key,
    measure: row.measure,
    rank: Number(row.rank || 0),
    scope: row.scope,
  };
  return {
    ...leadingFields,
    ...topRowIdentity(row),
    ...measures,
    computed_at: row.computed_at || null,
    dirty: isDirtyRow(row),
    metadata: parsedMetadataOrNull(row.metadata_json),
    total_retained_bytes: retainedTotalBytes(row, measures),
  };
}

function retainedTotalBytes(row: RetainedSizeRow, measures: RetainedSizeMeasures): number {
  return Number(row.total_retained_bytes || totalBytesFromMeasures(measures));
}

function isDirtyRow(row: RetainedSizeRow): boolean {
  return Number(row.dirty || 0) !== 0;
}

function parsedMetadataOrNull(value: string | Record<string, unknown> | null | undefined): Metadata | null {
  return parseMetadata(value) || null;
}

// ---------------------------------------------------------------------------
// Incremental maintenance
// ---------------------------------------------------------------------------

/**
 * Apply a record-write delta. Called from the durable record ingest path
 * AFTER the canonical row is committed. Failures must NOT propagate back —
 * they mark the projection dirty so a subsequent rebuild/reconcile pass
 * repairs it. Same contract as applyDatasetSummaryRecordDelta.
 */
export async function applyRetainedSizeRecordDelta(delta: RetainedSizeDelta): Promise<void> {
  try {
    if (isPostgresStorageBackend()) {
      await applyRecordDeltaPostgres(delta);
      return;
    }
    applyRecordDeltaSqlite(delta);
  } catch (err) {
    await markRetainedSizeDirty(`retained-size record delta failed: ${sanitizeProjectionError(err)}`);
  }
}

/**
 * Apply a blob-write delta. Counts and bytes are attributed to the
 * (connector_instance_id, connector_id, stream) grain captured at blob
 * insert/binding time. Same dirty-on-failure contract as record deltas.
 */
export async function applyRetainedSizeBlobDelta(delta: RetainedSizeDelta): Promise<void> {
  try {
    if (isPostgresStorageBackend()) {
      await applyBlobDeltaPostgres(delta);
      return;
    }
    applyBlobDeltaSqlite(delta);
  } catch (err) {
    await markRetainedSizeDirty(`retained-size blob delta failed: ${sanitizeProjectionError(err)}`);
  }
}

function applyRecordDeltaSqlite(delta: RetainedSizeDelta): void {
  const db = getDb();
  const computedAt = nowIso();
  db.transaction(() => {
    upsertStreamRowSqlite(delta, computedAt);
    upsertConnectionRowSqlite(delta, computedAt);
    applyGlobalDeltaSqlite(delta, computedAt);
    markTopRowsDirtySqlite(db, "record delta changed retained-size ordering", computedAt);
  })();
}

async function applyRecordDeltaPostgres(delta: RetainedSizeDelta): Promise<void> {
  const computedAt = nowIso();
  await withPostgresTransaction(async (client: PoolClient) => {
    await upsertStreamRowPostgres(client, delta, computedAt);
    await upsertConnectionRowPostgres(client, delta, computedAt);
    await applyGlobalDeltaPostgres(client, delta, computedAt);
    await markTopRowsDirtyPostgres(client, "record delta changed retained-size ordering", computedAt);
  });
}

function applyBlobDeltaSqlite(delta: RetainedSizeDelta): void {
  const db = getDb();
  const computedAt = nowIso();
  db.transaction(() => {
    upsertStreamRowSqlite(delta, computedAt);
    upsertConnectionRowSqlite(delta, computedAt);
    applyGlobalDeltaSqlite(delta, computedAt);
    markTopRowsDirtySqlite(db, "blob delta changed retained-size ordering", computedAt);
  })();
}

async function applyBlobDeltaPostgres(delta: RetainedSizeDelta): Promise<void> {
  const computedAt = nowIso();
  await withPostgresTransaction(async (client: PoolClient) => {
    await upsertStreamRowPostgres(client, delta, computedAt);
    await upsertConnectionRowPostgres(client, delta, computedAt);
    await applyGlobalDeltaPostgres(client, delta, computedAt);
    await markTopRowsDirtyPostgres(client, "blob delta changed retained-size ordering", computedAt);
  });
}

function normalizedDelta(delta: RetainedSizeDelta): NormalizedRetainedSizeDelta {
  const normalized: NormalizedRetainedSizeDelta = {
    blob_bytes_delta: 0,
    blob_count_delta: 0,
    connector_id: delta.connectorId || null,
    connector_instance_id: delta.connectorInstanceId || null,
    current_record_json_bytes_delta: 0,
    record_count_delta: 0,
    record_history_count_delta: 0,
    record_history_json_bytes_delta: 0,
    stream: delta.stream || null,
  };
  for (const [inputName, fieldName] of RETAINED_SIZE_DELTA_FIELDS) {
    normalized[fieldName] = Number(delta[inputName] || 0);
  }
  return normalized;
}

function upsertStreamRowSqlite(rawDelta: RetainedSizeDelta, computedAt: string): void {
  const delta = normalizedDelta(rawDelta);
  if (!(delta.connector_instance_id && delta.connector_id && delta.stream)) {
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
         current_record_json_bytes = MAX(0, current_record_json_bytes + ?),
         record_history_json_bytes = MAX(0, record_history_json_bytes + ?),
         blob_bytes = MAX(0, blob_bytes + ?),
         record_count = MAX(0, record_count + ?),
         record_history_count = MAX(0, record_history_count + ?),
         blob_count = MAX(0, blob_count + ?),
         computed_at = ?`
    )
    .run(
      delta.connector_instance_id,
      delta.connector_id,
      delta.stream,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
      computedAt
    );
}

async function upsertStreamRowPostgres(
  client: PoolClient,
  rawDelta: RetainedSizeDelta,
  computedAt: string
): Promise<void> {
  const delta = normalizedDelta(rawDelta);
  if (!(delta.connector_instance_id && delta.connector_id && delta.stream)) {
    return;
  }
  await client.query(
    `INSERT INTO retained_size_stream(
       connector_instance_id, connector_id, stream,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE SET
       current_record_json_bytes = GREATEST(0, retained_size_stream.current_record_json_bytes + $11),
       record_history_json_bytes = GREATEST(0, retained_size_stream.record_history_json_bytes + $12),
       blob_bytes = GREATEST(0, retained_size_stream.blob_bytes + $13),
       record_count = GREATEST(0, retained_size_stream.record_count + $14),
       record_history_count = GREATEST(0, retained_size_stream.record_history_count + $15),
       blob_count = GREATEST(0, retained_size_stream.blob_count + $16),
       computed_at = EXCLUDED.computed_at`,
    [
      delta.connector_instance_id,
      delta.connector_id,
      delta.stream,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
    ]
  );
}

function upsertConnectionRowSqlite(rawDelta: RetainedSizeDelta, computedAt: string): void {
  const delta = normalizedDelta(rawDelta);
  if (!(delta.connector_instance_id && delta.connector_id)) {
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(connector_instance_id) DO UPDATE SET
         current_record_json_bytes = MAX(0, current_record_json_bytes + ?),
         record_history_json_bytes = MAX(0, record_history_json_bytes + ?),
         blob_bytes = MAX(0, blob_bytes + ?),
         record_count = MAX(0, record_count + ?),
         record_history_count = MAX(0, record_history_count + ?),
         blob_count = MAX(0, blob_count + ?),
         computed_at = ?`
    )
    .run(
      delta.connector_instance_id,
      delta.connector_id,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
      computedAt
    );
}

async function upsertConnectionRowPostgres(
  client: PoolClient,
  rawDelta: RetainedSizeDelta,
  computedAt: string
): Promise<void> {
  const delta = normalizedDelta(rawDelta);
  if (!(delta.connector_instance_id && delta.connector_id)) {
    return;
  }
  await client.query(
    `INSERT INTO retained_size_connection(
       connector_instance_id, connector_id,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)
     ON CONFLICT (connector_instance_id) DO UPDATE SET
       current_record_json_bytes = GREATEST(0, retained_size_connection.current_record_json_bytes + $10),
       record_history_json_bytes = GREATEST(0, retained_size_connection.record_history_json_bytes + $11),
       blob_bytes = GREATEST(0, retained_size_connection.blob_bytes + $12),
       record_count = GREATEST(0, retained_size_connection.record_count + $13),
       record_history_count = GREATEST(0, retained_size_connection.record_history_count + $14),
       blob_count = GREATEST(0, retained_size_connection.blob_count + $15),
       computed_at = $9`,
    [
      delta.connector_instance_id,
      delta.connector_id,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
    ]
  );
}

function applyGlobalDeltaSqlite(rawDelta: RetainedSizeDelta, computedAt: string): void {
  const delta = normalizedDelta(rawDelta);
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         current_record_json_bytes = MAX(0, current_record_json_bytes + ?),
         record_history_json_bytes = MAX(0, record_history_json_bytes + ?),
         blob_bytes = MAX(0, blob_bytes + ?),
         record_count = MAX(0, record_count + ?),
         record_history_count = MAX(0, record_history_count + ?),
         blob_count = MAX(0, blob_count + ?),
         computed_at = ?`
    )
    .run(
      GLOBAL_KEY,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      JSON.stringify({
        last_error: null,
        rebuild_status: "idle",
        stale_since: null,
        state: "fresh",
      }),
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
      computedAt
    );
}

async function applyGlobalDeltaPostgres(
  client: PoolClient,
  rawDelta: RetainedSizeDelta,
  computedAt: string
): Promise<void> {
  const delta = normalizedDelta(rawDelta);
  await client.query(
    `INSERT INTO retained_size_global(
       projection_key,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, 0, $8, $9::jsonb)
     ON CONFLICT (projection_key) DO UPDATE SET
       current_record_json_bytes = GREATEST(0, retained_size_global.current_record_json_bytes + $10),
       record_history_json_bytes = GREATEST(0, retained_size_global.record_history_json_bytes + $11),
       blob_bytes = GREATEST(0, retained_size_global.blob_bytes + $12),
       record_count = GREATEST(0, retained_size_global.record_count + $13),
       record_history_count = GREATEST(0, retained_size_global.record_history_count + $14),
       blob_count = GREATEST(0, retained_size_global.blob_count + $15),
       computed_at = $8`,
    [
      GLOBAL_KEY,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      JSON.stringify({
        last_error: null,
        rebuild_status: "idle",
        stale_since: null,
        state: "fresh",
      }),
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
    ]
  );
}

function staleTopMetadata(reason: string, at: string): string {
  return JSON.stringify({
    computed_at: at,
    last_error: sanitizeProjectionError(reason || "retained-size top-N rows are stale"),
    rebuild_status: "idle",
    stale_since: at,
    state: "stale",
  });
}

function markTopRowsDirtySqlite(db: ReturnType<typeof getDb>, reason: string, at = nowIso()): void {
  db.prepare(
    `UPDATE retained_size_top_rows
        SET dirty = 1,
            metadata_json = ?
      WHERE dirty = 0`
  ).run(staleTopMetadata(reason, at));
}

async function markTopRowsDirtyPostgres(client: PoolClient, reason: string, at = nowIso()): Promise<void> {
  await client.query(
    `UPDATE retained_size_top_rows
        SET dirty = 1,
            metadata_json = $1::jsonb
      WHERE dirty = 0`,
    [staleTopMetadata(reason, at)]
  );
}

// ---------------------------------------------------------------------------
// Dirty markers
// ---------------------------------------------------------------------------

export async function markRetainedSizeDirty(reason: string): Promise<void> {
  const at = nowIso();
  const sanitized = sanitizeProjectionError(reason || "retained-size projection is stale");
  const metadataJson = JSON.stringify({
    last_error: sanitized,
    rebuild_status: "idle",
    stale_since: at,
    state: "stale",
  });
  try {
    await getRetainedSizeStore().upsertGlobalDirty({ at, metadataJson });
  } catch {
    // Dirty marker failure is non-fatal; canonical evidence is untouched.
  }
}

export async function markRetainedSizeStreamDirty({
  connectorInstanceId,
  stream,
}: {
  connectorInstanceId: string | null;
  stream: string | null;
}): Promise<void> {
  if (!(connectorInstanceId && stream)) {
    await markRetainedSizeDirty(`bulk write on (${connectorInstanceId}, ${stream})`);
    return;
  }
  try {
    await getRetainedSizeStore().markStreamRowsDirty({ connectorInstanceId, stream });
  } catch {
    // Best-effort marker; rebuild will repair.
  }
  await markRetainedSizeDirty(`bulk write on (${connectorInstanceId}, ${stream})`);
}

export async function markRetainedSizeConnectionDirty({
  connectorInstanceId,
}: {
  connectorInstanceId: string | null;
}): Promise<void> {
  if (!connectorInstanceId) {
    await markRetainedSizeDirty("bulk write on unknown connection");
    return;
  }
  try {
    await getRetainedSizeStore().markConnectionRowsDirty({ connectorInstanceId });
  } catch {
    // Best-effort.
  }
  await markRetainedSizeDirty(`bulk write on connection ${connectorInstanceId}`);
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild every retained-size row from the active backend's canonical
 * records/record_changes/blobs tables. The rebuild does NOT rerun
 * connectors or read credentials — it derives bytes/counts from already
 * durable state. On completion, all rows are marked dirty=0 and the
 * global metadata flips to 'fresh'.
 */
export async function rebuildRetainedSize() {
  const startedAt = nowIso();
  await markRetainedSizeRebuilding(startedAt);
  try {
    if (isPostgresStorageBackend()) {
      await rebuildPostgres();
    } else {
      rebuildSqlite();
    }
    const completedAt = nowIso();
    await markRetainedSizeFresh(completedAt);
    return await getRetainedSizeGlobal();
  } catch (err) {
    await markRetainedSizeFailed(err);
    throw err;
  }
}

function rebuildSqlite(): void {
  const db = getDb();
  const computedAt = nowIso();
  db.transaction(() => {
    db.prepare("DELETE FROM retained_size_stream").run();
    db.prepare("DELETE FROM retained_size_connection").run();
    db.prepare("DELETE FROM retained_size_record_family").run();

    const streamAgg = db
      .prepare(
        `SELECT connector_instance_id, connector_id, stream,
                COUNT(*)              AS record_count,
                COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS current_record_json_bytes
           FROM records
          WHERE deleted = 0
          GROUP BY connector_instance_id, connector_id, stream`
      )
      .all();
    const changesAgg = db
      .prepare(
        `SELECT connector_instance_id, connector_id, stream,
                COUNT(*) AS record_history_count,
                COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS record_history_json_bytes
           FROM record_changes
          GROUP BY connector_instance_id, connector_id, stream`
      )
      .all();
    const blobsAgg = db
      .prepare(
        `SELECT blob_bindings.connector_instance_id AS connector_instance_id,
                blob_bindings.connector_id AS connector_id,
                blob_bindings.stream AS stream,
                COUNT(*) AS blob_count,
                COALESCE(SUM(blobs.size_bytes), 0) AS blob_bytes
           FROM blob_bindings
           JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
          GROUP BY blob_bindings.connector_instance_id, blob_bindings.connector_id, blob_bindings.stream`
      )
      .all();

    const merged = mergeAggregateRows(
      streamAgg as AggregateSourceRow[],
      changesAgg as AggregateSourceRow[],
      blobsAgg as AggregateSourceRow[]
    );

    const insertStream = db.prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    for (const row of merged.streams) {
      insertStream.run(
        row.connector_instance_id,
        row.connector_id,
        row.stream,
        row.current_record_json_bytes,
        row.record_history_json_bytes,
        row.blob_bytes,
        row.record_count,
        row.record_history_count,
        row.blob_count,
        computedAt
      );
    }

    const insertConnection = db.prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    for (const row of merged.connections) {
      insertConnection.run(
        row.connector_instance_id,
        row.connector_id,
        row.current_record_json_bytes,
        row.record_history_json_bytes,
        row.blob_bytes,
        row.record_count,
        row.record_history_count,
        row.blob_count,
        computedAt
      );
    }

    refreshRetainedSizeTopRowsSqlite(db, computedAt);

    const globalRow = merged.global;
    db.prepare(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         current_record_json_bytes = excluded.current_record_json_bytes,
         record_history_json_bytes = excluded.record_history_json_bytes,
         blob_bytes = excluded.blob_bytes,
         record_count = excluded.record_count,
         record_history_count = excluded.record_history_count,
         blob_count = excluded.blob_count,
         dirty = 0,
         computed_at = excluded.computed_at,
         metadata_json = excluded.metadata_json`
    ).run(
      GLOBAL_KEY,
      globalRow.current_record_json_bytes,
      globalRow.record_history_json_bytes,
      globalRow.blob_bytes,
      globalRow.record_count,
      globalRow.record_history_count,
      globalRow.blob_count,
      computedAt,
      JSON.stringify({
        last_error: null,
        rebuild_status: "idle",
        stale_since: null,
        state: "fresh",
      })
    );
  })();
}

async function rebuildPostgres(): Promise<void> {
  await withPostgresTransaction(async (client: PoolClient) => {
    const computedAt = nowIso();
    await client.query("DELETE FROM retained_size_stream");
    await client.query("DELETE FROM retained_size_connection");
    await client.query("DELETE FROM retained_size_record_family");

    const streamAgg = await client.query(
      `SELECT connector_instance_id, connector_id, stream,
              COUNT(*)::bigint AS record_count,
              COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS current_record_json_bytes
         FROM records
        WHERE deleted = FALSE
        GROUP BY connector_instance_id, connector_id, stream`
    );
    const changesAgg = await client.query(
      `SELECT connector_instance_id, connector_id, stream,
              COUNT(*)::bigint AS record_history_count,
              COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS record_history_json_bytes
         FROM record_changes
        GROUP BY connector_instance_id, connector_id, stream`
    );
    const blobsAgg = await client.query(
      `SELECT blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.connector_id AS connector_id,
              blob_bindings.stream AS stream,
              COUNT(*)::bigint AS blob_count,
              COALESCE(SUM(blobs.size_bytes), 0)::bigint AS blob_bytes
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        GROUP BY blob_bindings.connector_instance_id, blob_bindings.connector_id, blob_bindings.stream`
    );
    const merged = mergeAggregateRows(streamAgg.rows, changesAgg.rows, blobsAgg.rows);

    await runSequentially(merged.streams, async (row) => {
      await client.query(
        `INSERT INTO retained_size_stream(
           connector_instance_id, connector_id, stream,
           current_record_json_bytes, record_history_json_bytes, blob_bytes,
           record_count, record_history_count, blob_count,
           dirty, computed_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.stream,
          row.current_record_json_bytes,
          row.record_history_json_bytes,
          row.blob_bytes,
          row.record_count,
          row.record_history_count,
          row.blob_count,
          computedAt,
        ]
      );
    });

    await runSequentially(merged.connections, async (row) => {
      await client.query(
        `INSERT INTO retained_size_connection(
           connector_instance_id, connector_id,
           current_record_json_bytes, record_history_json_bytes, blob_bytes,
           record_count, record_history_count, blob_count,
           dirty, computed_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.current_record_json_bytes,
          row.record_history_json_bytes,
          row.blob_bytes,
          row.record_count,
          row.record_history_count,
          row.blob_count,
          computedAt,
        ]
      );
    });

    const g = merged.global;
    await refreshRetainedSizeTopRowsPostgres(client, computedAt);
    await client.query(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, 0, $8, $9::jsonb)
       ON CONFLICT (projection_key) DO UPDATE SET
         current_record_json_bytes = EXCLUDED.current_record_json_bytes,
         record_history_json_bytes = EXCLUDED.record_history_json_bytes,
         blob_bytes = EXCLUDED.blob_bytes,
         record_count = EXCLUDED.record_count,
         record_history_count = EXCLUDED.record_history_count,
         blob_count = EXCLUDED.blob_count,
         dirty = 0,
         computed_at = EXCLUDED.computed_at,
         metadata_json = EXCLUDED.metadata_json`,
      [
        GLOBAL_KEY,
        g.current_record_json_bytes,
        g.record_history_json_bytes,
        g.blob_bytes,
        g.record_count,
        g.record_history_count,
        g.blob_count,
        computedAt,
        JSON.stringify({
          last_error: null,
          rebuild_status: "idle",
          stale_since: null,
          state: "fresh",
        }),
      ]
    );
  });
}

function mergeAggregateRows(
  streamAgg: readonly AggregateSourceRow[],
  changesAgg: readonly AggregateSourceRow[],
  blobsAgg: readonly AggregateSourceRow[]
) {
  const streams = mergeStreamAggregateRows(streamAgg, changesAgg, blobsAgg);
  const connections = aggregateConnectionRows(streams);
  const global = aggregateMeasureRows(streams);
  return { connections, global, streams };
}

function mergeStreamAggregateRows(
  streamAgg: readonly AggregateSourceRow[],
  changesAgg: readonly AggregateSourceRow[],
  blobsAgg: readonly AggregateSourceRow[]
): StreamAggregate[] {
  const map = new Map<string, StreamAggregate>();
  const ensure = (row: AggregateSourceRow): StreamAggregate => {
    const key = `${row.connector_instance_id}\u0000${row.connector_id}\u0000${row.stream}`;
    const entry = map.get(key);
    if (!entry) {
      const created: StreamAggregate = {
        connector_id: row.connector_id,
        connector_instance_id: row.connector_instance_id,
        stream: row.stream,
        ...emptyMeasures(),
      };
      map.set(key, created);
      return created;
    }
    return entry;
  };
  for (const row of streamAgg) {
    applyRecordAggregate(ensure(row), row);
  }
  for (const row of changesAgg) {
    applyRecordHistoryAggregate(ensure(row), row);
  }
  for (const row of blobsAgg) {
    applyBlobAggregate(ensure(row), row);
  }
  return [...map.values()];
}

function applyRecordAggregate(entry: StreamAggregate, row: AggregateSourceRow): void {
  entry.current_record_json_bytes = Number(row.current_record_json_bytes || 0);
  entry.record_count = Number(row.record_count || 0);
}

function applyRecordHistoryAggregate(entry: StreamAggregate, row: AggregateSourceRow): void {
  entry.record_history_json_bytes = Number(row.record_history_json_bytes || 0);
  entry.record_history_count = Number(row.record_history_count || 0);
}

function applyBlobAggregate(entry: StreamAggregate, row: AggregateSourceRow): void {
  entry.blob_bytes = Number(row.blob_bytes || 0);
  entry.blob_count = Number(row.blob_count || 0);
}

function aggregateConnectionRows(streams: readonly StreamAggregate[]): ConnectionAggregate[] {
  const connections = new Map<string, ConnectionAggregate>();
  for (const row of streams) {
    const key = row.connector_instance_id;
    let conn = connections.get(key);
    if (!conn) {
      conn = {
        connector_id: row.connector_id,
        connector_instance_id: row.connector_instance_id,
        ...emptyMeasures(),
      };
      connections.set(key, conn);
    }
    addMeasures(conn, row);
  }
  return [...connections.values()];
}

function aggregateMeasureRows(rows: readonly RetainedSizeMeasures[]): RetainedSizeMeasures {
  const aggregate = emptyMeasures();
  for (const row of rows) {
    addMeasures(aggregate, row);
  }
  return aggregate;
}

function addMeasures(target: RetainedSizeMeasures, source: RetainedSizeMeasures): void {
  for (const field of RETAINED_SIZE_MEASURE_FIELDS) {
    target[field] += source[field];
  }
}

function freshTopMetadata(computedAt: string): string {
  return JSON.stringify({
    computed_at: computedAt,
    last_error: null,
    rebuild_status: "idle",
    stale_since: null,
    state: "fresh",
  });
}

function topRowIdentity(row: RetainedSizeRow) {
  return {
    blob_id: row.blob_id || null,
    connector_id: row.connector_id || null,
    connector_instance_id: row.connector_instance_id || null,
    record_key: row.record_key || null,
    stream: row.stream || null,
  };
}

function topRowInsertValues(
  row: RetainedSizeRow,
  rank: number,
  scope: RetainedSizeScope,
  measure: RetainedSizeMeasure,
  computedAt: string,
  metadata: string
) {
  const measures = numericMeasures(row);
  const grainKey = row.grain_key;
  const identity = topRowIdentity(row);
  return [
    scope,
    measure,
    rank,
    grainKey,
    identity.connector_instance_id,
    identity.connector_id,
    identity.stream,
    identity.record_key,
    identity.blob_id,
    measures.current_record_json_bytes,
    measures.record_history_json_bytes,
    measures.blob_bytes,
    Number(row.total_retained_bytes || totalBytesFromMeasures(measures)),
    measures.record_count,
    measures.record_history_count,
    measures.blob_count,
    computedAt,
    metadata,
  ];
}

function insertTopRowsSqlite(
  db: ReturnType<typeof getDb>,
  scope: RetainedSizeScope,
  measure: RetainedSizeMeasure,
  rows: readonly RetainedSizeRow[],
  computedAt: string
): void {
  const metadata = freshTopMetadata(computedAt);
  const insert = db.prepare(
    `INSERT INTO retained_size_top_rows(
       scope, measure, rank, grain_key,
       connector_instance_id, connector_id, stream, record_key, blob_id,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       total_retained_bytes, record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  rows.forEach((row, index) => {
    insert.run(...topRowInsertValues(row, index + 1, scope, measure, computedAt, metadata));
  });
}

function refreshRetainedSizeTopRowsSqlite(db: ReturnType<typeof getDb>, computedAt: string): void {
  db.prepare("DELETE FROM retained_size_top_rows").run();
  const baseColumns = `
    current_record_json_bytes,
    record_history_json_bytes,
    blob_bytes,
    current_record_json_bytes + record_history_json_bytes + blob_bytes AS total_retained_bytes,
    record_count,
    record_history_count,
    blob_count
  `;
  const topMeasures = [...VALID_TOP_MEASURES];
  for (const measure of topMeasures) {
    const orderExpr =
      measure === "total_retained_bytes"
        ? "current_record_json_bytes + record_history_json_bytes + blob_bytes"
        : measure;
    insertTopRowsSqlite(
      db,
      "connection",
      measure,
      db
        .prepare(
          `SELECT connector_instance_id AS grain_key,
                connector_instance_id,
                connector_id,
                ${baseColumns}
           FROM retained_size_connection
          ORDER BY ${orderExpr} DESC, connector_instance_id ASC
          LIMIT ?`
        )
        .all(MAX_TOP_LIMIT),
      computedAt
    );
    insertTopRowsSqlite(
      db,
      "stream",
      measure,
      db
        .prepare(
          `SELECT connector_instance_id || char(10) || stream AS grain_key,
                connector_instance_id,
                connector_id,
                stream,
                ${baseColumns}
           FROM retained_size_stream
          ORDER BY ${orderExpr} DESC, connector_instance_id ASC, stream ASC
          LIMIT ?`
        )
        .all(MAX_TOP_LIMIT),
      computedAt
    );
  }

  insertTopRowsSqlite(
    db,
    "record",
    "current_record_json_bytes",
    db
      .prepare(
        `SELECT connector_instance_id || char(10) || stream || char(10) || record_key AS grain_key,
              connector_instance_id,
              connector_id,
              stream,
              record_key,
              LENGTH(CAST(record_json AS BLOB)) AS current_record_json_bytes,
              LENGTH(CAST(record_json AS BLOB)) AS total_retained_bytes,
              1 AS record_count
         FROM records
        WHERE deleted = 0
        ORDER BY current_record_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
        LIMIT ?`
      )
      .all(MAX_TOP_LIMIT),
    computedAt
  );
  insertTopRowsSqlite(
    db,
    "record",
    "record_history_json_bytes",
    db
      .prepare(
        `SELECT connector_instance_id || char(10) || stream || char(10) || record_key AS grain_key,
              connector_instance_id,
              connector_id,
              stream,
              record_key,
              COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS record_history_json_bytes,
              COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS total_retained_bytes,
              COUNT(*) AS record_history_count
         FROM record_changes
        GROUP BY connector_instance_id, connector_id, stream, record_key
        ORDER BY record_history_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
        LIMIT ?`
      )
      .all(MAX_TOP_LIMIT),
    computedAt
  );
  insertTopRowsSqlite(
    db,
    "record",
    "total_retained_bytes",
    db
      .prepare(
        `WITH keys AS (
         SELECT connector_instance_id, connector_id, stream, record_key
           FROM records
          WHERE deleted = 0
         UNION
         SELECT connector_instance_id, connector_id, stream, record_key
           FROM record_changes
         UNION
         SELECT connector_instance_id, connector_id, stream, record_key
           FROM blob_bindings
       ),
       current_records AS (
         SELECT connector_instance_id, stream, record_key,
                COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS current_record_json_bytes,
                COUNT(*) AS record_count
           FROM records
          WHERE deleted = 0
          GROUP BY connector_instance_id, stream, record_key
       ),
       history_records AS (
         SELECT connector_instance_id, stream, record_key,
                COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS record_history_json_bytes,
                COUNT(*) AS record_history_count
           FROM record_changes
          GROUP BY connector_instance_id, stream, record_key
       ),
       record_blobs AS (
         SELECT blob_bindings.connector_instance_id AS connector_instance_id,
                blob_bindings.stream AS stream,
                blob_bindings.record_key AS record_key,
                COALESCE(SUM(blobs.size_bytes), 0) AS blob_bytes,
                COUNT(*) AS blob_count
           FROM blob_bindings
           JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
          GROUP BY blob_bindings.connector_instance_id, blob_bindings.stream, blob_bindings.record_key
       )
       SELECT keys.connector_instance_id || char(10) || keys.stream || char(10) || keys.record_key AS grain_key,
              keys.connector_instance_id,
              keys.connector_id,
              keys.stream,
              keys.record_key,
              COALESCE(current_records.current_record_json_bytes, 0) AS current_record_json_bytes,
              COALESCE(history_records.record_history_json_bytes, 0) AS record_history_json_bytes,
              COALESCE(record_blobs.blob_bytes, 0) AS blob_bytes,
              COALESCE(current_records.current_record_json_bytes, 0)
                + COALESCE(history_records.record_history_json_bytes, 0)
                + COALESCE(record_blobs.blob_bytes, 0) AS total_retained_bytes,
              COALESCE(current_records.record_count, 0) AS record_count,
              COALESCE(history_records.record_history_count, 0) AS record_history_count,
              COALESCE(record_blobs.blob_count, 0) AS blob_count
         FROM keys
         LEFT JOIN current_records
           ON current_records.connector_instance_id = keys.connector_instance_id
          AND current_records.stream = keys.stream
          AND current_records.record_key = keys.record_key
         LEFT JOIN history_records
           ON history_records.connector_instance_id = keys.connector_instance_id
          AND history_records.stream = keys.stream
          AND history_records.record_key = keys.record_key
         LEFT JOIN record_blobs
           ON record_blobs.connector_instance_id = keys.connector_instance_id
          AND record_blobs.stream = keys.stream
          AND record_blobs.record_key = keys.record_key
        ORDER BY total_retained_bytes DESC, keys.connector_instance_id ASC, keys.stream ASC, keys.record_key ASC
        LIMIT ?`
      )
      .all(MAX_TOP_LIMIT),
    computedAt
  );
  insertTopRowsSqlite(
    db,
    "blob",
    "blob_bytes",
    db
      .prepare(
        `SELECT blob_bindings.connector_instance_id || char(10) || blob_bindings.stream || char(10) || blob_bindings.record_key || char(10) || blob_bindings.blob_id AS grain_key,
              blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.connector_id AS connector_id,
              blob_bindings.stream AS stream,
              blob_bindings.record_key AS record_key,
              blob_bindings.blob_id AS blob_id,
              blobs.size_bytes AS blob_bytes,
              blobs.size_bytes AS total_retained_bytes,
              1 AS blob_count
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        ORDER BY blobs.size_bytes DESC, blob_bindings.connector_instance_id ASC, blob_bindings.stream ASC, blob_bindings.record_key ASC, blob_bindings.blob_id ASC
        LIMIT ?`
      )
      .all(MAX_TOP_LIMIT),
    computedAt
  );
  insertTopRowsSqlite(
    db,
    "blob",
    "total_retained_bytes",
    db
      .prepare(
        `SELECT blob_bindings.connector_instance_id || char(10) || blob_bindings.stream || char(10) || blob_bindings.record_key || char(10) || blob_bindings.blob_id AS grain_key,
              blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.connector_id AS connector_id,
              blob_bindings.stream AS stream,
              blob_bindings.record_key AS record_key,
              blob_bindings.blob_id AS blob_id,
              blobs.size_bytes AS blob_bytes,
              blobs.size_bytes AS total_retained_bytes,
              1 AS blob_count
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        ORDER BY blobs.size_bytes DESC, blob_bindings.connector_instance_id ASC, blob_bindings.stream ASC, blob_bindings.record_key ASC, blob_bindings.blob_id ASC
        LIMIT ?`
      )
      .all(MAX_TOP_LIMIT),
    computedAt
  );
}

async function insertTopRowsPostgres(
  client: PoolClient,
  scope: RetainedSizeScope,
  measure: RetainedSizeMeasure,
  rows: readonly RetainedSizeRow[],
  computedAt: string
): Promise<void> {
  const metadata = freshTopMetadata(computedAt);
  await runSequentially(rows, async (row, index) => {
    const values = topRowInsertValues(row, index + 1, scope, measure, computedAt, metadata);
    await client.query(
      `INSERT INTO retained_size_top_rows(
         scope, measure, rank, grain_key,
         connector_instance_id, connector_id, stream, record_key, blob_id,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         total_retained_bytes, record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16, 0, $17, $18::jsonb)`,
      values
    );
  });
}

async function refreshRetainedSizeTopRowsPostgres(client: PoolClient, computedAt: string): Promise<void> {
  await client.query("DELETE FROM retained_size_top_rows");
  const topMeasures = [...VALID_TOP_MEASURES];
  await runSequentially(topMeasures, async (measure) => {
    const orderExpr =
      measure === "total_retained_bytes"
        ? "current_record_json_bytes + record_history_json_bytes + blob_bytes"
        : measure;
    const connectionRows = await client.query(
      `SELECT connector_instance_id AS grain_key,
              connector_instance_id,
              connector_id,
              current_record_json_bytes,
              record_history_json_bytes,
              blob_bytes,
              current_record_json_bytes + record_history_json_bytes + blob_bytes AS total_retained_bytes,
              record_count,
              record_history_count,
              blob_count
         FROM retained_size_connection
        ORDER BY ${orderExpr} DESC, connector_instance_id ASC
        LIMIT $1`,
      [MAX_TOP_LIMIT]
    );
    await insertTopRowsPostgres(client, "connection", measure, connectionRows.rows, computedAt);
    const streamRows = await client.query(
      `SELECT connector_instance_id || chr(10) || stream AS grain_key,
              connector_instance_id,
              connector_id,
              stream,
              current_record_json_bytes,
              record_history_json_bytes,
              blob_bytes,
              current_record_json_bytes + record_history_json_bytes + blob_bytes AS total_retained_bytes,
              record_count,
              record_history_count,
              blob_count
         FROM retained_size_stream
        ORDER BY ${orderExpr} DESC, connector_instance_id ASC, stream ASC
        LIMIT $1`,
      [MAX_TOP_LIMIT]
    );
    await insertTopRowsPostgres(client, "stream", measure, streamRows.rows, computedAt);
  });

  const recordCurrentRows = await client.query(
    `SELECT connector_instance_id || chr(10) || stream || chr(10) || record_key AS grain_key,
            connector_instance_id,
            connector_id,
            stream,
            record_key,
            octet_length(record_json::text) AS current_record_json_bytes,
            octet_length(record_json::text) AS total_retained_bytes,
            1 AS record_count
       FROM records
      WHERE deleted = FALSE
      ORDER BY current_record_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT]
  );
  await insertTopRowsPostgres(client, "record", "current_record_json_bytes", recordCurrentRows.rows, computedAt);
  const recordHistoryRows = await client.query(
    `SELECT connector_instance_id || chr(10) || stream || chr(10) || record_key AS grain_key,
            connector_instance_id,
            connector_id,
            stream,
            record_key,
            COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS record_history_json_bytes,
            COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS total_retained_bytes,
            COUNT(*)::bigint AS record_history_count
       FROM record_changes
      GROUP BY connector_instance_id, connector_id, stream, record_key
      ORDER BY record_history_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT]
  );
  await insertTopRowsPostgres(client, "record", "record_history_json_bytes", recordHistoryRows.rows, computedAt);

  const recordTotalRows = await client.query(
    `WITH keys AS (
       SELECT connector_instance_id, connector_id, stream, record_key
         FROM records
        WHERE deleted = FALSE
       UNION
       SELECT connector_instance_id, connector_id, stream, record_key
         FROM record_changes
       UNION
       SELECT connector_instance_id, connector_id, stream, record_key
         FROM blob_bindings
     ),
     current_records AS (
       SELECT connector_instance_id, stream, record_key,
              COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS current_record_json_bytes,
              COUNT(*)::bigint AS record_count
         FROM records
        WHERE deleted = FALSE
        GROUP BY connector_instance_id, stream, record_key
     ),
     history_records AS (
       SELECT connector_instance_id, stream, record_key,
              COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS record_history_json_bytes,
              COUNT(*)::bigint AS record_history_count
         FROM record_changes
        GROUP BY connector_instance_id, stream, record_key
     ),
     record_blobs AS (
       SELECT blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.stream AS stream,
              blob_bindings.record_key AS record_key,
              COALESCE(SUM(blobs.size_bytes), 0)::bigint AS blob_bytes,
              COUNT(*)::bigint AS blob_count
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        GROUP BY blob_bindings.connector_instance_id, blob_bindings.stream, blob_bindings.record_key
     )
     SELECT keys.connector_instance_id || chr(10) || keys.stream || chr(10) || keys.record_key AS grain_key,
            keys.connector_instance_id,
            keys.connector_id,
            keys.stream,
            keys.record_key,
            COALESCE(current_records.current_record_json_bytes, 0)::bigint AS current_record_json_bytes,
            COALESCE(history_records.record_history_json_bytes, 0)::bigint AS record_history_json_bytes,
            COALESCE(record_blobs.blob_bytes, 0)::bigint AS blob_bytes,
            (COALESCE(current_records.current_record_json_bytes, 0)
              + COALESCE(history_records.record_history_json_bytes, 0)
              + COALESCE(record_blobs.blob_bytes, 0))::bigint AS total_retained_bytes,
            COALESCE(current_records.record_count, 0)::bigint AS record_count,
            COALESCE(history_records.record_history_count, 0)::bigint AS record_history_count,
            COALESCE(record_blobs.blob_count, 0)::bigint AS blob_count
       FROM keys
       LEFT JOIN current_records
         ON current_records.connector_instance_id = keys.connector_instance_id
        AND current_records.stream = keys.stream
        AND current_records.record_key = keys.record_key
       LEFT JOIN history_records
         ON history_records.connector_instance_id = keys.connector_instance_id
        AND history_records.stream = keys.stream
        AND history_records.record_key = keys.record_key
       LEFT JOIN record_blobs
         ON record_blobs.connector_instance_id = keys.connector_instance_id
        AND record_blobs.stream = keys.stream
        AND record_blobs.record_key = keys.record_key
      ORDER BY total_retained_bytes DESC, keys.connector_instance_id ASC, keys.stream ASC, keys.record_key ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT]
  );
  await insertTopRowsPostgres(client, "record", "total_retained_bytes", recordTotalRows.rows, computedAt);

  const blobRows = await client.query(
    `SELECT blob_bindings.connector_instance_id || chr(10) || blob_bindings.stream || chr(10) || blob_bindings.record_key || chr(10) || blob_bindings.blob_id AS grain_key,
            blob_bindings.connector_instance_id AS connector_instance_id,
            blob_bindings.connector_id AS connector_id,
            blob_bindings.stream AS stream,
            blob_bindings.record_key AS record_key,
            blob_bindings.blob_id AS blob_id,
            blobs.size_bytes AS blob_bytes,
            blobs.size_bytes AS total_retained_bytes,
            1 AS blob_count
       FROM blob_bindings
       JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
      ORDER BY blobs.size_bytes DESC, blob_bindings.connector_instance_id ASC, blob_bindings.stream ASC, blob_bindings.record_key ASC, blob_bindings.blob_id ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT]
  );
  await insertTopRowsPostgres(client, "blob", "blob_bytes", blobRows.rows, computedAt);
  await insertTopRowsPostgres(client, "blob", "total_retained_bytes", blobRows.rows, computedAt);
}

// ---------------------------------------------------------------------------
// Reconcile (light pass over dirty rows)
// ---------------------------------------------------------------------------

/**
 * Reconcile dirty connection and stream rows by recomputing those rows
 * from canonical state. Reconcile is bounded to "dirty rows only" so it
 * stays cheap relative to a full rebuild. If no rows are dirty, this is
 * a no-op.
 */
export async function reconcileDirtyRetainedSize() {
  return isPostgresStorageBackend() ? await reconcileDirtyPostgres() : reconcileDirtySqlite();
}

function reconcileDirtySqlite(): { streams: number; connections: number } {
  const db = getDb();
  const dirtyStreams = db
    .prepare(
      `SELECT connector_instance_id, connector_id, stream
         FROM retained_size_stream
        WHERE dirty <> 0`
    )
    .all();
  const reconciled = { connections: 0, streams: 0 };
  for (const row of dirtyStreams) {
    reconcileDirtyStreamSqlite(db, row as RetainedSizeRow);
    reconciled.streams += 1;
  }

  const dirtyConnections = db
    .prepare(
      `SELECT connector_instance_id
         FROM retained_size_connection
        WHERE dirty <> 0`
    )
    .all();
  for (const row of dirtyConnections) {
    reconcileDirtyConnectionSqlite(db, row as RetainedSizeRow);
    reconciled.connections += 1;
  }

  recomputeGlobalFromConnectionsSqlite();
  refreshRetainedSizeTopRowsSqlite(db, nowIso());
  return reconciled;
}

function reconcileDirtyStreamSqlite(db: ReturnType<typeof getDb>, row: RetainedSizeRow): void {
  const recompute = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM records WHERE connector_instance_id = ? AND stream = ? AND deleted = 0) AS record_count,
         (SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) FROM records WHERE connector_instance_id = ? AND stream = ? AND deleted = 0) AS current_record_json_bytes,
         (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = ? AND stream = ?) AS record_history_count,
         (SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) FROM record_changes WHERE connector_instance_id = ? AND stream = ?) AS record_history_json_bytes,
         (SELECT COUNT(*) FROM blob_bindings WHERE connector_instance_id = ? AND stream = ?) AS blob_count,
         (SELECT COALESCE(SUM(blobs.size_bytes), 0)
            FROM blob_bindings JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
           WHERE blob_bindings.connector_instance_id = ? AND blob_bindings.stream = ?) AS blob_bytes`
    )
    .get(
      row.connector_instance_id,
      row.stream,
      row.connector_instance_id,
      row.stream,
      row.connector_instance_id,
      row.stream,
      row.connector_instance_id,
      row.stream,
      row.connector_instance_id,
      row.stream,
      row.connector_instance_id,
      row.stream
    );
  db.prepare(
    `UPDATE retained_size_stream SET
       current_record_json_bytes = ?,
       record_history_json_bytes = ?,
       blob_bytes = ?,
       record_count = ?,
       record_history_count = ?,
       blob_count = ?,
       dirty = 0,
       computed_at = ?
     WHERE connector_instance_id = ? AND stream = ?`
  ).run(...reconciledStreamValues(recompute as RetainedSizeRow, row));
}

function reconcileDirtyConnectionSqlite(db: ReturnType<typeof getDb>, row: RetainedSizeRow): void {
  const sums = db
    .prepare(
      `SELECT
         COALESCE(SUM(current_record_json_bytes), 0) AS current_record_json_bytes,
         COALESCE(SUM(record_history_json_bytes), 0) AS record_history_json_bytes,
         COALESCE(SUM(blob_bytes), 0) AS blob_bytes,
         COALESCE(SUM(record_count), 0) AS record_count,
         COALESCE(SUM(record_history_count), 0) AS record_history_count,
         COALESCE(SUM(blob_count), 0) AS blob_count
       FROM retained_size_stream
      WHERE connector_instance_id = ?`
    )
    .get(row.connector_instance_id);
  db.prepare(
    `UPDATE retained_size_connection SET
       current_record_json_bytes = ?,
       record_history_json_bytes = ?,
       blob_bytes = ?,
       record_count = ?,
       record_history_count = ?,
       blob_count = ?,
       dirty = 0,
       computed_at = ?
     WHERE connector_instance_id = ?`
  ).run(...reconciledConnectionValues(sums as RetainedSizeRow, row));
}

function reconciledStreamValues(measures: RetainedSizeRow, row: RetainedSizeRow): SqlValue[] {
  return [...Object.values(numericMeasures(measures)), nowIso(), row.connector_instance_id, row.stream];
}

function reconciledConnectionValues(measures: RetainedSizeRow, row: RetainedSizeRow): SqlValue[] {
  return [...Object.values(numericMeasures(measures)), nowIso(), row.connector_instance_id];
}

function recomputeGlobalFromConnectionsSqlite(): void {
  const sums = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(current_record_json_bytes), 0) AS current_record_json_bytes,
         COALESCE(SUM(record_history_json_bytes), 0) AS record_history_json_bytes,
         COALESCE(SUM(blob_bytes), 0) AS blob_bytes,
         COALESCE(SUM(record_count), 0) AS record_count,
         COALESCE(SUM(record_history_count), 0) AS record_history_count,
         COALESCE(SUM(blob_count), 0) AS blob_count,
         MAX(dirty) AS dirty
       FROM retained_size_connection`
    )
    .get();
  const stillDirty = sums ? isDirtyRow(sums as RetainedSizeRow) : false;
  const at = nowIso();
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         current_record_json_bytes = excluded.current_record_json_bytes,
         record_history_json_bytes = excluded.record_history_json_bytes,
         blob_bytes = excluded.blob_bytes,
         record_count = excluded.record_count,
         record_history_count = excluded.record_history_count,
         blob_count = excluded.blob_count,
         dirty = excluded.dirty,
         computed_at = excluded.computed_at,
         metadata_json = excluded.metadata_json`
    )
    .run(...reconciledGlobalValues(sums as RetainedSizeRow, stillDirty, at));
}

function reconciledGlobalValues(sums: RetainedSizeRow, stillDirty: boolean, at: string) {
  return [
    GLOBAL_KEY,
    ...Object.values(numericMeasures(sums)),
    stillDirty ? 1 : 0,
    at,
    reconciledGlobalMetadata(stillDirty, at),
  ];
}

function reconciledGlobalMetadata(stillDirty: boolean, at: string): string {
  return JSON.stringify({
    last_error: stillDirty ? "connection rows remain dirty after reconcile" : null,
    rebuild_status: "idle",
    stale_since: stillDirty ? at : null,
    state: stillDirty ? "stale" : "fresh",
  });
}

async function reconcileDirtyPostgres(): Promise<{ streams: number; connections: number }> {
  const reconciled = { connections: 0, streams: 0 };
  const dirtyStreams = (await postgresQuery(
    `SELECT connector_instance_id, connector_id, stream
       FROM retained_size_stream
      WHERE dirty <> 0`
  )) as { rows: RetainedSizeRow[] };
  await runSequentially(dirtyStreams.rows, async (row) => {
    await reconcileDirtyStreamPostgres(row);
    reconciled.streams += 1;
  });
  const dirtyConnections = (await postgresQuery(
    `SELECT connector_instance_id
       FROM retained_size_connection
      WHERE dirty <> 0`
  )) as { rows: RetainedSizeRow[] };
  await runSequentially(dirtyConnections.rows, async (row) => {
    await reconcileDirtyConnectionPostgres(row);
    reconciled.connections += 1;
  });
  await recomputeGlobalFromConnectionsPostgres();
  await withPostgresTransaction(async (client: PoolClient) => {
    await refreshRetainedSizeTopRowsPostgres(client, nowIso());
  });
  return reconciled;
}

async function reconcileDirtyStreamPostgres(row: RetainedSizeRow): Promise<void> {
  const recompute = await postgresQuery(
    `SELECT
       (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE)::bigint AS record_count,
       (SELECT COALESCE(SUM(octet_length(record_json::text)), 0) FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE)::bigint AS current_record_json_bytes,
       (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = $2)::bigint AS record_history_count,
       (SELECT COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0) FROM record_changes WHERE connector_instance_id = $1 AND stream = $2)::bigint AS record_history_json_bytes,
       (SELECT COUNT(*) FROM blob_bindings WHERE connector_instance_id = $1 AND stream = $2)::bigint AS blob_count,
       (SELECT COALESCE(SUM(blobs.size_bytes), 0)
          FROM blob_bindings JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
         WHERE blob_bindings.connector_instance_id = $1 AND blob_bindings.stream = $2)::bigint AS blob_bytes`,
    [row.connector_instance_id, row.stream]
  );
  await postgresQuery(
    `UPDATE retained_size_stream SET
       current_record_json_bytes = $1,
       record_history_json_bytes = $2,
       blob_bytes = $3,
       record_count = $4,
       record_history_count = $5,
       blob_count = $6,
       dirty = 0,
       computed_at = $7
     WHERE connector_instance_id = $8 AND stream = $9`,
    reconciledStreamValues(recompute.rows[0] || {}, row)
  );
}

async function reconcileDirtyConnectionPostgres(row: RetainedSizeRow): Promise<void> {
  const sums = await postgresQuery(
    `SELECT
       COALESCE(SUM(current_record_json_bytes), 0)::bigint AS current_record_json_bytes,
       COALESCE(SUM(record_history_json_bytes), 0)::bigint AS record_history_json_bytes,
       COALESCE(SUM(blob_bytes), 0)::bigint AS blob_bytes,
       COALESCE(SUM(record_count), 0)::bigint AS record_count,
       COALESCE(SUM(record_history_count), 0)::bigint AS record_history_count,
       COALESCE(SUM(blob_count), 0)::bigint AS blob_count
     FROM retained_size_stream
    WHERE connector_instance_id = $1`,
    [row.connector_instance_id]
  );
  await postgresQuery(
    `UPDATE retained_size_connection SET
       current_record_json_bytes = $1,
       record_history_json_bytes = $2,
       blob_bytes = $3,
       record_count = $4,
       record_history_count = $5,
       blob_count = $6,
       dirty = 0,
       computed_at = $7
     WHERE connector_instance_id = $8`,
    reconciledConnectionValues(sums.rows[0] || {}, row)
  );
}

async function recomputeGlobalFromConnectionsPostgres(): Promise<void> {
  const sums = await postgresQuery(
    `SELECT
       COALESCE(SUM(current_record_json_bytes), 0)::bigint AS current_record_json_bytes,
       COALESCE(SUM(record_history_json_bytes), 0)::bigint AS record_history_json_bytes,
       COALESCE(SUM(blob_bytes), 0)::bigint AS blob_bytes,
       COALESCE(SUM(record_count), 0)::bigint AS record_count,
       COALESCE(SUM(record_history_count), 0)::bigint AS record_history_count,
       COALESCE(SUM(blob_count), 0)::bigint AS blob_count,
       COALESCE(MAX(dirty), 0)::int AS dirty
     FROM retained_size_connection`
  );
  const s = sums.rows[0] || {};
  const stillDirty = isDirtyRow(s);
  const at = nowIso();
  await postgresQuery(
    `INSERT INTO retained_size_global(
       projection_key,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (projection_key) DO UPDATE SET
       current_record_json_bytes = EXCLUDED.current_record_json_bytes,
       record_history_json_bytes = EXCLUDED.record_history_json_bytes,
       blob_bytes = EXCLUDED.blob_bytes,
       record_count = EXCLUDED.record_count,
       record_history_count = EXCLUDED.record_history_count,
       blob_count = EXCLUDED.blob_count,
       dirty = EXCLUDED.dirty,
       computed_at = EXCLUDED.computed_at,
       metadata_json = EXCLUDED.metadata_json`,
    reconciledGlobalValues(s, stillDirty, at)
  );
}

// ---------------------------------------------------------------------------
// Metadata transitions used by rebuild
// ---------------------------------------------------------------------------

async function markRetainedSizeRebuilding(at: string): Promise<void> {
  const metadata = {
    last_error: null,
    rebuild_status: "running",
    stale_since: at,
    state: "rebuilding",
  };
  await getRetainedSizeStore().upsertGlobalRebuilding({ at, metadataJson: JSON.stringify(metadata) });
}

async function markRetainedSizeFresh(at: string): Promise<void> {
  const metadata = {
    last_error: null,
    rebuild_status: "idle",
    stale_since: null,
    state: "fresh",
  };
  await getRetainedSizeStore().updateGlobalFresh({ at, metadataJson: JSON.stringify(metadata) });
}

async function markRetainedSizeFailed(err: unknown): Promise<void> {
  const metadata = {
    last_error: sanitizeProjectionError(err),
    rebuild_status: "failed",
    stale_since: nowIso(),
    state: "failed",
  };
  try {
    await getRetainedSizeStore().upsertGlobalFailed({ at: nowIso(), metadataJson: JSON.stringify(metadata) });
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Exports for limits / constants (test surface)
// ---------------------------------------------------------------------------

export const RETAINED_SIZE_LIMITS = Object.freeze({
  DEFAULT_TOP_LIMIT,
  MAX_TOP_LIMIT,
  VALID_TOP_MEASURES: [...VALID_TOP_MEASURES],
  VALID_TOP_SCOPES: [...VALID_TOP_SCOPES],
});

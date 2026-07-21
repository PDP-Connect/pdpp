import { createHash } from "node:crypto";

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import { postgresQuery } from "../postgres-storage.js";

const DEFAULT_LIST_LIMIT = 25;

/** Raw `acquisition_batches` row as returned by the storage backends. */
interface AcquisitionBatchRow {
  accepted_count: number | string | null;
  acquisition_method: string;
  artifact_sha256: string | null;
  batch_id: string;
  connector_id: string;
  connector_instance_id: string | null;
  created_at: string;
  duplicate_count: number | string | null;
  event_time_end: string | null;
  event_time_start: string | null;
  failed_count: number | string | null;
  media_coverage_json: string | null;
  owner_subject_id: string;
  parsed_count: number | string | null;
  parser_version: string | null;
  receipt_json: string | null;
  skipped_count: number | string | null;
  source_format: string | null;
  status: string;
  updated_at: string;
  uploaded_file_name: string | null;
  warnings_json: string | null;
}

/** Domain view of an acquisition batch (camelCase, JSON columns parsed). */
export interface AcquisitionBatch {
  acceptedCount: number | null;
  acquisitionMethod: string;
  artifactSha256: string | null;
  batchId: string;
  connectorId: string;
  connectorInstanceId: string | null;
  createdAt: string;
  duplicateCount: number | null;
  eventTimeEnd: string | null;
  eventTimeStart: string | null;
  failedCount: number | null;
  mediaCoverage: unknown;
  ownerSubjectId: string;
  parsedCount: number | null;
  parserVersion: string | null;
  receipt: unknown;
  skippedCount: number | null;
  sourceFormat: string | null;
  status: string;
  updatedAt: string;
  uploadedFileName: string | null;
  warnings: unknown;
}

/** Caller-supplied owner-artifact batch insert record. */
export interface AcquisitionBatchInsert {
  acceptedCount?: number | null;
  acquisitionMethod?: string;
  artifactSha256: string;
  batchId?: string;
  connectorId: string;
  connectorInstanceId: string;
  createdAt?: string;
  duplicateCount?: number | null;
  eventTimeEnd?: string | null;
  eventTimeStart?: string | null;
  failedCount?: number | null;
  mediaCoverage?: unknown;
  now?: string;
  ownerSubjectId: string;
  parsedCount?: number | null;
  parserVersion?: string | null;
  receipt?: unknown;
  skippedCount?: number | null;
  sourceFormat?: string | null;
  status?: string;
  updatedAt?: string;
  uploadedFileName?: string | null;
  warnings?: unknown;
}

/** Provenance write input. */
export interface RecordProvenanceInput {
  acquisitionMethod?: string;
  batchId: string;
  connectorInstanceId: string;
  createdAt?: string;
  recordKey: string;
  stream: string;
}

/** Provenance write result. */
export interface RecordProvenanceResult {
  batchId: string;
  connectorInstanceId: string;
  recordKey: string;
  stream: string;
}

interface MarkCommittedOptions {
  acceptedCount?: number;
  failedCount?: number;
  updatedAt?: string;
}
interface ListOptions {
  limit?: number;
}

/** Normalized insert payload (all columns resolved, JSON serialized). */
interface NormalizedInsert {
  acceptedCount: number;
  acquisitionMethod: string;
  artifactSha256: string;
  batchId: string;
  connectorId: string;
  connectorInstanceId: string;
  createdAt: string;
  duplicateCount: number;
  eventTimeEnd: string | null;
  eventTimeStart: string | null;
  failedCount: number;
  mediaCoverageJson: string;
  ownerSubjectId: string;
  parsedCount: number | null;
  parserVersion: string | null;
  receiptJson: string;
  skippedCount: number;
  sourceFormat: string | null;
  status: string;
  updatedAt: string;
  uploadedFileName: string | null;
  warningsJson: string;
}

export interface SqliteAcquisitionBatchStore {
  findByArtifactHash(ownerSubjectId: string, connectorId: string, artifactSha256: string): AcquisitionBatch | null;
  get(batchId: string): AcquisitionBatch | null;
  insertOwnerArtifactBatch(record: AcquisitionBatchInsert): AcquisitionBatch | null;
  listByConnection(connectorInstanceId: string, opts?: ListOptions): (AcquisitionBatch | null)[];
  markCommittedForConnection(connectorInstanceId: string, opts?: MarkCommittedOptions): AcquisitionBatch | null;
  recordRecordProvenance(input: RecordProvenanceInput): RecordProvenanceResult;
}

export interface PostgresAcquisitionBatchStore {
  findByArtifactHash(
    ownerSubjectId: string,
    connectorId: string,
    artifactSha256: string
  ): Promise<AcquisitionBatch | null>;
  get(batchId: string): Promise<AcquisitionBatch | null>;
  insertOwnerArtifactBatch(record: AcquisitionBatchInsert): Promise<AcquisitionBatch | null>;
  listByConnection(connectorInstanceId: string, opts?: ListOptions): Promise<(AcquisitionBatch | null)[]>;
  markCommittedForConnection(
    connectorInstanceId: string,
    opts?: MarkCommittedOptions
  ): Promise<AcquisitionBatch | null>;
  recordRecordProvenance(input: RecordProvenanceInput): Promise<RecordProvenanceResult>;
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeAcquisitionBatchId(ownerSubjectId: string, connectorId: string, artifactSha256: string): string {
  return `ab_${hashKey(`${ownerSubjectId}\n${connectorId}\n${artifactSha256}`).slice(0, 24)}`;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value == null) {
    return fallback;
  }
  if (typeof value !== "string") {
    return value ?? fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapRow(row: AcquisitionBatchRow | null | undefined): AcquisitionBatch | null {
  if (!row) {
    return null;
  }
  return {
    batchId: row.batch_id,
    ownerSubjectId: row.owner_subject_id,
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    acquisitionMethod: row.acquisition_method,
    sourceFormat: row.source_format,
    parserVersion: row.parser_version,
    artifactSha256: row.artifact_sha256,
    uploadedFileName: row.uploaded_file_name,
    status: row.status,
    eventTimeStart: row.event_time_start,
    eventTimeEnd: row.event_time_end,
    parsedCount: numberOrNull(row.parsed_count),
    acceptedCount: numberOrNull(row.accepted_count),
    duplicateCount: numberOrNull(row.duplicate_count),
    skippedCount: numberOrNull(row.skipped_count),
    failedCount: numberOrNull(row.failed_count),
    mediaCoverage: parseJson(row.media_coverage_json, null),
    warnings: parseJson(row.warnings_json, []),
    receipt: parseJson(row.receipt_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sqliteGetOne(sql: string, params: readonly (string | number | null)[] = []): AcquisitionBatchRow | null {
  return [...iterateDynamicSqlAcknowledged<AcquisitionBatchRow>(sql, params)][0] ?? null;
}

function sqliteList(sql: string, params: readonly (string | number | null)[] = []): AcquisitionBatchRow[] {
  return [...iterateDynamicSqlAcknowledged<AcquisitionBatchRow>(sql, params)];
}

interface RequiredInsertFields {
  artifactSha256: string;
  connectorId: string;
  connectorInstanceId: string;
  ownerSubjectId: string;
}

// Assert the four fields that have no fallback and would otherwise persist an
// invalid owner-artifact batch. Throws the same messages the inline guards did.
function assertRequiredInsertFields(record: AcquisitionBatchInsert): RequiredInsertFields {
  if (!record.ownerSubjectId) {
    throw new Error("ownerSubjectId is required.");
  }
  if (!record.connectorId) {
    throw new Error("connectorId is required.");
  }
  if (!record.connectorInstanceId) {
    throw new Error("connectorInstanceId is required.");
  }
  if (!record.artifactSha256) {
    throw new Error("artifactSha256 is required for owner-artifact batches.");
  }
  return {
    ownerSubjectId: record.ownerSubjectId,
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId,
    artifactSha256: record.artifactSha256,
  };
}

function normalizeInsert(record: AcquisitionBatchInsert): NormalizedInsert {
  const { ownerSubjectId, connectorId, connectorInstanceId, artifactSha256 } = assertRequiredInsertFields(record);
  const now = record.now ?? new Date().toISOString();
  return {
    batchId: record.batchId ?? makeAcquisitionBatchId(ownerSubjectId, connectorId, artifactSha256),
    ownerSubjectId,
    connectorId,
    connectorInstanceId,
    acquisitionMethod: record.acquisitionMethod ?? "owner_artifact",
    sourceFormat: record.sourceFormat ?? null,
    parserVersion: record.parserVersion ?? null,
    artifactSha256,
    uploadedFileName: record.uploadedFileName ?? null,
    status: record.status ?? "validated",
    eventTimeStart: record.eventTimeStart ?? null,
    eventTimeEnd: record.eventTimeEnd ?? null,
    parsedCount: record.parsedCount ?? null,
    acceptedCount: record.acceptedCount ?? 0,
    duplicateCount: record.duplicateCount ?? 0,
    skippedCount: record.skippedCount ?? 0,
    failedCount: record.failedCount ?? 0,
    mediaCoverageJson: stringifyJson(record.mediaCoverage ?? null),
    warningsJson: stringifyJson(record.warnings ?? []),
    receiptJson: stringifyJson(record.receipt ?? null),
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
  };
}

export function createSqliteAcquisitionBatchStore(): SqliteAcquisitionBatchStore {
  return {
    insertOwnerArtifactBatch(record: AcquisitionBatchInsert): AcquisitionBatch | null {
      const row = normalizeInsert(record);
      // REVIEWED-DYNAMIC: store-owned mutation; acquisition_batches is created
      // by this change and has no registered query artifact yet.
      execDynamicSqlAcknowledged(
        `INSERT INTO acquisition_batches(
           batch_id, owner_subject_id, connector_id, connector_instance_id,
           acquisition_method, source_format, parser_version, artifact_sha256,
           uploaded_file_name, status, event_time_start, event_time_end,
           parsed_count, accepted_count, duplicate_count, skipped_count, failed_count,
           media_coverage_json, warnings_json, receipt_json, created_at, updated_at
         )
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(batch_id) DO UPDATE SET
           connector_instance_id = excluded.connector_instance_id,
           uploaded_file_name = excluded.uploaded_file_name,
           updated_at = excluded.updated_at`,
        [
          row.batchId,
          row.ownerSubjectId,
          row.connectorId,
          row.connectorInstanceId,
          row.acquisitionMethod,
          row.sourceFormat,
          row.parserVersion,
          row.artifactSha256,
          row.uploadedFileName,
          row.status,
          row.eventTimeStart,
          row.eventTimeEnd,
          row.parsedCount,
          row.acceptedCount,
          row.duplicateCount,
          row.skippedCount,
          row.failedCount,
          row.mediaCoverageJson,
          row.warningsJson,
          row.receiptJson,
          row.createdAt,
          row.updatedAt,
        ]
      );
      return this.get(row.batchId);
    },

    findByArtifactHash(ownerSubjectId: string, connectorId: string, artifactSha256: string): AcquisitionBatch | null {
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned table.
      const row = sqliteGetOne(
        `SELECT *
           FROM acquisition_batches
          WHERE owner_subject_id = ?
            AND connector_id = ?
            AND artifact_sha256 = ?
          ORDER BY created_at ASC
          LIMIT 1`,
        [ownerSubjectId, connectorId, artifactSha256]
      );
      return mapRow(row);
    },

    get(batchId: string): AcquisitionBatch | null {
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned table.
      return mapRow(sqliteGetOne("SELECT * FROM acquisition_batches WHERE batch_id = ? LIMIT 1", [batchId]));
    },

    listByConnection(
      connectorInstanceId: string,
      { limit = DEFAULT_LIST_LIMIT }: ListOptions = {}
    ): (AcquisitionBatch | null)[] {
      // REVIEWED-DYNAMIC: bounded listing for the store-owned table.
      const rows = sqliteList(
        `SELECT *
           FROM acquisition_batches
          WHERE connector_instance_id = ?
          ORDER BY created_at DESC, batch_id DESC
          LIMIT ?`,
        [connectorInstanceId, limit]
      );
      return rows.map(mapRow);
    },

    recordRecordProvenance({
      connectorInstanceId,
      stream,
      recordKey,
      batchId,
      acquisitionMethod = "owner_artifact",
      createdAt,
    }: RecordProvenanceInput): RecordProvenanceResult {
      const now = createdAt ?? new Date().toISOString();
      // REVIEWED-DYNAMIC: store-owned provenance mutation.
      execDynamicSqlAcknowledged(
        `INSERT OR IGNORE INTO record_acquisition_provenance(
           connector_instance_id, stream, record_key, batch_id, acquisition_method, created_at
         )
         VALUES(?, ?, ?, ?, ?, ?)`,
        [connectorInstanceId, stream, recordKey, batchId, acquisitionMethod, now]
      );
      return { batchId, connectorInstanceId, recordKey, stream };
    },

    markCommittedForConnection(
      connectorInstanceId: string,
      { acceptedCount = 0, failedCount = 0, updatedAt }: MarkCommittedOptions = {}
    ): AcquisitionBatch | null {
      const now = updatedAt ?? new Date().toISOString();
      // REVIEWED-DYNAMIC: store-owned mutation that targets the latest active
      // batch for one connection.
      execDynamicSqlAcknowledged(
        `UPDATE acquisition_batches
            SET status = CASE WHEN status = 'validated' THEN 'committed' ELSE status END,
                accepted_count = COALESCE(accepted_count, 0) + ?,
                failed_count = COALESCE(failed_count, 0) + ?,
                updated_at = ?
          WHERE batch_id = (
            SELECT batch_id
              FROM acquisition_batches
             WHERE connector_instance_id = ?
               AND status IN ('validated', 'committed')
             ORDER BY created_at DESC, batch_id DESC
             LIMIT 1
          )`,
        [acceptedCount, failedCount, now, connectorInstanceId]
      );
      return this.listByConnection(connectorInstanceId, { limit: 1 })[0] ?? null;
    },
  };
}

export function createPostgresAcquisitionBatchStore(): PostgresAcquisitionBatchStore {
  return {
    async insertOwnerArtifactBatch(record: AcquisitionBatchInsert): Promise<AcquisitionBatch | null> {
      const row = normalizeInsert(record);
      await postgresQuery(
        `INSERT INTO acquisition_batches(
           batch_id, owner_subject_id, connector_id, connector_instance_id,
           acquisition_method, source_format, parser_version, artifact_sha256,
           uploaded_file_name, status, event_time_start, event_time_end,
           parsed_count, accepted_count, duplicate_count, skipped_count, failed_count,
           media_coverage_json, warnings_json, receipt_json, created_at, updated_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21, $22)
         ON CONFLICT(batch_id) DO UPDATE SET
           connector_instance_id = EXCLUDED.connector_instance_id,
           uploaded_file_name = EXCLUDED.uploaded_file_name,
           updated_at = EXCLUDED.updated_at`,
        [
          row.batchId,
          row.ownerSubjectId,
          row.connectorId,
          row.connectorInstanceId,
          row.acquisitionMethod,
          row.sourceFormat,
          row.parserVersion,
          row.artifactSha256,
          row.uploadedFileName,
          row.status,
          row.eventTimeStart,
          row.eventTimeEnd,
          row.parsedCount,
          row.acceptedCount,
          row.duplicateCount,
          row.skippedCount,
          row.failedCount,
          row.mediaCoverageJson,
          row.warningsJson,
          row.receiptJson,
          row.createdAt,
          row.updatedAt,
        ]
      );
      return await this.get(row.batchId);
    },

    async findByArtifactHash(
      ownerSubjectId: string,
      connectorId: string,
      artifactSha256: string
    ): Promise<AcquisitionBatch | null> {
      const result = await postgresQuery(
        `SELECT *
           FROM acquisition_batches
          WHERE owner_subject_id = $1
            AND connector_id = $2
            AND artifact_sha256 = $3
          ORDER BY created_at ASC
          LIMIT 1`,
        [ownerSubjectId, connectorId, artifactSha256]
      );
      return mapRow(result.rows[0]);
    },

    async get(batchId: string): Promise<AcquisitionBatch | null> {
      const result = await postgresQuery("SELECT * FROM acquisition_batches WHERE batch_id = $1", [batchId]);
      return mapRow(result.rows[0]);
    },

    async listByConnection(
      connectorInstanceId: string,
      { limit = DEFAULT_LIST_LIMIT }: ListOptions = {}
    ): Promise<(AcquisitionBatch | null)[]> {
      const result = await postgresQuery(
        `SELECT *
           FROM acquisition_batches
          WHERE connector_instance_id = $1
          ORDER BY created_at DESC, batch_id DESC
          LIMIT $2`,
        [connectorInstanceId, limit]
      );
      return result.rows.map(mapRow);
    },

    async recordRecordProvenance({
      connectorInstanceId,
      stream,
      recordKey,
      batchId,
      acquisitionMethod = "owner_artifact",
      createdAt,
    }: RecordProvenanceInput): Promise<RecordProvenanceResult> {
      const now = createdAt ?? new Date().toISOString();
      await postgresQuery(
        `INSERT INTO record_acquisition_provenance(
           connector_instance_id, stream, record_key, batch_id, acquisition_method, created_at
         )
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connector_instance_id, stream, record_key, batch_id) DO NOTHING`,
        [connectorInstanceId, stream, recordKey, batchId, acquisitionMethod, now]
      );
      return { batchId, connectorInstanceId, recordKey, stream };
    },

    async markCommittedForConnection(
      connectorInstanceId: string,
      { acceptedCount = 0, failedCount = 0, updatedAt }: MarkCommittedOptions = {}
    ): Promise<AcquisitionBatch | null> {
      const now = updatedAt ?? new Date().toISOString();
      await postgresQuery(
        `UPDATE acquisition_batches
            SET status = CASE WHEN status = 'validated' THEN 'committed' ELSE status END,
                accepted_count = COALESCE(accepted_count, 0) + $1,
                failed_count = COALESCE(failed_count, 0) + $2,
                updated_at = $3
          WHERE batch_id = (
            SELECT batch_id
              FROM acquisition_batches
             WHERE connector_instance_id = $4
               AND status IN ('validated', 'committed')
             ORDER BY created_at DESC, batch_id DESC
             LIMIT 1
          )`,
        [acceptedCount, failedCount, now, connectorInstanceId]
      );
      const rows = await this.listByConnection(connectorInstanceId, { limit: 1 });
      return rows[0] ?? null;
    },
  };
}

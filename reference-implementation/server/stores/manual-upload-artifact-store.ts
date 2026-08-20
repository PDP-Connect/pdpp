// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import { postgresQuery } from "../postgres-storage.ts";

const DEFAULT_LIST_LIMIT = 20;
const VALID_STATUSES = new Set(["uploaded", "validating", "staged", "duplicate", "failed"]);
const REQUIRED_INSERT_FIELDS = [
  ["artifactId", "artifactId is required."],
  ["ownerSubjectId", "ownerSubjectId is required."],
  ["connectorId", "connectorId is required."],
  ["fileName", "fileName is required."],
  ["stagingPath", "stagingPath is required."],
] as const;

/** Raw `manual_upload_artifacts` row as returned by the storage backends. */
interface ManualUploadArtifactRow {
  acquisition_batch_id: string | null;
  artifact_id: string;
  artifact_sha256: string | null;
  connector_id: string;
  connector_instance_id: string | null;
  created_at: string;
  error_json: string | null;
  file_name: string;
  file_size_bytes: number | string | null;
  final_path: string | null;
  owner_subject_id: string;
  staging_path: string;
  status: string;
  updated_at: string;
  validation_json: string | null;
}

/** Domain view of a manual-upload artifact (camelCase, JSON columns parsed). */
export interface ManualUploadArtifact {
  acquisitionBatchId: string | null;
  artifactId: string;
  artifactSha256: string | null;
  connectorId: string;
  connectorInstanceId: string | null;
  createdAt: string;
  error: unknown;
  fileName: string;
  fileSizeBytes: number;
  finalPath: string | null;
  ownerSubjectId: string;
  stagingPath: string;
  status: string;
  updatedAt: string;
  validation: unknown;
}

/** Caller-supplied insert record. */
export interface ManualUploadArtifactInsert {
  acquisitionBatchId?: string | null;
  artifactId: string;
  artifactSha256?: string | null;
  connectorId: string;
  connectorInstanceId?: string | null;
  createdAt?: string;
  error?: unknown;
  fileName: string;
  fileSizeBytes?: number | null;
  finalPath?: string | null;
  now?: string;
  ownerSubjectId: string;
  stagingPath: string;
  status?: string;
  updatedAt?: string;
  validation?: unknown;
}

/** Caller-supplied partial update. */
export interface ManualUploadArtifactPatch {
  acquisitionBatchId?: string | null;
  artifactSha256?: string | null;
  connectorInstanceId?: string | null;
  error?: unknown;
  fileSizeBytes?: number | null;
  finalPath?: string | null;
  status?: string | null;
  updatedAt?: string;
  validation?: unknown;
}

interface ListOptions {
  limit?: number;
}

/** Normalized insert payload (all columns resolved, JSON serialized). */
interface NormalizedInsert {
  acquisitionBatchId: string | null;
  artifactId: string;
  artifactSha256: string | null;
  connectorId: string;
  connectorInstanceId: string | null;
  createdAt: string;
  errorJson: string | null;
  fileName: string;
  fileSizeBytes: number;
  finalPath: string | null;
  ownerSubjectId: string;
  stagingPath: string;
  status: string;
  updatedAt: string;
  validationJson: string | null;
}

/** Normalized patch payload; JSON fields are `undefined` when not present. */
interface NormalizedPatch {
  acquisitionBatchId: string | null;
  artifactSha256: string | null;
  connectorInstanceId: string | null;
  errorJson: string | null | undefined;
  fileSizeBytes: number | null;
  finalPath: string | null;
  status: string | null;
  updatedAt: string;
  validationJson: string | null | undefined;
}

/** Statuses that represent in-flight work with no owning process once the
 *  server that started them has restarted -- see listInFlightOlderThan's
 *  doc comment. */
const IN_FLIGHT_STATUSES = ["uploaded", "validating"] as const;

export interface SqliteManualUploadArtifactStore {
  claimForSweep: (artifactId: string, cutoffIso: string, nowIso: string) => boolean;
  get: (artifactId: string) => ManualUploadArtifact | null;
  insert: (record: ManualUploadArtifactInsert) => ManualUploadArtifact | null;
  listByConnection: (connectorInstanceId: string, opts?: ListOptions) => (ManualUploadArtifact | null)[];
  listInFlightOlderThan: (cutoffIso: string) => ManualUploadArtifact[];
  update: (artifactId: string, patch: ManualUploadArtifactPatch) => ManualUploadArtifact | null;
}

export interface PostgresManualUploadArtifactStore {
  claimForSweep: (artifactId: string, cutoffIso: string, nowIso: string) => Promise<boolean>;
  get: (artifactId: string) => Promise<ManualUploadArtifact | null>;
  insert: (record: ManualUploadArtifactInsert) => Promise<ManualUploadArtifact | null>;
  listByConnection: (connectorInstanceId: string, opts?: ListOptions) => Promise<(ManualUploadArtifact | null)[]>;
  listInFlightOlderThan: (cutoffIso: string) => Promise<ManualUploadArtifact[]>;
  update: (artifactId: string, patch: ManualUploadArtifactPatch) => Promise<ManualUploadArtifact | null>;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value === null) {
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

function stringifyJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
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

function mapRow(row: ManualUploadArtifactRow | null | undefined): ManualUploadArtifact | null {
  if (!row) {
    return null;
  }
  return {
    acquisitionBatchId: row.acquisition_batch_id,
    artifactId: row.artifact_id,
    artifactSha256: row.artifact_sha256,
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    createdAt: row.created_at,
    error: parseJson(row.error_json, null),
    fileName: row.file_name,
    fileSizeBytes: numberOrNull(row.file_size_bytes) ?? 0,
    finalPath: row.final_path,
    ownerSubjectId: row.owner_subject_id,
    stagingPath: row.staging_path,
    status: row.status,
    updatedAt: row.updated_at,
    validation: parseJson(row.validation_json, null),
  };
}

function sqliteGetOne(sql: string, params: readonly (string | number | null)[] = []): ManualUploadArtifactRow | null {
  return [...iterateDynamicSqlAcknowledged<ManualUploadArtifactRow>(sql, params)][0] ?? null;
}

function sqliteList(sql: string, params: readonly (string | number | null)[] = []): ManualUploadArtifactRow[] {
  return [...iterateDynamicSqlAcknowledged<ManualUploadArtifactRow>(sql, params)];
}

function normalizeInsert(record: ManualUploadArtifactInsert): NormalizedInsert {
  for (const [fieldName, message] of REQUIRED_INSERT_FIELDS) {
    if (!record[fieldName]) {
      throw new Error(message);
    }
  }
  if (!VALID_STATUSES.has(record.status ?? "uploaded")) {
    throw new Error(`Invalid manual upload artifact status '${record.status}'.`);
  }
  const normalizedRecord = { ...record };
  normalizedRecord.connectorInstanceId ??= null;
  normalizedRecord.finalPath ??= null;
  normalizedRecord.fileSizeBytes ??= 0;
  normalizedRecord.artifactSha256 ??= null;
  normalizedRecord.status ??= "uploaded";
  normalizedRecord.acquisitionBatchId ??= null;
  normalizedRecord.now ??= new Date().toISOString();
  normalizedRecord.createdAt ??= normalizedRecord.now;
  normalizedRecord.updatedAt ??= normalizedRecord.now;
  return {
    acquisitionBatchId: normalizedRecord.acquisitionBatchId,
    artifactId: normalizedRecord.artifactId,
    artifactSha256: normalizedRecord.artifactSha256,
    connectorId: normalizedRecord.connectorId,
    connectorInstanceId: normalizedRecord.connectorInstanceId,
    createdAt: normalizedRecord.createdAt,
    errorJson: stringifyJson(normalizedRecord.error),
    fileName: normalizedRecord.fileName,
    fileSizeBytes: normalizedRecord.fileSizeBytes,
    finalPath: normalizedRecord.finalPath,
    ownerSubjectId: normalizedRecord.ownerSubjectId,
    stagingPath: normalizedRecord.stagingPath,
    status: normalizedRecord.status,
    updatedAt: normalizedRecord.updatedAt,
    validationJson: stringifyJson(normalizedRecord.validation),
  };
}

function normalizePatch(patch: ManualUploadArtifactPatch): NormalizedPatch {
  if (patch.status !== null && patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`Invalid manual upload artifact status '${patch.status}'.`);
  }
  return {
    acquisitionBatchId: patch.acquisitionBatchId ?? null,
    artifactSha256: patch.artifactSha256 ?? null,
    connectorInstanceId: patch.connectorInstanceId ?? null,
    errorJson: Object.hasOwn(patch, "error") ? stringifyJson(patch.error) : undefined,
    fileSizeBytes: patch.fileSizeBytes ?? null,
    finalPath: patch.finalPath ?? null,
    status: patch.status ?? null,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
    validationJson: Object.hasOwn(patch, "validation") ? stringifyJson(patch.validation) : undefined,
  };
}

export function createSqliteManualUploadArtifactStore(): SqliteManualUploadArtifactStore {
  return {
    claimForSweep(artifactId: string, cutoffIso: string, nowIso: string): boolean {
      const result = execDynamicSqlAcknowledged(
        `UPDATE manual_upload_artifacts
            SET status = 'validating',
                updated_at = ?
          WHERE artifact_id = ?
            AND status IN (${IN_FLIGHT_STATUSES.map(() => "?").join(", ")})
            AND updated_at < ?`,
        [nowIso, artifactId, ...IN_FLIGHT_STATUSES, cutoffIso]
      );
      return result.changes > 0;
    },
    get(artifactId: string): ManualUploadArtifact | null {
      return mapRow(sqliteGetOne("SELECT * FROM manual_upload_artifacts WHERE artifact_id = ? LIMIT 1", [artifactId]));
    },
    insert(record: ManualUploadArtifactInsert): ManualUploadArtifact | null {
      const row = normalizeInsert(record);
      execDynamicSqlAcknowledged(
        `INSERT INTO manual_upload_artifacts(
           artifact_id, owner_subject_id, connector_id, connector_instance_id,
           file_name, staging_path, final_path, file_size_bytes, artifact_sha256,
           status, acquisition_batch_id, validation_json, error_json,
           created_at, updated_at
         )
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
           status = excluded.status,
           file_size_bytes = excluded.file_size_bytes,
           artifact_sha256 = excluded.artifact_sha256,
           updated_at = excluded.updated_at`,
        [
          row.artifactId,
          row.ownerSubjectId,
          row.connectorId,
          row.connectorInstanceId,
          row.fileName,
          row.stagingPath,
          row.finalPath,
          row.fileSizeBytes,
          row.artifactSha256,
          row.status,
          row.acquisitionBatchId,
          row.validationJson,
          row.errorJson,
          row.createdAt,
          row.updatedAt,
        ]
      );
      return this.get(row.artifactId);
    },

    listByConnection(
      connectorInstanceId: string,
      { limit = DEFAULT_LIST_LIMIT }: ListOptions = {}
    ): (ManualUploadArtifact | null)[] {
      const rows = sqliteList(
        `SELECT *
           FROM manual_upload_artifacts
          WHERE connector_instance_id = ?
          ORDER BY created_at DESC, artifact_id DESC
          LIMIT ?`,
        [connectorInstanceId, limit]
      );
      return rows.map(mapRow);
    },

    listInFlightOlderThan(cutoffIso: string): ManualUploadArtifact[] {
      const rows = sqliteList(
        `SELECT *
           FROM manual_upload_artifacts
          WHERE status IN (${IN_FLIGHT_STATUSES.map(() => "?").join(", ")})
            AND updated_at < ?
          ORDER BY updated_at ASC`,
        [...IN_FLIGHT_STATUSES, cutoffIso]
      );
      return rows.map(mapRow).filter((row): row is ManualUploadArtifact => row !== null);
    },

    update(artifactId: string, patch: ManualUploadArtifactPatch): ManualUploadArtifact | null {
      const next = normalizePatch(patch);
      execDynamicSqlAcknowledged(
        `UPDATE manual_upload_artifacts
            SET status = COALESCE(?, status),
                connector_instance_id = COALESCE(?, connector_instance_id),
                final_path = COALESCE(?, final_path),
                file_size_bytes = COALESCE(?, file_size_bytes),
                artifact_sha256 = COALESCE(?, artifact_sha256),
                acquisition_batch_id = COALESCE(?, acquisition_batch_id),
                validation_json = CASE WHEN ? THEN ? ELSE validation_json END,
                error_json = CASE WHEN ? THEN ? ELSE error_json END,
                updated_at = ?
          WHERE artifact_id = ?`,
        [
          next.status,
          next.connectorInstanceId,
          next.finalPath,
          next.fileSizeBytes,
          next.artifactSha256,
          next.acquisitionBatchId,
          next.validationJson === undefined ? 0 : 1,
          next.validationJson ?? null,
          next.errorJson === undefined ? 0 : 1,
          next.errorJson ?? null,
          next.updatedAt,
          artifactId,
        ]
      );
      return this.get(artifactId);
    },
  };
}

export function createPostgresManualUploadArtifactStore(): PostgresManualUploadArtifactStore {
  return {
    async claimForSweep(artifactId: string, cutoffIso: string, nowIso: string): Promise<boolean> {
      const placeholders = IN_FLIGHT_STATUSES.map((_, i) => `$${i + 3}`).join(", ");
      const result = await postgresQuery(
        `UPDATE manual_upload_artifacts
            SET status = 'validating',
                updated_at = $1
          WHERE artifact_id = $2
            AND status IN (${placeholders})
            AND updated_at < $${IN_FLIGHT_STATUSES.length + 3}`,
        [nowIso, artifactId, ...IN_FLIGHT_STATUSES, cutoffIso]
      );
      return (result.rowCount ?? 0) > 0;
    },
    async get(artifactId: string): Promise<ManualUploadArtifact | null> {
      const result = await postgresQuery<ManualUploadArtifactRow>(
        "SELECT * FROM manual_upload_artifacts WHERE artifact_id = $1 LIMIT 1",
        [artifactId]
      );
      return mapRow(result.rows[0]);
    },
    async insert(record: ManualUploadArtifactInsert): Promise<ManualUploadArtifact | null> {
      const row = normalizeInsert(record);
      await postgresQuery(
        `INSERT INTO manual_upload_artifacts(
           artifact_id, owner_subject_id, connector_id, connector_instance_id,
           file_name, staging_path, final_path, file_size_bytes, artifact_sha256,
           status, acquisition_batch_id, validation_json, error_json,
           created_at, updated_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15)
         ON CONFLICT(artifact_id) DO UPDATE SET
           status = EXCLUDED.status,
           file_size_bytes = EXCLUDED.file_size_bytes,
           artifact_sha256 = EXCLUDED.artifact_sha256,
           updated_at = EXCLUDED.updated_at`,
        [
          row.artifactId,
          row.ownerSubjectId,
          row.connectorId,
          row.connectorInstanceId,
          row.fileName,
          row.stagingPath,
          row.finalPath,
          row.fileSizeBytes,
          row.artifactSha256,
          row.status,
          row.acquisitionBatchId,
          row.validationJson,
          row.errorJson,
          row.createdAt,
          row.updatedAt,
        ]
      );
      return await this.get(row.artifactId);
    },

    async listByConnection(
      connectorInstanceId: string,
      { limit = DEFAULT_LIST_LIMIT }: ListOptions = {}
    ): Promise<(ManualUploadArtifact | null)[]> {
      const result = await postgresQuery<ManualUploadArtifactRow>(
        `SELECT *
           FROM manual_upload_artifacts
          WHERE connector_instance_id = $1
          ORDER BY created_at DESC, artifact_id DESC
          LIMIT $2`,
        [connectorInstanceId, limit]
      );
      return result.rows.map(mapRow);
    },

    async listInFlightOlderThan(cutoffIso: string): Promise<ManualUploadArtifact[]> {
      const placeholders = IN_FLIGHT_STATUSES.map((_, i) => `$${i + 1}`).join(", ");
      const result = await postgresQuery<ManualUploadArtifactRow>(
        `SELECT *
           FROM manual_upload_artifacts
          WHERE status IN (${placeholders})
            AND updated_at < $${IN_FLIGHT_STATUSES.length + 1}
          ORDER BY updated_at ASC`,
        [...IN_FLIGHT_STATUSES, cutoffIso]
      );
      return result.rows.map(mapRow).filter((row): row is ManualUploadArtifact => row !== null);
    },

    async update(artifactId: string, patch: ManualUploadArtifactPatch): Promise<ManualUploadArtifact | null> {
      const next = normalizePatch(patch);
      await postgresQuery(
        `UPDATE manual_upload_artifacts
            SET status = COALESCE($1, status),
                connector_instance_id = COALESCE($2, connector_instance_id),
                final_path = COALESCE($3, final_path),
                file_size_bytes = COALESCE($4, file_size_bytes),
                artifact_sha256 = COALESCE($5, artifact_sha256),
                acquisition_batch_id = COALESCE($6, acquisition_batch_id),
                validation_json = CASE WHEN $7 THEN $8::jsonb ELSE validation_json END,
                error_json = CASE WHEN $9 THEN $10::jsonb ELSE error_json END,
                updated_at = $11
          WHERE artifact_id = $12`,
        [
          next.status,
          next.connectorInstanceId,
          next.finalPath,
          next.fileSizeBytes,
          next.artifactSha256,
          next.acquisitionBatchId,
          next.validationJson !== undefined,
          next.validationJson ?? null,
          next.errorJson !== undefined,
          next.errorJson ?? null,
          next.updatedAt,
          artifactId,
        ]
      );
      return await this.get(artifactId);
    },
  };
}

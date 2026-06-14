import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from '../../lib/db.ts';
import { postgresQuery } from '../postgres-storage.js';

const DEFAULT_LIST_LIMIT = 20;
const VALID_STATUSES = new Set(['uploaded', 'validating', 'staged', 'duplicate', 'failed']);

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapRow(row) {
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    ownerSubjectId: row.owner_subject_id,
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    fileName: row.file_name,
    stagingPath: row.staging_path,
    finalPath: row.final_path,
    fileSizeBytes: numberOrNull(row.file_size_bytes) ?? 0,
    artifactSha256: row.artifact_sha256,
    status: row.status,
    acquisitionBatchId: row.acquisition_batch_id,
    validation: parseJson(row.validation_json, null),
    error: parseJson(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sqliteGetOne(sql, params = []) {
  return [...iterateDynamicSqlAcknowledged(sql, params)][0] ?? null;
}

function sqliteList(sql, params = []) {
  return [...iterateDynamicSqlAcknowledged(sql, params)];
}

function normalizeInsert(record) {
  if (!record.artifactId) throw new Error('artifactId is required.');
  if (!record.ownerSubjectId) throw new Error('ownerSubjectId is required.');
  if (!record.connectorId) throw new Error('connectorId is required.');
  if (!record.fileName) throw new Error('fileName is required.');
  if (!record.stagingPath) throw new Error('stagingPath is required.');
  if (!VALID_STATUSES.has(record.status ?? 'uploaded')) {
    throw new Error(`Invalid manual upload artifact status '${record.status}'.`);
  }
  const now = record.now ?? new Date().toISOString();
  return {
    artifactId: record.artifactId,
    ownerSubjectId: record.ownerSubjectId,
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId ?? null,
    fileName: record.fileName,
    stagingPath: record.stagingPath,
    finalPath: record.finalPath ?? null,
    fileSizeBytes: record.fileSizeBytes ?? 0,
    artifactSha256: record.artifactSha256 ?? null,
    status: record.status ?? 'uploaded',
    acquisitionBatchId: record.acquisitionBatchId ?? null,
    validationJson: stringifyJson(record.validation),
    errorJson: stringifyJson(record.error),
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
  };
}

function normalizePatch(patch) {
  if (patch.status != null && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`Invalid manual upload artifact status '${patch.status}'.`);
  }
  return {
    status: patch.status ?? null,
    connectorInstanceId: patch.connectorInstanceId ?? null,
    finalPath: patch.finalPath ?? null,
    fileSizeBytes: patch.fileSizeBytes ?? null,
    artifactSha256: patch.artifactSha256 ?? null,
    acquisitionBatchId: patch.acquisitionBatchId ?? null,
    validationJson: Object.hasOwn(patch, 'validation') ? stringifyJson(patch.validation) : undefined,
    errorJson: Object.hasOwn(patch, 'error') ? stringifyJson(patch.error) : undefined,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };
}

export function createSqliteManualUploadArtifactStore() {
  return {
    insert(record) {
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

    get(artifactId) {
      return mapRow(sqliteGetOne(`SELECT * FROM manual_upload_artifacts WHERE artifact_id = ? LIMIT 1`, [artifactId]));
    },

    listByConnection(connectorInstanceId, { limit = DEFAULT_LIST_LIMIT } = {}) {
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

    update(artifactId, patch) {
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
          next.validationJson !== undefined ? 1 : 0,
          next.validationJson ?? null,
          next.errorJson !== undefined ? 1 : 0,
          next.errorJson ?? null,
          next.updatedAt,
          artifactId,
        ]
      );
      return this.get(artifactId);
    },
  };
}

export function createPostgresManualUploadArtifactStore() {
  return {
    async insert(record) {
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

    async get(artifactId) {
      const result = await postgresQuery(`SELECT * FROM manual_upload_artifacts WHERE artifact_id = $1 LIMIT 1`, [
        artifactId,
      ]);
      return mapRow(result.rows[0]);
    },

    async listByConnection(connectorInstanceId, { limit = DEFAULT_LIST_LIMIT } = {}) {
      const result = await postgresQuery(
        `SELECT *
           FROM manual_upload_artifacts
          WHERE connector_instance_id = $1
          ORDER BY created_at DESC, artifact_id DESC
          LIMIT $2`,
        [connectorInstanceId, limit]
      );
      return result.rows.map(mapRow);
    },

    async update(artifactId, patch) {
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

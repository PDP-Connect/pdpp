import { exec, getOne, referenceQueries } from '../../lib/db.ts';
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from '../postgres-storage.js';

export class DeviceBatchConflictError extends Error {
  constructor({ deviceId, batchId, existingBodyHash, bodyHash }) {
    super(`Device batch '${batchId}' for '${deviceId}' already exists with a different body hash.`);
    this.name = 'DeviceBatchConflictError';
    this.code = 'DEVICE_BATCH_CONFLICT';
    this.deviceId = deviceId;
    this.batchId = batchId;
    this.existingBodyHash = existingBodyHash;
    this.bodyHash = bodyHash;
  }
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function mapOutcome(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    batchId: row.batch_id,
    bodyHash: row.body_hash,
    sourceInstanceId: row.source_instance_id,
    status: row.status,
    httpStatus: row.http_status,
    response: parseJson(row.response_json, {}),
    createdAt: row.created_at,
  };
}

function mapDevice(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    ownerSubjectId: row.owner_subject_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function mapCredential(row) {
  if (!row) return null;
  return {
    credentialId: row.credential_id,
    deviceId: row.device_id,
    tokenHash: row.token_hash,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function mapEnrollment(row) {
  if (!row) return null;
  return {
    enrollmentCodeId: row.enrollment_code_id,
    codeHash: row.code_hash,
    ownerSubjectId: row.owner_subject_id,
    deviceId: row.device_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

function mapSourceInstance(row) {
  if (!row) return null;
  return {
    sourceInstanceId: row.source_instance_id,
    deviceId: row.device_id,
    connectorId: row.connector_id,
    localBindingId: row.local_binding_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function normalizeOutcome(record) {
  return {
    deviceId: record.deviceId,
    batchId: record.batchId,
    bodyHash: record.bodyHash,
    sourceInstanceId: record.sourceInstanceId,
    status: record.status,
    httpStatus: record.httpStatus,
    responseJson: JSON.stringify(record.response ?? {}),
    createdAt: record.createdAt,
  };
}

function replayOrConflict(existing, record) {
  if (!existing) return null;
  if (existing.bodyHash !== record.bodyHash) {
    throw new DeviceBatchConflictError({
      deviceId: record.deviceId,
      batchId: record.batchId,
      existingBodyHash: existing.bodyHash,
      bodyHash: record.bodyHash,
    });
  }
  return existing;
}

export function createSqliteDeviceExporterStore() {
  return {
    createDevice(record) {
      exec(referenceQueries.deviceExportersInsertDevice, [
        record.deviceId,
        record.ownerSubjectId,
        record.displayName,
        record.status ?? 'active',
        record.createdAt,
        record.updatedAt,
        record.revokedAt ?? null,
      ]);
    },

    getDevice(deviceId) {
      return mapDevice(getOne(referenceQueries.deviceExportersGetDevice, [deviceId]));
    },

    revokeDevice(deviceId, revokedAt) {
      exec(referenceQueries.deviceExportersRevokeDevice, [revokedAt, revokedAt, deviceId]);
      exec(referenceQueries.deviceExportersRevokeCredentialsForDevice, [revokedAt, deviceId]);
    },

    createCredential(record) {
      exec(referenceQueries.deviceExportersInsertCredential, [
        record.credentialId,
        record.deviceId,
        record.tokenHash,
        record.status ?? 'active',
        record.createdAt,
        record.lastUsedAt ?? null,
        record.revokedAt ?? null,
      ]);
    },

    findCredentialByTokenHash(tokenHash) {
      return mapCredential(getOne(referenceQueries.deviceExportersGetCredentialByTokenHash, [tokenHash]));
    },

    markCredentialUsed(credentialId, usedAt) {
      exec(referenceQueries.deviceExportersMarkCredentialUsed, [usedAt, credentialId]);
    },

    createEnrollmentCode(record) {
      exec(referenceQueries.deviceExportersInsertEnrollmentCode, [
        record.enrollmentCodeId,
        record.codeHash,
        record.ownerSubjectId,
        record.deviceId ?? null,
        record.status ?? 'pending',
        record.createdAt,
        record.expiresAt,
        record.consumedAt ?? null,
        record.revokedAt ?? null,
      ]);
    },

    findEnrollmentByCodeHash(codeHash) {
      return mapEnrollment(getOne(referenceQueries.deviceExportersGetEnrollmentByCodeHash, [codeHash]));
    },

    consumeEnrollmentCode(enrollmentCodeId, deviceId, consumedAt) {
      const result = exec(referenceQueries.deviceExportersConsumeEnrollmentCode, [deviceId, consumedAt, enrollmentCodeId]);
      return result.changes === 1;
    },

    revokeEnrollmentCode(enrollmentCodeId, revokedAt) {
      const result = exec(referenceQueries.deviceExportersRevokeEnrollmentCode, [revokedAt, enrollmentCodeId]);
      return result.changes === 1;
    },

    upsertSourceInstance(record) {
      exec(referenceQueries.deviceExportersUpsertSourceInstance, [
        record.sourceInstanceId,
        record.deviceId,
        record.connectorId,
        record.localBindingId,
        record.displayName ?? null,
        record.status ?? 'active',
        record.createdAt,
        record.updatedAt,
        record.revokedAt ?? null,
      ]);
    },

    getSourceInstance(deviceId, sourceInstanceId) {
      return mapSourceInstance(getOne(referenceQueries.deviceExportersGetSourceInstance, [deviceId, sourceInstanceId]));
    },

    getSourceInstanceByBinding(deviceId, connectorId, localBindingId) {
      return mapSourceInstance(
        getOne(referenceQueries.deviceExportersGetSourceInstanceByBinding, [deviceId, connectorId, localBindingId]),
      );
    },

    recordBatchOutcome(record) {
      const existing = mapOutcome(
        getOne(referenceQueries.deviceExportersGetBatchOutcomeByBatch, [record.deviceId, record.batchId]),
      );
      const replay = replayOrConflict(existing, record);
      if (replay) return { kind: 'replayed', outcome: replay };

      const normalized = normalizeOutcome(record);
      exec(referenceQueries.deviceExportersInsertBatchOutcome, [
        normalized.deviceId,
        normalized.batchId,
        normalized.bodyHash,
        normalized.sourceInstanceId,
        normalized.status,
        normalized.httpStatus,
        normalized.responseJson,
        normalized.createdAt,
      ]);
      return { kind: 'created', outcome: mapOutcome({
        device_id: normalized.deviceId,
        batch_id: normalized.batchId,
        body_hash: normalized.bodyHash,
        source_instance_id: normalized.sourceInstanceId,
        status: normalized.status,
        http_status: normalized.httpStatus,
        response_json: normalized.responseJson,
        created_at: normalized.createdAt,
      }) };
    },
  };
}

export function createPostgresDeviceExporterStore() {
  return {
    async createDevice(record) {
      await postgresQuery(
        `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [record.deviceId, record.ownerSubjectId, record.displayName, record.status ?? 'active', record.createdAt, record.updatedAt, record.revokedAt ?? null],
      );
    },

    async getDevice(deviceId) {
      const result = await postgresQuery(
        `SELECT device_id, owner_subject_id, display_name, status, created_at, updated_at, revoked_at
         FROM device_exporters WHERE device_id = $1`,
        [deviceId],
      );
      return mapDevice(result.rows[0]);
    },

    async revokeDevice(deviceId, revokedAt) {
      await postgresQuery(`UPDATE device_exporters SET status = 'revoked', revoked_at = $1, updated_at = $1 WHERE device_id = $2`, [revokedAt, deviceId]);
      await postgresQuery(`UPDATE device_ingest_credentials SET status = 'revoked', revoked_at = $1 WHERE device_id = $2 AND status <> 'revoked'`, [revokedAt, deviceId]);
    },

    async createCredential(record) {
      await postgresQuery(
        `INSERT INTO device_ingest_credentials(credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [record.credentialId, record.deviceId, record.tokenHash, record.status ?? 'active', record.createdAt, record.lastUsedAt ?? null, record.revokedAt ?? null],
      );
    },

    async findCredentialByTokenHash(tokenHash) {
      const result = await postgresQuery(
        `SELECT credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at
         FROM device_ingest_credentials WHERE token_hash = $1`,
        [tokenHash],
      );
      return mapCredential(result.rows[0]);
    },

    async markCredentialUsed(credentialId, usedAt) {
      await postgresQuery(`UPDATE device_ingest_credentials SET last_used_at = $1 WHERE credential_id = $2`, [usedAt, credentialId]);
    },

    async createEnrollmentCode(record) {
      await postgresQuery(
        `INSERT INTO device_enrollment_codes(enrollment_code_id, code_hash, owner_subject_id, device_id, status, created_at, expires_at, consumed_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [record.enrollmentCodeId, record.codeHash, record.ownerSubjectId, record.deviceId ?? null, record.status ?? 'pending', record.createdAt, record.expiresAt, record.consumedAt ?? null, record.revokedAt ?? null],
      );
    },

    async findEnrollmentByCodeHash(codeHash) {
      const result = await postgresQuery(
        `SELECT enrollment_code_id, code_hash, owner_subject_id, device_id, status, created_at, expires_at, consumed_at, revoked_at
         FROM device_enrollment_codes WHERE code_hash = $1`,
        [codeHash],
      );
      return mapEnrollment(result.rows[0]);
    },

    async consumeEnrollmentCode(enrollmentCodeId, deviceId, consumedAt) {
      const result = await postgresQuery(
        `UPDATE device_enrollment_codes SET status = 'consumed', device_id = $1, consumed_at = $2
         WHERE enrollment_code_id = $3 AND status = 'pending'`,
        [deviceId, consumedAt, enrollmentCodeId],
      );
      return result.rowCount === 1;
    },

    async revokeEnrollmentCode(enrollmentCodeId, revokedAt) {
      const result = await postgresQuery(
        `UPDATE device_enrollment_codes SET status = 'revoked', revoked_at = $1
         WHERE enrollment_code_id = $2 AND status = 'pending'`,
        [revokedAt, enrollmentCodeId],
      );
      return result.rowCount === 1;
    },

    async upsertSourceInstance(record) {
      await postgresQuery(
        `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, local_binding_id, display_name, status, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(device_id, connector_id, local_binding_id) DO UPDATE SET
           source_instance_id = excluded.source_instance_id,
           display_name = excluded.display_name,
           status = excluded.status,
           updated_at = excluded.updated_at,
           revoked_at = excluded.revoked_at`,
        [record.sourceInstanceId, record.deviceId, record.connectorId, record.localBindingId, record.displayName ?? null, record.status ?? 'active', record.createdAt, record.updatedAt, record.revokedAt ?? null],
      );
    },

    async getSourceInstance(deviceId, sourceInstanceId) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, local_binding_id, display_name, status, created_at, updated_at, revoked_at
         FROM device_source_instances WHERE device_id = $1 AND source_instance_id = $2`,
        [deviceId, sourceInstanceId],
      );
      return mapSourceInstance(result.rows[0]);
    },

    async getSourceInstanceByBinding(deviceId, connectorId, localBindingId) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, local_binding_id, display_name, status, created_at, updated_at, revoked_at
         FROM device_source_instances WHERE device_id = $1 AND connector_id = $2 AND local_binding_id = $3`,
        [deviceId, connectorId, localBindingId],
      );
      return mapSourceInstance(result.rows[0]);
    },

    async recordBatchOutcome(record) {
      const existingResult = await postgresQuery(
        `SELECT device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
         FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2`,
        [record.deviceId, record.batchId],
      );
      const existing = mapOutcome(existingResult.rows[0]);
      const replay = replayOrConflict(existing, record);
      if (replay) return { kind: 'replayed', outcome: replay };

      const normalized = normalizeOutcome(record);
      await postgresQuery(
        `INSERT INTO device_ingest_batch_outcomes(device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [normalized.deviceId, normalized.batchId, normalized.bodyHash, normalized.sourceInstanceId, normalized.status, normalized.httpStatus, normalized.responseJson, normalized.createdAt],
      );
      return { kind: 'created', outcome: mapOutcome({
        device_id: normalized.deviceId,
        batch_id: normalized.batchId,
        body_hash: normalized.bodyHash,
        source_instance_id: normalized.sourceInstanceId,
        status: normalized.status,
        http_status: normalized.httpStatus,
        response_json: normalized.responseJson,
        created_at: normalized.createdAt,
      }) };
    },
  };
}

export function createDeviceExporterStore() {
  return isPostgresStorageBackend() ? createPostgresDeviceExporterStore() : createSqliteDeviceExporterStore();
}

let defaultStore = null;
let defaultStoreBackend = null;

export function getDefaultDeviceExporterStore() {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultStoreBackend !== backend) {
    defaultStore = createDeviceExporterStore();
    defaultStoreBackend = backend;
  }
  return defaultStore;
}

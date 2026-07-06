import { allowUnboundedReadAcknowledged, exec, getMany, getOne, referenceQueries } from "../../lib/db.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";

/** A raw database row (column-keyed) crossing the untyped storage boundary. */
// biome-ignore lint/suspicious/noExplicitAny: raw db.js/postgres rows are untyped at this boundary.
type Row = Record<string, any>;

export class DeviceBatchConflictError extends Error {
  code: string;
  deviceId: string;
  batchId: string;
  existingBodyHash: string;
  bodyHash: string;

  constructor({
    deviceId,
    batchId,
    existingBodyHash,
    bodyHash,
  }: {
    deviceId: string;
    batchId: string;
    existingBodyHash: string;
    bodyHash: string;
  }) {
    super(`Device batch '${batchId}' for '${deviceId}' already exists with a different body hash.`);
    this.name = "DeviceBatchConflictError";
    this.code = "DEVICE_BATCH_CONFLICT";
    this.deviceId = deviceId;
    this.batchId = batchId;
    this.existingBodyHash = existingBodyHash;
    this.bodyHash = bodyHash;
  }
}

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function mapOutcome(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
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

function mapDevice(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    deviceId: row.device_id,
    ownerSubjectId: row.owner_subject_id,
    displayName: row.display_name,
    status: row.status,
    agentVersion: row.agent_version,
    // null when this device enrolled before the X-PDPP-Collector-Protocol
    // header was required; consumers must report that as legacy_unknown
    // rather than assume current compatibility.
    collectorProtocolVersion: row.collector_protocol_version ?? null,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastError: parseJson(row.last_error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function mapCredential(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
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

function mapEnrollment(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    enrollmentCodeId: row.enrollment_code_id,
    codeHash: row.code_hash,
    ownerSubjectId: row.owner_subject_id,
    connectorId: row.connector_id,
    localBindingId: row.local_binding_id,
    displayName: row.display_name,
    deviceId: row.device_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

function mapSourceInstance(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    sourceInstanceId: row.source_instance_id,
    deviceId: row.device_id,
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id ?? null,
    localBindingId: row.local_binding_id,
    displayName: row.display_name,
    status: row.status,
    lastError: parseJson(row.last_error_json, null),
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    lastHeartbeatStatus: row.last_heartbeat_status ?? null,
    recordsPending: row.records_pending == null ? null : Number(row.records_pending),
    outboxDiagnostics: parseJson(row.outbox_diagnostics_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function mapSourceInstanceHeartbeatRow(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    sourceInstanceId: row.source_instance_id,
    deviceId: row.device_id,
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id ?? null,
    sourceStatus: row.source_status,
    deviceStatus: row.device_status,
    deviceRevokedAt: row.device_revoked_at ?? null,
    lastError: parseJson(row.last_error_json, null),
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    lastHeartbeatStatus: row.last_heartbeat_status ?? null,
    recordsPending: row.records_pending == null ? null : Number(row.records_pending),
    outboxDiagnostics: parseJson(row.outbox_diagnostics_json, null),
    lastIngestAt: row.last_ingest_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

const HEARTBEAT_STATUS_VALUES = new Set(["starting", "healthy", "retrying", "blocked", "stopped"]);

function normalizeHeartbeatStatus(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return HEARTBEAT_STATUS_VALUES.has(value) ? value : null;
}

function normalizeRecordsPending(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const integer = Math.trunc(value);
  if (integer < 0) {
    return null;
  }
  return integer;
}

const OUTBOX_DIAGNOSTIC_COUNTS = Object.freeze([
  "backlog_open",
  "dead_letter",
  "leased",
  "pending",
  "retrying",
  "stale_leases",
  "succeeded",
  "total",
]);

function normalizeDiagnosticCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const integer = Math.trunc(value);
  if (integer < 0) {
    return null;
  }
  return integer;
}

function collectDiagnosticCounts(value: Record<string, unknown>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const field of OUTBOX_DIAGNOSTIC_COUNTS) {
    const count = normalizeDiagnosticCount(value[field]);
    if (count !== null) {
      normalized[field] = count;
    }
  }
  return normalized;
}

function validOldestPendingAt(value: Record<string, unknown>): string | null {
  if (typeof value.oldest_pending_at === "string" && value.oldest_pending_at.length > 0) {
    const parsed = Date.parse(value.oldest_pending_at);
    if (Number.isFinite(parsed)) {
      return value.oldest_pending_at;
    }
  }
  return null;
}

export function normalizeOutboxDiagnostics(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const normalized: Record<string, unknown> = collectDiagnosticCounts(value as Record<string, unknown>);
  const oldestPendingAt = validOldestPendingAt(value as Record<string, unknown>);
  if (oldestPendingAt !== null) {
    normalized.oldest_pending_at = oldestPendingAt;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function serializeOutboxDiagnostics(value: unknown): string | null {
  const normalized = normalizeOutboxDiagnostics(value);
  return normalized === null ? null : JSON.stringify(normalized);
}

function normalizeOutcome(record: Row) {
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

function replayOrConflict(existing: Row | null, record: Row) {
  if (!existing) {
    return null;
  }
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
    createDevice(record: Row) {
      exec(referenceQueries.deviceExportersInsertDevice, [
        record.deviceId,
        record.ownerSubjectId,
        record.displayName,
        record.status ?? "active",
        record.agentVersion ?? null,
        record.collectorProtocolVersion ?? null,
        record.lastHeartbeatAt ?? null,
        record.lastError === undefined ? null : JSON.stringify(record.lastError),
        record.createdAt,
        record.updatedAt,
        record.revokedAt ?? null,
      ]);
    },

    getDevice(deviceId: string) {
      return mapDevice(getOne(referenceQueries.deviceExportersGetDevice, [deviceId]));
    },

    listDevices(ownerSubjectId: string) {
      return allowUnboundedReadAcknowledged<Row>(referenceQueries.deviceExportersListDevices, [ownerSubjectId]).map(
        mapDevice
      );
    },

    revokeDevice(deviceId: string, revokedAt: string) {
      exec(referenceQueries.deviceExportersRevokeDevice, [revokedAt, revokedAt, deviceId]);
      exec(referenceQueries.deviceExportersRevokeCredentialsForDevice, [revokedAt, deviceId]);
      // Cascade revoke to the local-collector source instances bound to this
      // device and, where safe, to the connector_instances those source
      // instances reference. Source instances are revoked first so the
      // connector_instance update can use NOT EXISTS to spare any
      // connector_instance still referenced by another device's non-revoked
      // source instance (stable-binding re-enrollment lane).
      exec(referenceQueries.deviceExportersRevokeSourceInstancesForDevice, [revokedAt, revokedAt, deviceId]);
      exec(referenceQueries.deviceExportersRevokeConnectorInstancesForDevice, [revokedAt, revokedAt, deviceId]);
    },

    markDeviceHeartbeat(deviceId: string, record: Row) {
      return exec(referenceQueries.deviceExportersUpdateDeviceHeartbeat, [
        record.receivedAt,
        record.receivedAt,
        record.agentVersion ?? null,
        record.lastError === undefined ? null : JSON.stringify(record.lastError),
        deviceId,
      ]).changes;
    },

    createCredential(record: Row) {
      exec(referenceQueries.deviceExportersInsertCredential, [
        record.credentialId,
        record.deviceId,
        record.tokenHash,
        record.status ?? "active",
        record.createdAt,
        record.lastUsedAt ?? null,
        record.revokedAt ?? null,
      ]);
    },

    findCredentialByTokenHash(tokenHash: string) {
      return mapCredential(getOne(referenceQueries.deviceExportersGetCredentialByTokenHash, [tokenHash]));
    },

    markCredentialUsed(credentialId: string, usedAt: string) {
      exec(referenceQueries.deviceExportersMarkCredentialUsed, [usedAt, credentialId]);
    },

    createEnrollmentCode(record: Row) {
      exec(referenceQueries.deviceExportersInsertEnrollmentCode, [
        record.enrollmentCodeId,
        record.codeHash,
        record.ownerSubjectId,
        record.connectorId ?? "unknown",
        record.localBindingId ?? "default",
        record.displayName ?? null,
        record.deviceId ?? null,
        record.status ?? "pending",
        record.createdAt,
        record.expiresAt,
        record.consumedAt ?? null,
        record.revokedAt ?? null,
      ]);
    },

    findEnrollmentByCodeHash(codeHash: string) {
      return mapEnrollment(getOne(referenceQueries.deviceExportersGetEnrollmentByCodeHash, [codeHash]));
    },

    consumeEnrollmentCode(enrollmentCodeId: string, deviceId: string, consumedAt: string) {
      const result = exec(referenceQueries.deviceExportersConsumeEnrollmentCode, [
        deviceId,
        consumedAt,
        enrollmentCodeId,
      ]);
      return result.changes === 1;
    },

    revokeEnrollmentCode(enrollmentCodeId: string, revokedAt: string) {
      const result = exec(referenceQueries.deviceExportersRevokeEnrollmentCode, [revokedAt, enrollmentCodeId]);
      return result.changes === 1;
    },

    upsertSourceInstance(record: Row) {
      exec(referenceQueries.deviceExportersUpsertSourceInstance, [
        record.sourceInstanceId,
        record.deviceId,
        record.connectorId,
        record.connectorInstanceId ?? null,
        record.localBindingId,
        record.displayName ?? null,
        record.status ?? "active",
        record.lastError === undefined ? null : JSON.stringify(record.lastError),
        record.createdAt,
        record.updatedAt,
        record.revokedAt ?? null,
      ]);
    },

    getSourceInstance(deviceId: string, sourceInstanceId: string) {
      return mapSourceInstance(getOne(referenceQueries.deviceExportersGetSourceInstance, [deviceId, sourceInstanceId]));
    },

    listSourceInstances({ deviceId = null }: { deviceId?: string | null } = {}) {
      return allowUnboundedReadAcknowledged<Row>(referenceQueries.deviceExportersListSourceInstances, [
        deviceId,
        deviceId,
      ]).map(mapSourceInstance);
    },

    listSourceInstanceHeartbeatsByConnector(connectorId: string, options?: { connectorInstanceId?: string | null }) {
      const connectorInstanceId = options?.connectorInstanceId ?? null;
      return allowUnboundedReadAcknowledged<Row>(
        referenceQueries.deviceExportersListSourceInstanceHeartbeatsByConnector,
        [connectorId, connectorInstanceId, connectorInstanceId]
      ).map(mapSourceInstanceHeartbeatRow);
    },

    getSourceInstanceByBinding(deviceId: string, connectorId: string, localBindingId: string) {
      return mapSourceInstance(
        getOne(referenceQueries.deviceExportersGetSourceInstanceByBinding, [deviceId, connectorId, localBindingId])
      );
    },

    markSourceInstanceHeartbeat(deviceId: string, sourceInstanceId: string, record: Row) {
      return exec(referenceQueries.deviceExportersUpdateSourceInstanceHeartbeat, [
        record.receivedAt,
        record.lastError === undefined ? null : JSON.stringify(record.lastError),
        record.receivedAt,
        normalizeHeartbeatStatus(record.status),
        normalizeRecordsPending(record.recordsPending),
        serializeOutboxDiagnostics(record.outboxDiagnostics),
        deviceId,
        sourceInstanceId,
      ]).changes;
    },

    getBatchOutcome(deviceId: string, batchId: string) {
      return mapOutcome(getOne(referenceQueries.deviceExportersGetBatchOutcomeByBatch, [deviceId, batchId]));
    },

    listBatchOutcomes({ deviceId = null, limit = 500 }: { deviceId?: string | null; limit?: number } = {}) {
      return getMany<Record<string, unknown>>(referenceQueries.deviceExportersListBatchOutcomes, [deviceId, deviceId], {
        limit,
      }).rows.map(mapOutcome);
    },

    recordBatchOutcome(record: Row) {
      const existing = mapOutcome(
        getOne(referenceQueries.deviceExportersGetBatchOutcomeByBatch, [record.deviceId, record.batchId])
      );
      const replay = replayOrConflict(existing, record);
      if (replay) {
        return { kind: "replayed", outcome: replay };
      }

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
      return {
        kind: "created",
        outcome: mapOutcome({
          device_id: normalized.deviceId,
          batch_id: normalized.batchId,
          body_hash: normalized.bodyHash,
          source_instance_id: normalized.sourceInstanceId,
          status: normalized.status,
          http_status: normalized.httpStatus,
          response_json: normalized.responseJson,
          created_at: normalized.createdAt,
        }),
      };
    },
  };
}

export function createPostgresDeviceExporterStore() {
  return {
    async createDevice(record: Row) {
      await postgresQuery(
        `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [
          record.deviceId,
          record.ownerSubjectId,
          record.displayName,
          record.status ?? "active",
          record.agentVersion ?? null,
          record.collectorProtocolVersion ?? null,
          record.lastHeartbeatAt ?? null,
          record.lastError === undefined ? null : JSON.stringify(record.lastError),
          record.createdAt,
          record.updatedAt,
          record.revokedAt ?? null,
        ]
      );
    },

    async getDevice(deviceId: string) {
      const result = await postgresQuery(
        `SELECT device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
         FROM device_exporters WHERE device_id = $1`,
        [deviceId]
      );
      return mapDevice(result.rows[0]);
    },

    async listDevices(ownerSubjectId: string) {
      const result = await postgresQuery(
        `SELECT device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
         FROM device_exporters
         WHERE owner_subject_id = $1
         ORDER BY created_at DESC, device_id ASC`,
        [ownerSubjectId]
      );
      return result.rows.map(mapDevice);
    },

    async revokeDevice(deviceId: string, revokedAt: string) {
      await postgresQuery(
        `UPDATE device_exporters SET status = 'revoked', revoked_at = $1, updated_at = $1 WHERE device_id = $2`,
        [revokedAt, deviceId]
      );
      await postgresQuery(
        `UPDATE device_ingest_credentials SET status = 'revoked', revoked_at = $1 WHERE device_id = $2 AND status <> 'revoked'`,
        [revokedAt, deviceId]
      );
      // Cascade revoke to the local-collector source instances bound to this
      // device and, where safe, to the connector_instances those source
      // instances reference. Source instances are revoked first so the
      // connector_instance update can use NOT EXISTS to spare any
      // connector_instance still referenced by another device's non-revoked
      // source instance (stable-binding re-enrollment lane).
      await postgresQuery(
        `UPDATE device_source_instances
            SET status = 'revoked', revoked_at = $1, updated_at = $1
          WHERE device_id = $2 AND status <> 'revoked'`,
        [revokedAt, deviceId]
      );
      await postgresQuery(
        `UPDATE connector_instances ci
            SET status = 'revoked', revoked_at = $1, updated_at = $1
          WHERE ci.status <> 'revoked'
            AND ci.connector_instance_id IN (
              SELECT connector_instance_id
              FROM device_source_instances
              WHERE device_id = $2
                AND connector_instance_id IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM device_source_instances active
              WHERE active.connector_instance_id = ci.connector_instance_id
                AND active.status <> 'revoked'
            )`,
        [revokedAt, deviceId]
      );
    },

    async markDeviceHeartbeat(deviceId: string, record: Row) {
      const result = await postgresQuery(
        `UPDATE device_exporters
            SET updated_at = $1, last_heartbeat_at = $2, agent_version = COALESCE($3, agent_version), last_error_json = $4::jsonb
          WHERE device_id = $5 AND status = 'active'`,
        [
          record.receivedAt,
          record.receivedAt,
          record.agentVersion ?? null,
          record.lastError === undefined ? null : JSON.stringify(record.lastError),
          deviceId,
        ]
      );
      return result.rowCount;
    },

    async createCredential(record: Row) {
      await postgresQuery(
        `INSERT INTO device_ingest_credentials(credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.credentialId,
          record.deviceId,
          record.tokenHash,
          record.status ?? "active",
          record.createdAt,
          record.lastUsedAt ?? null,
          record.revokedAt ?? null,
        ]
      );
    },

    async findCredentialByTokenHash(tokenHash: string) {
      const result = await postgresQuery(
        `SELECT credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at
         FROM device_ingest_credentials WHERE token_hash = $1`,
        [tokenHash]
      );
      return mapCredential(result.rows[0]);
    },

    async markCredentialUsed(credentialId: string, usedAt: string) {
      await postgresQuery("UPDATE device_ingest_credentials SET last_used_at = $1 WHERE credential_id = $2", [
        usedAt,
        credentialId,
      ]);
    },

    async createEnrollmentCode(record: Row) {
      await postgresQuery(
        `INSERT INTO device_enrollment_codes(enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, display_name, device_id, status, created_at, expires_at, consumed_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          record.enrollmentCodeId,
          record.codeHash,
          record.ownerSubjectId,
          record.connectorId ?? "unknown",
          record.localBindingId ?? "default",
          record.displayName ?? null,
          record.deviceId ?? null,
          record.status ?? "pending",
          record.createdAt,
          record.expiresAt,
          record.consumedAt ?? null,
          record.revokedAt ?? null,
        ]
      );
    },

    async findEnrollmentByCodeHash(codeHash: string) {
      const result = await postgresQuery(
        `SELECT enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, display_name, device_id, status, created_at, expires_at, consumed_at, revoked_at
         FROM device_enrollment_codes WHERE code_hash = $1`,
        [codeHash]
      );
      return mapEnrollment(result.rows[0]);
    },

    async consumeEnrollmentCode(enrollmentCodeId: string, deviceId: string, consumedAt: string) {
      const result = await postgresQuery(
        `UPDATE device_enrollment_codes SET status = 'consumed', device_id = $1, consumed_at = $2
         WHERE enrollment_code_id = $3 AND status = 'pending'`,
        [deviceId, consumedAt, enrollmentCodeId]
      );
      return result.rowCount === 1;
    },

    async revokeEnrollmentCode(enrollmentCodeId: string, revokedAt: string) {
      const result = await postgresQuery(
        `UPDATE device_enrollment_codes SET status = 'revoked', revoked_at = $1
         WHERE enrollment_code_id = $2 AND status = 'pending'`,
        [revokedAt, enrollmentCodeId]
      );
      return result.rowCount === 1;
    },

    async upsertSourceInstance(record: Row) {
      await postgresQuery(
        `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
         ON CONFLICT(device_id, connector_id, local_binding_id) DO UPDATE SET
           source_instance_id = excluded.source_instance_id,
           connector_instance_id = excluded.connector_instance_id,
           display_name = excluded.display_name,
           status = excluded.status,
           last_error_json = excluded.last_error_json,
           updated_at = excluded.updated_at,
           revoked_at = excluded.revoked_at`,
        [
          record.sourceInstanceId,
          record.deviceId,
          record.connectorId,
          record.connectorInstanceId ?? null,
          record.localBindingId,
          record.displayName ?? null,
          record.status ?? "active",
          record.lastError === undefined ? null : JSON.stringify(record.lastError),
          record.createdAt,
          record.updatedAt,
          record.revokedAt ?? null,
        ]
      );
    },

    async getSourceInstance(deviceId: string, sourceInstanceId: string) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, last_heartbeat_at, last_heartbeat_status, records_pending, outbox_diagnostics_json, created_at, updated_at, revoked_at
         FROM device_source_instances WHERE device_id = $1 AND source_instance_id = $2`,
        [deviceId, sourceInstanceId]
      );
      return mapSourceInstance(result.rows[0]);
    },

    async listSourceInstances({ deviceId = null }: { deviceId?: string | null } = {}) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, last_heartbeat_at, last_heartbeat_status, records_pending, outbox_diagnostics_json, created_at, updated_at, revoked_at
         FROM device_source_instances
         WHERE ($1::text IS NULL OR device_id = $1)
         ORDER BY device_id ASC, created_at DESC, source_instance_id ASC`,
        [deviceId]
      );
      return result.rows.map(mapSourceInstance);
    },

    async listSourceInstanceHeartbeatsByConnector(
      connectorId: string,
      options?: { connectorInstanceId?: string | null }
    ) {
      const connectorInstanceId = options?.connectorInstanceId ?? null;
      const result = await postgresQuery(
        `SELECT dsi.source_instance_id,
                dsi.device_id,
                dsi.connector_id,
                dsi.connector_instance_id,
                dsi.status AS source_status,
                dsi.last_error_json,
                dsi.last_heartbeat_at,
                dsi.last_heartbeat_status,
                dsi.records_pending,
                dsi.outbox_diagnostics_json,
                dsi.updated_at,
                dio.last_ingest_at,
                de.status AS device_status,
                de.revoked_at AS device_revoked_at
           FROM device_source_instances dsi
           JOIN device_exporters de ON de.device_id = dsi.device_id
           LEFT JOIN (
             SELECT device_id, source_instance_id, MAX(created_at) AS last_ingest_at
               FROM device_ingest_batch_outcomes
              GROUP BY device_id, source_instance_id
           ) dio ON dio.device_id = dsi.device_id AND dio.source_instance_id = dsi.source_instance_id
          WHERE dsi.connector_id = $1
            AND ($2::text IS NULL OR dsi.connector_instance_id = $2)
          ORDER BY (dsi.last_heartbeat_at IS NULL), dsi.last_heartbeat_at DESC NULLS LAST, dsi.device_id ASC, dsi.source_instance_id ASC`,
        [connectorId, connectorInstanceId]
      );
      return result.rows.map(mapSourceInstanceHeartbeatRow);
    },

    async getSourceInstanceByBinding(deviceId: string, connectorId: string, localBindingId: string) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, last_heartbeat_at, last_heartbeat_status, records_pending, outbox_diagnostics_json, created_at, updated_at, revoked_at
         FROM device_source_instances WHERE device_id = $1 AND connector_id = $2 AND local_binding_id = $3`,
        [deviceId, connectorId, localBindingId]
      );
      return mapSourceInstance(result.rows[0]);
    },

    async markSourceInstanceHeartbeat(deviceId: string, sourceInstanceId: string, record: Row) {
      const result = await postgresQuery(
        `UPDATE device_source_instances
            SET updated_at = $1,
                last_error_json = $2::jsonb,
                last_heartbeat_at = $3,
                last_heartbeat_status = $4,
                records_pending = $5,
                outbox_diagnostics_json = $6::jsonb
          WHERE device_id = $7 AND source_instance_id = $8 AND status = 'active'`,
        [
          record.receivedAt,
          record.lastError === undefined ? null : JSON.stringify(record.lastError),
          record.receivedAt,
          normalizeHeartbeatStatus(record.status),
          normalizeRecordsPending(record.recordsPending),
          serializeOutboxDiagnostics(record.outboxDiagnostics),
          deviceId,
          sourceInstanceId,
        ]
      );
      return result.rowCount;
    },

    async getBatchOutcome(deviceId: string, batchId: string) {
      const result = await postgresQuery(
        `SELECT device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
         FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2`,
        [deviceId, batchId]
      );
      return mapOutcome(result.rows[0]);
    },

    async listBatchOutcomes({ deviceId = null, limit = 500 }: { deviceId?: string | null; limit?: number } = {}) {
      const result = await postgresQuery(
        `SELECT device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
         FROM device_ingest_batch_outcomes
         WHERE ($1::text IS NULL OR device_id = $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [deviceId, limit]
      );
      return result.rows.map(mapOutcome);
    },

    async recordBatchOutcome(record: Row) {
      const existingResult = await postgresQuery(
        `SELECT device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
         FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2`,
        [record.deviceId, record.batchId]
      );
      const existing = mapOutcome(existingResult.rows[0]);
      const replay = replayOrConflict(existing, record);
      if (replay) {
        return { kind: "replayed", outcome: replay };
      }

      const normalized = normalizeOutcome(record);
      await postgresQuery(
        `INSERT INTO device_ingest_batch_outcomes(device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          normalized.deviceId,
          normalized.batchId,
          normalized.bodyHash,
          normalized.sourceInstanceId,
          normalized.status,
          normalized.httpStatus,
          normalized.responseJson,
          normalized.createdAt,
        ]
      );
      return {
        kind: "created",
        outcome: mapOutcome({
          device_id: normalized.deviceId,
          batch_id: normalized.batchId,
          body_hash: normalized.bodyHash,
          source_instance_id: normalized.sourceInstanceId,
          status: normalized.status,
          http_status: normalized.httpStatus,
          response_json: normalized.responseJson,
          created_at: normalized.createdAt,
        }),
      };
    },
  };
}

type DeviceExporterStore =
  | ReturnType<typeof createSqliteDeviceExporterStore>
  | ReturnType<typeof createPostgresDeviceExporterStore>;

export function createDeviceExporterStore(): DeviceExporterStore {
  return isPostgresStorageBackend() ? createPostgresDeviceExporterStore() : createSqliteDeviceExporterStore();
}

let defaultStore: DeviceExporterStore | null = null;
let defaultStoreBackend: string | null = null;

export function getDefaultDeviceExporterStore(): DeviceExporterStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultStoreBackend !== backend) {
    defaultStore = createDeviceExporterStore();
    defaultStoreBackend = backend;
  }
  return defaultStore;
}

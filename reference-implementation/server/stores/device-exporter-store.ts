// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  allowUnboundedReadAcknowledged,
  type BindValue,
  exec,
  getMany,
  getOne,
  referenceQueries,
  writeTransaction,
} from "../../lib/db.ts";
import { isNullish } from "../../lib/nullish.ts";
import { fingerprintDeviceAttemptManifest } from "../device-ingest-attempt-context.ts";
import {
  getStorageBackendKind,
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from "../postgres-storage.ts";

/** A raw database row (column-keyed) crossing the untyped storage boundary. */
// biome-ignore lint/suspicious/noExplicitAny: raw db.js/postgres rows are untyped at this boundary.
type Row = Record<string, any>;

// Design D6 (fix-enroll-stable-binding-identity-key), extended by D7
// (fix-enroll-source-kind-identity-gap) to include sourceKind in the lock
// material. Distinct namespace prefix from
// connector-instance-write-coordinator.ts's advisoryKey — this locks the
// enrollment BINDING decision (which device identity a first enroll for
// this binding should resolve to), an entirely different resource than
// that module's per-connector-instance ingest writer-admission fence.
// Sharing a keyspace would risk accidental cross-fence coupling; a distinct
// prefix makes collision cryptographically negligible even if the same
// (owner, connector, sourceKind, binding) string ever collided with a
// connector_instance_id, which it structurally cannot (different id
// shapes). sourceKind is part of the hash input (not just the SQL
// predicate) so two enrollments sharing owner+connector+binding but
// resolving to different source kinds serialize on DISTINCT lock keys —
// each kind's identity decision is independent, never blocked by or
// racing against the other's.
function advisoryEnrollmentBindingKey(
  ownerSubjectId: string,
  connectorId: string,
  sourceKind: string,
  localBindingId: string
): string {
  const bytes = createHash("sha256")
    .update("pdpp:enrollment-binding-identity:v1:\0")
    .update(`${ownerSubjectId}\n${connectorId}\n${sourceKind}\n${localBindingId}`)
    .digest();
  return bytes.readBigInt64BE(0).toString();
}

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
  if (isNullish(value)) {
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
    acceptedAt: row.accepted_at ?? null,
    batchId: row.batch_id,
    batchSeq: Number(row.batch_seq),
    bodyHash: row.body_hash,
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    createdAt: row.created_at,
    deviceId: row.device_id,
    durablePrefixCount: Number(row.durable_prefix_count ?? 0),
    httpStatus: row.http_status,
    manifestFingerprint: row.manifest_fingerprint ?? "",
    recordCount: Number(row.record_count ?? 0),
    response: parseJson(row.response_json, null),
    semanticCapabilityIdentity: row.semantic_capability_identity ?? "",
    sourceInstanceId: row.source_instance_id,
    status: row.status,
  };
}

function mapDevice(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    agentVersion: row.agent_version,
    // null when this device enrolled before the X-PDPP-Collector-Protocol
    // header was required; consumers must report that as legacy_unknown
    // rather than assume current compatibility.
    collectorProtocolVersion: row.collector_protocol_version ?? null,
    createdAt: row.created_at,
    deviceId: row.device_id,
    displayName: row.display_name,
    lastError: parseJson(row.last_error_json, null),
    lastHeartbeatAt: row.last_heartbeat_at,
    ownerSubjectId: row.owner_subject_id,
    revokedAt: row.revoked_at,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function mapCredential(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    createdAt: row.created_at,
    credentialId: row.credential_id,
    deviceId: row.device_id,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    status: row.status,
    tokenHash: row.token_hash,
  };
}

function mapEnrollment(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    codeHash: row.code_hash,
    connectorId: row.connector_id,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    deviceId: row.device_id,
    displayName: row.display_name,
    enrollmentCodeId: row.enrollment_code_id,
    expiresAt: row.expires_at,
    localBindingId: row.local_binding_id,
    ownerSubjectId: row.owner_subject_id,
    revokedAt: row.revoked_at,
    status: row.status,
  };
}

function mapSourceInstance(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id ?? null,
    createdAt: row.created_at,
    deviceId: row.device_id,
    displayName: row.display_name,
    lastError: parseJson(row.last_error_json, null),
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    lastHeartbeatStatus: row.last_heartbeat_status ?? null,
    localBindingId: row.local_binding_id,
    manifestGeneration: isNullish(row.manifest_generation) ? null : Number(row.manifest_generation),
    outboxDiagnostics: parseJson(row.outbox_diagnostics_json, null),
    recordsPending: isNullish(row.records_pending) ? null : Number(row.records_pending),
    revokedAt: row.revoked_at,
    sourceInstanceId: row.source_instance_id,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function mapSourceInstanceHeartbeatRow(row: Row | null | undefined) {
  if (!row) {
    return null;
  }
  return {
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id ?? null,
    deviceId: row.device_id,
    deviceRevokedAt: row.device_revoked_at ?? null,
    deviceStatus: row.device_status,
    lastError: parseJson(row.last_error_json, null),
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    lastHeartbeatStatus: row.last_heartbeat_status ?? null,
    lastIngestAt: row.last_ingest_at ?? null,
    manifestGeneration: isNullish(row.manifest_generation) ? null : Number(row.manifest_generation),
    outboxDiagnostics: parseJson(row.outbox_diagnostics_json, null),
    recordsPending: isNullish(row.records_pending) ? null : Number(row.records_pending),
    sourceInstanceId: row.source_instance_id,
    sourceStatus: row.source_status,
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
  if (isNullish(value)) {
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
  if (isNullish(value) || typeof value !== "object" || Array.isArray(value)) {
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
    acceptedAt: record.acceptedAt ?? null,
    batchId: record.batchId,
    batchSeq: record.batchSeq ?? 0,
    bodyHash: record.bodyHash,
    connectorId: record.connectorId ?? "",
    connectorInstanceId: record.connectorInstanceId ?? "",
    createdAt: record.createdAt,
    deviceId: record.deviceId,
    durablePrefixCount: record.durablePrefixCount ?? 0,
    httpStatus: record.httpStatus ?? null,
    recordCount: record.recordCount ?? 0,
    responseJson: isNullish(record.response) ? null : JSON.stringify(record.response),
    sourceInstanceId: record.sourceInstanceId,
    status: record.status,
  };
}

function sameBatchIdentity(existing: Row, record: Row) {
  if (!(existing.connectorInstanceId || existing.connectorId)) {
    return existing.bodyHash === record.bodyHash && existing.sourceInstanceId === record.sourceInstanceId;
  }
  return (
    existing.bodyHash === record.bodyHash &&
    existing.sourceInstanceId === record.sourceInstanceId &&
    existing.connectorInstanceId === record.connectorInstanceId &&
    existing.connectorId === record.connectorId &&
    Number(existing.batchSeq) === Number(record.batchSeq)
  );
}

function replayOrConflict(existing: Row | null, record: Row) {
  if (!existing) {
    return null;
  }
  if (!sameBatchIdentity(existing, record)) {
    throw new DeviceBatchConflictError({
      batchId: record.batchId,
      bodyHash: record.bodyHash,
      deviceId: record.deviceId,
      existingBodyHash: existing.bodyHash,
    });
  }
  return existing;
}

function sqliteOutcomeRow(deviceId: string, batchId: string): Row | null {
  return getOne(referenceQueries.deviceExportersGetBatchOutcomeByBatch, [deviceId, batchId]) as Row | null;
}

function reservationIdentityBinds(record: Row): BindValue[] {
  return [
    record.deviceId,
    record.batchId,
    record.bodyHash,
    record.sourceInstanceId,
    record.connectorInstanceId,
    record.connectorId,
    record.batchSeq,
  ];
}

function currentSqliteManifestFingerprint(connectorId: string): string | null {
  const row = getOne(referenceQueries.authConnectorsGetManifestById, [connectorId]) as Row | null;
  if (!row?.manifest) {
    return null;
  }
  try {
    return fingerprintDeviceAttemptManifest(JSON.parse(row.manifest));
  } catch {
    return null;
  }
}

function retryableReservationError(message = "device ingest reservation cannot be accepted"): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = "device_ingest_retryable";
  return err;
}

export function advanceSqliteDeviceIngestPrefix(record: Row, inputIndex: number): void {
  const result = exec(referenceQueries.deviceExportersAdvanceProcessingPrefix, [
    ...reservationIdentityBinds(record),
    inputIndex,
  ]);
  if (result.changes !== 1) {
    const err = new Error("device ingest reservation prefix is no longer current");
    (err as Error & { code?: string }).code = "device_ingest_retryable";
    throw err;
  }
}

interface PostgresTransactionClient {
  query: (sql: string, params: readonly unknown[]) => Promise<{ rowCount: number | null; rows: Row[] }>;
}

export async function advancePostgresDeviceIngestPrefix(
  client: PostgresTransactionClient,
  record: Row,
  inputIndex: number
) {
  const result = await client.query(
    `UPDATE device_ingest_batch_outcomes
        SET durable_prefix_count = durable_prefix_count + 1
      WHERE device_id = $1 AND batch_id = $2 AND body_hash = $3
        AND source_instance_id = $4 AND connector_instance_id = $5
        AND connector_id = $6 AND batch_seq = $7
        AND status = 'processing' AND durable_prefix_count = $8`,
    [...reservationIdentityBinds(record), inputIndex]
  );
  if (result.rowCount !== 1) {
    const err = new Error("device ingest reservation prefix is no longer current");
    (err as Error & { code?: string }).code = "device_ingest_retryable";
    throw err;
  }
}

export function createSqliteDeviceExporterStore() {
  return {
    completeProcessingBatch(record: Row) {
      return writeTransaction(() => {
        const currentManifestFingerprint = currentSqliteManifestFingerprint(record.connectorId);
        const currentSemanticCapabilityIdentity = record.getCurrentSemanticCapabilityIdentity?.();
        if (
          currentManifestFingerprint !== record.manifestFingerprint ||
          currentSemanticCapabilityIdentity !== record.semanticCapabilityIdentity
        ) {
          throw retryableReservationError("device ingest attempt facts changed before acceptance");
        }
        const result = exec(referenceQueries.deviceExportersCompleteProcessingBatch, [
          record.acceptedAt,
          record.httpStatus,
          JSON.stringify(record.response),
          ...reservationIdentityBinds(record),
          record.manifestFingerprint,
          record.semanticCapabilityIdentity,
        ]);
        if (result.changes !== 1) {
          throw retryableReservationError();
        }
        return mapOutcome(sqliteOutcomeRow(record.deviceId, record.batchId));
      });
    },

    consumeEnrollmentCode(enrollmentCodeId: string, deviceId: string, consumedAt: string) {
      const result = exec(referenceQueries.deviceExportersConsumeEnrollmentCode, [
        deviceId,
        consumedAt,
        enrollmentCodeId,
      ]);
      return result.changes === 1;
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

    ensureProcessingBatch(record: Row) {
      const existing = mapOutcome(sqliteOutcomeRow(record.deviceId, record.batchId));
      const replay = replayOrConflict(existing, record);
      if (replay) {
        return replay;
      }
      try {
        exec(referenceQueries.deviceExportersInsertProcessingBatch, [
          ...reservationIdentityBinds(record),
          record.recordCount,
          record.manifestFingerprint,
          record.semanticCapabilityIdentity,
          record.createdAt,
        ]);
      } catch (err) {
        const raced = mapOutcome(sqliteOutcomeRow(record.deviceId, record.batchId));
        const replayed = replayOrConflict(raced, record);
        if (replayed) {
          return replayed;
        }
        throw err;
      }
      return mapOutcome(sqliteOutcomeRow(record.deviceId, record.batchId));
    },

    findCredentialByTokenHash(tokenHash: string) {
      return mapCredential(getOne(referenceQueries.deviceExportersGetCredentialByTokenHash, [tokenHash]));
    },

    findEnrollmentByCodeHash(codeHash: string) {
      return mapEnrollment(getOne(referenceQueries.deviceExportersGetEnrollmentByCodeHash, [codeHash]));
    },

    getBatchOutcome(deviceId: string, batchId: string) {
      return mapOutcome(sqliteOutcomeRow(deviceId, batchId));
    },

    getDevice(deviceId: string) {
      return mapDevice(getOne(referenceQueries.deviceExportersGetDevice, [deviceId]));
    },

    getSourceInstance(deviceId: string, sourceInstanceId: string) {
      return mapSourceInstance(getOne(referenceQueries.deviceExportersGetSourceInstance, [deviceId, sourceInstanceId]));
    },

    getSourceInstanceByBinding(deviceId: string, connectorId: string, localBindingId: string) {
      return mapSourceInstance(
        getOne(referenceQueries.deviceExportersGetSourceInstanceByBinding, [deviceId, connectorId, localBindingId])
      );
    },

    listBatchOutcomes({ deviceId = null, limit = 500 }: { deviceId?: string | null; limit?: number } = {}) {
      return getMany<Record<string, unknown>>(referenceQueries.deviceExportersListBatchOutcomes, [deviceId, deviceId], {
        limit,
      }).rows.map(mapOutcome);
    },

    listDevices(ownerSubjectId: string) {
      return allowUnboundedReadAcknowledged<Row>(referenceQueries.deviceExportersListDevices, [ownerSubjectId]).map(
        mapDevice
      );
    },

    listSourceInstanceHeartbeatsByConnector(connectorId: string, options?: { connectorInstanceId?: string | null }) {
      const connectorInstanceId = options?.connectorInstanceId ?? null;
      return allowUnboundedReadAcknowledged<Row>(
        referenceQueries.deviceExportersListSourceInstanceHeartbeatsByConnector,
        [connectorId, connectorInstanceId, connectorInstanceId]
      ).map(mapSourceInstanceHeartbeatRow);
    },

    listSourceInstances({ deviceId = null }: { deviceId?: string | null } = {}) {
      return allowUnboundedReadAcknowledged<Row>(referenceQueries.deviceExportersListSourceInstances, [
        deviceId,
        deviceId,
      ]).map(mapSourceInstance);
    },

    markCredentialUsed(credentialId: string, usedAt: string) {
      exec(referenceQueries.deviceExportersMarkCredentialUsed, [usedAt, credentialId]);
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

    recordBatchOutcome(record: Row) {
      const existing = mapOutcome(sqliteOutcomeRow(record.deviceId, record.batchId));
      const replay = replayOrConflict(existing, record);
      if (replay) {
        return { kind: "replayed", outcome: replay };
      }

      const normalized = normalizeOutcome(record);
      const acceptedCount = Number((record.response as Record<string, unknown> | null)?.accepted_record_count ?? 0);
      exec(referenceQueries.deviceExportersInsertBatchOutcome, [
        normalized.deviceId,
        normalized.batchId,
        normalized.bodyHash,
        normalized.sourceInstanceId,
        normalized.connectorInstanceId,
        normalized.connectorId,
        normalized.batchSeq,
        "accepted",
        normalized.httpStatus,
        normalized.responseJson,
        acceptedCount,
        acceptedCount,
        normalized.createdAt,
        normalized.createdAt,
      ]);
      return {
        kind: "created",
        outcome: mapOutcome({
          accepted_at: normalized.createdAt,
          batch_id: normalized.batchId,
          batch_seq: normalized.batchSeq,
          body_hash: normalized.bodyHash,
          connector_id: normalized.connectorId,
          connector_instance_id: normalized.connectorInstanceId,
          created_at: normalized.createdAt,
          device_id: normalized.deviceId,
          durable_prefix_count: acceptedCount,
          http_status: normalized.httpStatus,
          record_count: acceptedCount,
          response_json: normalized.responseJson,
          source_instance_id: normalized.sourceInstanceId,
          status: "accepted",
        }),
      };
    },

    refreshProcessingAttemptContext(record: Row) {
      const result = exec(referenceQueries.deviceExportersRefreshProcessingAttemptContext, [
        record.manifestFingerprint,
        record.semanticCapabilityIdentity,
        ...reservationIdentityBinds(record),
      ]);
      if (result.changes !== 1) {
        throw retryableReservationError("device ingest reservation context is no longer current");
      }
      return mapOutcome(sqliteOutcomeRow(record.deviceId, record.batchId));
    },

    // Design D6 (fix-enroll-stable-binding-identity-key), qualified by
    // sourceKind per D7 (fix-enroll-source-kind-identity-gap). See the
    // Postgres implementation's doc comment for the full contract (orphan
    // eligibility, fail-closed-on-ambiguity, why sourceKind is part of the
    // identity key). No explicit lock is needed here: better-sqlite3 is
    // synchronous and single-connection, so the lookup-then-create sequence
    // below cannot be interleaved by a concurrent request — Node's
    // single-threaded event loop cannot run another callback
    // mid-synchronous-execution, which is the actual property a lock would
    // otherwise need to provide.
    resolveOrCreateEnrollmentDevice(params: {
      ownerSubjectId: string;
      connectorId: string;
      sourceKind: string;
      localBindingId: string;
      candidateDeviceId: string;
      candidateSourceInstanceId: string;
      displayName: string;
      collectorProtocolVersion: string | null;
      now: string;
    }) {
      const orphans = allowUnboundedReadAcknowledged<{ device_id: string; source_instance_id: string }>(
        referenceQueries.deviceExportersFindOrphanedDeviceForBinding,
        [params.ownerSubjectId, params.connectorId, params.sourceKind, params.localBindingId]
      );
      if (orphans.length > 1) {
        throw new Error(
          `resolveOrCreateEnrollmentDevice: ambiguous orphan set (${orphans.length} candidates) for owner=${params.ownerSubjectId} connector=${params.connectorId} sourceKind=${params.sourceKind} binding=${params.localBindingId}; refusing to guess`
        );
      }
      // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
      const orphan = orphans[0];
      if (orphan) {
        return { adopted: true, deviceId: orphan.device_id, sourceInstanceId: orphan.source_instance_id };
      }
      exec(referenceQueries.deviceExportersInsertDevice, [
        params.candidateDeviceId,
        params.ownerSubjectId,
        params.displayName,
        "active",
        null,
        params.collectorProtocolVersion,
        null,
        null,
        params.now,
        params.now,
        null,
      ]);
      // Placeholder source-instance row (connector_instance_id NULL) in the
      // SAME synchronous call sequence as the device — see the Postgres
      // implementation's doc comment for why this matters even here (a
      // future refactor that made this async could otherwise reintroduce
      // the race this placeholder exists to prevent).
      exec(referenceQueries.deviceExportersUpsertSourceInstance, [
        params.candidateSourceInstanceId,
        params.candidateDeviceId,
        params.connectorId,
        null,
        params.localBindingId,
        params.sourceKind,
        params.displayName,
        "active",
        null,
        params.now,
        params.now,
        null,
      ]);
      return { adopted: false, deviceId: params.candidateDeviceId, sourceInstanceId: params.candidateSourceInstanceId };
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

    revokeEnrollmentCode(enrollmentCodeId: string, revokedAt: string) {
      const result = exec(referenceQueries.deviceExportersRevokeEnrollmentCode, [revokedAt, enrollmentCodeId]);
      return result.changes === 1;
    },

    // Revoke every non-revoked credential for the device and install exactly one
    // fresh credential, so a re-enroll (idempotent-response retry) yields a
    // single current token and invalidates any previously issued token. See
    // decouple-device-enrollment-from-ingest-writer-admission design D2.
    rotateDeviceCredential(record: Row) {
      exec(referenceQueries.deviceExportersRevokeCredentialsForDevice, [record.rotatedAt, record.deviceId]);
      exec(referenceQueries.deviceExportersInsertCredential, [
        record.credentialId,
        record.deviceId,
        record.tokenHash,
        "active",
        record.createdAt,
        null,
        null,
      ]);
    },

    upsertSourceInstance(record: Row) {
      exec(referenceQueries.deviceExportersUpsertSourceInstance, [
        record.sourceInstanceId,
        record.deviceId,
        record.connectorId,
        record.connectorInstanceId ?? null,
        record.localBindingId,
        record.sourceKind ?? null,
        record.displayName ?? null,
        record.status ?? "active",
        record.lastError === undefined ? null : JSON.stringify(record.lastError),
        record.createdAt,
        record.updatedAt,
        record.revokedAt ?? null,
      ]);
    },
  };
}

export function createPostgresDeviceExporterStore() {
  return {
    completeProcessingBatch(record: Row) {
      return withPostgresTransaction(async (client: PostgresTransactionClient) => {
        const reservation = await client.query(
          `SELECT manifest_fingerprint, semantic_capability_identity
             FROM device_ingest_batch_outcomes
            WHERE device_id = $1 AND batch_id = $2
            FOR UPDATE`,
          [record.deviceId, record.batchId]
        );
        if (reservation.rowCount !== 1) {
          throw retryableReservationError();
        }
        const manifest = await client.query("SELECT manifest FROM connectors WHERE connector_id = $1 FOR SHARE", [
          record.connectorId,
        ]);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        const rawManifest = manifest.rows?.[0]?.manifest;
        const currentManifestFingerprint = isNullish(rawManifest)
          ? null
          : fingerprintDeviceAttemptManifest(rawManifest);
        const currentSemanticCapabilityIdentity = record.getCurrentSemanticCapabilityIdentity?.();
        if (
          currentManifestFingerprint !== record.manifestFingerprint ||
          currentSemanticCapabilityIdentity !== record.semanticCapabilityIdentity
        ) {
          throw retryableReservationError("device ingest attempt facts changed before acceptance");
        }
        const result = await client.query(
          `UPDATE device_ingest_batch_outcomes
              SET status = 'accepted', accepted_at = $1, http_status = $2, response_json = $3::jsonb
            WHERE device_id = $4 AND batch_id = $5 AND body_hash = $6
              AND source_instance_id = $7 AND connector_instance_id = $8
              AND connector_id = $9 AND batch_seq = $10
              AND manifest_fingerprint = $11 AND semantic_capability_identity = $12
              AND status = 'processing' AND durable_prefix_count = record_count`,
          [
            record.acceptedAt,
            record.httpStatus,
            JSON.stringify(record.response),
            ...reservationIdentityBinds(record),
            record.manifestFingerprint,
            record.semanticCapabilityIdentity,
          ]
        );
        if (result.rowCount !== 1) {
          throw retryableReservationError();
        }
        const accepted = await client.query(
          `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                  connector_id, batch_seq, status, http_status, response_json,
                  record_count, durable_prefix_count, manifest_fingerprint,
                  semantic_capability_identity, created_at, accepted_at
             FROM device_ingest_batch_outcomes
            WHERE device_id = $1 AND batch_id = $2`,
          [record.deviceId, record.batchId]
        );
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        return mapOutcome(accepted.rows?.[0]);
      });
    },

    async consumeEnrollmentCode(enrollmentCodeId: string, deviceId: string, consumedAt: string) {
      const result = await postgresQuery(
        `UPDATE device_enrollment_codes SET status = 'consumed', device_id = $1, consumed_at = $2
         WHERE enrollment_code_id = $3 AND status = 'pending'`,
        [deviceId, consumedAt, enrollmentCodeId]
      );
      return result.rowCount === 1;
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
    async createDevice(record: Row) {
      // ON CONFLICT DO NOTHING: device_id is deterministic per enrollment
      // code (see fix-enroll-pending-code-partial-write-idempotency design
      // D5), so a concurrent retry of the same pending code racing another
      // first attempt converges on one device row instead of a duplicate-key
      // error.
      await postgresQuery(
        `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
         ON CONFLICT(device_id) DO NOTHING`,
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

    async ensureProcessingBatch(record: Row) {
      const existing = await this.getBatchOutcome(record.deviceId, record.batchId);
      const replay = replayOrConflict(existing, record);
      if (replay) {
        return replay;
      }
      try {
        await postgresQuery(
          `INSERT INTO device_ingest_batch_outcomes(
            device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
            connector_id, batch_seq, status, record_count, durable_prefix_count,
            manifest_fingerprint, semantic_capability_identity, created_at
          ) VALUES($1, $2, $3, $4, $5, $6, $7, 'processing', $8, 0, $9, $10, $11)`,
          [
            ...reservationIdentityBinds(record),
            record.recordCount,
            record.manifestFingerprint,
            record.semanticCapabilityIdentity,
            record.createdAt,
          ]
        );
      } catch (err) {
        const raced = await this.getBatchOutcome(record.deviceId, record.batchId);
        const replayed = replayOrConflict(raced, record);
        if (replayed) {
          return replayed;
        }
        throw err;
      }
      return this.getBatchOutcome(record.deviceId, record.batchId);
    },

    async findCredentialByTokenHash(tokenHash: string) {
      const result = await postgresQuery(
        `SELECT credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at
         FROM device_ingest_credentials WHERE token_hash = $1`,
        [tokenHash]
      );
      return mapCredential(result.rows[0]);
    },

    async findEnrollmentByCodeHash(codeHash: string) {
      const result = await postgresQuery(
        `SELECT enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, display_name, device_id, status, created_at, expires_at, consumed_at, revoked_at
         FROM device_enrollment_codes WHERE code_hash = $1`,
        [codeHash]
      );
      return mapEnrollment(result.rows[0]);
    },

    async getBatchOutcome(deviceId: string, batchId: string) {
      const result = await postgresQuery(
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
         FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2`,
        [deviceId, batchId]
      );
      return mapOutcome(result.rows[0]);
    },

    async getDevice(deviceId: string) {
      const result = await postgresQuery(
        `SELECT device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
         FROM device_exporters WHERE device_id = $1`,
        [deviceId]
      );
      return mapDevice(result.rows[0]);
    },

    async getSourceInstance(deviceId: string, sourceInstanceId: string) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, last_heartbeat_at, last_heartbeat_status, records_pending, outbox_diagnostics_json, manifest_generation, created_at, updated_at, revoked_at
         FROM device_source_instances WHERE device_id = $1 AND source_instance_id = $2`,
        [deviceId, sourceInstanceId]
      );
      return mapSourceInstance(result.rows[0]);
    },

    async getSourceInstanceByBinding(deviceId: string, connectorId: string, localBindingId: string) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, last_heartbeat_at, last_heartbeat_status, records_pending, outbox_diagnostics_json, manifest_generation, created_at, updated_at, revoked_at
         FROM device_source_instances WHERE device_id = $1 AND connector_id = $2 AND local_binding_id = $3`,
        [deviceId, connectorId, localBindingId]
      );
      return mapSourceInstance(result.rows[0]);
    },

    async listBatchOutcomes({ deviceId = null, limit = 500 }: { deviceId?: string | null; limit?: number } = {}) {
      const result = await postgresQuery(
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
         FROM device_ingest_batch_outcomes
         WHERE ($1::text IS NULL OR device_id = $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [deviceId, limit]
      );
      return result.rows.map(mapOutcome);
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
                dsi.manifest_generation,
                dsi.updated_at,
                dio.last_ingest_at,
                de.status AS device_status,
                de.revoked_at AS device_revoked_at
           FROM device_source_instances dsi
           JOIN device_exporters de ON de.device_id = dsi.device_id
           LEFT JOIN (
             SELECT device_id, source_instance_id, MAX(accepted_at) AS last_ingest_at
               FROM device_ingest_batch_outcomes
              WHERE status = 'accepted'
              GROUP BY device_id, source_instance_id
           ) dio ON dio.device_id = dsi.device_id AND dio.source_instance_id = dsi.source_instance_id
          WHERE dsi.connector_id = $1
            AND ($2::text IS NULL OR dsi.connector_instance_id = $2)
          ORDER BY (dsi.last_heartbeat_at IS NULL), dsi.last_heartbeat_at DESC NULLS LAST, dsi.device_id ASC, dsi.source_instance_id ASC`,
        [connectorId, connectorInstanceId]
      );
      return result.rows.map(mapSourceInstanceHeartbeatRow);
    },

    async listSourceInstances({ deviceId = null }: { deviceId?: string | null } = {}) {
      const result = await postgresQuery(
        `SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, last_heartbeat_at, last_heartbeat_status, records_pending, outbox_diagnostics_json, manifest_generation, created_at, updated_at, revoked_at
         FROM device_source_instances
         WHERE ($1::text IS NULL OR device_id = $1)
         ORDER BY device_id ASC, created_at DESC, source_instance_id ASC`,
        [deviceId]
      );
      return result.rows.map(mapSourceInstance);
    },

    async markCredentialUsed(credentialId: string, usedAt: string) {
      await postgresQuery("UPDATE device_ingest_credentials SET last_used_at = $1 WHERE credential_id = $2", [
        usedAt,
        credentialId,
      ]);
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

    async markSourceInstanceHeartbeat(deviceId: string, sourceInstanceId: string, record: Row) {
      const result = await postgresQuery(
        `UPDATE device_source_instances
            SET updated_at = $1,
                last_error_json = $2::jsonb,
                last_heartbeat_at = $3,
                last_heartbeat_status = $4,
                records_pending = $5,
                outbox_diagnostics_json = $6::jsonb,
                manifest_generation = (SELECT manifest_generation FROM connector_instances WHERE connector_instance_id = device_source_instances.connector_instance_id)
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

    async recordBatchOutcome(record: Row) {
      const existingResult = await postgresQuery(
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json,
                record_count, durable_prefix_count, created_at, accepted_at
         FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2`,
        [record.deviceId, record.batchId]
      );
      const existing = mapOutcome(existingResult.rows[0]);
      const replay = replayOrConflict(existing, record);
      if (replay) {
        return { kind: "replayed", outcome: replay };
      }

      const normalized = normalizeOutcome(record);
      const acceptedCount = Number((record.response as Record<string, unknown> | null)?.accepted_record_count ?? 0);
      await postgresQuery(
        `INSERT INTO device_ingest_batch_outcomes(
          device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
          connector_id, batch_seq, status, http_status, response_json, record_count,
          durable_prefix_count, created_at, accepted_at
        ) VALUES($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, $9::jsonb, $10, $11, $12, $13)`,
        [
          normalized.deviceId,
          normalized.batchId,
          normalized.bodyHash,
          normalized.sourceInstanceId,
          normalized.connectorInstanceId,
          normalized.connectorId,
          normalized.batchSeq,
          normalized.httpStatus,
          normalized.responseJson,
          acceptedCount,
          acceptedCount,
          normalized.createdAt,
          normalized.createdAt,
        ]
      );
      return {
        kind: "created",
        outcome: mapOutcome({
          accepted_at: normalized.createdAt,
          batch_id: normalized.batchId,
          batch_seq: normalized.batchSeq,
          body_hash: normalized.bodyHash,
          connector_id: normalized.connectorId,
          connector_instance_id: normalized.connectorInstanceId,
          created_at: normalized.createdAt,
          device_id: normalized.deviceId,
          durable_prefix_count: acceptedCount,
          http_status: normalized.httpStatus,
          record_count: acceptedCount,
          response_json: normalized.responseJson,
          source_instance_id: normalized.sourceInstanceId,
          status: "accepted",
        }),
      };
    },

    async refreshProcessingAttemptContext(record: Row) {
      const result = await postgresQuery(
        `UPDATE device_ingest_batch_outcomes
            SET manifest_fingerprint = $1, semantic_capability_identity = $2
          WHERE device_id = $3 AND batch_id = $4 AND body_hash = $5
            AND source_instance_id = $6 AND connector_instance_id = $7
            AND connector_id = $8 AND batch_seq = $9 AND status = 'processing'`,
        [record.manifestFingerprint, record.semanticCapabilityIdentity, ...reservationIdentityBinds(record)]
      );
      if (result.rowCount !== 1) {
        throw retryableReservationError("device ingest reservation context is no longer current");
      }
      return this.getBatchOutcome(record.deviceId, record.batchId);
    },

    // Design D6 (fix-enroll-stable-binding-identity-key), qualified by
    // sourceKind per D7 (fix-enroll-source-kind-identity-gap). Resolves the
    // device identity a first-time enroll for this (owner, connector,
    // sourceKind, binding) should use, adopting an orphaned partial-write
    // device if one exists rather than always minting fresh identity.
    //
    // sourceKind is part of the identity key — not just the local binding
    // name — because the same owner, connector, and binding name can be
    // enrolled under two structurally distinct connector-instance kinds
    // (local_device vs browser_collector; see connector-source-kind.ts).
    // Without this qualifier, an orphan created under one kind could be
    // adopted by an enrollment resolving to the other, silently merging two
    // unrelated identities. The caller resolves sourceKind from the
    // connector's manifest BEFORE calling this method (never derived here),
    // so the same qualifier is available for both the lock key and the
    // orphan-eligibility predicate.
    //
    // Serialization: the lookup-then-create decision is itself a race — two
    // genuinely concurrent enroll attempts for the same still-empty binding
    // could both observe "no orphan" and each create a distinct device
    // before either commits, since neither has written anything yet for the
    // per-device lock (rotateDeviceCredential's SELECT...FOR UPDATE) to
    // serialize on. This method closes that gap with a DURABLE,
    // database-backed serialization boundary — pg_advisory_xact_lock keyed
    // on the (owner, connector, sourceKind, binding) tuple, held for exactly
    // the find-or-create decision and released automatically on
    // commit/rollback — never a process-local lock (worthless across
    // concurrent requests on the same or different processes; useless
    // against real Postgres concurrency).
    //
    // Orphan eligibility (see the WHERE clause): exact owner_subject_id +
    // connector_id + source_kind + local_binding_id match; never had a code
    // successfully consumed for it (device_enrollment_codes.status =
    // 'consumed'); not revoked. If more than one candidate somehow exists
    // (should be unreachable given this method is the only writer, but the
    // query is defensive), this FAILS CLOSED by throwing rather than
    // silently picking one — an ambiguous orphan set must never be resolved
    // by guessing.
    async resolveOrCreateEnrollmentDevice(params: {
      ownerSubjectId: string;
      connectorId: string;
      sourceKind: string;
      localBindingId: string;
      candidateDeviceId: string;
      candidateSourceInstanceId: string;
      displayName: string;
      collectorProtocolVersion: string | null;
      now: string;
    }) {
      return await withPostgresTransaction(async (client: PostgresTransactionClient) => {
        const lockKey = advisoryEnrollmentBindingKey(
          params.ownerSubjectId,
          params.connectorId,
          params.sourceKind,
          params.localBindingId
        );
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey]);

        const orphans = await client.query(
          `SELECT dsi.device_id, dsi.source_instance_id
             FROM device_source_instances dsi
             JOIN device_exporters de ON de.device_id = dsi.device_id
            WHERE de.owner_subject_id = $1
              AND dsi.connector_id = $2
              AND dsi.source_kind = $3
              AND dsi.local_binding_id = $4
              AND dsi.status != 'revoked'
              AND de.status != 'revoked'
              AND NOT EXISTS (
                SELECT 1 FROM device_enrollment_codes dec
                WHERE dec.device_id = dsi.device_id AND dec.status = 'consumed'
              )
            ORDER BY dsi.created_at DESC`,
          [params.ownerSubjectId, params.connectorId, params.sourceKind, params.localBindingId]
        );
        if (orphans.rows.length > 1) {
          throw new Error(
            `resolveOrCreateEnrollmentDevice: ambiguous orphan set (${orphans.rows.length} candidates) for owner=${params.ownerSubjectId} connector=${params.connectorId} sourceKind=${params.sourceKind} binding=${params.localBindingId}; refusing to guess`
          );
        }
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const orphan = orphans.rows[0];
        if (orphan) {
          return { adopted: true, deviceId: orphan.device_id, sourceInstanceId: orphan.source_instance_id };
        }

        await client.query(
          `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, $3, 'active', NULL, $4, NULL, NULL, $5, $5, NULL)
           ON CONFLICT(device_id) DO NOTHING`,
          [
            params.candidateDeviceId,
            params.ownerSubjectId,
            params.displayName,
            params.collectorProtocolVersion,
            params.now,
          ]
        );
        // A placeholder source-instance row (connector_instance_id NULL) is
        // created in the SAME locked transaction as the device, not left for
        // the caller's later upsertSourceInstance call. Otherwise the orphan
        // query above — which requires a device_source_instances row to
        // exist — would never see a device between the moment this
        // transaction commits and the moment the caller's own (unlocked)
        // upsertSourceInstance runs, so a concurrent second attempt's lock
        // acquisition in that window would wrongly conclude no orphan exists
        // and create a SECOND, independent device for the same binding.
        // upsertSourceInstance's own ON CONFLICT(device_id, connector_id,
        // local_binding_id) safely fills in the real connector_instance_id
        // afterward.
        await client.query(
          `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, last_error_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, $3, NULL, $4, $5, $6, 'active', NULL, $7, $7, NULL)
           ON CONFLICT(device_id, connector_id, local_binding_id) DO NOTHING`,
          [
            params.candidateSourceInstanceId,
            params.candidateDeviceId,
            params.connectorId,
            params.localBindingId,
            params.sourceKind,
            params.displayName,
            params.now,
          ]
        );
        return {
          adopted: false,
          deviceId: params.candidateDeviceId,
          sourceInstanceId: params.candidateSourceInstanceId,
        };
      });
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

    async revokeEnrollmentCode(enrollmentCodeId: string, revokedAt: string) {
      const result = await postgresQuery(
        `UPDATE device_enrollment_codes SET status = 'revoked', revoked_at = $1
         WHERE enrollment_code_id = $2 AND status = 'pending'`,
        [revokedAt, enrollmentCodeId]
      );
      return result.rowCount === 1;
    },

    // Revoke every non-revoked credential for the device and install exactly one
    // fresh credential, so a re-enroll (idempotent-response retry) yields a
    // single current token and invalidates any previously issued token. See
    // decouple-device-enrollment-from-ingest-writer-admission design D2.
    //
    // Serialization: the revoke UPDATE alone only locks rows it actually
    // matches. When the device has ZERO credential rows yet (the D5
    // empty-device first-attempt case — concurrent first enrolls for the same
    // pending code, or the very first rotation any device ever gets), the
    // revoke touches nothing and takes no lock, so two concurrent
    // transactions can both fall through to INSERT and each commit an active
    // credential — violating "exactly one active credential." Lock the
    // device's OWN identity row first with SELECT ... FOR UPDATE: that row is
    // guaranteed to exist (created by createDevice before any rotation is
    // ever attempted) and is guaranteed unique per device, so it is always a
    // real serialization point regardless of how many credential rows exist.
    // A concurrent rotation for the SAME device blocks on this lock until the
    // first transaction commits, then re-reads the now-revoked prior
    // credential and inserts its own — exactly-once-active is a database
    // invariant, not a race on which UPDATE happens to touch a row.
    async rotateDeviceCredential(record: Row) {
      await withPostgresTransaction(async (client: PostgresTransactionClient) => {
        const locked = await client.query("SELECT device_id FROM device_exporters WHERE device_id = $1 FOR UPDATE", [
          record.deviceId,
        ]);
        if (locked.rowCount === 0) {
          throw new Error(`rotateDeviceCredential: no device_exporters row for device_id ${record.deviceId}`);
        }
        await client.query(
          `UPDATE device_ingest_credentials SET status = 'revoked', revoked_at = $1 WHERE device_id = $2 AND status <> 'revoked'`,
          [record.rotatedAt, record.deviceId]
        );
        await client.query(
          `INSERT INTO device_ingest_credentials(credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at)
           VALUES($1, $2, $3, 'active', $4, NULL, NULL)`,
          [record.credentialId, record.deviceId, record.tokenHash, record.createdAt]
        );
      });
    },

    async upsertSourceInstance(record: Row) {
      await postgresQuery(
        `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, last_error_json, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         ON CONFLICT(device_id, connector_id, local_binding_id) DO UPDATE SET
           source_instance_id = excluded.source_instance_id,
           connector_instance_id = excluded.connector_instance_id,
           source_kind = excluded.source_kind,
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
          record.sourceKind ?? null,
          record.displayName ?? null,
          record.status ?? "active",
          record.lastError === undefined ? null : JSON.stringify(record.lastError),
          record.createdAt,
          record.updatedAt,
          record.revokedAt ?? null,
        ]
      );
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

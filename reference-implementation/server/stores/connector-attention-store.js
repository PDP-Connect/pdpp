/**
 * Durable structured-attention record store for the reference operator
 * console.
 *
 * Persists `AttentionRecord` shapes from `runtime/attention.ts` so the
 * connection-health projection can read non-secret attention evidence
 * per (connector_id, connector_instance_id) without bouncing through the
 * scheduler's coarse `human_attention_needed` flag.
 *
 * Reference-only: this is not a PDPP Core surface. Callers (controller,
 * scheduler, controller-side detectors) wrap their attention decisions in
 * `upsertAttention`; the projection layer reads via
 * `listOpenAttentionForConnection` and trusts the runtime's redaction.
 */

import { iterateDynamicSqlAcknowledged, execDynamicSqlAcknowledged } from '../../lib/db.ts';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../owner-auth.ts';
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from '../postgres-storage.js';
import { makeDefaultAccountConnectorInstanceId } from './connector-instance-store.js';

const OPEN_LIFECYCLES = ['open', 'acknowledged', 'in_progress'];
const VALID_LIFECYCLES = new Set([
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'expired',
  'cancelled',
  'superseded',
]);
const TERMINAL_LIFECYCLES = new Set(['resolved', 'expired', 'cancelled', 'superseded']);
const ALLOWED_TRANSITIONS = {
  open: new Set(['acknowledged', 'in_progress', 'resolved', 'expired', 'cancelled', 'superseded']),
  acknowledged: new Set(['in_progress', 'resolved', 'expired', 'cancelled', 'superseded']),
  in_progress: new Set(['resolved', 'expired', 'cancelled', 'superseded']),
  resolved: new Set(),
  expired: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function defaultConnectorInstanceId(connectorId) {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureRecordShape(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('connector attention store: record must be an object');
  }
  const required = [
    'id',
    'dedupe_key',
    'connection_id',
    'reason_code',
    'lifecycle',
    'sensitivity',
    'created_at',
    'updated_at',
  ];
  for (const field of required) {
    if (typeof record[field] !== 'string' || !record[field]) {
      throw new Error(`connector attention store: record.${field} is required`);
    }
  }
  if (!VALID_LIFECYCLES.has(record.lifecycle)) {
    throw new Error(`connector attention store: invalid lifecycle ${record.lifecycle}`);
  }
}

function rowToRecord(row) {
  if (!row) return null;
  const json = typeof row.record_json === 'string' ? row.record_json : JSON.stringify(row.record_json);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`connector attention store: malformed record_json for ${row.attention_id}`);
  }
  // The persisted record_json is authoritative for the AttentionRecord
  // shape; the column projections are duplicated for indexed predicates
  // only. Trust the column-side lifecycle for callers that want to filter
  // without parsing JSON, but return the parsed record verbatim so the
  // projection sees exactly what the writer redacted.
  return parsed;
}

function encodeUpsertArgs(record, connectorId, connectorInstanceId) {
  ensureRecordShape(record);
  return {
    attentionId: record.id,
    dedupeKey: record.dedupe_key,
    connectorId,
    connectorInstanceId,
    connectionId: record.connection_id,
    runId: nonEmptyString(record.run_id),
    reasonCode: record.reason_code,
    lifecycle: record.lifecycle,
    sensitivity: record.sensitivity,
    expiresAt: nonEmptyString(record.expires_at),
    recordJson: JSON.stringify(record),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function clampLimit(limit) {
  const raw = Number(limit);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIST_LIMIT));
}

function buildSqliteOpenPredicate(lifecycles) {
  const placeholders = lifecycles.map(() => '?').join(', ');
  return `lifecycle IN (${placeholders})`;
}

const VALID_NOTIFICATION_STATES = new Set(['acknowledged', 'failed', 'pending', 'sent', 'suppressed']);

function applyNotificationOutcomeToRecord(record, { outcome, reason, now }) {
  if (!VALID_NOTIFICATION_STATES.has(outcome)) {
    throw new Error(`recordNotificationOutcomeById: invalid outcome ${outcome}`);
  }
  const trimmedReason = nonEmptyString(reason);
  return {
    ...record,
    notification_state: outcome,
    notification_updated_at: now,
    notification_reason: trimmedReason,
  };
}

export function createSqliteConnectorAttentionStore() {
  return {
    async upsertAttention({ record, connectorId, connectorInstanceId }) {
      const id = nonEmptyString(connectorId);
      if (!id) throw new Error('upsertAttention: connectorId is required');
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const args = encodeUpsertArgs(record, id, instance);
      // REVIEWED-DYNAMIC: connector_attention_records is owned by this store
      // and is not represented in the static query registry yet.
      execDynamicSqlAcknowledged(
        `INSERT INTO connector_attention_records(
           attention_id, dedupe_key, connector_id, connector_instance_id, connection_id,
           run_id, reason_code, lifecycle, sensitivity, expires_at, record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attention_id) DO UPDATE SET
           dedupe_key = excluded.dedupe_key,
           connector_id = excluded.connector_id,
           connector_instance_id = excluded.connector_instance_id,
           connection_id = excluded.connection_id,
           run_id = excluded.run_id,
           reason_code = excluded.reason_code,
           lifecycle = excluded.lifecycle,
           sensitivity = excluded.sensitivity,
           expires_at = excluded.expires_at,
           record_json = excluded.record_json,
           updated_at = excluded.updated_at`,
        [
          args.attentionId,
          args.dedupeKey,
          args.connectorId,
          args.connectorInstanceId,
          args.connectionId,
          args.runId,
          args.reasonCode,
          args.lifecycle,
          args.sensitivity,
          args.expiresAt,
          args.recordJson,
          args.createdAt,
          args.updatedAt,
        ],
      );
      return record;
    },

    async listOpenAttentionForConnection({ connectorId, connectorInstanceId, limit } = {}) {
      const id = nonEmptyString(connectorId);
      if (!id) throw new Error('listOpenAttentionForConnection: connectorId is required');
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const bounded = clampLimit(limit);
      // REVIEWED-DYNAMIC: parameterized read over the store-owned table.
      // Bounded by `limit` (clamped to MAX_LIST_LIMIT) so a connection with
      // unusual attention churn cannot fan out the dashboard list call.
      const rows = [
        ...iterateDynamicSqlAcknowledged(
          `SELECT attention_id, record_json
             FROM connector_attention_records
            WHERE connector_id = ?
              AND connector_instance_id = ?
              AND ${buildSqliteOpenPredicate(OPEN_LIFECYCLES)}
            ORDER BY updated_at DESC
            LIMIT ?`,
          [id, instance, ...OPEN_LIFECYCLES, bounded],
        ),
      ];
      return rows.map(rowToRecord);
    },

    async transitionAttention({ attentionId, to, now }) {
      const id = nonEmptyString(attentionId);
      if (!id) throw new Error('transitionAttention: attentionId is required');
      if (!VALID_LIFECYCLES.has(to)) {
        throw new Error(`transitionAttention: invalid target lifecycle ${to}`);
      }
      const updatedAt = nonEmptyString(now) || nowIso();
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned table.
      const row = [...iterateDynamicSqlAcknowledged(
        'SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = ? LIMIT 1',
        [id],
      )][0];
      if (!row) return null;
      const current = row.lifecycle;
      if (TERMINAL_LIFECYCLES.has(current)) {
        throw new Error(`transitionAttention: ${id} is terminal (${current})`);
      }
      if (!ALLOWED_TRANSITIONS[current].has(to)) {
        throw new Error(`transitionAttention: invalid transition ${current} -> ${to} for ${id}`);
      }
      const record = rowToRecord(row);
      const next = { ...record, lifecycle: to, updated_at: updatedAt };
      // REVIEWED-DYNAMIC: lifecycle mutation for the store-owned table.
      execDynamicSqlAcknowledged(
        `UPDATE connector_attention_records
            SET lifecycle = ?, updated_at = ?, record_json = ?
          WHERE attention_id = ?`,
        [to, updatedAt, JSON.stringify(next), id],
      );
      return next;
    },

    /**
     * Update the durable `notification_state` axis on an existing row
     * without touching lifecycle. The push fanout uses this to record
     * whether delivery actually reached the owner so the operator
     * console can answer "did we tell them?" without re-reading
     * transport logs. Lifecycle is intentionally preserved — a
     * `failed` outcome must NOT terminate the attention; the spec
     * scenario "Notification failure does not cause a run storm"
     * requires the unresolved owner action to remain visible.
     */
    async recordNotificationOutcomeById({ attentionId, outcome, reason, now }) {
      const id = nonEmptyString(attentionId);
      if (!id) throw new Error('recordNotificationOutcomeById: attentionId is required');
      const updatedAt = nonEmptyString(now) || nowIso();
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned table.
      const row = [...iterateDynamicSqlAcknowledged(
        'SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = ? LIMIT 1',
        [id],
      )][0];
      if (!row) return null;
      const record = rowToRecord(row);
      const next = applyNotificationOutcomeToRecord(record, { outcome, reason, now: updatedAt });
      // REVIEWED-DYNAMIC: notification-axis mutation for the store-owned table.
      // `updated_at` and `lifecycle` columns are intentionally left as-is so
      // an external notification outcome does not look like a lifecycle event
      // to projection consumers that read the column shape.
      execDynamicSqlAcknowledged(
        'UPDATE connector_attention_records SET record_json = ? WHERE attention_id = ?',
        [JSON.stringify(next), id],
      );
      return next;
    },
  };
}

export function createPostgresConnectorAttentionStore() {
  return {
    async upsertAttention({ record, connectorId, connectorInstanceId }) {
      const id = nonEmptyString(connectorId);
      if (!id) throw new Error('upsertAttention: connectorId is required');
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const args = encodeUpsertArgs(record, id, instance);
      await postgresQuery(
        `INSERT INTO connector_attention_records(
           attention_id, dedupe_key, connector_id, connector_instance_id, connection_id,
           run_id, reason_code, lifecycle, sensitivity, expires_at, record_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
         ON CONFLICT (attention_id) DO UPDATE SET
           dedupe_key = EXCLUDED.dedupe_key,
           connector_id = EXCLUDED.connector_id,
           connector_instance_id = EXCLUDED.connector_instance_id,
           connection_id = EXCLUDED.connection_id,
           run_id = EXCLUDED.run_id,
           reason_code = EXCLUDED.reason_code,
           lifecycle = EXCLUDED.lifecycle,
           sensitivity = EXCLUDED.sensitivity,
           expires_at = EXCLUDED.expires_at,
           record_json = EXCLUDED.record_json,
           updated_at = EXCLUDED.updated_at`,
        [
          args.attentionId,
          args.dedupeKey,
          args.connectorId,
          args.connectorInstanceId,
          args.connectionId,
          args.runId,
          args.reasonCode,
          args.lifecycle,
          args.sensitivity,
          args.expiresAt,
          args.recordJson,
          args.createdAt,
          args.updatedAt,
        ],
      );
      return record;
    },

    async listOpenAttentionForConnection({ connectorId, connectorInstanceId, limit } = {}) {
      const id = nonEmptyString(connectorId);
      if (!id) throw new Error('listOpenAttentionForConnection: connectorId is required');
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const bounded = clampLimit(limit);
      const result = await postgresQuery(
        `SELECT attention_id, record_json
           FROM connector_attention_records
          WHERE connector_id = $1
            AND connector_instance_id = $2
            AND lifecycle = ANY($3::text[])
          ORDER BY updated_at DESC
          LIMIT $4`,
        [id, instance, OPEN_LIFECYCLES, bounded],
      );
      return result.rows.map(rowToRecord);
    },

    async transitionAttention({ attentionId, to, now }) {
      const id = nonEmptyString(attentionId);
      if (!id) throw new Error('transitionAttention: attentionId is required');
      if (!VALID_LIFECYCLES.has(to)) {
        throw new Error(`transitionAttention: invalid target lifecycle ${to}`);
      }
      const updatedAt = nonEmptyString(now) || nowIso();
      const lookup = await postgresQuery(
        'SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = $1',
        [id],
      );
      const row = lookup.rows[0];
      if (!row) return null;
      const current = row.lifecycle;
      if (TERMINAL_LIFECYCLES.has(current)) {
        throw new Error(`transitionAttention: ${id} is terminal (${current})`);
      }
      if (!ALLOWED_TRANSITIONS[current].has(to)) {
        throw new Error(`transitionAttention: invalid transition ${current} -> ${to} for ${id}`);
      }
      const record = rowToRecord(row);
      const next = { ...record, lifecycle: to, updated_at: updatedAt };
      await postgresQuery(
        `UPDATE connector_attention_records
            SET lifecycle = $1, updated_at = $2, record_json = $3::jsonb
          WHERE attention_id = $4`,
        [to, updatedAt, JSON.stringify(next), id],
      );
      return next;
    },

    async recordNotificationOutcomeById({ attentionId, outcome, reason, now }) {
      const id = nonEmptyString(attentionId);
      if (!id) throw new Error('recordNotificationOutcomeById: attentionId is required');
      const updatedAt = nonEmptyString(now) || nowIso();
      const lookup = await postgresQuery(
        'SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = $1',
        [id],
      );
      const row = lookup.rows[0];
      if (!row) return null;
      const record = rowToRecord(row);
      const next = applyNotificationOutcomeToRecord(record, { outcome, reason, now: updatedAt });
      await postgresQuery(
        'UPDATE connector_attention_records SET record_json = $1::jsonb WHERE attention_id = $2',
        [JSON.stringify(next), id],
      );
      return next;
    },
  };
}

export function createConnectorAttentionStore() {
  return isPostgresStorageBackend()
    ? createPostgresConnectorAttentionStore()
    : createSqliteConnectorAttentionStore();
}

let defaultStore = null;
let defaultBackend = null;

export function getDefaultConnectorAttentionStore() {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultBackend !== backend) {
    defaultStore = createConnectorAttentionStore();
    defaultBackend = backend;
  }
  return defaultStore;
}

/**
 * Test/admin hook. Resets the cached store so a process that swaps the
 * storage backend mid-life (only the test harness does this) picks up
 * fresh credentials and prepared statements.
 */
export function resetDefaultConnectorAttentionStoreCache() {
  defaultStore = null;
  defaultBackend = null;
}

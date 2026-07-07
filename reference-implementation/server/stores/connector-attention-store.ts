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

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import type { AttentionLifecycle, AttentionRecord, NotificationState } from "../../runtime/attention.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../owner-auth.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";
import { makeDefaultAccountConnectorInstanceId } from "./connector-instance-store.js";

const OPEN_LIFECYCLES = ["open", "acknowledged", "in_progress"];
const VALID_LIFECYCLES = new Set([
  "open",
  "acknowledged",
  "in_progress",
  "resolved",
  "expired",
  "cancelled",
  "superseded",
]);
const TERMINAL_LIFECYCLES = new Set(["resolved", "expired", "cancelled", "superseded"]);
const ALLOWED_TRANSITIONS: Record<AttentionLifecycle, Set<string>> = {
  open: new Set(["acknowledged", "in_progress", "resolved", "expired", "cancelled", "superseded"]),
  acknowledged: new Set(["in_progress", "resolved", "expired", "cancelled", "superseded"]),
  in_progress: new Set(["resolved", "expired", "cancelled", "superseded"]),
  resolved: new Set(),
  expired: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const EXPIRE_DUE_LIMIT = 200;
const TERMINAL_RUN_ATTENTION_RECONCILE_LIMIT = MAX_LIST_LIMIT;
const TERMINAL_RUN_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
];

/** Row projection for the transition/notification single-row lookups. */
interface AttentionLifecycleRow {
  lifecycle: AttentionLifecycle;
  record_json: string | unknown;
}
/** Row projection for the open-attention list read. */
interface AttentionListRow {
  attention_id: string;
  record_json: string | unknown;
}
/** Row projection for the expire-due read (adds `expires_at`). */
type AttentionExpireRow = AttentionListRow & { expires_at: string | null };

/** Encoded columns for an attention upsert. */
interface UpsertArgs {
  attentionId: string;
  connectionId: string;
  connectorId: string;
  connectorInstanceId: string;
  createdAt: string;
  dedupeKey: string;
  expiresAt: string | null;
  lifecycle: AttentionLifecycle;
  reasonCode: string;
  recordJson: string;
  runId: string | null;
  sensitivity: string;
  updatedAt: string;
}

interface UpsertInput {
  connectorId?: string | null;
  connectorInstanceId?: string | null;
  record: AttentionRecord;
}

interface ListInput {
  connectorId?: string | null;
  connectorInstanceId?: string | null;
  limit?: number | null;
}

interface ExpireDueInput {
  connectorId?: string | null;
  connectorInstanceId?: string | null;
  limit?: number | null;
  now?: string | null;
}

interface TransitionInput {
  attentionId?: string | null;
  now?: string | null;
  to: string;
}

interface NotificationOutcomeInput {
  attentionId?: string | null;
  now?: string | null;
  outcome: string;
  reason?: string | null;
}

interface ReconcileTerminalRunsInput {
  limit?: number | null;
  now?: string | null;
}

export interface ConnectorAttentionStore {
  cancelOpenAttentionForTerminalRuns(input?: ReconcileTerminalRunsInput): Promise<AttentionRecord[]>;
  expireDueAttentionForConnection(input?: ExpireDueInput): Promise<AttentionRecord[]>;
  listOpenAttentionForConnection(input?: ListInput): Promise<(AttentionRecord | null)[]>;
  recordNotificationOutcomeById(input: NotificationOutcomeInput): Promise<AttentionRecord | null>;
  transitionAttention(input: TransitionInput): Promise<AttentionRecord | null>;
  upsertAttention(input: UpsertInput): Promise<AttentionRecord>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultConnectorInstanceId(connectorId: string): string {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureRecordShape(record: unknown): asserts record is AttentionRecord {
  if (!record || typeof record !== "object") {
    throw new Error("connector attention store: record must be an object");
  }
  const bag = record as Record<string, unknown>;
  const required = [
    "id",
    "dedupe_key",
    "connection_id",
    "reason_code",
    "lifecycle",
    "sensitivity",
    "created_at",
    "updated_at",
  ];
  for (const field of required) {
    if (typeof bag[field] !== "string" || !bag[field]) {
      throw new Error(`connector attention store: record.${field} is required`);
    }
  }
  if (!VALID_LIFECYCLES.has(bag.lifecycle as string)) {
    throw new Error(`connector attention store: invalid lifecycle ${bag.lifecycle}`);
  }
}

function rowToRecord(
  row: AttentionListRow | AttentionLifecycleRow | AttentionExpireRow | null | undefined
): AttentionRecord | null {
  if (!row) {
    return null;
  }
  const json = typeof row.record_json === "string" ? row.record_json : JSON.stringify(row.record_json);
  let parsed: AttentionRecord;
  try {
    parsed = JSON.parse(json) as AttentionRecord;
  } catch {
    const attentionId = "attention_id" in row ? row.attention_id : "";
    throw new Error(`connector attention store: malformed record_json for ${attentionId}`);
  }
  // The persisted record_json is authoritative for the AttentionRecord
  // shape; the column projections are duplicated for indexed predicates
  // only. Trust the column-side lifecycle for callers that want to filter
  // without parsing JSON, but return the parsed record verbatim so the
  // projection sees exactly what the writer redacted.
  return parsed;
}

function encodeUpsertArgs(record: AttentionRecord, connectorId: string, connectorInstanceId: string): UpsertArgs {
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

function clampLimit(limit: unknown): number {
  const raw = Number(limit);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIST_LIMIT));
}

function buildSqliteOpenPredicate(lifecycles: readonly string[]): string {
  const placeholders = lifecycles.map(() => "?").join(", ");
  return `lifecycle IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?)`;
}

function expiresAtOrBefore(expiresAt: string | null | undefined, now: string): boolean {
  const expiresMs = Date.parse(expiresAt as string);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiresMs) && Number.isFinite(nowMs) && expiresMs <= nowMs;
}

function expiredRecord(record: AttentionRecord | null, now: string): AttentionRecord {
  return {
    ...(record as AttentionRecord),
    lifecycle: "expired",
    updated_at: now,
  };
}

function cancelledRecord(record: AttentionRecord | null, now: string): AttentionRecord {
  return {
    ...(record as AttentionRecord),
    lifecycle: "cancelled",
    updated_at: now,
  };
}

const VALID_NOTIFICATION_STATES = new Set(["acknowledged", "failed", "pending", "sent", "suppressed"]);

function applyNotificationOutcomeToRecord(
  record: AttentionRecord,
  { outcome, reason, now }: { outcome: string; reason?: string | null | undefined; now: string }
): AttentionRecord {
  if (!VALID_NOTIFICATION_STATES.has(outcome)) {
    throw new Error(`recordNotificationOutcomeById: invalid outcome ${outcome}`);
  }
  const trimmedReason = nonEmptyString(reason);
  return {
    ...record,
    notification_state: outcome as NotificationState,
    notification_updated_at: now,
    notification_reason: trimmedReason,
  };
}

export function createSqliteConnectorAttentionStore(): ConnectorAttentionStore {
  return {
    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared ConnectorAttentionStore contract.
    async upsertAttention({ record, connectorId, connectorInstanceId }: UpsertInput): Promise<AttentionRecord> {
      const id = nonEmptyString(connectorId);
      if (!id) {
        throw new Error("upsertAttention: connectorId is required");
      }
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
        ]
      );
      return record;
    },

    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared ConnectorAttentionStore contract.
    async listOpenAttentionForConnection({
      connectorId,
      connectorInstanceId,
      limit,
    }: ListInput = {}): Promise<(AttentionRecord | null)[]> {
      const id = nonEmptyString(connectorId);
      if (!id) {
        throw new Error("listOpenAttentionForConnection: connectorId is required");
      }
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const bounded = clampLimit(limit);
      // REVIEWED-DYNAMIC: parameterized read over the store-owned table.
      // Bounded by `limit` (clamped to MAX_LIST_LIMIT) so a connection with
      // unusual attention churn cannot fan out the dashboard list call.
      const rows = [
        ...iterateDynamicSqlAcknowledged<AttentionListRow>(
          `SELECT attention_id, record_json
             FROM connector_attention_records
            WHERE connector_id = ?
              AND connector_instance_id = ?
              AND ${buildSqliteOpenPredicate(OPEN_LIFECYCLES)}
            ORDER BY updated_at DESC
            LIMIT ?`,
          [id, instance, ...OPEN_LIFECYCLES, nowIso(), bounded]
        ),
      ];
      return rows.map(rowToRecord);
    },

    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared ConnectorAttentionStore contract.
    async cancelOpenAttentionForTerminalRuns({
      now,
      limit,
    }: ReconcileTerminalRunsInput = {}): Promise<AttentionRecord[]> {
      const updatedAt = nonEmptyString(now) || nowIso();
      const bounded = clampLimit(limit ?? TERMINAL_RUN_ATTENTION_RECONCILE_LIMIT);
      const rows = [
        ...iterateDynamicSqlAcknowledged<AttentionListRow>(
          `SELECT attention_id, record_json
             FROM connector_attention_records AS attention
            WHERE attention.lifecycle IN (${OPEN_LIFECYCLES.map(() => "?").join(", ")})
              AND attention.run_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM spine_events AS terminal
                 WHERE terminal.run_id = attention.run_id
                   AND terminal.event_type IN (${TERMINAL_RUN_EVENT_TYPES.map(() => "?").join(", ")})
                 LIMIT 1
              )
            ORDER BY attention.updated_at DESC
            LIMIT ?`,
          [...OPEN_LIFECYCLES, ...TERMINAL_RUN_EVENT_TYPES, bounded]
        ),
      ];
      const cancelled: AttentionRecord[] = [];
      for (const row of rows) {
        const next = cancelledRecord(rowToRecord(row), updatedAt);
        execDynamicSqlAcknowledged(
          `UPDATE connector_attention_records
              SET lifecycle = ?, updated_at = ?, record_json = ?
            WHERE attention_id = ?`,
          ["cancelled", updatedAt, JSON.stringify(next), row.attention_id]
        );
        cancelled.push(next);
      }
      return cancelled;
    },

    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared ConnectorAttentionStore contract.
    async expireDueAttentionForConnection({
      connectorId,
      connectorInstanceId,
      now,
      limit,
    }: ExpireDueInput = {}): Promise<AttentionRecord[]> {
      const id = nonEmptyString(connectorId);
      if (!id) {
        throw new Error("expireDueAttentionForConnection: connectorId is required");
      }
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const updatedAt = nonEmptyString(now) || nowIso();
      const bounded = clampLimit(limit ?? EXPIRE_DUE_LIMIT);
      const rows = [
        ...iterateDynamicSqlAcknowledged<AttentionExpireRow>(
          `SELECT attention_id, record_json, expires_at
             FROM connector_attention_records
            WHERE connector_id = ?
              AND connector_instance_id = ?
              AND lifecycle IN (${OPEN_LIFECYCLES.map(() => "?").join(", ")})
              AND expires_at IS NOT NULL
              AND expires_at <= ?
            ORDER BY updated_at DESC
            LIMIT ?`,
          [id, instance, ...OPEN_LIFECYCLES, updatedAt, bounded]
        ),
      ];
      const expired: AttentionRecord[] = [];
      for (const row of rows) {
        if (!expiresAtOrBefore(row.expires_at, updatedAt)) {
          continue;
        }
        const next = expiredRecord(rowToRecord(row), updatedAt);
        execDynamicSqlAcknowledged(
          `UPDATE connector_attention_records
              SET lifecycle = ?, updated_at = ?, record_json = ?
            WHERE attention_id = ?`,
          ["expired", updatedAt, JSON.stringify(next), row.attention_id]
        );
        expired.push(next);
      }
      return expired;
    },

    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared ConnectorAttentionStore contract.
    async transitionAttention({ attentionId, to, now }: TransitionInput): Promise<AttentionRecord | null> {
      const id = nonEmptyString(attentionId);
      if (!id) {
        throw new Error("transitionAttention: attentionId is required");
      }
      if (!VALID_LIFECYCLES.has(to)) {
        throw new Error(`transitionAttention: invalid target lifecycle ${to}`);
      }
      const updatedAt = nonEmptyString(now) || nowIso();
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned table.
      const row = [
        ...iterateDynamicSqlAcknowledged<AttentionLifecycleRow>(
          "SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = ? LIMIT 1",
          [id]
        ),
      ][0];
      if (!row) {
        return null;
      }
      const current = row.lifecycle;
      if (TERMINAL_LIFECYCLES.has(current)) {
        throw new Error(`transitionAttention: ${id} is terminal (${current})`);
      }
      if (!ALLOWED_TRANSITIONS[current].has(to)) {
        throw new Error(`transitionAttention: invalid transition ${current} -> ${to} for ${id}`);
      }
      const record = rowToRecord(row) as AttentionRecord;
      const next: AttentionRecord = { ...record, lifecycle: to as AttentionLifecycle, updated_at: updatedAt };
      // REVIEWED-DYNAMIC: lifecycle mutation for the store-owned table.
      execDynamicSqlAcknowledged(
        `UPDATE connector_attention_records
            SET lifecycle = ?, updated_at = ?, record_json = ?
          WHERE attention_id = ?`,
        [to, updatedAt, JSON.stringify(next), id]
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
    // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared ConnectorAttentionStore contract.
    async recordNotificationOutcomeById({
      attentionId,
      outcome,
      reason,
      now,
    }: NotificationOutcomeInput): Promise<AttentionRecord | null> {
      const id = nonEmptyString(attentionId);
      if (!id) {
        throw new Error("recordNotificationOutcomeById: attentionId is required");
      }
      const updatedAt = nonEmptyString(now) || nowIso();
      // REVIEWED-DYNAMIC: single-row lookup for the store-owned table.
      const row = [
        ...iterateDynamicSqlAcknowledged<AttentionLifecycleRow>(
          "SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = ? LIMIT 1",
          [id]
        ),
      ][0];
      if (!row) {
        return null;
      }
      const record = rowToRecord(row) as AttentionRecord;
      const next = applyNotificationOutcomeToRecord(record, { outcome, reason, now: updatedAt });
      // REVIEWED-DYNAMIC: notification-axis mutation for the store-owned table.
      // `updated_at` and `lifecycle` columns are intentionally left as-is so
      // an external notification outcome does not look like a lifecycle event
      // to projection consumers that read the column shape.
      execDynamicSqlAcknowledged("UPDATE connector_attention_records SET record_json = ? WHERE attention_id = ?", [
        JSON.stringify(next),
        id,
      ]);
      return next;
    },
  };
}

export function createPostgresConnectorAttentionStore(): ConnectorAttentionStore {
  return {
    async upsertAttention({ record, connectorId, connectorInstanceId }: UpsertInput): Promise<AttentionRecord> {
      const id = nonEmptyString(connectorId);
      if (!id) {
        throw new Error("upsertAttention: connectorId is required");
      }
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
        ]
      );
      return record;
    },

    async listOpenAttentionForConnection({
      connectorId,
      connectorInstanceId,
      limit,
    }: ListInput = {}): Promise<(AttentionRecord | null)[]> {
      const id = nonEmptyString(connectorId);
      if (!id) {
        throw new Error("listOpenAttentionForConnection: connectorId is required");
      }
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const bounded = clampLimit(limit);
      const result = await postgresQuery(
        `SELECT attention_id, record_json
           FROM connector_attention_records
          WHERE connector_id = $1
            AND connector_instance_id = $2
            AND lifecycle = ANY($3::text[])
            AND (expires_at IS NULL OR expires_at > $4)
          ORDER BY updated_at DESC
          LIMIT $5`,
        [id, instance, OPEN_LIFECYCLES, nowIso(), bounded]
      );
      return (result.rows as AttentionListRow[]).map(rowToRecord);
    },

    async cancelOpenAttentionForTerminalRuns({
      now,
      limit,
    }: ReconcileTerminalRunsInput = {}): Promise<AttentionRecord[]> {
      const updatedAt = nonEmptyString(now) || nowIso();
      const bounded = clampLimit(limit ?? TERMINAL_RUN_ATTENTION_RECONCILE_LIMIT);
      const result = await postgresQuery(
        `SELECT attention.attention_id, attention.record_json
           FROM connector_attention_records AS attention
          WHERE attention.lifecycle = ANY($1::text[])
            AND attention.run_id IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM spine_events AS terminal
               WHERE terminal.run_id = attention.run_id
                 AND terminal.event_type = ANY($2::text[])
               LIMIT 1
            )
          ORDER BY attention.updated_at DESC
          LIMIT $3`,
        [OPEN_LIFECYCLES, TERMINAL_RUN_EVENT_TYPES, bounded]
      );
      const cancelled: AttentionRecord[] = [];
      for (const row of result.rows as AttentionListRow[]) {
        const next = cancelledRecord(rowToRecord(row), updatedAt);
        await postgresQuery(
          `UPDATE connector_attention_records
              SET lifecycle = $1, updated_at = $2, record_json = $3::jsonb
            WHERE attention_id = $4`,
          ["cancelled", updatedAt, JSON.stringify(next), row.attention_id]
        );
        cancelled.push(next);
      }
      return cancelled;
    },

    async expireDueAttentionForConnection({
      connectorId,
      connectorInstanceId,
      now,
      limit,
    }: ExpireDueInput = {}): Promise<AttentionRecord[]> {
      const id = nonEmptyString(connectorId);
      if (!id) {
        throw new Error("expireDueAttentionForConnection: connectorId is required");
      }
      const instance = nonEmptyString(connectorInstanceId) || defaultConnectorInstanceId(id);
      const updatedAt = nonEmptyString(now) || nowIso();
      const bounded = clampLimit(limit ?? EXPIRE_DUE_LIMIT);
      const result = await postgresQuery(
        `SELECT attention_id, record_json, expires_at
           FROM connector_attention_records
          WHERE connector_id = $1
            AND connector_instance_id = $2
            AND lifecycle = ANY($3::text[])
            AND expires_at IS NOT NULL
            AND expires_at <= $4
          ORDER BY updated_at DESC
          LIMIT $5`,
        [id, instance, OPEN_LIFECYCLES, updatedAt, bounded]
      );
      const expired: AttentionRecord[] = [];
      for (const row of result.rows as AttentionExpireRow[]) {
        if (!expiresAtOrBefore(row.expires_at, updatedAt)) {
          continue;
        }
        const next = expiredRecord(rowToRecord(row), updatedAt);
        await postgresQuery(
          `UPDATE connector_attention_records
              SET lifecycle = $1, updated_at = $2, record_json = $3::jsonb
            WHERE attention_id = $4`,
          ["expired", updatedAt, JSON.stringify(next), row.attention_id]
        );
        expired.push(next);
      }
      return expired;
    },

    async transitionAttention({ attentionId, to, now }: TransitionInput): Promise<AttentionRecord | null> {
      const id = nonEmptyString(attentionId);
      if (!id) {
        throw new Error("transitionAttention: attentionId is required");
      }
      if (!VALID_LIFECYCLES.has(to)) {
        throw new Error(`transitionAttention: invalid target lifecycle ${to}`);
      }
      const updatedAt = nonEmptyString(now) || nowIso();
      const lookup = await postgresQuery(
        "SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = $1",
        [id]
      );
      const row = lookup.rows[0] as AttentionLifecycleRow | undefined;
      if (!row) {
        return null;
      }
      const current = row.lifecycle;
      if (TERMINAL_LIFECYCLES.has(current)) {
        throw new Error(`transitionAttention: ${id} is terminal (${current})`);
      }
      if (!ALLOWED_TRANSITIONS[current].has(to)) {
        throw new Error(`transitionAttention: invalid transition ${current} -> ${to} for ${id}`);
      }
      const record = rowToRecord(row) as AttentionRecord;
      const next: AttentionRecord = { ...record, lifecycle: to as AttentionLifecycle, updated_at: updatedAt };
      await postgresQuery(
        `UPDATE connector_attention_records
            SET lifecycle = $1, updated_at = $2, record_json = $3::jsonb
          WHERE attention_id = $4`,
        [to, updatedAt, JSON.stringify(next), id]
      );
      return next;
    },

    async recordNotificationOutcomeById({
      attentionId,
      outcome,
      reason,
      now,
    }: NotificationOutcomeInput): Promise<AttentionRecord | null> {
      const id = nonEmptyString(attentionId);
      if (!id) {
        throw new Error("recordNotificationOutcomeById: attentionId is required");
      }
      const updatedAt = nonEmptyString(now) || nowIso();
      const lookup = await postgresQuery(
        "SELECT record_json, lifecycle FROM connector_attention_records WHERE attention_id = $1",
        [id]
      );
      const row = lookup.rows[0] as AttentionLifecycleRow | undefined;
      if (!row) {
        return null;
      }
      const record = rowToRecord(row) as AttentionRecord;
      const next = applyNotificationOutcomeToRecord(record, { outcome, reason, now: updatedAt });
      await postgresQuery("UPDATE connector_attention_records SET record_json = $1::jsonb WHERE attention_id = $2", [
        JSON.stringify(next),
        id,
      ]);
      return next;
    },
  };
}

export function createConnectorAttentionStore(): ConnectorAttentionStore {
  return isPostgresStorageBackend() ? createPostgresConnectorAttentionStore() : createSqliteConnectorAttentionStore();
}

let defaultStore: ConnectorAttentionStore | null = null;
let defaultBackend: string | null = null;

export function getDefaultConnectorAttentionStore(): ConnectorAttentionStore {
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
export function resetDefaultConnectorAttentionStoreCache(): void {
  defaultStore = null;
  defaultBackend = null;
}

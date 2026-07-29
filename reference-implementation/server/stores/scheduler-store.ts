// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// SchedulerStore — production storage interface for the connector
// schedule registry and the controller-managed active-run registry.
//
// The surface is deliberately *semantic*: it speaks in lifecycle terms
// (`createSchedule`, `setScheduleEnabled`, `upsertActiveRun`,
// `listActiveRuns`) and returns domain records, not SQLite rows. Callers
// see `enabled: boolean`, never the underlying `0 | 1` integer column,
// and never see registered query keys, prepared statements, or `getDb()`.
//
// Behavior preserved verbatim from the controller helpers being replaced:
//   - One schedule row per connector instance with semantic fields
//     (interval_seconds, jitter_seconds, enabled, created_at, updated_at).
//   - `enabled` round-trips as a boolean across the public surface; the
//     SQLite-flavored 0/1 conversion lives inside this module.
//   - Active-run records are one per connector instance with `run_id` unique
//     across the registry; `upsertActiveRun` fails closed on
//     connector-instance collisions and preserves the incumbent row rather
//     than replacing it.
//
// Spine reconciliation, in-memory `activeRuns` projections, and the
// `wasRunMarkedFailed` accessor stay in the controller. The store is
// the persistence seam only.

import {
  allowUnboundedReadAcknowledged,
  exec,
  getMany,
  getOne,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
} from "../../lib/db.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

// ─── Domain records (public, semantic) ──────────────────────────────────────

export interface ScheduleRecord {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly created_at: string;
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ScheduleCreate {
  readonly connector_id: string;
  readonly connector_instance_id?: string;
  readonly created_at: string;
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ScheduleUpdate {
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ActiveRunRecord {
  readonly connector_id: string;
  readonly connector_instance_id?: string;
  readonly run_generation: number;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface SchedulerRunHistoryRecord {
  readonly attempt: number;
  readonly checkpointSummary: Record<string, unknown> | null;
  readonly completedAt: string;
  readonly connectorError?: Record<string, unknown> | null;
  readonly connectorId: string;
  readonly connectorInstanceId?: string | null;
  readonly error?: string;
  readonly failureReason?: string | null;
  readonly knownGaps: readonly Record<string, unknown>[];
  readonly recordsEmitted: number;
  readonly reportedRecordsEmitted?: number | null;
  readonly runId?: string | null;
  readonly source: Record<string, unknown>;
  readonly startedAt: string;
  readonly status: "cancelled" | "failed" | "skipped" | "succeeded";
  readonly terminalReason?: string | null;
  readonly traceId?: string | null;
}

export interface SchedulerLastRunTimeRecord {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly last_run_time_ms: number;
  readonly updated_at: string;
}

// ─── Public store surface ───────────────────────────────────────────────────

export interface SchedulerStore {
  // Scheduler run history + interval gate timestamps.
  appendRunHistory: (record: SchedulerRunHistoryRecord) => Promise<void> | void;

  // Schedule registry — semantic lifecycle verbs.
  createSchedule: (record: ScheduleCreate) => Promise<void> | void;

  // Active-run registry — semantic lifecycle verbs.
  deleteActiveRun: (connectorInstanceId: string, runId: string) => Promise<void> | void;
  deleteSchedule: (connectorInstanceId: string) => Promise<void> | void;
  getActiveRun: (connectorInstanceId: string) => Promise<ActiveRunRecord | null> | ActiveRunRecord | null;
  getLatestRunHistoryForConnection: (
    connectorInstanceId: string,
    status?: string | null
  ) => Promise<SchedulerRunHistoryRecord | null> | SchedulerRunHistoryRecord | null;
  getSchedule: (connectorInstanceId: string) => Promise<ScheduleRecord | null> | ScheduleRecord | null;
  listActiveRuns: () => Promise<readonly ActiveRunRecord[]> | readonly ActiveRunRecord[];
  listLastRunTimes: () => Promise<readonly SchedulerLastRunTimeRecord[]> | readonly SchedulerLastRunTimeRecord[];
  listLastRunTimesByConnectionIds?: (
    connectorInstanceIds: readonly string[]
  ) => Promise<readonly SchedulerLastRunTimeRecord[]> | readonly SchedulerLastRunTimeRecord[];
  listLatestRunHistoryByConnectionIds?: (
    connectorInstanceIds: readonly string[],
    status?: string | null
  ) => Promise<readonly SchedulerRunHistoryRecord[]> | readonly SchedulerRunHistoryRecord[];
  listRunHistory: (
    limit: number
  ) => Promise<readonly SchedulerRunHistoryRecord[]> | readonly SchedulerRunHistoryRecord[];
  listSchedules: () => Promise<readonly ScheduleRecord[]> | readonly ScheduleRecord[];
  listSchedulesByConnectionIds?: (
    connectorInstanceIds: readonly string[]
  ) => Promise<readonly ScheduleRecord[]> | readonly ScheduleRecord[];
  setScheduleEnabled: (connectorInstanceId: string, enabled: boolean, updatedAt: string) => Promise<void> | void;
  updateSchedule: (connectorInstanceId: string, patch: ScheduleUpdate) => Promise<void> | void;
  upsertActiveRun: (record: ActiveRunRecord) => Promise<boolean> | boolean;
  upsertLastRunTime: (
    connectorInstanceId: string,
    lastRunTimeMs: number,
    updatedAt: string,
    connectorId?: string
  ) => Promise<void> | void;
}

// SQLite's variable limit is configurable. Keep the page batch well below its
// historical 999 floor so a future query can add a small fixed bind set without
// coupling correctness to a deployment-specific compile option.
const SQLITE_CONNECTION_ID_BATCH_SIZE = 900;
// The summary page contract caps identity pages at 100. Keep PostgreSQL arrays
// at that accepted bound even if a future caller supplies a larger set.
const POSTGRES_CONNECTION_ID_BATCH_SIZE = 100;

function uniqueConnectionIds(connectorInstanceIds: readonly string[]): readonly string[] {
  return [...new Set(connectorInstanceIds)];
}

function connectionIdChunks(connectorInstanceIds: readonly string[]): readonly (readonly string[])[] {
  return connectionIdChunksOfSize(connectorInstanceIds, SQLITE_CONNECTION_ID_BATCH_SIZE);
}

function connectionIdChunksOfSize(
  connectorInstanceIds: readonly string[],
  chunkSize: number
): readonly (readonly string[])[] {
  const ids = uniqueConnectionIds(connectorInstanceIds);
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }
  return chunks;
}

function sqliteMembershipPlaceholders(ids: readonly string[]): string {
  return ids.map(() => "?").join(", ");
}

const SCHEDULER_RUN_HISTORY_COLUMNS = `
  id,
  connector_instance_id,
  connector_id,
  source_json,
  status,
  records_emitted,
  reported_records_emitted,
  checkpoint_summary_json,
  known_gaps_json,
  connector_error_json,
  run_id,
  trace_id,
  failure_reason,
  terminal_reason,
  started_at,
  completed_at,
  error,
  attempt`;

// ─── SQLite implementation ──────────────────────────────────────────────────

interface ScheduleSqliteRow {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly created_at: string;
  readonly enabled: 0 | 1 | boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

interface SchedulerRunHistoryRow extends Record<string, unknown> {
  readonly attempt: number;
  readonly checkpoint_summary_json: unknown;
  readonly completed_at: string;
  readonly connector_error_json: unknown;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly error: string | null;
  readonly failure_reason: string | null;
  readonly known_gaps_json: unknown;
  readonly records_emitted: number;
  readonly reported_records_emitted: number | null;
  readonly run_id: string | null;
  readonly source_json: unknown;
  readonly started_at: string;
  readonly status: "cancelled" | "failed" | "skipped" | "succeeded";
  readonly terminal_reason: string | null;
  readonly trace_id: string | null;
}

function rowToScheduleRecord(row: ScheduleSqliteRow): ScheduleRecord {
  return {
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id,
    created_at: row.created_at,
    enabled: row.enabled === true || row.enabled === 1,
    interval_seconds: row.interval_seconds,
    jitter_seconds: row.jitter_seconds,
    updated_at: row.updated_at,
  };
}

function parseJsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asObjectArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)
  );
}

function rowToRunHistoryRecord(row: SchedulerRunHistoryRow): SchedulerRunHistoryRecord {
  const record: SchedulerRunHistoryRecord = {
    attempt: row.attempt,
    checkpointSummary: asObjectOrNull(parseJsonValue(row.checkpoint_summary_json, null)),
    completedAt: row.completed_at,
    connectorError: asObjectOrNull(parseJsonValue(row.connector_error_json, null)),
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    failureReason: row.failure_reason,
    knownGaps: asObjectArray(parseJsonValue(row.known_gaps_json, [])),
    recordsEmitted: row.records_emitted,
    reportedRecordsEmitted: row.reported_records_emitted,
    runId: row.run_id,
    source: asObjectOrNull(parseJsonValue(row.source_json, {})) ?? {},
    startedAt: row.started_at,
    status: row.status,
    terminalReason: row.terminal_reason,
    traceId: row.trace_id,
  };
  return row.error === null ? record : { ...record, error: row.error };
}

function serializeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function createSqliteSchedulerStore(): SchedulerStore {
  return {
    appendRunHistory(record) {
      const connectorInstanceId = record.connectorInstanceId ?? record.connectorId;
      exec(referenceQueries.controllerInsertSchedulerRunHistory, [
        connectorInstanceId,
        record.connectorId,
        JSON.stringify(record.source),
        record.status,
        record.recordsEmitted,
        record.reportedRecordsEmitted ?? null,
        serializeJson(record.checkpointSummary ?? null),
        JSON.stringify(record.knownGaps),
        serializeJson(record.connectorError ?? null),
        record.runId ?? null,
        record.traceId ?? null,
        record.failureReason ?? null,
        record.terminalReason ?? null,
        record.startedAt,
        record.completedAt,
        record.error ?? null,
        record.attempt,
      ]);
    },

    createSchedule(record) {
      const connectorInstanceId = record.connector_instance_id ?? record.connector_id;
      exec(referenceQueries.controllerInsertSchedule, [
        connectorInstanceId,
        record.connector_id,
        record.interval_seconds,
        record.jitter_seconds,
        record.enabled ? 1 : 0,
        record.created_at,
        record.updated_at,
      ]);
    },

    deleteActiveRun(connectorInstanceId, runId) {
      exec(referenceQueries.controllerDeleteActiveRun, [runId, connectorInstanceId, connectorInstanceId]);
    },

    deleteSchedule(connectorInstanceId) {
      exec(referenceQueries.controllerDeleteSchedule, [connectorInstanceId]);
    },

    getActiveRun(connectorInstanceId) {
      const rows = allowUnboundedReadAcknowledged<ActiveRunRecord>(referenceQueries.controllerListActiveRuns);
      const found = rows.find((row) => (row.connector_instance_id ?? row.connector_id) === connectorInstanceId);
      return found ?? null;
    },

    getLatestRunHistoryForConnection(connectorInstanceId, status = null) {
      const row = getOne<SchedulerRunHistoryRow>(referenceQueries.controllerGetLatestSchedulerRunHistoryForConnection, [
        connectorInstanceId,
        status,
        status,
      ]);
      return row ? rowToRunHistoryRecord(row) : null;
    },

    getSchedule(connectorInstanceId) {
      const row = getOne<ScheduleSqliteRow>(referenceQueries.controllerGetScheduleByConnector, [connectorInstanceId]);
      return row ? rowToScheduleRecord(row) : null;
    },

    listActiveRuns() {
      // REVIEWED-BOUNDED: at most one row per configured connector instance.
      return allowUnboundedReadAcknowledged<ActiveRunRecord>(referenceQueries.controllerListActiveRuns);
    },

    listLastRunTimes() {
      return allowUnboundedReadAcknowledged<SchedulerLastRunTimeRecord>(
        referenceQueries.controllerListSchedulerLastRunTimes
      );
    },

    listLastRunTimesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerLastRunTimeRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; membership is a
        // page-scoped, fixed-fragment IN list with every connection id bound.
        rows.push(
          ...iterateDynamicSqlAcknowledged<SchedulerLastRunTimeRecord>(
            `SELECT connector_instance_id, connector_id, last_run_time_ms, updated_at
             FROM scheduler_last_run_times
             WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
             ORDER BY connector_id ASC, connector_instance_id ASC`,
            ids
          )
        );
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    listLatestRunHistoryByConnectionIds(connectorInstanceIds, status = null) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; this ranks one
        // terminal/skip history row per bound page connection id.
        rows.push(
          ...[
            ...iterateDynamicSqlAcknowledged<SchedulerRunHistoryRow>(
              `SELECT ${SCHEDULER_RUN_HISTORY_COLUMNS}
             FROM (
               SELECT ${SCHEDULER_RUN_HISTORY_COLUMNS},
                 ROW_NUMBER() OVER (
                   PARTITION BY connector_instance_id
                   ORDER BY completed_at DESC, id DESC
                 ) AS row_rank
               FROM scheduler_run_history
               WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
                 AND (? IS NULL OR status = ?)
            ) ranked
             WHERE row_rank = 1
             ORDER BY connector_id ASC, connector_instance_id ASC`,
              [...ids, status, status]
            ),
          ].map(rowToRunHistoryRecord)
        );
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    listRunHistory(limit) {
      return getMany<SchedulerRunHistoryRow>(referenceQueries.controllerListSchedulerRunHistory, [], {
        limit,
      }).rows.map(rowToRunHistoryRecord);
    },

    listSchedules() {
      // REVIEWED-BOUNDED: connector_schedules holds at most one row per
      // configured connector instance; scan is bounded by instance count.
      const rows = allowUnboundedReadAcknowledged<ScheduleSqliteRow>(referenceQueries.controllerListSchedules);
      return rows.map(rowToScheduleRecord);
    },

    listSchedulesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunks(connectorInstanceIds);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ScheduleRecord[] = [];
      for (const ids of chunks) {
        // REVIEWED-DYNAMIC: SQLite has no bound array type; membership is a
        // page-scoped, fixed-fragment IN list with every connection id bound.
        rows.push(
          ...[
            ...iterateDynamicSqlAcknowledged<ScheduleSqliteRow>(
              `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
             FROM connector_schedules
             WHERE connector_instance_id IN (${sqliteMembershipPlaceholders(ids)})
             ORDER BY connector_id ASC, connector_instance_id ASC`,
              ids
            ),
          ].map(rowToScheduleRecord)
        );
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    setScheduleEnabled(connectorInstanceId, enabled, updatedAt) {
      exec(referenceQueries.controllerUpdateScheduleEnabled, [enabled ? 1 : 0, updatedAt, connectorInstanceId]);
    },

    updateSchedule(connectorInstanceId, patch) {
      exec(referenceQueries.controllerUpdateSchedule, [
        patch.interval_seconds,
        patch.jitter_seconds,
        patch.enabled ? 1 : 0,
        patch.updated_at,
        connectorInstanceId,
      ]);
    },

    upsertActiveRun(record) {
      // Fail closed: a live row already present for the connector instance
      // must preserve the incumbent row rather than replacing it.
      const result = exec(referenceQueries.controllerUpsertActiveRun, [
        record.connector_instance_id ?? record.connector_id,
        record.connector_id,
        record.run_id,
        record.trace_id,
        record.scenario_id,
        record.started_at,
        record.run_generation,
      ]);
      return result.changes > 0;
    },

    upsertLastRunTime(connectorInstanceId, lastRunTimeMs, updatedAt, connectorId = connectorInstanceId) {
      exec(referenceQueries.controllerUpsertSchedulerLastRunTime, [
        connectorInstanceId,
        connectorId,
        lastRunTimeMs,
        updatedAt,
      ]);
    },
  };
}

export function createPostgresSchedulerStore(): SchedulerStore {
  return {
    async appendRunHistory(record) {
      const connectorInstanceId = record.connectorInstanceId ?? record.connectorId;
      await postgresQuery(
        `INSERT INTO scheduler_run_history(
           connector_instance_id,
           connector_id,
           source_json,
           status,
           records_emitted,
           reported_records_emitted,
           checkpoint_summary_json,
           known_gaps_json,
           connector_error_json,
           run_id,
           trace_id,
           failure_reason,
           terminal_reason,
           started_at,
           completed_at,
           error,
           attempt
         ) VALUES($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          connectorInstanceId,
          record.connectorId,
          JSON.stringify(record.source),
          record.status,
          record.recordsEmitted,
          record.reportedRecordsEmitted ?? null,
          serializeJson(record.checkpointSummary ?? null),
          JSON.stringify(record.knownGaps),
          serializeJson(record.connectorError ?? null),
          record.runId ?? null,
          record.traceId ?? null,
          record.failureReason ?? null,
          record.terminalReason ?? null,
          record.startedAt,
          record.completedAt,
          record.error ?? null,
          record.attempt,
        ]
      );
    },

    async createSchedule(record) {
      const connectorInstanceId = record.connector_instance_id ?? record.connector_id;
      await postgresQuery(
        `INSERT INTO connector_schedules(
           connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [
          connectorInstanceId,
          record.connector_id,
          record.interval_seconds,
          record.jitter_seconds,
          record.enabled,
          record.created_at,
          record.updated_at,
        ]
      );
    },

    async deleteActiveRun(connectorInstanceId, runId) {
      await postgresQuery(
        `DELETE FROM controller_active_runs
         WHERE run_id = $1
           AND (
             connector_instance_id = $2
             OR (connector_instance_id IS NULL AND connector_id = $2)
           )`,
        [runId, connectorInstanceId]
      );
    },

    async deleteSchedule(connectorInstanceId) {
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
    },

    async getActiveRun(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
         FROM controller_active_runs
         WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      return result.rows[0] ? (result.rows[0] as ActiveRunRecord) : null;
    },

    async getLatestRunHistoryForConnection(connectorInstanceId, status = null) {
      const result = await postgresQuery(
        `SELECT
           id,
           connector_instance_id,
           connector_id,
           source_json,
           status,
           records_emitted,
           reported_records_emitted,
           checkpoint_summary_json,
           known_gaps_json,
           connector_error_json,
           run_id,
           trace_id,
           failure_reason,
           terminal_reason,
           started_at,
           completed_at,
           error,
           attempt
         FROM scheduler_run_history
         WHERE connector_instance_id = $1
           AND ($2::text IS NULL OR status = $2)
         ORDER BY completed_at DESC, id DESC
         LIMIT 1`,
        [connectorInstanceId, status]
      );
      return result.rows[0] ? rowToRunHistoryRecord(result.rows[0] as SchedulerRunHistoryRow) : null;
    },

    async getSchedule(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         FROM connector_schedules
         WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      return result.rows[0] ? rowToScheduleRecord(result.rows[0] as ScheduleSqliteRow) : null;
    },

    async listActiveRuns() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
         FROM controller_active_runs
         ORDER BY connector_id, connector_instance_id`
      );
      return result.rows as ActiveRunRecord[];
    },

    async listLastRunTimes() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, last_run_time_ms, updated_at
         FROM scheduler_last_run_times
         ORDER BY connector_id, connector_instance_id`
      );
      return result.rows as SchedulerLastRunTimeRecord[];
    },

    async listLastRunTimesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerLastRunTimeRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `SELECT times.connector_instance_id, times.connector_id, times.last_run_time_ms, times.updated_at
         FROM unnest($1::text[]) AS input(connector_instance_id)
         JOIN scheduler_last_run_times AS times USING (connector_instance_id)
         ORDER BY times.connector_id ASC, times.connector_instance_id ASC`,
          [ids]
        );
        rows.push(
          ...(result.rows as SchedulerLastRunTimeRecord[]).map((row) => ({
            ...row,
            last_run_time_ms: Number(row.last_run_time_ms),
          }))
        );
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    async listLatestRunHistoryByConnectionIds(connectorInstanceIds, status = null) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: SchedulerRunHistoryRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `WITH scoped_history AS (
           SELECT history.id,
                  history.connector_instance_id,
                  history.connector_id,
                  history.source_json,
                  history.status,
                  history.records_emitted,
                  history.reported_records_emitted,
                  history.checkpoint_summary_json,
                  history.known_gaps_json,
                  history.connector_error_json,
                  history.run_id,
                  history.trace_id,
                  history.failure_reason,
                  history.terminal_reason,
                  history.started_at,
                  history.completed_at,
                  history.error,
                  history.attempt,
                  ROW_NUMBER() OVER (
                    PARTITION BY history.connector_instance_id
                    ORDER BY history.completed_at DESC, history.id DESC
                  ) AS row_rank
           FROM unnest($1::text[]) AS input(connector_instance_id)
           JOIN scheduler_run_history AS history USING (connector_instance_id)
           WHERE $2::text IS NULL OR history.status = $2
         )
         SELECT ${SCHEDULER_RUN_HISTORY_COLUMNS}
         FROM scoped_history
         WHERE row_rank = 1
         ORDER BY connector_id ASC, connector_instance_id ASC`,
          [ids, status]
        );
        rows.push(...(result.rows as SchedulerRunHistoryRow[]).map(rowToRunHistoryRecord));
      }
      return rows.sort(
        (left, right) =>
          left.connectorId.localeCompare(right.connectorId) ||
          (left.connectorInstanceId ?? left.connectorId).localeCompare(right.connectorInstanceId ?? right.connectorId)
      );
    },

    async listRunHistory(limit) {
      const boundedLimit = Math.max(1, Math.min(5000, Math.trunc(limit)));
      const result = await postgresQuery(
        `SELECT
           id,
           connector_instance_id,
           connector_id,
           source_json,
           status,
           records_emitted,
           reported_records_emitted,
           checkpoint_summary_json,
           known_gaps_json,
           connector_error_json,
           run_id,
           trace_id,
           failure_reason,
           terminal_reason,
           started_at,
           completed_at,
           error,
           attempt
         FROM (
           SELECT *
           FROM scheduler_run_history
           ORDER BY completed_at DESC, id DESC
           LIMIT $1
         ) rows
         ORDER BY completed_at ASC, id ASC`,
        [boundedLimit]
      );
      return (result.rows as SchedulerRunHistoryRow[]).map(rowToRunHistoryRecord);
    },

    async listSchedules() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         FROM connector_schedules
         ORDER BY connector_id, connector_instance_id`
      );
      return (result.rows as ScheduleSqliteRow[]).map(rowToScheduleRecord);
    },

    async listSchedulesByConnectionIds(connectorInstanceIds) {
      const chunks = connectionIdChunksOfSize(connectorInstanceIds, POSTGRES_CONNECTION_ID_BATCH_SIZE);
      if (chunks.length === 0) {
        return [];
      }
      const rows: ScheduleRecord[] = [];
      for (const ids of chunks) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded chunks preserve deterministic result order.
        const result = await postgresQuery(
          `SELECT schedules.connector_instance_id, schedules.connector_id,
                schedules.interval_seconds, schedules.jitter_seconds, schedules.enabled,
                schedules.created_at, schedules.updated_at
         FROM unnest($1::text[]) AS input(connector_instance_id)
         JOIN connector_schedules AS schedules USING (connector_instance_id)
         ORDER BY schedules.connector_id ASC, schedules.connector_instance_id ASC`,
          [ids]
        );
        rows.push(...(result.rows as ScheduleSqliteRow[]).map(rowToScheduleRecord));
      }
      return rows.sort(
        (left, right) =>
          left.connector_id.localeCompare(right.connector_id) ||
          left.connector_instance_id.localeCompare(right.connector_instance_id)
      );
    },

    async setScheduleEnabled(connectorInstanceId, enabled, updatedAt) {
      await postgresQuery(
        `UPDATE connector_schedules
         SET enabled = $1,
             updated_at = $2
         WHERE connector_instance_id = $3`,
        [enabled, updatedAt, connectorInstanceId]
      );
    },

    async updateSchedule(connectorInstanceId, patch) {
      await postgresQuery(
        `UPDATE connector_schedules
         SET interval_seconds = $1,
             jitter_seconds = $2,
             enabled = $3,
             updated_at = $4
         WHERE connector_instance_id = $5`,
        [patch.interval_seconds, patch.jitter_seconds, patch.enabled, patch.updated_at, connectorInstanceId]
      );
    },

    async upsertActiveRun(record) {
      const result = await postgresQuery(
        `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
         VALUES($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (connector_instance_id) DO NOTHING`,
        [
          record.connector_instance_id ?? record.connector_id,
          record.connector_id,
          record.run_id,
          record.trace_id,
          record.scenario_id,
          record.started_at,
          record.run_generation,
        ]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async upsertLastRunTime(connectorInstanceId, lastRunTimeMs, updatedAt, connectorId = connectorInstanceId) {
      await postgresQuery(
        `INSERT INTO scheduler_last_run_times(connector_instance_id, connector_id, last_run_time_ms, updated_at)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(connector_instance_id) DO UPDATE SET
           connector_id = EXCLUDED.connector_id,
           last_run_time_ms = EXCLUDED.last_run_time_ms,
           updated_at = EXCLUDED.updated_at`,
        [connectorInstanceId, connectorId, lastRunTimeMs, updatedAt]
      );
    },
  };
}

export function createSchedulerStore(): SchedulerStore {
  return isPostgresStorageBackend() ? createPostgresSchedulerStore() : createSqliteSchedulerStore();
}

let defaultStore: SchedulerStore | null = null;
let defaultStoreBackend: string | null = null;

export function getDefaultSchedulerStore(): SchedulerStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultStoreBackend !== backend) {
    defaultStore = createSchedulerStore();
    defaultStoreBackend = backend;
  }
  return defaultStore;
}

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
//     across the registry; `upsertActiveRun` resolves connector-instance
//     collisions, while a duplicate `run_id` raises a unique-constraint error.
//
// Spine reconciliation, in-memory `activeRuns` projections, and the
// `wasRunMarkedFailed` accessor stay in the controller. The store is
// the persistence seam only.

import { allowUnboundedReadAcknowledged, exec, getMany, getOne, referenceQueries } from "../../lib/db.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";

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
  readonly status: "failed" | "skipped" | "succeeded";
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
  appendRunHistory(record: SchedulerRunHistoryRecord): Promise<void> | void;

  // Schedule registry — semantic lifecycle verbs.
  createSchedule(record: ScheduleCreate): Promise<void> | void;

  // Active-run registry — semantic lifecycle verbs.
  deleteActiveRun(connectorInstanceId: string, runId: string): Promise<void> | void;
  deleteSchedule(connectorInstanceId: string): Promise<void> | void;
  getSchedule(connectorInstanceId: string): Promise<ScheduleRecord | null> | ScheduleRecord | null;
  listActiveRuns(): Promise<readonly ActiveRunRecord[]> | readonly ActiveRunRecord[];
  listLastRunTimes(): Promise<readonly SchedulerLastRunTimeRecord[]> | readonly SchedulerLastRunTimeRecord[];
  listRunHistory(limit: number): Promise<readonly SchedulerRunHistoryRecord[]> | readonly SchedulerRunHistoryRecord[];
  listSchedules(): Promise<readonly ScheduleRecord[]> | readonly ScheduleRecord[];
  setScheduleEnabled(connectorInstanceId: string, enabled: boolean, updatedAt: string): Promise<void> | void;
  updateSchedule(connectorInstanceId: string, patch: ScheduleUpdate): Promise<void> | void;
  upsertActiveRun(record: ActiveRunRecord): Promise<void> | void;
  upsertLastRunTime(
    connectorInstanceId: string,
    lastRunTimeMs: number,
    updatedAt: string,
    connectorId?: string
  ): Promise<void> | void;
}

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
  readonly status: "failed" | "skipped" | "succeeded";
  readonly terminal_reason: string | null;
  readonly trace_id: string | null;
}

function rowToScheduleRecord(row: ScheduleSqliteRow): ScheduleRecord {
  return {
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    interval_seconds: row.interval_seconds,
    jitter_seconds: row.jitter_seconds,
    enabled: row.enabled === true || row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonValue(value: unknown, fallback: unknown): unknown {
  if (value == null) {
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
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    source: asObjectOrNull(parseJsonValue(row.source_json, {})) ?? {},
    status: row.status,
    recordsEmitted: row.records_emitted,
    reportedRecordsEmitted: row.reported_records_emitted,
    checkpointSummary: asObjectOrNull(parseJsonValue(row.checkpoint_summary_json, null)),
    knownGaps: asObjectArray(parseJsonValue(row.known_gaps_json, [])),
    connectorError: asObjectOrNull(parseJsonValue(row.connector_error_json, null)),
    runId: row.run_id,
    traceId: row.trace_id,
    failureReason: row.failure_reason,
    terminalReason: row.terminal_reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    attempt: row.attempt,
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

    listRunHistory(limit) {
      return getMany<SchedulerRunHistoryRow>(referenceQueries.controllerListSchedulerRunHistory, [], {
        limit,
      }).rows.map(rowToRunHistoryRecord);
    },

    listLastRunTimes() {
      return allowUnboundedReadAcknowledged<SchedulerLastRunTimeRecord>(
        referenceQueries.controllerListSchedulerLastRunTimes
      );
    },

    upsertLastRunTime(connectorInstanceId, lastRunTimeMs, updatedAt, connectorId = connectorInstanceId) {
      exec(referenceQueries.controllerUpsertSchedulerLastRunTime, [
        connectorInstanceId,
        connectorId,
        lastRunTimeMs,
        updatedAt,
      ]);
    },

    getSchedule(connectorInstanceId) {
      const row = getOne<ScheduleSqliteRow>(referenceQueries.controllerGetScheduleByConnector, [connectorInstanceId]);
      return row ? rowToScheduleRecord(row) : null;
    },

    listSchedules() {
      // REVIEWED-BOUNDED: connector_schedules holds at most one row per
      // configured connector instance; scan is bounded by instance count.
      const rows = allowUnboundedReadAcknowledged<ScheduleSqliteRow>(referenceQueries.controllerListSchedules);
      return rows.map(rowToScheduleRecord);
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

    updateSchedule(connectorInstanceId, patch) {
      exec(referenceQueries.controllerUpdateSchedule, [
        patch.interval_seconds,
        patch.jitter_seconds,
        patch.enabled ? 1 : 0,
        patch.updated_at,
        connectorInstanceId,
      ]);
    },

    setScheduleEnabled(connectorInstanceId, enabled, updatedAt) {
      exec(referenceQueries.controllerUpdateScheduleEnabled, [enabled ? 1 : 0, updatedAt, connectorInstanceId]);
    },

    deleteSchedule(connectorInstanceId) {
      exec(referenceQueries.controllerDeleteSchedule, [connectorInstanceId]);
    },

    upsertActiveRun(record) {
      // The reference query is INSERT ... ON CONFLICT(connector_instance_id)
      // DO UPDATE; collisions on the instance key are resolved as upserts.
      // Collisions on `run_id` (a separate UNIQUE constraint) raise the
      // engine's unique-constraint error — preserved here intentionally.
      exec(referenceQueries.controllerUpsertActiveRun, [
        record.connector_instance_id ?? record.connector_id,
        record.connector_id,
        record.run_id,
        record.trace_id,
        record.scenario_id,
        record.started_at,
        record.run_generation,
      ]);
    },

    listActiveRuns() {
      // REVIEWED-BOUNDED: at most one row per configured connector instance.
      return allowUnboundedReadAcknowledged<ActiveRunRecord>(referenceQueries.controllerListActiveRuns);
    },

    deleteActiveRun(connectorInstanceId, runId) {
      exec(referenceQueries.controllerDeleteActiveRun, [runId, connectorInstanceId, connectorInstanceId]);
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

    async listLastRunTimes() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, last_run_time_ms, updated_at
         FROM scheduler_last_run_times
         ORDER BY connector_id, connector_instance_id`
      );
      return result.rows as SchedulerLastRunTimeRecord[];
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

    async getSchedule(connectorInstanceId) {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         FROM connector_schedules
         WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      return result.rows[0] ? rowToScheduleRecord(result.rows[0] as ScheduleSqliteRow) : null;
    },

    async listSchedules() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
         FROM connector_schedules
         ORDER BY connector_id, connector_instance_id`
      );
      return (result.rows as ScheduleSqliteRow[]).map(rowToScheduleRecord);
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

    async setScheduleEnabled(connectorInstanceId, enabled, updatedAt) {
      await postgresQuery(
        `UPDATE connector_schedules
         SET enabled = $1,
             updated_at = $2
         WHERE connector_instance_id = $3`,
        [enabled, updatedAt, connectorInstanceId]
      );
    },

    async deleteSchedule(connectorInstanceId) {
      await postgresQuery("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorInstanceId]);
    },

    async upsertActiveRun(record) {
      await postgresQuery(
        `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
         VALUES($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (connector_instance_id) DO UPDATE
           SET connector_id = EXCLUDED.connector_id,
               run_id = EXCLUDED.run_id,
               trace_id = EXCLUDED.trace_id,
               scenario_id = EXCLUDED.scenario_id,
               started_at = EXCLUDED.started_at,
               run_generation = EXCLUDED.run_generation`,
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
    },

    async listActiveRuns() {
      const result = await postgresQuery(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
         FROM controller_active_runs
         ORDER BY connector_id, connector_instance_id`
      );
      return result.rows as ActiveRunRecord[];
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

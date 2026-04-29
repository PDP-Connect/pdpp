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
//   - One schedule row per connector with semantic fields
//     (interval_seconds, jitter_seconds, enabled, created_at, updated_at).
//   - `enabled` round-trips as a boolean across the public surface; the
//     SQLite-flavored 0/1 conversion lives inside this module.
//   - Active-run records are one per connector with `run_id` unique
//     across the registry; `upsertActiveRun` resolves connector-id
//     collisions, while a duplicate `run_id` raises a unique-constraint
//     error from the engine (preserving the existing schema invariant).
//
// Spine reconciliation, in-memory `activeRuns` projections, and the
// `wasRunMarkedFailed` accessor stay in the controller. The store is
// the persistence seam only.

import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries } from "../../lib/db.ts";

// ─── Domain records (public, semantic) ──────────────────────────────────────

export interface ScheduleRecord {
  readonly connector_id: string;
  readonly created_at: string;
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ScheduleCreate {
  readonly connector_id: string;
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
  readonly run_id: string;
  readonly scenario_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

// ─── Public store surface ───────────────────────────────────────────────────

export interface SchedulerStore {
  // Schedule registry — semantic lifecycle verbs.
  createSchedule(record: ScheduleCreate): void;

  // Active-run registry — semantic lifecycle verbs.
  deleteActiveRun(connectorId: string, runId: string): void;
  deleteSchedule(connectorId: string): void;
  getSchedule(connectorId: string): ScheduleRecord | null;
  listActiveRuns(): readonly ActiveRunRecord[];
  listSchedules(): readonly ScheduleRecord[];
  setScheduleEnabled(connectorId: string, enabled: boolean, updatedAt: string): void;
  updateSchedule(connectorId: string, patch: ScheduleUpdate): void;
  upsertActiveRun(record: ActiveRunRecord): void;
}

// ─── SQLite implementation ──────────────────────────────────────────────────

interface ScheduleSqliteRow {
  readonly connector_id: string;
  readonly created_at: string;
  readonly enabled: 0 | 1;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

function rowToScheduleRecord(row: ScheduleSqliteRow): ScheduleRecord {
  return {
    connector_id: row.connector_id,
    interval_seconds: row.interval_seconds,
    jitter_seconds: row.jitter_seconds,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createSqliteSchedulerStore(): SchedulerStore {
  return {
    getSchedule(connectorId) {
      const row = getOne<ScheduleSqliteRow>(referenceQueries.controllerGetScheduleByConnector, [connectorId]);
      return row ? rowToScheduleRecord(row) : null;
    },

    listSchedules() {
      // REVIEWED-BOUNDED: connector_schedules holds at most one row per
      // registered connector; scan is bounded by connector count.
      const rows = allowUnboundedReadAcknowledged<ScheduleSqliteRow>(referenceQueries.controllerListSchedules);
      return rows.map(rowToScheduleRecord);
    },

    createSchedule(record) {
      exec(referenceQueries.controllerInsertSchedule, [
        record.connector_id,
        record.interval_seconds,
        record.jitter_seconds,
        record.enabled ? 1 : 0,
        record.created_at,
        record.updated_at,
      ]);
    },

    updateSchedule(connectorId, patch) {
      exec(referenceQueries.controllerUpdateSchedule, [
        patch.interval_seconds,
        patch.jitter_seconds,
        patch.enabled ? 1 : 0,
        patch.updated_at,
        connectorId,
      ]);
    },

    setScheduleEnabled(connectorId, enabled, updatedAt) {
      exec(referenceQueries.controllerUpdateScheduleEnabled, [enabled ? 1 : 0, updatedAt, connectorId]);
    },

    deleteSchedule(connectorId) {
      exec(referenceQueries.controllerDeleteSchedule, [connectorId]);
    },

    upsertActiveRun(record) {
      // The reference query is INSERT ... ON CONFLICT(connector_id) DO
      // UPDATE; collisions on `connector_id` are resolved as upserts.
      // Collisions on `run_id` (a separate UNIQUE constraint) raise the
      // engine's unique-constraint error — preserved here intentionally.
      exec(referenceQueries.controllerUpsertActiveRun, [
        record.connector_id,
        record.run_id,
        record.trace_id,
        record.scenario_id,
        record.started_at,
      ]);
    },

    listActiveRuns() {
      // REVIEWED-BOUNDED: at most one row per registered connector.
      return allowUnboundedReadAcknowledged<ActiveRunRecord>(referenceQueries.controllerListActiveRuns);
    },

    deleteActiveRun(connectorId, runId) {
      exec(referenceQueries.controllerDeleteActiveRun, [connectorId, runId]);
    },
  };
}

let defaultStore: SchedulerStore | null = null;

export function getDefaultSchedulerStore(): SchedulerStore {
  if (!defaultStore) {
    defaultStore = createSqliteSchedulerStore();
  }
  return defaultStore;
}

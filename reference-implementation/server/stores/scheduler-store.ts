// SchedulerStore — production storage interface for the connector
// schedule registry and the controller-managed active-run registry.
//
// Hides the `connector_schedules` and `controller_active_runs` SQLite
// tables behind two semantic registry surfaces. Callers stay in domain
// terms (schedule fields, run lifecycle) and never see registered query
// keys, prepared statements, or `getDb()`.
//
// Shape preserved verbatim from the current controller helpers:
//   - Schedules are one row per connector with semantic columns
//     (interval_seconds, jitter_seconds, enabled, created_at, updated_at).
//   - `enabled` is persisted as a SQLite 0/1 integer; the store accepts a
//     boolean and surfaces a `0 | 1` numeric in row reads to keep the
//     existing `scheduleRowToApi` boolean coercion intact.
//   - Active-run rows are one per connector with `run_id UNIQUE` across
//     the registry; upsert resolves connector-id collisions, while a
//     duplicate run_id raises a unique-constraint error from the engine
//     (preserving `controller_active_runs.run_id UNIQUE` semantics).
//
// Spine reconciliation, in-memory `activeRuns` projections, and the
// `wasRunMarkedFailed` accessor stay in the controller. The store is
// deliberately the persistence seam only.

import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries } from "../../lib/db.ts";

// ─── Schedule registry ──────────────────────────────────────────────────────

export interface ScheduleRow {
  readonly connector_id: string;
  readonly created_at: string;
  readonly enabled: 0 | 1;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface ScheduleInsert {
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

export interface ScheduleStore {
  delete(connectorId: string): void;
  get(connectorId: string): ScheduleRow | null;
  insert(row: ScheduleInsert): void;
  list(): readonly ScheduleRow[];
  setEnabled(connectorId: string, enabled: boolean, updatedAt: string): void;
  update(connectorId: string, patch: ScheduleUpdate): void;
}

// ─── Active-run registry ────────────────────────────────────────────────────

export interface ActiveRunRow {
  readonly connector_id: string;
  readonly run_id: string;
  readonly scenario_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface ActiveRunStore {
  delete(connectorId: string, runId: string): void;
  list(): readonly ActiveRunRow[];
  upsert(row: ActiveRunRow): void;
}

// ─── Combined surface ───────────────────────────────────────────────────────

export interface SchedulerStore {
  readonly activeRuns: ActiveRunStore;
  readonly schedules: ScheduleStore;
}

export function createSqliteSchedulerStore(): SchedulerStore {
  const schedules: ScheduleStore = {
    get(connectorId) {
      return getOne<ScheduleRow>(referenceQueries.controllerGetScheduleByConnector, [connectorId]);
    },

    list() {
      // REVIEWED-BOUNDED: connector_schedules holds at most one row per
      // registered connector; scan is bounded by connector count.
      return allowUnboundedReadAcknowledged<ScheduleRow>(referenceQueries.controllerListSchedules);
    },

    insert(row) {
      exec(referenceQueries.controllerInsertSchedule, [
        row.connector_id,
        row.interval_seconds,
        row.jitter_seconds,
        row.enabled ? 1 : 0,
        row.created_at,
        row.updated_at,
      ]);
    },

    update(connectorId, patch) {
      exec(referenceQueries.controllerUpdateSchedule, [
        patch.interval_seconds,
        patch.jitter_seconds,
        patch.enabled ? 1 : 0,
        patch.updated_at,
        connectorId,
      ]);
    },

    setEnabled(connectorId, enabled, updatedAt) {
      exec(referenceQueries.controllerUpdateScheduleEnabled, [enabled ? 1 : 0, updatedAt, connectorId]);
    },

    delete(connectorId) {
      exec(referenceQueries.controllerDeleteSchedule, [connectorId]);
    },
  };

  const activeRuns: ActiveRunStore = {
    upsert(row) {
      // The reference query is INSERT ... ON CONFLICT(connector_id) DO
      // UPDATE; collisions on `connector_id` are resolved as upserts.
      // Collisions on `run_id` (a separate UNIQUE constraint) raise the
      // engine's unique-constraint error — preserved here intentionally.
      exec(referenceQueries.controllerUpsertActiveRun, [
        row.connector_id,
        row.run_id,
        row.trace_id,
        row.scenario_id,
        row.started_at,
      ]);
    },

    list() {
      // REVIEWED-BOUNDED: at most one row per registered connector.
      return allowUnboundedReadAcknowledged<ActiveRunRow>(referenceQueries.controllerListActiveRuns);
    },

    delete(connectorId, runId) {
      exec(referenceQueries.controllerDeleteActiveRun, [connectorId, runId]);
    },
  };

  return { schedules, activeRuns };
}

let defaultStore: SchedulerStore | null = null;

export function getDefaultSchedulerStore(): SchedulerStore {
  if (!defaultStore) {
    defaultStore = createSqliteSchedulerStore();
  }
  return defaultStore;
}

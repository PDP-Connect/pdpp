/**
 * Production-store-backed driver for the connector-state / schedule /
 * active-run conformance harness.
 *
 * Exercises the production `ConnectorStateStore` and `SchedulerStore`
 * SQLite implementations directly, without going through the legacy
 * `getSyncState`/`putSyncState` helpers in `records.js` or the
 * controller's persistence wrappers. This is the production-store gate
 * required by `extract-low-risk-reference-stores` (task 2.5): the new
 * stores must pass the same conformance suite the test-only driver
 * passes.
 *
 * Restart reconciliation still goes through `createController`, because
 * the controller owns the abandoned-run reconciliation policy and the
 * spine emit. The store is the persistence seam for the registries
 * themselves, not for run lifecycle.
 *
 * This driver is test-only and SHALL NOT be exported from production
 * code; it is the test-side adapter that proves the production store
 * implementations satisfy the harness.
 */

import { closeDb, initDb } from '../../server/db.js';
import { registerConnector } from '../../server/auth.js';
import { getOne, referenceQueries } from '../../lib/db.ts';
import { createSqliteConnectorStateStore } from '../../server/stores/connector-state-store.ts';
import { createSqliteSchedulerStore } from '../../server/stores/scheduler-store.ts';
import { createController } from '../../runtime/controller.ts';

import { CONNECTOR_A, CONNECTOR_B } from './connector-state-scheduler-conformance.js';

// Stub manifests for the two harness connectors (mirrors the
// SQLite-driver helper). Registration is required so the controller's
// policy lookup has a manifest to find when scenarios touch schedules.
const HARNESS_MANIFESTS = [
  {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_A,
    version: '1.0.0',
    display_name: 'Conformance Connector A',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'stream_x',
        semantics: 'mutable_state',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
      {
        name: 'stream_y',
        semantics: 'mutable_state',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
  },
  {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_B,
    version: '1.0.0',
    display_name: 'Conformance Connector B',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'stream_x',
        semantics: 'mutable_state',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
  },
];

function activeRunRowToSummary(row) {
  if (!row) return null;
  return {
    connector_id: row.connector_id,
    run_id: row.run_id,
    trace_id: row.trace_id,
    scenario_id: row.scenario_id,
    started_at: row.started_at,
  };
}

function scheduleRowToSummary(row) {
  if (!row) return null;
  return {
    connector_id: row.connector_id,
    interval_seconds: row.interval_seconds,
    jitter_seconds: row.jitter_seconds,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function nowIso() {
  return new Date().toISOString();
}

export function createProductionStoreConnectorStateSchedulerDriver() {
  let stateStore = null;
  let schedulerStore = null;
  let controller = null;

  return {
    async setup() {
      initDb();
      for (const manifest of HARNESS_MANIFESTS) {
        await registerConnector(manifest);
      }
      stateStore = createSqliteConnectorStateStore();
      schedulerStore = createSqliteSchedulerStore();
      // Controller is needed so `simulateRestart` runs the abandoned-run
      // reconciliation against the same DB; the controller is configured
      // with the same scheduler store so it sees the rows the driver wrote.
      controller = createController({
        logger: { warn: () => {}, error: () => {} },
        schedulerStore,
      });
    },

    async teardown() {
      stateStore = null;
      schedulerStore = null;
      controller = null;
      closeDb();
    },

    async putConnectorState(scope, stateByStream) {
      return stateStore.putState(
        { connectorId: scope.connectorId, grantId: scope.grantId || null },
        stateByStream,
      );
    },

    async getConnectorState(scope, opts = {}) {
      const allowedStreams = Array.isArray(opts.allowedStreams) ? opts.allowedStreams : null;
      return stateStore.getState(
        { connectorId: scope.connectorId, grantId: scope.grantId || null },
        { allowedStreams },
      );
    },

    async upsertSchedule(connectorId, patch) {
      const enabled = patch.enabled !== false;
      const intervalSeconds = patch.interval_seconds;
      const jitterSeconds = patch.jitter_seconds || 0;
      const existing = schedulerStore.schedules.get(connectorId);
      const now = nowIso();
      if (existing) {
        schedulerStore.schedules.update(connectorId, {
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          enabled,
          updated_at: now,
        });
      } else {
        schedulerStore.schedules.insert({
          connector_id: connectorId,
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          enabled,
          created_at: now,
          updated_at: now,
        });
      }
      return scheduleRowToSummary(schedulerStore.schedules.get(connectorId));
    },

    async getSchedule(connectorId) {
      return scheduleRowToSummary(schedulerStore.schedules.get(connectorId));
    },

    async listSchedules() {
      return schedulerStore.schedules.list().map(scheduleRowToSummary);
    },

    async setScheduleEnabled(connectorId, enabled) {
      schedulerStore.schedules.setEnabled(connectorId, enabled, nowIso());
      return scheduleRowToSummary(schedulerStore.schedules.get(connectorId));
    },

    async deleteSchedule(connectorId) {
      const existing = schedulerStore.schedules.get(connectorId);
      if (!existing) return false;
      schedulerStore.schedules.delete(connectorId);
      return true;
    },

    async insertActiveRun(connectorId, run) {
      schedulerStore.activeRuns.upsert({
        connector_id: connectorId,
        run_id: run.runId,
        trace_id: run.traceId,
        scenario_id: run.scenarioId,
        started_at: run.startedAt,
      });
    },

    async getActiveRun(connectorId) {
      const rows = schedulerStore.activeRuns.list();
      const found = rows.find((row) => row.connector_id === connectorId);
      return found ? activeRunRowToSummary(found) : null;
    },

    async listActiveRuns() {
      return schedulerStore.activeRuns.list().map(activeRunRowToSummary);
    },

    async deleteActiveRun(connectorId, runId) {
      schedulerStore.activeRuns.delete(connectorId, runId);
    },

    async simulateRestart() {
      // Constructing a fresh controller against the same DB triggers
      // `reconcileAbandonedControllerRuns`, which reads from
      // `schedulerStore.activeRuns.list()` and clears each row after
      // emitting `run.failed`.
      controller = createController({
        logger: { warn: () => {}, error: () => {} },
        schedulerStore,
      });
      await new Promise((resolve) => setImmediate(resolve));
    },

    async wasRunMarkedFailed(runId) {
      // Spine read stays directly on the registered query: the spine is
      // intentionally out of scope for the low-risk store extraction.
      const row = getOne(referenceQueries.spineCheckRunTerminal, [runId]);
      return Boolean(row);
    },
  };
}

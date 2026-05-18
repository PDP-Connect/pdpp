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
import { makeLegacyConnectorInstanceId } from '../../server/stores/connector-instance-store.js';
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

function activeRunRecordToSummary(record) {
  if (!record) return null;
  return {
    connector_id: record.connector_id,
    run_id: record.run_id,
    trace_id: record.trace_id,
    scenario_id: record.scenario_id,
    started_at: record.started_at,
  };
}

function scheduleRecordToSummary(record) {
  if (!record) return null;
  // The store surface guarantees `record.enabled` is already a boolean;
  // we forward it verbatim so a future store regression that re-leaks a
  // 0/1 numeric would surface in the harness's strict equality checks.
  return {
    connector_id: record.connector_id,
    interval_seconds: record.interval_seconds,
    jitter_seconds: record.jitter_seconds,
    enabled: record.enabled,
    created_at: record.created_at,
    updated_at: record.updated_at,
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
        {
          connectorId: scope.connectorId,
          connectorInstanceId: makeLegacyConnectorInstanceId('owner_local', scope.connectorId),
          grantId: scope.grantId || null,
        },
        stateByStream,
      );
    },

    async getConnectorState(scope, opts = {}) {
      const allowedStreams = Array.isArray(opts.allowedStreams) ? opts.allowedStreams : null;
      return stateStore.getState(
        {
          connectorId: scope.connectorId,
          connectorInstanceId: makeLegacyConnectorInstanceId('owner_local', scope.connectorId),
          grantId: scope.grantId || null,
        },
        { allowedStreams },
      );
    },

    async upsertSchedule(connectorId, patch) {
      const enabled = patch.enabled !== false;
      const intervalSeconds = patch.interval_seconds;
      const jitterSeconds = patch.jitter_seconds || 0;
      const existing = schedulerStore.getSchedule(connectorId);
      const now = nowIso();
      if (existing) {
        schedulerStore.updateSchedule(connectorId, {
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          enabled,
          updated_at: now,
        });
      } else {
        schedulerStore.createSchedule({
          connector_id: connectorId,
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          enabled,
          created_at: now,
          updated_at: now,
        });
      }
      return scheduleRecordToSummary(schedulerStore.getSchedule(connectorId));
    },

    async getSchedule(connectorId) {
      return scheduleRecordToSummary(schedulerStore.getSchedule(connectorId));
    },

    async listSchedules() {
      return schedulerStore.listSchedules().map(scheduleRecordToSummary);
    },

    async setScheduleEnabled(connectorId, enabled) {
      schedulerStore.setScheduleEnabled(connectorId, enabled, nowIso());
      return scheduleRecordToSummary(schedulerStore.getSchedule(connectorId));
    },

    async deleteSchedule(connectorId) {
      const existing = schedulerStore.getSchedule(connectorId);
      if (!existing) return false;
      schedulerStore.deleteSchedule(connectorId);
      return true;
    },

    async insertActiveRun(connectorId, run) {
      schedulerStore.upsertActiveRun({
        connector_id: connectorId,
        run_id: run.runId,
        trace_id: run.traceId,
        scenario_id: run.scenarioId,
        started_at: run.startedAt,
      });
    },

    async getActiveRun(connectorId) {
      const records = schedulerStore.listActiveRuns();
      const found = records.find((record) => record.connector_id === connectorId);
      return found ? activeRunRecordToSummary(found) : null;
    },

    async listActiveRuns() {
      return schedulerStore.listActiveRuns().map(activeRunRecordToSummary);
    },

    async deleteActiveRun(connectorId, runId) {
      schedulerStore.deleteActiveRun(connectorId, runId);
    },

    async simulateRestart() {
      // Constructing a fresh controller against the same DB triggers
      // `reconcileAbandonedControllerRuns`, which reads from
      // `schedulerStore.listActiveRuns()` and clears each record after
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

/**
 * SQLite-backed driver for the connector-state / schedule / active-run
 * conformance harness.
 *
 * Wraps the current reference helpers (`getSyncState`/`putSyncState` for
 * state, `createController` public methods for schedules, and the
 * `controllerUpsertActiveRun` / `controllerListActiveRuns` /
 * `controllerDeleteActiveRun` registered queries for active runs) in the
 * narrow, semantic harness shape. This driver is the pinned baseline for
 * the conformance suite; it is not exported from production code.
 *
 * Active-run note: the controller has no public `insertActiveRun`-style
 * seam — only `runNow()`, which spawns a real connector child process.
 * This driver therefore reaches the persistence layer through the
 * registered `controllerUpsertActiveRun` query (the same statement
 * `runNow` itself uses internally) so the harness can exercise the
 * registry's persistence contract without standing up a runtime. That
 * coupling is intentional and bounded: the harness scenarios speak in
 * lifecycle terms and never see SQL or table names.
 *
 * Spec: openspec/changes/add-connector-state-scheduler-conformance-harness/
 *       specs/reference-implementation-architecture/spec.md
 */

import {
  allowUnboundedReadAcknowledged,
  exec,
  getOne,
  referenceQueries,
} from '../../lib/db.ts';
import { closeDb, initDb } from '../../server/db.js';
import { registerConnector } from '../../server/auth.js';
import { getSyncState, putSyncState } from '../../server/records.js';
import { createController } from '../../runtime/controller.ts';

import { CONNECTOR_A, CONNECTOR_B } from './connector-state-scheduler-conformance.js';

// Stub manifests for the harness's two connectors. Registration is
// required so `getSyncState` / `putSyncState` (which load the manifest
// indirectly via record helpers) and the controller's policy lookup
// (`getConnectorRefreshPolicy`) have a row to find. These manifests
// declare no `refresh_policy` so schedule scenarios stay clear of the
// `minimum_interval_warning` policy surface, which is covered by
// existing controller tests.
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

function scopeKey(scope) {
  return { connectorId: scope.connectorId, grantId: scope.grantId || null };
}

function activeRunRowToSummary(row) {
  if (!row) return null;
  return {
    connector_instance_id: row.connector_instance_id ?? row.connector_id,
    connector_id: row.connector_id,
    run_id: row.run_id,
    run_generation: row.run_generation ?? 1,
    trace_id: row.trace_id,
    scenario_id: row.scenario_id,
    started_at: row.started_at,
  };
}

export function createSqliteConnectorStateSchedulerDriver() {
  // Each scenario gets a fresh driver instance, but the harness calls
  // `setup()` on it before any work, so we can keep state in the closure.
  let controller = null;

  return {
    async setup() {
      initDb();
      for (const manifest of HARNESS_MANIFESTS) {
        await registerConnector(manifest);
      }
      controller = createController({
        // Quiet logger so the reconciliation warning that fires inside
        // `simulateRestart` doesn't leak into test output.
        logger: { warn: () => {}, error: () => {} },
      });
    },

    async teardown() {
      controller = null;
      closeDb();
    },

    async putConnectorState(scope, stateByStream) {
      const { connectorId, grantId } = scopeKey(scope);
      return putSyncState(connectorId, stateByStream, { grantId });
    },

    async getConnectorState(scope, opts = {}) {
      const { connectorId, grantId } = scopeKey(scope);
      const allowedStreams = Array.isArray(opts.allowedStreams) ? opts.allowedStreams : null;
      return getSyncState(connectorId, { grantId, allowedStreams });
    },

    async upsertSchedule(connectorId, patch) {
      const result = await controller.upsertSchedule(connectorId, patch);
      const api = result.schedule;
      return {
        connector_instance_id: api.connector_instance_id,
        connector_id: api.connector_id,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        enabled: api.enabled,
        created_at: api.created_at,
        updated_at: api.updated_at,
      };
    },

    async getSchedule(connectorId) {
      const api = await controller.getSchedule(connectorId);
      if (!api) return null;
      return {
        connector_instance_id: api.connector_instance_id,
        connector_id: api.connector_id,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        enabled: api.enabled,
        created_at: api.created_at,
        updated_at: api.updated_at,
      };
    },

    async listSchedules() {
      const apis = await controller.listSchedules();
      return apis.map((api) => ({
        connector_instance_id: api.connector_instance_id,
        connector_id: api.connector_id,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        enabled: api.enabled,
        created_at: api.created_at,
        updated_at: api.updated_at,
      }));
    },

    async setScheduleEnabled(connectorId, enabled) {
      const api = await controller.setScheduleEnabled(connectorId, enabled);
      return {
        connector_instance_id: api.connector_instance_id,
        connector_id: api.connector_id,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        enabled: api.enabled,
        created_at: api.created_at,
        updated_at: api.updated_at,
      };
    },

    async deleteSchedule(connectorId) {
      return controller.deleteSchedule(connectorId);
    },

    async insertActiveRun(connectorId, run) {
      // The reference uses `controllerUpsertActiveRun` at runtime. The
      // harness asserts that a competing run is rejected and the incumbent
      // row remains intact.
      const result = exec(referenceQueries.controllerUpsertActiveRun, [
        connectorId,
        connectorId,
        run.runId,
        run.traceId,
        run.scenarioId,
        run.startedAt,
        run.runGeneration ?? 1,
      ]);
      return result.changes > 0;
    },

    getActiveRun(connectorId) {
      // No registered single-connector lookup query exists; the
      // reference uses an in-memory `activeRuns` map and only uses
      // the persistence layer for restart reconciliation. For the
      // harness we filter the bounded list, which still exercises
      // the persistence read path.
      const rows = allowUnboundedReadAcknowledged(referenceQueries.controllerListActiveRuns);
      const found = rows.find((row) => (row.connector_instance_id ?? row.connector_id) === connectorId);
      return found ? activeRunRowToSummary(found) : null;
    },

    async listActiveRuns() {
      const rows = allowUnboundedReadAcknowledged(referenceQueries.controllerListActiveRuns);
      return rows.map(activeRunRowToSummary);
    },

    async deleteActiveRun(connectorId, runId) {
      exec(referenceQueries.controllerDeleteActiveRun, [runId, connectorId, connectorId]);
    },

    async simulateRestart() {
      // A fresh controller invokes `reconcileAbandonedControllerRuns`
      // at construction time against the same db (the module-scoped
      // sqlite handle is preserved). This mirrors the production
      // restart sequence: the prior process leaves rows behind in
      // `controller_active_runs`; the new process boots a controller
      // and reconciliation drains them.
      controller = createController({
        logger: { warn: () => {}, error: () => {} },
      });
      // Reconciliation emits run.failed events asynchronously; settle
      // the microtask queue so the spine row is durable before the
      // harness inspects it.
      await new Promise((resolve) => setImmediate(resolve));
    },

    async wasRunMarkedFailed(runId) {
      // `spineCheckRunTerminal` returns truthy for either run.completed
      // or run.failed. The harness's restart scenario only emits
      // run.failed (no run.completed is ever produced for these
      // synthetic runs), so a terminal hit here is sufficient evidence
      // of the failed branch firing.
      const row = getOne(referenceQueries.spineCheckRunTerminal, [runId]);
      return Boolean(row);
    },
  };
}

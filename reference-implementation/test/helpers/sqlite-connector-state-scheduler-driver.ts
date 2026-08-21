// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries } from "../../lib/db.ts";
import { createController } from "../../runtime/controller.ts";
import { registerConnector } from "../../server/auth.ts";
import { closeDb, initDb } from "../../server/db.ts";
import { getSyncState, putSyncState } from "../../server/records.ts";

import { CONNECTOR_A, CONNECTOR_B } from "./connector-state-scheduler-conformance.ts";

interface StateScope {
  connectorId: string;
  grantId?: string | null;
}
interface StateByStream {
  [stream: string]: Record<string, unknown>;
}
interface SchedulePatch {
  enabled?: boolean;
  interval_seconds: number;
  jitter_seconds?: number;
}
interface ActiveRunInput {
  runGeneration?: number;
  runId: string;
  scenarioId: string;
  startedAt: string;
  traceId: string;
}
interface ActiveDbRow {
  connector_id: string;
  connector_instance_id?: string;
  run_generation?: number;
  run_id: string;
  scenario_id: string;
  started_at: string;
  trace_id: string;
}

// Stub manifests for the harness's two connectors. Registration is
// required so `getSyncState` / `putSyncState` (which load the manifest
// indirectly via record helpers) and the controller's policy lookup
// (`getConnectorRefreshPolicy`) have a row to find. These manifests
// declare no `refresh_policy` so schedule scenarios stay clear of the
// `minimum_interval_warning` policy surface, which is covered by
// existing controller tests.
const HARNESS_MANIFESTS = [
  {
    connector_id: CONNECTOR_A,
    display_name: "Conformance Connector A",
    manifest_uri: `https://sources.example/${CONNECTOR_A}`,
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: "stream_x",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "stream_y",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  },
  {
    connector_id: CONNECTOR_B,
    display_name: "Conformance Connector B",
    manifest_uri: `https://sources.example/${CONNECTOR_B}`,
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: "stream_x",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  },
];

function scopeKey(scope: StateScope): { connectorId: string; grantId: string | null } {
  return { connectorId: scope.connectorId, grantId: scope.grantId || null };
}

function activeRunRowToSummary(row: ActiveDbRow | null): ActiveDbRow | null {
  if (!row) {
    return null;
  }
  return {
    connector_id: row.connector_id,
    connector_instance_id: row.connector_instance_id ?? row.connector_id,
    run_generation: row.run_generation ?? 1,
    run_id: row.run_id,
    scenario_id: row.scenario_id,
    started_at: row.started_at,
    trace_id: row.trace_id,
  };
}

export function createSqliteConnectorStateSchedulerDriver() {
  // Each scenario gets a fresh driver instance, but the harness calls
  // `setup()` on it before any work, so we can keep state in the closure.
  let controller: ReturnType<typeof createController> | null = null;

  return {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async deleteActiveRun(connectorId: string, runId: string) {
      exec(referenceQueries.controllerDeleteActiveRun, [runId, connectorId, connectorId]);
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async deleteSchedule(connectorId: string) {
      const scheduler = controller;
      if (!scheduler) {
        throw new Error("sqlite scheduler driver has not been set up");
      }
      return scheduler.deleteSchedule(connectorId);
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async getActiveRun(connectorId: string) {
      // No registered single-connector lookup query exists; the
      // reference uses an in-memory `activeRuns` map and only uses
      // the persistence layer for restart reconciliation. For the
      // harness we filter the bounded list, which still exercises
      // the persistence read path.
      const rows = allowUnboundedReadAcknowledged(referenceQueries.controllerListActiveRuns) as ActiveDbRow[];
      const found = rows.find((row) => (row.connector_instance_id ?? row.connector_id) === connectorId);
      return found ? activeRunRowToSummary(found) : null;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async getConnectorState(scope: StateScope, opts: { allowedStreams?: string[] } = {}) {
      const { connectorId, grantId } = scopeKey(scope);
      const allowedStreams = Array.isArray(opts.allowedStreams) ? opts.allowedStreams : null;
      return getSyncState(connectorId, { allowedStreams, grantId });
    },

    async getSchedule(connectorId: string) {
      const api = await controller?.getSchedule(connectorId);
      if (!api) {
        return null;
      }
      return {
        connector_id: api.connector_id,
        connector_instance_id: api.connector_instance_id,
        created_at: api.created_at,
        enabled: api.enabled,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        updated_at: api.updated_at,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async insertActiveRun(connectorId: string, run: ActiveRunInput) {
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

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listActiveRuns() {
      const rows = allowUnboundedReadAcknowledged(referenceQueries.controllerListActiveRuns) as ActiveDbRow[];
      return rows.map(activeRunRowToSummary).filter((row): row is ActiveDbRow => row !== null);
    },

    async listSchedules() {
      const scheduler = controller;
      if (!scheduler) {
        throw new Error("sqlite scheduler driver has not been set up");
      }
      const apis = await scheduler.listSchedules();
      return apis.map((api: (typeof apis)[number]) => ({
        connector_id: api.connector_id,
        connector_instance_id: api.connector_instance_id,
        created_at: api.created_at,
        enabled: api.enabled,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        updated_at: api.updated_at,
      }));
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async putConnectorState(scope: StateScope, stateByStream: StateByStream) {
      const { connectorId, grantId } = scopeKey(scope);
      return putSyncState(connectorId, stateByStream, { grantId });
    },

    async setScheduleEnabled(connectorId: string, enabled: boolean) {
      const api = await controller?.setScheduleEnabled(connectorId, enabled);
      if (!api) {
        throw new Error(`Schedule not found for connector: ${connectorId}`);
      }
      return {
        connector_id: api.connector_id,
        connector_instance_id: api.connector_instance_id,
        created_at: api.created_at,
        enabled: api.enabled,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        updated_at: api.updated_at,
      };
    },
    async setup() {
      initDb();
      for (const manifest of HARNESS_MANIFESTS) {
        // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
        await registerConnector(manifest);
      }
      controller = createController({
        // Quiet logger so the reconciliation warning that fires inside
        // `simulateRestart` doesn't leak into test output.
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        logger: { error: () => {}, warn: () => {} },
      });
    },

    async simulateRestart() {
      // A fresh controller invokes `releaseAbandonedControllerRunClaims`
      // at construction time against the same db (the module-scoped
      // sqlite handle is preserved). This mirrors the production
      // restart sequence: the prior process leaves rows behind in
      // `controller_active_runs`; the new process boots a controller
      // and releases those stale claims. The runs' terminal state is
      // adjudicated separately, from the spine, by
      // `reconcileOrphanedRunsAtBoot`.
      controller = createController({
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        logger: { error: () => {}, warn: () => {} },
      });
      // Reconciliation emits run.failed events asynchronously; settle
      // the microtask queue so the spine row is durable before the
      // harness inspects it.
      await new Promise((resolve) => setImmediate(resolve));
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async teardown() {
      controller = null;
      closeDb();
    },

    async upsertSchedule(connectorId: string, patch: SchedulePatch) {
      const scheduler = controller;
      if (!scheduler) {
        throw new Error("sqlite scheduler driver has not been set up");
      }
      const result = await scheduler.upsertSchedule(connectorId, patch);
      const api = result.schedule;
      return {
        connector_id: api.connector_id,
        connector_instance_id: api.connector_instance_id,
        created_at: api.created_at,
        enabled: api.enabled,
        interval_seconds: api.interval_seconds,
        jitter_seconds: api.jitter_seconds,
        updated_at: api.updated_at,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async wasRunMarkedFailed(runId: string) {
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

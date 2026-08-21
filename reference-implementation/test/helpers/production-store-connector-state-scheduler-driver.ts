// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { clearCurrentBootEpoch } from "../../lib/spine.ts";
import { createController } from "../../runtime/controller.ts";
import { registerConnector } from "../../server/auth.ts";
import { closeDb, initDb } from "../../server/db.ts";
import { makeDefaultAccountConnectorInstanceId } from "../../server/stores/connector-instance-store.ts";
import { createSqliteConnectorStateStore } from "../../server/stores/connector-state-store.ts";
import { createSqliteSchedulerStore } from "../../server/stores/scheduler-store.ts";

import {
  announceHarnessRunStarted,
  CONNECTOR_A,
  CONNECTOR_B,
  runHarnessBootReconciliation,
  spineHasRunAbandoned,
} from "./connector-state-scheduler-conformance.ts";

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
interface ScheduleRecord {
  connector_id: string;
  connector_instance_id?: string;
  created_at: string;
  enabled: boolean;
  interval_seconds: number;
  jitter_seconds: number;
  updated_at: string;
}
interface ActiveRunRecord {
  connector_id: string;
  connector_instance_id?: string;
  run_generation?: number;
  run_id: string;
  scenario_id: string;
  started_at: string;
  trace_id: string;
}

// Stub manifests for the two harness connectors (mirrors the
// SQLite-driver helper). Registration is required so the controller's
// policy lookup has a manifest to find when scenarios touch schedules.
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

function activeRunRecordToSummary(record: ActiveRunRecord | null): ActiveRunRecord | null {
  if (!record) {
    return null;
  }
  return {
    connector_id: record.connector_id,
    connector_instance_id: record.connector_instance_id ?? record.connector_id,
    run_generation: record.run_generation ?? 1,
    run_id: record.run_id,
    scenario_id: record.scenario_id,
    started_at: record.started_at,
    trace_id: record.trace_id,
  };
}

function scheduleRecordToSummary(record: ScheduleRecord | null): ScheduleRecord | null {
  if (!record) {
    return null;
  }
  // The store surface guarantees `record.enabled` is already a boolean;
  // we forward it verbatim so a future store regression that re-leaks a
  // 0/1 numeric would surface in the harness's strict equality checks.
  return {
    connector_id: record.connector_id,
    connector_instance_id: record.connector_instance_id ?? record.connector_id,
    created_at: record.created_at,
    enabled: record.enabled,
    interval_seconds: record.interval_seconds,
    jitter_seconds: record.jitter_seconds,
    updated_at: record.updated_at,
  };
}

function nowIso() {
  return new Date().toISOString();
}

export function createProductionStoreConnectorStateSchedulerDriver() {
  let stateStore: ReturnType<typeof createSqliteConnectorStateStore> | null = null;
  let schedulerStore: ReturnType<typeof createSqliteSchedulerStore> | null = null;

  return {
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async deleteActiveRun(connectorId: string, runId: string) {
      schedulerStore?.deleteActiveRun(connectorId, runId);
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async deleteSchedule(connectorId: string) {
      const existing = schedulerStore?.getSchedule(connectorId);
      if (!existing) {
        return false;
      }
      schedulerStore?.deleteSchedule(connectorId);
      return true;
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async getActiveRun(connectorId: string) {
      const found = schedulerStore?.getActiveRun(connectorId) as ActiveRunRecord | null;
      return found ? activeRunRecordToSummary(found) : null;
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async getConnectorState(scope: StateScope, opts: { allowedStreams?: string[] } = {}) {
      const allowedStreams = Array.isArray(opts.allowedStreams) ? opts.allowedStreams : null;
      const store = stateStore;
      if (!store) {
        throw new Error("production scheduler driver has not been set up");
      }
      return store.getState(
        {
          connectorId: scope.connectorId,
          connectorInstanceId: makeDefaultAccountConnectorInstanceId("owner_local", scope.connectorId),
          grantId: scope.grantId || null,
        },
        { allowedStreams }
      );
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async getSchedule(connectorId: string) {
      return scheduleRecordToSummary(schedulerStore?.getSchedule(connectorId) as ScheduleRecord | null);
    },

    async insertActiveRun(connectorId: string, run: ActiveRunInput) {
      const admitted = await schedulerStore?.upsertActiveRun({
        connector_id: connectorId,
        connector_instance_id: connectorId,
        run_generation: run.runGeneration ?? 1,
        run_id: run.runId,
        scenario_id: run.scenarioId,
        started_at: run.startedAt,
        trace_id: run.traceId,
      });
      if (admitted) {
        // See the sqlite driver: the boot reconciler adjudicates from
        // `run.started` spine events, not from the flight table, so a run
        // that exists only as a store record is invisible to it.
        await announceHarnessRunStarted(connectorId, run);
      }
      return admitted;
    },

    async listActiveRuns() {
      if (!schedulerStore) {
        throw new Error("production scheduler driver has not been set up");
      }
      return (await schedulerStore.listActiveRuns())
        .map((record: ActiveRunRecord) => activeRunRecordToSummary(record))
        .filter((record): record is ActiveRunRecord => record !== null);
    },

    async listSchedules() {
      if (!schedulerStore) {
        throw new Error("production scheduler driver has not been set up");
      }
      return (await schedulerStore.listSchedules())
        .map((record: ScheduleRecord) => scheduleRecordToSummary(record))
        .filter((record): record is ScheduleRecord => record !== null);
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async putConnectorState(scope: StateScope, stateByStream: StateByStream) {
      if (!stateStore) {
        throw new Error("production state driver has not been set up");
      }
      return stateStore.putState(
        {
          connectorId: scope.connectorId,
          connectorInstanceId: makeDefaultAccountConnectorInstanceId("owner_local", scope.connectorId),
          grantId: scope.grantId || null,
        },
        stateByStream
      );
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async setScheduleEnabled(connectorId: string, enabled: boolean) {
      schedulerStore?.setScheduleEnabled(connectorId, enabled, nowIso());
      const summary = scheduleRecordToSummary(schedulerStore?.getSchedule(connectorId) as ScheduleRecord | null);
      if (!summary) {
        throw new Error(`Schedule missing after enable update for connector: ${connectorId}`);
      }
      return summary;
    },
    async setup() {
      initDb();
      for (const manifest of HARNESS_MANIFESTS) {
        // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
        await registerConnector(manifest);
      }
      stateStore = createSqliteConnectorStateStore();
      schedulerStore = createSqliteSchedulerStore();
      // Establish this incarnation's boot epoch before any run is
      // announced; the spine refuses an unstamped `run.started`.
      await runHarnessBootReconciliation();
      // Controller is needed so `simulateRestart` releases the abandoned
      // run claims against the same DB; the controller is configured with
      // the same scheduler store so it sees the rows the driver wrote.
      // biome-ignore lint/complexity/noVoid: expression intentionally discards a test-only value
      void createController({
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        logger: { error: () => {}, warn: () => {} },
        schedulerStore,
      });
    },

    async simulateRestart() {
      // Constructing a fresh controller against the same DB triggers
      // `releaseAbandonedControllerRunClaims`, which reads from
      // `schedulerStore.listActiveRuns()` and clears each record. It
      // writes no terminal event: `reconcileOrphanedRunsAtBoot` owns
      // that, from the spine — so the successor's boot reconciliation
      // has to actually run, which is the second call below.
      // biome-ignore lint/complexity/noVoid: expression intentionally discards a test-only value
      void createController({
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        logger: { error: () => {}, warn: () => {} },
        // biome-ignore lint/style/noNonNullAssertion: test fixture establishes this value before use
        schedulerStore: schedulerStore!,
      });
      await runHarnessBootReconciliation();
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async teardown() {
      stateStore = null;
      schedulerStore = null;
      // The boot epoch lives in a module-scoped singleton; leaving one
      // behind would stamp the next scenario's runs with a dead
      // incarnation's identity.
      clearCurrentBootEpoch();
      closeDb();
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async upsertSchedule(connectorId: string, patch: SchedulePatch) {
      const enabled = patch.enabled !== false;
      const intervalSeconds = patch.interval_seconds;
      const jitterSeconds = patch.jitter_seconds || 0;
      const existing = schedulerStore?.getSchedule(connectorId);
      const now = nowIso();
      if (existing) {
        schedulerStore?.updateSchedule(connectorId, {
          enabled,
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          updated_at: now,
        });
      } else {
        schedulerStore?.createSchedule({
          connector_id: connectorId,
          connector_instance_id: connectorId,
          created_at: now,
          enabled,
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          updated_at: now,
        });
      }
      const summary = scheduleRecordToSummary(schedulerStore?.getSchedule(connectorId) as ScheduleRecord | null);
      if (!summary) {
        throw new Error(`Schedule missing after upsert for connector: ${connectorId}`);
      }
      return summary;
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async wasRunAdjudicatedAbandoned(runId: string) {
      // Spine read stays outside the store seam: the spine is
      // intentionally out of scope for the low-risk store extraction.
      return spineHasRunAbandoned(runId);
    },
  };
}

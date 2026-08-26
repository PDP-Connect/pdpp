// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deliberately broken in-memory driver for connector-state / schedule /
 * active-run conformance falsifiability.
 *
 * This driver exists ONLY for the conformance harness's negative proof.
 * It implements a small in-memory store whose persistence is
 * intentionally wrong in three specific ways — one per concern the
 * harness covers — so the harness must catch at least one invariant
 * violation in each area, not just an aggregate failure that could
 * trivially overshadow weaker scenarios.
 *
 *   1. State scope is collapsed: `grantId` is ignored, so grant-scoped
 *      writes leak into the owner-scoped projection (and vice-versa).
 *      This is the failure mode that protects against drivers that
 *      forget to key by `(connector_id, grant_id, stream)` and instead
 *      key by `(connector_id, stream)` everywhere.
 *
 *   2. Schedule upsert always inserts: a second `upsertSchedule` for
 *      the same connector appends a new row instead of updating in
 *      place, growing `listSchedules()` by one. This is the failure
 *      mode that protects against drivers that drop the conflict guard.
 *
 *   3. Active-run registry permits duplicates: two `insertActiveRun`
 *      calls for the same connector succeed and both rows persist.
 *      This is the failure mode that protects against drivers that
 *      forget the per-connector exclusivity invariant.
 *
 * `simulateRestart` is implemented as a no-op so the corresponding
 * scenario also fails — the broken driver never reconciles abandoned
 * rows or adjudicates a run.abandoned terminal event. That makes the
 * restart-reconciliation scenario a falsifiability hit too.
 *
 * This driver SHALL NOT be used as a production adapter or environment
 * profile. It is only imported from the falsifiability test.
 */

interface StateRow {
  connector_id: string;
  state_json: string;
  stream: string;
  updated_at: string;
}
interface ScheduleRow {
  connector_id: string;
  created_at: string;
  enabled: boolean;
  interval_seconds: number;
  jitter_seconds: number;
  updated_at: string;
}
interface ActiveRunRow {
  connector_id: string;
  run_generation: number;
  run_id: string;
  scenario_id: string;
  started_at: string;
  trace_id: string;
}
interface StateScope {
  connectorId: string;
  grantId?: string | null;
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

export function createBrokenInMemoryConnectorStateSchedulerDriver() {
  // BROKEN: keyed only by (connector_id, stream), losing grant scope.
  let stateRows: StateRow[] = [];

  // BROKEN: appends instead of upserting on conflict.
  let scheduleRows: ScheduleRow[] = [];

  // BROKEN: no per-connector exclusivity; both rows persist on
  // collision.
  let activeRunRows: ActiveRunRow[] = [];

  // The broken driver never emits terminal events.
  const failedRunIds = new Set();

  function nowIso() {
    return new Date().toISOString();
  }

  function applyAllowedStreams(
    state: Record<string, Record<string, unknown>>,
    allowedStreams?: string[]
  ): Record<string, Record<string, unknown>> {
    if (!Array.isArray(allowedStreams)) {
      return state;
    }
    const set = new Set(allowedStreams);
    const filtered: Record<string, Record<string, unknown>> = {};
    for (const [stream, value] of Object.entries(state)) {
      if (set.has(stream)) {
        filtered[stream] = value;
      }
    }
    return filtered;
  }

  return {
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async deleteActiveRun(connectorId: string, runId: string): Promise<void> {
      activeRunRows = activeRunRows.filter((row) => !(row.connector_id === connectorId && row.run_id === runId));
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async deleteSchedule(connectorId: string): Promise<boolean> {
      const before = scheduleRows.length;
      scheduleRows = scheduleRows.filter((row) => row.connector_id !== connectorId);
      return scheduleRows.length < before;
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async getActiveRun(connectorId: string): Promise<ActiveRunRow | null> {
      const found = activeRunRows.find((row) => row.connector_id === connectorId);
      return found ? { ...found } : null;
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async getConnectorState(scope: StateScope, opts: { allowedStreams?: string[] } = {}) {
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const connectorId = scope.connectorId;
      const grantId = scope.grantId || null;
      const state: Record<string, Record<string, unknown>> = {};
      // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
      let updatedAt = null;
      for (const row of stateRows) {
        if (row.connector_id !== connectorId) {
          continue;
        }
        state[row.stream] = JSON.parse(row.state_json);
        if (!updatedAt || row.updated_at > updatedAt) {
          updatedAt = row.updated_at;
        }
      }
      const projected = applyAllowedStreams(state, opts.allowedStreams);
      return {
        connector_id: connectorId,
        grant_id: grantId,
        object: "stream_state",
        state: projected,
        updated_at: updatedAt,
      };
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async getSchedule(connectorId: string): Promise<ScheduleRow | null> {
      const found = scheduleRows.find((row) => row.connector_id === connectorId);
      return found ? { ...found } : null;
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async insertActiveRun(connectorId: string, run: ActiveRunInput): Promise<undefined> {
      // BROKEN: never reject or upsert; just append.
      activeRunRows.push({
        connector_id: connectorId,
        run_generation: run.runGeneration ?? 1,
        run_id: run.runId,
        scenario_id: run.scenarioId,
        started_at: run.startedAt,
        trace_id: run.traceId,
      });
      // biome-ignore lint/complexity/noUselessReturn: required by the explicit Promise<undefined> conformance contract.
      return;
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listActiveRuns() {
      return activeRunRows.map((row) => ({ ...row }));
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listSchedules() {
      return scheduleRows.map((row) => ({ ...row }));
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async putConnectorState(scope: StateScope, stateByStream: Record<string, Record<string, unknown>>) {
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const connectorId = scope.connectorId;
      const now = nowIso();
      for (const [stream, value] of Object.entries(stateByStream)) {
        // BROKEN: key omits grant_id entirely.
        // biome-ignore lint/suspicious/noShadow: Shadowed name mirrors the protocol field being asserted.
        const idx = stateRows.findIndex((row) => row.connector_id === connectorId && row.stream === stream);
        const row = {
          connector_id: connectorId,
          state_json: JSON.stringify(value),
          stream,
          updated_at: now,
        };
        if (idx >= 0) {
          stateRows[idx] = row;
        } else {
          stateRows.push(row);
        }
      }
      return this.getConnectorState(scope);
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async setScheduleEnabled(connectorId: string, enabled: boolean): Promise<ScheduleRow> {
      const idx = scheduleRows.findIndex((row) => row.connector_id === connectorId);
      if (idx < 0) {
        throw new Error(`Schedule not found for connector: ${connectorId}`);
      }
      const current = scheduleRows[idx];
      if (!current) {
        throw new Error(`Schedule not found for connector: ${connectorId}`);
      }
      scheduleRows[idx] = {
        ...current,
        enabled,
        updated_at: nowIso(),
      };
      return { ...current, enabled, updated_at: scheduleRows[idx]?.updated_at ?? nowIso() };
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async setup() {
      stateRows = [];
      scheduleRows = [];
      activeRunRows = [];
      failedRunIds.clear();
    },

    async simulateRestart() {
      // BROKEN: no-op. The broken driver never reconciles abandoned
      // rows or adjudicates terminal events.
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async teardown() {
      stateRows = [];
      scheduleRows = [];
      activeRunRows = [];
      failedRunIds.clear();
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async upsertSchedule(connectorId: string, patch: SchedulePatch): Promise<ScheduleRow> {
      const now = nowIso();
      // BROKEN: append unconditionally.
      const row = {
        connector_id: connectorId,
        created_at: now,
        enabled: patch.enabled ?? true,
        interval_seconds: patch.interval_seconds,
        jitter_seconds: patch.jitter_seconds ?? 0,
        updated_at: now,
      };
      scheduleRows.push(row);
      return { ...row };
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async wasRunAdjudicatedAbandoned(runId: string): Promise<boolean> {
      return failedRunIds.has(runId);
    },
  };
}

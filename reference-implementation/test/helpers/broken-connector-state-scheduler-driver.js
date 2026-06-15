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
 * rows or surfaces a run.failed terminal event. That makes the
 * restart-reconciliation scenario a falsifiability hit too.
 *
 * This driver SHALL NOT be used as a production adapter or environment
 * profile. It is only imported from the falsifiability test.
 */

export function createBrokenInMemoryConnectorStateSchedulerDriver() {
  // BROKEN: keyed only by (connector_id, stream), losing grant scope.
  let stateRows = [];

  // BROKEN: appends instead of upserting on conflict.
  let scheduleRows = [];

  // BROKEN: no per-connector exclusivity; both rows persist on
  // collision.
  let activeRunRows = [];

  // The broken driver never emits terminal events.
  const failedRunIds = new Set();

  function nowIso() {
    return new Date().toISOString();
  }

  function applyAllowedStreams(state, allowedStreams) {
    if (!Array.isArray(allowedStreams)) return state;
    const set = new Set(allowedStreams);
    const filtered = {};
    for (const [stream, value] of Object.entries(state)) {
      if (set.has(stream)) filtered[stream] = value;
    }
    return filtered;
  }

  return {
    async setup() {
      stateRows = [];
      scheduleRows = [];
      activeRunRows = [];
      failedRunIds.clear();
    },

    async teardown() {
      stateRows = [];
      scheduleRows = [];
      activeRunRows = [];
      failedRunIds.clear();
    },

    async putConnectorState(scope, stateByStream) {
      const connectorId = scope.connectorId;
      const now = nowIso();
      for (const [stream, value] of Object.entries(stateByStream)) {
        // BROKEN: key omits grant_id entirely.
        const idx = stateRows.findIndex(
          (row) => row.connector_id === connectorId && row.stream === stream,
        );
        const row = {
          connector_id: connectorId,
          stream,
          state_json: JSON.stringify(value),
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

    async getConnectorState(scope, opts = {}) {
      const connectorId = scope.connectorId;
      const grantId = scope.grantId || null;
      const state = {};
      let updatedAt = null;
      for (const row of stateRows) {
        if (row.connector_id !== connectorId) continue;
        state[row.stream] = JSON.parse(row.state_json);
        if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
      }
      const projected = applyAllowedStreams(state, opts.allowedStreams);
      return {
        object: 'stream_state',
        connector_id: connectorId,
        grant_id: grantId,
        state: projected,
        updated_at: updatedAt,
      };
    },

    async upsertSchedule(connectorId, patch) {
      const now = nowIso();
      // BROKEN: append unconditionally.
      const row = {
        connector_id: connectorId,
        interval_seconds: patch.interval_seconds,
        jitter_seconds: patch.jitter_seconds ?? 0,
        enabled: patch.enabled ?? true,
        created_at: now,
        updated_at: now,
      };
      scheduleRows.push(row);
      return { ...row };
    },

    async getSchedule(connectorId) {
      const found = scheduleRows.find((row) => row.connector_id === connectorId);
      return found ? { ...found } : null;
    },

    async listSchedules() {
      return scheduleRows.map((row) => ({ ...row }));
    },

    async setScheduleEnabled(connectorId, enabled) {
      const idx = scheduleRows.findIndex((row) => row.connector_id === connectorId);
      if (idx < 0) {
        throw new Error(`Schedule not found for connector: ${connectorId}`);
      }
      scheduleRows[idx] = {
        ...scheduleRows[idx],
        enabled,
        updated_at: nowIso(),
      };
      return { ...scheduleRows[idx] };
    },

    async deleteSchedule(connectorId) {
      const before = scheduleRows.length;
      scheduleRows = scheduleRows.filter((row) => row.connector_id !== connectorId);
      return scheduleRows.length < before;
    },

    async insertActiveRun(connectorId, run) {
      // BROKEN: never reject or upsert; just append.
      activeRunRows.push({
        connector_id: connectorId,
        run_id: run.runId,
        run_generation: run.runGeneration ?? 1,
        trace_id: run.traceId,
        scenario_id: run.scenarioId,
        started_at: run.startedAt,
      });
    },

    async getActiveRun(connectorId) {
      const found = activeRunRows.find((row) => row.connector_id === connectorId);
      return found ? { ...found } : null;
    },

    async listActiveRuns() {
      return activeRunRows.map((row) => ({ ...row }));
    },

    async deleteActiveRun(connectorId, runId) {
      activeRunRows = activeRunRows.filter(
        (row) => !(row.connector_id === connectorId && row.run_id === runId),
      );
    },

    async simulateRestart() {
      // BROKEN: no-op. The broken driver never reconciles abandoned
      // rows or emits terminal events.
    },

    async wasRunMarkedFailed(runId) {
      return failedRunIds.has(runId);
    },
  };
}

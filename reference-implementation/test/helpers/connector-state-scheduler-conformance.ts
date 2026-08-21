// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector state, schedule, and active-run conformance harness.
 *
 * Test-only helper. Defines durable persistence obligations of three
 * adjacent reference-runtime concerns as reusable scenarios that any
 * candidate driver can be evaluated against by supplying a small driver
 * object:
 *
 *   - Connector sync state (`connector_state` and `grant_connector_state`):
 *     owner-scoped upsert/list, overwrite per `(connector_id, stream)`,
 *     grant-scoped isolation, allowed-stream filtering on read.
 *
 *   - Schedule registry (`connector_schedules`): one row per connector,
 *     create/update/list/pause/resume/delete behavior.
 *
 *   - Active-run registry (`controller_active_runs`): at most one active
 *     run per connector, lookup, delete, and abandoned-run cleanup at
 *     restart.
 *
 * The driver shape is intentionally narrow and *semantic*: it speaks in
 * reference-runtime lifecycle terms (put/get state, upsert/list/delete
 * schedule, insert/list/delete active run, simulate restart) and does not
 * expose raw SQL, table names, or a generic repository surface. It is not
 * exported from production code and SHALL NOT be treated as a production
 * `ConnectorStateStore` / `SchedulerStore` / `ActiveRunStore` contract.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void
 *     async teardown(): void
 *
 *     // Connector sync state
 *     //
 *     // `scope` is `{ connectorId, grantId? }`. When `grantId` is null or
 *     // absent the call addresses owner-scoped state; otherwise it
 *     // addresses grant-scoped state for that grant.
 *     //
 *     // `stateByStream` is `{ [streamName]: cursorObject }` — one cursor
 *     // object per stream; the driver MUST persist every entry as a
 *     // separate `(scope, stream)` row.
 *     //
 *     // Returns the canonical projection:
 *     //   { object: 'stream_state', connector_id, grant_id, state, updated_at }
 *     async putConnectorState(scope, stateByStream): StateProjection
 *
 *     // Read state for a scope. `allowedStreams` (optional array of stream
 *     // names) narrows the projection to the listed streams; rows that
 *     // are not in the set are filtered out without being deleted.
 *     async getConnectorState(scope, { allowedStreams } = {}): StateProjection
 *
 *     // Schedule registry
 *     //
 *     // `patch` mirrors the runtime controller's `ConnectorSchedulePatch`:
 *     //   { interval_seconds, jitter_seconds?, enabled? }
 *     // The driver MUST persist exactly one row per connector and MUST
 *     // preserve `created_at` across updates.
 *     async upsertSchedule(connectorId, patch): ScheduleSummary
 *     async getSchedule(connectorId): ScheduleSummary | null
 *     async listSchedules(): ScheduleSummary[]
 *     async setScheduleEnabled(connectorId, enabled): ScheduleSummary
 *     // Returns true if a row was deleted, false if the connector had no
 *     // schedule. Repeated delete on the same connector returns false.
 *     async deleteSchedule(connectorId): boolean
 *
 *     // Active-run registry
 *     //
 *     // `run` is `{ runId, traceId, scenarioId, startedAt }`. The driver
 *     // MUST enforce one active row per connector and a unique run_id
 *     // across the registry. Duplicate admission MUST fail closed and
 *     // preserve the incumbent row.
 *     async insertActiveRun(connectorId, run): boolean | void
 *     async getActiveRun(connectorId): ActiveRunSummary | null
 *     async listActiveRuns(): ActiveRunSummary[]
 *     async deleteActiveRun(connectorId, runId): void
 *
 *     // Simulate a process restart, running BOTH halves of the real boot
 *     // sequence: release the flight claims the dead incarnation left
 *     // behind, then run the successor's spine-driven adjudication. After
 *     // this resolves the driver MUST report zero active runs and MUST
 *     // have adjudicated `run.abandoned` for any previously-active run
 *     // that had not already reached a terminal state.
 *     //
 *     // Releasing claims alone does NOT satisfy this: it writes no
 *     // terminal event, so a driver that stopped there would report a
 *     // clean registry while every interrupted run stayed unadjudicated.
 *     //
 *     // The driver SHALL provide a way to inspect the abandonment verdict
 *     // for a run via `wasRunAdjudicatedAbandoned(runId)` so the harness
 *     // can prove the effect without coupling to the spine schema.
 *     async simulateRestart(): void
 *     async wasRunAdjudicatedAbandoned(runId): boolean
 *   }
 *
 * Spec: openspec/changes/add-connector-state-scheduler-conformance-harness/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";

import { emitControllerBootedAndStashEpoch, reconcileOrphanedRunsAtBoot } from "../../lib/controller-boot.ts";
import { clearCurrentBootEpoch, emitSpineEvent, getCurrentBootEpoch } from "../../lib/spine.ts";
import { getDb } from "../../server/db.ts";

/**
 * Announce a harness run on the spine the way a real run announces itself.
 *
 * The active-run registry and the spine are two different records of the
 * same fact, and only the spine one is adjudicable: the boot reconciler
 * selects orphans by scanning `run.started` events that lack a terminal
 * event, never by reading `controller_active_runs`. A driver that wrote
 * only the flight row would leave the restart scenario with nothing for
 * reconciliation to find, which is how it came to assert an outcome no
 * mechanism under test produced.
 *
 * The spine rejects an unstamped `run.started`, and the stamp is supplied
 * by the emitting caller rather than injected downstream — see
 * `runConnector` in `runtime/index.ts`, which this mirrors. Callers must
 * therefore have booted an epoch first.
 */
export async function announceHarnessRunStarted(
  connectorId: string,
  run: { runId: string; scenarioId: string; startedAt: string; traceId: string }
): Promise<void> {
  const bootEpoch = getCurrentBootEpoch();
  if (!bootEpoch) {
    throw new Error("announceHarnessRunStarted: no boot epoch; driver setup must run the boot sequence first");
  }
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: {
      boot_epoch: bootEpoch.boot_epoch,
      connector_instance_id: connectorId,
      controller_id: bootEpoch.controller_id,
      seq: bootEpoch.seq,
      source: connectorId,
    },
    event_type: "run.started",
    object_id: run.runId,
    object_type: "run",
    occurred_at: run.startedAt,
    run_id: run.runId,
    scenario_id: run.scenarioId,
    status: "started",
    trace_id: run.traceId,
  });
}

/**
 * True when the spine records the `run.abandoned` verdict for this run.
 *
 * Deliberately narrower than the reference's `spineCheckRunTerminal`
 * probe, which answers "is this run terminal at all" and is satisfied by
 * `run.completed` and `run.failed` too. The restart scenario exists to pin
 * WHICH terminal state an interrupted run earns, so a probe that cannot
 * tell the verdicts apart would not pin it.
 *
 * Reads the spine through the shared SQLite handle, the same way
 * `boot-orphan-reconciliation.test.ts` inspects reconciliation output.
 */
export function spineHasRunAbandoned(runId: string): boolean {
  const db = getDb() as unknown as {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
  };
  const row = db
    .prepare("SELECT 1 AS present FROM spine_events WHERE run_id = ? AND event_type = 'run.abandoned' LIMIT 1")
    .get(runId);
  return Boolean(row);
}

/**
 * Run the boot sequence a successor process runs, in the production order:
 * emit `controller.booted` to establish this incarnation's epoch, then let
 * `reconcileOrphanedRunsAtBoot` adjudicate every run the previous epoch
 * left unfinished.
 *
 * Mirrors `startServer` (`server/index.ts`), which is the only other caller
 * of this pair. Drivers delegate here rather than reimplementing it so the
 * harness keeps exercising the real adjudicator — and so this seam moves in
 * one place when adjudication becomes a run-lifecycle transition.
 */
export async function runHarnessBootReconciliation(): Promise<void> {
  clearCurrentBootEpoch();
  const bootEpoch = await emitControllerBootedAndStashEpoch();
  await reconcileOrphanedRunsAtBoot(bootEpoch);
}

interface StateProjection {
  connector_id: string;
  grant_id: string | null;
  object: string;
  state: Readonly<Record<string, unknown>>;
  updated_at: string | null;
}

interface ScheduleSummary {
  connector_id: string;
  created_at: string;
  enabled: boolean;
  interval_seconds: number;
  jitter_seconds: number;
  updated_at: string;
}

interface ActiveRunSummary {
  connector_id: string;
  run_id: string;
  scenario_id: string;
  started_at: string;
  trace_id: string;
}

interface SchedulerDriver {
  deleteActiveRun: (connectorId: string, runId: string) => Promise<void>;
  deleteSchedule: (connectorId: string) => Promise<boolean>;
  getActiveRun: (connectorId: string) => Promise<ActiveRunSummary | null>;
  getConnectorState: (
    scope: { connectorId: string; grantId?: string | null },
    options?: { allowedStreams?: string[] }
  ) => Promise<StateProjection>;
  getSchedule: (connectorId: string) => Promise<ScheduleSummary | null>;
  insertActiveRun: (
    connectorId: string,
    run: { runId: string; traceId: string; scenarioId: string; startedAt: string }
  ) => Promise<boolean | undefined>;
  listActiveRuns: () => Promise<ActiveRunSummary[]>;
  listSchedules: () => Promise<ScheduleSummary[]>;
  putConnectorState: (
    scope: { connectorId: string; grantId?: string | null },
    state: Record<string, Record<string, unknown>>
  ) => Promise<StateProjection>;
  setScheduleEnabled: (connectorId: string, enabled: boolean) => Promise<ScheduleSummary>;
  setup: () => Promise<void>;
  simulateRestart: () => Promise<void>;
  teardown: () => Promise<void>;
  upsertSchedule: (
    connectorId: string,
    patch: { interval_seconds: number; jitter_seconds?: number; enabled?: boolean }
  ) => Promise<ScheduleSummary>;
  wasRunAdjudicatedAbandoned: (runId: string) => Promise<boolean>;
}

type TestFn = (name: string, fn: () => Promise<void>) => void;

export const CONNECTOR_A = "https://test.pdpp.dev/connectors/conformance-a";
export const CONNECTOR_B = "https://test.pdpp.dev/connectors/conformance-b";

export const STREAM_X = "stream_x";
export const STREAM_Y = "stream_y";

export const GRANT_1 = "grant_conformance_1";
export const GRANT_2 = "grant_conformance_2";

/**
 * Run the connector-state / schedule / active-run conformance suite against
 * a driver.
 *
 * @param {object} options
 * @param {string} options.label                                       distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  test runner (e.g. `node:test`'s `test`)
 * @param {() => Promise<object> | object} options.makeDriver           returns a fresh driver per scenario
 */
export function runConnectorStateSchedulerConformance({
  label,
  test,
  makeDriver,
}: {
  label: string;
  test: TestFn;
  makeDriver: () => Promise<SchedulerDriver> | SchedulerDriver;
}): void {
  const t = (name: string, fn: () => Promise<void>) => test(`[conformance:${label}] ${name}`, fn);

  // ────────────────────────────────────────────────────────────────────────
  // Connector state — owner-scoped
  // ────────────────────────────────────────────────────────────────────────

  // Pins the owner-scoped upsert/list invariant: each `(connector_id,
  // stream)` writes a single row, multiple streams round-trip together,
  // and the projection's `connector_id`/`grant_id` reflect the addressed
  // scope.
  t("owner-scoped state put/get round-trips multiple streams under one connector", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const written = await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        {
          [STREAM_X]: { cursor: "x:1", items: 3 },
          [STREAM_Y]: { cursor: "y:7", items: 9 },
        }
      );
      assert.equal(written.object, "stream_state");
      assert.equal(written.connector_id, CONNECTOR_A);
      assert.equal(written.grant_id, null);

      const got = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      assert.equal(got.object, "stream_state");
      assert.equal(got.connector_id, CONNECTOR_A);
      assert.equal(got.grant_id, null);
      assert.deepEqual(got.state, {
        [STREAM_X]: { cursor: "x:1", items: 3 },
        [STREAM_Y]: { cursor: "y:7", items: 9 },
      });
      assert.ok(typeof got.updated_at === "string" && got.updated_at.length > 0);
    } finally {
      await driver.teardown();
    }
  });

  // Pins the per-(connector, stream) overwrite rule: writing the same
  // stream twice must replace the prior cursor rather than appending or
  // duplicating rows.
  t("owner-scoped state overwrites per (connector, stream) on second put", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState({ connectorId: CONNECTOR_A }, { [STREAM_X]: { cursor: "x:1" } });
      await driver.putConnectorState({ connectorId: CONNECTOR_A }, { [STREAM_X]: { cursor: "x:2" } });

      const got = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      assert.deepEqual(got.state, { [STREAM_X]: { cursor: "x:2" } });
    } finally {
      await driver.teardown();
    }
  });

  // Pins inter-connector isolation for owner-scoped state: reading state
  // for one connector must not surface streams persisted under another
  // connector with the same stream name.
  t("owner-scoped state for connector A is isolated from connector B", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState({ connectorId: CONNECTOR_A }, { [STREAM_X]: { source: "a" } });
      await driver.putConnectorState({ connectorId: CONNECTOR_B }, { [STREAM_X]: { source: "b" } });

      const a = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      const b = await driver.getConnectorState({ connectorId: CONNECTOR_B });
      assert.deepEqual(a.state, { [STREAM_X]: { source: "a" } });
      assert.deepEqual(b.state, { [STREAM_X]: { source: "b" } });
    } finally {
      await driver.teardown();
    }
  });

  // Pins read-side narrowing by `allowedStreams`. The reference helper
  // `getSyncState` accepts `allowedStreams` and filters out rows not in
  // the set. This is the only stream-allowlist check the helper
  // currently performs; route handlers enforce manifest membership and
  // grant-scope membership separately. Drivers MUST implement the read
  // filter; pre-write rejection of unknown streams is *not* required at
  // this layer (see "Deferrals" comment block at the file foot).
  t("owner-scoped state read narrows by allowedStreams without deleting other rows", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A },
        {
          [STREAM_X]: { cursor: "x:1" },
          [STREAM_Y]: { cursor: "y:1" },
        }
      );

      const narrow = await driver.getConnectorState({ connectorId: CONNECTOR_A }, { allowedStreams: [STREAM_X] });
      assert.deepEqual(narrow.state, { [STREAM_X]: { cursor: "x:1" } });

      // The narrowing is read-only; subsequent unfiltered read still
      // returns both streams. This catches drivers that mistakenly
      // delete or hide rows when an allowlist is applied.
      const wide = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      assert.deepEqual(wide.state, {
        [STREAM_X]: { cursor: "x:1" },
        [STREAM_Y]: { cursor: "y:1" },
      });
    } finally {
      await driver.teardown();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Connector state — grant-scoped
  // ────────────────────────────────────────────────────────────────────────

  // Pins owner/grant isolation: a grant-scoped write MUST NOT surface in
  // owner-scoped reads, and an owner-scoped write MUST NOT surface in
  // grant-scoped reads. This is the durable invariant that lets later
  // adapters split the two scopes into different tables or partitions
  // without changing semantics.
  t("grant-scoped state is isolated from owner-scoped state on the same connector", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState({ connectorId: CONNECTOR_A }, { [STREAM_X]: { who: "owner" } });
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A, grantId: GRANT_1 },
        { [STREAM_X]: { who: "grant_1" } }
      );

      const owner = await driver.getConnectorState({ connectorId: CONNECTOR_A });
      const grant = await driver.getConnectorState({ connectorId: CONNECTOR_A, grantId: GRANT_1 });
      assert.deepEqual(owner.state, { [STREAM_X]: { who: "owner" } });
      assert.equal(owner.grant_id, null);
      assert.deepEqual(grant.state, { [STREAM_X]: { who: "grant_1" } });
      assert.equal(grant.grant_id, GRANT_1);
    } finally {
      await driver.teardown();
    }
  });

  // Pins inter-grant isolation under a single connector: two distinct
  // grants must not bleed into each other.
  t("grant-scoped state for grant 1 is isolated from grant 2 on the same connector", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A, grantId: GRANT_1 },
        { [STREAM_X]: { who: "grant_1" } }
      );
      await driver.putConnectorState(
        { connectorId: CONNECTOR_A, grantId: GRANT_2 },
        { [STREAM_X]: { who: "grant_2" } }
      );

      const g1 = await driver.getConnectorState({ connectorId: CONNECTOR_A, grantId: GRANT_1 });
      const g2 = await driver.getConnectorState({ connectorId: CONNECTOR_A, grantId: GRANT_2 });
      assert.deepEqual(g1.state, { [STREAM_X]: { who: "grant_1" } });
      assert.deepEqual(g2.state, { [STREAM_X]: { who: "grant_2" } });
    } finally {
      await driver.teardown();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Schedule registry
  // ────────────────────────────────────────────────────────────────────────

  // Pins the create case: an upsert against an empty registry produces
  // exactly one row whose fields reflect the patch and whose
  // `created_at`/`updated_at` are populated.
  t("schedule upsert creates one row per connector with patch fields populated", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const created = await driver.upsertSchedule(CONNECTOR_A, {
        enabled: true,
        interval_seconds: 1800,
        jitter_seconds: 30,
      });
      assert.equal(created.connector_id, CONNECTOR_A);
      assert.equal(created.interval_seconds, 1800);
      assert.equal(created.jitter_seconds, 30);
      assert.equal(created.enabled, true);
      assert.ok(typeof created.created_at === "string" && created.created_at.length > 0);
      assert.ok(typeof created.updated_at === "string" && created.updated_at.length > 0);

      const list = await driver.listSchedules();
      assert.equal(list.length, 1);
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const listed = list[0];
      assert.ok(listed);
      assert.equal(listed.connector_id, CONNECTOR_A);
    } finally {
      await driver.teardown();
    }
  });

  // Pins the update case: a second upsert on the same connector must
  // change interval/jitter/enabled while preserving connector identity
  // and `created_at`. This is the invariant that catches drivers that
  // (a) insert a duplicate row instead of updating, or (b) overwrite
  // `created_at` on update.
  t("schedule upsert updates existing row in place and preserves created_at", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const first = await driver.upsertSchedule(CONNECTOR_A, {
        enabled: true,
        interval_seconds: 1800,
        jitter_seconds: 30,
      });
      const second = await driver.upsertSchedule(CONNECTOR_A, {
        enabled: false,
        interval_seconds: 3600,
        jitter_seconds: 60,
      });

      assert.equal(second.connector_id, CONNECTOR_A);
      assert.equal(second.interval_seconds, 3600);
      assert.equal(second.jitter_seconds, 60);
      assert.equal(second.enabled, false);
      assert.equal(second.created_at, first.created_at, "second upsert must preserve the original created_at");

      const list = await driver.listSchedules();
      assert.equal(list.length, 1, "second upsert must update in place rather than insert a duplicate");
    } finally {
      await driver.teardown();
    }
  });

  // Pins the pause/resume invariant: toggling enabled must not lose the
  // current interval or jitter. Drivers that recompute defaults on
  // toggle would fail this scenario.
  t("schedule pause then resume toggles enabled without losing interval or jitter", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.upsertSchedule(CONNECTOR_A, {
        enabled: true,
        interval_seconds: 1800,
        jitter_seconds: 30,
      });

      const paused = await driver.setScheduleEnabled(CONNECTOR_A, false);
      assert.equal(paused.enabled, false);
      assert.equal(paused.interval_seconds, 1800);
      assert.equal(paused.jitter_seconds, 30);

      const resumed = await driver.setScheduleEnabled(CONNECTOR_A, true);
      assert.equal(resumed.enabled, true);
      assert.equal(resumed.interval_seconds, 1800);
      assert.equal(resumed.jitter_seconds, 30);
    } finally {
      await driver.teardown();
    }
  });

  // Pins listing order independence and per-connector identity: two
  // connectors with schedules surface as two distinct rows with the
  // right fields. We assert by-id rather than by-position to keep the
  // harness driver-agnostic about ordering.
  t("schedule list surfaces all configured connectors", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.upsertSchedule(CONNECTOR_A, { interval_seconds: 60 });
      await driver.upsertSchedule(CONNECTOR_B, { interval_seconds: 120 });

      const list = await driver.listSchedules();
      assert.equal(list.length, 2);
      const byId = Object.fromEntries(list.map((row) => [row.connector_id, row]));
      assert.ok(byId[CONNECTOR_A]);
      assert.ok(byId[CONNECTOR_B]);
      assert.equal(byId[CONNECTOR_A].interval_seconds, 60);
      assert.equal(byId[CONNECTOR_B].interval_seconds, 120);
    } finally {
      await driver.teardown();
    }
  });

  // Pins delete and idempotence-of-absence: the first delete of a known
  // schedule reports success (true), the second delete reports
  // not-found (false), and the row is gone from list/get. Mirrors the
  // controller's current `deleteSchedule` returning a boolean and the
  // route's 204→404 response sequence.
  t("schedule delete removes the row and repeated delete reports not-found", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.upsertSchedule(CONNECTOR_A, { interval_seconds: 1800 });
      const first = await driver.deleteSchedule(CONNECTOR_A);
      assert.equal(first, true, "first delete should report a row was removed");

      const got = await driver.getSchedule(CONNECTOR_A);
      assert.equal(got, null, "schedule should be gone after delete");

      const second = await driver.deleteSchedule(CONNECTOR_A);
      assert.equal(second, false, "repeated delete should report not-found");
    } finally {
      await driver.teardown();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Active-run registry
  // ────────────────────────────────────────────────────────────────────────

  // Pins per-connector exclusivity. Duplicate admission may throw or no-op,
  // but the incumbent live row must remain intact and the newer row must not
  // win by overwrite.
  t("active-run registry preserves the incumbent row on duplicate admission", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const firstInsert = await driver.insertActiveRun(CONNECTOR_A, {
        runId: "run_one",
        scenarioId: "scn_1",
        startedAt: "2026-04-28T00:00:00.000Z",
        traceId: "trc_1",
      });
      assert.notEqual(firstInsert, false, "first insert should succeed or be ignored only by a broken driver");

      let collisionThrew = false;
      // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
      // biome-ignore lint/suspicious/noImplicitAnyLet: Fixture accumulator is intentionally inferred from runtime test data.
      let collisionResult;
      try {
        collisionResult = await driver.insertActiveRun(CONNECTOR_A, {
          runId: "run_two",
          scenarioId: "scn_2",
          startedAt: "2026-04-28T00:01:00.000Z",
          traceId: "trc_2",
        });
      } catch {
        collisionThrew = true;
      }

      const list = await driver.listActiveRuns();
      const forA = list.filter((row) => row.connector_id === CONNECTOR_A);
      assert.equal(forA.length, 1, "connector A must have exactly one active row");
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const incumbent = forA[0];
      assert.ok(incumbent);
      assert.equal(incumbent.run_id, "run_one", "duplicate admission must preserve the incumbent run id");
      if (!collisionThrew) {
        assert.notEqual(collisionResult, true, "duplicate insert must not report a successful replacement");
      }
    } finally {
      await driver.teardown();
    }
  });

  // Pins cross-connector run_id uniqueness. The current SQLite schema
  // declares `run_id UNIQUE` on `controller_active_runs` (and an index
  // on the column) precisely so a run id minted for one connector
  // cannot also be minted for another. Drivers MUST either reject the
  // duplicate insert (throw) or ignore it (no-op); they MUST NOT
  // rebind the existing run id from connector A to connector B. Either
  // way the original connector A row stays intact, the registry holds
  // exactly one row under that run id, and connector B has no active
  // row. A driver that silently moves the run id to connector B
  // (e.g. UPDATE … WHERE run_id = ?) fails this scenario, as does a
  // driver that lets both rows persist.
  t("active-run run_id is unique across connectors", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.insertActiveRun(CONNECTOR_A, {
        runId: "run_shared",
        scenarioId: "scn_a",
        startedAt: "2026-04-28T00:00:00.000Z",
        traceId: "trc_a",
      });

      try {
        await driver.insertActiveRun(CONNECTOR_B, {
          runId: "run_shared",
          scenarioId: "scn_b",
          startedAt: "2026-04-28T00:01:00.000Z",
          traceId: "trc_b",
        });
      } catch {
        // Throwing the duplicate is acceptable; the row-state
        // assertions below pin the invariant whether the driver
        // throws or no-ops.
      }

      const list = await driver.listActiveRuns();
      const sharedRows = list.filter((row) => row.run_id === "run_shared");
      assert.equal(sharedRows.length, 1, "run_id must be unique across the active-run registry");
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const shared = sharedRows[0];
      assert.ok(shared);
      assert.equal(
        shared.connector_id,
        CONNECTOR_A,
        "duplicate run_id must not rebind the existing row to a different connector"
      );
      assert.equal(
        shared.trace_id,
        "trc_a",
        "original row trace_id must remain intact after a duplicate run_id attempt"
      );
      const onB = await driver.getActiveRun(CONNECTOR_B);
      assert.equal(onB, null, "connector B must have no active row when its insert duplicated an existing run_id");
    } finally {
      await driver.teardown();
    }
  });

  // Pins lookup-by-connector. `getActiveRun(connectorId)` must surface
  // the registry row's run/trace/scenario/started_at for that
  // connector, and return null when nothing is active.
  t("active-run lookup by connector returns null when absent and the row when present", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      assert.equal(await driver.getActiveRun(CONNECTOR_A), null);

      await driver.insertActiveRun(CONNECTOR_A, {
        runId: "run_lookup",
        scenarioId: "scn_lookup",
        startedAt: "2026-04-28T00:00:00.000Z",
        traceId: "trc_lookup",
      });

      const got = await driver.getActiveRun(CONNECTOR_A);
      assert.ok(got, "expected an active-run row");
      assert.equal(got.connector_id, CONNECTOR_A);
      assert.equal(got.run_id, "run_lookup");
      assert.equal(got.trace_id, "trc_lookup");
    } finally {
      await driver.teardown();
    }
  });

  // Pins delete + run-id guard. The current reference deletes by
  // `(connector_id, run_id)` so a stale delete with the wrong run_id
  // does not race a freshly-overwritten row. Drivers MUST honor that
  // guard.
  t("active-run delete is scoped by (connector_id, run_id) and does not affect a different run id", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.insertActiveRun(CONNECTOR_A, {
        runId: "run_current",
        scenarioId: "scn",
        startedAt: "2026-04-28T00:00:00.000Z",
        traceId: "trc",
      });

      // Stale delete from a previously-active run id; must not clear the row.
      await driver.deleteActiveRun(CONNECTOR_A, "run_stale");
      const stillThere = await driver.getActiveRun(CONNECTOR_A);
      assert.ok(stillThere, "mismatched run_id delete must not remove the active row");
      assert.equal(stillThere.run_id, "run_current");

      // Correct delete clears it.
      await driver.deleteActiveRun(CONNECTOR_A, "run_current");
      assert.equal(await driver.getActiveRun(CONNECTOR_A), null);
    } finally {
      await driver.teardown();
    }
  });

  // Pins startup reconciliation. After a simulated restart any rows that
  // had been left in the active registry must be cleared, and each run the
  // dead incarnation left unfinished must have been adjudicated
  // `run.abandoned` — not `run.failed`. Nothing at restart observed a
  // failure; it observed the absence of a report from a process that is
  // gone, and only abandonment says that honestly.
  //
  // The harness asks the driver via a narrow
  // `wasRunAdjudicatedAbandoned` accessor instead of reading the spine
  // table directly so the contract is at the lifecycle layer.
  t("simulated restart clears abandoned runs and adjudicates each run.abandoned", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.insertActiveRun(CONNECTOR_A, {
        runId: "run_abandoned_a",
        scenarioId: "scn_a",
        startedAt: "2026-04-28T00:00:00.000Z",
        traceId: "trc_a",
      });
      await driver.insertActiveRun(CONNECTOR_B, {
        runId: "run_abandoned_b",
        scenarioId: "scn_b",
        startedAt: "2026-04-28T00:01:00.000Z",
        traceId: "trc_b",
      });

      await driver.simulateRestart();

      const remaining = await driver.listActiveRuns();
      assert.deepEqual(remaining, [], "restart must clear stale active-run rows");

      assert.equal(await driver.wasRunAdjudicatedAbandoned("run_abandoned_a"), true);
      assert.equal(await driver.wasRunAdjudicatedAbandoned("run_abandoned_b"), true);
    } finally {
      await driver.teardown();
    }
  });
}

/*
 * Deferrals (deliberately not enforced at the persistence layer)
 *
 * - Manifest-stream membership: route handlers (`PUT /v1/state/:connectorId`)
 *   reject writes whose stream is not declared in the connector manifest.
 *   The persistence helper itself accepts any stream name. Tests covering
 *   manifest enforcement live in `pdpp.test.js`.
 *
 * - Grant scope rejection: route handlers reject writes whose stream is
 *   not in the grant's `grantedStreams` set. The helper accepts the write
 *   and only filters the *projection* via `allowedStreams`. Coverage for
 *   the route-side rejection lives in `pdpp.test.js`.
 *
 * - Schedule input validation: the controller's `validateScheduleInput`
 *   throws `ControllerError('invalid_request')` on bad patches, but that
 *   is policy above persistence. The harness covers persistence behavior
 *   for valid inputs; controller-level tests in `control-actions.test.js`
 *   cover input rejection.
 *
 * - `minimum_interval_warning`: the controller composes a policy warning
 *   based on the connector manifest's `refresh_policy.minimum_interval_seconds`.
 *   Warning composition is policy-not-persistence; coverage stays in
 *   `control-actions.test.js`.
 *
 * - Active-run interaction projection: pending interactions are tracked
 *   in an in-memory `activeRunInteractions` map and a separate
 *   `run.interaction_required` spine event, not in
 *   `controller_active_runs`. Coverage stays in
 *   `run-interaction-control.test.js`.
 *
 * If a future adapter changes any of these surfaces, the harness must be
 * updated explicitly rather than implicitly extended via route tests.
 */

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manual provider-safety gate tests.
 *
 * Verifies that ordinary manual `Sync now` requests are blocked when a
 * provider-pressure cooldown is active, and that an explicit `force: true`
 * flag (a separately-named action) is required to bypass the cooldown.
 *
 * Acceptance criteria from the workstream brief:
 *   1. Ordinary manual request during provider-pressure cooldown does not
 *      start provider work and surfaces cooling-off state.
 *   2. Explicit force override is required to bypass the pressure safety gate.
 *   3. Cooling-off is not rendered as `needs_attention` and does not imply
 *      owner action.
 *
 * All tests use createController with a fake detail-gap store. The cooldown
 * gate fires before getSyncState is reached, so no DB or startServer is
 * needed for the gate-behavior tests. For pass-gate cases, errors from deeper
 * DB layers are expected and asserted to NOT be provider_pressure_cooldown.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Controller, createController } from "../runtime/controller.ts";
import type {
  ScheduleRecord,
  SchedulerLastRunTimeRecord,
  SchedulerRunHistoryRecord,
  SchedulerStore,
} from "../server/stores/scheduler-store.ts";

interface PendingDetailGapRow {
  readonly attempt_count?: number | null;
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly detail_class?: string | null;
  readonly last_attempt_at?: string | null;
  readonly last_error?: { readonly class?: unknown } | null;
  readonly next_attempt_after?: string | null;
  readonly reason?: string | null;
  readonly status?: string | null;
  readonly stream?: string | null;
  readonly updated_at?: string | null;
}

interface DetailGapStoreCall {
  readonly connectorId: string;
  readonly options: { limit?: number } | undefined;
}

type ControllerThrownError = Error & {
  code?: string;
  nextEligibleAt?: string;
  pendingPressureGapCount?: number;
  recoveryAdmissionReason?: string;
};

interface DetailGapReadStore {
  listPendingGapsForConnector: (connectorId: string, options?: { limit?: number }) => readonly PendingDetailGapRow[];
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

// A connector that exits immediately so run-now drains cleanly on teardown.
function buildImmediateConnectorFixture(dir: string): string {
  const path = join(dir, "connector.mjs");
  writeFileSync(
    path,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return path;
}

// Fake detail-gap store returning a configurable set of pending gaps.
function fakeDetailGapStore(
  pendingGaps: readonly PendingDetailGapRow[] = [],
  calls: DetailGapStoreCall[] = []
): DetailGapReadStore {
  return {
    listPendingGapsForConnector: (connectorId, options) => {
      calls.push({ connectorId, options });
      return pendingGaps;
    },
  };
}

interface FakeSchedulerStoreOptions {
  lastRunTimes?: readonly SchedulerLastRunTimeRecord[];
  runHistory?: readonly SchedulerRunHistoryRecord[];
  // Test fixtures deliberately supply only the fields the controller's
  // cooldown/gate logic under test actually reads, not a full ScheduleRecord.
  schedule?: Partial<ScheduleRecord> | null;
}

// Fake scheduler store — configurable schedule/last-run anchors, no DB needed.
// getActiveRun/getLatestRunHistoryForConnection are stubbed to satisfy
// SchedulerStore; the pre-gate tests below never reach either (the cooldown
// gate fires before the controller consults active-run or history state).
function fakeSchedulerStore({
  schedule = null,
  lastRunTimes = [],
  runHistory = [],
}: FakeSchedulerStoreOptions = {}): SchedulerStore {
  return {
    appendRunHistory: () => {
      /* intentionally empty */
    },
    createSchedule: () => {
      /* intentionally empty */
    },
    deleteActiveRun: () => {
      /* intentionally empty */
    },
    deleteSchedule: () => {
      /* intentionally empty */
    },
    getActiveRun: () => null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => schedule as ScheduleRecord | null,
    listActiveRuns: () => [],
    listLastRunTimes: () => lastRunTimes,
    listRunHistory: () => runHistory,
    listSchedules: () => [],
    setScheduleEnabled: () => {
      /* intentionally empty */
    },
    updateSchedule: () => {
      /* intentionally empty */
    },
    upsertActiveRun: () => true,
    upsertLastRunTime: () => {
      /* intentionally empty */
    },
  };
}

// A minimal, production-shaped admission fixture. Every `runNow` call in this
// file that omits `connectorInstanceId` relies on this suite's fixture data
// (`pressureGap`/`lastRunTimes` rows keyed by bare `connector_id`, with
// `connector_instance_id: null`) matching the legacy "default instance id
// equals connectorId" convention that `collectPendingPressureGaps`
// (runtime/controller.ts) reads via `row.connector_instance_id || connectorId`.
// Echoing `connectorId` itself here (rather than synthesizing a distinct
// default-account id) keeps that equality true and preserves the exact
// pressure-gate behavior under test.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? connectorId;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

// One pending pressure gap (the shape the controller reads from the store).
function pressureGap(overrides: Partial<PendingDetailGapRow> = {}): PendingDetailGapRow {
  return {
    attempt_count: 2,
    connector_instance_id: null,
    last_attempt_at: new Date().toISOString(),
    next_attempt_after: null,
    reason: "upstream_pressure",
    stream: null,
    updated_at: null,
    ...overrides,
  };
}

// A minimal in-memory manifest for the test connector.
const TEST_CONNECTOR_ID = "test/immediate";
function buildManifest(): { connector_id: string; version: string; streams: { name: string; fields: unknown[] }[] } {
  return { connector_id: TEST_CONNECTOR_ID, streams: [{ fields: [], name: "items" }], version: "1.0.0" };
}

// ─── Strategy A: pre-gate tests (no DB) ──────────────────────────────────────
// The cooldown gate fires before getSyncState is reached, so we can use
// createController directly with fake stores — no startServer / DB needed.

async function withPreGateController(
  detailGapStoreFn: () => DetailGapReadStore,
  fn: (controller: Controller) => Promise<void>,
  schedulerStoreOptions: FakeSchedulerStoreOptions = {}
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-manual-safety-"));
  const connectorPath = buildImmediateConnectorFixture(tmpDir);
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => connectorPath,
    detailGapStore: detailGapStoreFn(),
    schedulerStore: fakeSchedulerStore(schedulerStoreOptions),
  });
  try {
    await fn(controller);
  } finally {
    await controller.drainActiveRuns(2000).catch(() => {
      /* intentionally empty */
    });
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("ordinary manual run during provider-pressure cooldown is blocked with provider_pressure_cooldown", async () => {
  const lastRun = Date.now();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 2 })]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      assert.ok(err, "runNow should have thrown during provider-pressure cooldown");
      assert.equal(err.code, "provider_pressure_cooldown", `expected provider_pressure_cooldown, got: ${err.code}`);
      assert.ok(typeof err.nextEligibleAt === "string", "error must carry nextEligibleAt ISO timestamp");
      assert.ok(typeof err.pendingPressureGapCount === "number", "error must carry pendingPressureGapCount");
      assert.ok(err.pendingPressureGapCount > 0, "pendingPressureGapCount must be > 0");
      // Task 2.3: the manual denial carries the connector-neutral admission
      // reason class, matching an automatic recovery-admission `cooldown` denial.
      assert.equal(
        err.recoveryAdmissionReason,
        "cooldown",
        "manual denial must carry the neutral admission reason class"
      );
    },
    {
      lastRunTimes: [
        {
          connector_id: TEST_CONNECTOR_ID,
          connector_instance_id: TEST_CONNECTOR_ID,
          last_run_time_ms: lastRun,
          updated_at: new Date(lastRun).toISOString(),
        },
      ],
      schedule: { interval_seconds: 60 },
    }
  );
});

test("stale provider-pressure rows do not re-arm the manual cooldown gate", async () => {
  const stalePressureAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 8, last_attempt_at: stalePressureAt })]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      if (err) {
        assert.notEqual(
          err.code,
          "provider_pressure_cooldown",
          `stale pressure evidence must not block manual run; got ${err.code}: ${err.message}`
        );
      }
    },
    {
      lastRunTimes: [
        {
          connector_id: TEST_CONNECTOR_ID,
          connector_instance_id: TEST_CONNECTOR_ID,
          last_run_time_ms: Date.now(),
          updated_at: new Date().toISOString(),
        },
      ],
      schedule: { interval_seconds: 60 },
    }
  );
});

test("provider_pressure_cooldown error carries a future nextEligibleAt when next_attempt_after is set", async () => {
  const futureFloor = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 0, next_attempt_after: futureFloor })]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      assert.ok(err, "should throw");
      assert.equal(err.code, "provider_pressure_cooldown");
      assert.ok(err.nextEligibleAt, "expected nextEligibleAt on the thrown error");
      const eligibleMs = Date.parse(err.nextEligibleAt);
      const floorMs = Date.parse(futureFloor);
      assert.ok(eligibleMs >= floorMs, `nextEligibleAt ${err.nextEligibleAt} should be >= floor ${futureFloor}`);
    }
  );
});

test("past next_attempt_after does not block an ordinary manual run", async () => {
  const pastFloor = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 0, next_attempt_after: pastFloor })]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      if (err) {
        assert.notEqual(
          err.code,
          "provider_pressure_cooldown",
          `past next_attempt_after must not block manual run; got ${err.code}: ${err.message}`
        );
      }
    }
  );
});

test("manual cooldown gate reads connector type and filters to the requested connection instance", async () => {
  const calls: DetailGapStoreCall[] = [];
  const futureFloor = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await withPreGateController(
    () =>
      fakeDetailGapStore(
        [
          pressureGap({ attempt_count: 7, connector_instance_id: "cin_other" }),
          pressureGap({ attempt_count: 2, connector_instance_id: "cin_target", next_attempt_after: futureFloor }),
        ],
        calls
      ),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, {
          connectorInstanceId: "cin_target",
          manifest: buildManifest(),
        });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      assert.ok(err, "target instance has a pressure gap and should be blocked");
      assert.equal(err.code, "provider_pressure_cooldown");
      assert.equal(err.pendingPressureGapCount, 1, "only the requested connection instance should count");
      assert.equal(calls.length, 1);
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const firstCall = calls[0];
      assert.ok(firstCall, "expected a detail-gap store call to have been recorded");
      assert.equal(firstCall.connectorId, TEST_CONNECTOR_ID, "store read is connector-type scoped, not cin-scoped");
      assert.deepEqual(firstCall.options, { limit: 200 });
    }
  );
});

test("manual cooldown gate uses recent run history when persisted last-run row is stale", async () => {
  const recent = Date.now();
  const stale = recent - 30 * 24 * 60 * 60 * 1000;
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 0, connector_instance_id: "cin_target" })]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, {
          connectorInstanceId: "cin_target",
          manifest: buildManifest(),
        });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      assert.ok(err, "recent skip history should keep the pressure cooldown active");
      assert.equal(err.code, "provider_pressure_cooldown");
    },
    {
      lastRunTimes: [
        {
          connector_id: TEST_CONNECTOR_ID,
          connector_instance_id: "cin_target",
          last_run_time_ms: stale,
          updated_at: new Date(stale).toISOString(),
        },
      ],
      runHistory: [
        {
          attempt: 0,
          checkpointSummary: null,
          completedAt: new Date(recent).toISOString(),
          connectorId: TEST_CONNECTOR_ID,
          connectorInstanceId: "cin_target",
          error: "source_pressure_cooldown_applied: fixture",
          knownGaps: [],
          recordsEmitted: 0,
          runId: null,
          source: { id: TEST_CONNECTOR_ID, kind: "connector" },
          startedAt: new Date(recent).toISOString(),
          status: "skipped",
        },
      ],
      schedule: { interval_seconds: 60 },
    }
  );
});

test("manual cooldown gate does not let recent skip history slide an elapsed pressure window", async () => {
  const recentSkip = Date.now();
  const stale = recentSkip - 30 * 24 * 60 * 60 * 1000;
  const pressureObserved = recentSkip - 10 * 60 * 1000;
  await withPreGateController(
    () =>
      fakeDetailGapStore([
        pressureGap({
          attempt_count: 0,
          connector_instance_id: "cin_target",
          last_attempt_at: null,
          updated_at: new Date(pressureObserved).toISOString(),
        }),
      ]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, {
          connectorInstanceId: "cin_target",
          manifest: buildManifest(),
        });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      if (err) {
        assert.notEqual(
          err.code,
          "provider_pressure_cooldown",
          `recent skip history must not slide elapsed pressure window; got ${err.code}: ${err.message}`
        );
      }
    },
    {
      lastRunTimes: [
        {
          connector_id: TEST_CONNECTOR_ID,
          connector_instance_id: "cin_target",
          last_run_time_ms: stale,
          updated_at: new Date(stale).toISOString(),
        },
      ],
      runHistory: [
        {
          attempt: 0,
          checkpointSummary: null,
          completedAt: new Date(recentSkip).toISOString(),
          connectorId: TEST_CONNECTOR_ID,
          connectorInstanceId: "cin_target",
          error: "source_pressure_cooldown_applied: fixture",
          knownGaps: [],
          recordsEmitted: 0,
          runId: null,
          source: { id: TEST_CONNECTOR_ID, kind: "connector" },
          startedAt: new Date(recentSkip).toISOString(),
          status: "skipped",
        },
      ],
      schedule: { interval_seconds: 60 },
    }
  );
});

test("ordinary manual run is allowed after provider-pressure cooldown has elapsed", async () => {
  const lastRun = Date.now() - 10 * 60 * 1000;
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 1, last_attempt_at: new Date(lastRun).toISOString() })]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      if (err) {
        assert.notEqual(
          err.code,
          "provider_pressure_cooldown",
          `elapsed pressure cooldown must not block manual run; got ${err.code}: ${err.message}`
        );
      }
    },
    {
      lastRunTimes: [
        {
          connector_id: TEST_CONNECTOR_ID,
          connector_instance_id: TEST_CONNECTOR_ID,
          last_run_time_ms: lastRun,
          updated_at: new Date(lastRun).toISOString(),
        },
      ],
      schedule: { interval_seconds: 60 },
    }
  );
});

test("cooling-off disposition does not set needs_attention flag", async () => {
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 2 })]),
    async (controller) => {
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch {
        /* expected */
      }
      assert.equal(
        controller.isNeedsHuman(TEST_CONNECTOR_ID),
        false,
        "provider-pressure cooldown must not set needs_attention"
      );
    }
  );
});

test("provider_pressure_cooldown error code maps to HTTP 425 in ref-error-status", async () => {
  const { codeToStatus } = await import("../server/routes/ref-error-status.ts");
  assert.equal(codeToStatus.provider_pressure_cooldown, 425, "must map to HTTP 425 Too Early");
});

test("explicit force: true bypasses provider-pressure cooldown and starts the run", async () => {
  // Use pre-gate controller with force=true: the gate is bypassed before DB,
  // so the run would proceed past our gate but fail on DB access. That's fine
  // — we only need to verify the gate did NOT throw provider_pressure_cooldown.
  // We confirm by catching any error and asserting it's NOT our gate error.
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 6 })]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { force: true, manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      // Any error here should NOT be a provider_pressure_cooldown — the gate
      // must have been bypassed. The run may fail later (no DB) but that is
      // a different error code.
      if (err) {
        assert.notEqual(
          err.code,
          "provider_pressure_cooldown",
          `force: true must bypass the gate; got ${err.code}: ${err.message}`
        );
      }
      // If no error, even better — the run started successfully.
    }
  );
});

test("no pressure gaps — ordinary run does not throw provider_pressure_cooldown", async () => {
  await withPreGateController(
    () => fakeDetailGapStore([]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      if (err) {
        assert.notEqual(err.code, "provider_pressure_cooldown", "no-gap run must not be blocked by cooldown gate");
      }
    }
  );
});

test("repeated owner clicks cannot bypass a provider-pressure cooldown (task 2.4)", async () => {
  // The regression the OpenSpec change closes: repeating "Retry now"
  // immediately must not erode the cooldown. The gate is stateless w.r.t. click
  // count — each click re-reads the durable pressure gaps and re-decides — so
  // five clicks in a row are all blocked, and none starts provider work.
  const calls: DetailGapStoreCall[] = [];
  const lastRun = Date.now();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 4 })], calls),
    async (controller) => {
      for (let click = 0; click < 5; click += 1) {
        let err: ControllerThrownError | undefined;
        try {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
        } catch (e) {
          assert.ok(e instanceof Error);
          err = e as ControllerThrownError;
        }
        assert.ok(err, `click ${click + 1} should have been blocked`);
        assert.equal(err.code, "provider_pressure_cooldown", `click ${click + 1} must stay blocked; got ${err.code}`);
      }
      // Every click re-read the durable store — no first-click-consumes-the-gate
      // shortcut that a later click could slip through.
      assert.equal(calls.length, 5, "each click must re-read the durable pressure gaps");
    },
    {
      lastRunTimes: [
        {
          connector_id: TEST_CONNECTOR_ID,
          connector_instance_id: TEST_CONNECTOR_ID,
          last_run_time_ms: lastRun,
          updated_at: new Date(lastRun).toISOString(),
        },
      ],
      schedule: { interval_seconds: 60 },
    }
  );
});

test("non-pressure gap reasons do not trigger the cooldown gate", async () => {
  await withPreGateController(
    () =>
      fakeDetailGapStore([
        pressureGap({ attempt_count: 5, reason: "retry_exhausted" }),
        pressureGap({ attempt_count: 3, reason: "temporary_unavailable" }),
      ]),
    async (controller) => {
      let err: ControllerThrownError | undefined;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        assert.ok(e instanceof Error);
        err = e as ControllerThrownError;
      }
      if (err) {
        assert.notEqual(err.code, "provider_pressure_cooldown", "non-pressure gaps must not trigger cooldown gate");
      }
    }
  );
});

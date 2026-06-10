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

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createController } from '../runtime/controller.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// A connector that exits immediately so run-now drains cleanly on teardown.
function buildImmediateConnectorFixture(dir) {
  const path = join(dir, 'connector.mjs');
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
    'utf8',
  );
  return path;
}

// Fake detail-gap store returning a configurable set of pending gaps.
function fakeDetailGapStore(pendingGaps = [], calls = []) {
  return {
    listPendingGapsForConnector: (connectorId, options) => {
      calls.push({ connectorId, options });
      return pendingGaps;
    },
  };
}

// Fake scheduler store — configurable schedule/last-run anchors, no DB needed.
function fakeSchedulerStore({ schedule = null, lastRunTimes = [], runHistory = [] } = {}) {
  return {
    appendRunHistory: () => {},
    createSchedule: () => {},
    deleteActiveRun: () => {},
    deleteSchedule: () => {},
    getSchedule: () => schedule,
    listActiveRuns: () => [],
    listLastRunTimes: () => lastRunTimes,
    listRunHistory: () => runHistory,
    listSchedules: () => [],
    setScheduleEnabled: () => {},
    updateSchedule: () => {},
    upsertActiveRun: () => {},
    upsertLastRunTime: () => {},
  };
}

// One pending pressure gap (the shape the controller reads from the store).
function pressureGap(overrides = {}) {
  return {
    reason: 'upstream_pressure',
    attempt_count: 2,
    last_attempt_at: null,
    next_attempt_after: null,
    connector_instance_id: null,
    stream: null,
    updated_at: null,
    ...overrides,
  };
}

// A minimal in-memory manifest for the test connector.
const TEST_CONNECTOR_ID = 'test/immediate';
function buildManifest() {
  return { connector_id: TEST_CONNECTOR_ID, version: '1.0.0', streams: [{ name: 'items', fields: [] }] };
}

// ─── Strategy A: pre-gate tests (no DB) ──────────────────────────────────────
// The cooldown gate fires before getSyncState is reached, so we can use
// createController directly with fake stores — no startServer / DB needed.

async function withPreGateController(detailGapStoreFn, fn, schedulerStoreOptions = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-manual-safety-'));
  const connectorPath = buildImmediateConnectorFixture(tmpDir);
  const controller = createController({
    connectorPathResolver: () => connectorPath,
    detailGapStore: detailGapStoreFn(),
    schedulerStore: fakeSchedulerStore(schedulerStoreOptions),
  });
  try {
    await fn(controller);
  } finally {
    await controller.drainActiveRuns(2000).catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('ordinary manual run during provider-pressure cooldown is blocked with provider_pressure_cooldown', async () => {
  const lastRun = Date.now();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 2 })]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'runNow should have thrown during provider-pressure cooldown');
      assert.equal(err.code, 'provider_pressure_cooldown', `expected provider_pressure_cooldown, got: ${err.code}`);
      assert.ok(typeof err.nextEligibleAt === 'string', 'error must carry nextEligibleAt ISO timestamp');
      assert.ok(typeof err.pendingPressureGapCount === 'number', 'error must carry pendingPressureGapCount');
      assert.ok(err.pendingPressureGapCount > 0, 'pendingPressureGapCount must be > 0');
    },
    {
      schedule: { interval_seconds: 60 },
      lastRunTimes: [{
        connector_id: TEST_CONNECTOR_ID,
        connector_instance_id: TEST_CONNECTOR_ID,
        last_run_time_ms: lastRun,
        updated_at: new Date(lastRun).toISOString(),
      }],
    },
  );
});

test('provider_pressure_cooldown error carries a future nextEligibleAt when next_attempt_after is set', async () => {
  const futureFloor = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 0, next_attempt_after: futureFloor })]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'should throw');
      assert.equal(err.code, 'provider_pressure_cooldown');
      const eligibleMs = Date.parse(err.nextEligibleAt);
      const floorMs = Date.parse(futureFloor);
      assert.ok(eligibleMs >= floorMs, `nextEligibleAt ${err.nextEligibleAt} should be >= floor ${futureFloor}`);
    },
  );
});

test('past next_attempt_after does not block an ordinary manual run', async () => {
  const pastFloor = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 0, next_attempt_after: pastFloor })]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        err = e;
      }
      if (err) {
        assert.notEqual(
          err.code,
          'provider_pressure_cooldown',
          `past next_attempt_after must not block manual run; got ${err.code}: ${err.message}`,
        );
      }
    },
  );
});

test('manual cooldown gate reads connector type and filters to the requested connection instance', async () => {
  const calls = [];
  const futureFloor = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await withPreGateController(
    () =>
      fakeDetailGapStore(
        [
          pressureGap({ connector_instance_id: 'cin_other', attempt_count: 7 }),
          pressureGap({ connector_instance_id: 'cin_target', attempt_count: 2, next_attempt_after: futureFloor }),
        ],
        calls,
      ),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, {
          connectorInstanceId: 'cin_target',
          manifest: buildManifest(),
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'target instance has a pressure gap and should be blocked');
      assert.equal(err.code, 'provider_pressure_cooldown');
      assert.equal(err.pendingPressureGapCount, 1, 'only the requested connection instance should count');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].connectorId, TEST_CONNECTOR_ID, 'store read is connector-type scoped, not cin-scoped');
      assert.deepEqual(calls[0].options, { limit: 200 });
    },
  );
});

test('manual cooldown gate uses recent run history when persisted last-run row is stale', async () => {
  const recent = Date.now();
  const stale = recent - 30 * 24 * 60 * 60 * 1000;
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ connector_instance_id: 'cin_target', attempt_count: 0 })]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, {
          connectorInstanceId: 'cin_target',
          manifest: buildManifest(),
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'recent skip history should keep the pressure cooldown active');
      assert.equal(err.code, 'provider_pressure_cooldown');
    },
    {
      schedule: { interval_seconds: 60 },
      lastRunTimes: [{
        connector_id: TEST_CONNECTOR_ID,
        connector_instance_id: 'cin_target',
        last_run_time_ms: String(stale),
        updated_at: new Date(stale).toISOString(),
      }],
      runHistory: [{
        attempt: 0,
        checkpointSummary: null,
        completedAt: new Date(recent).toISOString(),
        connectorId: TEST_CONNECTOR_ID,
        connectorInstanceId: 'cin_target',
        error: 'source_pressure_cooldown_applied: fixture',
        knownGaps: [],
        recordsEmitted: 0,
        runId: null,
        source: { kind: 'connector', id: TEST_CONNECTOR_ID },
        startedAt: new Date(recent).toISOString(),
        status: 'skipped',
      }],
    },
  );
});

test('manual cooldown gate does not let recent skip history slide an elapsed pressure window', async () => {
  const recentSkip = Date.now();
  const stale = recentSkip - 30 * 24 * 60 * 60 * 1000;
  const pressureObserved = recentSkip - 10 * 60 * 1000;
  await withPreGateController(
    () =>
      fakeDetailGapStore([
        pressureGap({
          connector_instance_id: 'cin_target',
          attempt_count: 0,
          updated_at: new Date(pressureObserved).toISOString(),
        }),
      ]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, {
          connectorInstanceId: 'cin_target',
          manifest: buildManifest(),
        });
      } catch (e) {
        err = e;
      }
      if (err) {
        assert.notEqual(
          err.code,
          'provider_pressure_cooldown',
          `recent skip history must not slide elapsed pressure window; got ${err.code}: ${err.message}`,
        );
      }
    },
    {
      schedule: { interval_seconds: 60 },
      lastRunTimes: [{
        connector_id: TEST_CONNECTOR_ID,
        connector_instance_id: 'cin_target',
        last_run_time_ms: String(stale),
        updated_at: new Date(stale).toISOString(),
      }],
      runHistory: [{
        attempt: 0,
        checkpointSummary: null,
        completedAt: new Date(recentSkip).toISOString(),
        connectorId: TEST_CONNECTOR_ID,
        connectorInstanceId: 'cin_target',
        error: 'source_pressure_cooldown_applied: fixture',
        knownGaps: [],
        recordsEmitted: 0,
        runId: null,
        source: { kind: 'connector', id: TEST_CONNECTOR_ID },
        startedAt: new Date(recentSkip).toISOString(),
        status: 'skipped',
      }],
    },
  );
});

test('ordinary manual run is allowed after provider-pressure cooldown has elapsed', async () => {
  const lastRun = Date.now() - 10 * 60 * 1000;
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 1 })]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        err = e;
      }
      if (err) {
        assert.notEqual(
          err.code,
          'provider_pressure_cooldown',
          `elapsed pressure cooldown must not block manual run; got ${err.code}: ${err.message}`,
        );
      }
    },
    {
      schedule: { interval_seconds: 60 },
      lastRunTimes: [{
        connector_id: TEST_CONNECTOR_ID,
        connector_instance_id: TEST_CONNECTOR_ID,
        last_run_time_ms: lastRun,
        updated_at: new Date(lastRun).toISOString(),
      }],
    },
  );
});

test('cooling-off disposition does not set needs_attention flag', async () => {
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 2 })]),
    async (controller) => {
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch { /* expected */ }
      assert.equal(
        controller.isNeedsHuman(TEST_CONNECTOR_ID),
        false,
        'provider-pressure cooldown must not set needs_attention',
      );
    },
  );
});

test('provider_pressure_cooldown error code maps to HTTP 425 in ref-error-status', async () => {
  const { codeToStatus } = await import('../server/routes/ref-error-status.ts');
  assert.equal(codeToStatus['provider_pressure_cooldown'], 425, 'must map to HTTP 425 Too Early');
});

test('explicit force: true bypasses provider-pressure cooldown and starts the run', async () => {
  // Use pre-gate controller with force=true: the gate is bypassed before DB,
  // so the run would proceed past our gate but fail on DB access. That's fine
  // — we only need to verify the gate did NOT throw provider_pressure_cooldown.
  // We confirm by catching any error and asserting it's NOT our gate error.
  await withPreGateController(
    () => fakeDetailGapStore([pressureGap({ attempt_count: 6 })]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest(), force: true });
      } catch (e) {
        err = e;
      }
      // Any error here should NOT be a provider_pressure_cooldown — the gate
      // must have been bypassed. The run may fail later (no DB) but that is
      // a different error code.
      if (err) {
        assert.notEqual(
          err.code,
          'provider_pressure_cooldown',
          `force: true must bypass the gate; got ${err.code}: ${err.message}`,
        );
      }
      // If no error, even better — the run started successfully.
    },
  );
});

test('no pressure gaps — ordinary run does not throw provider_pressure_cooldown', async () => {
  await withPreGateController(
    () => fakeDetailGapStore([]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        err = e;
      }
      if (err) {
        assert.notEqual(err.code, 'provider_pressure_cooldown', 'no-gap run must not be blocked by cooldown gate');
      }
    },
  );
});

test('non-pressure gap reasons do not trigger the cooldown gate', async () => {
  await withPreGateController(
    () =>
      fakeDetailGapStore([
        pressureGap({ reason: 'retry_exhausted', attempt_count: 5 }),
        pressureGap({ reason: 'temporary_unavailable', attempt_count: 3 }),
      ]),
    async (controller) => {
      let err;
      try {
        await controller.runNow(TEST_CONNECTOR_ID, { manifest: buildManifest() });
      } catch (e) {
        err = e;
      }
      if (err) {
        assert.notEqual(err.code, 'provider_pressure_cooldown', 'non-pressure gaps must not trigger cooldown gate');
      }
    },
  );
});

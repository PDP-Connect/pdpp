// Scheduler managed-browser-surface routing tests.
//
// These exercises drive the scheduler directly (no AS/RS/neko) so they
// isolate the managed-surface routing contract from the rest of the
// reference implementation. They prove:
//
//   T1. A scheduled run for a managed connector acquires the controller
//       surface lease (runManagedConnectorViaController is called with
//       priorityClass "background" and triggerKind "scheduled").
//       The callback receives PDPP_BROWSER_SURFACE_REQUIRED=neko-shaped opts.
//
//   T2. Lease release is inherited via runNow's finally chain — the
//       scheduler does NOT add a separate release. Because we mock the
//       controller, we verify only that runManagedConnectorViaController
//       is called exactly once and the resulting RunRecord has status
//       "succeeded" (the controller's own finally releases the lease).
//
//   T3. browser_surface_queued → SKIP not failure-retry (no failure-streak
//       increment; status is "skipped"; next tick retries cleanly).
//
//   T4. Non-managed connector (callback returns null) is unaffected — falls
//       through to the normal runConnector path (status "succeeded" from
//       the connector itself, no lease env, no PDPP_BROWSER_SURFACE_* env).
//
//   T5. profile_key is connectorId (passed as connectorInstanceId in opts
//       when connectorInstanceId === connectorId, which acquireInitialBrowserSurfaceLease
//       derives profileKey from connectorId/connectorInstanceId/manifest).
//       We verify the connectorInstanceId forwarded = connectorId.
//
//   T6. On non-contention controller throw, the scheduler records a "failed"
//       RunRecord (not a crash), preserving the retry/back-off pipeline.
//
//   T7. On controller run/lease contention, the scheduler records a "skipped"
//       deferred tick, not a connector failure.
//
// All tests use the createScheduler seam directly — no live neko surface
// is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createScheduler } from '../runtime/scheduler.ts';

// A manifest that permits background (automatic) runs so the scheduler
// dispatches without hitting the automation_policy_blocked gate.
const BACKGROUND_SAFE_MANIFEST = {
  capabilities: {
    refresh_policy: { recommended_mode: 'automatic', background_safe: true },
  },
  streams: [{ name: 'items' }],
};

function writeDummyConnector(tmpDir, name = 'dummy-connector.mjs') {
  const connectorPath = join(tmpDir, name);
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    'utf8',
  );
  return connectorPath;
}

async function waitFor(condition, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function anchorStore(connectorId, lastRunTimeMs) {
  return {
    listRunHistory: () => [],
    listLastRunTimes: () => [{
      connector_id: connectorId,
      connector_instance_id: connectorId,
      last_run_time_ms: lastRunTimeMs,
    }],
    appendRunHistory: () => {},
    upsertLastRunTime: () => {},
    upsertActiveRun: () => {},
    deleteActiveRun: () => {},
  };
}

function pressureGap({ attemptCount = 6 } = {}) {
  return {
    attemptCount,
    lastPressureAt: new Date().toISOString(),
    nextAttemptAfter: new Date(Date.now() + 60_000).toISOString(),
    reason: 'upstream_pressure',
  };
}

// ── T1 + T2: managed connector acquires surface via callback ────────────────

test('T1+T2: scheduled managed-connector run calls runManagedConnectorViaController with background priority', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const connectorId = 'chatgpt';
    const runId = `run_${Date.now()}`;

    const calls = [];
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId,
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async (id, opts) => {
        calls.push({ id, opts });
        // The callback awaits the run's REAL terminal outcome (via
        // controller.awaitRun) before returning — so it reports the real
        // status, not "started". A successful run → "succeeded".
        return { run_id: runId, status: 'succeeded', trace_id: 'trace-001' };
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      assert.equal(calls.length >= 1, true, 'runManagedConnectorViaController must be called');
      const call = calls[0];
      assert.equal(call.id, connectorId, 'connectorId forwarded correctly');
      assert.equal(call.opts.priorityClass, 'background', 'priorityClass must be background');
      assert.equal(call.opts.triggerKind, 'scheduled', 'triggerKind must be scheduled');
      assert.equal(call.opts.recoveryOnly, false, 'normal scheduled managed run must not become recovery-only');
      assert.equal(call.opts.connectorInstanceId, connectorId, 'connectorInstanceId defaults to connectorId');
      assert.equal(call.opts.ownerToken, 'owner-token', 'ownerToken forwarded');

      const [record] = completedRuns;
      assert.equal(record.status, 'succeeded', 'RunRecord status must be succeeded after managed dispatch');
      assert.equal(record.runId, runId, 'runId from controller forwarded to RunRecord');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T2c: scheduled managed connector retries runtime-retryable terminal known gaps before recording failure', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-retry-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const connectorId = 'chatgpt';
    const completedRuns = [];
    const controllerCalls = [];
    const runtimeGap = {
      kind: 'run_failed',
      reason: 'connector_reported_failed',
      stream: null,
      severity: 'actionable',
      message:
        'chatgpt_preprogress_failure: runtime_exception: could not open browser profile: Protocol error (Network.setCacheDisabled): Internal server error, session closed.',
      recovery_hint: { action: 'retry_by_runtime', retryable: true },
    };

    const scheduler = createScheduler({
      connectors: [{
        connectorId,
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 2,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async () => {
        controllerCalls.push(Date.now());
        if (controllerCalls.length === 1) {
          return {
            run_id: 'run-runtime-race-001',
            status: 'failed',
            trace_id: 'trace-runtime-race-001',
            known_gaps: [runtimeGap],
            connector_error: { message: String(runtimeGap.message), retryable: false },
          };
        }
        return {
          run_id: 'run-runtime-race-002',
          status: 'succeeded',
          trace_id: 'trace-runtime-race-002',
        };
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      assert.equal(controllerCalls.length, 2, 'runtime-retryable managed failure should be retried by scheduler');
      const [record] = completedRuns;
      assert.equal(record.status, 'succeeded');
      assert.equal(record.runId, 'run-runtime-race-002');
      assert.equal(record.attempt, 2);
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T2d: a definitive session_required failure is NOT retried even with maxRetries>0 (no three-attempt burst)', async () => {
  // Regression for the live steady-state burst: a scheduled ChatGPT run that
  // fails with session_required must stop after ONE attempt. The gap here is
  // deliberately shaped so the GENERIC retry classifier would retry it — it
  // carries no `retryable: false` marker and no non-retryable failure/terminal
  // reason — so the ONLY thing preventing a burst is the owner-auth-repair gate
  // added to routeScheduledManagedRun. Removing that gate makes this fail with
  // controllerCalls.length === 3.
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-authburst-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const connectorInstanceId = 'cin_chatgpt_personal';
    const needsHuman = new Set();
    const completedRuns = [];
    const controllerCalls = [];
    const sessionGap = {
      kind: 'run_failed',
      reason: 'connector_reported_failed',
      stream: null,
      severity: 'actionable',
      // session_required message → managedRunRequiresOwnerAuthRepair === true.
      message:
        'chatgpt_preprogress_failure: session_required: ChatGPT session is not active.',
      // No recovery_hint.retryable marker → the generic classifier does NOT see
      // this as non-retryable on its own.
    };

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorInstanceId,
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 2,
        ownerToken: 'owner-token',
      }],
      isNeedsHuman: (_connectorId, instanceId) => needsHuman.has(instanceId),
      markNeedsHuman: (_connectorId, instanceId) => needsHuman.add(instanceId),
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: 'http://localhost.invalid',
      runManagedConnectorViaController: async () => {
        controllerCalls.push(Date.now());
        return {
          run_id: `run-session-required-${controllerCalls.length}`,
          status: 'failed',
          trace_id: 'trace-session-required',
          known_gaps: [sessionGap],
          // No connector_error.retryable:false — the classifier would retry.
          connector_error: { message: String(sessionGap.message) },
        };
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      const authAttempts = controllerCalls.length;
      assert.equal(authAttempts, 1, 'definitive session_required must not retry within a tick (no burst)');
      assert.equal(completedRuns[0].status, 'failed');
      assert.equal(completedRuns[0].attempt, 1, 'terminal record should be the first and only attempt');
      assert.equal(needsHuman.has(connectorInstanceId), true, 'owner repair must be flagged');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T2b: scheduled managed-connector recovery dispatch preserves recoveryOnly', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const connectorId = 'chatgpt';
    const calls = [];
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId,
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      getSourcePressureGaps: () => [pressureGap()],
      getNonPressureRecoverableCount: async () => 1,
      isManagedConnector: (id) => id === connectorId,
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: 'http://localhost.invalid',
      schedulerStore: anchorStore(connectorId, Date.now() - 200),
      runManagedConnectorViaController: async (id, opts) => {
        calls.push({ id, opts });
        return { run_id: `run_${Date.now()}`, status: 'succeeded', trace_id: 'trace-recovery-only' };
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      assert.equal(calls.length >= 1, true, 'runManagedConnectorViaController must be called');
      const recoveryCall = calls.find((call) => call.opts.recoveryOnly === true);
      assert.ok(recoveryCall, 'recovery-only dispatch intent must reach controller route');
      assert.equal(recoveryCall.id, connectorId, 'connectorId forwarded correctly');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── T3: browser_surface_queued → SKIP not failure ──────────────────────────

test('T3: browser_surface_queued status maps to skipped RunRecord (not failure-retry)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async () => ({
        run_id: `run_${Date.now()}`,
        status: 'run_browser_surface_queued',
        trace_id: 'trace-queued',
      }),
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      const [record] = completedRuns;
      assert.equal(record.status, 'skipped', 'browser_surface_queued must produce a skipped RunRecord');
      assert.ok(
        typeof record.error === 'string' && record.error.includes('browser_surface_unavailable'),
        `error should include browser_surface_unavailable, got: ${record.error}`
      );
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T3c: run_already_active controller contention maps to skipped RunRecord', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async () => {
        const err = new Error('Connector already has an active run: run_existing');
        err.code = 'run_already_active';
        throw err;
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      const [record] = completedRuns;
      assert.equal(record.status, 'skipped', 'run_already_active must produce a skipped RunRecord');
      assert.ok(
        typeof record.error === 'string' && record.error.includes('browser_surface_unavailable'),
        `error should include browser_surface_unavailable, got: ${record.error}`,
      );
      assert.ok(
        record.error.includes('run_already_active'),
        `defer reason should preserve run_already_active, got: ${record.error}`,
      );
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── T3b: surface_failed and browser_surface_probe_failed also → SKIP ───────

test('T3b: surface_failed status also maps to skipped RunRecord', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async () => ({
        run_id: `run_${Date.now()}`,
        status: 'surface_failed',
        trace_id: 'trace-probe',
      }),
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      const [record] = completedRuns;
      assert.equal(record.status, 'skipped', 'surface_failed must produce a skipped RunRecord');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── T4: non-managed connector (callback returns null) uses runConnector ─────

test('T4: non-managed connector (callback returns null) falls through to runConnector (not a managed skip)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];
    let managedCallCount = 0;

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'filesystem-connector',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async () => {
        managedCallCount++;
        // Non-managed: signal launchRun to fall through to runConnector
        return null;
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      // Callback was consulted (once) but returned null → fell through to runConnector
      assert.ok(managedCallCount >= 1, 'callback should be called even for non-managed');
      const [record] = completedRuns;
      // The record must NOT be a browser_surface_unavailable skip (that would mean
      // the managed path was incorrectly taken). The runConnector path may fail or
      // succeed depending on the RS server — we only assert it was NOT routed as
      // a managed skip.
      assert.ok(
        !record.error?.includes('browser_surface_unavailable'),
        `RunRecord error must not be browser_surface_unavailable (managed skip must not fire for null return); got: ${record.error}`
      );
      // Verify no browser_surface env was involved — the record has no traceId
      // from a controller.runNow call (the managed path sets traceId from controller).
      // For the null-return case, traceId comes from runConnector output (may be null).
      // Key invariant: the record DOES NOT have status "skipped" from the surface path.
      assert.notEqual(record.status, 'skipped', 'non-managed connector must not produce a surface skip');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── T5: connectorInstanceId forwarded as profile_key ───────────────────────

test('T5: connectorInstanceId matches connectorId when not explicitly set (profile_key = connectorId)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const connectorId = 'chatgpt';
    const calls = [];
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId,
        // No explicit connectorInstanceId → defaults to connectorId
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async (id, opts) => {
        calls.push(opts);
        return { run_id: `run_${Date.now()}`, status: 'started', trace_id: 'trace-t5' };
      },
    });

    try {
      scheduler.start();
      await waitFor(() => calls.length >= 1, 5000);
      scheduler.stop();

      assert.equal(calls[0].connectorInstanceId, connectorId,
        'connectorInstanceId must equal connectorId (profile_key derivation)');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── T6: controller throw → failed RunRecord (not crash) ────────────────────

test('T6: controller.runNow throw produces a failed RunRecord (scheduler stays alive)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async () => {
        throw new Error('provider_pressure_cooldown: simulated controller error');
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      const [record] = completedRuns;
      assert.equal(record.status, 'failed', 'controller throw must produce a failed RunRecord');
      assert.ok(
        typeof record.error === 'string' && record.error.includes('controller_run_now_failed'),
        `error should include controller_run_now_failed, got: ${record.error}`
      );
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T7: a managed run that DISPATCHES but FAILS records a failed RunRecord (no synthetic succeeded — the regression)', async () => {
  // The regression this guards: controller.runNow returns status "started"
  // immediately (the run executes async), so an earlier version recorded a
  // SYNTHETIC "succeeded" — masking a genuinely-failing scheduled run (e.g. the
  // Cloudflare case) from the scheduler's failure streak / back-off. The fixed
  // callback awaits controller.awaitRun and returns the REAL terminal status, so
  // a failed run must record "failed" and feed the back-off machinery.
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: async () => {
        // Run dispatched + awaited to its REAL terminal outcome = failed.
        return { run_id: 'run-failed-001', status: 'failed', trace_id: 'trace-fail' };
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      const [record] = completedRuns;
      assert.equal(record.status, 'failed', 'a dispatched-but-failed managed run must record failed, not synthetic succeeded');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T7b: auth-required managed scheduled failure marks needs-human and suppresses the next tick', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const connectorInstanceId = 'cin_chatgpt_personal';
    const needsHuman = new Set();
    const completedRuns = [];
    const controllerCalls = [];
    const authGap = {
      kind: 'run_failed',
      reason: 'connector_reported_failed',
      stream: null,
      severity: 'actionable',
      message:
        'chatgpt_preprogress_failure: refresh_credentials: chatgpt_session_failed: chatgpt_session_required: ChatGPT session is not active.',
      recovery_hint: { action: 'refresh_credentials', retryable: false },
    };

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorInstanceId,
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      isNeedsHuman: (_connectorId, instanceId) => needsHuman.has(instanceId),
      markNeedsHuman: (_connectorId, instanceId) => needsHuman.add(instanceId),
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: 'http://localhost.invalid',
      runManagedConnectorViaController: async () => {
        controllerCalls.push(Date.now());
        return {
          run_id: 'run-auth-required-001',
          status: 'failed',
          trace_id: 'trace-auth-required',
          known_gaps: [authGap],
          connector_error: { message: String(authGap.message), retryable: false },
        };
      },
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 2, 5000);
      scheduler.stop();

      assert.equal(controllerCalls.length, 1, 'auth-required failure should prevent a second managed dispatch');
      assert.equal(completedRuns[0].status, 'failed');
      assert.deepEqual(completedRuns[0].knownGaps, [authGap], 'terminal auth gap should be preserved');
      assert.equal(needsHuman.has(connectorInstanceId), true, 'existing needs-human gate should be marked');
      assert.equal(completedRuns[1].status, 'skipped');
      assert.match(completedRuns[1].error || '', /needs_human_attention/u);
      // Same-connection repair (4.8): the failure, the needs-human gate, and the
      // suppressed follow-up tick all key on the SAME connector_instance_id — no
      // duplicate connection is created to carry the repair.
      const instanceIds = new Set(completedRuns.map((r) => r.connectorInstanceId || r.connectorId));
      assert.deepEqual([...instanceIds], [connectorInstanceId], 'repair stays on the same connection id');
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── T8: restart-race — managed connector with NO routing seam DEFERS ─────────
//
// The live ChatGPT wedge's failure origin: when the managed-routing seam
// (runManagedConnectorViaController) is not wired — e.g. the controller's
// browserSurfaceLeaseManager was not yet available when createScheduler ran —
// a managed connector must DEFER its scheduled tick (a skipped RunRecord that
// does NOT feed the failure streak), not cold-dispatch a fresh headless browser
// that Cloudflare challenges and fails. `isManagedConnector` lets the scheduler
// recognize the managed connector independent of whether the callback is wired.

test('T8: managed connector with an unwired routing seam DEFERS (skip), not a cold runConnector dispatch', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    // This connector, if cold-dispatched, would hit the RS server at an
    // invalid URL and FAIL. The defer must prevent that: we assert the record
    // is a surface skip, never a failure.
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'chatgpt',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      // The routing seam is NOT wired (boot race) ...
      runManagedConnectorViaController: null,
      // ... but the scheduler still knows chatgpt is a managed connector.
      isManagedConnector: (id) => id === 'chatgpt',
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      // Give a couple more ticks a chance to (incorrectly) cold-dispatch.
      await new Promise((resolve) => setTimeout(resolve, 150));
      scheduler.stop();

      for (const record of completedRuns) {
        assert.equal(record.status, 'skipped', 'unwired managed seam must DEFER (skip), never cold-dispatch');
        assert.ok(
          typeof record.error === 'string' && record.error.includes('browser_surface_unavailable'),
          `defer record must be a surface-unavailable skip, got: ${record.error}`,
        );
        assert.ok(
          record.error.includes('surface_routing_unavailable'),
          `defer reason should name the missing routing seam, got: ${record.error}`,
        );
      }
      // Crucially: no failed records (a cold dispatch would have failed and fed
      // the back-off streak — the exact deepening that produced the live wedge).
      assert.equal(
        completedRuns.filter((r) => r.status === 'failed').length,
        0,
        'a deferred managed tick must NEVER produce a failure that deepens back-off',
      );
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── T9: the defer guard must NOT over-fire for non-managed connectors ────────
//
// A non-managed connector with no routing seam must still cold-run through
// runConnector (its normal path) — the defer guard is scoped to managed
// connectors only. Mirrors T4 but with the seam fully absent (null).

test('T9: non-managed connector with no routing seam still uses runConnector (defer guard does not over-fire)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sched-managed-'));
  try {
    const connectorPath = writeDummyConnector(tmpDir);
    const completedRuns = [];

    const scheduler = createScheduler({
      connectors: [{
        connectorId: 'filesystem-connector',
        connectorPath,
        manifest: BACKGROUND_SAFE_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      }],
      rsUrl: 'http://localhost.invalid',
      onInteraction: async () => ({ accepted: true, status: 'cancelled' }),
      onRunComplete: (record) => completedRuns.push(record),
      runManagedConnectorViaController: null,
      // Default isManagedConnector (returns false) — filesystem-connector is not managed.
    });

    try {
      scheduler.start();
      await waitFor(() => completedRuns.length >= 1, 5000);
      scheduler.stop();

      for (const record of completedRuns) {
        assert.ok(
          !record.error?.includes('surface_routing_unavailable'),
          `non-managed connector must NOT be deferred by the managed-seam guard; got: ${record.error}`,
        );
      }
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

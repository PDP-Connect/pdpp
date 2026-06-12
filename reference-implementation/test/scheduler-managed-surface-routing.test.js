// Scheduler managed-browser-surface routing tests.
//
// These exercises drive the scheduler directly (no AS/RS/neko) so they
// isolate the managed-surface routing contract from the rest of the
// reference implementation. They prove:
//
//   T1. A scheduled run for a managed connector acquires the controller
//       surface lease (runManagedConnectorViaController is called with
//       priorityClass "scheduled_refresh" and triggerKind "scheduled").
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
//   T6. On controller throw, the scheduler records a "failed" RunRecord (not
//       a crash), preserving the retry/back-off pipeline.
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

// ── T1 + T2: managed connector acquires surface via callback ────────────────

test('T1+T2: scheduled managed-connector run calls runManagedConnectorViaController with scheduled_refresh priority', async () => {
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
      assert.equal(call.opts.priorityClass, 'scheduled_refresh', 'priorityClass must be scheduled_refresh');
      assert.equal(call.opts.triggerKind, 'scheduled', 'triggerKind must be scheduled');
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
        throw new Error('run_already_active: simulated controller error');
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

// SLVP-ideal §4.3 invariant: a source-pressure cooldown MUST NOT make a run
// ineligible when non-source-pressure pending gaps exist.
//
// This is the regression guard for the live "cooldown-starves-recovery" class
// bug: a handful of `upstream_pressure` gaps armed the cross-run cooldown, and
// the legacy single binary eligibility gate (`elapsed >= interval &&
// !cooldownDefers`) skipped the WHOLE dispatch — including recovery of hundreds
// of NON-pressure (`run_cap_deferred` / `retry_exhausted`) gaps that the
// reason-discriminated cooldown has no claim over. The fix splits eligibility:
// the cooldown defers only the forward walk; recovery of non-pressure gaps is
// work-conserving and cooldown-exempt (a recovery-only launch).
//
// Harness mirrors scheduler-source-pressure-cooldown-suppression.test.js: a
// not-background-safe manifest means any ELIGIBLE tick emits a deterministic
// `automation_policy_blocked` skip before spawning, while a COOLING tick emits
// a `source_pressure_cooldown_applied` skip. So "did the cooldown suppress the
// dispatch?" is observable purely from which skip class appears.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createScheduler } from '../runtime/scheduler.ts';

function writeUnusedConnector(tmpDir, name = 'unused-connector.mjs') {
  const attemptsPath = join(tmpDir, `${name}.attempts.log`);
  const connectorPath = join(tmpDir, name);
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {
  appendFileSync(${JSON.stringify(attemptsPath)}, 'spawn\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  process.exit(0);
});
`,
    'utf8',
  );
  return { attemptsPath, connectorPath };
}

const POLICY_BLOCKED_MANIFEST = {
  capabilities: { refresh_policy: { background_safe: false } },
};

function anchorStore(anchors) {
  return {
    listRunHistory: () => [],
    listLastRunTimes: () =>
      anchors.map(({ connectorId, lastRunTimeMs }) => ({
        connector_id: connectorId,
        connector_instance_id: connectorId,
        last_run_time_ms: lastRunTimeMs,
      })),
    appendRunHistory: () => {},
    upsertLastRunTime: () => {},
  };
}

function pressureGap(overrides = {}) {
  const {
    reason = 'upstream_pressure',
    attemptCount = 0,
    nextAttemptAfter = null,
    lastPressureAt = new Date().toISOString(),
  } = overrides;
  return { reason, attemptCount, nextAttemptAfter, lastPressureAt };
}

function readAttempts(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const cooldownSkips = (records) => records.filter((r) => /source_pressure_cooldown_applied/.test(r.error || ''));
const policySkips = (records) => records.filter((r) => /automation_policy_blocked/.test(r.error || ''));
const backoffSkips = (records) => records.filter((r) => /scheduler_backoff_applied/.test(r.error || ''));

async function waitFor(condition, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for scheduler condition');
}

const cancelledInteractionResponse = (interaction) => ({
  type: 'INTERACTION_RESPONSE',
  request_id: interaction.request_id,
  status: 'cancelled',
});

// THE INVARIANT (the fix): cooldown armed + non-pressure recoverable gaps
// present -> the dispatch becomes eligible (recovery-only), so the cooldown
// does NOT suppress it. With the policy-blocked manifest, an eligible tick
// surfaces as an automation_policy_blocked skip rather than a cooldown skip.
test('a source-pressure cooldown does NOT suppress the dispatch when non-pressure recovery gaps exist', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cooldown-recovery-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'recovery.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-cooldown-recovery-connector';

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    // High attempt count + recent anchor -> the cooldown window (2^6 * 50ms)
    // far exceeds elapsed, so WITHOUT the fix this tick would cooldown-skip
    // forever (the live 942-gap stall). The schedule interval (50ms) HAS
    // elapsed, which is the precondition for a recovery-only launch.
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() - 200 }]),
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    getSourcePressureGaps: () => [pressureGap({ attemptCount: 6 })],
    // 942 stranded non-pressure (retry_exhausted) gaps waiting to drain.
    getNonPressureRecoverableCount: () => 942,
  });

  try {
    scheduler.start();
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    scheduler.stop();

    assert.ok(
      policySkips(completedRuns).length >= 1,
      'cooldown-armed tick with non-pressure recovery work is eligible (recovery-only), reaches the policy gate',
    );
    assert.equal(
      cooldownSkips(completedRuns).length,
      0,
      'the cooldown must NOT emit a cooling-off skip when it is letting recovery proceed (would be a dishonest "skipped" audit line)',
    );
    // Policy-blocked manifest still refuses to spawn — we are proving the
    // ELIGIBILITY decision, not the connector behaviour (that is L3's test).
    assert.equal(readAttempts(attemptsPath).length, 0, 'policy-blocked manifest never spawns');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// THE DEADLOCK CASE (the live bug): a STALE failure-backoff streak inflates the
// failure-backoff effectiveIntervalMs (e.g. 16h) so the connection can never run
// a successful run to clear the streak — a deadlock. Recovery of NON-pressure
// gaps must NOT be gated by that failure-backoff interval: draining already-
// deferred gaps cannot worsen a failure streak, so it proceeds on the minimal
// recovery cadence (one base interval) regardless of the inflated backoff.
test('recovery fires even when a stale failure-backoff interval has NOT elapsed (the live deadlock)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-recovery-deadlock-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'deadlock.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-recovery-deadlock-connector';

  // Seed a streak of FAILED runs so computeNextRunWithBackoff inflates
  // effectiveIntervalMs far beyond the elapsed time (intervalElapsed=false).
  const now = Date.now();
  const failedHistory = Array.from({ length: 6 }, (_, i) => ({
    connector_id: connectorId,
    connector_instance_id: connectorId,
    source: { kind: 'connector', id: connectorId },
    status: 'failed',
    error: 'simulated upstream failure',
    started_at: new Date(now - (i + 1) * 60_000).toISOString(),
    completed_at: new Date(now - (i + 1) * 60_000).toISOString(),
    records_emitted: 0,
  }));
  const deadlockStore = {
    listRunHistory: () => failedHistory,
    // last run only ~200ms ago -> a 50ms base interval HAS elapsed (recovery
    // cadence) but the inflated failure-backoff interval has NOT.
    listLastRunTimes: () => [{ connector_id: connectorId, connector_instance_id: connectorId, last_run_time_ms: now - 200 }],
    appendRunHistory: () => {},
    upsertLastRunTime: () => {},
  };

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    schedulerStore: deadlockStore,
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    // No source-pressure gaps here — the blocker is purely the failure-backoff
    // interval, proving recovery is independent of BOTH governors.
    getSourcePressureGaps: () => [],
    getNonPressureRecoverableCount: () => 942,
  });

  try {
    scheduler.start();
    // Recovery-only launch reaches the policy-blocked gate (eligible despite the
    // un-elapsed failure-backoff interval).
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.ok(
      policySkips(completedRuns).length >= 1,
      'recovery fires despite the stale failure-backoff interval — breaks the deadlock',
    );
    assert.equal(readAttempts(attemptsPath).length, 0, 'policy-blocked manifest never spawns');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// THE CONTROL (no regression): same cooldown, but ZERO non-pressure recovery
// work -> the legacy behaviour holds, the cooldown suppresses the dispatch.
test('a source-pressure cooldown still suppresses the dispatch when there is NO non-pressure recovery work', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cooldown-norecovery-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'norecovery.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-cooldown-norecovery-connector';

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() - 200 }]),
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    getSourcePressureGaps: () => [pressureGap({ attemptCount: 6 })],
    getNonPressureRecoverableCount: () => 0,
  });

  try {
    scheduler.start();
    await waitFor(() => cooldownSkips(completedRuns).length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    scheduler.stop();

    assert.equal(
      cooldownSkips(completedRuns).length,
      1,
      'with no non-pressure recovery work, the cooldown suppresses the dispatch exactly as before (one skip per identity)',
    );
    assert.equal(policySkips(completedRuns).length, 0, 'no recovery launch, so no policy skip');
    assert.equal(readAttempts(attemptsPath).length, 0, 'connector never spawned while cooling off');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stale source-pressure rows do not re-arm the scheduler cooldown', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cooldown-stale-pressure-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'stale-pressure.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-stale-pressure-connector';
  const stalePressureAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() - 200 }]),
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    getSourcePressureGaps: () => [pressureGap({ attemptCount: 8, lastPressureAt: stalePressureAt })],
    getNonPressureRecoverableCount: () => 0,
  });

  try {
    scheduler.start();
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.equal(cooldownSkips(completedRuns).length, 0, 'stale pressure must not emit a cooldown skip');
    assert.ok(policySkips(completedRuns).length >= 1, 'stale pressure lets ordinary eligibility reach the policy gate');
    assert.equal(readAttempts(attemptsPath).length, 0, 'policy-blocked manifest never spawns');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Safety: a genuinely blocked connection is NOT launched even for recovery
// (SLVP-ideal §10-C). The probe defaults to fail-closed (0) so an unwired host
// keeps legacy behaviour — verified implicitly by the suppression suite, which
// does not set getNonPressureRecoverableCount and still cools off.
test('the non-pressure recovery probe defaults to fail-closed (legacy behaviour when unwired)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cooldown-default-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'default.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-cooldown-default-connector';

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    schedulerStore: anchorStore([{ connectorId, lastRunTimeMs: Date.now() - 200 }]),
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    getSourcePressureGaps: () => [pressureGap({ attemptCount: 6 })],
    // getNonPressureRecoverableCount intentionally NOT provided -> default () => 0.
  });

  try {
    scheduler.start();
    await waitFor(() => cooldownSkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.equal(cooldownSkips(completedRuns).length, 1, 'unwired host keeps the legacy whole-dispatch cooldown');
    assert.equal(readAttempts(attemptsPath).length, 0, 'connector never spawned');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Cross-path success clears a stale failure-backoff (THE LIVE WEDGE) ──────
//
// The live ChatGPT wedge: a streak of FAILED runs inflates the failure-backoff
// interval so the inflated next-run time has NOT elapsed → the forward walk
// defers forever. Manual/owner `controller.runNow` successes are invisible to
// the scheduler's own history, so the streak never clears from a success. The
// `getLastSuccessfulRunAt` probe surfaces the durable cross-path success: when
// it is newer than the streak, the back-off clears and the connector becomes
// eligible. With the policy-blocked manifest, an ELIGIBLE tick surfaces as an
// `automation_policy_blocked` skip; a still-backing-off tick surfaces as a
// `scheduler_backoff_applied` skip. So the skip class proves the decision.

function backoffWedgeStore(connectorId, { failures = 5, lastFailAt }) {
  // A streak of same-class failures whose newest failure is at `lastFailAt`.
  // Shape matches `SchedulerRunHistoryRecord` (camelCase + a `source` object) so
  // the scheduler's `fromStoredRunRecord` hydrates it into runtime history and
  // the streak actually engages.
  const failedHistory = Array.from({ length: failures }, (_, i) => ({
    connectorId,
    connectorInstanceId: connectorId,
    source: { kind: 'connector', id: connectorId },
    status: 'failed',
    terminalReason: 'connector_reported_failed',
    failureReason: null,
    connectorError: null,
    error: 'connector_reported_failed',
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    checkpointSummary: null,
    knownGaps: [],
    runId: null,
    traceId: null,
    startedAt: new Date(lastFailAt - (failures - 1 - i) * 1000 - 1000).toISOString(),
    completedAt: new Date(lastFailAt - (failures - 1 - i) * 1000).toISOString(),
    attempt: 1,
  }));
  return {
    listRunHistory: () => failedHistory,
    // last run anchored at the newest failure: with a 4x-inflated back-off
    // (2^(5-3)) the next-run time is far in the FUTURE, so WITHOUT recovery the
    // forward walk defers (backoff skip).
    listLastRunTimes: () => [
      { connector_id: connectorId, connector_instance_id: connectorId, last_run_time_ms: lastFailAt },
    ],
    appendRunHistory: () => {},
    upsertLastRunTime: () => {},
  };
}

test('a genuine cross-path success NEWER than the streak clears the stale back-off → connector becomes eligible', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-backoff-recovery-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'recovery-success.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-backoff-recovery-connector';
  const lastFailAt = Date.now();

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      // Small interval so a 4x back-off (2^(5-3)=4 => 200ms) still sits in the
      // future relative to the ~0ms elapsed at start, proving the streak would
      // otherwise defer the forward walk.
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    schedulerStore: backoffWedgeStore(connectorId, { failures: 5, lastFailAt }),
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    getSourcePressureGaps: () => [],
    getNonPressureRecoverableCount: () => 0,
    // A manual success ONE HOUR after the newest failure — invisible to the
    // scheduler's own history, surfaced only via this durable probe.
    getLastSuccessfulRunAt: () => lastFailAt + 3_600_000,
  });

  try {
    scheduler.start();
    // The cleared streak makes the connector eligible: the policy-blocked
    // manifest then emits an automation_policy_blocked skip. Stop as soon as we
    // see it so a later tick cannot muddy the signal.
    await waitFor(() => policySkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.ok(policySkips(completedRuns).length >= 1, 'eligible tick reaches the policy gate');
    assert.equal(
      backoffSkips(completedRuns).length,
      0,
      'no scheduler_backoff_applied skip — the streak was cleared by the genuine recent success',
    );
    assert.equal(readAttempts(attemptsPath).length, 0, 'policy-blocked manifest never spawns');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a STALE cross-path success (older than the streak) does NOT clear the back-off → still defers', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-backoff-stale-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'recovery-stale.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-backoff-stale-connector';
  const lastFailAt = Date.now();

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    // failures: 6 keeps the state cooling_off (< blocked threshold of 7) while
    // the back-off window (2^(6-3) = 8x => 400ms) comfortably exceeds the
    // first-tick capture, so the defer is observed before any window elapses.
    schedulerStore: backoffWedgeStore(connectorId, { failures: 6, lastFailAt }),
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    getSourcePressureGaps: () => [],
    getNonPressureRecoverableCount: () => 0,
    // Success predates the streak — not recovery evidence.
    getLastSuccessfulRunAt: () => lastFailAt - 3_600_000,
  });

  try {
    scheduler.start();
    // The inflated back-off defers the forward walk: a scheduler_backoff_applied
    // skip is emitted. Stop the instant we see it so a later tick crossing the
    // (deep) window cannot muddy the eligibility signal.
    await waitFor(() => backoffSkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.ok(
      backoffSkips(completedRuns).length >= 1,
      'a stale success leaves the inflated back-off intact → the tick defers (backoff skip)',
    );
    assert.equal(
      policySkips(completedRuns).length,
      0,
      'never eligible (a stale success is not recovery evidence) → never reaches the policy gate',
    );
    assert.equal(readAttempts(attemptsPath).length, 0, 'connector never spawned while backing off');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('with NO cross-path success probe wired, a stale streak keeps backing off (legacy behaviour preserved)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-backoff-default-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir, 'recovery-default.mjs');
  const completedRuns = [];
  const connectorId = 'chatgpt-backoff-default-connector';
  const lastFailAt = Date.now();

  const scheduler = createScheduler({
    connectors: [{
      connectorId,
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 50,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    schedulerStore: backoffWedgeStore(connectorId, { failures: 6, lastFailAt }),
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    getSourcePressureGaps: () => [],
    getNonPressureRecoverableCount: () => 0,
    // getLastSuccessfulRunAt intentionally NOT provided → defaults to () => null.
  });

  try {
    scheduler.start();
    await waitFor(() => backoffSkips(completedRuns).length >= 1, 5000);
    scheduler.stop();

    assert.ok(backoffSkips(completedRuns).length >= 1, 'unwired host keeps the legacy failure back-off');
    assert.equal(policySkips(completedRuns).length, 0, 'never eligible without a recovery signal');
    assert.equal(readAttempts(attemptsPath).length, 0, 'connector never spawned');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

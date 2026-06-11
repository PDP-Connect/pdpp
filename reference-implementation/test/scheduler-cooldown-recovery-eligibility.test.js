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
  const { reason = 'upstream_pressure', attemptCount = 0, nextAttemptAfter = null, lastPressureAt = null } = overrides;
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

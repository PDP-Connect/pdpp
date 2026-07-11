import assert from 'node:assert/strict';
import test from 'node:test';

import { createDispatchGovernor } from '../runtime/scheduler/dispatch-governor.ts';

function createRuntime() {
  return {
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    history: [],
    lastRunTime: new Map(),
    notifiedCooldownIdentity: new Map(),
  };
}

function createGovernor(runtime) {
  return createDispatchGovernor({
    getLastSuccessfulRunAt: async () => null,
    getNonPressureRecoverableCount: async () => 0,
    getSourcePressureGaps: async () => [],
    onHumanRequiredStateEscalation: () => {},
    runtime,
  });
}

function schedule(overrides = {}) {
  return {
    connectorId: 'chatgpt',
    connectorInstanceId: 'chatgpt:default',
    connectorPath: '/unused/connector.mjs',
    intervalMs: 60_000,
    manifest: {},
    maxRetries: 0,
    ownerToken: 'owner-token',
    ...overrides,
  };
}

function cooldown(overrides = {}) {
  return {
    cooldownApplied: true,
    effectiveIntervalMs: 120_000,
    identity: 'source_pressure:upstream_pressure:gaps=1:attempt=1',
    maxAttemptCount: 1,
    nextRunAt: '2026-07-07T08:00:00.000Z',
    pendingPressureGapCount: 1,
    recommendedHealthState: 'cooling_off',
    ...overrides,
  };
}

test('resolveCooldownSkip dedupes repeated cooldown identity and re-arms when pressure clears', (t) => {
  t.diagnostic('BASELINE: authored test active');

  const runtime = createRuntime();
  const governor = createGovernor(runtime);
  const connectorSchedule = schedule();
  const key = connectorSchedule.connectorInstanceId;
  const decision = cooldown();

  const firstSkip = governor.resolveCooldownSkip(connectorSchedule, key, decision, true, null);
  assert.ok(firstSkip, 'first deferring cooldown should emit a skip');
  assert.equal(firstSkip.status, 'skipped');
  assert.match(firstSkip.error ?? '', /source_pressure_cooldown_applied/);
  assert.equal(runtime.notifiedCooldownIdentity.get(key), decision.identity);

  const secondSkip = governor.resolveCooldownSkip(connectorSchedule, key, decision, true, null);
  assert.equal(secondSkip, null, 'same cooldown identity should not emit another skip without an existing skip');
  assert.equal(runtime.notifiedCooldownIdentity.get(key), decision.identity);

  const preservedSkip = { ...firstSkip, error: 'existing skip' };
  const clearedSkip = governor.resolveCooldownSkip(
    connectorSchedule,
    key,
    cooldown({ cooldownApplied: false, identity: null, recommendedHealthState: null }),
    false,
    preservedSkip
  );
  assert.equal(clearedSkip, preservedSkip, 'non-deferring cooldown should preserve the existing skip argument');
  assert.equal(runtime.notifiedCooldownIdentity.has(key), false);
});

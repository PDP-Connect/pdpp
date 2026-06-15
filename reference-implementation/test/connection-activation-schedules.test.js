import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachActivationScheduleIfAutomatic,
  resolveActivationRefreshContract,
} from '../server/connection-activation-schedules.ts';

function manifest(refreshPolicy) {
  return {
    connector_id: 'https://registry.example.test/connectors/custom',
    capabilities: {
      refresh_policy: refreshPolicy,
    },
  };
}

function createFakeController(initialSchedules = []) {
  const schedules = new Map(initialSchedules.map((schedule) => [schedule.connector_instance_id, schedule]));
  const upserts = [];
  return {
    schedules,
    upserts,
    async getSchedule(connectorId, options = {}) {
      const key = options.connectorInstanceId || connectorId;
      return schedules.get(key) ?? null;
    },
    async upsertSchedule(connectorId, input, options = {}) {
      const key = options.connectorInstanceId || connectorId;
      const row = {
        connector_id: connectorId,
        connector_instance_id: key,
        enabled: input.enabled,
        interval_seconds: input.interval_seconds,
        jitter_seconds: input.jitter_seconds,
      };
      upserts.push({ connectorId, input, options });
      schedules.set(key, row);
      return { schedule: row, policy_warning: null };
    },
  };
}

test('6.1: automatic background-safe manifests attach a per-connection schedule at activation', async () => {
  const controller = createFakeController();
  const result = await attachActivationScheduleIfAutomatic({
    connectorId: 'custom-automatic',
    connectorInstanceId: 'cin_auto_1',
    controller,
    manifest: manifest({
      recommended_mode: 'automatic',
      recommended_interval_seconds: 1800,
      background_safe: true,
      interaction_posture: 'credentials',
    }),
  });

  assert.equal(result.reason, 'attached');
  assert.equal(result.attached, true);
  assert.equal(result.contract.mode, 'automatic');
  assert.deepEqual(controller.upserts, [
    {
      connectorId: 'custom-automatic',
      input: {
        enabled: true,
        interval_seconds: 1800,
        jitter_seconds: 0,
      },
      options: {
        connectorInstanceId: 'cin_auto_1',
      },
    },
  ]);
  assert.equal(controller.schedules.get('cin_auto_1').connector_instance_id, 'cin_auto_1');
});

test('6.1: assisted automatic manifests still attach schedules; credential presence is not consulted', async () => {
  const controller = createFakeController();
  const result = await attachActivationScheduleIfAutomatic({
    connectorId: 'assisted-browser-account',
    connectorInstanceId: 'cin_assisted_1',
    controller,
    manifest: manifest({
      assisted_after_owner_auth: true,
      recommended_mode: 'automatic',
      recommended_interval_seconds: 3600,
      background_safe: true,
      interaction_posture: 'manual_action_likely',
    }),
  });

  assert.equal(result.reason, 'attached');
  assert.equal(controller.upserts.length, 1);
  assert.equal(controller.schedules.get('cin_assisted_1').interval_seconds, 3600);
});

test('6.1: activation preserves an existing schedule row instead of overwriting operator intent', async () => {
  const controller = createFakeController([
    {
      connector_id: 'custom-automatic',
      connector_instance_id: 'cin_existing_1',
      enabled: false,
      interval_seconds: 7200,
      jitter_seconds: 17,
    },
  ]);
  const result = await attachActivationScheduleIfAutomatic({
    connectorId: 'custom-automatic',
    connectorInstanceId: 'cin_existing_1',
    controller,
    manifest: manifest({
      recommended_mode: 'automatic',
      recommended_interval_seconds: 1800,
      background_safe: true,
    }),
  });

  assert.equal(result.reason, 'already_attached');
  assert.equal(result.attached, false);
  assert.equal(controller.upserts.length, 0);
  assert.equal(controller.schedules.get('cin_existing_1').interval_seconds, 7200);
  assert.equal(controller.schedules.get('cin_existing_1').enabled, false);
});

test('6.1: manual, paused, and background-unsafe manifests do not attach schedules', async () => {
  const cases = [
    ['manual', { recommended_mode: 'manual', recommended_interval_seconds: 1800, background_safe: true }],
    ['paused', { recommended_mode: 'paused', recommended_interval_seconds: 1800, background_safe: true }],
    ['background_unsafe', { recommended_mode: 'automatic', recommended_interval_seconds: 1800, background_safe: false }],
  ];

  for (const [expectedReason, policy] of cases) {
    const controller = createFakeController();
    const result = await attachActivationScheduleIfAutomatic({
      connectorId: `custom-${expectedReason}`,
      connectorInstanceId: `cin_${expectedReason}`,
      controller,
      manifest: manifest(policy),
    });

    assert.equal(result.reason, 'manual_contract');
    assert.equal(result.contract.mode, 'manual');
    assert.equal(result.contract.reason, expectedReason);
    assert.equal(result.attached, false);
    assert.equal(controller.upserts.length, 0);
  }
});

test('6.1: the contract resolver treats non-manual, background-safe policy as automatic', () => {
  assert.deepEqual(
    resolveActivationRefreshContract(
      manifest({
        recommended_mode: 'automatic',
        recommended_interval_seconds: 900,
        background_safe: true,
      })
    ),
    {
      backgroundSafe: true,
      intervalSeconds: 900,
      mode: 'automatic',
      reason: 'automatic',
      recommendedMode: 'automatic',
    }
  );
});

/**
 * Auto-enrollment for proven, env-wired connectors.
 *
 * Covers the boot-time helper that closes the "registered, listed,
 * proven, env-wired, silently unscheduled" gap for connectors like
 * Notion, Oura, and Strava. The contract under test:
 *
 *   - Eligible-with-env: a manifest that is automatic, background-safe,
 *     listed, proven, and declares `capabilities.auth.required` whose
 *     env names are all populated on `process.env` gets a new enabled
 *     schedule row at the manifest-recommended interval.
 *   - Eligible-without-env: the same manifest with one env name unset
 *     produces no row.
 *   - Ineligible policy: manual / paused / background-unsafe / unproven
 *     produces no row even when env is set.
 *   - Idempotency: a second pass over the same controller is a no-op;
 *     an operator-paused row stays paused.
 *
 * Spec: openspec/changes/auto-enroll-eligible-connector-schedules/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { autoEnrollEligibleSchedules } from '../server/auto-enroll-eligible-schedules.ts';

function manifest(overrides = {}) {
  return {
    connector_id: 'https://registry.example.test/connectors/widget',
    version: '0.1.0',
    capabilities: {
      refresh_policy: {
        recommended_mode: 'automatic',
        background_safe: true,
        recommended_interval_seconds: 1800,
      },
      public_listing: {
        listed: true,
        status: 'proven',
      },
      auth: {
        kind: 'env',
        required: ['WIDGET_TOKEN'],
      },
    },
    ...overrides,
  };
}

function createFakeController() {
  const schedules = new Map();
  return {
    schedules,
    getSchedule: async (connectorId) => schedules.get(connectorId) ?? null,
    upsertSchedule: async (connectorId, input) => {
      const now = new Date().toISOString();
      const row = {
        connector_id: connectorId,
        enabled: input.enabled,
        interval_seconds: input.interval_seconds,
        jitter_seconds: input.jitter_seconds,
        created_at: schedules.get(connectorId)?.created_at ?? now,
        updated_at: now,
      };
      schedules.set(connectorId, row);
      return { schedule: row, policy_warning: null };
    },
  };
}

function singleManifestList(m) {
  return async () => [{ connector_id: m.connector_id, manifest: m }];
}

test('eligible-with-env enrolls a new schedule at the manifest-recommended interval', async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.errors, 0);
  assert.equal(summary.skipped_env, 0);
  assert.equal(summary.skipped_existing, 0);
  assert.equal(summary.skipped_policy, 0);
  const enrolled = controller.schedules.get(m.connector_id);
  assert.ok(enrolled, 'a row was inserted');
  assert.equal(enrolled.enabled, true, 'enrolled enabled');
  assert.equal(enrolled.interval_seconds, 1800, 'recommended interval honored');
  assert.equal(enrolled.jitter_seconds, 0);
});

test('eligible manifest without recommended_interval_seconds falls back to 3600', async () => {
  const controller = createFakeController();
  const m = manifest();
  delete m.capabilities.refresh_policy.recommended_interval_seconds;
  await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(controller.schedules.get(m.connector_id).interval_seconds, 3600);
});

test('missing env keeps the connector honestly unscheduled and counts skipped_env', async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { /* WIDGET_TOKEN intentionally absent */ },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.skipped_env, 1);
  assert.equal(controller.schedules.size, 0);
});

test('blank or whitespace-only env value is treated as missing', async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: '   ' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_env, 1);
  assert.equal(controller.schedules.size, 0);
});

test('alias-array entry is satisfied when the fallback alias is set', async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: { kind: 'env', required: [['WIDGET_TOKEN', 'WIDGET_PAT']] },
    },
  });
  // Only the fallback alias is set; the first-listed alias is empty.
  // Runtime first-set-wins says this is enough credential; the enrollment
  // gate must agree.
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_PAT: 'alt-set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.skipped_env, 0);
});

test('alias-array entry is satisfied when the first-listed alias is set', async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: { kind: 'env', required: [['WIDGET_TOKEN', 'WIDGET_PAT']] },
    },
  });
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'primary-set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
});

test('alias-array entry is unsatisfied only when EVERY alias is absent or empty', async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: { kind: 'env', required: [['WIDGET_TOKEN', 'WIDGET_PAT']] },
    },
  });
  // Both aliases present-but-empty count as unsatisfied (whitespace is
  // treated as missing, same as the runtime).
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: '', WIDGET_PAT: '   ' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.skipped_env, 1);
});

test('mixed string + alias-array entries each apply their own rule', async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: {
        kind: 'env',
        required: ['WIDGET_TOKEN', ['WIDGET_REGION', 'WIDGET_DEFAULT_REGION']],
      },
    },
  });
  // String entry: WIDGET_TOKEN must itself be non-empty.
  // Alias entry: any one of WIDGET_REGION / WIDGET_DEFAULT_REGION suffices.
  const satisfied = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set', WIDGET_DEFAULT_REGION: 'us-east-1' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(satisfied.enrolled, 1);

  const controller2 = createFakeController();
  // String entry missing -> whole requirement fails, even though the
  // alias is satisfied.
  const stringMissing = await autoEnrollEligibleSchedules({
    controller: controller2,
    env: { WIDGET_DEFAULT_REGION: 'us-east-1' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(stringMissing.skipped_env, 1);
  assert.equal(stringMissing.enrolled, 0);

  const controller3 = createFakeController();
  // Alias entirely absent -> requirement fails, even though the string
  // is satisfied.
  const aliasMissing = await autoEnrollEligibleSchedules({
    controller: controller3,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(aliasMissing.skipped_env, 1);
  assert.equal(aliasMissing.enrolled, 0);
});

test('manual refresh policy is never auto-enrolled even when env is present', async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.recommended_mode = 'manual';
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test('background_safe=false is never auto-enrolled even when env is present', async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.background_safe = false;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test('assisted_after_owner_auth=true is never auto-enrolled even when env is present', async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.assisted_after_owner_auth = true;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
  assert.equal(controller.schedules.size, 0);
});

test('public_listing.status != "proven" is never auto-enrolled', async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.public_listing.status = 'pilot';
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test('public_listing.listed != true is never auto-enrolled', async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.public_listing.listed = false;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test('manifest without capabilities.auth.required cannot be auto-enrolled', async () => {
  const controller = createFakeController();
  const m = manifest();
  delete m.capabilities.auth;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  // Categorized as skipped_policy: the manifest does not declare the
  // gating contract this pass needs. The connector remains visible in
  // the catalog and the doctor still reports it as NOSCHED.
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test('existing schedule row is never overwritten (idempotent re-run)', async () => {
  const controller = createFakeController();
  const m = manifest();
  // Pretend the operator already paused the schedule with a custom interval.
  controller.schedules.set(m.connector_id, {
    connector_id: m.connector_id,
    enabled: false,
    interval_seconds: 60,
    jitter_seconds: 15,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  });
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_existing, 1);
  assert.equal(summary.enrolled, 0);
  const row = controller.schedules.get(m.connector_id);
  assert.equal(row.enabled, false, 'operator-paused row stays paused');
  assert.equal(row.interval_seconds, 60, 'operator-set interval is preserved');
  assert.equal(row.jitter_seconds, 15);
});

test('second pass after enrollment is a no-op', async () => {
  const controller = createFakeController();
  const m = manifest();
  await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  const firstRow = { ...controller.schedules.get(m.connector_id) };
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.skipped_existing, 1);
  // updated_at may differ only because of a write — but no write should
  // have happened. Compare the full row instead.
  assert.deepEqual(controller.schedules.get(m.connector_id), firstRow);
});

test('enabled=false short-circuits the entire pass', async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    enabled: false,
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.scanned, 0);
  assert.equal(summary.enrolled, 0);
  assert.equal(controller.schedules.size, 0);
});

test('multiple connectors are evaluated independently in one pass', async () => {
  const controller = createFakeController();
  const eligible = manifest({ connector_id: 'eligible' });
  const noEnv = manifest({ connector_id: 'no-env' });
  const manual = manifest({ connector_id: 'manual' });
  manual.capabilities.refresh_policy.recommended_mode = 'manual';
  const list = async () => [
    { connector_id: eligible.connector_id, manifest: eligible },
    { connector_id: noEnv.connector_id, manifest: noEnv },
    { connector_id: manual.connector_id, manifest: manual },
  ];
  // Same WIDGET_TOKEN env satisfies eligible and manual; manual is still
  // blocked by policy. no-env has its own required env that we leave unset.
  const noEnvManifest = { ...noEnv };
  noEnvManifest.capabilities = {
    ...noEnv.capabilities,
    auth: { kind: 'env', required: ['NO_ENV_TOKEN'] },
  };
  const list2 = async () => [
    { connector_id: eligible.connector_id, manifest: eligible },
    { connector_id: noEnvManifest.connector_id, manifest: noEnvManifest },
    { connector_id: manual.connector_id, manifest: manual },
  ];
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: list2,
  });
  assert.equal(summary.scanned, 3);
  assert.equal(summary.enrolled, 1, 'only eligible was enrolled');
  assert.equal(summary.skipped_env, 1, 'no-env was skipped by env gate');
  assert.equal(summary.skipped_policy, 1, 'manual was skipped by policy');
  assert.ok(controller.schedules.has('eligible'));
  assert.ok(!controller.schedules.has('no-env'));
  assert.ok(!controller.schedules.has('manual'));
  // Suppress the unused-var lint without changing test scope: `list` was
  // used to express the alternate shape before the override.
  void list;
});

test('controller upsertSchedule throwing increments errors and continues', async () => {
  const controller = {
    getSchedule: async () => null,
    upsertSchedule: async () => {
      throw new Error('boom');
    },
  };
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: 'set' },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.errors, 1);
  assert.equal(summary.enrolled, 0);
});

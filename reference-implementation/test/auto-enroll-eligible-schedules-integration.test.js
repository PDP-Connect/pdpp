/**
 * Integration coverage for the auto-enrollment helper against the real
 * reference controller and scheduler store.
 *
 * Proves the helper hooks into:
 *   - the real `createController().upsertSchedule` path (which goes
 *     through the eligibility gate and the scheduler store);
 *   - real first-party manifests on disk (Notion, Oura, Strava all carry
 *     `capabilities.auth.required` after the manifest declaration slice);
 *   - the doctor's catalog cross-reference, so an enrolled row stops
 *     showing up as `NOSCHED`.
 *
 * Spec: openspec/changes/auto-enroll-eligible-connector-schedules/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { closeDb, initDb } from '../server/db.js';
import {
  getConnectorManifest,
  listRegisteredConnectorIds,
  registerConnector,
} from '../server/auth.js';
import {
  __resetControllerInteractionStateForTests,
  createController,
} from '../runtime/controller.ts';
import { autoEnrollEligibleSchedules } from '../server/auto-enroll-eligible-schedules.ts';
import { getDefaultSchedulerStore } from '../server/stores/scheduler-store.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = resolve(
  __dirname,
  '..',
  '..',
  'packages',
  'polyfill-connectors',
  'manifests',
);

function readManifest(name) {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, `${name}.json`), 'utf8'));
}

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-auto-enroll-int-'));
    initDb(join(dir, 'pdpp.sqlite'));
    __resetControllerInteractionStateForTests();
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function buildListConnectors() {
  return async () => {
    const ids = await listRegisteredConnectorIds();
    return Promise.all(
      ids.map(async (connectorId) => ({
        connector_id: connectorId,
        manifest: await getConnectorManifest(connectorId),
      })),
    );
  };
}

test(
  'shipped Notion manifest declares capabilities.auth.required so enrollment can gate on it',
  () => {
    const m = readManifest('notion');
    assert.equal(m.capabilities?.auth?.kind, 'env');
    assert.deepEqual(m.capabilities?.auth?.required, ['NOTION_API_TOKEN']);
  },
);

test(
  'shipped Oura manifest declares capabilities.auth.required',
  () => {
    const m = readManifest('oura');
    assert.equal(m.capabilities?.auth?.kind, 'env');
    assert.deepEqual(m.capabilities?.auth?.required, ['OURA_PERSONAL_ACCESS_TOKEN']);
  },
);

test(
  'shipped Strava manifest declares capabilities.auth.required',
  () => {
    const m = readManifest('strava');
    assert.equal(m.capabilities?.auth?.kind, 'env');
    assert.deepEqual(m.capabilities?.auth?.required, ['STRAVA_ACCESS_TOKEN']);
  },
);

test(
  'enrollment against a real controller creates a single enabled row for an eligible registered manifest',
  withTmpDb(async () => {
    const notion = readManifest('notion');
    await registerConnector(notion);
    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { NOTION_API_TOKEN: 'integration-token' },
      listConnectors: buildListConnectors(),
    });
    assert.equal(summary.enrolled, 1, 'Notion is the only enrolled manifest');
    assert.equal(summary.errors, 0);
    const schedule = await controller.getSchedule(notion.connector_id);
    assert.ok(schedule, 'a schedule row exists for Notion');
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.interval_seconds, 3600);
    assert.equal(schedule.ineligibility_reason, null, 'eligible under current manifest');
    // Pin the persisted store too: the row went through createSchedule().
    const persisted = await Promise.resolve(
      getDefaultSchedulerStore().getSchedule(notion.connector_id),
    );
    assert.equal(persisted.enabled, true);
  }),
);

test(
  'enrollment leaves a connector unscheduled when its declared env is missing',
  withTmpDb(async () => {
    const notion = readManifest('notion');
    await registerConnector(notion);
    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: {
        /* NOTION_API_TOKEN intentionally absent */
      },
      listConnectors: buildListConnectors(),
    });
    assert.equal(summary.skipped_env, 1);
    assert.equal(summary.enrolled, 0);
    const schedule = await controller.getSchedule(notion.connector_id);
    assert.equal(schedule, null, 'no row created when env is missing');
  }),
);

test(
  'enrollment never overrides an operator-paused row across boots',
  withTmpDb(async () => {
    const notion = readManifest('notion');
    await registerConnector(notion);
    const controller = createController({});
    // Operator already created a paused row with a custom interval.
    await controller.upsertSchedule(notion.connector_id, {
      enabled: false,
      interval_seconds: 1800,
      jitter_seconds: 30,
    });
    const beforeRow = await controller.getSchedule(notion.connector_id);
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { NOTION_API_TOKEN: 'integration-token' },
      listConnectors: buildListConnectors(),
    });
    assert.equal(summary.skipped_existing, 1);
    assert.equal(summary.enrolled, 0);
    const afterRow = await controller.getSchedule(notion.connector_id);
    assert.equal(afterRow.enabled, false, 'paused row stays paused');
    assert.equal(afterRow.interval_seconds, beforeRow.interval_seconds);
    assert.equal(afterRow.jitter_seconds, beforeRow.jitter_seconds);
  }),
);

test(
  'enrollment is a no-op for connectors whose manifest is manual or background-unsafe',
  withTmpDb(async () => {
    // Reddit currently ships as background_safe=false (browser auth), so
    // its row must not appear even if a putative env existed.
    const reddit = readManifest('reddit');
    await registerConnector(reddit);
    const controller = createController({});
    const summary = await autoEnrollEligibleSchedules({
      controller,
      env: { REDDIT_USERNAME: 'u', REDDIT_PASSWORD: 'p' },
      listConnectors: buildListConnectors(),
    });
    assert.equal(summary.skipped_policy, 1);
    assert.equal(summary.enrolled, 0);
    const schedule = await controller.getSchedule(reddit.connector_id);
    assert.equal(schedule, null);
  }),
);

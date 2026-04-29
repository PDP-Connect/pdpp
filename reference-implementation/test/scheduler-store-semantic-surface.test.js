/**
 * Pins the semantic surface of the production `SchedulerStore`.
 *
 * The store wraps SQLite tables that store `enabled` as a `0 | 1`
 * integer. The public surface MUST hide that representation: every
 * `ScheduleRecord` returned by `getSchedule` / `listSchedules` MUST
 * carry `enabled: boolean`. Any future regression that re-leaks the
 * SQLite-flavored `0 | 1` numeric through the public surface (e.g. by
 * skipping the row→record mapper) will fail this test.
 *
 * Method names are also pinned: a future change that renamed
 * `createSchedule` back to `insert` or split the registries into
 * `store.schedules.*` / `store.activeRuns.*` namespaces would fail
 * compilation, but the runtime checks below add a belt-and-braces
 * assertion in case a `// eslint-disable` or a casted type slipped past
 * review.
 *
 * Spec: openspec/changes/extract-low-risk-reference-stores/design.md
 *       (Decision 4: "Interfaces are semantic, not table-shaped").
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, initDb } from '../server/db.js';
import { registerConnector } from '../server/auth.js';
import { createSqliteSchedulerStore } from '../server/stores/scheduler-store.ts';

const SEMANTIC_CONNECTOR = 'https://test.pdpp.org/connectors/semantic-surface';

const SEMANTIC_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: SEMANTIC_CONNECTOR,
  version: '1.0.0',
  display_name: 'Semantic Surface Connector',
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      name: 'stream_x',
      semantics: 'mutable_state',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      primary_key: ['id'],
    },
  ],
};

async function withFreshStore(fn) {
  initDb();
  await registerConnector(SEMANTIC_MANIFEST);
  const store = createSqliteSchedulerStore();
  try {
    await fn(store);
  } finally {
    closeDb();
  }
}

test('SchedulerStore exposes only semantic schedule lifecycle methods', () => {
  const store = createSqliteSchedulerStore();
  const expected = [
    'createSchedule',
    'deleteSchedule',
    'getSchedule',
    'listSchedules',
    'setScheduleEnabled',
    'updateSchedule',
    'deleteActiveRun',
    'listActiveRuns',
    'upsertActiveRun',
  ];
  for (const name of expected) {
    assert.equal(typeof store[name], 'function', `expected ${name} on store`);
  }

  // No table-shaped or namespaced surfaces leak through.
  const forbidden = ['insert', 'update', 'delete', 'schedules', 'activeRuns', 'getDb', 'exec'];
  for (const name of forbidden) {
    assert.equal(
      store[name],
      undefined,
      `SchedulerStore must not expose '${name}' — interfaces are semantic, not table-shaped`,
    );
  }
});

test('createSchedule + getSchedule round-trip surfaces enabled as a boolean (true)', async () => {
  await withFreshStore((store) => {
    const now = '2026-04-29T00:00:00.000Z';
    store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      interval_seconds: 600,
      jitter_seconds: 30,
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    const got = store.getSchedule(SEMANTIC_CONNECTOR);
    assert.ok(got, 'expected a schedule record');
    assert.equal(typeof got.enabled, 'boolean', 'enabled must round-trip as a boolean, not a 0|1 integer');
    assert.equal(got.enabled, true);
    assert.notEqual(got.enabled, 1, 'enabled must not leak the SQLite 0|1 representation');
  });
});

test('createSchedule + getSchedule round-trip surfaces enabled as a boolean (false)', async () => {
  await withFreshStore((store) => {
    const now = '2026-04-29T00:00:00.000Z';
    store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      interval_seconds: 600,
      jitter_seconds: 30,
      enabled: false,
      created_at: now,
      updated_at: now,
    });

    const got = store.getSchedule(SEMANTIC_CONNECTOR);
    assert.ok(got, 'expected a schedule record');
    assert.equal(typeof got.enabled, 'boolean', 'enabled must round-trip as a boolean, not a 0|1 integer');
    assert.equal(got.enabled, false);
    assert.notEqual(got.enabled, 0, 'enabled must not leak the SQLite 0|1 representation');
  });
});

test('setScheduleEnabled toggles the boolean without leaking 0|1', async () => {
  await withFreshStore((store) => {
    const now = '2026-04-29T00:00:00.000Z';
    store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      interval_seconds: 600,
      jitter_seconds: 0,
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    store.setScheduleEnabled(SEMANTIC_CONNECTOR, false, '2026-04-29T00:00:01.000Z');
    const paused = store.getSchedule(SEMANTIC_CONNECTOR);
    assert.equal(typeof paused.enabled, 'boolean');
    assert.equal(paused.enabled, false);

    store.setScheduleEnabled(SEMANTIC_CONNECTOR, true, '2026-04-29T00:00:02.000Z');
    const resumed = store.getSchedule(SEMANTIC_CONNECTOR);
    assert.equal(typeof resumed.enabled, 'boolean');
    assert.equal(resumed.enabled, true);
  });
});

test('listSchedules entries each surface enabled as a boolean', async () => {
  await withFreshStore((store) => {
    const now = '2026-04-29T00:00:00.000Z';
    store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      interval_seconds: 600,
      jitter_seconds: 0,
      enabled: false,
      created_at: now,
      updated_at: now,
    });

    const list = store.listSchedules();
    assert.equal(list.length, 1);
    for (const record of list) {
      assert.equal(
        typeof record.enabled,
        'boolean',
        'every listSchedules() entry must carry enabled as a boolean',
      );
    }
  });
});

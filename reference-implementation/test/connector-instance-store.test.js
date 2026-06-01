import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  ConnectorInstanceResolutionError,
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
  resolveOwnerConnectorInstanceNamespace,
} from '../server/stores/connector-instance-store.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const NOW = '2026-05-15T12:00:00.000Z';
const LATER = '2026-05-15T12:01:00.000Z';

function makeDriver(store) {
  return {
    async call(method, ...args) {
      return await store[method](...args);
    },
  };
}

async function seedSqliteConnector(connectorId) {
  getDb()
    .prepare(`INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)`)
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

async function seedPostgresConnector(connectorId) {
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES($1, $2::jsonb, $3)
     ON CONFLICT(connector_id) DO NOTHING`,
    [connectorId, JSON.stringify({ connector_id: connectorId }), NOW],
  );
}

async function runConformance({ makeStore, seedConnector }) {
  const store = await makeStore();
  const driver = makeDriver(store);

  await seedConnector('gmail');
  await seedConnector('claude-code');
  await seedConnector('reddit');

  const defaultAccount = await driver.call('ensureDefaultAccountConnection', {
    ownerSubjectId: 'owner_1',
    connectorId: 'gmail',
    displayName: 'Gmail',
    now: NOW,
  });
  assert.equal(defaultAccount.connectorInstanceId, makeDefaultAccountConnectorInstanceId('owner_1', 'gmail'));
  assert.equal(defaultAccount.sourceKind, 'account');
  assert.deepEqual(defaultAccount.sourceBinding, { kind: 'default_account' });
  assert.equal((await driver.call('resolveActiveByConnector', 'owner_1', 'gmail')).connectorInstanceId, defaultAccount.connectorInstanceId);
  assert.deepEqual(
    await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_1',
      connectorId: 'gmail',
      connectorInstanceStore: store,
    }),
    {
      ownerSubjectId: 'owner_1',
      connectorId: 'gmail',
      connectorInstanceId: defaultAccount.connectorInstanceId,
      displayName: 'Gmail',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'default',
      sourceBinding: { kind: 'default_account' },
      selector: 'connector_id',
      createdDefaultAccount: false,
    },
  );

  const work = await driver.call('upsert', {
    connectorInstanceId: 'cin_gmail_work',
    ownerSubjectId: 'owner_2',
    connectorId: 'gmail',
    displayName: 'Gmail - work',
    sourceKind: 'account',
    sourceBindingKey: 'acct_work',
    sourceBinding: { account_hint: 'work@example.test' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const personal = await driver.call('upsert', {
    connectorInstanceId: 'cin_gmail_personal',
    ownerSubjectId: 'owner_2',
    connectorId: 'gmail',
    displayName: 'Gmail - personal',
    sourceKind: 'account',
    sourceBindingKey: 'acct_personal',
    sourceBinding: { account_hint: 'personal@example.test' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(work.connectorId, personal.connectorId);
  assert.notEqual(work.connectorInstanceId, personal.connectorInstanceId);

  const ownerInstances = await driver.call('listByOwner', 'owner_2');
  assert.deepEqual(ownerInstances.map((row) => row.connectorInstanceId), ['cin_gmail_personal', 'cin_gmail_work']);
  assert.equal(
    (await driver.call('getByBinding', {
      ownerSubjectId: 'owner_2',
      connectorId: 'gmail',
      sourceKind: 'account',
      sourceBindingKey: 'acct_work',
    })).connectorInstanceId,
    'cin_gmail_work',
  );
  assert.equal(
    (await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    })).connectorInstanceId,
    'cin_gmail_work',
  );
  assert.equal(
    (await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorId: 'gmail',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    })).connectorId,
    'gmail',
  );

  await assert.rejects(
    () => driver.call('resolveActiveByConnector', 'owner_2', 'gmail'),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'ambiguous_connector_instance',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorId: 'gmail',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'ambiguous_connector_instance',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_1',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_owner_mismatch',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorId: 'claude-code',
      connectorInstanceId: 'cin_gmail_work',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_connector_mismatch',
  );

  await driver.call('updateStatus', 'cin_gmail_personal', {
    status: 'paused',
    updatedAt: LATER,
  });
  assert.equal((await driver.call('resolveActiveByConnector', 'owner_2', 'gmail')).connectorInstanceId, 'cin_gmail_work');
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_2',
      connectorInstanceId: 'cin_gmail_personal',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_inactive',
  );

  await driver.call('upsert', {
    connectorInstanceId: 'cin_claude_laptop',
    ownerSubjectId: 'owner_2',
    connectorId: 'claude-code',
    displayName: 'Claude Code - laptop',
    sourceKind: 'local_device',
    sourceBindingKey: 'dev_laptop:default',
    sourceBinding: { device_id: 'dev_laptop', local_binding_id: 'default' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await driver.call('upsert', {
    connectorInstanceId: 'cin_claude_desktop',
    ownerSubjectId: 'owner_2',
    connectorId: 'claude-code',
    displayName: 'Claude Code - desktop',
    sourceKind: 'local_device',
    sourceBindingKey: 'dev_desktop:default',
    sourceBinding: { device_id: 'dev_desktop', local_binding_id: 'default' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await assert.rejects(
    () => driver.call('resolveActiveByConnector', 'owner_2', 'claude-code'),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'ambiguous_connector_instance',
  );

  await assert.rejects(
    () => driver.call('resolveActiveByConnector', 'owner_2', 'missing'),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_not_found',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_3',
      connectorId: 'reddit',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_not_found',
  );
  const created = await resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId: 'owner_3',
    connectorId: 'reddit',
    displayName: 'Reddit',
    connectorInstanceStore: store,
    allowDefaultAccount: true,
    now: NOW,
  });
  assert.equal(created.connectorInstanceId, makeDefaultAccountConnectorInstanceId('owner_3', 'reddit'));
  assert.equal(created.createdDefaultAccount, true);
  assert.equal(created.selector, 'connector_id');
  const defaultHint = await resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId: 'owner_4',
    connectorId: 'reddit',
    connectorInstanceId: 'reddit',
    displayName: 'Reddit',
    connectorInstanceStore: store,
    allowDefaultAccount: true,
    now: NOW,
  });
  assert.equal(defaultHint.connectorInstanceId, makeDefaultAccountConnectorInstanceId('owner_4', 'reddit'));
  assert.equal(defaultHint.createdDefaultAccount, true);
  assert.equal(defaultHint.selector, 'connector_id');
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_3',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_selector_required',
  );

  // --- Durability guard: a revoked default-account connection is never
  // silently resurrected by default-account materialization (Unit 1 of the
  // owner-agent revoke packet). This is the regression that fails without the
  // guard: ensureDefaultAccountConnection's ON CONFLICT ... DO UPDATE SET
  // status = excluded.status used to flip the deterministically-keyed revoked
  // row back to active on the next owner read/ingest. ---
  await seedConnector('github');
  const ghDefault = await resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId: 'owner_5',
    connectorId: 'github',
    displayName: 'GitHub',
    connectorInstanceStore: store,
    allowDefaultAccount: true,
    now: NOW,
  });
  assert.equal(ghDefault.connectorInstanceId, makeDefaultAccountConnectorInstanceId('owner_5', 'github'));
  assert.equal(ghDefault.status, 'active');
  assert.equal(ghDefault.createdDefaultAccount, true);

  // The owner revokes the default-account connection (the connection-scoped,
  // zero-cascade soft flip the owner-agent revoke route shares).
  await driver.call('updateStatus', ghDefault.connectorInstanceId, {
    status: 'revoked',
    updatedAt: LATER,
    revokedAt: LATER,
  });
  assert.equal((await driver.call('get', ghDefault.connectorInstanceId)).status, 'revoked');

  // ensureDefaultAccountConnection (the direct dashboard-materialization
  // caller) returns the revoked row UNCHANGED — it does not flip to active.
  const reEnsured = await driver.call('ensureDefaultAccountConnection', {
    ownerSubjectId: 'owner_5',
    connectorId: 'github',
    displayName: 'GitHub',
    now: LATER,
  });
  assert.equal(reEnsured.status, 'revoked', 'ensureDefaultAccountConnection must not resurrect a revoked default account');
  assert.equal((await driver.call('get', ghDefault.connectorInstanceId)).status, 'revoked');

  // The owner resolution path (read/ingest, allowDefaultAccount: true) fails
  // closed with connector_instance_not_found instead of binding to / writing
  // through a revoked connection. The revoke survives this resolution AND a
  // second one (proves durability across at least two reads).
  for (const reattempt of [1, 2]) {
    await assert.rejects(
      () => resolveOwnerConnectorInstanceNamespace({
        ownerSubjectId: 'owner_5',
        connectorId: 'github',
        connectorInstanceStore: store,
        allowDefaultAccount: true,
        now: LATER,
      }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_not_found',
      `revoked default account must stay revoked across read ${reattempt}`,
    );
    assert.equal(
      (await driver.call('get', ghDefault.connectorInstanceId)).status,
      'revoked',
      `revoked default account row must remain revoked after read ${reattempt}`,
    );
  }

  // Guard does not over-reach: a brand-new connector with no prior row still
  // materializes an active default-account connection.
  await seedConnector('spotify');
  const freshDefault = await resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId: 'owner_5',
    connectorId: 'spotify',
    connectorInstanceStore: store,
    allowDefaultAccount: true,
    now: LATER,
  });
  assert.equal(freshDefault.status, 'active');
  assert.equal(freshDefault.createdDefaultAccount, true);
}

test('SQLite ConnectorInstanceStore supports default account connections and ambiguous connector-only resolution', async () => {
  initDb();
  try {
    await runConformance({
      makeStore: () => createSqliteConnectorInstanceStore(),
      seedConnector: seedSqliteConnector,
    });
  } finally {
    closeDb();
  }
});

// ─── deleteConnection store primitive (add-owner-connection-delete-contract) ──

function seedDeletableInstance(store, { connectorInstanceId, connectorId, sourceKind = 'account', sourceBindingKey }) {
  return store.upsert({
    connectorInstanceId,
    ownerSubjectId: 'owner_1',
    connectorId,
    displayName: connectorInstanceId,
    status: 'active',
    sourceKind,
    sourceBindingKey,
    sourceBinding: { hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedScheduleRow(connectorInstanceId, connectorId) {
  getDb()
    .prepare(
      `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
       VALUES(?, ?, 3600, 0, 1, ?, ?)`,
    )
    .run(connectorInstanceId, connectorId, NOW, NOW);
}

test('SQLite deleteConnection erases schedule + row + device back-ref and refuses run-active / default-account', async () => {
  initDb();
  try {
    const store = createSqliteConnectorInstanceStore();
    await seedSqliteConnector('reddit');

    // A deletable explicit-account connection with a schedule and a device
    // source-instance back-reference.
    await seedDeletableInstance(store, { connectorInstanceId: 'cin_del', connectorId: 'reddit', sourceBindingKey: 'the owner' });
    seedScheduleRow('cin_del', 'reddit');
    getDb()
      .prepare(`INSERT OR IGNORE INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at) VALUES('dev_x','owner_1','dev_x','active',?,?)`)
      .run(NOW, NOW);
    getDb()
      .prepare(`INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, status, created_at, updated_at) VALUES('dsi_x','dev_x','reddit','cin_del','lb_x','active',?,?)`)
      .run(NOW, NOW);

    let purgeCalls = 0;
    const summary = await store.deleteConnection('cin_del', {
      ownerSubjectId: 'owner_1',
      now: LATER,
      purgeConnectionData: (target) => {
        purgeCalls += 1;
        assert.equal(target.connector_instance_id, 'cin_del');
        return Promise.resolve({ deletedRecordCount: 4, deletedStreamCount: 2 });
      },
    });
    assert.equal(purgeCalls, 1, 'purgeConnectionData invoked exactly once');
    assert.equal(summary.connection_id, 'cin_del');
    assert.equal(summary.deleted_record_count, 4);
    assert.equal(summary.schedule_deleted, true);
    assert.equal(summary.device_refs_cleared, 1);

    assert.equal(store.get('cin_del'), null, 'connector_instances row gone');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM connector_schedules WHERE connector_instance_id=?').get('cin_del').n, 0, 'schedule gone');
    const dsi = getDb().prepare('SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id=?').get('dsi_x');
    assert.equal(dsi.connector_instance_id, null, 'device back-ref cleared');
    assert.ok(getDb().prepare('SELECT device_id FROM device_exporters WHERE device_id=?').get('dev_x'), 'device edge preserved');

    // Repeat delete → typed not-found (idempotency I4).
    await assert.rejects(
      () => store.deleteConnection('cin_del', { ownerSubjectId: 'owner_1', now: LATER, purgeConnectionData: () => Promise.resolve({}) }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_not_found',
    );

    // Foreign-owner → typed not-found, no purge (I5).
    await seedDeletableInstance(store, { connectorInstanceId: 'cin_foreign', connectorId: 'reddit', sourceBindingKey: 'other' });
    getDb().prepare(`UPDATE connector_instances SET owner_subject_id='owner_2' WHERE connector_instance_id='cin_foreign'`).run();
    let foreignPurge = 0;
    await assert.rejects(
      () => store.deleteConnection('cin_foreign', { ownerSubjectId: 'owner_1', now: LATER, purgeConnectionData: () => { foreignPurge += 1; return Promise.resolve({}); } }),
      (err) => err.code === 'connector_instance_not_found',
    );
    assert.equal(foreignPurge, 0, 'foreign delete never reaches purge');
    assert.ok(store.get('cin_foreign'), 'foreign connection not erased');

    // Active-run lease → typed connection_run_active, no purge (I7).
    await seedDeletableInstance(store, { connectorInstanceId: 'cin_run', connectorId: 'reddit', sourceBindingKey: 'runner' });
    getDb()
      .prepare(`INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at) VALUES('cin_run','reddit','run_1','trc','default',?)`)
      .run(NOW);
    let runPurge = 0;
    await assert.rejects(
      () => store.deleteConnection('cin_run', { ownerSubjectId: 'owner_1', now: LATER, purgeConnectionData: () => { runPurge += 1; return Promise.resolve({}); } }),
      (err) => err.code === 'connection_run_active',
    );
    assert.equal(runPurge, 0, 'run-active delete never reaches purge');
    assert.ok(store.get('cin_run'), 'run-active connection not erased');

    // Default-account binding → typed default_account_delete_unsupported, no
    // purge, row untouched (I6 / Decision 1 fallback).
    const defaultId = makeDefaultAccountConnectorInstanceId('owner_1', 'reddit');
    await store.ensureDefaultAccountConnection({ ownerSubjectId: 'owner_1', connectorId: 'reddit', displayName: 'Reddit', now: NOW });
    let defaultPurge = 0;
    await assert.rejects(
      () => store.deleteConnection(defaultId, { ownerSubjectId: 'owner_1', now: LATER, purgeConnectionData: () => { defaultPurge += 1; return Promise.resolve({}); } }),
      (err) => err.code === 'default_account_delete_unsupported',
    );
    assert.equal(defaultPurge, 0, 'default-account delete never reaches purge');
    assert.equal(store.get(defaultId).status, 'active', 'default-account row untouched');
  } finally {
    closeDb();
  }
});

test('SQLite deleteConnection is all-or-nothing: a purge failure leaves the row, schedule, and device back-ref intact (I8)', async () => {
  initDb();
  try {
    const store = createSqliteConnectorInstanceStore();
    await seedSqliteConnector('reddit');
    await seedDeletableInstance(store, { connectorInstanceId: 'cin_atomic', connectorId: 'reddit', sourceBindingKey: 'atom' });
    seedScheduleRow('cin_atomic', 'reddit');
    getDb()
      .prepare(`INSERT OR IGNORE INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at) VALUES('dev_a','owner_1','dev_a','active',?,?)`)
      .run(NOW, NOW);
    getDb()
      .prepare(`INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, status, created_at, updated_at) VALUES('dsi_a','dev_a','reddit','cin_atomic','lb_a','active',?,?)`)
      .run(NOW, NOW);

    // The data purge runs FIRST and fails. Because it owns its own atomic
    // transaction and the schedule/device/row deletes only run AFTER a
    // successful purge, the failure leaves the connection fully present: row,
    // schedule, and device back-reference all intact (no half-deleted state).
    await assert.rejects(
      () => store.deleteConnection('cin_atomic', {
        ownerSubjectId: 'owner_1',
        now: LATER,
        purgeConnectionData: () => Promise.reject(new Error('injected mid-cascade failure')),
      }),
      /injected mid-cascade failure/,
    );

    assert.ok(store.get('cin_atomic'), 'connector_instances row still present after purge failure');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM connector_schedules WHERE connector_instance_id=?').get('cin_atomic').n, 1, 'schedule still present');
    const dsi = getDb().prepare('SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id=?').get('dsi_a');
    assert.equal(dsi.connector_instance_id, 'cin_atomic', 'device back-ref still intact');
  } finally {
    closeDb();
  }
});

test('Postgres ConnectorInstanceStore conforms when PDPP_TEST_POSTGRES_URL is set', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
  try {
    await postgresQuery(`DELETE FROM connector_instances WHERE owner_subject_id IN ('owner_1', 'owner_2', 'owner_3', 'owner_4', 'owner_5')`);
    await runConformance({
      makeStore: () => createPostgresConnectorInstanceStore(),
      seedConnector: seedPostgresConnector,
    });
  } finally {
    await postgresQuery(`DELETE FROM connector_instances WHERE owner_subject_id IN ('owner_1', 'owner_2', 'owner_3', 'owner_4', 'owner_5')`);
    await postgresQuery(`DELETE FROM connectors WHERE connector_id IN ('gmail', 'claude-code', 'reddit', 'github', 'spotify')`);
    await closePostgresStorage();
  }
});

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
import {
  deleteConnectionRecordRowsSqlite,
  enumerateConnectionStreams,
  teardownConnectionSearchProjection,
} from '../server/records.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

// The real records-side cascade phases, wired the way the host injects them in
// `server/index.js`. Tests that want to assert real record-purge atomicity use
// this; tests that only exercise the store's schedule/device/row arm can pass a
// `purge` that stubs out the record phase (see `stubPurge`).
const realSqlitePurge = {
  enumerateStreams: (storageTarget) => enumerateConnectionStreams(storageTarget),
  deleteRecordRowsSqlite: (id) => deleteConnectionRecordRowsSqlite(id),
  teardownProjection: (args) => teardownConnectionSearchProjection(args),
};

// A purge whose record phase is a counted no-op returning a fixed count, used by
// the store-arm tests that don't seed real records but want to assert the
// schedule/device/row cascade and the deletion summary. `enumerateStreams` and
// `teardownProjection` are real (harmless on an empty record set).
function stubPurge({ deletedRecordCount = 0, onDeleteRows = () => {} } = {}) {
  return {
    enumerateStreams: () => Promise.resolve({ streams: [] }),
    deleteRecordRowsSqlite: (id) => {
      onDeleteRows(id);
      return deletedRecordCount;
    },
    teardownProjection: () => Promise.resolve(),
  };
}

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

  const draft = await driver.call('upsert', {
    connectorInstanceId: 'cin_gmail_draft',
    ownerSubjectId: 'owner_4',
    connectorId: 'gmail',
    displayName: 'Gmail Draft',
    status: 'draft',
    sourceKind: 'account',
    sourceBindingKey: 'draft_binding',
    sourceBinding: { kind: 'static_secret_draft' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(draft.status, 'draft');
  assert.deepEqual(
    (await driver.call('listByOwner', 'owner_4')).map((row) => row.connectorInstanceId),
    [],
    'draft is hidden from listByOwner',
  );
  await assert.rejects(
    () => resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_4',
      connectorInstanceId: 'cin_gmail_draft',
      connectorInstanceStore: store,
    }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_inactive',
  );
  const draftNamespace = await resolveOwnerConnectorInstanceNamespace({
    ownerSubjectId: 'owner_4',
    connectorInstanceId: 'cin_gmail_draft',
    connectorInstanceStore: store,
    allowStatuses: ['active', 'draft'],
  });
  assert.equal(draftNamespace.status, 'draft');
  const activatedDraft = await driver.call('activateDraft', 'cin_gmail_draft', { now: LATER });
  assert.equal(activatedDraft.status, 'active');
  assert.equal(activatedDraft.updatedAt, LATER);
  assert.deepEqual(
    (await driver.call('listByOwner', 'owner_4')).map((row) => row.connectorInstanceId),
    ['cin_gmail_draft'],
    'activated draft becomes visible',
  );
  const activatedAgain = await driver.call('activateDraft', 'cin_gmail_draft', { now: '2026-05-15T12:02:00.000Z' });
  assert.equal(activatedAgain.status, 'active');
  assert.equal(activatedAgain.updatedAt, LATER, 'non-draft activation is a no-op');

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
    getDb()
      .prepare(`INSERT INTO connector_summary_evidence(connector_instance_id, connector_id, manifest_generation) VALUES('cin_del', 'reddit', 3)`)
      .run();
    getDb()
      .prepare(`INSERT INTO manifest_write_violations(connector_instance_id, stream, manifest_generation, provenance, observed_at) VALUES('cin_del', 'removed_stream', 3, 'test', ?)`)
      .run(NOW);

    let purgeCalls = 0;
    let purgedId = null;
    const summary = await store.deleteConnection('cin_del', {
      ownerSubjectId: 'owner_1',
      now: LATER,
      purge: stubPurge({
        deletedRecordCount: 4,
        onDeleteRows: (id) => { purgeCalls += 1; purgedId = id; },
      }),
    });
    assert.equal(purgeCalls, 1, 'record purge invoked exactly once');
    assert.equal(purgedId, 'cin_del', 'record purge keyed on the target connection id');
    assert.equal(summary.connection_id, 'cin_del');
    assert.equal(summary.deleted_record_count, 4);
    assert.equal(summary.schedule_deleted, true);
    assert.equal(summary.device_refs_cleared, 1);

    assert.equal(store.get('cin_del'), null, 'connector_instances row gone');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM connector_schedules WHERE connector_instance_id=?').get('cin_del').n, 0, 'schedule gone');
    const dsi = getDb().prepare('SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id=?').get('dsi_x');
    assert.equal(dsi.connector_instance_id, null, 'device back-ref cleared');
    assert.ok(getDb().prepare('SELECT device_id FROM device_exporters WHERE device_id=?').get('dev_x'), 'device edge preserved');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM connector_summary_evidence WHERE connector_instance_id=?').get('cin_del').n, 0, 'summary evidence erased');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM manifest_write_violations WHERE connector_instance_id=?').get('cin_del').n, 0, 'generation-keyed violation evidence erased');

    // Repeat delete → typed not-found (idempotency I4).
    await assert.rejects(
      () => store.deleteConnection('cin_del', { ownerSubjectId: 'owner_1', now: LATER, purge: stubPurge() }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_not_found',
    );

    // Foreign-owner → typed not-found, no purge (I5).
    await seedDeletableInstance(store, { connectorInstanceId: 'cin_foreign', connectorId: 'reddit', sourceBindingKey: 'other' });
    getDb().prepare(`UPDATE connector_instances SET owner_subject_id='owner_2' WHERE connector_instance_id='cin_foreign'`).run();
    let foreignPurge = 0;
    await assert.rejects(
      () => store.deleteConnection('cin_foreign', { ownerSubjectId: 'owner_1', now: LATER, purge: stubPurge({ onDeleteRows: () => { foreignPurge += 1; } }) }),
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
      () => store.deleteConnection('cin_run', { ownerSubjectId: 'owner_1', now: LATER, purge: stubPurge({ onDeleteRows: () => { runPurge += 1; } }) }),
      (err) => err.code === 'connection_run_active',
    );
    assert.equal(runPurge, 0, 'run-active delete never reaches purge');
    assert.ok(store.get('cin_run'), 'run-active connection not erased');
    // The active-run row itself is REFUSED, never erased: it survives the failed
    // delete (delete does not race / clear a live run's lease).
    assert.equal(
      getDb().prepare('SELECT COUNT(*) n FROM controller_active_runs WHERE connector_instance_id=?').get('cin_run').n,
      1,
      'active-run row preserved, not erased, on refusal',
    );

    // Default-account binding → typed default_account_delete_unsupported, no
    // purge, row untouched (I6 / Decision 1 fallback).
    const defaultId = makeDefaultAccountConnectorInstanceId('owner_1', 'reddit');
    await store.ensureDefaultAccountConnection({ ownerSubjectId: 'owner_1', connectorId: 'reddit', displayName: 'Reddit', now: NOW });
    let defaultPurge = 0;
    await assert.rejects(
      () => store.deleteConnection(defaultId, { ownerSubjectId: 'owner_1', now: LATER, purge: stubPurge({ onDeleteRows: () => { defaultPurge += 1; } }) }),
      (err) => err.code === 'default_account_delete_unsupported',
    );
    assert.equal(defaultPurge, 0, 'default-account delete never reaches purge');
    assert.equal(store.get(defaultId).status, 'active', 'default-account row untouched');
  } finally {
    closeDb();
  }
});

// Shared setup for the I8 atomicity tests: a deletable connection with REAL
// seeded records/history/version_counter, a schedule, and a device back-ref.
// Returns helpers to assert the whole cascade survived a rollback.
async function seedAtomicFixture(store, cin) {
  await seedSqliteConnector('reddit');
  await seedDeletableInstance(store, { connectorInstanceId: cin, connectorId: 'reddit', sourceBindingKey: cin });
  seedScheduleRow(cin, 'reddit');
  getDb()
    .prepare(`INSERT OR IGNORE INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at) VALUES('dev_a','owner_1','dev_a','active',?,?)`)
    .run(NOW, NOW);
  getDb()
    .prepare(`INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, status, created_at, updated_at) VALUES('dsi_a','dev_a','reddit',?,'lb_a','active',?,?)`)
    .run(cin, NOW, NOW);
  // Real source rows seeded directly (no manifest/search dependency) so we can
  // prove the SOURCE DATA — not just the connector_instances row — survives a
  // rollback now that the record purge shares the cascade transaction.
  const db = getDb();
  for (const [v, key] of [[1, 'r1'], [2, 'r2']]) {
    db.prepare(`INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version) VALUES('reddit',?,'s',?,?,?,?)`)
      .run(cin, key, JSON.stringify({ id: key }), NOW, v);
    db.prepare(`INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at) VALUES('reddit',?,'s',?,?,?,?)`)
      .run(cin, key, v, JSON.stringify({ id: key }), NOW);
  }
  db.prepare(`INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version) VALUES('reddit',?,'s',2)`).run(cin);
  const count = (table) => getDb().prepare(`SELECT COUNT(*) n FROM ${table} WHERE connector_instance_id=?`).get(cin).n;
  assert.equal(count('records'), 2, 'records seeded');
  assert.equal(count('connector_schedules'), 1, 'schedule seeded');
  return {
    assertFullyIntact() {
      assert.ok(store.get(cin), 'connector_instances row still present after rollback');
      assert.equal(count('records'), 2, 'records still present after rollback');
      assert.ok(count('record_changes') >= 2, 'record_changes still present after rollback');
      assert.equal(count('version_counter'), 1, 'version_counter still present after rollback');
      assert.equal(count('connector_schedules'), 1, 'schedule still present after rollback');
      const dsi = getDb().prepare('SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id=?').get('dsi_a');
      assert.equal(dsi.connector_instance_id, cin, 'device back-ref still intact after rollback');
    },
  };
}

test('SQLite deleteConnection is all-or-nothing: a record-purge failure rolls back the WHOLE cascade — row, schedule, device, and source data intact (I8)', async () => {
  initDb();
  try {
    const store = createSqliteConnectorInstanceStore();
    const fixture = await seedAtomicFixture(store, 'cin_atomic');

    // The record purge throws INSIDE the cascade transaction. Because the record
    // purge and the schedule/device/row deletes now share ONE transaction, the
    // failure rolls EVERYTHING back: the connection is fully present afterward.
    await assert.rejects(
      () => store.deleteConnection('cin_atomic', {
        ownerSubjectId: 'owner_1',
        now: LATER,
        purge: {
          enumerateStreams: () => Promise.resolve({ streams: ['s'] }),
          deleteRecordRowsSqlite: () => { throw new Error('injected record-purge failure'); },
          teardownProjection: () => Promise.resolve(),
        },
      }),
      /injected record-purge failure/,
    );

    fixture.assertFullyIntact();
  } finally {
    closeDb();
  }
});

test('SQLite deleteConnection is all-or-nothing: a schedule/device/row failure AFTER the record purge ran rolls the purge back too — source data intact (I8 regression)', async () => {
  initDb();
  try {
    const store = createSqliteConnectorInstanceStore();
    const fixture = await seedAtomicFixture(store, 'cin_atomic');

    // This is the failure mode review flagged: the record-purge DELETEs have
    // ALREADY executed inside the cascade transaction, and THEN the
    // schedule/device/row cleanup fails. With the old two-transaction
    // construction the record purge would have committed independently, leaving
    // the connection half-deleted (data gone, row present). With the single
    // transaction, a post-purge failure rolls the record DELETEs back too, so
    // the seeded records survive fully.
    //
    // To exercise exactly that ordering we run the REAL record-family DELETEs
    // (proving, mid-transaction, that records are gone at that instant), then
    // throw — simulating the schedule/device/row-cleanup step failing after the
    // purge already ran. The store's single transaction must roll the purge
    // back.
    let purgeRan = false;
    await assert.rejects(
      () => store.deleteConnection('cin_atomic', {
        ownerSubjectId: 'owner_1',
        now: LATER,
        purge: {
          enumerateStreams: realSqlitePurge.enumerateStreams,
          deleteRecordRowsSqlite: (id) => {
            // Run the REAL record-family DELETEs inside the transaction...
            const n = deleteConnectionRecordRowsSqlite(id);
            purgeRan = true;
            assert.equal(getDb().prepare('SELECT COUNT(*) n FROM records WHERE connector_instance_id=?').get(id).n, 0, 'records deleted mid-transaction');
            // ...then throw to simulate a schedule/device/row-cleanup failure
            // that happens AFTER the record purge already executed.
            throw new Error('injected post-purge cleanup failure');
          },
          teardownProjection: realSqlitePurge.teardownProjection,
        },
      }),
      /injected post-purge cleanup failure/,
    );

    assert.equal(purgeRan, true, 'the record purge DID run before the failure');
    // The whole transaction rolled back, so the records the purge deleted
    // mid-transaction are restored — no half-deleted connection.
    fixture.assertFullyIntact();
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

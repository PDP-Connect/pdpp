// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  ConnectorInstanceResolutionError,
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeConnectorInstanceSourceBindingKey,
  makeDefaultAccountConnectorInstanceId,
  resolveOwnerConnectorInstanceNamespace,
} from '../server/stores/connector-instance-store.ts';
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
// `teardownProjection` are real (harmless on an empty record set). Both
// backend record-phase methods are stubbed so this is usable from the shared
// (SQLite + Postgres) `runConformance` driver as well as SQLite-only tests.
function stubPurge({ deletedRecordCount = 0, onDeleteRows = () => {} } = {}) {
  return {
    enumerateStreams: () => Promise.resolve({ streams: [] }),
    deleteRecordRowsSqlite: (id) => {
      onDeleteRows(id);
      return deletedRecordCount;
    },
    deleteRecordRowsPostgres: (_client, id) => {
      onDeleteRows(id);
      return Promise.resolve(deletedRecordCount);
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

  // ─── Owner-delete resurrection guard (fix-owner-delete-resurrection) ───
  // A device-collected (local_device) connection's connector_instance_id is
  // deterministic: hash(owner, connector, source_kind, source_binding_key),
  // where source_binding_key derives from {kind, local_binding_name} only —
  // independent of device_id/source_instance_id. deleteConnection hard-
  // removes the row. Without a tombstone, a later upsert for the SAME
  // identity (e.g. a device re-enrollment under the same local_binding_name,
  // from a DIFFERENT device_id/source_instance_id — a genuinely new
  // enrollment event) would silently resurrect the row as active. This
  // proves it does not.
  await seedConnector('codex');
  const codexBindingKey = makeConnectorInstanceSourceBindingKey({ kind: 'local_device', local_binding_name: 'default' });
  const codexOriginal = await driver.call('upsert', {
    ownerSubjectId: 'owner_6',
    connectorId: 'codex',
    displayName: 'Codex',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: codexBindingKey,
    sourceBinding: { kind: 'local_device', device_id: 'dexp_original', local_binding_name: 'default', source_instance_id: 'dsrc_original' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await driver.call('deleteConnection', codexOriginal.connectorInstanceId, {
    ownerSubjectId: 'owner_6',
    now: LATER,
    purge: stubPurge(),
  });
  assert.equal(await driver.call('get', codexOriginal.connectorInstanceId), null, 'row is gone after delete');

  // The resurrection attempt: a DIFFERENT device_id/source_instance_id (a
  // genuinely new enrollment), same owner/connector/source_kind/binding.
  await assert.rejects(
    () => driver.call('upsert', {
      ownerSubjectId: 'owner_6',
      connectorId: 'codex',
      displayName: 'Codex',
      status: 'active',
      sourceKind: 'local_device',
      sourceBindingKey: codexBindingKey,
      sourceBinding: { kind: 'local_device', device_id: 'dexp_reenrolled', local_binding_name: 'default', source_instance_id: 'dsrc_reenrolled' },
      createdAt: LATER,
      updatedAt: LATER,
    }),
    (err) => err.code === 'connection_tombstoned',
    'a deleted identity must fail closed, not silently resurrect',
  );
  assert.equal(
    await driver.call('get', codexOriginal.connectorInstanceId),
    null,
    'no row was created by the rejected upsert — the tombstoned identity stays absent, not half-resurrected',
  );

  // Unaffected-sibling: a DIFFERENT binding (distinct local_binding_name) for
  // the SAME owner/connector succeeds normally and is untouched by the
  // unrelated tombstone.
  const codexOtherBindingKey = makeConnectorInstanceSourceBindingKey({ kind: 'local_device', local_binding_name: 'work-laptop' });
  const codexSibling = await driver.call('upsert', {
    ownerSubjectId: 'owner_6',
    connectorId: 'codex',
    displayName: 'Codex - work laptop',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: codexOtherBindingKey,
    sourceBinding: { kind: 'local_device', device_id: 'dexp_sibling', local_binding_name: 'work-laptop', source_instance_id: 'dsrc_sibling' },
    createdAt: LATER,
    updatedAt: LATER,
  });
  assert.equal(codexSibling.status, 'active', 'a distinct binding is unaffected by an unrelated tombstone');
  assert.notEqual(codexSibling.connectorInstanceId, codexOriginal.connectorInstanceId);

  // Unaffected-revoke: REVOKE (not delete) still allows the existing
  // reactivate-by-re-enroll behavior — the tombstone guard only applies to
  // the no-existing-row path, never to an ON CONFLICT DO UPDATE hit against
  // a live row.
  const codexRevokeBindingKey = makeConnectorInstanceSourceBindingKey({ kind: 'local_device', local_binding_name: 'revoke-then-reenroll' });
  const codexRevokable = await driver.call('upsert', {
    ownerSubjectId: 'owner_6',
    connectorId: 'codex',
    displayName: 'Codex - revoke test',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: codexRevokeBindingKey,
    sourceBinding: { kind: 'local_device', device_id: 'dexp_revoke', local_binding_name: 'revoke-then-reenroll', source_instance_id: 'dsrc_revoke' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await driver.call('updateStatus', codexRevokable.connectorInstanceId, {
    status: 'revoked',
    updatedAt: LATER,
    revokedAt: LATER,
  });
  const codexReenrolled = await driver.call('upsert', {
    ownerSubjectId: 'owner_6',
    connectorId: 'codex',
    displayName: 'Codex - revoke test',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: codexRevokeBindingKey,
    sourceBinding: { kind: 'local_device', device_id: 'dexp_revoke_new', local_binding_name: 'revoke-then-reenroll', source_instance_id: 'dsrc_revoke_new' },
    createdAt: LATER,
    updatedAt: LATER,
  });
  assert.equal(codexReenrolled.connectorInstanceId, codexRevokable.connectorInstanceId, 'revoke (not delete) still reactivates the SAME row on re-enroll');
  assert.equal(codexReenrolled.status, 'active', 'revoke-then-re-enroll behavior is unchanged by the tombstone guard');
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

test('SQLite ConnectorInstanceStore.upsert migrates a legacy same-binding row in place on a primary-key collision (D8, fix-enroll-connector-instance-pk-collision)', async () => {
  // A legacy row (source_binding_key computed under the older, larger
  // sourceBinding shape) can predate makeConnectorInstanceId and coincide,
  // on the PRIMARY KEY alone, with what today's deterministic formula
  // computes for the SAME logical binding under its current stable key.
  // upsert() must recognize this is provably the same binding (same owner,
  // connector, source_kind, and local_binding_name embedded in the legacy
  // row's own source_binding_json) and migrate the key in place, not fork a
  // second row.
  initDb();
  try {
    await seedSqliteConnector('codex');
    const store = createSqliteConnectorInstanceStore();
    const legacyConnectorInstanceId = 'cin_legacy_fixed_id';
    const legacySourceBindingKey = 'legacy-key-embedding-device-and-source-instance';

    getDb()
      .prepare(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES(?, ?, 'codex', 'vivid-fish', 'active', 'local_device', ?, ?, ?, ?, NULL)`,
      )
      .run(
        legacyConnectorInstanceId,
        'owner_1',
        legacySourceBindingKey,
        JSON.stringify({
          kind: 'local_device',
          device_id: 'dexp_legacy',
          local_binding_name: 'vivid-fish',
          source_instance_id: 'dsrc_legacy',
        }),
        NOW,
        NOW,
      );

    // A fresh upsert for the SAME logical binding, under the current stable
    // key shape, whose deterministic id happens to equal the legacy row's
    // PRIMARY KEY (forced here via an explicit connectorInstanceId, standing
    // in for makeConnectorInstanceId computing the same value live).
    const resolved = await store.upsert({
      connectorInstanceId: legacyConnectorInstanceId,
      ownerSubjectId: 'owner_1',
      connectorId: 'codex',
      displayName: 'vivid-fish',
      status: 'active',
      sourceKind: 'local_device',
      sourceBindingKey: 'stable-key-kind-and-binding-name-only',
      sourceBinding: { kind: 'local_device', local_binding_name: 'vivid-fish' },
      createdAt: NOW,
      updatedAt: NOW,
    });

    assert.equal(resolved.connectorInstanceId, legacyConnectorInstanceId, 'must reuse the legacy row\'s own id, not fork a new one');
    assert.equal(resolved.sourceBindingKey, 'stable-key-kind-and-binding-name-only', 'the stale key must be migrated to the current stable key');
    assert.deepEqual(resolved.sourceBinding, { kind: 'local_device', local_binding_name: 'vivid-fish' });

    const rows = getDb().prepare(`SELECT connector_instance_id FROM connector_instances WHERE owner_subject_id = 'owner_1' AND connector_id = 'codex'`).all();
    assert.equal(rows.length, 1, 'exactly one row must exist for this binding — migrated in place, never duplicated');

    // A PK collision against a row that is NOT the same logical binding
    // (different local_binding_name in the legacy row's own JSON) must fail
    // closed, never silently adopted.
    const unrelatedId = 'cin_unrelated_fixed_id';
    getDb()
      .prepare(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES(?, 'owner_1', 'codex', 'other-binding', 'active', 'local_device', 'unrelated-key', ?, ?, ?, NULL)`,
      )
      .run(unrelatedId, JSON.stringify({ kind: 'local_device', local_binding_name: 'a-totally-different-binding' }), NOW, NOW);

    assert.throws(
      () =>
        store.upsert({
          connectorInstanceId: unrelatedId,
          ownerSubjectId: 'owner_1',
          connectorId: 'codex',
          displayName: 'vivid-fish-2',
          status: 'active',
          sourceKind: 'local_device',
          sourceBindingKey: 'a-second-stable-key',
          sourceBinding: { kind: 'local_device', local_binding_name: 'vivid-fish-2' },
          createdAt: NOW,
          updatedAt: NOW,
        }),
      (err) => err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY',
      'a PK collision against an unrelated binding must fail closed, never be silently adopted',
    );
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
    const tombstone = getDb().prepare('SELECT owner_subject_id, connector_id, source_kind, source_binding_key, deleted_at FROM connector_instance_tombstones WHERE connector_instance_id=?').get('cin_del');
    assert.ok(tombstone, 'delete writes a tombstone row for the deleted identity, same transaction');
    assert.equal(tombstone.owner_subject_id, 'owner_1');
    assert.equal(tombstone.connector_id, 'reddit');
    assert.equal(tombstone.source_binding_key, 'the owner');
    assert.equal(tombstone.deleted_at, LATER);

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

test('SQLite tombstone survives a process restart (file-backed DB, close + reopen)', async () => {
  // A bare `initDb()` (no path) opens `:memory:`, which cannot prove
  // restart-survival — the whole DB vanishes on close regardless of whether
  // the fix works. This test uses a real on-disk file and closes/reopens the
  // handle against the SAME path between delete and the resurrection
  // attempt, mirroring `connection-restart-acceptance.test.js`'s
  // `simulateRestart` pattern: the only state that can survive is whatever
  // was actually committed to disk.
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-owner-delete-resurrection-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  try {
    initDb(dbPath);
    await seedSqliteConnector('codex');
    let store = createSqliteConnectorInstanceStore();
    const bindingKey = makeConnectorInstanceSourceBindingKey({ kind: 'local_device', local_binding_name: 'default' });
    const original = store.upsert({
      ownerSubjectId: 'owner_restart',
      connectorId: 'codex',
      displayName: 'Codex',
      status: 'active',
      sourceKind: 'local_device',
      sourceBindingKey: bindingKey,
      sourceBinding: { kind: 'local_device', device_id: 'dexp_a', local_binding_name: 'default', source_instance_id: 'dsrc_a' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    await store.deleteConnection(original.connectorInstanceId, {
      ownerSubjectId: 'owner_restart',
      now: LATER,
      purge: stubPurge(),
    });
    assert.equal(store.get(original.connectorInstanceId), null, 'row gone before restart');

    // Simulate a process restart: close the handle, reopen against the SAME
    // on-disk file. This is the exact "normal stack rebuild" scenario from
    // the live incident.
    closeDb();
    initDb(dbPath);
    store = createSqliteConnectorInstanceStore();

    assert.equal(store.get(original.connectorInstanceId), null, 'row still absent after restart');
    assert.throws(
      () => store.upsert({
        ownerSubjectId: 'owner_restart',
        connectorId: 'codex',
        displayName: 'Codex',
        status: 'active',
        sourceKind: 'local_device',
        sourceBindingKey: bindingKey,
        sourceBinding: { kind: 'local_device', device_id: 'dexp_b', local_binding_name: 'default', source_instance_id: 'dsrc_b' },
        createdAt: LATER,
        updatedAt: LATER,
      }),
      (err) => err.code === 'connection_tombstoned',
      'the tombstone recorded before restart still blocks resurrection after restart',
    );
    assert.equal(store.get(original.connectorInstanceId), null, 'still no row after the rejected post-restart upsert');
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite startup migration (migrateLocalDeviceConnectorInstances) does not resurrect a deleted connection on restart -- no re-enrollment, no HTTP call', async () => {
  // Judge-identified critical gap: deleteConnection's device-back-ref clear
  // (clear-source-instance-connector-ref.sql) only nulls
  // device_source_instances.connector_instance_id -- it leaves connector_id,
  // local_binding_id, device_id, and source_instance_id populated exactly as
  // a real enrolled device would (see the SQL's own doc comment: "device row
  // and its sibling connections stay intact"). `initDb`'s boot sequence
  // unconditionally runs migrateLocalDeviceConnectorInstances on EVERY
  // start (server/db.js), which scans device_source_instances for exactly
  // this row shape (connector_id IS NOT NULL, source_instance_id IS NOT
  // NULL) and re-upserts a connector_instances row for it. Before the fix,
  // a bare process restart -- with NO re-enrollment and NO HTTP call --
  // silently resurrected the deleted connection. This test reproduces that
  // exact live-incident shape ("after a normal stack rebuild") end to end
  // through real initDb() boots, not a direct call to the migration
  // function or a hand-rolled upsert.
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-owner-delete-resurrection-migration-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  try {
    initDb(dbPath);
    await seedSqliteConnector('codex');
    let store = createSqliteConnectorInstanceStore();
    const bindingKey = makeConnectorInstanceSourceBindingKey({ kind: 'local_device', local_binding_name: 'default' });
    const original = store.upsert({
      ownerSubjectId: 'owner_migration_restart',
      connectorId: 'codex',
      displayName: 'Codex',
      status: 'active',
      sourceKind: 'local_device',
      sourceBindingKey: bindingKey,
      sourceBinding: { kind: 'local_device', device_id: 'dexp_real', local_binding_name: 'default', source_instance_id: 'dsrc_real' },
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Seed device_exporters + device_source_instances exactly as the real
    // device-exporter enroll route (server/routes/ref-device-exporters.ts)
    // leaves them for a live enrollment -- this is the realistic back-ref
    // shape the judge's reproduction used, not a minimal stub.
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
         VALUES('dexp_real','owner_migration_restart','Codex laptop','active',?,?)`,
      )
      .run(NOW, NOW);
    getDb()
      .prepare(
        `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, created_at, updated_at)
         VALUES('dsrc_real','dexp_real','codex',?,'default','local_device','Codex laptop','active',?,?)`,
      )
      .run(original.connectorInstanceId, NOW, NOW);

    // The owner deletes the connection through the REAL cascade (not a
    // hand-rolled UPDATE) -- this is what actually clears
    // device_source_instances.connector_instance_id in production.
    await store.deleteConnection(original.connectorInstanceId, {
      ownerSubjectId: 'owner_migration_restart',
      now: LATER,
      purge: stubPurge(),
    });
    assert.equal(store.get(original.connectorInstanceId), null, 'row gone after delete');
    const dsiAfterDelete = getDb()
      .prepare('SELECT connector_id, local_binding_id, device_id, source_instance_id, connector_instance_id FROM device_source_instances WHERE source_instance_id=?')
      .get('dsrc_real');
    assert.equal(dsiAfterDelete.connector_instance_id, null, 'delete clears ONLY the connector_instance_id back-ref');
    assert.equal(dsiAfterDelete.connector_id, 'codex', 'delete leaves connector_id populated (realistic post-delete shape)');
    assert.equal(dsiAfterDelete.local_binding_id, 'default', 'delete leaves local_binding_id populated (realistic post-delete shape)');

    // Simulate a real process restart: close and reopen the SAME on-disk
    // file. initDb() runs the FULL boot migration sequence, including
    // migrateLocalDeviceConnectorInstances, exactly as a real "stack
    // rebuild" would -- no test seam bypasses it.
    closeDb();
    initDb(dbPath);
    store = createSqliteConnectorInstanceStore();

    assert.equal(
      store.get(original.connectorInstanceId),
      null,
      'CRITICAL: the startup migration sweep must not resurrect the deleted connection on a bare restart',
    );
    const dsiAfterRestart = getDb()
      .prepare('SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id=?')
      .get('dsrc_real');
    assert.equal(
      dsiAfterRestart.connector_instance_id,
      null,
      'the migration must not re-link the device_source_instances row to a resurrected/new connector_instances row',
    );

    // A second restart (repeat boot) must also stay quiescent -- the
    // tombstone guard is not a one-shot fluke.
    closeDb();
    initDb(dbPath);
    store = createSqliteConnectorInstanceStore();
    assert.equal(store.get(original.connectorInstanceId), null, 'still absent after a SECOND restart');
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite mutation proof: without the tombstone check, the resurrecting upsert would silently succeed (documents the pre-fix defect)', async () => {
  // This is the pre-fix reproduction, kept as a permanent regression test on
  // the OLD behavior being wrong — not just a happy-path assertion that the
  // new code returns the right error. It calls the SAME low-level primitives
  // `upsert` uses (raw INSERT ... ON CONFLICT DO UPDATE), bypassing the
  // store's tombstone guard entirely, to prove that WITHOUT the guard this
  // exact sequence resurrects a deleted connection — i.e. the guard is
  // load-bearing, not incidental.
  initDb();
  try {
    await seedSqliteConnector('codex');
    const store = createSqliteConnectorInstanceStore();
    const bindingKey = makeConnectorInstanceSourceBindingKey({ kind: 'local_device', local_binding_name: 'default' });
    const original = store.upsert({
      ownerSubjectId: 'owner_mutation',
      connectorId: 'codex',
      displayName: 'Codex',
      status: 'active',
      sourceKind: 'local_device',
      sourceBindingKey: bindingKey,
      sourceBinding: { kind: 'local_device', device_id: 'dexp_a', local_binding_name: 'default', source_instance_id: 'dsrc_a' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    await store.deleteConnection(original.connectorInstanceId, {
      ownerSubjectId: 'owner_mutation',
      now: LATER,
      purge: stubPurge(),
    });
    assert.equal(store.get(original.connectorInstanceId), null);
    assert.ok(
      getDb().prepare('SELECT 1 x FROM connector_instance_tombstones WHERE connector_instance_id=?').get(original.connectorInstanceId),
      'delete left a tombstone (this is what the guard consults)',
    );

    // Bypass the store entirely: this is exactly the raw statement `upsert`
    // issues, run directly against the SAME identity, with NO tombstone
    // check in front of it — reproducing the pre-fix code path verbatim.
    getDb()
      .prepare(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES(?, ?, 'codex', 'Codex', 'active', 'local_device', ?, ?, ?, ?, NULL)
         ON CONFLICT(owner_subject_id, connector_id, source_kind, source_binding_key) DO UPDATE SET
           status = excluded.status, updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`,
      )
      .run(
        original.connectorInstanceId,
        'owner_mutation',
        bindingKey,
        JSON.stringify({ kind: 'local_device', device_id: 'dexp_b', local_binding_name: 'default', source_instance_id: 'dsrc_b' }),
        LATER,
        LATER,
      );

    const resurrected = store.get(original.connectorInstanceId);
    assert.ok(resurrected, 'PROVEN DEFECT (pre-fix): the bare INSERT resurrects the deleted identity');
    assert.equal(resurrected.status, 'active');
    assert.equal(resurrected.revokedAt, null);
    // This confirms the defect is real and the guard in `upsert` (not this
    // raw statement) is what closes it — `upsert` itself is proven to refuse
    // the exact same sequence in the tests above.
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
      assert.equal(
        getDb().prepare('SELECT COUNT(*) n FROM connector_instance_tombstones WHERE connector_instance_id=?').get(cin).n,
        0,
        'no tombstone was left behind by a rolled-back delete',
      );
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

const CONFORMANCE_TEST_OWNER_SUBJECT_IDS = ['owner_1', 'owner_2', 'owner_3', 'owner_4', 'owner_5', 'owner_6'];
const CONFORMANCE_TEST_CONNECTOR_IDS = ['gmail', 'claude-code', 'reddit', 'github', 'spotify', 'codex'];

async function cleanConformanceFixtures() {
  const ownerPlaceholders = CONFORMANCE_TEST_OWNER_SUBJECT_IDS.map((_, i) => `$${i + 1}`).join(', ');
  // Tombstones are NOT cascade-deleted by a connector_instances row delete
  // (they are deliberately independent, identity-only rows — see
  // openspec/changes/fix-owner-delete-resurrection) and must be cleaned
  // explicitly, or a leftover tombstone from a prior run makes the NEXT
  // run's first upsert for the same identity fail spuriously.
  await postgresQuery(`DELETE FROM connector_instance_tombstones WHERE owner_subject_id IN (${ownerPlaceholders})`, CONFORMANCE_TEST_OWNER_SUBJECT_IDS);
  await postgresQuery(`DELETE FROM connector_instances WHERE owner_subject_id IN (${ownerPlaceholders})`, CONFORMANCE_TEST_OWNER_SUBJECT_IDS);
}

test('Postgres ConnectorInstanceStore conforms when PDPP_TEST_POSTGRES_URL is set', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
  try {
    await cleanConformanceFixtures();
    await runConformance({
      makeStore: () => createPostgresConnectorInstanceStore(),
      seedConnector: seedPostgresConnector,
    });
  } finally {
    await cleanConformanceFixtures();
    await postgresQuery(
      `DELETE FROM connectors WHERE connector_id = ANY($1::text[])`,
      [CONFORMANCE_TEST_CONNECTOR_IDS],
    );
    await closePostgresStorage();
  }
});

test('Postgres startup migration (migratePostgresLocalDeviceConnectorInstances) does not resurrect a deleted connection on restart', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  // Postgres counterpart of the SQLite startup-migration restart regression
  // above. bootstrapPostgresSchema (called by every initPostgresStorage)
  // unconditionally runs migratePostgresLocalDeviceConnectorInstances on
  // every boot, mirroring the SQLite sweep exactly.
  const deviceId = 'dexp_pg_restart';
  const sourceInstanceId = 'dsrc_pg_restart';
  const ownerSubjectId = 'owner_pg_migration_restart';
  const cleanupDeviceRows = async () => {
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id = $1`, [deviceId]);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id = $1`, [deviceId]);
    await postgresQuery(`DELETE FROM connector_instance_tombstones WHERE owner_subject_id = $1`, [ownerSubjectId]);
    await postgresQuery(`DELETE FROM connector_instances WHERE owner_subject_id = $1`, [ownerSubjectId]);
  };
  await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
  try {
    await cleanConformanceFixtures();
    await cleanupDeviceRows();
    await seedPostgresConnector('codex');
    const store = createPostgresConnectorInstanceStore();
    const bindingKey = makeConnectorInstanceSourceBindingKey({ kind: 'local_device', local_binding_name: 'default' });
    const original = await store.upsert({
      ownerSubjectId,
      connectorId: 'codex',
      displayName: 'Codex',
      status: 'active',
      sourceKind: 'local_device',
      sourceBindingKey: bindingKey,
      sourceBinding: { kind: 'local_device', device_id: deviceId, local_binding_name: 'default', source_instance_id: sourceInstanceId },
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Realistic post-enrollment device_source_instances shape, same as the
    // SQLite test.
    await postgresQuery(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES($1, $2, 'Codex laptop', 'active', $3, $3)
       ON CONFLICT(device_id) DO NOTHING`,
      [deviceId, ownerSubjectId, NOW],
    );
    await postgresQuery(
      `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, created_at, updated_at)
       VALUES($1, $2, 'codex', $3, 'default', 'local_device', 'Codex laptop', 'active', $4, $4)`,
      [sourceInstanceId, deviceId, original.connectorInstanceId, NOW],
    );

    await store.deleteConnection(original.connectorInstanceId, {
      ownerSubjectId,
      now: LATER,
      purge: stubPurge(),
    });
    assert.equal(await store.get(original.connectorInstanceId), null, 'row gone after delete');
    const dsiAfterDelete = await postgresQuery(
      `SELECT connector_id, local_binding_id, connector_instance_id FROM device_source_instances WHERE source_instance_id = $1`,
      [sourceInstanceId],
    );
    assert.equal(dsiAfterDelete.rows[0].connector_instance_id, null, 'delete clears ONLY the connector_instance_id back-ref');
    assert.equal(dsiAfterDelete.rows[0].connector_id, 'codex', 'delete leaves connector_id populated (realistic post-delete shape)');

    // Simulate a restart: initPostgresStorage re-runs the FULL boot
    // migration sequence, including migratePostgresLocalDeviceConnectorInstances,
    // against the SAME durable database -- no test seam bypasses it.
    await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });

    assert.equal(
      await store.get(original.connectorInstanceId),
      null,
      'CRITICAL: the startup migration sweep must not resurrect the deleted connection on a bare restart',
    );
    const dsiAfterRestart = await postgresQuery(
      `SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id = $1`,
      [sourceInstanceId],
    );
    assert.equal(
      dsiAfterRestart.rows[0].connector_instance_id,
      null,
      'the migration must not re-link the device_source_instances row to a resurrected/new connector_instances row',
    );
  } finally {
    await cleanupDeviceRows();
    await cleanConformanceFixtures();
    await postgresQuery(`DELETE FROM connectors WHERE connector_id = 'codex'`);
    await closePostgresStorage();
  }
});

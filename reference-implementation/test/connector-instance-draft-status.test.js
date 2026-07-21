// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  ConnectorInstanceResolutionError,
  createSqliteConnectorInstanceStore,
  resolveOwnerConnectorInstanceNamespace,
} from '../server/stores/connector-instance-store.js';

// Focused coverage for the `draft` connector-instance status that closes the
// first-static-secret-connection deadlock without a phantom active row.
// See add-static-secret-owner-session-connect-path design Decisions 1-3, 5.

const NOW = '2026-06-02T12:00:00.000Z';
const LATER = '2026-06-02T12:05:00.000Z';

function seedConnector(connectorId) {
  getDb()
    .prepare(`INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)`)
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

function makeDraft(store, { ownerSubjectId = 'owner_1', connectorId = 'gmail', sourceBindingKey, displayName = 'Gmail' }) {
  return store.upsert({
    ownerSubjectId,
    connectorId,
    displayName,
    status: 'draft',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { kind: 'static_secret_draft', nonce: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

test('draft status is admitted by the SQLite store and CHECK constraint', () => {
  initDb();
  try {
    seedConnector('gmail');
    const store = createSqliteConnectorInstanceStore();
    const draft = makeDraft(store, { sourceBindingKey: 'nonce_a' });
    assert.equal(draft.status, 'draft');
    // round-trips through get
    assert.equal(store.get(draft.connectorInstanceId).status, 'draft');
  } finally {
    closeDb();
  }
});

test('draft instances are invisible to listByOwner (every connection read surface)', () => {
  initDb();
  try {
    seedConnector('gmail');
    const store = createSqliteConnectorInstanceStore();
    // one active, one draft
    const active = store.upsert({
      ownerSubjectId: 'owner_1',
      connectorId: 'gmail',
      displayName: 'Gmail Active',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'active_binding',
      sourceBinding: { kind: 'account' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const draft = makeDraft(store, { sourceBindingKey: 'draft_binding' });

    const listed = store.listByOwner('owner_1');
    const ids = listed.map((i) => i.connectorInstanceId);
    assert.ok(ids.includes(active.connectorInstanceId), 'active connection is listed');
    assert.ok(!ids.includes(draft.connectorInstanceId), 'draft connection is hidden from listByOwner');

    // owner-internal lookups still resolve the draft
    assert.equal(store.get(draft.connectorInstanceId).status, 'draft');
    assert.equal(
      store.getByBinding({
        ownerSubjectId: 'owner_1',
        connectorId: 'gmail',
        sourceKind: 'account',
        sourceBindingKey: 'draft_binding',
      }).connectorInstanceId,
      draft.connectorInstanceId,
    );
  } finally {
    closeDb();
  }
});

test('resolver rejects a draft by default and admits it only with allowStatuses', async () => {
  initDb();
  try {
    seedConnector('gmail');
    const store = createSqliteConnectorInstanceStore();
    const draft = makeDraft(store, { sourceBindingKey: 'nonce_resolve' });

    // default (active-only) → connector_instance_inactive
    await assert.rejects(
      () =>
        resolveOwnerConnectorInstanceNamespace({
          ownerSubjectId: 'owner_1',
          connectorInstanceId: draft.connectorInstanceId,
          connectorInstanceStore: store,
        }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === 'connector_instance_inactive',
    );

    // explicit allowStatuses admits the draft
    const ns = await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId: 'owner_1',
      connectorInstanceId: draft.connectorInstanceId,
      connectorInstanceStore: store,
      allowStatuses: ['active', 'draft'],
    });
    assert.equal(ns.connectorInstanceId, draft.connectorInstanceId);
    assert.equal(ns.status, 'draft');
  } finally {
    closeDb();
  }
});

test('activateDraft flips draft → active and is a no-op on non-draft rows', () => {
  initDb();
  try {
    seedConnector('gmail');
    const store = createSqliteConnectorInstanceStore();
    const draft = makeDraft(store, { sourceBindingKey: 'nonce_activate' });

    const activated = store.activateDraft(draft.connectorInstanceId, { now: LATER });
    assert.equal(activated.status, 'active');
    assert.equal(activated.updatedAt, LATER);
    // now visible on the read surface
    assert.ok(store.listByOwner('owner_1').some((i) => i.connectorInstanceId === draft.connectorInstanceId));

    // second activation is a no-op (idempotent / concurrency-safe)
    const again = store.activateDraft(draft.connectorInstanceId, { now: '2026-06-02T13:00:00.000Z' });
    assert.equal(again.status, 'active');
    assert.equal(again.updatedAt, LATER, 'no-op did not re-stamp the row');

    // a paused row is NOT moved to active by activateDraft
    const paused = store.upsert({
      ownerSubjectId: 'owner_1',
      connectorId: 'gmail',
      displayName: 'Paused',
      status: 'paused',
      sourceKind: 'account',
      sourceBindingKey: 'paused_binding',
      sourceBinding: { kind: 'account' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const stillPaused = store.activateDraft(paused.connectorInstanceId, { now: LATER });
    assert.equal(stillPaused.status, 'paused');

    // activateDraft on a missing row returns null
    assert.equal(store.activateDraft('cin_does_not_exist', { now: LATER }), null);
  } finally {
    closeDb();
  }
});

test('browser enrollment shell sweep enumerates active shell bindings until they resolve', () => {
  initDb();
  try {
    seedConnector('amazon');
    const store = createSqliteConnectorInstanceStore();
    const draftShell = store.upsert({
      ownerSubjectId: 'owner_1',
      connectorId: 'amazon',
      displayName: 'Amazon',
      status: 'draft',
      sourceKind: 'account',
      sourceBindingKey: 'browser_shell_draft',
      sourceBinding: {
        kind: 'browser_enrollment_shell',
        enrollment_expires_at: '2026-06-02T14:00:00.000Z',
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const activeShell = store.upsert({
      ownerSubjectId: 'owner_1',
      connectorId: 'amazon',
      displayName: 'Amazon',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'browser_shell_active',
      sourceBinding: {
        kind: 'browser_enrollment_shell',
        enrollment_expires_at: '2026-06-02T14:00:00.000Z',
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.upsert({
      ownerSubjectId: 'owner_1',
      connectorId: 'amazon',
      displayName: 'Amazon - Personal',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'browser_collector_resolved',
      sourceBinding: {
        kind: 'browser_collector',
        enrollment_expires_at: '2026-06-02T14:00:00.000Z',
      },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const listed = store.listDraftBrowserEnrollmentShells('owner_1').map((instance) => instance.connectorInstanceId);

    assert.deepEqual(listed.sort(), [activeShell.connectorInstanceId, draftShell.connectorInstanceId].sort());
  } finally {
    closeDb();
  }
});

test('two drafts for one connector are two distinct connection_ids', () => {
  initDb();
  try {
    seedConnector('gmail');
    const store = createSqliteConnectorInstanceStore();
    const a = makeDraft(store, { sourceBindingKey: 'mailbox_a' });
    const b = makeDraft(store, { sourceBindingKey: 'mailbox_b' });
    assert.notEqual(a.connectorInstanceId, b.connectorInstanceId);
  } finally {
    closeDb();
  }
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-shell integration tests for cross-binding lexical search fan-in.
 *
 * Drives `runLexicalSearch` (the native dependency-wiring shell) against
 * the real SQLite FTS5 storage with two active owner-visible bindings
 * under the same connector. Proves the end-to-end path:
 *   - `listOwnerVisibleBindings` enumerates both bindings;
 *   - the snapshot's plan emits one entry per binding;
 *   - the round-robin merge in `buildSnapshot` returns hits from both
 *     bindings;
 *   - each hit carries `connection_id` plus the deprecated alias;
 *   - request-time `connection_id` narrowing scopes the snapshot to one
 *     binding.
 *
 * Skips Postgres (the SQLite reference path is the canonical regression
 * surface; Postgres parity is exercised by `postgres-runtime-storage.test.js`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { runLexicalSearch } from '../server/search.js';
import { buildSemanticSearchPlanForGrant } from '../server/search-semantic.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const CONNECTOR_ID = 'search-fan-in';
const STREAM = 'messages';
const ALERTS_STREAM = 'alerts';
const INSTANCE_A = 'cin_search_fanin_account_a';
const INSTANCE_B = 'cin_search_fanin_account_b';

const baseManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Search Fan-in Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'subject', 'received_at'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
        },
      },
      query: {
        search: { lexical_fields: ['subject'] },
      },
    },
    {
      name: ALERTS_STREAM,
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'subject', 'received_at'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
        },
      },
      query: {
        search: { lexical_fields: ['subject'] },
      },
    },
  ],
};

function target(instanceId) {
  return { connector_id: CONNECTOR_ID, connector_instance_id: instanceId };
}

function payload(id, subject, receivedAt, stream = STREAM) {
  return {
    stream,
    key: id,
    data: { id, subject, received_at: receivedAt },
    emitted_at: receivedAt,
  };
}

async function seedInstance(instanceId, displayName, sourceBindingKey) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account: sourceBindingKey },
    createdAt: now,
    updatedAt: now,
  });
}

async function withDualBindingDb(testFn) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
    await ingestRecord(target(INSTANCE_A), payload('rec-a-1', 'overdraft surprise from A', '2026-05-18T12:00:00.000Z'));
    await ingestRecord(target(INSTANCE_A), payload('rec-a-2', 'unrelated A message', '2026-05-18T12:01:00.000Z'));
    await ingestRecord(target(INSTANCE_B), payload('rec-b-1', 'overdraft fee from B', '2026-05-18T12:02:00.000Z'));
    await ingestRecord(target(INSTANCE_B), payload('rec-b-2', 'unrelated B message', '2026-05-18T12:03:00.000Z'));
    await ingestRecord(target(INSTANCE_A), payload('alert-a-1', 'overdraft alert from A', '2026-05-18T12:04:00.000Z', ALERTS_STREAM));
    await ingestRecord(target(INSTANCE_B), payload('alert-b-1', 'overdraft alert from B', '2026-05-18T12:05:00.000Z', ALERTS_STREAM));
    await testFn();
  } finally {
    closeDb();
  }
}

function makeOwnerWiring(query) {
  const req = { query };
  const tokenInfo = {
    pdpp_token_kind: 'owner',
    subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
  };
  return {
    req,
    opts: { lexicalRetrievalSupported: true },
    tokenInfo,
    getOwnerSubjectId: () => OWNER_AUTH_DEFAULT_SUBJECT_ID,
    resolveOwnerVisibleConnectorIds: () => [CONNECTOR_ID],
    resolveOwnerScopeForConnector: (connectorId) => ({
      public_scope: 'polyfill',
      owner_subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      source: { kind: 'connector', id: connectorId },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerManifestFromScope: async (ownerScope) => {
      // Honor a pinned connector_instance_id when the caller (the
      // fan-in path) supplied one; otherwise just return the manifest.
      const pinned = ownerScope?.storage_binding?.connector_instance_id || null;
      const manifest = {
        ...baseManifest,
        storage_binding: {
          connector_id: ownerScope?.storage_binding?.connector_id || CONNECTOR_ID,
          ...(pinned ? { connector_instance_id: pinned } : {}),
        },
      };
      return {
        ownerScope,
        storageBinding: manifest.storage_binding,
        manifest,
      };
    },
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest?.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveGrantManifest: async () => {
      throw new Error('owner-mode test should not reach client grant resolver');
    },
  };
}

test('owner-mode lexical fan-in: returns hits from both bindings under one connector', async () => {
  await withDualBindingDb(async () => {
    const wiring = makeOwnerWiring({ q: 'overdraft', streams: [STREAM] });
    const { envelope, disclosureData } = await runLexicalSearch(wiring);
    const ids = envelope.data.map((d) => d.record_key).sort();
    assert.deepEqual(ids, ['rec-a-1', 'rec-b-1']);
    // Each hit must carry connection_id + alias.
    for (const item of envelope.data) {
      assert.ok(item.connection_id, 'hit must carry connection_id');
      assert.equal(item.connector_instance_id, item.connection_id);
    }
    // Owner-facing display_name surfaces from the store.
    const cidA = envelope.data.find((d) => d.connection_id === INSTANCE_A);
    const cidB = envelope.data.find((d) => d.connection_id === INSTANCE_B);
    assert.equal(cidA?.display_name, 'Account A');
    assert.equal(cidB?.display_name, 'Account B');
    // Connector count reflects per-binding plans (= 2).
    assert.equal(disclosureData.connector_count, 2);
  });
});

test('owner-mode lexical fan-in: connection_id narrows to one binding', async () => {
  await withDualBindingDb(async () => {
    const wiring = makeOwnerWiring({ q: 'overdraft', streams: [STREAM], connection_id: INSTANCE_A });
    const { envelope } = await runLexicalSearch(wiring);
    assert.equal(envelope.data.length, 1);
    assert.equal(envelope.data[0].connection_id, INSTANCE_A);
  });
});

test('owner-mode lexical fan-in: deprecated connector_instance_id alias narrows identically and emits warning', async () => {
  await withDualBindingDb(async () => {
    const wiring = makeOwnerWiring({ q: 'overdraft', streams: [STREAM], connector_instance_id: INSTANCE_B });
    const { envelope } = await runLexicalSearch(wiring);
    assert.equal(envelope.data.length, 1);
    assert.equal(envelope.data[0].connection_id, INSTANCE_B);
    // The native shell strips meta during envelope re-wrapping; the
    // operation-level test (rs-search-lexical-fan-in.test.js) covers the
    // warning emission. Here we only assert narrowing semantics.
  });
});

function makeClientWiring(query, { grantStreamConnectionId = null } = {}) {
  const grant = {
    source: { kind: 'connector', id: CONNECTOR_ID },
    streams: [
      grantStreamConnectionId
        ? { name: STREAM, fields: ['id', 'subject', 'received_at'], connection_id: grantStreamConnectionId }
        : { name: STREAM, fields: ['id', 'subject', 'received_at'] },
    ],
  };
  const tokenInfo = {
    pdpp_token_kind: 'client',
    subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    client_id: 'cl_test',
    grant_id: 'g_test',
    grant,
  };
  return {
    req: { query },
    opts: { lexicalRetrievalSupported: true },
    tokenInfo,
    getOwnerSubjectId: () => OWNER_AUTH_DEFAULT_SUBJECT_ID,
    resolveOwnerVisibleConnectorIds: () => [CONNECTOR_ID],
    resolveOwnerScopeForConnector: (connectorId) => ({
      public_scope: 'polyfill',
      owner_subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      source: { kind: 'connector', id: connectorId },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerManifestFromScope: async (ownerScope) => {
      const pinned = ownerScope?.storage_binding?.connector_instance_id || null;
      const manifest = {
        ...baseManifest,
        storage_binding: {
          connector_id: ownerScope?.storage_binding?.connector_id || CONNECTOR_ID,
          ...(pinned ? { connector_instance_id: pinned } : {}),
        },
      };
      return { ownerScope, storageBinding: manifest.storage_binding, manifest };
    },
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest?.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveGrantManifest: async () => ({
      manifest: { ...baseManifest, storage_binding: { connector_id: CONNECTOR_ID } },
      storageBinding: { connector_id: CONNECTOR_ID },
    }),
  };
}

test('client-mode lexical fan-in: hits union across grant-authorized bindings (no per-stream pin)', async () => {
  await withDualBindingDb(async () => {
    const wiring = makeClientWiring({ q: 'overdraft' });
    const { envelope } = await runLexicalSearch(wiring);
    const ids = envelope.data.map((d) => d.record_key).sort();
    assert.deepEqual(ids, ['rec-a-1', 'rec-b-1']);
  });
});

test('client-mode lexical fan-in: per-stream grant connection_id pins the search to one binding', async () => {
  await withDualBindingDb(async () => {
    const wiring = makeClientWiring(
      { q: 'overdraft' },
      { grantStreamConnectionId: INSTANCE_A },
    );
    const { envelope } = await runLexicalSearch(wiring);
    assert.equal(envelope.data.length, 1);
    assert.equal(envelope.data[0].connection_id, INSTANCE_A);
  });
});

test('client-mode lexical fan-in: mixed per-stream grant connection_id constraints are honored independently', async () => {
  await withDualBindingDb(async () => {
    const grant = {
      source: { kind: 'connector', id: CONNECTOR_ID },
      streams: [
        { name: STREAM, fields: ['id', 'subject', 'received_at'], connection_id: INSTANCE_A },
        { name: ALERTS_STREAM, fields: ['id', 'subject', 'received_at'], connection_id: INSTANCE_B },
      ],
    };
    const tokenInfo = {
      pdpp_token_kind: 'client',
      subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      client_id: 'cl_test',
      grant_id: 'g_test_mixed',
      grant,
    };
    const wiring = {
      ...makeClientWiring({ q: 'overdraft', streams: [STREAM, ALERTS_STREAM] }),
      tokenInfo,
      resolveGrantManifest: async () => ({
        manifest: { ...baseManifest, storage_binding: { connector_id: CONNECTOR_ID } },
        storageBinding: { connector_id: CONNECTOR_ID },
      }),
    };
    const { envelope } = await runLexicalSearch(wiring);
    const observed = envelope.data
      .map((d) => `${d.stream}:${d.record_key}:${d.connection_id}`)
      .sort();
    assert.deepEqual(observed, [
      `${ALERTS_STREAM}:alert-b-1:${INSTANCE_B}`,
      `${STREAM}:rec-a-1:${INSTANCE_A}`,
    ]);
  });
});

test('client-mode lexical fan-in: request connection_id outside grant returns connection_not_found', async () => {
  await withDualBindingDb(async () => {
    const wiring = makeClientWiring(
      { q: 'overdraft', connection_id: 'cin_does_not_exist' },
      { grantStreamConnectionId: INSTANCE_A },
    );
    await assert.rejects(
      () => runLexicalSearch(wiring),
      (err) => {
        assert.equal(err.code, 'connection_not_found');
        return true;
      },
    );
  });
});

test('semantic plan builder honors mixed per-stream grant connection_id constraints per binding', () => {
  const manifest = {
    streams: [
      { name: STREAM, query: { search: { semantic_fields: ['subject'] } } },
      { name: ALERTS_STREAM, query: { search: { semantic_fields: ['subject'] } } },
    ],
  };
  const grant = {
    streams: [
      { name: STREAM, fields: ['subject'], connection_id: INSTANCE_A },
      { name: ALERTS_STREAM, fields: ['subject'], connection_id: INSTANCE_B },
    ],
  };
  const planA = buildSemanticSearchPlanForGrant({
    manifest,
    grant,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_A,
  });
  const planB = buildSemanticSearchPlanForGrant({
    manifest,
    grant,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_B,
  });
  assert.deepEqual(planA.map((entry) => entry.streamName), [STREAM]);
  assert.deepEqual(planB.map((entry) => entry.streamName), [ALERTS_STREAM]);
});

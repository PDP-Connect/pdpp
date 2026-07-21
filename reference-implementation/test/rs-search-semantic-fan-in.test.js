// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-binding fan-in tests for `rs.search.semantic`.
 *
 * Drives the operation with the new optional dependencies
 * (`listOwnerVisibleBindings`, `resolveOwnerManifestForBinding`,
 * `resolveClientBindings`). Mirrors `rs-search-lexical-fan-in.test.js`
 * but the merge is total-order by distance, not round-robin.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeSearchSemantic,
} from '../operations/rs-search-semantic/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_owner' };
const STUB_BACKEND_IDENTITY = 'stub-backend-identity-v1';

const defaultAdvertisement = {
  supported: true,
  cross_stream: true,
  default_limit: 25,
  max_limit: 100,
  score: {
    supported: true,
    kind: 'semantic_distance',
    order: 'lower_is_better',
    value_semantics: 'distance',
  },
};

function hit(connectorId, connectorInstanceId, recordKey, distance) {
  return {
    connectorId,
    connectorInstanceId,
    stream: 'messages',
    recordKey,
    matchedFields: ['subject'],
    distance,
    topField: 'subject',
  };
}

function makeOwnerDepsWithBindings(bindings, hitsByBinding) {
  const stored = new Map();
  return {
    getAdvertisement: () => defaultAdvertisement,
    getCurrentBackendIdentity: () => STUB_BACKEND_IDENTITY,
    listOwnerVisibleConnectorIds: () => Array.from(new Set(bindings.map((b) => b.connectorId))),
    listOwnerVisibleBindings: () => bindings,
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: 'messages' }],
    }),
    resolveOwnerManifestForBinding: (binding) => ({
      connector_id: binding.connectorId,
      streams: [{ name: 'messages' }],
      storage_binding: { connector_id: binding.connectorId, connector_instance_id: binding.connectorInstanceId },
    }),
    buildOwnerReadGrantForManifest: (m) => ({ streams: (m.streams || []).map((s) => ({ name: s.name })) }),
    resolveClientManifest: () => ({ streams: [{ name: 'messages' }] }),
    buildSearchPlanForGrant: ({ manifest }) => {
      const cid = manifest?.storage_binding?.connector_instance_id || null;
      const hs = hitsByBinding[cid];
      if (hs && !Array.isArray(hs) && hs._emptyPlan) return [];
      return [{ streamName: 'messages', connectorInstanceId: cid, searchableFields: ['subject'] }];
    },
    buildSnapshot: ({ q, perConnectorPlans }) => {
      // Per-binding KNN + global total-order merge by distance, mirroring
      // the native semantic adapter.
      const flat = [];
      for (const p of perConnectorPlans) {
        const cid = p.planEntries[0]?.connectorInstanceId;
        const hs = hitsByBinding[cid];
        if (Array.isArray(hs)) flat.push(...hs);
      }
      const sorted = flat.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        const cia = a.connectorInstanceId || '';
        const cib = b.connectorInstanceId || '';
        if (cia !== cib) return cia < cib ? -1 : 1;
        return a.recordKey < b.recordKey ? -1 : 1;
      });
      return {
        snapshot_id: `snap_sem_${q}_${sorted.length}`,
        query: q,
        backend_hash: STUB_BACKEND_IDENTITY,
        results: sorted,
      };
    },
    persistSnapshot: (snap) => { stored.set(snap.snapshot_id, snap); },
    loadSnapshot: (id) => stored.get(id) ?? null,
    hydrateResult: () => ({
      emittedAt: '2026-05-01T00:00:00Z',
      snippet: { field: 'subject', text: 'snip' },
    }),
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
    _stored: stored,
  };
}

test('owner-mode semantic fan-in: total-order merge by distance across bindings', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1', 0.10), hit('gmail', 'cin_gmail_A', 'A2', 0.30)],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1', 0.05), hit('gmail', 'cin_gmail_B', 'B2', 0.25)],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  // Global order by distance: B1(0.05), A1(0.10), B2(0.25), A2(0.30)
  assert.deepEqual(out.envelope.data.map((d) => d.record_key), ['B1', 'A1', 'B2', 'A2']);
  for (const item of out.envelope.data) {
    assert.equal(typeof item.connection_id, 'string');
    assert.equal(item.connector_instance_id, item.connection_id);
  }
  assert.equal(out.disclosureData.connector_count, 2);
});

test('owner-mode semantic fan-in: a record indexed in two bindings appears twice with distinct connection_ids', async () => {
  // Same record_key in two bindings — must remain two separate hits.
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'shared', 0.10)],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'shared', 0.15)],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.data.length, 2);
  const cids = out.envelope.data.map((d) => d.connection_id);
  assert.deepEqual(new Set(cids), new Set(['cin_gmail_A', 'cin_gmail_B']));
});

test('owner-mode semantic fan-in: connection_id narrows to one binding', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1', 0.10)],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1', 0.05)],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'foo', connection_id: 'cin_gmail_A' } },
    deps,
  );
  assert.deepEqual(out.envelope.data.map((d) => d.record_key), ['A1']);
});

test('owner-mode semantic fan-in: unknown connection_id raises connection_not_found', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const deps = makeOwnerDepsWithBindings(bindings, {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1', 0.10)],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1', 0.05)],
  });
  await assert.rejects(
    () => executeSearchSemantic(
      { actor: ownerActor, query: { q: 'foo', connection_id: 'cin_missing' } },
      deps,
    ),
    (err) => {
      assert.equal(err.code, 'connection_not_found');
      assert.equal(err.param, 'connection_id');
      return true;
    },
  );
});

test('owner-mode semantic fan-in: empty plan on one binding emits binding-aware skipped warning', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1', 0.10)],
    cin_gmail_B: { _emptyPlan: true },
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  const skipped = (out.envelope.meta?.warnings || []).find((w) => w.code === 'source_skipped_not_applicable');
  assert.ok(skipped);
  assert.equal(skipped.detail?.connection_id, 'cin_gmail_B');
  assert.equal(skipped.detail?.source, 'gmail');
});

test('client-mode semantic fan-in: iterates every grant-authorized binding', async () => {
  const grant = { source: { kind: 'connector', id: 'gmail' }, streams: [{ name: 'messages' }] };
  const clientActor = { kind: 'client', subject_id: 'subj', client_id: 'c', grant_id: 'g', grant };
  const bindingSpecs = [
    { connectorInstanceId: 'cin_gmail_A', manifest: { streams: [{ name: 'messages' }], storage_binding: { connector_id: 'gmail', connector_instance_id: 'cin_gmail_A' } } },
    { connectorInstanceId: 'cin_gmail_B', manifest: { streams: [{ name: 'messages' }], storage_binding: { connector_id: 'gmail', connector_instance_id: 'cin_gmail_B' } } },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1', 0.10)],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1', 0.05)],
  };
  const deps = makeOwnerDepsWithBindings([{ connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' }, { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' }], hits);
  // override with client-mode bindings resolver
  deps.resolveClientBindings = (_actor, { connectionId }) => {
    if (connectionId) {
      const m = bindingSpecs.find((b) => b.connectorInstanceId === connectionId);
      if (!m) {
        const err = new Error(`connection_id '${connectionId}' is not addressable under this grant.`);
        err.code = 'connection_not_found';
        err.param = 'connection_id';
        throw err;
      }
      return [{ manifest: m.manifest, connectorInstanceId: m.connectorInstanceId }];
    }
    return bindingSpecs.map((b) => ({ manifest: b.manifest, connectorInstanceId: b.connectorInstanceId }));
  };
  const out = await executeSearchSemantic(
    { actor: clientActor, query: { q: 'foo' } },
    deps,
  );
  assert.deepEqual(out.envelope.data.map((d) => d.record_key), ['B1', 'A1']);
});

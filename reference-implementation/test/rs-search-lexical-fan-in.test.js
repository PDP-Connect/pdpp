/**
 * Cross-binding fan-in tests for `rs.search.lexical`.
 *
 * Drives the operation with the new optional dependencies
 * (`listOwnerVisibleBindings`, `resolveOwnerManifestForBinding`,
 * `resolveClientBindings`) so the per-binding fan-out is exercised without
 * standing up the full Fastify host. The native shell wiring in
 * `server/search.js` is itself unit-tested by `lexical-retrieval.test.js`
 * and the storage-layer fan-in helpers (`resolveFanInBindings`,
 * `listActiveOwnerBindingsForConnectors`) are covered by
 * `storage-fan-in-read-contract.test.js`.
 *
 * What this file proves:
 * - owner-mode fan-in emits one connector plan per binding (round-robin
 *   merge across bindings, not just connectors);
 * - client-mode fan-in iterates every binding the grant authorizes;
 * - request-time `connection_id` narrows the binding set the operation
 *   plans against (owner: filter in operation; client: resolver-supplied);
 * - the deprecated `connector_instance_id` alias narrows identically to
 *   the canonical `connection_id`, and emits the deprecated-alias warning;
 * - `source_skipped_not_applicable` warnings carry the binding's
 *   `connection_id` when the skipped unit is one binding under a connector
 *   rather than the entire connector;
 * - cursors pin the snapshot they were issued for; pagination returns
 *   each hit exactly once across the full multi-binding snapshot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeSearchLexical,
} from '../operations/rs-search-lexical/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_owner' };

const defaultAdvertisement = {
  supported: true,
  cross_stream: true,
  snippets: true,
  default_limit: 25,
  max_limit: 100,
  score: {
    supported: true,
    kind: 'bm25',
    order: 'lower_is_better',
    value_semantics: 'implementation_relative',
  },
};

function hit(connectorId, connectorInstanceId, recordKey, score = -1) {
  return {
    connectorId,
    connectorInstanceId,
    stream: 'messages',
    recordKey,
    emittedAt: '2026-05-01T00:00:00Z',
    matchedFields: ['subject'],
    snippet: { field: 'subject', text: 'snip' },
    score,
  };
}

function makeOwnerDepsWithBindings(bindings, hitsByBinding) {
  const stored = new Map();
  return {
    getAdvertisement: () => defaultAdvertisement,
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
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveClientManifest: () => ({ streams: [{ name: 'messages' }] }),
    buildSearchPlanForGrant: ({ manifest }) => {
      const cid = manifest?.storage_binding?.connector_instance_id || null;
      const streamHits = hitsByBinding[cid];
      // Empty plan signal — the operation must treat this as a skipped
      // binding (warning carries the binding's connection_id).
      if (streamHits && !Array.isArray(streamHits) && streamHits._emptyPlan) {
        return [];
      }
      return [{
        streamName: 'messages',
        connectorInstanceId: cid,
        searchableFields: ['subject'],
      }];
    },
    buildSnapshot: ({ q, perConnectorPlans }) => {
      const results = [];
      // Round-robin across plans (each plan is one binding) — same as the
      // native adapter's roundRobinMerge over per-binding hit lists.
      const lists = perConnectorPlans.map((p) => {
        const cid = p.planEntries[0]?.connectorInstanceId;
        const hs = hitsByBinding[cid];
        return Array.isArray(hs) ? hs.slice() : [];
      });
      let i = 0;
      let progress = true;
      while (progress) {
        progress = false;
        for (const list of lists) {
          if (i < list.length) {
            results.push(list[i]);
            progress = true;
          }
        }
        i += 1;
      }
      return {
        snapshot_id: `snap_${q}_${results.length}`,
        query: q,
        results,
      };
    },
    persistSnapshot: (snap) => { stored.set(snap.snapshot_id, snap); },
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
    _stored: stored,
  };
}

// ─── Owner-mode cross-binding fan-out ────────────────────────────────────

test('owner-mode fan-in: round-robins across two bindings of the same connector', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1'), hit('gmail', 'cin_gmail_A', 'A2')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1'), hit('gmail', 'cin_gmail_B', 'B2')],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  const ids = out.envelope.data.map((d) => d.record_key);
  // Round-robin: A1, B1, A2, B2
  assert.deepEqual(ids, ['A1', 'B1', 'A2', 'B2']);
  // Each hit carries the binding's connection_id.
  for (const item of out.envelope.data) {
    assert.equal(typeof item.connection_id, 'string');
    assert.equal(item.connector_instance_id, item.connection_id);
  }
  // Connector count reflects one plan per binding.
  assert.equal(out.disclosureData.connector_count, 2);
});

test('owner-mode fan-in: spans different connectors and bindings together', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
    { connectorId: 'slack', connectorInstanceId: 'cin_slack' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'GA1')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'GB1')],
    cin_slack: [hit('slack', 'cin_slack', 'S1')],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  // Round-robin: one from each binding before any second hit (only one
  // exists per binding here).
  const ids = out.envelope.data.map((d) => d.record_key);
  assert.equal(ids.length, 3);
  assert.deepEqual(new Set(ids), new Set(['GA1', 'GB1', 'S1']));
  // Three plans emitted = three bindings.
  assert.equal(out.disclosureData.connector_count, 3);
});

test('owner-mode fan-in: connection_id narrows to a single binding', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1')],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', connection_id: 'cin_gmail_B' } },
    deps,
  );
  assert.deepEqual(out.envelope.data.map((d) => d.record_key), ['B1']);
});

test('owner-mode fan-in: unknown connection_id raises connection_not_found', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const deps = makeOwnerDepsWithBindings(bindings, {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1')],
  });
  await assert.rejects(
    () => executeSearchLexical(
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

test('owner-mode fan-in: deprecated connector_instance_id alias narrows identically and emits warning', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1')],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', connector_instance_id: 'cin_gmail_A' } },
    deps,
  );
  assert.deepEqual(out.envelope.data.map((d) => d.record_key), ['A1']);
  const codes = (out.envelope.meta?.warnings || []).map((w) => w.code);
  assert.ok(codes.includes('deprecated_alias_used'));
});

test('owner-mode fan-in: skipped binding emits source_skipped_not_applicable with connection_id detail', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1')],
    cin_gmail_B: { _emptyPlan: true },
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  const skipped = (out.envelope.meta?.warnings || []).find(
    (w) => w.code === 'source_skipped_not_applicable',
  );
  assert.ok(skipped, 'expected a source_skipped_not_applicable warning');
  assert.equal(skipped.detail?.source, 'gmail');
  assert.equal(skipped.detail?.connection_id, 'cin_gmail_B');
});

test('owner-mode fan-in: cursor pages across the full multi-binding snapshot exactly once', async () => {
  const bindings = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1'), hit('gmail', 'cin_gmail_A', 'A2')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1'), hit('gmail', 'cin_gmail_B', 'B2')],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const page1 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '2' } },
    deps,
  );
  assert.equal(page1.envelope.has_more, true);
  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '2', cursor: page1.envelope.next_cursor } },
    deps,
  );
  assert.equal(page2.envelope.has_more, false);
  const all = [...page1.envelope.data, ...page2.envelope.data].map((d) => d.record_key);
  assert.equal(new Set(all).size, all.length, 'pagination must not duplicate hits');
  assert.equal(all.length, 4);
});

// ─── Client-mode cross-binding fan-out ───────────────────────────────────

const grantWithTwoBindings = {
  source: { kind: 'connector', id: 'gmail' },
  streams: [{ name: 'messages' }],
};
const clientActor = {
  kind: 'client',
  subject_id: 'subj_owner',
  client_id: 'cl1',
  grant_id: 'g1',
  grant: grantWithTwoBindings,
};

function makeClientDepsWithBindings(bindingSpecs, hitsByBinding, opts = {}) {
  const stored = new Map();
  return {
    getAdvertisement: () => defaultAdvertisement,
    listOwnerVisibleConnectorIds: () => ['gmail'],
    resolveOwnerManifestForConnector: () => ({ streams: [{ name: 'messages' }] }),
    buildOwnerReadGrantForManifest: (m) => ({ streams: (m.streams || []).map((s) => ({ name: s.name })) }),
    resolveClientManifest: () => ({ streams: [{ name: 'messages' }] }),
    resolveClientBindings: (actor, { connectionId }) => {
      if (opts.resolverError) throw opts.resolverError;
      // Honor narrowing by request connection_id; raise connection_not_found
      // when the request asked for a binding that isn't in the grant's set.
      if (connectionId) {
        const match = bindingSpecs.find((b) => b.connectorInstanceId === connectionId);
        if (!match) {
          const err = new Error(`connection_id '${connectionId}' is not addressable under this grant.`);
          err.code = 'connection_not_found';
          err.param = 'connection_id';
          throw err;
        }
        return [{ manifest: match.manifest, connectorInstanceId: match.connectorInstanceId, displayName: match.displayName }];
      }
      return bindingSpecs.map((b) => ({
        manifest: b.manifest,
        connectorInstanceId: b.connectorInstanceId,
        ...(b.displayName ? { displayName: b.displayName } : {}),
      }));
    },
    buildSearchPlanForGrant: ({ manifest }) => {
      const cid = manifest?.storage_binding?.connector_instance_id || null;
      return [{ streamName: 'messages', connectorInstanceId: cid, searchableFields: ['subject'] }];
    },
    buildSnapshot: ({ q, perConnectorPlans }) => {
      const results = [];
      const lists = perConnectorPlans.map((p) => {
        const cid = p.planEntries[0]?.connectorInstanceId;
        return (hitsByBinding[cid] || []).slice();
      });
      let i = 0;
      let progress = true;
      while (progress) {
        progress = false;
        for (const list of lists) {
          if (i < list.length) {
            results.push(list[i]);
            progress = true;
          }
        }
        i += 1;
      }
      return { snapshot_id: `snap_c_${q}_${results.length}`, query: q, results };
    },
    persistSnapshot: (snap) => { stored.set(snap.snapshot_id, snap); },
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
  };
}

test('client-mode fan-in: emits one plan per grant-authorized binding', async () => {
  const bindingSpecs = [
    {
      connectorInstanceId: 'cin_gmail_A',
      manifest: { streams: [{ name: 'messages' }], storage_binding: { connector_id: 'gmail', connector_instance_id: 'cin_gmail_A' } },
    },
    {
      connectorInstanceId: 'cin_gmail_B',
      manifest: { streams: [{ name: 'messages' }], storage_binding: { connector_id: 'gmail', connector_instance_id: 'cin_gmail_B' } },
    },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1')],
  };
  const deps = makeClientDepsWithBindings(bindingSpecs, hits);
  const out = await executeSearchLexical(
    { actor: clientActor, query: { q: 'foo' } },
    deps,
  );
  const ids = out.envelope.data.map((d) => d.record_key).sort();
  assert.deepEqual(ids, ['A1', 'B1']);
  for (const item of out.envelope.data) {
    assert.ok(item.connection_id);
    assert.equal(item.connector_instance_id, item.connection_id);
  }
});

test('client-mode fan-in: request connection_id outside grant raises connection_not_found', async () => {
  const bindingSpecs = [
    {
      connectorInstanceId: 'cin_gmail_A',
      manifest: { streams: [{ name: 'messages' }], storage_binding: { connector_id: 'gmail', connector_instance_id: 'cin_gmail_A' } },
    },
  ];
  const deps = makeClientDepsWithBindings(bindingSpecs, { cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1')] });
  await assert.rejects(
    () =>
      executeSearchLexical(
        { actor: clientActor, query: { q: 'foo', connection_id: 'cin_unknown' } },
        deps,
      ),
    (err) => {
      assert.equal(err.code, 'connection_not_found');
      assert.equal(err.param, 'connection_id');
      return true;
    },
  );
});

// ─── Plan-hash binding-set determinism ───────────────────────────────────

test('owner-mode fan-in: cursor pins the issued snapshot even if binding ordering changes on the next call', async () => {
  // The first call enumerates bindings in [A, B]; the cursor pins that
  // snapshot. A subsequent fresh call with the same query but bindings
  // [B, A] would build a different snapshot, but the cursor reuse path
  // loads the original snapshot by id and pages from it unchanged.
  const ordered = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
  ];
  const reversed = [
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_B' },
    { connectorId: 'gmail', connectorInstanceId: 'cin_gmail_A' },
  ];
  const hits = {
    cin_gmail_A: [hit('gmail', 'cin_gmail_A', 'A1'), hit('gmail', 'cin_gmail_A', 'A2')],
    cin_gmail_B: [hit('gmail', 'cin_gmail_B', 'B1'), hit('gmail', 'cin_gmail_B', 'B2')],
  };
  const deps = makeOwnerDepsWithBindings(ordered, hits);
  const page1 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '2' } },
    deps,
  );
  // Now reverse the binding order in the deps (simulating new active
  // bindings being added/removed mid-pagination); page2 must still serve
  // from the original snapshot.
  deps.listOwnerVisibleBindings = () => reversed;
  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '2', cursor: page1.envelope.next_cursor } },
    deps,
  );
  const all = [...page1.envelope.data, ...page2.envelope.data].map((d) => d.record_key);
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 4);
});

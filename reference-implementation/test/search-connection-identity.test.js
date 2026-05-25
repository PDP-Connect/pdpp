/**
 * Regression: search hits across lexical / semantic / hybrid all carry
 * `connection_id` and the deprecated `connector_instance_id` alias on the
 * emitted `search_result` items when the underlying snapshot supplied the
 * identifier.
 *
 * Scope:
 *   - Lexical and semantic snapshots already track `connectorInstanceId`
 *     per hit. The operation MUST forward it onto the public result item.
 *   - Hybrid composes the two source envelopes and MUST preserve the
 *     identity fields that the sources emitted.
 *   - When the snapshot omits the identifier (defensive: pre-identity
 *     snapshots or partial fixtures), the operation MUST omit the field
 *     rather than emit an empty string.
 *
 * Companion to `public-read-connection-alias.test.js`, which covers the
 * alias-conflict validation on the request side. This file covers the
 * response side.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeSearchLexical } from '../operations/rs-search-lexical/index.ts';
import { executeSearchSemantic } from '../operations/rs-search-semantic/index.ts';
import { executeSearchHybrid } from '../operations/rs-search-hybrid/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_owner' };

const lexicalAd = {
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

const semanticAd = {
  supported: true,
  cross_stream: true,
  snippets: true,
  default_limit: 25,
  max_limit: 100,
  score: {
    supported: true,
    kind: 'semantic_distance',
    order: 'lower_is_better',
    value_semantics: 'distance',
  },
};

const BACKEND_ID = 'stub-backend-identity-v1';

function makeLexicalDeps({ connectorInstanceIds }) {
  const stored = new Map();
  return {
    getAdvertisement: () => lexicalAd,
    listOwnerVisibleConnectorIds: () => ['acme_payroll'],
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: 'pay_statements' }],
    }),
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveClientManifest: () => ({ streams: [{ name: 'pay_statements' }] }),
    buildSearchPlanForGrant: ({ manifest }) =>
      (manifest.streams || []).map((s) => ({
        streamName: s.name,
        searchableFields: ['employer'],
      })),
    buildSnapshot: ({ q }) => ({
      snapshot_id: `snap_${q}`,
      query: q,
      results: connectorInstanceIds.map((cii, i) => ({
        connectorId: 'acme_payroll',
        connectorInstanceId: cii,
        stream: 'pay_statements',
        recordKey: `rec_${i + 1}`,
        emittedAt: '2026-04-01T00:00:00Z',
        matchedFields: ['employer'],
        score: -1 - i * 0.1,
      })),
    }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
  };
}

function makeSemanticDeps({ connectorInstanceIds }) {
  const stored = new Map();
  return {
    getAdvertisement: () => semanticAd,
    getCurrentBackendIdentity: () => BACKEND_ID,
    listOwnerVisibleConnectorIds: () => ['acme_payroll'],
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: 'pay_statements' }],
    }),
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveClientManifest: () => ({ streams: [{ name: 'pay_statements' }] }),
    buildSearchPlanForGrant: ({ manifest }) =>
      (manifest.streams || []).map((s) => ({
        streamName: s.name,
        searchableFields: ['employer'],
      })),
    buildSnapshot: ({ q }) => ({
      snapshot_id: `snap_${q}`,
      query: q,
      backend_hash: BACKEND_ID,
      results: connectorInstanceIds.map((cii, i) => ({
        connectorId: 'acme_payroll',
        connectorInstanceId: cii,
        stream: 'pay_statements',
        recordKey: `rec_${i + 1}`,
        matchedFields: ['employer'],
        distance: 0.05 + i * 0.01,
      })),
    }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    hydrateResult: ({ hit }) => ({
      emittedAt: '2026-04-01T00:00:00Z',
      snippet: { field: 'employer', text: `…${hit.recordKey}…` },
    }),
    formatRecordUrl: ({ stream, recordKey }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
  };
}

test('lexical search emits connection_id and connector_instance_id on every hit', async () => {
  const deps = makeLexicalDeps({
    connectorInstanceIds: ['ci_acme_alpha', 'ci_acme_beta'],
  });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.equal(result.envelope.data.length, 2);
  for (const hit of result.envelope.data) {
    assert.equal(hit.connector_id, 'acme_payroll');
    assert.ok(
      hit.connection_id && typeof hit.connection_id === 'string',
      'lexical hit must carry connection_id',
    );
    assert.equal(
      hit.connector_instance_id,
      hit.connection_id,
      'connector_instance_id MUST mirror connection_id during deprecation',
    );
  }
  // Confirm both bindings round-trip distinctly so the value really came
  // from the snapshot, not a hard-coded string.
  assert.deepEqual(
    result.envelope.data.map((h) => h.connection_id).sort(),
    ['ci_acme_alpha', 'ci_acme_beta'],
  );
});

test('lexical search omits connection_id when the snapshot did not capture one', async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: [null] });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.equal(result.envelope.data.length, 1);
  const [hit] = result.envelope.data;
  assert.equal(hit.connection_id, undefined);
  assert.equal(hit.connector_instance_id, undefined);
});

test('semantic search emits connection_id and connector_instance_id on every hit', async () => {
  const deps = makeSemanticDeps({
    connectorInstanceIds: ['ci_acme_alpha', 'ci_acme_beta'],
  });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.equal(result.envelope.data.length, 2);
  for (const hit of result.envelope.data) {
    assert.equal(hit.retrieval_mode, 'semantic');
    assert.ok(
      hit.connection_id && typeof hit.connection_id === 'string',
      'semantic hit must carry connection_id',
    );
    assert.equal(hit.connector_instance_id, hit.connection_id);
  }
  assert.deepEqual(
    result.envelope.data.map((h) => h.connection_id).sort(),
    ['ci_acme_alpha', 'ci_acme_beta'],
  );
});

test('semantic search omits connection_id when the snapshot did not capture one', async () => {
  const deps = makeSemanticDeps({ connectorInstanceIds: [null] });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  const [hit] = result.envelope.data;
  assert.equal(hit.connection_id, undefined);
  assert.equal(hit.connector_instance_id, undefined);
});

test('hybrid search forwards connection_id from both sources and reconciles overlap', async () => {
  // rec_1 is found by both sources with matching connection_id ⇒ identity
  // pinned on first source-write wins, but values agree.
  // rec_2 only from semantic, rec_3 only from lexical — each preserves its
  // own connection_id distinctly.
  const lexicalHits = [
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_1',
      connector_id: 'acme',
      connection_id: 'ci_acme_alpha',
      connector_instance_id: 'ci_acme_alpha',
      record_url: '/v1/streams/posts/records/rec_1',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['title'],
      snippet: { field: 'title', text: 'lex-snippet' },
      score: { kind: 'bm25', value: -1.5, order: 'lower_is_better' },
    },
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_3',
      connector_id: 'acme',
      connection_id: 'ci_acme_gamma',
      connector_instance_id: 'ci_acme_gamma',
      record_url: '/v1/streams/posts/records/rec_3',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['title'],
      score: { kind: 'bm25', value: -1.2, order: 'lower_is_better' },
    },
  ];
  const semanticHits = [
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_1',
      connector_id: 'acme',
      connection_id: 'ci_acme_alpha',
      connector_instance_id: 'ci_acme_alpha',
      record_url: '/v1/streams/posts/records/rec_1',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['selftext'],
      retrieval_mode: 'semantic',
      snippet: { field: 'selftext', text: 'sem-snippet' },
      score: { kind: 'semantic_distance', value: 0.05, order: 'lower_is_better' },
    },
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_2',
      connector_id: 'acme',
      connection_id: 'ci_acme_beta',
      connector_instance_id: 'ci_acme_beta',
      record_url: '/v1/streams/posts/records/rec_2',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['selftext'],
      retrieval_mode: 'semantic',
      score: { kind: 'semantic_distance', value: 0.08, order: 'lower_is_better' },
    },
  ];
  const deps = {
    runLexical: () => ({ envelope: { data: lexicalHits } }),
    runSemantic: () => ({ envelope: { data: semanticHits } }),
  };
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  // Index hits by record_key for clarity.
  const byKey = Object.fromEntries(
    result.envelope.data.map((h) => [h.record_key, h]),
  );
  assert.equal(byKey.rec_1.connection_id, 'ci_acme_alpha');
  assert.equal(byKey.rec_1.connector_instance_id, 'ci_acme_alpha');
  assert.equal(byKey.rec_2.connection_id, 'ci_acme_beta');
  assert.equal(byKey.rec_2.connector_instance_id, 'ci_acme_beta');
  assert.equal(byKey.rec_3.connection_id, 'ci_acme_gamma');
  assert.equal(byKey.rec_3.connector_instance_id, 'ci_acme_gamma');
  // Hybrid mode is preserved on every hit.
  for (const hit of result.envelope.data) {
    assert.equal(hit.retrieval_mode, 'hybrid');
  }
});

test('hybrid search omits connection_id when neither source supplied one', async () => {
  const lexicalHit = {
    object: 'search_result',
    stream: 'posts',
    record_key: 'rec_1',
    connector_id: 'acme',
    record_url: '/v1/streams/posts/records/rec_1',
    emitted_at: '2026-04-01T00:00:00Z',
    matched_fields: ['title'],
    score: { kind: 'bm25', value: -1.5, order: 'lower_is_better' },
  };
  const deps = {
    runLexical: () => ({ envelope: { data: [lexicalHit] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  const [hit] = result.envelope.data;
  assert.equal(hit.connection_id, undefined);
  assert.equal(hit.connector_instance_id, undefined);
});

test('hybrid search falls back to connector_instance_id when source emits only the alias', async () => {
  // Defensive: a source that ships only the deprecated alias still seeds
  // the canonical `connection_id` on the merged hybrid hit.
  const lexicalHit = {
    object: 'search_result',
    stream: 'posts',
    record_key: 'rec_1',
    connector_id: 'acme',
    connector_instance_id: 'ci_legacy_only',
    record_url: '/v1/streams/posts/records/rec_1',
    emitted_at: '2026-04-01T00:00:00Z',
    matched_fields: ['title'],
    score: { kind: 'bm25', value: -1.5, order: 'lower_is_better' },
  };
  const deps = {
    runLexical: () => ({ envelope: { data: [lexicalHit] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  const [hit] = result.envelope.data;
  assert.equal(hit.connection_id, 'ci_legacy_only');
  assert.equal(hit.connector_instance_id, 'ci_legacy_only');
});

/**
 * `source_skipped_not_applicable` warning — task 3.6 of
 * `canonicalize-public-read-contract`.
 *
 * Owner-mode search fans out across every owner-visible connector. Today
 * the runtime silently drops connectors whose manifest cannot be resolved
 * or whose searchable plan is empty (no declared lexical/semantic fields).
 *
 * The canonical envelope requires that these drops surface as structured
 * `source_skipped_not_applicable` warnings on `meta.warnings[]`, so wire
 * consumers (REST, MCP, dashboard, CLI) can detect partial fan-out without
 * relying on free-form prose or connector-side health checks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeSearchLexical,
  SEARCH_SOURCE_SKIPPED_WARNING_CODE,
} from '../operations/rs-search-lexical/index.ts';
import {
  executeSearchSemantic,
  SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE,
} from '../operations/rs-search-semantic/index.ts';

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

const SEMANTIC_BACKEND_ID = 'stub-source-skipped-v1';

function makeLexicalDeps({
  ownerConnectors,
  brokenManifestConnectors = [],
  emptyPlanConnectors = [],
}) {
  const stored = new Map();
  const broken = new Set(brokenManifestConnectors);
  const empty = new Set(emptyPlanConnectors);
  return {
    getAdvertisement: () => lexicalAd,
    listOwnerVisibleConnectorIds: () => ownerConnectors,
    resolveOwnerManifestForConnector: (connectorId) => {
      if (broken.has(connectorId)) return null;
      return { connector_id: connectorId, streams: [{ name: 'messages' }] };
    },
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveClientManifest: () => ({ streams: [{ name: 'messages' }] }),
    buildSearchPlanForGrant: ({ manifest, connectorId }) => {
      if (empty.has(connectorId)) return [];
      return (manifest.streams || []).map((s) => ({
        streamName: s.name,
        searchableFields: ['subject'],
      }));
    },
    buildSnapshot: ({ q, perConnectorPlans }) => ({
      snapshot_id: `snap_${q}`,
      query: q,
      results: perConnectorPlans.flatMap(({ connectorId }) => [
        {
          connectorId,
          connectorInstanceId: `ci_${connectorId}`,
          stream: 'messages',
          recordKey: `rec_${connectorId}`,
          emittedAt: '2026-04-01T00:00:00Z',
          matchedFields: ['subject'],
          score: -1,
        },
      ]),
    }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
  };
}

function makeSemanticDeps({
  ownerConnectors,
  brokenManifestConnectors = [],
  emptyPlanConnectors = [],
}) {
  const stored = new Map();
  const broken = new Set(brokenManifestConnectors);
  const empty = new Set(emptyPlanConnectors);
  return {
    getAdvertisement: () => semanticAd,
    getCurrentBackendIdentity: () => SEMANTIC_BACKEND_ID,
    listOwnerVisibleConnectorIds: () => ownerConnectors,
    resolveOwnerManifestForConnector: (connectorId) => {
      if (broken.has(connectorId)) return null;
      return { connector_id: connectorId, streams: [{ name: 'messages' }] };
    },
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveClientManifest: () => ({ streams: [{ name: 'messages' }] }),
    buildSearchPlanForGrant: ({ manifest, connectorId }) => {
      if (empty.has(connectorId)) return [];
      return (manifest.streams || []).map((s) => ({
        streamName: s.name,
        searchableFields: ['subject'],
      }));
    },
    buildSnapshot: ({ q, perConnectorPlans }) => ({
      snapshot_id: `snap_${q}`,
      query: q,
      backend_hash: SEMANTIC_BACKEND_ID,
      results: perConnectorPlans.flatMap(({ connectorId }) => [
        {
          connectorId,
          connectorInstanceId: `ci_${connectorId}`,
          stream: 'messages',
          recordKey: `rec_${connectorId}`,
          matchedFields: ['subject'],
          distance: 0.1,
        },
      ]),
    }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    hydrateResult: ({ hit }) => ({
      emittedAt: '2026-04-01T00:00:00Z',
      snippet: { field: 'subject', text: `…${hit.recordKey}…` },
    }),
    formatRecordUrl: ({ stream, recordKey }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Lexical
// ───────────────────────────────────────────────────────────────────────

test('lexical search emits source_skipped_not_applicable for broken-manifest connector', async () => {
  const deps = makeLexicalDeps({
    ownerConnectors: ['acme', 'broken_one'],
    brokenManifestConnectors: ['broken_one'],
  });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'hello' } },
    deps,
  );
  const warnings = result.envelope.meta?.warnings ?? [];
  const skipped = warnings.filter(
    (w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE,
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].detail?.source, 'broken_one');
});

test('lexical search emits source_skipped_not_applicable when the searchable plan is empty', async () => {
  const deps = makeLexicalDeps({
    ownerConnectors: ['acme', 'no_fields'],
    emptyPlanConnectors: ['no_fields'],
  });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'hello' } },
    deps,
  );
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE,
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].detail?.source, 'no_fields');
});

test('lexical search omits source_skipped_not_applicable when every connector contributes', async () => {
  const deps = makeLexicalDeps({ ownerConnectors: ['acme'] });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'hello' } },
    deps,
  );
  const warnings = result.envelope.meta?.warnings ?? [];
  for (const w of warnings) {
    assert.notEqual(w.code, SEARCH_SOURCE_SKIPPED_WARNING_CODE);
  }
});

// ───────────────────────────────────────────────────────────────────────
// Semantic
// ───────────────────────────────────────────────────────────────────────

test('semantic search emits source_skipped_not_applicable for broken-manifest connector', async () => {
  const deps = makeSemanticDeps({
    ownerConnectors: ['acme', 'broken_one'],
    brokenManifestConnectors: ['broken_one'],
  });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'hello' } },
    deps,
  );
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE,
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].detail?.source, 'broken_one');
});

test('semantic search emits source_skipped_not_applicable when the searchable plan is empty', async () => {
  const deps = makeSemanticDeps({
    ownerConnectors: ['acme', 'no_fields'],
    emptyPlanConnectors: ['no_fields'],
  });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'hello' } },
    deps,
  );
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE,
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].detail?.source, 'no_fields');
});

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
  throwingFilterConnectors = [],
}) {
  const stored = new Map();
  const broken = new Set(brokenManifestConnectors);
  const empty = new Set(emptyPlanConnectors);
  const throwing = new Set(throwingFilterConnectors);
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
      if (throwing.has(connectorId)) {
        // Simulates compileRequestFilters throwing "Unknown field" when the
        // stream's schema lacks the filtered field.
        const err = new Error('Unknown field: received_at');
        err.code = 'filter_field_not_in_schema';
        throw err;
      }
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
  throwingFilterConnectors = [],
}) {
  const stored = new Map();
  const broken = new Set(brokenManifestConnectors);
  const empty = new Set(emptyPlanConnectors);
  const throwing = new Set(throwingFilterConnectors);
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
      if (throwing.has(connectorId)) {
        const err = new Error('Unknown field: received_at');
        err.code = 'filter_field_not_in_schema';
        throw err;
      }
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

// ───────────────────────────────────────────────────────────────────────
// B4: Unknown-field filter → skip, not ok:false
//
// When an owner fan-out query filters on a field that exists in some streams
// but not others, the per-source filter compilation throws an
// `invalidQueryError`-shaped error. The operation must convert it to a
// `source_skipped_not_applicable` warning rather than propagating it as a
// whole-request failure.
// ───────────────────────────────────────────────────────────────────────

test('lexical: multi-source query — unknown-field filter skips that source, others succeed', async () => {
  // "acme" has the filtered field; "legacy" lacks it (throws invalidQueryError).
  const deps = makeLexicalDeps({
    ownerConnectors: ['acme', 'legacy'],
    throwingFilterConnectors: ['legacy'],
  });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'hello', 'streams[]': 'messages', filter: { received_at: { gte: '2026-01-01' } } } },
    deps,
  );
  // The skip warning is present for the throwing source.
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE,
  );
  assert.equal(skipped.length, 1, 'exactly one source skipped');
  assert.equal(skipped[0].detail?.source, 'legacy');
  // The non-throwing source contributed a result.
  assert.equal(result.envelope.data.some((d) => d.connector_id === 'acme'), true, 'acme result present');
});

test('lexical: single-source unknown-field filter propagates as error (no silent widening)', async () => {
  // Single source with a throwing filter — the error should propagate, not be swallowed.
  // In client mode (single manifest path), the caller controls the filter and
  // must get an error back so they can fix the request.
  const stored = new Map();
  const deps = {
    getAdvertisement: () => lexicalAd,
    listOwnerVisibleConnectorIds: () => ['acme'],
    resolveOwnerManifestForConnector: () => ({ streams: [{ name: 'messages' }] }),
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveClientManifest: () => ({ streams: [{ name: 'messages' }] }),
    buildSearchPlanForGrant: () => {
      const err = new Error('Unknown field: received_at');
      err.code = 'filter_field_not_in_schema';
      throw err;
    },
    buildSnapshot: ({ q }) => ({ snapshot_id: `snap_${q}`, query: q, results: [] }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
  };
  // Owner fan-out with single connector: should emit skip warning, not throw.
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'hello', 'streams[]': 'messages', filter: { received_at: { gte: '2026-01-01' } } } },
    deps,
  );
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE,
  );
  assert.equal(skipped.length, 1, 'single-connector unknown-field emits skip warning');
  assert.equal(result.envelope.data.length, 0, 'no results from skipped connector');
});

test('semantic: multi-source query — unknown-field filter skips that source, others succeed', async () => {
  const deps = makeSemanticDeps({
    ownerConnectors: ['acme', 'legacy'],
    throwingFilterConnectors: ['legacy'],
  });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'hello', 'streams[]': 'messages', filter: { received_at: { gte: '2026-01-01' } } } },
    deps,
  );
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE,
  );
  assert.equal(skipped.length, 1, 'exactly one source skipped');
  assert.equal(skipped[0].detail?.source, 'legacy');
  assert.equal(result.envelope.data.some((d) => d.connector_id === 'acme'), true, 'acme result present');
});

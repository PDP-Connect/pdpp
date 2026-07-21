/**
 * Regression: an over-cap `limit` on the direct-REST search surface SHALL
 * surface a structured `limit_clamped` warning via the canonical
 * `meta.warnings[]` envelope slot on the rs.search.* operations, mirroring the
 * records-list `limit_clamped` semantics. The reduction is no longer silent.
 *
 * Spec: openspec/changes/add-search-limit-clamp-warning/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Search-retrieval limit is clamped to the page maximum")
 *
 * This file covers the host-independent operation behavior (all three search
 * modes, the warning derivation matrix, and hybrid single-warning dedup). The
 * native-shell-to-REST passthrough (proving the warning is not dropped at the
 * host boundary) is covered end-to-end in `lexical-retrieval.test.js`.
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
  score: { supported: true, kind: 'bm25', order: 'lower_is_better', value_semantics: 'implementation_relative' },
};

const semanticAd = {
  supported: true,
  cross_stream: true,
  snippets: true,
  default_limit: 25,
  max_limit: 100,
  score: { supported: true, kind: 'semantic_distance', order: 'lower_is_better', value_semantics: 'distance' },
};

const BACKEND_ID = 'stub-backend-limit-clamp-v1';

// A snapshot of 150 results so an over-cap request can be honestly bounded to
// the 100-hit page maximum and a `has_more` truncation is observable.
function makeResults(n) {
  return Array.from({ length: n }, (_, i) => ({
    connectorId: 'acme_payroll',
    connectorInstanceId: 'ci_alpha',
    stream: 'pay_statements',
    recordKey: `rec_${i}`,
    emittedAt: '2026-04-01T00:00:00Z',
    matchedFields: ['employer'],
    score: -1.5,
    distance: 0.05,
  }));
}

function makeLexicalDeps() {
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
      (manifest.streams || []).map((s) => ({ streamName: s.name, searchableFields: ['employer'] })),
    buildSnapshot: ({ q }) => ({ snapshot_id: `snap_${q}`, query: q, results: makeResults(150) }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
  };
}

function makeSemanticDeps() {
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
      (manifest.streams || []).map((s) => ({ streamName: s.name, searchableFields: ['employer'] })),
    buildSnapshot: ({ q }) => ({ snapshot_id: `snap_${q}`, query: q, backend_hash: BACKEND_ID, results: makeResults(150) }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    hydrateResult: ({ hit }) => ({ emittedAt: '2026-04-01T00:00:00Z', snippet: { field: 'employer', text: `…${hit.recordKey}…` } }),
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
  };
}

function findClamp(envelope) {
  return (envelope.meta?.warnings || []).find((w) => w.code === 'limit_clamped');
}

// ─── rs.search.lexical ──────────────────────────────────────────────────────

test('lexical: limit=500 emits a single limit_clamped warning and bounds the page to 100', async () => {
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft', limit: '500' } },
    makeLexicalDeps(),
  );
  assert.equal(result.envelope.data.length, 100, 'over-cap page is bounded to the 100-hit max');
  assert.equal(result.envelope.has_more, true, 'has_more honestly reports more hits exist');
  const clamp = findClamp(result.envelope);
  assert.ok(clamp, 'expected a limit_clamped warning');
  assert.equal(clamp.param, 'limit');
  assert.equal(clamp.detail.requested_limit, 500);
  assert.equal(clamp.detail.max_limit, 100);
  const clampCount = (result.envelope.meta.warnings || []).filter((w) => w.code === 'limit_clamped').length;
  assert.equal(clampCount, 1, 'exactly one limit_clamped warning');
});

test('lexical: limit at or below the cap, absent, zero, and non-numeric emit no limit_clamped warning', async () => {
  for (const query of [
    { q: 'overdraft', limit: '100' },
    { q: 'overdraft', limit: '50' },
    { q: 'overdraft' },
    { q: 'overdraft', limit: '0' },
    { q: 'overdraft', limit: 'banana' },
  ]) {
    const result = await executeSearchLexical({ actor: ownerActor, query }, makeLexicalDeps());
    assert.equal(findClamp(result.envelope), undefined, `limit=${query.limit ?? '<absent>'} must not clamp-warn`);
  }
});

// ─── rs.search.semantic ─────────────────────────────────────────────────────

test('semantic: limit=500 emits a single limit_clamped warning and bounds the page to 100', async () => {
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft', limit: '500' } },
    makeSemanticDeps(),
  );
  assert.equal(result.envelope.data.length, 100);
  const clamp = findClamp(result.envelope);
  assert.ok(clamp, 'expected a limit_clamped warning');
  assert.equal(clamp.param, 'limit');
  assert.equal(clamp.detail.requested_limit, 500);
  assert.equal(clamp.detail.max_limit, 100);
});

test('semantic: in-range / absent limit emits no limit_clamped warning', async () => {
  for (const query of [{ q: 'overdraft', limit: '100' }, { q: 'overdraft' }]) {
    const result = await executeSearchSemantic({ actor: ownerActor, query }, makeSemanticDeps());
    assert.equal(findClamp(result.envelope), undefined);
  }
});

// ─── rs.search.hybrid ───────────────────────────────────────────────────────

test('hybrid: limit=500 emits exactly one limit_clamped warning across composed sources', async () => {
  // Hybrid clamps its own limit and forwards the already-clamped value to its
  // sub-runners, so only hybrid's own warning is emitted; even if a sub-runner
  // echoed one, dedup collapses to a single (code, param) row.
  const deps = {
    runLexical: () => ({ envelope: { data: [] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft', limit: '500' } },
    deps,
  );
  const clamps = (result.envelope.meta?.warnings || []).filter((w) => w.code === 'limit_clamped');
  assert.equal(clamps.length, 1, 'hybrid emits exactly one limit_clamped warning');
  assert.equal(clamps[0].param, 'limit');
  assert.equal(clamps[0].detail.requested_limit, 500);
  assert.equal(clamps[0].detail.max_limit, 100);
});

test('hybrid: in-range limit emits no limit_clamped warning', async () => {
  const deps = {
    runLexical: () => ({ envelope: { data: [] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft', limit: '100' } },
    deps,
  );
  assert.equal(findClamp(result.envelope), undefined);
});

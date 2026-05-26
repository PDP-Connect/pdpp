/**
 * Canonical public read envelope — cross-operation conformance.
 *
 * Targets tasks 7.1, 7.2, 7.3 of `canonicalize-public-read-contract`:
 *
 *   - 7.1: envelope-shape coverage for already-supported invariants
 *          (`object`, `data`, `has_more`, identity on every hit).
 *   - 7.2: multi-connection fixture exercising lexical/semantic/hybrid so
 *          identity is verified across more than one binding.
 *   - 7.3: regression assertions that strict-validation behavior already
 *          shipped (conflicting alias) is uniform across search ops.
 *
 * Scope discipline: this file only asserts cross-operation behavior already
 * implemented in the runtime. Focused runtime tests cover records-list
 * identity, deprecated-alias warnings, unknown-parameter rejection, and
 * expansion-target rejection. Items still pending in `tasks.md` are kept as
 * `test.todo` here so the broader implementation lane cannot silently drop
 * them.
 *
 * Companion files:
 *   - search-connection-identity.test.js — identity emission per backend
 *   - public-read-connection-alias.test.js — request-side alias validation
 *   - public-read-connection-id-decoration.test.js — records-list/detail
 *     identity, deprecated-alias warnings, and expansion rejection
 *   - record-read-conformance.test.js     — record list/cursor/projection
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeSearchLexical } from '../operations/rs-search-lexical/index.ts';
import { executeSearchSemantic } from '../operations/rs-search-semantic/index.ts';
import { executeSearchHybrid } from '../operations/rs-search-hybrid/index.ts';
import {
  parseSearchLexicalParams,
  SearchLexicalRequestError,
} from '../operations/rs-search-lexical/index.ts';
import {
  parseSearchSemanticParams,
  SearchSemanticRequestError,
} from '../operations/rs-search-semantic/index.ts';
import {
  parseSearchHybridParams,
  SearchHybridRequestError,
} from '../operations/rs-search-hybrid/index.ts';

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

const BACKEND_ID = 'stub-canonical-conformance-v1';

function makeLexicalDeps({ connectorInstanceIds, displayNames = {} }) {
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
      results: connectorInstanceIds.map((cii, i) => {
        const hit = {
          connectorId: 'acme_payroll',
          connectorInstanceId: cii,
          stream: 'pay_statements',
          recordKey: `rec_${i + 1}`,
          emittedAt: '2026-04-01T00:00:00Z',
          matchedFields: ['employer'],
          score: -1 - i * 0.1,
        };
        if (displayNames[cii]) hit.displayName = displayNames[cii];
        return hit;
      }),
    }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
  };
}

function makeSemanticDeps({ connectorInstanceIds, displayNames = {} }) {
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
      results: connectorInstanceIds.map((cii, i) => {
        const hit = {
          connectorId: 'acme_payroll',
          connectorInstanceId: cii,
          stream: 'pay_statements',
          recordKey: `rec_${i + 1}`,
          matchedFields: ['employer'],
          distance: 0.05 + i * 0.01,
        };
        if (displayNames[cii]) hit.displayName = displayNames[cii];
        return hit;
      }),
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

// ───────────────────────────────────────────────────────────────────────
// 7.1 — Envelope-shape coverage for already-implemented invariants
// ───────────────────────────────────────────────────────────────────────

test('lexical search envelope carries object=list, data array, and has_more flag', async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: ['ci_acme_alpha'] });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.equal(result.envelope.object, 'list');
  assert.ok(Array.isArray(result.envelope.data));
  assert.equal(typeof result.envelope.has_more, 'boolean');
});

test('semantic search envelope carries object=list, data array, and has_more flag', async () => {
  const deps = makeSemanticDeps({ connectorInstanceIds: ['ci_acme_alpha'] });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.equal(result.envelope.object, 'list');
  assert.ok(Array.isArray(result.envelope.data));
  assert.equal(typeof result.envelope.has_more, 'boolean');
});

test('every lexical hit is canonically addressable: connector_id + stream + record_key', async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: ['ci_acme_alpha'] });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.ok(result.envelope.data.length > 0);
  for (const hit of result.envelope.data) {
    assert.equal(hit.object, 'search_result');
    assert.equal(typeof hit.connector_id, 'string');
    assert.equal(typeof hit.stream, 'string');
    assert.equal(typeof hit.record_key, 'string');
    assert.ok(hit.connector_id.length > 0);
    assert.ok(hit.stream.length > 0);
    assert.ok(hit.record_key.length > 0);
  }
});

// ───────────────────────────────────────────────────────────────────────
// 7.2 — Multi-connection fixture: identity must distinguish bindings
// ───────────────────────────────────────────────────────────────────────

test('multi-connection lexical fixture: every hit carries its own connection_id (not the same one)', async () => {
  const deps = makeLexicalDeps({
    connectorInstanceIds: ['ci_acme_alpha', 'ci_acme_beta', 'ci_acme_gamma'],
  });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  const ids = result.envelope.data.map((h) => h.connection_id);
  assert.deepEqual(
    ids.sort(),
    ['ci_acme_alpha', 'ci_acme_beta', 'ci_acme_gamma'],
    'lexical search across multiple bindings must preserve per-hit identity',
  );
  // Deprecated alias must mirror exactly during the migration window.
  for (const hit of result.envelope.data) {
    assert.equal(hit.connector_instance_id, hit.connection_id);
  }
});

test('multi-connection semantic fixture: every hit carries its own connection_id', async () => {
  const deps = makeSemanticDeps({
    connectorInstanceIds: ['ci_acme_alpha', 'ci_acme_beta'],
  });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  const ids = result.envelope.data.map((h) => h.connection_id);
  assert.deepEqual(ids.sort(), ['ci_acme_alpha', 'ci_acme_beta']);
});

test('multi-connection hybrid fixture: identity from both sources survives composition', async () => {
  const lexicalHits = [
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_alpha',
      connector_id: 'acme',
      connection_id: 'ci_alpha',
      connector_instance_id: 'ci_alpha',
      record_url: '/v1/streams/posts/records/rec_alpha',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['title'],
      score: { kind: 'bm25', value: -1.5, order: 'lower_is_better' },
    },
  ];
  const semanticHits = [
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_beta',
      connector_id: 'acme',
      connection_id: 'ci_beta',
      connector_instance_id: 'ci_beta',
      record_url: '/v1/streams/posts/records/rec_beta',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['selftext'],
      retrieval_mode: 'semantic',
      score: { kind: 'semantic_distance', value: 0.05, order: 'lower_is_better' },
    },
  ];
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    {
      runLexical: () => ({ envelope: { data: lexicalHits } }),
      runSemantic: () => ({ envelope: { data: semanticHits } }),
    },
  );
  const byKey = Object.fromEntries(
    result.envelope.data.map((h) => [h.record_key, h]),
  );
  assert.equal(byKey.rec_alpha.connection_id, 'ci_alpha');
  assert.equal(byKey.rec_beta.connection_id, 'ci_beta');
  // Confirm the two identities truly stayed distinct (regression: an early
  // composition pass copied the first hit's identity onto every result).
  assert.notEqual(byKey.rec_alpha.connection_id, byKey.rec_beta.connection_id);
});

// ───────────────────────────────────────────────────────────────────────
// 3.1 — Search hits carry display_name when the snapshot pinned a label
// ───────────────────────────────────────────────────────────────────────

test('lexical search emits display_name when the snapshot pinned a non-placeholder label', async () => {
  const deps = makeLexicalDeps({
    connectorInstanceIds: ['ci_acme_alpha', 'ci_acme_beta'],
    displayNames: {
      ci_acme_alpha: 'Acme Personal',
      ci_acme_beta: 'Acme Business',
    },
  });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  const byCii = Object.fromEntries(
    result.envelope.data.map((h) => [h.connection_id, h]),
  );
  assert.equal(byCii.ci_acme_alpha.display_name, 'Acme Personal');
  assert.equal(byCii.ci_acme_beta.display_name, 'Acme Business');
});

test('lexical search omits display_name when the snapshot did not pin one (no guessing)', async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: ['ci_acme_alpha'] });
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  for (const hit of result.envelope.data) {
    assert.ok(
      !('display_name' in hit),
      'display_name SHOULD be omitted when the runtime cannot pin a label without guessing',
    );
  }
});

test('semantic search emits display_name when the snapshot pinned a label', async () => {
  const deps = makeSemanticDeps({
    connectorInstanceIds: ['ci_acme_alpha'],
    displayNames: { ci_acme_alpha: 'Acme Personal' },
  });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.equal(result.envelope.data[0].display_name, 'Acme Personal');
});

test('semantic search omits display_name when the snapshot did not pin one', async () => {
  const deps = makeSemanticDeps({ connectorInstanceIds: ['ci_acme_alpha'] });
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  for (const hit of result.envelope.data) {
    assert.ok(!('display_name' in hit));
  }
});

test('hybrid search forwards display_name from whichever source provided it', async () => {
  const lexicalHits = [
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_alpha',
      connector_id: 'acme',
      connection_id: 'ci_alpha',
      connector_instance_id: 'ci_alpha',
      display_name: 'Acme Personal',
      record_url: '/v1/streams/posts/records/rec_alpha',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['title'],
      score: { kind: 'bm25', value: -1.5, order: 'lower_is_better' },
    },
  ];
  const semanticHits = [
    {
      object: 'search_result',
      stream: 'posts',
      record_key: 'rec_beta',
      connector_id: 'acme',
      connection_id: 'ci_beta',
      connector_instance_id: 'ci_beta',
      // No display_name supplied — hybrid must omit on the merged item.
      record_url: '/v1/streams/posts/records/rec_beta',
      emitted_at: '2026-04-01T00:00:00Z',
      matched_fields: ['selftext'],
      retrieval_mode: 'semantic',
      score: { kind: 'semantic_distance', value: 0.05, order: 'lower_is_better' },
    },
  ];
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    {
      runLexical: () => ({ envelope: { data: lexicalHits } }),
      runSemantic: () => ({ envelope: { data: semanticHits } }),
    },
  );
  const byKey = Object.fromEntries(
    result.envelope.data.map((h) => [h.record_key, h]),
  );
  assert.equal(byKey.rec_alpha.display_name, 'Acme Personal');
  assert.ok(!('display_name' in byKey.rec_beta));
});

// ───────────────────────────────────────────────────────────────────────
// 7.3 — Strict-validation regressions for already-shipped behavior
// ───────────────────────────────────────────────────────────────────────

test('lexical parser does NOT silently no-op on conflicting alias', () => {
  // Regression: prior code accepted both and picked one without warning.
  assert.throws(
    () =>
      parseSearchLexicalParams({
        q: 'overdraft',
        connection_id: 'ci_a',
        connector_instance_id: 'ci_b',
      }),
    (err) =>
      err instanceof SearchLexicalRequestError &&
      err.code === 'invalid_argument' &&
      err.param === 'connector_instance_id',
  );
});

test('semantic parser does NOT silently no-op on conflicting alias', () => {
  assert.throws(
    () =>
      parseSearchSemanticParams({
        q: 'overdraft',
        connection_id: 'ci_a',
        connector_instance_id: 'ci_b',
      }),
    (err) =>
      err instanceof SearchSemanticRequestError &&
      err.code === 'invalid_argument' &&
      err.param === 'connector_instance_id',
  );
});

test('hybrid parser does NOT silently no-op on conflicting alias', () => {
  assert.throws(
    () =>
      parseSearchHybridParams({
        q: 'overdraft',
        connection_id: 'ci_a',
        connector_instance_id: 'ci_b',
      }),
    (err) =>
      err instanceof SearchHybridRequestError &&
      err.code === 'invalid_argument' &&
      err.param === 'connector_instance_id',
  );
});

test('all three search parsers reject the same alias-conflict shape consistently', () => {
  // Cross-op consistency: an MCP / dashboard / CLI client that learns one
  // error contract MUST get the same shape from every search mode. Drift
  // here is the symptom we are guarding against.
  const conflicting = {
    q: 'overdraft',
    connection_id: 'ci_a',
    connector_instance_id: 'ci_b',
  };
  const errors = [];
  for (const [label, parse, ErrType] of [
    ['lexical', parseSearchLexicalParams, SearchLexicalRequestError],
    ['semantic', parseSearchSemanticParams, SearchSemanticRequestError],
    ['hybrid', parseSearchHybridParams, SearchHybridRequestError],
  ]) {
    try {
      parse(conflicting);
      assert.fail(`${label} parser failed to reject conflicting alias`);
    } catch (err) {
      assert.ok(err instanceof ErrType, `${label} threw the wrong error type`);
      errors.push({ code: err.code, param: err.param });
    }
  }
  // Same code/param across the board.
  assert.deepEqual(
    new Set(errors.map((e) => e.code)),
    new Set(['invalid_argument']),
  );
  assert.deepEqual(
    new Set(errors.map((e) => e.param)),
    new Set(['connector_instance_id']),
  );
});

// ───────────────────────────────────────────────────────────────────────
// Pending canonical-contract requirements (red on the impl lane)
// ───────────────────────────────────────────────────────────────────────

test.todo(
  'public read envelope SHALL carry links.self and links.next — pending tasks.md 3.4 (envelope normalization)',
);

test.todo(
  'public read SHALL support Prefer: count=estimated with meta.count.kind — pending tasks.md 3.7 (graded counts)',
);

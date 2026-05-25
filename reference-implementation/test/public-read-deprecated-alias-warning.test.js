/**
 * Regression: deprecated `connector_instance_id` alias usage SHALL surface
 * a structured `deprecated_alias_used` warning via the canonical
 * `meta.warnings[]` envelope slot on rs.search.* operations and via the
 * shared `resolveRequestConnectionId` helper used by records/aggregate.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Public read warnings SHALL be structured")
 *
 * Tasks 3.6 + 3.5 of `canonicalize-public-read-contract` — strict alias
 * conflict rejection is already covered by `public-read-connection-alias.test.js`.
 * This file covers the *warning* surface, not the conflict surface.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTION_ALIAS_DEPRECATED_WARNING_CODE,
  resolveRequestConnectionId,
} from '../server/connection-id-request.js';
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

const BACKEND_ID = 'stub-backend-warning-v1';

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
      (manifest.streams || []).map((s) => ({
        streamName: s.name,
        searchableFields: ['employer'],
      })),
    buildSnapshot: ({ q }) => ({
      snapshot_id: `snap_${q}`,
      query: q,
      results: [
        {
          connectorId: 'acme_payroll',
          connectorInstanceId: 'ci_alpha',
          stream: 'pay_statements',
          recordKey: 'rec_1',
          emittedAt: '2026-04-01T00:00:00Z',
          matchedFields: ['employer'],
          score: -1.5,
        },
      ],
    }),
    persistSnapshot: (snap) => stored.set(snap.snapshot_id, snap),
    loadSnapshot: (id) => stored.get(id) ?? null,
    formatRecordUrl: ({ stream, recordKey }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
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
      (manifest.streams || []).map((s) => ({
        streamName: s.name,
        searchableFields: ['employer'],
      })),
    buildSnapshot: ({ q }) => ({
      snapshot_id: `snap_${q}`,
      query: q,
      backend_hash: BACKEND_ID,
      results: [
        {
          connectorId: 'acme_payroll',
          connectorInstanceId: 'ci_alpha',
          stream: 'pay_statements',
          recordKey: 'rec_1',
          matchedFields: ['employer'],
          distance: 0.05,
        },
      ],
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

// ─── connection-id-request: helper-level coverage ───────────────────────────

test('resolveRequestConnectionId emits no warnings for canonical-only request', () => {
  const { connectionId, warnings } = resolveRequestConnectionId({ connection_id: 'cin_abc' });
  assert.equal(connectionId, 'cin_abc');
  assert.deepEqual(warnings, []);
});

test('resolveRequestConnectionId emits deprecated_alias_used when only deprecated alias is sent', () => {
  const { connectionId, warnings } = resolveRequestConnectionId({
    connector_instance_id: 'cin_abc',
  });
  assert.equal(connectionId, 'cin_abc');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, CONNECTION_ALIAS_DEPRECATED_WARNING_CODE);
  assert.equal(warnings[0].param, 'connector_instance_id');
});

test('resolveRequestConnectionId emits deprecated_alias_used when both fields match', () => {
  const { connectionId, warnings } = resolveRequestConnectionId({
    connection_id: 'cin_abc',
    connector_instance_id: 'cin_abc',
  });
  assert.equal(connectionId, 'cin_abc');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, CONNECTION_ALIAS_DEPRECATED_WARNING_CODE);
});

test('resolveRequestConnectionId returns null connectionId and no warnings when neither is sent', () => {
  const { connectionId, warnings } = resolveRequestConnectionId({});
  assert.equal(connectionId, null);
  assert.deepEqual(warnings, []);
});

test('resolveRequestConnectionId still rejects conflicting values via the shared validator', () => {
  assert.throws(
    () =>
      resolveRequestConnectionId({
        connection_id: 'cin_abc',
        connector_instance_id: 'cin_xyz',
      }),
    (err) => err.code === 'invalid_argument' && err.param === 'connector_instance_id',
  );
});

test('resolveRequestConnectionId treats empty alias as absent (no warning, no value)', () => {
  const { connectionId, warnings } = resolveRequestConnectionId({
    connector_instance_id: '',
  });
  assert.equal(connectionId, null);
  assert.deepEqual(warnings, []);
});

// ─── rs.search.lexical: envelope-level coverage ─────────────────────────────

test('lexical search omits meta.warnings when only canonical connection_id is sent', async () => {
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'overdraft', connection_id: 'ci_alpha' } },
    makeLexicalDeps(),
  );
  assert.equal(result.envelope.meta, undefined);
});

test('lexical search emits meta.warnings deprecated_alias_used when only the deprecated alias is sent', async () => {
  const result = await executeSearchLexical(
    {
      actor: ownerActor,
      query: { q: 'overdraft', connector_instance_id: 'ci_alpha' },
    },
    makeLexicalDeps(),
  );
  assert.ok(result.envelope.meta, 'expected envelope.meta to be present');
  assert.equal(result.envelope.meta.warnings.length, 1);
  assert.equal(result.envelope.meta.warnings[0].code, 'deprecated_alias_used');
  assert.equal(result.envelope.meta.warnings[0].param, 'connector_instance_id');
});

test('lexical search emits meta.warnings when both fields are sent with matching values', async () => {
  const result = await executeSearchLexical(
    {
      actor: ownerActor,
      query: {
        q: 'overdraft',
        connection_id: 'ci_alpha',
        connector_instance_id: 'ci_alpha',
      },
    },
    makeLexicalDeps(),
  );
  assert.ok(result.envelope.meta);
  assert.equal(result.envelope.meta.warnings[0].code, 'deprecated_alias_used');
});

// ─── rs.search.semantic: envelope-level coverage ────────────────────────────

test('semantic search emits meta.warnings deprecated_alias_used when only the deprecated alias is sent', async () => {
  const result = await executeSearchSemantic(
    {
      actor: ownerActor,
      query: { q: 'overdraft', connector_instance_id: 'ci_alpha' },
    },
    makeSemanticDeps(),
  );
  assert.ok(result.envelope.meta);
  assert.equal(result.envelope.meta.warnings[0].code, 'deprecated_alias_used');
});

test('semantic search omits meta.warnings when no alias is sent', async () => {
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { q: 'overdraft', connection_id: 'ci_alpha' } },
    makeSemanticDeps(),
  );
  assert.equal(result.envelope.meta, undefined);
});

// ─── rs.search.hybrid: envelope-level coverage ──────────────────────────────

test('hybrid search emits a single deduplicated deprecated_alias_used warning across sources', async () => {
  // Sources legitimately emit the same warning because the caller's query
  // contains the alias. Hybrid MUST deduplicate so callers see one row per
  // unique (code, param) pair instead of N copies.
  const lexicalEnv = {
    data: [
      {
        object: 'search_result',
        stream: 'posts',
        record_key: 'rec_1',
        connector_id: 'acme',
        connection_id: 'ci_alpha',
        connector_instance_id: 'ci_alpha',
        record_url: '/v1/streams/posts/records/rec_1',
        emitted_at: '2026-04-01T00:00:00Z',
        matched_fields: ['title'],
      },
    ],
    meta: {
      warnings: [
        {
          code: 'deprecated_alias_used',
          param: 'connector_instance_id',
          message: '`connector_instance_id` is deprecated; send `connection_id` instead.',
        },
      ],
    },
  };
  const semanticEnv = {
    data: [],
    meta: {
      warnings: [
        {
          code: 'deprecated_alias_used',
          param: 'connector_instance_id',
          message: '`connector_instance_id` is deprecated; send `connection_id` instead.',
        },
      ],
    },
  };
  const deps = {
    runLexical: () => ({ envelope: lexicalEnv }),
    runSemantic: () => ({ envelope: semanticEnv }),
  };
  const result = await executeSearchHybrid(
    {
      actor: ownerActor,
      query: { q: 'overdraft', connector_instance_id: 'ci_alpha' },
    },
    deps,
  );
  assert.ok(result.envelope.meta);
  assert.equal(
    result.envelope.meta.warnings.length,
    1,
    'hybrid MUST deduplicate identical warnings from its own request and from sub-envelopes',
  );
  assert.equal(result.envelope.meta.warnings[0].code, 'deprecated_alias_used');
});

test('hybrid search omits meta.warnings entirely when neither hybrid nor any source carries warnings', async () => {
  const deps = {
    runLexical: () => ({ envelope: { data: [] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.equal(result.envelope.meta, undefined);
});

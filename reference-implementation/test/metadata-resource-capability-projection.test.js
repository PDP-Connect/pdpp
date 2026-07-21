// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for two UNTESTED metadata read-model builders in
 * `server/metadata.ts`:
 *
 *   1. buildProtectedResourceMetadata — shapes the `oauth-protected-resource`
 *      document. Always-present core fields (resource, resource_name,
 *      authorization_servers, bearer_methods_supported=["header"],
 *      pdpp_provider_connect_version, pdpp_self_export_supported,
 *      pdpp_token_kinds_supported, pdpp_core_query_base); optional blocks
 *      (pdpp_discovery_hints, pdpp_agent_discovery, pdpp_owner_agent_onboarding)
 *      emitted only when supplied; `capabilities` emitted only when a non-empty
 *      object.
 *
 *   2. buildSemanticRetrievalCapability — the semantic-search advertisement, with
 *      a TRUTHFULNESS gate: returns null unless model + dimensions +
 *      distanceMetric + indexState are ALL present. When present it composes a
 *      `score.comparable_with.backend_identity` string in a fixed field order
 *      (`profile=…;model=…;dtype=…;dimensions=…;metric=…`, dropping absent
 *      profile/dtype) and includes `profile_id` / `dtype` keys only when given.
 *      (The sibling `search-count-capability.test.js` covers only the
 *      count/cursor advertisement, not the gate or backend-identity.)
 *
 * Pure — only `node:net` is imported by the module. No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProtectedResourceMetadata,
  buildSemanticRetrievalCapability,
} from '../server/metadata.ts';

function baseMetadataInput(overrides = {}) {
  return {
    resource: 'https://rs.example.com',
    resourceName: 'Reference RS',
    authorizationServers: ['https://as.example.com'],
    queryBase: 'https://rs.example.com/v1/query',
    providerConnectVersion: '1',
    selfExportSupported: true,
    tokenKindsSupported: ['owner', 'client_grant'],
    ...overrides,
  };
}

// --- buildProtectedResourceMetadata -----------------------------------------

test('buildProtectedResourceMetadata: emits exactly the core fields when no optional blocks are supplied', () => {
  const meta = buildProtectedResourceMetadata(baseMetadataInput());
  assert.deepEqual(
    Object.keys(meta).sort(),
    [
      'authorization_servers',
      'bearer_methods_supported',
      'pdpp_core_query_base',
      'pdpp_provider_connect_version',
      'pdpp_self_export_supported',
      'pdpp_token_kinds_supported',
      'resource',
      'resource_name',
    ],
    `keys: ${Object.keys(meta).sort().join(',')}`,
  );
  assert.deepEqual(meta.bearer_methods_supported, ['header'], 'bearer methods is always ["header"]');
  assert.equal(meta.resource, 'https://rs.example.com');
  assert.equal(meta.resource_name, 'Reference RS');
  assert.equal(meta.pdpp_core_query_base, 'https://rs.example.com/v1/query');
  assert.equal(meta.pdpp_self_export_supported, true);
  assert.deepEqual(meta.pdpp_token_kinds_supported, ['owner', 'client_grant']);
});

test('buildProtectedResourceMetadata: optional discovery/agent/onboarding blocks appear only when supplied', () => {
  const hints = { connectors_endpoint: 'https://rs.example.com/v1/connectors' };
  const agent = { advisory: true, skill_name: 'pdpp-data-access' };
  const onboarding = { advisory: true, profile: 'trusted_owner_agent' };
  const meta = buildProtectedResourceMetadata(
    baseMetadataInput({ discoveryHints: hints, agentDiscovery: agent, ownerAgentOnboarding: onboarding }),
  );
  assert.equal(meta.pdpp_discovery_hints, hints, 'discovery hints passed through');
  assert.equal(meta.pdpp_agent_discovery, agent, 'agent discovery passed through');
  assert.equal(meta.pdpp_owner_agent_onboarding, onboarding, 'owner-agent onboarding passed through');
});

test('buildProtectedResourceMetadata: capabilities emitted only when a NON-EMPTY object', () => {
  const withEmpty = buildProtectedResourceMetadata(baseMetadataInput({ capabilities: {} }));
  assert.equal('capabilities' in withEmpty, false, 'empty capabilities object must be omitted');

  const withNull = buildProtectedResourceMetadata(baseMetadataInput({ capabilities: null }));
  assert.equal('capabilities' in withNull, false, 'null capabilities must be omitted');

  const caps = { lexical_retrieval: { supported: true } };
  const withCaps = buildProtectedResourceMetadata(baseMetadataInput({ capabilities: caps }));
  assert.equal(withCaps.capabilities, caps, 'non-empty capabilities included');
});

// --- buildSemanticRetrievalCapability: truthfulness gate --------------------

test('buildSemanticRetrievalCapability: returns null unless model+dimensions+metric+indexState all present', () => {
  assert.equal(
    buildSemanticRetrievalCapability({ dimensions: 384, distanceMetric: 'cosine', indexState: 'built' }),
    null,
    'missing model => null',
  );
  assert.equal(
    buildSemanticRetrievalCapability({ model: 'm', distanceMetric: 'cosine', indexState: 'built' }),
    null,
    'missing dimensions => null',
  );
  assert.equal(
    buildSemanticRetrievalCapability({ model: 'm', dimensions: 384, indexState: 'built' }),
    null,
    'missing distanceMetric => null',
  );
  assert.equal(
    buildSemanticRetrievalCapability({ model: 'm', dimensions: 384, distanceMetric: 'cosine' }),
    null,
    'missing indexState => null',
  );
  assert.equal(buildSemanticRetrievalCapability(), null, 'no args => null');
});

test('buildSemanticRetrievalCapability: minimal complete input yields a supported capability', () => {
  const cap = buildSemanticRetrievalCapability({
    model: 'minilm',
    dimensions: 384,
    distanceMetric: 'cosine',
    indexState: 'built',
  });
  assert.equal(cap.supported, true);
  assert.equal(cap.model, 'minilm');
  assert.equal(cap.dimensions, 384);
  assert.equal(cap.distance_metric, 'cosine');
  assert.equal(cap.index_state, 'built');
  assert.equal(cap.endpoint, '/v1/search/semantic', 'default endpoint');
  assert.equal(cap.query_input, 'text');
  assert.equal(cap.lexical_blending, false);
});

test('buildSemanticRetrievalCapability: backend_identity composes fields in fixed order, dropping absent profile/dtype', () => {
  const full = buildSemanticRetrievalCapability({
    model: 'minilm',
    dimensions: 384,
    distanceMetric: 'cosine',
    indexState: 'built',
    profileId: 'p1',
    dtype: 'int8',
  });
  assert.equal(
    full.score.comparable_with.backend_identity,
    'profile=p1;model=minilm;dtype=int8;dimensions=384;metric=cosine',
    `backend_identity: ${full.score.comparable_with.backend_identity}`,
  );
  assert.equal(full.score.comparable_with.profile_id, 'p1', 'profile_id present');
  assert.equal(full.score.comparable_with.dtype, 'int8', 'dtype present');

  const bare = buildSemanticRetrievalCapability({
    model: 'minilm',
    dimensions: 384,
    distanceMetric: 'cosine',
    indexState: 'built',
  });
  assert.equal(
    bare.score.comparable_with.backend_identity,
    'model=minilm;dimensions=384;metric=cosine',
    `bare backend_identity: ${bare.score.comparable_with.backend_identity}`,
  );
  assert.equal('profile_id' in bare.score.comparable_with, false, 'profile_id omitted when absent');
  assert.equal('dtype' in bare.score.comparable_with, false, 'dtype omitted when absent');
});

test('buildSemanticRetrievalCapability: language_bias attached only when supplied', () => {
  const withBias = buildSemanticRetrievalCapability({
    model: 'm',
    dimensions: 384,
    distanceMetric: 'cosine',
    indexState: 'built',
    languageBias: { primary: 'en' },
  });
  assert.deepEqual(withBias.language_bias, { primary: 'en' });

  const withoutBias = buildSemanticRetrievalCapability({
    model: 'm',
    dimensions: 384,
    distanceMetric: 'cosine',
    indexState: 'built',
  });
  assert.equal('language_bias' in withoutBias, false, 'language_bias omitted when not supplied');
});

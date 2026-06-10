/**
 * Operation-level behavior tests for `rs.protected-resource-metadata`.
 *
 * Pins the composition rules for the protected-resource metadata document:
 *   - lexical capability is published verbatim from the dependency.
 *   - semantic capability is published verbatim from the dependency.
 *   - hybrid capability is published only when (a) not suppressed AND (b)
 *     either an override is provided OR both lexical and semantic carry
 *     `supported: true`.
 *   - Discovery hints always include the fixed pointer block.
 *   - The `search` hint is published only when lexical is supported, with
 *     endpoint pulled from the lexical capability (defaults to `/v1/search`).
 *   - `hybrid_pagination_supported` reflects the hybrid capability's
 *     `cursor_supported` flag when hybrid is published.
 *   - `owner_polyfill_requires_source_kind_connector` is published only when the
 *     server is NOT in native single-source mode.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRsProtectedResourceMetadata } from '../operations/rs-protected-resource-metadata/index.ts';

function withDefaults(overrides = {}) {
  return {
    resolveLexicalCapability: () => null,
    resolveSemanticCapability: () => null,
    resolveHybridCapabilityOverride: () => null,
    buildDefaultHybridCapability: () => null,
    isHybridSuppressed: () => false,
    isNativeSingleSourceMode: () => false,
    resolveClientEventSubscriptionsCapability: () => null,
    ...overrides,
  };
}

test('publishes lexical capability when dependency returns one', async () => {
  const lexical = { supported: true, endpoint: '/v1/search' };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ resolveLexicalCapability: () => lexical }),
  );
  assert.equal(composition.capabilities.lexical_retrieval, lexical);
});

test('omits lexical capability when dependency returns null', async () => {
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults(),
  );
  assert.equal(composition.capabilities.lexical_retrieval, undefined);
});

test('publishes semantic capability when dependency returns one', async () => {
  const semantic = { supported: true, model: 'm', dimensions: 64 };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ resolveSemanticCapability: () => semantic }),
  );
  assert.equal(composition.capabilities.semantic_retrieval, semantic);
});

test('publishes hybrid capability override when present', async () => {
  const hybrid = { supported: true, cursor_supported: false };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ resolveHybridCapabilityOverride: () => hybrid }),
  );
  assert.equal(composition.capabilities.hybrid_retrieval, hybrid);
});

test('builds default hybrid only when both lexical and semantic are supported', async () => {
  const lexical = { supported: true, endpoint: '/v1/search' };
  const semantic = { supported: true };
  const built = { supported: true, cursor_supported: false };
  let buildArgs = null;
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({
      resolveLexicalCapability: () => lexical,
      resolveSemanticCapability: () => semantic,
      buildDefaultHybridCapability: (args) => {
        buildArgs = args;
        return built;
      },
    }),
  );
  assert.deepEqual(buildArgs, { lexicalAvailable: true, semanticAvailable: true });
  assert.equal(composition.capabilities.hybrid_retrieval, built);
});

test('does not build default hybrid when lexical is unsupported', async () => {
  const semantic = { supported: true };
  let buildCalled = false;
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({
      resolveSemanticCapability: () => semantic,
      buildDefaultHybridCapability: () => {
        buildCalled = true;
        return { supported: true, cursor_supported: false };
      },
    }),
  );
  assert.equal(buildCalled, false);
  assert.equal(composition.capabilities.hybrid_retrieval, undefined);
});

test('does not publish hybrid when builder returns supported:false', async () => {
  const lexical = { supported: true };
  const semantic = { supported: true };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({
      resolveLexicalCapability: () => lexical,
      resolveSemanticCapability: () => semantic,
      buildDefaultHybridCapability: () => ({ supported: false }),
    }),
  );
  assert.equal(composition.capabilities.hybrid_retrieval, undefined);
});

test('isHybridSuppressed skips hybrid composition entirely', async () => {
  const lexical = { supported: true };
  const semantic = { supported: true };
  let buildCalled = false;
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({
      resolveLexicalCapability: () => lexical,
      resolveSemanticCapability: () => semantic,
      isHybridSuppressed: () => true,
      resolveHybridCapabilityOverride: () => ({ supported: true }),
      buildDefaultHybridCapability: () => {
        buildCalled = true;
        return { supported: true, cursor_supported: false };
      },
    }),
  );
  assert.equal(composition.capabilities.hybrid_retrieval, undefined);
  assert.equal(buildCalled, false);
});

test('discovery hints include the fixed pointer block', async () => {
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ isNativeSingleSourceMode: () => true }),
  );
  assert.equal(composition.discoveryHints.schema_endpoint, '/v1/schema');
  assert.equal(composition.discoveryHints.query_base, '/v1');
  assert.equal(composition.discoveryHints.connectors_endpoint, '/v1/connectors');
  assert.equal(
    composition.discoveryHints.streams_endpoint_template,
    '/v1/streams/{stream}',
  );
  assert.deepEqual(composition.discoveryHints.aggregate, {
    endpoint_template: '/v1/streams/{stream}/aggregate',
  });
  assert.equal(composition.discoveryHints.changes_since_bootstrap, 'beginning');
  assert.equal(composition.discoveryHints.blob_indirection, 'data.blob_ref.fetch_url');
});

test('search discovery hint published only when lexical is supported', async () => {
  const lexical = { supported: true, endpoint: '/v1/search' };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ resolveLexicalCapability: () => lexical }),
  );
  assert.deepEqual(composition.discoveryHints.search, {
    endpoint: '/v1/search',
    scope_param: 'streams[]',
    filter_requires_single_stream: true,
  });
});

test('search discovery hint endpoint defaults to /v1/search when capability omits it', async () => {
  const lexical = { supported: true };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ resolveLexicalCapability: () => lexical }),
  );
  assert.equal(composition.discoveryHints.search?.endpoint, '/v1/search');
});

test('search discovery hint omitted when lexical is supported:false', async () => {
  const lexical = { supported: false };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ resolveLexicalCapability: () => lexical }),
  );
  assert.equal(composition.discoveryHints.search, undefined);
});

test('hybrid_pagination_supported reflects cursor_supported when hybrid is published', async () => {
  const lexical = { supported: true };
  const semantic = { supported: true };
  const { composition } = await executeRsProtectedResourceMetadata(
    {},
    withDefaults({
      resolveLexicalCapability: () => lexical,
      resolveSemanticCapability: () => semantic,
      buildDefaultHybridCapability: () => ({
        supported: true,
        cursor_supported: true,
      }),
    }),
  );
  assert.equal(composition.discoveryHints.hybrid_pagination_supported, true);
});

test('owner_polyfill_requires_source_kind_connector only published in non-native mode', async () => {
  const polyfill = (await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ isNativeSingleSourceMode: () => false }),
  )).composition;
  assert.equal(polyfill.discoveryHints.owner_polyfill_requires_source_kind_connector, true);

  const native = (await executeRsProtectedResourceMetadata(
    {},
    withDefaults({ isNativeSingleSourceMode: () => true }),
  )).composition;
  assert.equal(
    native.discoveryHints.owner_polyfill_requires_source_kind_connector,
    undefined,
  );
});

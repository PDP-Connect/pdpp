/**
 * Search-mode count and pagination capability metadata — task 4.3 of
 * `canonicalize-public-read-contract`.
 *
 * The canonical contract requires that pagination + count support are
 * advertised on every search capability and that the runtime's strict
 * validation rejects unsupported parameters cleanly. This file pins those
 * two facts:
 *
 *   1. `buildLexicalRetrievalCapability` / `buildSemanticRetrievalCapability` /
 *      `buildHybridRetrievalCapability` emit `cursor_supported` and
 *      `count_supported` so MCP/CLI/dashboard discovery can detect the
 *      negative space without trial-and-error.
 *
 *   2. Each rs.search.* operation's allowlist rejects `count` at parse time
 *      (it is NOT silently dropped), aligning runtime behavior with the
 *      advertised `count_supported: false`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLexicalRetrievalCapability,
  buildSemanticRetrievalCapability,
  buildHybridRetrievalCapability,
} from '../server/metadata.ts';

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

// ───────────────────────────────────────────────────────────────────────
// Advertised pagination/count metadata
// ───────────────────────────────────────────────────────────────────────

test('lexical capability advertises cursor_supported:true and count_supported:false', () => {
  const cap = buildLexicalRetrievalCapability();
  assert.equal(cap.supported, true);
  assert.equal(cap.cursor_supported, true);
  assert.equal(cap.count_supported, false);
});

test('semantic capability advertises cursor_supported:true and count_supported:false', () => {
  const cap = buildSemanticRetrievalCapability({
    model: 'fake-model-v1',
    dimensions: 384,
    distanceMetric: 'cosine',
    indexState: 'built',
  });
  assert.ok(cap, 'semantic capability should be returned when backend is configured');
  assert.equal(cap.cursor_supported, true);
  assert.equal(cap.count_supported, false);
});

test('hybrid capability advertises count_supported:false and forwards cursor_supported', () => {
  const cap = buildHybridRetrievalCapability({ cursorSupported: false });
  assert.equal(cap?.supported, true);
  assert.equal(cap?.cursor_supported, false);
  assert.equal(cap?.count_supported, false);
});

// ───────────────────────────────────────────────────────────────────────
// Runtime rejects count= aligning with the advertised negative capability
// ───────────────────────────────────────────────────────────────────────

test('rs.search.lexical rejects count= as an unsupported parameter', () => {
  assert.throws(
    () => parseSearchLexicalParams({ q: 'foo', count: 'exact' }),
    (err) =>
      err instanceof SearchLexicalRequestError &&
      err.code === 'invalid_request' &&
      err.param === 'count',
    'count is not in the allowlist; the runtime SHALL reject it',
  );
});

test('rs.search.semantic rejects count= as an unsupported parameter', () => {
  assert.throws(
    () => parseSearchSemanticParams({ q: 'foo', count: 'exact' }),
    (err) =>
      err instanceof SearchSemanticRequestError &&
      err.code === 'invalid_request' &&
      err.param === 'count',
  );
});

test('rs.search.hybrid rejects count= as an unsupported parameter', () => {
  assert.throws(
    () => parseSearchHybridParams({ q: 'foo', count: 'exact' }),
    (err) =>
      err instanceof SearchHybridRequestError &&
      err.code === 'invalid_request' &&
      err.param === 'count',
  );
});

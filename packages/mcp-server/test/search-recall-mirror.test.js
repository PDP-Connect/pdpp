// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP search adapter: recall-metadata mirroring.
 *
 * Pins openspec/changes/disclose-lexical-recall-windows:
 *   "An MCP adapter that exposes PDPP lexical search SHALL preserve the RS
 *    response's recall metadata in structured output and SHALL summarize
 *    non-complete recall in its text output. The adapter SHALL NOT infer recall
 *    completeness from has_more, page size, or the number of hits returned."
 *
 * These tests exercise `toSearchToolResult` directly with synthetic RS bodies
 * so the assertions consume only what the model can see: the text content[]
 * and the structuredContent envelope.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { __internal } from '../src/tools.js';

const { toSearchToolResult } = __internal;

const PROVIDER_URL = 'https://rs.example.invalid';

function rsResponse(body) {
  return { ok: true, status: 200, body, requestId: 'req_test' };
}

function completeBody() {
  return {
    object: 'list',
    has_more: false,
    data: [
      { object: 'search_result', stream: 'posts', record_key: 'r1', connector_id: 'redditish-a', record_url: '/v1/streams/posts/records/r1', emitted_at: '2026-04-01T00:00:00Z', matched_fields: ['title'] },
    ],
    meta: {
      count: 1,
      count_accuracy: 'exact',
      recall: { complete: true, ranking_scope: 'all_matches', truncated: false },
    },
  };
}

function candidateWindowBody() {
  return {
    object: 'list',
    // Deliberately has_more:false so a naive adapter that inferred completeness
    // from has_more would WRONGLY report this page as exhaustive.
    has_more: false,
    data: [
      { object: 'search_result', stream: 'posts', record_key: 'w1', connector_id: 'redditish-a', record_url: '/v1/streams/posts/records/w1', emitted_at: '2026-04-01T00:00:00Z', matched_fields: ['title'] },
    ],
    meta: {
      count: 200,
      count_accuracy: 'lower_bound',
      recall: {
        complete: false,
        ranking_scope: 'candidate_window',
        truncated: true,
        ranked_candidate_count: 200,
        candidate_window_limit: 200,
        sources_searched_count: 1,
        truncated_source_count: 1,
      },
    },
  };
}

test('MCP mirrors complete recall into structuredContent.data and omits a recall warning in text', () => {
  const result = toSearchToolResult(rsResponse(completeBody()), PROVIDER_URL);
  const recall = result.structuredContent.data.meta.recall;
  assert.equal(recall.complete, true);
  assert.equal(recall.ranking_scope, 'all_matches');
  assert.equal(result.structuredContent.data.meta.count_accuracy, 'exact');
  assert.equal(result.structuredContent.data.meta.count, 1);
  // No bounded-window warning for a complete search.
  const text = result.content[0].text;
  assert.ok(!/bounded candidate window/i.test(text), 'complete recall must not warn');
});

test('MCP mirrors candidate_window recall and warns in text without inferring from has_more', () => {
  const result = toSearchToolResult(rsResponse(candidateWindowBody()), PROVIDER_URL);
  // Structured mirror: identical recall facts, not reinterpreted.
  const recall = result.structuredContent.data.meta.recall;
  assert.equal(recall.complete, false);
  assert.equal(recall.ranking_scope, 'candidate_window');
  assert.equal(recall.truncated, true);
  assert.equal(recall.candidate_window_limit, 200);
  assert.equal(result.structuredContent.data.meta.count_accuracy, 'lower_bound');

  // Text summary indicates the bounded candidate window even though has_more is
  // false — proving the adapter reads meta.recall, not has_more / hit count.
  const text = result.content[0].text;
  assert.ok(/bounded candidate window/i.test(text), `text must warn on candidate_window recall; got: ${text}`);
  assert.ok(/more matches may exist/i.test(text));
  assert.ok(/candidate_window_limit=200/.test(text));
  assert.ok(/truncated_source_count=1/.test(text));
  // The adapter must not call a bounded-window page exhaustive.
  assert.ok(!/exhaustive\b(?!.*do not)/i.test(text) || /do not treat this page as exhaustive/i.test(text));
});

test('MCP search with no meta does not fabricate recall facts', () => {
  const body = { object: 'list', has_more: false, data: [] };
  const result = toSearchToolResult(rsResponse(body), PROVIDER_URL);
  // No meta in → no meta out (and certainly no invented recall warning).
  const text = result.content[0].text;
  assert.ok(!/bounded candidate window/i.test(text));
  assert.equal(result.structuredContent.data.meta, undefined);
});

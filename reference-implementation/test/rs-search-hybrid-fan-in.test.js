/**
 * Cross-binding fan-in tests for `rs.search.hybrid`.
 *
 * Hybrid does not implement its own fan-out — it composes the underlying
 * lexical and semantic runners. These tests confirm that:
 *   - hybrid dedup key includes `connection_id`, so two bindings under the
 *     same connector that share a `record_key` are not collapsed;
 *   - identity (`connection_id` + deprecated `connector_instance_id` alias)
 *     forwards onto each merged hit from whichever sub-source first
 *     emitted it;
 *   - warnings from sub-sources (including `source_skipped_not_applicable`
 *     with binding-aware `detail.connection_id`) are aggregated into the
 *     hybrid envelope.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSearchHybrid } from '../operations/rs-search-hybrid/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_owner' };

function lexHit({ connectorId = 'gmail', connectorInstanceId, recordKey, stream = 'messages', score = -1 } = {}) {
  return {
    object: 'search_result',
    stream,
    record_key: recordKey,
    connector_id: connectorId,
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
    record_url: `/v1/streams/${stream}/records/${recordKey}`,
    emitted_at: '2026-05-01T00:00:00Z',
    matched_fields: ['subject'],
    snippet: { field: 'subject', text: 'lex' },
    score: { kind: 'bm25', value: score, order: 'lower_is_better' },
  };
}

function semHit({ connectorId = 'gmail', connectorInstanceId, recordKey, stream = 'messages', distance = 0.1 } = {}) {
  return {
    object: 'search_result',
    stream,
    record_key: recordKey,
    connector_id: connectorId,
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
    record_url: `/v1/streams/${stream}/records/${recordKey}`,
    emitted_at: '2026-05-01T00:00:00Z',
    matched_fields: ['body'],
    snippet: { field: 'body', text: 'sem' },
    score: { kind: 'semantic_distance', value: distance, order: 'lower_is_better' },
  };
}

test('hybrid dedup key includes connection_id: two bindings sharing record_key are not collapsed', async () => {
  const deps = {
    runLexical: () => ({ envelope: { data: [
      lexHit({ connectorInstanceId: 'cin_gmail_A', recordKey: 'shared' }),
      lexHit({ connectorInstanceId: 'cin_gmail_B', recordKey: 'shared' }),
    ] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.data.length, 2);
  const cids = out.envelope.data.map((d) => d.connection_id);
  assert.deepEqual(new Set(cids), new Set(['cin_gmail_A', 'cin_gmail_B']));
});

test('hybrid dedup: same connection + same record across both sources collapses to one hit', async () => {
  const deps = {
    runLexical: () => ({ envelope: { data: [
      lexHit({ connectorInstanceId: 'cin_gmail_A', recordKey: 'r1' }),
    ] } }),
    runSemantic: () => ({ envelope: { data: [
      semHit({ connectorInstanceId: 'cin_gmail_A', recordKey: 'r1' }),
    ] } }),
  };
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.data.length, 1);
  const item = out.envelope.data[0];
  assert.equal(item.connection_id, 'cin_gmail_A');
  // Provenance reflects both sources.
  assert.deepEqual(item.retrieval_sources, ['lexical', 'semantic']);
  // matched_fields unioned, lexical-first.
  assert.deepEqual(item.matched_fields, ['subject', 'body']);
  // Both per-source scores forwarded.
  assert.ok(item.scores.lexical);
  assert.ok(item.scores.semantic);
});

test('hybrid forwards connection_id from whichever source emitted first', async () => {
  // Same record_key from each source under DIFFERENT bindings — must
  // produce two hits because dedup key includes connection_id.
  const deps = {
    runLexical: () => ({ envelope: { data: [
      lexHit({ connectorInstanceId: 'cin_A', recordKey: 'r1' }),
    ] } }),
    runSemantic: () => ({ envelope: { data: [
      semHit({ connectorInstanceId: 'cin_B', recordKey: 'r1' }),
    ] } }),
  };
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.data.length, 2);
  const byConn = Object.fromEntries(out.envelope.data.map((d) => [d.connection_id, d]));
  assert.ok(byConn.cin_A);
  assert.ok(byConn.cin_B);
  assert.deepEqual(byConn.cin_A.retrieval_sources, ['lexical']);
  assert.deepEqual(byConn.cin_B.retrieval_sources, ['semantic']);
});

test('hybrid aggregates binding-aware source_skipped_not_applicable warnings from sub-sources', async () => {
  const deps = {
    runLexical: () => ({ envelope: {
      data: [],
      meta: {
        warnings: [{
          code: 'source_skipped_not_applicable',
          message: "Connection 'cin_gmail_B' under connector 'gmail' is not applicable to this query and was skipped.",
          detail: { source: 'gmail', connection_id: 'cin_gmail_B' },
        }],
      },
    } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  const skipped = (out.envelope.meta?.warnings || []).find((w) => w.code === 'source_skipped_not_applicable');
  assert.ok(skipped);
  assert.equal(skipped.detail?.connection_id, 'cin_gmail_B');
});

test('hybrid: legacy single-binding hits (no connection_id) keep using (connector_id, stream, record_key) dedup', async () => {
  // Two pre-identity hits with the same (connector_id, stream, record_key)
  // — one from each source — must still collapse, exactly as v1 behavior.
  const stripId = (h) => {
    const { connection_id, connector_instance_id, ...rest } = h;
    void connection_id;
    void connector_instance_id;
    return rest;
  };
  const deps = {
    runLexical: () => ({ envelope: { data: [stripId(lexHit({ connectorInstanceId: 'unused', recordKey: 'r1' }))] } }),
    runSemantic: () => ({ envelope: { data: [stripId(semHit({ connectorInstanceId: 'unused', recordKey: 'r1' }))] } }),
  };
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.data.length, 1);
});

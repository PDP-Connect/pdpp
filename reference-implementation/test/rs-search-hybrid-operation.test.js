/**
 * Operation-level tests for `rs.search.hybrid`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that the host-independent slice of behavior moved into the operation is
 * preserved:
 *   - the v1 query-param allowlist rejects unknown params and missing `q`;
 *   - `cursor` is rejected explicitly (v1 hybrid does NOT support cursor
 *     pagination);
 *   - the explicit forbidden-parameter list (`vector`, `embedding`,
 *     `model`, `connector_id`, `order`, etc.) returns `invalid_request`
 *     with the rejected `param`;
 *   - `filter[...]` requires exactly one `streams[]` value;
 *   - the operation invokes BOTH lexical and semantic dependencies under
 *     the caller's grant with the parsed sub-request params verbatim;
 *   - errors thrown by either runner propagate unchanged (so
 *     `grant_stream_not_allowed` from semantic surfaces through hybrid);
 *   - per-source result lists are merged in round-robin order with stable
 *     dedup by `(connector_id, stream, record_key)`;
 *   - on overlap, `matched_fields` are unioned (lexical-first), per-source
 *     scores are forwarded verbatim under `scores[source]`, and the first
 *     non-empty snippet is preserved;
 *   - per-source provenance is reported through `retrieval_sources` (subset
 *     of `["lexical", "semantic"]`, lexical-first order);
 *   - every emitted hit carries `retrieval_mode: "hybrid"`;
 *   - the merged list is trimmed to `limit` AFTER dedup (so cross-source
 *     overlap never reduces page size below the requested limit);
 *   - `has_more` honestly reports merged-list truncation and the envelope
 *     never carries `next_cursor`;
 *   - the operation produces the `disclosure.served`-shaped data block with
 *     `query_shape: "search_hybrid"` plus per-source counts.
 *
 * Host-mounted parity is covered by `hybrid-retrieval.test.js` (native).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeSearchHybrid,
  parseSearchHybridParams,
  SearchHybridRequestError,
} from '../operations/rs-search-hybrid/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_owner' };
const clientActor = {
  kind: 'client',
  subject_id: 'subj_client',
  client_id: 'client_x',
  grant_id: 'grant_y',
};

function lexicalHit(overrides = {}) {
  return {
    object: 'search_result',
    stream: 'posts',
    record_key: 'rec_1',
    connector_id: 'acme',
    record_url: '/v1/streams/posts/records/rec_1',
    emitted_at: '2026-04-01T00:00:00Z',
    matched_fields: ['title'],
    snippet: { field: 'title', text: '<mark>overdraft</mark> surprise' },
    score: { kind: 'bm25', value: -1.5, order: 'lower_is_better' },
    ...overrides,
  };
}

function semanticHit(overrides = {}) {
  return {
    object: 'search_result',
    stream: 'posts',
    record_key: 'rec_1',
    connector_id: 'acme',
    record_url: '/v1/streams/posts/records/rec_1',
    emitted_at: '2026-04-01T00:00:00Z',
    matched_fields: ['selftext'],
    retrieval_mode: 'semantic',
    snippet: { field: 'selftext', text: 'overdraft fee' },
    score: { kind: 'semantic_distance', value: 0.05, order: 'lower_is_better' },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const lexicalCalls = [];
  const semanticCalls = [];
  const base = {
    runLexical: (params) => {
      lexicalCalls.push(params);
      return { envelope: { data: [lexicalHit()] } };
    },
    runSemantic: (params) => {
      semanticCalls.push(params);
      return { envelope: { data: [semanticHit({ record_key: 'rec_2' })] } };
    },
  };
  return {
    ...base,
    ...overrides,
    _lexicalCalls: lexicalCalls,
    _semanticCalls: semanticCalls,
  };
}

// ─── Allowlist + cursor rejection + filter coupling + forbidden list ───────

test('parseSearchHybridParams rejects unsupported query parameters', () => {
  assert.throws(
    () => parseSearchHybridParams({ q: 'foo', unknown_param: 'x' }),
    (err) => {
      assert.ok(err instanceof SearchHybridRequestError);
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'unknown_param');
      return true;
    },
  );
});

test('parseSearchHybridParams rejects cursor explicitly (v1 hybrid has no cursor support)', () => {
  // v1 hybrid pagination choice: NO cursor support. Snapshot-honest hybrid
  // cursors require encoding the combined-source snapshot identity; v1
  // rejects the `cursor` parameter rather than ship offset-only pagination
  // over two independently changing candidate sets.
  assert.throws(
    () => parseSearchHybridParams({ q: 'foo', cursor: 'anything' }),
    (err) => {
      assert.ok(err instanceof SearchHybridRequestError);
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'cursor');
      return true;
    },
  );
});

test('parseSearchHybridParams rejects every explicit forbidden parameter with param set', () => {
  // Mirrors the FORBIDDEN_PARAMS list in the operation. Each rejection must
  // carry `param: <key>` so the host-level error envelope can identify the
  // rejected parameter.
  const forbidden = [
    'vector', 'embedding', 'embed',
    'model', 'model_id', 'model_family',
    'rank', 'boost', 'weights', 'blend',
    'connector_id',
    'fields', 'expand', 'expand[]', 'expand_limit', 'expand_limit[]',
    'order', 'sort', 'mode',
  ];
  for (const key of forbidden) {
    assert.throws(
      () => parseSearchHybridParams({ q: 'foo', [key]: 'whatever' }),
      (err) => {
        assert.ok(
          err instanceof SearchHybridRequestError,
          `${key} should throw a typed error`,
        );
        assert.equal(err.code, 'invalid_request', `${key} code`);
        assert.equal(err.param, key, `${key} param`);
        return true;
      },
    );
  }
});

test('parseSearchHybridParams requires q', () => {
  assert.throws(
    () => parseSearchHybridParams({}),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'q');
      return true;
    },
  );
});

test('parseSearchHybridParams clamps and defaults limit', () => {
  assert.equal(parseSearchHybridParams({ q: 'foo' }).limit, 25);
  assert.equal(parseSearchHybridParams({ q: 'foo', limit: '500' }).limit, 100);
  assert.equal(parseSearchHybridParams({ q: 'foo', limit: '0' }).limit, 25);
  assert.equal(parseSearchHybridParams({ q: 'foo', limit: '7' }).limit, 7);
});

test('parseSearchHybridParams normalizes streams (string and array)', () => {
  assert.deepEqual(
    parseSearchHybridParams({ q: 'foo', streams: 'posts' }).streams,
    ['posts'],
  );
  assert.deepEqual(
    parseSearchHybridParams({ q: 'foo', streams: ['posts', 'comments'] }).streams,
    ['posts', 'comments'],
  );
  assert.deepEqual(
    parseSearchHybridParams({ q: 'foo', 'streams[]': 'posts' }).streams,
    ['posts'],
  );
});

test('parseSearchHybridParams requires filter[...] to bind to exactly one streams[]', () => {
  assert.throws(
    () => parseSearchHybridParams({ q: 'foo', filter: { x: 1 } }),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'streams');
      return true;
    },
  );
  // Two streams + filter is also invalid (must be EXACTLY one).
  assert.throws(
    () =>
      parseSearchHybridParams({
        q: 'foo',
        streams: ['posts', 'comments'],
        filter: { x: 1 },
      }),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'streams');
      return true;
    },
  );
  const ok = parseSearchHybridParams({ q: 'foo', streams: 'posts', filter: { x: 1 } });
  assert.deepEqual(ok.streams, ['posts']);
});

// ─── Per-source dependency invocation under the caller's grant ─────────────

test('operation invokes BOTH runners with parsed sub-request params verbatim', async () => {
  const deps = makeDeps();
  await executeSearchHybrid(
    {
      actor: ownerActor,
      query: { q: 'overdraft', limit: '7', 'streams[]': 'posts' },
    },
    deps,
  );
  assert.equal(deps._lexicalCalls.length, 1);
  assert.equal(deps._semanticCalls.length, 1);
  for (const call of [deps._lexicalCalls[0], deps._semanticCalls[0]]) {
    assert.equal(call.q, 'overdraft');
    assert.equal(call.limit, 7);
    assert.deepEqual(call.streams, ['posts']);
    assert.equal(call.filter, null);
  }
});

test('errors from either runner propagate unchanged (e.g. grant_stream_not_allowed from semantic)', async () => {
  // Hybrid is NOT a new grant-logic path; grant enforcement lives in the
  // underlying runners. Errors must surface with their original code so
  // hybrid behaves identically to calling /v1/search/semantic directly.
  const grantErr = Object.assign(new Error("Stream 'forbidden' not in grant"), {
    code: 'grant_stream_not_allowed',
  });
  const deps = makeDeps({
    runSemantic: () => {
      throw grantErr;
    },
  });
  await assert.rejects(
    () =>
      executeSearchHybrid(
        { actor: clientActor, query: { q: 'overdraft', streams: 'forbidden' } },
        deps,
      ),
    (err) => {
      assert.equal(err.code, 'grant_stream_not_allowed');
      return true;
    },
  );
});

// ─── Merge / dedup / matched_fields union / scores forwarding ──────────────

test('overlapping records are deduped; matched_fields and scores are merged across sources', async () => {
  // Both sources surface rec_1; lexical surfaces rec_2; semantic surfaces
  // rec_3. The dedup map must collapse the overlap and forward both source
  // scores under `scores`, with `retrieval_sources` listing both surfaces.
  const deps = makeDeps({
    runLexical: () => ({
      envelope: {
        data: [
          lexicalHit({ record_key: 'rec_1', matched_fields: ['title'] }),
          lexicalHit({ record_key: 'rec_2', matched_fields: ['title'] }),
        ],
      },
    }),
    runSemantic: () => ({
      envelope: {
        data: [
          semanticHit({ record_key: 'rec_1', matched_fields: ['selftext'] }),
          semanticHit({ record_key: 'rec_3', matched_fields: ['selftext'] }),
        ],
      },
    }),
  });
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  // Round-robin merge: lexical[0] (rec_1) → semantic[0] (rec_1 dedup) →
  // lexical[1] (rec_2) → semantic[1] (rec_3). So order is rec_1, rec_2, rec_3.
  assert.deepEqual(
    out.envelope.data.map((h) => h.record_key),
    ['rec_1', 'rec_2', 'rec_3'],
  );
  const rec1 = out.envelope.data[0];
  assert.deepEqual(rec1.retrieval_sources, ['lexical', 'semantic']);
  assert.deepEqual(rec1.matched_fields, ['title', 'selftext']);
  assert.equal(rec1.scores.lexical.kind, 'bm25');
  assert.equal(rec1.scores.semantic.kind, 'semantic_distance');
  // Lexical-only and semantic-only hits keep their single-source provenance
  // and a single-source score map.
  const rec2 = out.envelope.data.find((h) => h.record_key === 'rec_2');
  assert.deepEqual(rec2.retrieval_sources, ['lexical']);
  assert.equal(rec2.scores.lexical.kind, 'bm25');
  assert.equal(rec2.scores.semantic, undefined);
  const rec3 = out.envelope.data.find((h) => h.record_key === 'rec_3');
  assert.deepEqual(rec3.retrieval_sources, ['semantic']);
  assert.equal(rec3.scores.semantic.kind, 'semantic_distance');
  assert.equal(rec3.scores.lexical, undefined);
});

test('matched_fields union deduplicates repeated field names (lexical-first discovery order)', async () => {
  const deps = makeDeps({
    runLexical: () => ({
      envelope: {
        data: [lexicalHit({ matched_fields: ['title', 'selftext'] })],
      },
    }),
    runSemantic: () => ({
      envelope: {
        data: [semanticHit({ matched_fields: ['selftext', 'body'] })],
      },
    }),
  });
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'overdraft' } },
    deps,
  );
  assert.deepEqual(out.envelope.data[0].matched_fields, ['title', 'selftext', 'body']);
});

test('first non-empty snippet is preserved on dedup', async () => {
  const deps = makeDeps({
    runLexical: () => ({
      envelope: {
        data: [lexicalHit({ snippet: { field: 'title', text: '<mark>x</mark>' } })],
      },
    }),
    runSemantic: () => ({
      envelope: {
        data: [semanticHit({ snippet: { field: 'selftext', text: 'verbatim' } })],
      },
    }),
  });
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'x' } },
    deps,
  );
  // Lexical surfaced the record first → its snippet wins.
  assert.deepEqual(out.envelope.data[0].snippet, {
    field: 'title',
    text: '<mark>x</mark>',
  });
});

test('semantic-only hit retains semantic snippet when lexical did not surface the record', async () => {
  const deps = makeDeps({
    runLexical: () => ({ envelope: { data: [] } }),
    runSemantic: () => ({
      envelope: {
        data: [semanticHit({ record_key: 'rec_x', snippet: { field: 'body', text: 'verbatim' } })],
      },
    }),
  });
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'x' } },
    deps,
  );
  assert.equal(out.envelope.data.length, 1);
  assert.deepEqual(out.envelope.data[0].snippet, { field: 'body', text: 'verbatim' });
  assert.deepEqual(out.envelope.data[0].retrieval_sources, ['semantic']);
});

// ─── retrieval_mode is unconditionally "hybrid" ────────────────────────────

test('every emitted hit carries retrieval_mode:"hybrid"', async () => {
  const deps = makeDeps();
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.ok(out.envelope.data.length > 0);
  for (const hit of out.envelope.data) {
    assert.equal(hit.retrieval_mode, 'hybrid');
  }
});

// ─── Limit applied AFTER merge so overlap never shrinks the page ──────────

test('limit is applied after dedup; merged list trims and reports has_more', async () => {
  // Both sources return 3 hits each, with NO overlap → 6 deduped hits. With
  // limit=2 the page shows the first 2 (round-robin: lex[0], sem[0]) and
  // has_more is true.
  const deps = makeDeps({
    runLexical: () => ({
      envelope: {
        data: [
          lexicalHit({ record_key: 'lex_1' }),
          lexicalHit({ record_key: 'lex_2' }),
          lexicalHit({ record_key: 'lex_3' }),
        ],
      },
    }),
    runSemantic: () => ({
      envelope: {
        data: [
          semanticHit({ record_key: 'sem_1' }),
          semanticHit({ record_key: 'sem_2' }),
          semanticHit({ record_key: 'sem_3' }),
        ],
      },
    }),
  });
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo', limit: '2' } },
    deps,
  );
  assert.equal(out.envelope.data.length, 2);
  assert.equal(out.envelope.has_more, true);
  // Round-robin order: lex_1, sem_1.
  assert.deepEqual(
    out.envelope.data.map((h) => h.record_key),
    ['lex_1', 'sem_1'],
  );
});

// ─── No next_cursor in v1 hybrid envelope ─────────────────────────────────

test('envelope never carries next_cursor in v1', async () => {
  const deps = makeDeps({
    runLexical: () => ({
      envelope: {
        data: Array.from({ length: 10 }, (_, i) =>
          lexicalHit({ record_key: `lex_${i}` }),
        ),
      },
    }),
  });
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo', limit: '2' } },
    deps,
  );
  assert.equal('next_cursor' in out.envelope, false);
  assert.equal(out.envelope.has_more, true);
});

// ─── Per-hit score objects are forwarded verbatim under `scores` map ──────

test('per-source scores are forwarded under `scores[source]` and individual hits do NOT emit a top-level `score` field', async () => {
  // Hybrid hits expose per-source scores via a `scores` map keyed by source
  // name; the previous flat `score` field that single-surface endpoints emit
  // does NOT appear on hybrid hits (their score semantics differ across
  // surfaces and a single value would imply a normalization that v1 does
  // NOT perform).
  const deps = makeDeps();
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  for (const hit of out.envelope.data) {
    assert.equal('score' in hit, false, 'hybrid hit must not carry a flat `score` field');
    assert.ok(hit.scores, 'hybrid hit must carry a per-source `scores` map');
    for (const [source, scoreObj] of Object.entries(hit.scores)) {
      assert.ok(
        source === 'lexical' || source === 'semantic',
        'scores map keys must be lexical or semantic',
      );
      assert.equal(typeof scoreObj.kind, 'string');
      assert.equal(typeof scoreObj.value, 'number');
      assert.equal(typeof scoreObj.order, 'string');
    }
  }
});

// ─── Disclosure data block ─────────────────────────────────────────────────

test('disclosure data block carries query_shape:search_hybrid plus per-source counts', async () => {
  const deps = makeDeps({
    runLexical: () => ({
      envelope: {
        data: [
          lexicalHit({ record_key: 'lex_1' }),
          lexicalHit({ record_key: 'lex_2' }),
        ],
      },
    }),
    runSemantic: () => ({
      envelope: {
        data: [semanticHit({ record_key: 'sem_1' })],
      },
    }),
  });
  const out = await executeSearchHybrid(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.deepEqual(out.disclosureData, {
    query_shape: 'search_hybrid',
    record_count: 3,
    has_more: false,
    mode: 'owner',
    lexical_count: 2,
    semantic_count: 1,
  });
});

test('disclosure mode tracks the actor kind (client)', async () => {
  const deps = makeDeps();
  const out = await executeSearchHybrid(
    { actor: clientActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.disclosureData.mode, 'client');
});

// ─── Round-trip: filter[...] bound to a single streams[] flows through ────

test('filter[...] bound to exactly one streams[] is forwarded into both sub-requests', async () => {
  const deps = makeDeps();
  await executeSearchHybrid(
    {
      actor: ownerActor,
      query: { q: 'foo', streams: 'posts', filter: { source_created_at: { gte: 'x' } } },
    },
    deps,
  );
  for (const call of [deps._lexicalCalls[0], deps._semanticCalls[0]]) {
    assert.deepEqual(call.streams, ['posts']);
    assert.deepEqual(call.filter, { source_created_at: { gte: 'x' } });
  }
});

test('a manifest read-authority rejection stops hybrid before semantic dispatch', async () => {
  let semanticCalls = 0;
  const deps = makeDeps({
    runLexical: () => {
      const error = new Error('Stream is not declared by the current manifest');
      error.code = 'stream_not_declared';
      throw error;
    },
    runSemantic: () => {
      semanticCalls += 1;
      assert.fail('semantic vector/delegate path must not run after stale-grant rejection');
    },
  });
  await assert.rejects(
    () => executeSearchHybrid({ actor: clientActor, query: { q: 'old', streams: 'time_entries' } }, deps),
    (error) => error.code === 'stream_not_declared',
  );
  assert.equal(semanticCalls, 0);
});

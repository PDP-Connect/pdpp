/**
 * Operation-level tests for `rs.search.lexical`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that the host-independent slice of behavior moved into the operation is
 * preserved:
 *   - the result envelope flows from the dependency's snapshot;
 *   - the score-advertisement gate controls whether `score` is emitted;
 *   - the cross-stream advertisement gate requires `streams[]` when
 *     `cross_stream: false`;
 *   - the v1 query-param allowlist rejects unknown params and missing `q`;
 *   - `filter[...]` requires exactly one `streams[]` value;
 *   - client-mode `streams[] ⊆ grant.streams` is enforced
 *     (`grant_stream_not_allowed`);
 *   - owner-mode `streams[]` is a soft filter (no error on unknown stream);
 *   - cursor encode/decode round-trips through `loadSnapshot` and the
 *     operation paginates via `next_cursor`;
 *   - malformed and expired cursors raise `invalid_cursor`;
 *   - the operation produces the `disclosure.served`-shaped data block;
 *   - `formatRecordUrl` is invoked for every emitted hit.
 *
 * Host-mounted parity is covered by `lexical-retrieval.test.js` (native)
 * and the sandbox `_demo/routes.test.ts` suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeSearchLexicalCursor,
  executeSearchLexical,
  parseSearchLexicalParams,
  SearchLexicalRequestError,
} from '../operations/rs-search-lexical/index.ts';
import { buildSearchPlanForGrant } from '../server/search.js';

const ownerActor = { kind: 'owner', subject_id: 'subj_owner' };
const clientGrant = {
  source: { kind: 'connector', id: 'acme_payroll' },
  streams: [{ name: 'pay_statements' }, { name: 'time_entries' }],
};
const clientActor = {
  kind: 'client',
  subject_id: 'subj_client',
  client_id: 'client_x',
  grant_id: 'grant_y',
  grant: clientGrant,
};

const defaultAdvertisement = {
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

function makeHit(overrides = {}) {
  return {
    connectorId: 'acme_payroll',
    stream: 'pay_statements',
    recordKey: 'rec_1',
    emittedAt: '2026-04-01T00:00:00Z',
    matchedFields: ['employer'],
    snippet: { field: 'employer', text: '…snippet…' },
    score: -1.5,
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const stored = new Map();
  const base = {
    getAdvertisement: () => defaultAdvertisement,
    listOwnerVisibleConnectorIds: () => ['acme_payroll', 'sherwood_finance'],
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: 'pay_statements' }],
    }),
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    resolveClientManifest: () => ({
      streams: [{ name: 'pay_statements' }, { name: 'time_entries' }],
    }),
    buildSearchPlanForGrant: ({ manifest, streamsFilter }) => {
      const streams = (manifest.streams || [])
        .filter((s) => !streamsFilter || streamsFilter.includes(s.name))
        .map((s) => ({ streamName: s.name, searchableFields: ['employer'] }));
      return streams;
    },
    buildSnapshot: ({ q, perConnectorPlans }) => ({
      snapshot_id: `snap_${q.replace(/[^a-z0-9]/gi, '_')}`,
      query: q,
      // Empty plans ⇒ empty results, mirroring the native FTS behavior so
      // owner-mode soft-filter semantics are exercised honestly.
      results: perConnectorPlans.length === 0
        ? []
        : [makeHit({ recordKey: 'rec_1' }), makeHit({ recordKey: 'rec_2', score: -1.0 })],
    }),
    persistSnapshot: (snapshot) => {
      stored.set(snapshot.snapshot_id, snapshot);
    },
    loadSnapshot: (snapshotId) => stored.get(snapshotId) ?? null,
    formatRecordUrl: ({ stream, recordKey, isOwner }) =>
      isOwner
        ? `/v1/streams/${stream}/records/${recordKey}?owner=1`
        : `/v1/streams/${stream}/records/${recordKey}`,
  };
  return { ...base, ...overrides, _stored: stored };
}

// ─── Allowlist + required q + filter coupling ───────────────────────────

test('parseSearchLexicalParams rejects unsupported query parameters', () => {
  assert.throws(
    () => parseSearchLexicalParams({ q: 'foo', connector_id: 'x' }),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'connector_id');
      return true;
    },
  );
});

test('parseSearchLexicalParams requires q', () => {
  assert.throws(
    () => parseSearchLexicalParams({}),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'q');
      return true;
    },
  );
});

test('parseSearchLexicalParams clamps and defaults limit', () => {
  assert.equal(parseSearchLexicalParams({ q: 'foo' }).limit, 25);
  assert.equal(parseSearchLexicalParams({ q: 'foo', limit: '500' }).limit, 100);
  assert.equal(parseSearchLexicalParams({ q: 'foo', limit: '0' }).limit, 25);
  assert.equal(parseSearchLexicalParams({ q: 'foo', limit: '7' }).limit, 7);
});

test('parseSearchLexicalParams normalizes streams (string and array)', () => {
  const a = parseSearchLexicalParams({ q: 'foo', streams: 'posts' });
  assert.deepEqual(a.streams, ['posts']);
  const b = parseSearchLexicalParams({ q: 'foo', streams: ['posts', 'comments'] });
  assert.deepEqual(b.streams, ['posts', 'comments']);
  // streams[] alias
  const c = parseSearchLexicalParams({ q: 'foo', 'streams[]': 'posts' });
  assert.deepEqual(c.streams, ['posts']);
});

test('parseSearchLexicalParams requires filter[...] to bind to exactly one streams[]', () => {
  assert.throws(
    () => parseSearchLexicalParams({ q: 'foo', filter: { x: 1 } }),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'streams');
      return true;
    },
  );
  // OK: filter + exactly one stream
  const ok = parseSearchLexicalParams({ q: 'foo', streams: 'posts', filter: { x: 1 } });
  assert.equal(ok.filteredStream, 'posts');
});

// ─── Cross-stream advertisement gate ────────────────────────────────────

test('cross_stream:false advertisement requires streams[] in the request', async () => {
  const deps = makeDeps({
    getAdvertisement: () => ({ ...defaultAdvertisement, cross_stream: false }),
  });
  await assert.rejects(
    () => executeSearchLexical({ actor: ownerActor, query: { q: 'foo' } }, deps),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'streams');
      return true;
    },
  );
});

// ─── Client-mode grant enforcement ──────────────────────────────────────

test('client-mode rejects streams[] not in grant', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () =>
      executeSearchLexical(
        { actor: clientActor, query: { q: 'foo', streams: 'comments' } },
        deps,
      ),
    (err) => {
      assert.equal(err.code, 'grant_stream_not_allowed');
      return true;
    },
  );
});

test('client-mode allows streams[] in grant', async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical(
    { actor: clientActor, query: { q: 'foo', streams: 'pay_statements' } },
    deps,
  );
  assert.equal(out.envelope.object, 'list');
  assert.equal(out.disclosureData.mode, 'client');
});

// ─── Owner-mode soft streams[] filter ──────────────────────────────────

test('lexical search emits first-class bounded evidence excerpts', async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical({ actor: clientActor, query: { q: 'foo' } }, deps);
  const first = out.envelope.data[0];

  assert.equal(first.evidence_excerpts?.[0]?.object, 'evidence_excerpt');
  assert.equal(first.evidence_excerpts?.[0]?.field_path, 'employer');
  assert.equal(first.evidence_excerpts?.[0]?.preview_text, '…snippet…');
  assert.equal(first.evidence_excerpts?.[0]?.truncated, true);
  assert.equal(first.evidence_excerpts?.[0]?.provenance, 'lexical_match');
});

test('REST search evidence excerpt carries a bounded field-window read continuation', async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical({ actor: clientActor, query: { q: 'foo' } }, deps);
  const excerpt = out.envelope.data[0]?.evidence_excerpts?.[0];

  // SLVP parity: a REST/CLI client must be able to follow a search excerpt to
  // the full bounded field window without exporting the record — the descriptor
  // is not a dead end. This mirrors the MCP read_record_field continuation.
  const read = excerpt?.read;
  assert.ok(read, 'evidence excerpt must include a read continuation');
  assert.equal(read.object, 'field_window_read');
  assert.equal(read.method, 'GET');
  assert.equal(read.field, excerpt.field_path);
  assert.match(read.route, /^\/v1\/streams\/[^/]+\/records\/[^/]+\/field-window$/);
  assert.equal(typeof read.stream, 'string');
  assert.equal(typeof read.record_id, 'string');
  // The route is self-consistent with the structured stream/record_id.
  assert.equal(
    read.route,
    `/v1/streams/${encodeURIComponent(read.stream)}/records/${encodeURIComponent(read.record_id)}/field-window`,
  );
});

test('owner-mode treats unknown streams[] as a soft filter (no error)', async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', streams: 'totally_unknown_stream' } },
    deps,
  );
  // Plan compilation drops streams not present in the manifest, so the
  // resulting plan list is empty and the operation produces zero hits
  // without raising.
  assert.equal(out.envelope.object, 'list');
  assert.equal(out.envelope.has_more, false);
  assert.equal(out.envelope.data.length, 0);
});

// ─── Score-advertisement gate ───────────────────────────────────────────

test('score is emitted only when capability advertises bm25 lower_is_better', async () => {
  const depsWithScore = makeDeps();
  const out1 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    depsWithScore,
  );
  assert.ok(out1.envelope.data[0].score, 'score should be emitted when advertised');
  assert.equal(out1.envelope.data[0].score.kind, 'bm25');
  assert.equal(out1.envelope.data[0].score.order, 'lower_is_better');

  const depsNoScore = makeDeps({
    getAdvertisement: () => ({
      ...defaultAdvertisement,
      score: { ...defaultAdvertisement.score, supported: false },
    }),
  });
  const out2 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    depsNoScore,
  );
  for (const hit of out2.envelope.data) {
    assert.equal('score' in hit, false, 'score must be omitted when not advertised');
  }
});

test('authoredAt snapshot value is emitted as authored_at', async () => {
  const deps = makeDeps({
    buildSnapshot: () => ({
      snapshot_id: 'snap_authored',
      query: 'foo',
      results: [makeHit({ authoredAt: '2026-04-08T16:57:06.018Z' })],
    }),
  });
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.data[0].authored_at, '2026-04-08T16:57:06.018Z');
});

// ─── formatRecordUrl is called for every hit ───────────────────────────

test('formatRecordUrl decorates every emitted result with isOwner=true for owner actor', async () => {
  const calls = [];
  const deps = makeDeps({
    formatRecordUrl: (args) => {
      calls.push(args);
      return `/test/${args.stream}/${args.recordKey}/${args.isOwner ? 'owner' : 'client'}`;
    },
  });
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(calls.length, out.envelope.data.length);
  for (const call of calls) {
    assert.equal(call.isOwner, true);
  }
  assert.match(out.envelope.data[0].record_url, /\/owner$/);
});

// ─── Cursor round-trip ─────────────────────────────────────────────────

test('cursor round-trip slices the snapshot and rejects malformed/expired cursors', async () => {
  const deps = makeDeps();
  // limit=1 forces pagination across the 2-result snapshot.
  const page1 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '1' } },
    deps,
  );
  assert.equal(page1.envelope.data.length, 1);
  assert.equal(page1.envelope.has_more, true);
  assert.equal(typeof page1.envelope.next_cursor, 'string');

  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '1', cursor: page1.envelope.next_cursor } },
    deps,
  );
  assert.equal(page2.envelope.data.length, 1);
  assert.equal(page2.envelope.has_more, false);
  assert.equal('next_cursor' in page2.envelope, false);
  // Different record on page 2 than page 1.
  assert.notEqual(page2.envelope.data[0].record_key, page1.envelope.data[0].record_key);
});

test('malformed cursor raises invalid_cursor', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () =>
      executeSearchLexical(
        { actor: ownerActor, query: { q: 'foo', cursor: 'not-base64-json' } },
        deps,
      ),
    (err) => {
      assert.equal(err.code, 'invalid_cursor');
      return true;
    },
  );
});

test('expired/unknown snapshot id raises invalid_cursor', async () => {
  const deps = makeDeps();
  // Build a syntactically-valid cursor that points at a snapshot id the
  // store has never seen.
  const cursor = encodeSearchLexicalCursor({ snap: 'snap_does_not_exist', off: 0 });
  await assert.rejects(
    () =>
      executeSearchLexical(
        { actor: ownerActor, query: { q: 'foo', cursor } },
        deps,
      ),
    (err) => {
      assert.equal(err.code, 'invalid_cursor');
      return true;
    },
  );
});

// ─── Disclosure data block ─────────────────────────────────────────────

test('disclosure data block carries query_shape, record_count, has_more, mode, connector_count', async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.deepEqual(out.disclosureData, {
    query_shape: 'search',
    record_count: 2,
    has_more: false,
    mode: 'owner',
    connector_count: 2,
  });
});

// ─── Recall / count disclosure (disclose-lexical-recall-windows) ─────────

// Build deps whose snapshot carries an explicit `recall_meta`, mirroring the
// adapter seam where the FTS builder folds per-source truncation facts into
// the snapshot so cursor pages reuse them verbatim.
function makeRecallDeps(recallMeta, { hits } = {}) {
  const stored = new Map();
  return makeDeps({
    buildSnapshot: ({ q, perConnectorPlans }) => {
      const results = perConnectorPlans.length === 0
        ? []
        : hits ?? [makeHit({ recordKey: 'rec_1' }), makeHit({ recordKey: 'rec_2', score: -1.0 })];
      return {
        snapshot_id: `snap_${q.replace(/[^a-z0-9]/gi, '_')}`,
        query: q,
        results,
        ...(recallMeta ? { recall_meta: recallMeta } : {}),
      };
    },
    persistSnapshot: (snapshot) => {
      stored.set(snapshot.snapshot_id, snapshot);
    },
    loadSnapshot: (snapshotId) => stored.get(snapshotId) ?? null,
  });
}

test('exact complete search emits meta.count exact + recall all_matches', async () => {
  const deps = makeRecallDeps({
    count: 2,
    count_accuracy: 'exact',
    recall: {
      complete: true,
      ranking_scope: 'all_matches',
      truncated: false,
      ranked_candidate_count: 2,
      sources_searched_count: 2,
    },
  });
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.meta.count, 2);
  assert.equal(out.envelope.meta.count_accuracy, 'exact');
  assert.equal(out.envelope.meta.recall.complete, true);
  assert.equal(out.envelope.meta.recall.ranking_scope, 'all_matches');
  assert.equal(out.envelope.meta.recall.truncated, false);
});

test('bounded-window search emits lower_bound count + candidate_window recall with compact facts', async () => {
  const deps = makeRecallDeps({
    count: 200,
    count_accuracy: 'lower_bound',
    recall: {
      complete: false,
      ranking_scope: 'candidate_window',
      truncated: true,
      ranked_candidate_count: 200,
      candidate_window_limit: 200,
      sources_searched_count: 2,
      truncated_source_count: 1,
    },
  });
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.meta.count, 200);
  assert.equal(out.envelope.meta.count_accuracy, 'lower_bound');
  assert.notEqual(out.envelope.meta.count_accuracy, 'exact');
  const recall = out.envelope.meta.recall;
  assert.equal(recall.complete, false);
  assert.equal(recall.ranking_scope, 'candidate_window');
  assert.equal(recall.truncated, true);
  assert.equal(recall.ranked_candidate_count, 200);
  assert.equal(recall.candidate_window_limit, 200);
  assert.ok(recall.truncated_source_count > 0);
});

test('snapshot without recall_meta yields honest not_counted / unknown (no has_more inference)', async () => {
  // A snapshot that omits recall_meta (legacy adapter / pre-upgrade cursor)
  // must NOT be reported as complete just because it fit one page.
  const deps = makeRecallDeps(undefined);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo' } },
    deps,
  );
  assert.equal(out.envelope.has_more, false);
  assert.equal(out.envelope.meta.count, null);
  assert.equal(out.envelope.meta.count_accuracy, 'not_counted');
  assert.equal(out.envelope.meta.recall.complete, false);
  assert.equal(out.envelope.meta.recall.ranking_scope, 'unknown');
  assert.equal(out.envelope.meta.recall.truncated, false);
});

test('has_more:false with a bounded window still reports recall.complete:false on every page', async () => {
  // Pagination completeness (has_more) is distinct from recall completeness.
  // A bounded-window snapshot paginated to its last page (has_more:false) must
  // keep recall.complete:false and recall.truncated:true — identical across
  // pages, because recall is a property of the ranked snapshot, not the page.
  const recallMeta = {
    count: 2,
    count_accuracy: 'lower_bound',
    recall: {
      complete: false,
      ranking_scope: 'candidate_window',
      truncated: true,
      ranked_candidate_count: 2,
      candidate_window_limit: 200,
      sources_searched_count: 1,
      truncated_source_count: 1,
    },
  };
  const deps = makeRecallDeps(recallMeta);
  const page1 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '1' } },
    deps,
  );
  assert.equal(page1.envelope.has_more, true);
  assert.equal(page1.envelope.meta.recall.complete, false);
  assert.equal(page1.envelope.meta.recall.truncated, true);

  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', limit: '1', cursor: page1.envelope.next_cursor } },
    deps,
  );
  // Last page: has_more flips to false, but recall facts are unchanged.
  assert.equal(page2.envelope.has_more, false);
  assert.equal(page2.envelope.meta.recall.complete, false);
  assert.equal(page2.envelope.meta.recall.truncated, true);
  assert.equal(page2.envelope.meta.count_accuracy, 'lower_bound');
  assert.deepEqual(page2.envelope.meta.recall, page1.envelope.meta.recall);
});

test('recall meta coexists with structured warnings in the same meta object', async () => {
  const deps = makeRecallDeps({
    count: 2,
    count_accuracy: 'exact',
    recall: { complete: true, ranking_scope: 'all_matches', truncated: false },
  });
  // The deprecated alias triggers a warning; meta must carry BOTH.
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: 'foo', connector_instance_id: 'ci_x' } },
    deps,
  );
  assert.equal(out.envelope.meta.count_accuracy, 'exact');
  assert.ok(Array.isArray(out.envelope.meta.warnings));
  assert.equal(out.envelope.meta.warnings[0].code, 'deprecated_alias_used');
});

test('a stale grant for a dormant stream rejects before lexical storage/index dependencies', async () => {
  const deps = makeDeps({
    resolveClientManifest: () => ({ streams: [{ name: 'pay_statements' }] }),
    buildSearchPlanForGrant,
    buildSnapshot: () => assert.fail('dormant stream must not reach lexical storage/index snapshot'),
    persistSnapshot: () => assert.fail('dormant stream must not persist a snapshot'),
  });
  await assert.rejects(
    () => executeSearchLexical({ actor: clientActor, query: { q: 'old', streams: 'time_entries' } }, deps),
    (error) => error.code === 'stream_not_declared',
  );
});

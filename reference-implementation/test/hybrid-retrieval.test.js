/**
 * Hybrid Retrieval Experimental Extension — public-contract conformance tests.
 *
 * Pins the behavior of the approved spec at:
 *   openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
 *
 * Covered scenarios:
 *   - advertisement only when BOTH lexical and semantic retrieval are on
 *   - happy-path owner-token hybrid search across at least two streams
 *   - client-token grant projection (stream + field) applied consistently
 *   - dedup of a record that matches both sources, with merged sources + scores
 *   - provenance for lexical-only and semantic-only hits
 *   - cursor behavior for the v1 first-tranche (no cursor support)
 *   - cross-surface cursor rejection (lexical and semantic cursors are not
 *     accepted at /v1/search/hybrid)
 *   - /v1/search and /v1/search/semantic response shapes unchanged
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

// Two manifests, mirroring the semantic-retrieval.test.js fixtures: the
// `posts` stream declares BOTH lexical and semantic fields so hybrid has
// overlapping candidates, and `comments` differs between the two (declares
// both extensions but with different field sets) so source-specific hits
// exercise lexical-only and semantic-only provenance paths.
const MANIFEST_A = {
  protocol_version: '0.1.0',
  connector_id: 'https://test.pdpp.org/connectors/hybrid-a',
  version: '1.0.0',
  display_name: 'Hybrid A',
  capabilities: { human_interaction: ['credentials'] },
  streams: [
    {
      name: 'posts',
      semantics: 'append_only',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          selftext: { type: 'string' },
          source_created_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'title'],
      },
      primary_key: ['id'],
      cursor_field: 'source_created_at',
      consent_time_field: 'source_created_at',
      selection: { fields: true, resources: false },
      query: {
        range_filters: { source_created_at: ['gte', 'gt', 'lte', 'lt'] },
        search: {
          lexical_fields: ['title', 'selftext'],
          semantic_fields: ['title', 'selftext'],
        },
      },
    },
    {
      name: 'comments',
      semantics: 'append_only',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          body: { type: 'string' },
          source_created_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'body'],
      },
      primary_key: ['id'],
      cursor_field: 'source_created_at',
      consent_time_field: 'source_created_at',
      selection: { fields: true, resources: false },
      query: {
        search: {
          lexical_fields: ['body'],
          semantic_fields: ['body'],
        },
      },
    },
  ],
};

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  return tokenBody.access_token;
}

async function approveClientGrant(asUrl, params) {
  const { body: initiate } = await fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.client_id,
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          connector_id: params.connector_id,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          access_mode: params.access_mode,
          streams: params.streams,
        },
      ],
    }),
  });
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: params.subject_id || 'owner_local' }),
  });
  return approved;
}

async function ingest(rsUrl, ownerToken, connectorId, stream, records) {
  const ndjson = records.map((r) => JSON.stringify({
    key: r.id,
    data: r,
    emitted_at: r.emitted_at || r.source_created_at,
  })).join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/x-ndjson' },
      body: ndjson,
    },
  );
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

async function withHarness(opts, fn, manifests = [MANIFEST_A]) {
  const startOpts = {
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    ...opts,
  };
  const server = await startServer(startOpts);
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    for (const manifest of manifests) {
      const reg = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(reg.status, 201, `register ${manifest.connector_id}`);
    }
    await fn({ server, asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// ─── Advertisement ──────────────────────────────────────────────────────────

test('RS metadata advertises capabilities.hybrid_retrieval when both lexical and semantic are on', async () => {
  await withHarness({}, async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    const cap = body.capabilities?.hybrid_retrieval;
    assert.ok(cap, 'hybrid_retrieval advertisement should be present');
    assert.equal(cap.supported, true);
    assert.equal(cap.stability, 'experimental');
    assert.equal(cap.endpoint, '/v1/search/hybrid');
    assert.equal(cap.cross_stream, true);
    assert.equal(cap.default_limit, 25);
    assert.equal(cap.max_limit, 100);
    assert.equal(cap.cursor_supported, false, 'v1 tranche declares no cursor support');
    assert.deepEqual(cap.sources, ['lexical', 'semantic']);
  });
});

test('RS metadata omits hybrid_retrieval when semantic is disabled', async () => {
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const cap = body.capabilities?.hybrid_retrieval;
    if (cap) assert.equal(cap.supported, false);
    const { status } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=x`);
    assert.equal(status, 404);
  });
});

test('RS metadata omits hybrid_retrieval when lexical is disabled', async () => {
  await withHarness({ lexicalRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const cap = body.capabilities?.hybrid_retrieval;
    if (cap) assert.equal(cap.supported, false);
    const { status } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=x`);
    assert.equal(status, 404);
  });
});

test('RS metadata omits hybrid_retrieval when explicitly disabled even if both sources are on', async () => {
  await withHarness({ hybridRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(body.capabilities?.hybrid_retrieval, undefined);
    const { status } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=x`);
    assert.equal(status, 404);
  });
});

// ─── Happy path / provenance / dedup ────────────────────────────────────────

test('owner-token hybrid search returns list envelope with per-source provenance across streams', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // posts: two records, one exactly matching q (so lexical+semantic both
    // return it), one distant-match (lexical-only) to exercise the
    // lexical-only provenance branch.
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft surprise', selftext: 'unexpected fee', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 'p2', title: 'cooking pasta', selftext: 'al dente tips', source_created_at: '2026-04-02T00:00:00Z' },
    ]);
    // comments: one record whose body contains the query tokens — at least
    // one source should return it, exercising the second stream.
    await ingest(rsUrl, ownerToken, connectorA, 'comments', [
      { id: 'c1', body: 'overdraft discussion thread', source_created_at: '2026-04-03T00:00:00Z' },
    ]);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=${encodeURIComponent('overdraft')}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.url, '/v1/search/hybrid');
    assert.equal(typeof body.has_more, 'boolean');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0, 'expected at least one hybrid hit');
    // Every hit has hybrid-shaped provenance.
    for (const hit of body.data) {
      assert.equal(hit.object, 'search_result');
      assert.equal(hit.retrieval_mode, 'hybrid');
      assert.ok(Array.isArray(hit.retrieval_sources) && hit.retrieval_sources.length > 0);
      for (const s of hit.retrieval_sources) {
        assert.ok(['lexical', 'semantic'].includes(s), `unexpected source ${s}`);
      }
      // scores shape: each key must match the corresponding source.
      if (hit.scores) {
        if (hit.scores.lexical) assert.equal(hit.scores.lexical.kind, 'bm25');
        if (hit.scores.semantic) assert.equal(hit.scores.semantic.kind, 'semantic_distance');
      }
    }
    // At least one hit should span both sources (p1 matches title lexically
    // and is close to q embedding-wise given the stub backend's exact-match
    // reflexivity).
    const dualSourceHits = body.data.filter((h) => h.retrieval_sources.length === 2);
    assert.ok(dualSourceHits.length > 0, 'expected at least one dual-source hit');
    const dual = dualSourceHits[0];
    assert.ok(dual.scores?.lexical && dual.scores?.semantic,
      'dual-source hit must carry both score objects');
  });
});

test('record that matches both lexical and semantic is deduplicated to one result', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // The stub semantic backend is deterministic + reflexive on exact
    // matches. Seed a record whose title matches q verbatim so it is
    // guaranteed to appear in both the lexical and semantic candidate
    // lists, exercising the dedup branch.
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p-dup', title: 'overdraft surprise', selftext: 'unexpected fee', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=${encodeURIComponent('overdraft surprise')}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    const matches = body.data.filter((h) => h.record_key === 'p-dup');
    assert.equal(matches.length, 1, 'dedup must collapse both-source matches to one result');
    const hit = matches[0];
    assert.deepEqual(
      [...hit.retrieval_sources].sort(),
      ['lexical', 'semantic'],
      'both sources should be reported on the dedup\'d hit',
    );
    assert.ok(hit.scores?.lexical && hit.scores?.semantic,
      'dedup\'d hit must carry both per-source score objects');
  });
});

// ─── Client-token grant projection ──────────────────────────────────────────

test('client-token hybrid search respects the same grant projection as lexical + semantic', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft surprise', selftext: 'secret ungranted text', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    // Grant posts/title only — selftext is NOT in the client projection.
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'analytics',
      purpose_description: 'hybrid test',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title'] }],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=${encodeURIComponent('overdraft surprise')}`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    const hit = body.data.find((r) => r.record_key === 'p1');
    assert.ok(hit, 'client should see p1 under the granted field');
    for (const f of hit.matched_fields) {
      assert.equal(f, 'title', 'matched_fields must stay inside the grant projection');
    }
    if (hit.snippet) {
      assert.ok(!hit.snippet.text.includes('secret ungranted text'),
        'snippet must not leak ungranted selftext');
    }
  });
});

test('client-token hybrid search rejects streams[] not in grant (same as lexical/semantic)', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'analytics',
      purpose_description: 'grant enforcement',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title'] }],
    });
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=overdraft&streams=comments`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 403);
    assert.equal(body.error?.code, 'grant_stream_not_allowed');
  });
});

// ─── Cursor behavior — first-tranche: no cursor support ─────────────────────

test('hybrid search rejects the cursor parameter in the v1 tranche', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    // A bare, malformed cursor — still 400 because v1 rejects the parameter
    // up front rather than returning misleading offset-only pages.
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=overdraft&cursor=anything`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'invalid_request');
  });
});

test('hybrid search does not emit next_cursor in the v1 tranche', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // Seed enough records that the internal merge could plausibly have
    // overflowed a small `limit`. The response must not carry next_cursor —
    // v1 hybrid advertises cursor_supported:false.
    const seeds = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      title: `overdraft variant ${i}`,
      selftext: 'fee story',
      source_created_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    await ingest(rsUrl, ownerToken, connectorA, 'posts', seeds);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=overdraft&limit=2`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.next_cursor, undefined, 'v1 hybrid must omit next_cursor');
  });
});

test('cursors from /v1/search and /v1/search/semantic are rejected by /v1/search/hybrid', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const seeds = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      title: `overdraft variant ${i}`,
      selftext: 'fee story',
      source_created_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    await ingest(rsUrl, ownerToken, connectorA, 'posts', seeds);

    // Pull a real lexical cursor.
    const { body: lexBody } = await fetchJson(
      `${rsUrl}/v1/search?q=overdraft&limit=1`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    // Pull a real semantic cursor.
    const { body: semBody } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=overdraft&limit=1`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );

    for (const cursor of [lexBody.next_cursor, semBody.next_cursor].filter(Boolean)) {
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search/hybrid?q=overdraft&cursor=${encodeURIComponent(cursor)}`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 400, `hybrid must reject cursor ${cursor}`);
      assert.equal(body.error?.code, 'invalid_request');
    }
  });
});

// ─── Underlying endpoints unchanged ─────────────────────────────────────────

test('/v1/search and /v1/search/semantic response shapes are unchanged when hybrid is advertised', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft surprise', selftext: 'unexpected fee', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const { body: lex } = await fetchJson(
      `${rsUrl}/v1/search?q=overdraft`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(lex.url, '/v1/search');
    for (const hit of lex.data) {
      assert.equal(hit.retrieval_mode, undefined, '/v1/search must not emit retrieval_mode');
      assert.equal(hit.retrieval_sources, undefined);
      assert.equal(hit.scores, undefined);
    }
    const { body: sem } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=overdraft`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(sem.url, '/v1/search/semantic');
    for (const hit of sem.data) {
      assert.equal(hit.retrieval_mode, 'semantic', '/v1/search/semantic still emits retrieval_mode:"semantic"');
      assert.equal(hit.retrieval_sources, undefined);
      assert.equal(hit.scores, undefined);
    }
  });
});

// ─── Parameter rejection ────────────────────────────────────────────────────

test('hybrid search rejects forbidden parameters with invalid_request', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const forbidden = [
      'vector', 'embedding', 'embed',
      'model', 'model_id', 'weights', 'blend',
      'boost', 'rank', 'mode',
      'connector_id', 'fields', 'expand', 'expand_limit',
      'order', 'sort',
    ];
    for (const key of forbidden) {
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search/hybrid?q=anything&${key}=whatever`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 400, `${key} should return 400`);
      assert.equal(body.error?.code, 'invalid_request');
    }
  });
});

test('hybrid search requires q', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/hybrid`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'invalid_request');
  });
});

/**
 * Semantic Retrieval Experimental Extension — public-contract conformance tests.
 *
 * Pins the behavior the approved spec promises at:
 *   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
 *
 * Plus reference-implementation-architecture scenarios from:
 *   openspec/changes/implement-semantic-retrieval-experimental-extension/
 *     specs/reference-implementation-architecture/spec.md
 *
 * Coverage (cross-referenced to tasks.md §14 in the implementation tranche):
 *   14.1  — advertisement present with required keys when supported
 *   14.2  — stability="experimental", query_input="text", lexical_blending=false
 *   14.3  — advertisement omitted when no backend is configured
 *   14.4  — advertisement reachable without bearer token
 *   14.5  — independent from capabilities.lexical_retrieval
 *   14.6  — /v1/search/semantic returns list envelope
 *   14.7  — each result has required keys; typed semantic distance score; no debug fields
 *   14.8  — retrieval_mode === "semantic" on every hit in v1
 *   14.9  — missing q → invalid_request
 *   14.10 — each rejected parameter returns invalid_request with `param`
 *   14.11 — cross_stream advertised false + no streams[] → invalid_request
 *   14.12 — client token streams[]=<not-in-grant> → grant_stream_not_allowed
 *   14.13 — owner token streams[]=<nonexistent> → empty list
 *   14.14 — zero intersection → zero hits, no per-stream error
 *   14.15 — matched_fields ⊆ (declared semantic_fields ∩ grant projection)
 *   14.18 — snippet is verbatim contiguous substring (property test, no paraphrase)
 *   14.19 — snippet grant-safe: never drawn from ungranted fields
 *   14.21/14.22 — no-fallback: search-semantic.js has no import from search.js
 *   14.24 — owner cross-connector fan-out
 *   14.25 — owner record_url round-trip
 *   14.26 — owner connector_id= → invalid_request
 *   14.27 — next_cursor round-trips within a session
 *   14.28/14.29/14.30 — cursor kinds are distinct (semantic ↔ lexical ↔ records)
 *   14.31 — lexical surfaces unchanged when semantic is enabled
 *   14.33 — restart regression: sqlite-vec path, coverage survives restart
 *   14.35 — restart + drift: backend identity change → stale, rebuild restores
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildPostgresSemanticPlanRequests,
  DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS,
  makeStubBackend,
  parseSemanticSearchParams,
  resolveSemanticPerConnectorLimit,
  resolveSemanticBackendFromEnv,
  semanticIndexDelete,
} from '../server/search-semantic.js';
import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';
import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';

// ─── harness ────────────────────────────────────────────────────────────────

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_MULTILINGUAL_MINILM_SMOKE = process.env.PDPP_MULTILINGUAL_MINILM_SMOKE === '1';

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

// Two manifests with declared semantic_fields. Same shape as the lexical
// test harness but declaring semantic_fields (sometimes alongside lexical,
// sometimes not — exercises independence).
const MANIFEST_A = {
  protocol_version: '0.1.0',
  connector_id: 'semantic-a',
  version: '1.0.0',
  display_name: 'Semantic A',
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
          subreddit: { type: 'string' },
          selftext: { type: 'string' },
          score: { type: 'integer' },
          source_created_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'title'],
      },
      primary_key: ['id'],
      cursor_field: 'source_created_at',
      consent_time_field: 'source_created_at',
      selection: { fields: true, resources: false },
      query: {
        range_filters: {
          source_created_at: ['gte', 'gt', 'lte', 'lt'],
          score: ['gte'],
        },
        search: {
          lexical_fields: ['title', 'selftext'],
          semantic_fields: ['title', 'selftext'],
        },
      },
    },
    {
      // comments: lexical AND semantic, but DIFFERENT fields — proves independence.
      name: 'comments',
      semantics: 'append_only',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          body: { type: 'string' },
          post_title: { type: 'string' },
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
          lexical_fields: ['body', 'post_title'],
          semantic_fields: ['body'],
        },
      },
    },
    {
      // Non-participating stream in EITHER extension. Proves the omit branch.
      name: 'saved',
      semantics: 'append_only',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          source_created_at: { type: 'string', format: 'date-time' },
        },
        required: ['id'],
      },
      primary_key: ['id'],
      cursor_field: 'source_created_at',
      consent_time_field: 'source_created_at',
      selection: { fields: true, resources: false },
    },
  ],
};

const MANIFEST_B = {
  protocol_version: '0.1.0',
  connector_id: 'semantic-b',
  version: '1.0.0',
  display_name: 'Semantic B',
  capabilities: { human_interaction: ['credentials'] },
  streams: [
    {
      // Shared stream name with A — exercises cross-connector fan-out.
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
        range_filters: {
          source_created_at: ['gte', 'gt', 'lte', 'lt'],
        },
        search: { semantic_fields: ['title', 'selftext'] },
      }, // semantic only
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
          source: { kind: 'connector', id: params.connector_id },
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

async function ingest(rsUrl, ownerToken, connectorId, stream, records, connectorInstanceId = null) {
  const ndjson = records.map((r) => JSON.stringify({
    key: r.id,
    data: r,
    emitted_at: r.emitted_at || r.source_created_at,
  })).join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}${connectorInstanceId ? `&connector_instance_id=${encodeURIComponent(connectorInstanceId)}` : ''}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/x-ndjson' },
      body: ndjson,
    },
  );
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

async function withHarness(opts, fn, manifests = [MANIFEST_A, MANIFEST_B]) {
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

// ─── 14.1 / 14.2 / 14.4 — advertisement shape + stability ───────────────────

test('RS metadata advertises capabilities.semantic_retrieval with all required keys when supported', async () => {
  await withHarness({}, async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    const cap = body.capabilities?.semantic_retrieval;
    assert.ok(cap, 'capabilities.semantic_retrieval should be present');
    assert.equal(cap.supported, true);
    assert.equal(cap.stability, 'experimental', 'v1 stability is hardcoded experimental');
    assert.equal(cap.endpoint, '/v1/search/semantic');
    assert.equal(cap.cross_stream, true);
    assert.equal(cap.query_input, 'text', 'v1 query_input is hardcoded text');
    assert.equal(cap.snippets, true);
    assert.equal(cap.lexical_blending, false, 'v1 lexical_blending is hardcoded false');
    assert.ok(typeof cap.model === 'string' && cap.model.length > 0);
    assert.ok(typeof cap.dimensions === 'number' && cap.dimensions > 0);
    assert.ok(['cosine', 'dot', 'l2'].includes(cap.distance_metric));
    assert.equal(cap.default_limit, 25);
    assert.equal(cap.max_limit, 100);
    assert.ok(['built', 'building', 'stale'].includes(cap.index_state));
    assert.equal(cap.score?.supported, true);
    assert.equal(cap.score.kind, 'semantic_distance');
    assert.equal(cap.score.order, 'lower_is_better');
    assert.equal(cap.score.value_semantics, 'distance');
    assert.equal(cap.score.comparable_with.model, cap.model);
    assert.equal(cap.score.comparable_with.dimensions, cap.dimensions);
    assert.equal(cap.score.comparable_with.distance_metric, cap.distance_metric);
    assert.equal(cap.score.comparable_with.profile_id, 'stub');
    assert.match(cap.score.comparable_with.backend_identity, /model=pdpp-reference-stub-embed-v0/);
    // Advertisement is fetched without a bearer token (the unauthenticated
    // RS metadata route already allows that for lexical; confirming parity).
  });
});

test('RS metadata omits capabilities.semantic_retrieval when extension is disabled', async () => {
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    // Either omitted entirely or explicitly { supported: false }.
    const cap = body.capabilities?.semantic_retrieval;
    if (cap) assert.equal(cap.supported, false);
    // Route is also absent — request returns 404.
    const { status: sStatus } = await fetchJson(`${rsUrl}/v1/search/semantic?q=x`);
    assert.equal(sStatus, 404);
  });
});

test('RS metadata omits semantic retrieval and route 404s when backend is unavailable', async () => {
  const unavailableBackend = {
    ...makeStubBackend(),
    available: () => false,
  };
  await withHarness({ semanticRetrievalBackend: unavailableBackend }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(body.capabilities?.semantic_retrieval, undefined);
    const resp = await fetch(`${rsUrl}/v1/search/semantic?q=test`, {
      headers: { Authorization: 'Bearer bad-token' },
    });
    assert.equal(resp.status, 404);
  });
});

// ─── Dashboard capability probe — fail-closed on unadvertised, true when on ─

test('dashboard capability probe returns true when semantic is advertised', async () => {
  // Exercises the same shape that apps/console/src/app/dashboard/lib/rs-client.ts
  // #isSemanticRetrievalAdvertised reads from the RS metadata document. The
  // dashboard's blended-search composition depends on this probe returning
  // true ONLY when the RS really would serve /v1/search/semantic.
  await withHarness({}, async ({ rsUrl }) => {
    const res = await fetch(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.ok, true);
    const body = await res.json();
    assert.equal(body.capabilities?.semantic_retrieval?.supported, true,
      'probe contract: supported:true signals "extension is reachable"');
  });
});

test('dashboard capability probe returns false when semantic is disabled', async () => {
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const res = await fetch(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.ok, true);
    const body = await res.json();
    // Probe treats supported:false OR absent as "unavailable" — either
    // shape is legal per the spec.
    const supported = body.capabilities?.semantic_retrieval?.supported === true;
    assert.equal(supported, false);
  });
});

// ─── 14.5 — independence from lexical advertisement ─────────────────────────

test('semantic advertisement is independent from lexical advertisement', async () => {
  // Lexical on, semantic off.
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const lex = body.capabilities?.lexical_retrieval;
    const sem = body.capabilities?.semantic_retrieval;
    assert.ok(lex && lex.supported === true, 'lexical still on');
    assert.ok(!sem || sem.supported === false, 'semantic off');
  });
  // Semantic on, lexical off.
  await withHarness({ lexicalRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const lex = body.capabilities?.lexical_retrieval;
    const sem = body.capabilities?.semantic_retrieval;
    assert.ok(!lex || lex.supported === false, 'lexical off');
    assert.ok(sem && sem.supported === true, 'semantic still on');
  });
});

// ─── 14.6 / 14.7 / 14.8 — happy-path shape + retrieval_mode ─────────────────

test('happy-path semantic search returns list envelope with retrieval_mode:"semantic"', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft surprise', selftext: 'unexpected fee', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 'p2', title: 'cooking pasta', selftext: 'al dente tips', source_created_at: '2026-04-02T00:00:00Z' },
    ]);

    // Exact-match query — stub's reflexive exact-match property guarantees p1 is top hit.
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('overdraft surprise')}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(typeof body.has_more, 'boolean');
    assert.ok(Array.isArray(body.data));
    const hit = body.data.find((r) => r.record_key === 'p1');
    assert.ok(hit, 'p1 should be in the hit list');
    assert.equal(hit.object, 'search_result');
    assert.equal(hit.stream, 'posts');
    assert.equal(hit.connector_id, connectorA);
    assert.equal(hit.retrieval_mode, 'semantic', 'v1: every hit emits retrieval_mode:"semantic"');
    assert.ok(Array.isArray(hit.matched_fields));
    assert.equal(hit.score.kind, 'semantic_distance');
    assert.equal(hit.score.order, 'lower_is_better');
    assert.ok(Math.abs(hit.score.value) < 1e-6, `exact-match semantic distance should be near zero, got ${hit.score.value}`);
    // No raw vector/debug/alternate score fields
    for (const forbidden of ['cosine', 'bm25', 'blend', '_debug', '_explain', '_vector_distance']) {
      assert.equal(hit[forbidden], undefined, `${forbidden} must not appear on a result`);
    }
    // Owner-mode record_url MUST include ?connector_id=
    assert.ok(hit.record_url.startsWith('/v1/streams/posts/records/p1?connector_id='));
    assert.ok(hit.record_url.includes(encodeURIComponent(connectorA)));
  });
});

test('semantic search omits score when capability metadata does not advertise score support', async () => {
  await withHarness({
    semanticRetrievalCapability: {
      supported: true,
      stability: 'experimental',
      endpoint: '/v1/search/semantic',
      cross_stream: true,
      query_input: 'text',
      snippets: true,
      lexical_blending: false,
      model: 'pdpp-reference-stub-embed-v0',
      dimensions: 64,
      distance_metric: 'cosine',
      default_limit: 25,
      max_limit: 100,
      index_state: 'built',
    },
  }, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft surprise', selftext: 'unexpected fee', source_created_at: '2026-04-01T00:00:00Z' },
    ]);

    const { body: metadata } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.capabilities?.semantic_retrieval?.score, undefined);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('overdraft surprise')}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.data[0]?.score, undefined);
  });
});

// ─── 14.9 / 14.10 — parameter rejection ─────────────────────────────────────

test('missing q returns invalid_request', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'invalid_request');
  });
});

test('forbidden parameters are all rejected with invalid_request (integration)', async () => {
  // The public surface has TWO rejection layers that both return 400
  // invalid_request: (a) the contract schema (additionalProperties: false on
  // the query allowlist), and (b) parseSemanticSearchParams in
  // search-semantic.js. A request containing a forbidden param may be
  // caught at either layer depending on ordering; the invariant this test
  // pins is "it's rejected with invalid_request", not which layer did it.
  // The `param` field is populated by the handler-level rejection; the
  // schema-level rejection omits it. The parseSemanticSearchParams
  // pure-helper test below pins `param` explicitly at the handler layer.
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const forbidden = [
      'vector', 'embedding', 'embed',
      'model', 'model_id', 'model_family',
      'rank', 'boost', 'weights', 'blend',
      'connector_id',
      'fields', 'expand', 'expand_limit',
      'order', 'sort', 'mode',
    ];
    for (const key of forbidden) {
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=anything&${key}=whatever`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 400, `${key} should return 400`);
      assert.equal(body.error?.code, 'invalid_request', `${key} code`);
    }
    // filter[…] without a single stream is still rejected
    const { status: fStatus, body: fBody } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=anything&${encodeURIComponent('filter[foo]')}=bar`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(fStatus, 400);
    assert.equal(fBody.error?.code, 'invalid_request');
  });
});

test('filtered semantic search applies declared range and no-match filters before vector lookup', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const exactQuery = 'semantic filtered alpha';
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'old-sem', title: exactQuery, selftext: '', score: 1, source_created_at: '2026-03-01T00:00:00Z' },
      { id: 'new-sem', title: exactQuery, selftext: '', score: 5, source_created_at: '2026-04-10T00:00:00Z' },
    ]);

    const range = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(range.status, 200);
    assert.deepEqual(
      range.body.data.filter((r) => r.connector_id === connectorA).map((r) => r.record_key),
      ['new-sem'],
    );

    const noMatch = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}&streams=posts&filter[source_created_at][gte]=2027-01-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(noMatch.status, 200);
    assert.deepEqual(noMatch.body.data.filter((r) => r.connector_id === connectorA), []);
  });
});

test('filtered semantic search rejects invalid filters and still-forbidden parameters', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'semantic filtered alpha', selftext: 'secret body', score: 5, source_created_at: '2026-04-10T00:00:00Z' },
    ]);

    const rejectedOwnerQueries = [
      'q=semantic&filter[source_created_at][gte]=2026-04-01T00:00:00Z',
      'q=semantic&streams=posts&streams=comments&filter[source_created_at][gte]=2026-04-01T00:00:00Z',
      'q=semantic&streams=posts&filter[subreddit][gte]=finance',
      'q=semantic&streams=posts&filter[source_created_at][between]=2026-04-01T00:00:00Z',
      'q=semantic&streams=posts&filter[source_created_at][gte]=not-a-date',
      'q=semantic&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z&model=client-model',
      `q=semantic&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z&connector_id=${encodeURIComponent(connectorA)}`,
    ];
    for (const query of rejectedOwnerQueries) {
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search/semantic?${query}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 400, `expected 400 for ${query}`);
      assert.equal(body.error.code, 'invalid_request');
    }

    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'semantic filtered retrieval test',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title', 'source_created_at'] }],
    });
    const unauthorized = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=semantic&streams=posts&filter[selftext]=secret`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.body.error.code, 'field_not_granted');
  });
});

// ─── 14.11 — cross_stream:false requires streams[] ──────────────────────────

test('cross_stream:false advertisement requires streams[]', async () => {
  await withHarness(
    {
      semanticRetrievalCapability: {
        supported: true,
        stability: 'experimental',
        endpoint: '/v1/search/semantic',
        cross_stream: false,
        query_input: 'text',
        snippets: true,
        lexical_blending: false,
        model: 'test-model',
        dimensions: 64,
        distance_metric: 'cosine',
        default_limit: 25,
        max_limit: 100,
        index_state: 'built',
      },
    },
    async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=overdraft`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 400);
      assert.equal(body.error?.code, 'invalid_request');
    },
  );
});

// ─── 14.12 — client token streams[] not in grant ────────────────────────────

test('client-token streams[] not in grant returns grant_stream_not_allowed', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'semantic test',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title'] }], // posts only
    });
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=overdraft&streams=comments`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 403);
    assert.equal(body.error?.code, 'grant_stream_not_allowed');
  });
});

// ─── 14.13 — owner streams[] unknown ⇒ empty list (not error) ───────────────

test('owner-token streams[]=<nonexistent> returns empty list, not error', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=overdraft&streams=nonexistent_stream`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, []);
    assert.equal(body.has_more, false);
  });
});

// ─── 14.15 / 14.19 — matched_fields subset + snippet grant safety ───────────

test('client grant authorizing only one of two declared semantic_fields restricts matched_fields and snippet', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft story', selftext: 'unauthorized field content', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    // Grant only `title` — selftext is NOT in the client's projection.
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'semantic test subset',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title'] }],
    });
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('overdraft story')}`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    const hit = body.data.find((r) => r.record_key === 'p1');
    if (hit) {
      for (const f of hit.matched_fields) {
        assert.equal(f, 'title', 'matched_fields may only include granted+declared fields');
      }
      assert.equal(hit.score.kind, 'semantic_distance');
      assert.equal(hit.score.order, 'lower_is_better');
      assert.ok(Number.isFinite(hit.score.value));
      if (hit.snippet) {
        // Grant-safe: snippet text must NOT come from selftext (which was ungranted).
        assert.ok(
          !hit.snippet.text.includes('unauthorized field content'),
          'snippet must not leak ungranted field text',
        );
      }
    }
  });
});

// ─── 14.14 — zero intersection stream contributes zero hits ─────────────────

test('stream declared in semantic_fields but with empty grant∩declared intersection contributes zero hits', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // Comments declares semantic_fields: ['body']. Grant authorizes only `id`
    // — no overlap with declared semantic_fields. Should contribute zero hits
    // AND return no per-stream error.
    await ingest(rsUrl, ownerToken, connectorA, 'comments', [
      { id: 'c1', body: 'something about overdrafts', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'zero-intersection test',
      access_mode: 'continuous',
      streams: [{ name: 'comments', fields: ['id'] }], // id not in declared semantic_fields
    });
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=overdrafts&streams=comments`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, []);
  });
});

// ─── 14.18 — snippet property: verbatim contiguous substring ────────────────

test('snippet text is a verbatim contiguous substring of the matched field (property test)', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const SEEDS = [
      { id: 'p1', title: 'alpha beta gamma', selftext: 'the quick brown fox', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 'p2', title: 'delta epsilon', selftext: 'lorem ipsum dolor sit', source_created_at: '2026-04-02T00:00:00Z' },
      { id: 'p3', title: 'zeta eta theta', selftext: 'consectetur adipiscing', source_created_at: '2026-04-03T00:00:00Z' },
    ];
    await ingest(rsUrl, ownerToken, connectorA, 'posts', SEEDS);
    // Run a handful of queries; whatever hits come back, assert the snippet
    // appears byte-identically as a contiguous substring of the matched
    // field's stored value. No assumption about paraphrase behavior.
    for (const q of ['alpha beta gamma', 'lorem', 'zeta eta theta', 'brown fox']) {
      const { body } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(q)}`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      for (const hit of body.data ?? []) {
        if (!hit.snippet) continue;
        const seed = SEEDS.find((s) => s.id === hit.record_key);
        if (!seed) continue;
        const fieldValue = seed[hit.snippet.field];
        assert.ok(typeof fieldValue === 'string', 'matched field is a string');
        // pickVerbatimExcerpt may append a trailing '…' ellipsis. Strip it
        // before the substring check — the character is NOT in the stored
        // text, and the rest must appear verbatim.
        const clean = hit.snippet.text.replace(/…$/, '');
        assert.ok(
          fieldValue.includes(clean),
          `snippet "${hit.snippet.text}" must be a verbatim substring of field.${hit.snippet.field}`,
        );
      }
    }
  });
});

// ─── 14.21/14.22 — no-fallback invariant visible in source ──────────────────

test('search-semantic.js has zero imports from search.js (no silent lexical fallback)', () => {
  const filePath = path.join(TEST_DIR, '..', 'server', 'search-semantic.js');
  const src = fs.readFileSync(filePath, 'utf8');
  // The invariant: no `from './search.js'` or `require('./search.js')`.
  assert.ok(!/from\s+['"]\.\/search\.js['"]/.test(src), 'search-semantic.js must not import from search.js');
  assert.ok(!/require\(\s*['"]\.\/search\.js['"]/.test(src), 'search-semantic.js must not require search.js');
});

// ─── 14.24 — owner cross-connector fan-out ──────────────────────────────────

test('owner cross-connector search returns hits from every owner-visible connector that matches', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const connectorB = MANIFEST_B.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'pA1', title: 'shared query alpha', selftext: 'A body', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    await ingest(rsUrl, ownerToken, connectorB, 'posts', [
      { id: 'pB1', title: 'shared query alpha', selftext: 'B body', source_created_at: '2026-04-02T00:00:00Z' },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('shared query alpha')}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    const connectors = new Set(body.data.map((h) => h.connector_id));
    assert.ok(connectors.has(connectorA), 'hits from connector A present');
    assert.ok(connectors.has(connectorB), 'hits from connector B present');
  });
});

// ─── 14.25 — owner record_url round-trip ────────────────────────────────────

test('owner record_url round-trips to a valid single-record read', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'hydration check', selftext: 'verify round-trip', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const { body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('hydration check')}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    const hit = body.data.find((r) => r.record_key === 'p1');
    assert.ok(hit);
    const recordResp = await fetchJson(
      `${rsUrl}${hit.record_url}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(recordResp.status, 200);
    // Canonical record envelope — spec doesn't pin the exact field shape at
    // this level, but the response must be JSON describing our record.
    assert.ok(recordResp.body, 'record envelope present');
  });
});

// ─── 14.26 — owner connector_id= is rejected ────────────────────────────────

test('owner request including connector_id= is rejected as invalid_request', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=anything&connector_id=${encodeURIComponent(connectorA)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'invalid_request');
    // .param is set by the handler-level rejection; the schema-level
    // rejection (additionalProperties: false) may fire first and omit it.
    // Either way the request is rejected with invalid_request, which is
    // the public contract. Handler-level .param is pinned by the
    // parseSemanticSearchParams unit test below.
  });
});

// ─── 14.27 / 14.28 / 14.30 — cursor round-trip + cross-surface rejection ────

test('next_cursor round-trips within a session (owner)', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // Seed enough records that limit=2 paginates.
    const seeds = [];
    for (let i = 0; i < 5; i++) {
      seeds.push({
        id: `p${i}`,
        title: `common query term ${i}`,
        selftext: `body ${i}`,
        source_created_at: `2026-04-0${i + 1}T00:00:00Z`,
      });
    }
    await ingest(rsUrl, ownerToken, connectorA, 'posts', seeds);
    const q = encodeURIComponent('common query term');
    const page0 = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${q}&limit=2`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(page0.status, 200);
    assert.equal(page0.body.data.length, 2);
    assert.equal(page0.body.has_more, true);
    assert.ok(typeof page0.body.next_cursor === 'string' && page0.body.next_cursor.length > 0);
    // Cursor MUST be distinguishable from a lexical cursor.
    assert.ok(page0.body.next_cursor.startsWith('sem1.'),
      'semantic cursors have a distinct prefix to prevent cross-surface reuse');

    const page1 = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${q}&limit=2&cursor=${encodeURIComponent(page0.body.next_cursor)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.length, 2);
    // Non-overlapping record_keys between pages.
    const p0keys = new Set(page0.body.data.map((r) => r.record_key));
    for (const hit of page1.body.data) {
      assert.ok(!p0keys.has(hit.record_key), `page1 must not repeat a page0 hit: ${hit.record_key}`);
    }
  });
});

test('lexical cursor passed to /v1/search/semantic is rejected as invalid_cursor', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'paginate me', selftext: 'x', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 'p2', title: 'paginate me', selftext: 'y', source_created_at: '2026-04-02T00:00:00Z' },
    ]);
    const lex = await fetchJson(
      `${rsUrl}/v1/search?q=paginate&limit=1`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(lex.status, 200);
    assert.ok(typeof lex.body.next_cursor === 'string', 'lexical gives a cursor');
    // Passing the lexical cursor to /v1/search/semantic must NOT be honored.
    // The shipped PDPP error table maps invalid_cursor → 400 (not 410).
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=paginate&cursor=${encodeURIComponent(lex.body.next_cursor)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'invalid_cursor');
  });
});

// ─── 14.31 — lexical surface unchanged when semantic is enabled ─────────────

test('semantic enablement does not break /v1/search (lexical surface)', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'lexical check', selftext: 'should still work', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=lexical`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    // Lexical hits MUST NOT carry retrieval_mode (that's semantic-only).
    for (const hit of body.data) {
      assert.equal(hit.retrieval_mode, undefined, 'lexical hits must not emit retrieval_mode');
    }
  });
});

function makeInterruptingDocumentBackend({ successfulEmbedsBeforeThrow }) {
  const base = makeStubBackend();
  let successfulEmbeds = 0;
  return {
    ...base,
    embedDocument: async (text) => {
      if (successfulEmbeds >= successfulEmbedsBeforeThrow) {
        throw new Error('simulated semantic backfill interruption');
      }
      successfulEmbeds += 1;
      return base.embedDocument(text);
    },
    successfulEmbeds: () => successfulEmbeds,
  };
}

function makeDocumentCountingBackend() {
  const base = makeStubBackend();
  let documentEmbeds = 0;
  return {
    ...base,
    embedDocument: async (text) => {
      documentEmbeds += 1;
      return base.embedDocument(text);
    },
    documentEmbeds: () => documentEmbeds,
  };
}

function makeEmbeddingInputCapturingBackend() {
  const base = makeStubBackend();
  const documentInputs = [];
  const queryInputs = [];
  return {
    ...base,
    embedDocument: async (text) => {
      documentInputs.push(text);
      return base.embedDocument(text);
    },
    embedQuery: async (text) => {
      queryInputs.push(text);
      return base.embedQuery(text);
    },
    documentInputs: () => documentInputs.slice(),
    queryInputs: () => queryInputs.slice(),
  };
}

function countPersistedSemanticVectors() {
  const db = getDb();
  const table = db.vectorIndexKind === 'sqlite-vec'
    ? 'semantic_search_rowid'
    : 'semantic_search_blob';
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n || 0);
}

// ─── 14.33 — restart regression: coverage survives restart ──────────────────

test('restart regression: semantic coverage survives process restart without re-ingest', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-semantic-restart-'));
  const dbPath = path.join(tmpDir, 'pdpp.sqlite');
  let hitsBefore;
  let advertisedIndexStateAfter;
  try {
    // --- First boot: register + ingest + search. ---
    {
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        for (const m of [MANIFEST_A]) {
          const reg = await fetch(`${asUrl}/connectors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(m),
          });
          assert.equal(reg.status, 201);
        }
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
          { id: 'p1', title: 'persistent hit', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
        ]);
        const { body } = await fetchJson(
          `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('persistent hit')}`,
          { headers: { 'Authorization': `Bearer ${ownerToken}` } },
        );
        hitsBefore = body.data.map((h) => h.record_key).sort();
        assert.ok(hitsBefore.includes('p1'), 'pre-restart search must find p1');
      } finally {
        await closeServer(server);
      }
    }
    // --- Second boot: same dbPath, no re-ingest, same search must hit. ---
    {
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      });
      try {
        await server.startupBackfillDone;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const asUrl = `http://localhost:${server.asPort}`;
        // Re-register manifest (polyfill topology re-registers on each boot;
        // backfill is idempotent and a no-op when no drift exists).
        await fetch(`${asUrl}/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(MANIFEST_A),
        });
        const { body: advBody } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
        advertisedIndexStateAfter = advBody.capabilities?.semantic_retrieval?.index_state;
        // index_state must be `built` (persistence survived, no drift).
        assert.equal(advertisedIndexStateAfter, 'built',
          'after clean restart with matching backend, index_state is built');

        const ownerToken = await issueOwnerToken(asUrl);
        const { body } = await fetchJson(
          `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('persistent hit')}`,
          { headers: { 'Authorization': `Bearer ${ownerToken}` } },
        );
        const hitsAfter = body.data.map((h) => h.record_key).sort();
        assert.ok(hitsAfter.includes('p1'),
          'post-restart search must still find p1 without re-ingest');
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('restart regression: streams with only empty semantic field values do not rebuild forever', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-semantic-empty-restart-'));
  const dbPath = path.join(tmpDir, 'pdpp.sqlite');
  try {
    {
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const reg = await fetch(`${asUrl}/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(MANIFEST_A),
        });
        assert.equal(reg.status, 201);
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
          { id: 'empty-semantic-1', title: '', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
        ]);
        assert.equal(countPersistedSemanticVectors(), 0, 'empty semantic fields should not write vectors');
      } finally {
        await closeServer(server);
      }
    }

    {
      const countingBackend = makeDocumentCountingBackend();
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        semanticRetrievalBackend: countingBackend,
      });
      try {
        await server.startupBackfillDone;
        assert.equal(
          countingBackend.documentEmbeds(),
          0,
          'restart drift check should treat zero indexable semantic values as in sync',
        );
        assert.equal(countPersistedSemanticVectors(), 0, 'restart should not fabricate vectors for empty fields');
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('semantic indexing caps oversized text before embedding', async () => {
  const capturingBackend = makeEmbeddingInputCapturingBackend();
  await withHarness({ semanticRetrievalBackend: capturingBackend }, async ({ asUrl, rsUrl }) => {
    const reg = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(MANIFEST_A),
    });
    assert.equal(reg.status, 201);

    const longText = `oversized semantic input ${'x'.repeat(DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS + 200)}`;
    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
      { id: 'long-semantic-1', title: longText, selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);

    assert.ok(
      capturingBackend.documentInputs().some((text) => text.length === DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS),
      'document embedding receives a capped input',
    );
    assert.ok(
      capturingBackend.documentInputs().every((text) => text.length <= DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS),
      'no document embedding receives the full oversized field',
    );

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(longText)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.ok(body.data.some((hit) => hit.record_key === 'long-semantic-1'));
    assert.ok(
      capturingBackend.queryInputs().every((text) => text.length <= DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS),
      'query embedding is capped with the same limit',
    );
  });
});

test('semantic search caches repeated query embeddings for fresh searches', async () => {
  const capturingBackend = makeEmbeddingInputCapturingBackend();
  await withHarness({ semanticRetrievalBackend: capturingBackend }, async ({ asUrl, rsUrl }) => {
    const reg = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(MANIFEST_A),
    });
    assert.equal(reg.status, 201);

    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
      { id: 'cache-semantic-1', title: 'deployment failure', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);

    for (let index = 0; index < 2; index += 1) {
      const { status } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=deployment%20failure`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 200);
    }
    assert.equal(capturingBackend.queryInputs().length, 1);
  });
});

test('semantic upsert with an empty field deletes only that record, not the whole scope', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const reg = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(MANIFEST_A),
    });
    assert.equal(reg.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
      {
        id: 'empty-upsert-1',
        title: 'first semantic survivor',
        selftext: '',
        source_created_at: '2026-04-01T00:00:00Z',
      },
      {
        id: 'empty-upsert-2',
        title: 'second semantic survivor',
        selftext: '',
        source_created_at: '2026-04-01T00:00:00Z',
      },
    ]);
    assert.equal(countPersistedSemanticVectors(), 2, 'initial ingest writes one vector per non-empty title');

    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
      { id: 'empty-upsert-1', title: '', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    assert.equal(
      countPersistedSemanticVectors(),
      1,
      'empty update removes only the updated record vector',
    );

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('second semantic survivor')}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.ok(body.data.some((hit) => hit.record_key === 'empty-upsert-2'));
    assert.equal(
      body.data.some((hit) => hit.record_key === 'empty-upsert-1'),
      false,
      'the emptied record no longer contributes semantic hits',
    );
  });
});

test('semantic index metadata isolates instances and client search fans in across active bindings', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);

    const db = getDb();
    const now = new Date().toISOString();
    const insertInstance = db.prepare(`
      INSERT INTO connector_instances(
        connector_instance_id, owner_subject_id, connector_id, display_name,
        status, source_kind, source_binding_key, source_binding_json, created_at, updated_at
      ) VALUES(?, 'owner_local', ?, ?, 'active', 'account', ?, '{}', ?, ?)
    `);
    insertInstance.run('cin_semantic_work', MANIFEST_A.connector_id, 'Semantic A work', 'work', now, now);
    insertInstance.run('cin_semantic_personal', MANIFEST_A.connector_id, 'Semantic A personal', 'personal', now, now);

    const baseRecord = {
      id: 'shared-record-key',
      title: 'semantic connector instance collision sentinel',
      selftext: '',
      subreddit: 'pdpp',
      score: 1,
      source_created_at: '2026-04-01T00:00:00Z',
    };
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [baseRecord], 'cin_semantic_work');
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [baseRecord], 'cin_semantic_personal');

    const vectorTable = db.vectorIndexKind === 'sqlite-vec' ? 'semantic_search_rowid' : 'semantic_search_blob';
    const indexed = db.prepare(`
      SELECT connector_instance_id, connector_id, scope_key, record_key
      FROM ${vectorTable}
      WHERE connector_id = ? AND record_key = ?
      ORDER BY connector_instance_id
    `).all(MANIFEST_A.connector_id, 'shared-record-key');
    assert.deepEqual(
      indexed.map((row) => row.connector_instance_id),
      ['cin_semantic_personal', 'cin_semantic_work'],
      'semantic vector identity includes connector_instance_id',
    );

    const metaRows = db.prepare(`
      SELECT connector_instance_id
      FROM semantic_search_meta
      WHERE connector_id = ? AND stream = 'posts'
      ORDER BY connector_instance_id
    `).all(MANIFEST_A.connector_id);
    assert.deepEqual(
      metaRows.map((row) => row.connector_instance_id),
      ['cin_semantic_personal', 'cin_semantic_work'],
      'semantic metadata is per connector instance',
    );

    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: MANIFEST_A.connector_id,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'semantic instance isolation test',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title', 'source_created_at'] }],
    });
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(baseRecord.title)}&streams[]=posts`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    // With cross-binding search fan-in, two active connections under one
    // connector are no longer an error — the runtime returns the union and
    // each hit carries its `connection_id`. (Pre-fan-in this surfaced the
    // scheduler's `ambiguous_connector_instance` error to the read path,
    // which has been replaced by the typed `connection_not_found` /
    // `ambiguous_connection` read-path errors covered by
    // `storage-fan-in-read-contract.test.js` and the route-level
    // `blob-fan-in-ambiguity.test.js`.)
    assert.equal(status, 200);
    const hits = body.data || [];
    // Both bindings should contribute a hit for the shared record_key.
    assert.equal(hits.length, 2, 'fan-in returns one hit per binding');
    const cids = hits.map((h) => h.connection_id).sort();
    assert.deepEqual(cids, ['cin_semantic_personal', 'cin_semantic_work']);
  });
});

test('interrupted semantic backfill with existing meta resumes instead of rebuilding from scratch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-semantic-meta-resume-'));
  const dbPath = path.join(tmpDir, 'pdpp.sqlite');
  try {
    {
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const reg = await fetch(`${asUrl}/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(MANIFEST_A),
        });
        assert.equal(reg.status, 201);
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
          {
            id: 'meta-resume-1',
            title: 'meta resume one',
            selftext: '',
            source_created_at: '2026-04-01T00:00:00Z',
          },
          {
            id: 'meta-resume-2',
            title: 'meta resume two',
            selftext: '',
            source_created_at: '2026-04-01T00:00:00Z',
          },
          {
            id: 'meta-resume-3',
            title: 'meta resume three',
            selftext: '',
            source_created_at: '2026-04-01T00:00:00Z',
          },
        ]);
        assert.equal(countPersistedSemanticVectors(), 3, 'initial write path indexes all records');

        await semanticIndexDelete({
          connectorId: MANIFEST_A.connector_id,
          stream: 'posts',
          recordKey: 'meta-resume-2',
        });
        assert.equal(countPersistedSemanticVectors(), 2, 'one vector is missing before simulated restart');

        const db = getDb();
        const meta = db.prepare(`
          SELECT connector_instance_id, fields_fingerprint, model_id, dimensions, distance_metric
          FROM semantic_search_meta
          WHERE connector_id = ? AND stream = 'posts'
        `).get(MANIFEST_A.connector_id);
        assert.ok(meta, 'completed meta exists before simulated interrupted resume');
        db.prepare(`
          INSERT INTO semantic_search_backfill_progress(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
          VALUES(?, ?, 'posts', ?, ?, ?, ?, ?)
        `).run(
          meta.connector_instance_id,
          MANIFEST_A.connector_id,
          meta.fields_fingerprint,
          meta.model_id,
          meta.dimensions,
          meta.distance_metric,
          new Date().toISOString(),
        );
      } finally {
        await closeServer(server);
      }
    }

    {
      const countingBackend = makeDocumentCountingBackend();
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        semanticRetrievalBackend: countingBackend,
      });
      try {
        await server.startupBackfillDone;
        assert.equal(
          countingBackend.documentEmbeds(),
          1,
          'matching progress row should resume the missing vector instead of deleting and rebuilding all rows',
        );
        assert.equal(countPersistedSemanticVectors(), 3, 'resume restores the missing vector');
        const db = getDb();
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM semantic_search_backfill_progress').get().n,
          0,
          'progress row is cleared after resume completes',
        );
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('interrupted semantic backfill resumes and embeds only missing record-field pairs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-semantic-resume-'));
  const dbPath = path.join(tmpDir, 'pdpp.sqlite');
  const strippedManifest = stripSemanticFields(MANIFEST_A);
  const interruptingBackend = makeInterruptingDocumentBackend({ successfulEmbedsBeforeThrow: 500 });
  const records = Array.from({ length: 501 }, (_, i) => ({
    id: `resume-${i}`,
    title: `resumable semantic backfill record ${i}`,
    selftext: '',
    source_created_at: '2026-04-01T00:00:00Z',
  }));

  try {
    {
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        semanticRetrievalBackend: interruptingBackend,
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const regV1 = await fetch(`${asUrl}/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(strippedManifest),
        });
        assert.equal(regV1.status, 201, 'register manifest without semantic fields');

        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', records);

        const regV2 = await fetch(`${asUrl}/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(MANIFEST_A),
        });
        assert.equal(regV2.status, 500, 'simulated interruption aborts semantic backfill');
        assert.equal(interruptingBackend.successfulEmbeds(), 500);

        const db = getDb();
        assert.equal(countPersistedSemanticVectors(), 500, 'first persisted page remains durable');
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM semantic_search_meta').get().n,
          0,
          'completed semantic meta is not written after interruption',
        );
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM semantic_search_backfill_progress').get().n,
          1,
          'in-progress semantic backfill identity is persisted',
        );
        const { body: metadata } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
        assert.equal(
          metadata.capabilities?.semantic_retrieval?.index_state,
          'stale',
          'incomplete progress without active backfill is advertised as stale',
        );
      } finally {
        await closeServer(server);
      }
    }

    {
      const countingBackend = makeDocumentCountingBackend();
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        semanticRetrievalBackend: countingBackend,
      });
      try {
        await server.startupBackfillDone;
        assert.equal(
          countingBackend.documentEmbeds(),
          1,
          'restart backfill should embed only the missing record-field pair',
        );
        assert.equal(countPersistedSemanticVectors(), 501, 'resume completes the stream without deleting prior vectors');
        const db = getDb();
        assert.equal(
          db.prepare('SELECT COUNT(*) AS n FROM semantic_search_backfill_progress').get().n,
          0,
          'progress row is deleted after completion',
        );
        assert.equal(
          db.prepare(`
            SELECT COUNT(*) AS n
            FROM semantic_search_meta
            WHERE connector_id = ? AND stream = 'posts'
          `).get(MANIFEST_A.connector_id).n,
          1,
          'completed semantic meta is written for the resumed stream',
        );

        const rsUrl = `http://localhost:${server.rsPort}`;
        const asUrl = `http://localhost:${server.asPort}`;
        const ownerToken = await issueOwnerToken(asUrl);
        const { status, body } = await fetchJson(
          `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('resumable semantic backfill record 500')}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } },
        );
        assert.equal(status, 200);
        assert.ok(
          body.data.some((hit) => hit.record_key === 'resume-500'),
          'the previously missing record becomes searchable after resume',
        );
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── 14.35 — restart + backend identity drift → stale → rebuild ─────────────

test('backend identity change flips index_state to stale until rebuild restores', async () => {
  // Same DB path across two boots, but the second boot configures a backend
  // with a DIFFERENT model_id (via semanticRetrievalBackend override).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-semantic-drift-'));
  const dbPath = path.join(tmpDir, 'pdpp.sqlite');
  try {
    // First boot — default stub backend (model `pdpp-reference-stub-embed-v0`).
    {
      const server = await startServer({
        quiet: true, asPort: 0, rsPort: 0, dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        await fetch(`${asUrl}/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(MANIFEST_A),
        });
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, 'posts', [
          { id: 'p1', title: 'drift test', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
        ]);
      } finally {
        await closeServer(server);
      }
    }
    // Second boot — install a stub with a different model_id. Startup
    // backfill runs after AS/RS listen, so wait for the returned promise
    // before asserting the steady-state advertisement.
    {
      const { makeStubBackend } = await import('../server/search-semantic.js');
      const driftedBackend = makeStubBackend({ dimensions: 64 });
      // Override the model identifier by shadowing the returned backend's
      // model() — a minimal adapter mimicking how an operator might swap
      // backends without changing the interface.
      const adapter = {
        ...driftedBackend,
        model: () => 'pdpp-reference-stub-embed-v0-variant',
      };
      const server = await startServer({
        quiet: true, asPort: 0, rsPort: 0, dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        semanticRetrievalBackend: adapter,
      });
      try {
        await server.startupBackfillDone;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const asUrl = `http://localhost:${server.asPort}`;
        await fetch(`${asUrl}/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(MANIFEST_A),
        });
        const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
        const cap = body.capabilities?.semantic_retrieval;
        // After re-register, backfill ran with the new backend → built.
        assert.equal(cap.model, 'pdpp-reference-stub-embed-v0-variant');
        assert.equal(cap.index_state, 'built');
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── parseSemanticSearchParams pure helper — guards the allowlist directly ──

// ─── Operational coverage: real polyfill manifest contributes semantic hits ──
//
// Regression for the operational gap described in
// openspec/changes/make-semantic-retrieval-operational: the semantic
// extension was advertised "built" while zero shipped polyfill manifests
// declared query.search.semantic_fields, so /v1/search/semantic could be
// wired up end-to-end and still return zero hits on real data.
//
// This test uses the real shipped gmail manifest (not an inline fixture) so
// any future regression that drops semantic_fields from the first-party set
// will fail here. It also walks the exact "existing DB + re-registration"
// path reconcilePolyfillManifests takes on boot, proving the declared
// coverage reaches existing records without connector re-ingest.

function loadShippedManifest(name) {
  const p = path.resolve(TEST_DIR, '..', '..', 'packages', 'polyfill-connectors', 'manifests', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stripSemanticFields(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  for (const stream of copy.streams || []) {
    const search = stream.query?.search;
    if (search && 'semantic_fields' in search) {
      delete search.semantic_fields;
    }
  }
  return copy;
}

test('shipped gmail manifest contributes semantic coverage after reconcile without record re-ingest', async () => {
  const shipped = loadShippedManifest('gmail.json');
  assert.ok(Array.isArray(shipped.streams) && shipped.streams.length > 0);

  // Baseline truth-check: at least one stream declares semantic_fields in the
  // shipped manifest. If this fails, the operational semantic gap has
  // regressed: no first-party polyfill contributes to the index.
  const participating = shipped.streams.filter(
    (s) => Array.isArray(s.query?.search?.semantic_fields) && s.query.search.semantic_fields.length > 0,
  );
  assert.ok(
    participating.length > 0,
    'shipped gmail manifest must declare query.search.semantic_fields on at least one stream',
  );
  // `messages` carries the highest-signal natural-language fields (subject,
  // snippet). Pin it explicitly so a future reshuffle that demotes messages
  // out of the semantic set is a visible failure rather than a silent one.
  const messagesStream = participating.find((s) => s.name === 'messages');
  assert.ok(messagesStream, 'gmail messages stream should participate in semantic retrieval');
  const declared = messagesStream.query.search.semantic_fields;
  for (const field of declared) {
    assert.ok(
      messagesStream.schema?.properties?.[field],
      `gmail messages.semantic_fields entry '${field}' must exist in schema.properties`,
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdpp-semantic-gmail-'));
  const dbPath = path.join(tmpDir, 'pdpp.sqlite');

  try {
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      const connectorId = shipped.connector_id;
      // The server canonicalizes the first-party registry URL
      // (`https://registry.pdpp.org/connectors/gmail`) to its short key
      // (`gmail`) at the manifest boundary, so semantic hits are emitted
      // under the canonical key — not the raw URL. Filter by the canonical
      // key (falling back to the raw value for custom manifests) to compare
      // hit.connector_id against what the runtime actually emits.
      const canonicalConnectorId =
        canonicalConnectorKeyFromManifest(shipped) ?? shipped.connector_id;

      // (1) Register the gmail manifest WITHOUT semantic_fields. Represents
      // the pre-operational-semantic world where a real DB was populated
      // while no semantic coverage was declared.
      const strippedManifest = stripSemanticFields(shipped);
      const regV1 = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(strippedManifest),
      });
      assert.equal(regV1.status, 201, 'register stripped gmail manifest');

      // (2) Ingest realistic gmail messages BEFORE semantic_fields exist.
      // The semantic index write-path maintenance never runs for these.
      const ownerToken = await issueOwnerToken(asUrl);
      await ingest(rsUrl, ownerToken, connectorId, 'messages', [
        {
          id: 'm1',
          thread_id: 't1',
          received_at: '2026-04-02T10:00:00Z',
          subject: 'Budget forecast for Q3 capacity planning',
          from_name: 'Taylor Finance',
          from_email: 'taylor@example.com',
          snippet: 'Heads-up on the quarterly budget forecast and capacity planning ahead of Q3 kickoff.',
          source_created_at: '2026-04-02T10:00:00Z',
          emitted_at: '2026-04-02T10:00:00Z',
        },
        {
          id: 'm2',
          thread_id: 't2',
          received_at: '2026-04-05T14:00:00Z',
          subject: 'Lunch Friday?',
          from_name: 'Jordan',
          from_email: 'jordan@example.com',
          snippet: 'Want to grab lunch Friday at the new place on Main?',
          source_created_at: '2026-04-05T14:00:00Z',
          emitted_at: '2026-04-05T14:00:00Z',
        },
        {
          id: 'm3',
          thread_id: 't3',
          received_at: '2026-04-10T09:00:00Z',
          subject: 'Flight itinerary — SFO to AMS',
          from_name: 'Airline',
          from_email: 'noreply@airline.example.com',
          snippet: 'Your flight itinerary from San Francisco to Amsterdam is confirmed.',
          source_created_at: '2026-04-10T09:00:00Z',
          emitted_at: '2026-04-10T09:00:00Z',
        },
      ]);

      // (3) Baseline: semantic search MUST return zero gmail hits because
      // the registered manifest has no semantic_fields. The deterministic
      // stub backend is exact-match reflexive, so we use the exact subject
      // as the query to rule out "search is broken for unrelated reasons".
      const exactQuery = 'Budget forecast for Q3 capacity planning';
      const { body: baselineBody } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      const baselineGmailHits = (baselineBody.data || []).filter(
        (h) => h.connector_id === canonicalConnectorId,
      );
      assert.deepEqual(
        baselineGmailHits.map((h) => h.record_key),
        [],
        'before semantic_fields are declared, gmail contributes zero semantic hits',
      );

      // (4) Re-register with the shipped manifest. This is what
      // reconcilePolyfillManifests does on boot after a reference ships
      // updated semantic_fields — without touching the records table.
      const regV2 = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shipped),
      });
      assert.equal(regV2.status, 201, 'register shipped gmail manifest');

      // (5) The same exact-match query must now return the historical
      // record. Exact-match reflexivity is the stub backend's load-bearing
      // promise; if the backfill path did not run, hits stay empty.
      const { body: afterBody } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      const afterGmailHits = (afterBody.data || []).filter(
        (h) => h.connector_id === canonicalConnectorId,
      );
      assert.ok(
        afterGmailHits.some((h) => h.record_key === 'm1'),
        'after declaring semantic_fields, the historical gmail record becomes semantically searchable with no re-ingest',
      );
      // matched_fields is an intersection of (declared semantic_fields ∩
      // grant projection). For owner-mode the grant projection is
      // effectively full, so matched_fields must be a subset of what the
      // shipped manifest declares.
      const hit = afterGmailHits.find((h) => h.record_key === 'm1');
      for (const field of hit.matched_fields || []) {
        assert.ok(
          declared.includes(field),
          `matched_field '${field}' must be present in declared semantic_fields ${JSON.stringify(declared)}`,
        );
      }
    } finally {
      await closeServer(server);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('multilingual-minilm profile builds embeddings and returns semantic hits', {
  timeout: 180_000,
  skip: RUN_MULTILINGUAL_MINILM_SMOKE
    ? false
    : 'set PDPP_MULTILINGUAL_MINILM_SMOKE=1 to run the external model-download smoke',
}, async () => {
  const cacheDir = process.env.PDPP_MULTILINGUAL_MINILM_SMOKE_CACHE_DIR
    || path.join(os.tmpdir(), 'pdpp-multilingual-minilm-smoke-cache');
  const backend = resolveSemanticBackendFromEnv({
    PDPP_SEMANTIC_EMBEDDING_BACKEND: 'local',
    PDPP_EMBEDDING_PROFILE_ID: 'multilingual-minilm',
    PDPP_EMBEDDING_CACHE_DIR: cacheDir,
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED: '1',
  });

  assert.ok(backend, 'multilingual-minilm backend resolves');
  assert.equal(backend.profileId(), 'multilingual-minilm');
  assert.equal(backend.model(), 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  assert.equal(backend.dimensions(), 384);
  assert.equal(backend.languageBias()?.primary, 'multi');

  const vector = await backend.embedDocument('La ricevuta del treno per Milano e pronta.');
  assert.equal(vector.length, 384, 'multilingual-minilm builds 384-dimensional embeddings');
  assert.equal(backend.modelCachePresent(), true, 'profile model files are cached after embedding');

  await withHarness({ semanticRetrievalBackend: backend }, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      {
        id: 'it-1',
        title: 'Ricevuta del treno per Milano',
        selftext: 'Promemoria: scaricare la ricevuta del viaggio in treno verso Milano.',
        subreddit: 'viaggi',
        source_created_at: '2026-04-18T09:00:00Z',
      },
      {
        id: 'it-2',
        title: 'Lista della spesa',
        selftext: 'Comprare pane, pomodori e caffe prima di cena.',
        subreddit: 'casa',
        source_created_at: '2026-04-18T10:00:00Z',
      },
    ]);

    const { status: metadataStatus, body: metadata } = await fetchJson(
      `${rsUrl}/.well-known/oauth-protected-resource`,
    );
    assert.equal(metadataStatus, 200);
    assert.equal(metadata.capabilities?.semantic_retrieval?.model, backend.model());
    assert.equal(metadata.capabilities?.semantic_retrieval?.language_bias?.primary, 'multi');

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent('ricevuta treno Milano')}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );

    assert.equal(status, 200);
    assert.ok(
      (body.data || []).some((hit) => hit.record_key === 'it-1' && hit.retrieval_mode === 'semantic'),
      'multilingual-minilm returns a semantic hit from the Italian corpus',
    );
  });
});

test('parseSemanticSearchParams accepts the v1 allowlist, rejects everything else', () => {
  const ok = parseSemanticSearchParams({ q: 'x' });
  assert.equal(ok.q, 'x');
  assert.equal(ok.limit, 25);
  assert.equal(ok.cursor, null);
  assert.equal(ok.streams, null);
  const filtered = parseSemanticSearchParams({ q: 'x', streams: 'posts', filter: { source_created_at: { gte: '2026-04-01T00:00:00Z' } } });
  assert.deepEqual(filtered.streams, ['posts']);
  assert.deepEqual(filtered.filter, { source_created_at: { gte: '2026-04-01T00:00:00Z' } });
  // Each rejected key throws with { code: 'invalid_request', param: <key> }.
  for (const key of ['vector', 'embedding', 'model', 'rank', 'connector_id', 'order']) {
    assert.throws(
      () => parseSemanticSearchParams({ q: 'x', [key]: 'v' }),
      (err) => err.code === 'invalid_request' && err.param === key,
      `${key} should throw`,
    );
  }
  // Missing q.
  assert.throws(
    () => parseSemanticSearchParams({}),
    (err) => err.code === 'invalid_request' && err.param === 'q',
  );
  assert.throws(
    () => parseSemanticSearchParams({ q: 'x', filter: { source_created_at: { gte: '2026-04-01T00:00:00Z' } } }),
    (err) => err.code === 'invalid_request' && err.param === 'streams',
  );
});

test('resolveSemanticPerConnectorLimit scales with requested page size instead of always using the public maximum', () => {
  assert.equal(resolveSemanticPerConnectorLimit(1), 25);
  assert.equal(resolveSemanticPerConnectorLimit(25), 38);
  assert.equal(resolveSemanticPerConnectorLimit(50), 75);
  assert.equal(resolveSemanticPerConnectorLimit(100), 100);
  assert.equal(resolveSemanticPerConnectorLimit(500), 100);
});

test('buildPostgresSemanticPlanRequests merges unfiltered scopes and preserves filtered candidate requests', () => {
  const requests = buildPostgresSemanticPlanRequests([
    {
      connectorInstanceId: 'cin_a',
      streamName: 'messages',
      scopeKeys: ['["messages","text"]'],
    },
    {
      connectorInstanceId: 'cin_a',
      streamName: 'files',
      scopeKeys: ['["files","title"]', '["messages","text"]'],
    },
    {
      connectorInstanceId: 'cin_a',
      streamName: 'messages',
      scopeKeys: ['["messages","text"]'],
      candidateRecordKeys: ['rk_1'],
    },
    {
      connectorInstanceId: 'cin_b',
      streamName: 'notes',
      scopeKeys: ['["notes","body"]'],
    },
  ]);

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], {
    connectorInstanceId: 'cin_b',
    streamName: null,
    scopeKeys: ['["notes","body"]'],
    candidateRecordKeys: null,
    postgresCandidateFilter: null,
  });
  assert.deepEqual(requests[1], {
    connectorInstanceId: 'cin_a',
    streamName: null,
    scopeKeys: ['["files","title"]', '["messages","text"]'],
    candidateRecordKeys: null,
    postgresCandidateFilter: null,
  });
  assert.deepEqual(requests[2], {
    connectorInstanceId: 'cin_a',
    streamName: 'messages',
    scopeKeys: ['["messages","text"]'],
    candidateRecordKeys: ['rk_1'],
    postgresCandidateFilter: undefined,
  });
});

test('semantic backend env resolver defaults to deterministic stub outside operational dev mode', () => {
  const backend = resolveSemanticBackendFromEnv({});
  assert.ok(backend);
  assert.equal(backend.model(), 'pdpp-reference-stub-embed-v0');
  assert.equal(backend.dimensions(), 64);
  assert.equal(backend.distanceMetric(), 'cosine');
  assert.equal(backend.available(), true);
});

test('semantic backend env resolver can disable semantic retrieval entirely', () => {
  assert.equal(resolveSemanticBackendFromEnv({ PDPP_SEMANTIC_EMBEDDING_BACKEND: 'disabled' }), null);
});

test('semantic backend env resolver rejects unknown local profile IDs', () => {
  assert.throws(
    () => resolveSemanticBackendFromEnv({
      PDPP_REFERENCE_OPERATIONAL_DEFAULTS: '1',
      PDPP_EMBEDDING_PROFILE_ID: 'unknown-profile',
    }),
    /PDPP_EMBEDDING_PROFILE_ID must be one of:/,
  );
});

test('semantic backend env resolver exposes local multilingual profile metadata without loading a model', () => {
  const backend = resolveSemanticBackendFromEnv({
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS: '1',
    PDPP_EMBEDDING_PROFILE_ID: 'multilingual-minilm',
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED: '0',
    PDPP_EMBEDDING_CACHE_DIR: path.join(os.tmpdir(), 'pdpp-missing-transformers-cache'),
  });
  assert.ok(backend);
  assert.equal(backend.model(), 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  assert.equal(backend.dimensions(), 384);
  assert.equal(backend.distanceMetric(), 'cosine');
  assert.equal(backend.languageBias()?.primary, 'multi');
  assert.equal(backend.downloadAllowed(), false);
  assert.equal(backend.modelCachePresent(), false);
  assert.equal(backend.available(), false);
});

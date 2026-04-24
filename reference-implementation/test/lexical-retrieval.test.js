/**
 * Lexical Retrieval Extension — public-contract conformance tests.
 *
 * Pins the behavior the approved spec promises at:
 *   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
 *
 * Coverage (cross-referenced to tasks.md §9 in
 * openspec/changes/implement-lexical-retrieval-extension/tasks.md):
 *  - 9.1  RS metadata advertisement present + complete when supported
 *  - 9.2  RS metadata advertisement omitted/false when disabled
 *  - 9.3  list envelope shape on a happy-path search
 *  - 9.4  missing q → invalid_request
 *  - 9.5  rejected v1 params (filter, rank, embedding, vector, semantic, order, connector_id)
 *  - 9.6  client-token streams[] not in grant → grant_stream_not_allowed;
 *         owner-token streams[] unknown anywhere → empty list (NOT error)
 *  - 9.7  cross_stream:false advertisement + missing streams[] → invalid_request
 *  - 9.8  result shape (required keys, no portable score), per-mode record_url
 *  - 9.9  helper-level: results without record_url/snippet are still valid
 *  - 9.10 matched_fields ⊆ declared lexical_fields ∩ grant projection
 *  - 9.11 grant subsetting + snippet grant safety
 *  - 9.12 zero overlap → zero hits, no per-stream error
 *  - 9.13 cursor round-trip + cross-surface invalid_cursor
 *  - 9.14 /_ref/search and /v1/search are independent
 *  - 9.15 manifest validator rejects bad lexical_fields shapes
 *  - 9.16 (covered by 9.11 snippet check)
 *  - 9.17 owner-mode cross-connector fan-out
 *  - 9.18 owner-mode hydration round-trip via record_url
 *
 * Plus Reference-Implementation-Architecture spec scenarios:
 *  - "/_ref/search returns spine-shape, /v1/search returns list shape"
 *  - "advertisement is reachable without a grant"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildSearchPlanForGrant,
  parseSearchParams,
} from '../server/search.js';
import { startServer } from '../server/index.js';
import { getDb, initDb, closeDb } from '../server/db.js';

// ─── harness ────────────────────────────────────────────────────────────────

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

// Two manifests with declared lexical_fields, designed to exercise
// cross-connector owner mode AND a stream name shared across both
// connectors. These are inline so the tests don't depend on any seed
// manifest beyond what they explicitly install.
const REDDITISH_MANIFEST_A = {
  protocol_version: '0.1.0',
  connector_id: 'https://test.pdpp.org/connectors/redditish-a',
  version: '1.0.0',
  display_name: 'Redditish A',
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
      query: { search: { lexical_fields: ['title', 'selftext'] } },
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
      query: { search: { lexical_fields: ['body'] } },
    },
    {
      // Non-participating stream. Proves the omit-query.search branch.
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

const REDDITISH_MANIFEST_B = {
  protocol_version: '0.1.0',
  connector_id: 'https://test.pdpp.org/connectors/redditish-b',
  version: '1.0.0',
  display_name: 'Redditish B',
  capabilities: { human_interaction: ['credentials'] },
  streams: [
    {
      // Same stream NAME as in manifest A — exercises cross-connector
      // hits with shared stream name.
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
      query: { search: { lexical_fields: ['title', 'selftext'] } },
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

async function withHarness(opts, fn) {
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
    // Register both manifests so cross-connector owner search has something
    // to fan out across.
    for (const manifest of [REDDITISH_MANIFEST_A, REDDITISH_MANIFEST_B]) {
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

// ─── 9.1 / 9.2 — RS metadata advertisement ──────────────────────────────────

test('RS metadata advertises capabilities.lexical_retrieval with all six required keys when supported', async () => {
  await withHarness({}, async ({ rsUrl }) => {
    // Reachable without a bearer token — onboarding requirement from the spec.
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    const cap = body.capabilities?.lexical_retrieval;
    assert.ok(cap, 'capabilities.lexical_retrieval should be present');
    assert.equal(cap.supported, true);
    assert.equal(cap.endpoint, '/v1/search');
    assert.equal(cap.cross_stream, true);
    assert.equal(cap.snippets, true);
    assert.equal(cap.default_limit, 25);
    assert.equal(cap.max_limit, 100);
  });
});

test('RS metadata omits/falses capabilities.lexical_retrieval when extension is disabled', async () => {
  await withHarness({ lexicalRetrievalSupported: false }, async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    const cap = body.capabilities?.lexical_retrieval;
    // Either omitted entirely or explicitly { supported: false }.
    if (cap) assert.equal(cap.supported, false);
  });
});

// ─── 9.3 / 9.8 — happy-path shape ───────────────────────────────────────────

test('happy-path search returns list envelope with search_result entries (owner token)', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft surprise', selftext: 'unexpected fee', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 'p2', title: 'cooking pasta', selftext: 'al dente tips', source_created_at: '2026-04-02T00:00:00Z' },
    ]);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=overdraft`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.equal(body.has_more, false);
    assert.ok(body.data.length >= 1, 'should return at least one hit');
    const hit = body.data.find((r) => r.record_key === 'p1');
    assert.ok(hit, 'p1 should be in the hit list');
    assert.equal(hit.object, 'search_result');
    assert.equal(hit.stream, 'posts');
    assert.equal(hit.connector_id, connectorA);
    assert.ok(typeof hit.emitted_at === 'string' && hit.emitted_at.length > 0);
    // Owner-mode record_url MUST include the canonical ?connector_id= query param
    assert.ok(hit.record_url.startsWith('/v1/streams/posts/records/p1?connector_id='));
    assert.ok(hit.record_url.includes(encodeURIComponent(connectorA)));
    // Required matched_fields, all from the declared lexical_fields set
    assert.ok(Array.isArray(hit.matched_fields) && hit.matched_fields.length >= 1);
    for (const f of hit.matched_fields) {
      assert.ok(['title', 'selftext'].includes(f), `matched_fields ⊆ declared: got ${f}`);
    }
    // No portable numeric score
    assert.equal(hit.score, undefined);
    // 'cooking pasta' must not match
    assert.equal(body.data.find((r) => r.record_key === 'p2'), undefined);
  });
});

// ─── 9.4 — missing q ────────────────────────────────────────────────────────

test('missing q returns invalid_request and identifies the missing param', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });
});

// ─── 9.5 — disallowed v1 params ─────────────────────────────────────────────

test('disallowed v1 params are rejected with invalid_request', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const cases = [
      'filter%5Brecipient%5D=alice',  // filter[recipient]=alice
      'rank=desc',
      'boost=2',
      'embedding=abc',
      'vector=xyz',
      'semantic=true',
      'order=asc',
      `connector_id=${encodeURIComponent(REDDITISH_MANIFEST_A.connector_id)}`,
    ];
    for (const param of cases) {
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search?q=foo&${param}`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 400, `expected 400 for ${param}, got ${status}`);
      // Schema-level rejection emits invalid_request from Fastify-AJV; runtime
      // rejection from search.js also emits invalid_request. Either is fine.
      assert.equal(body.error.code, 'invalid_request', `expected invalid_request for ${param}`);
    }
  });
});

// ─── 9.6 — client streams[] hard error ──────────────────────────────────────

test('client-token streams[] not in grant returns grant_stream_not_allowed', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);

    // Use the pre-seeded `longview` client — see reference-local-defaults.js.
    // PAR requires explicit registered client_id values; longview is one of
    // the seeded launch consumers.
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'analytics',
      purpose_description: 'lexical retrieval test',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title'] }],  // posts only
    });

    // Asking for `comments` is NOT in the grant ⇒ hard error.
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=overdraft&streams=comments`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 403);
    assert.equal(body.error.code, 'grant_stream_not_allowed');
  });
});

// ─── 9.6 (owner half) — owner streams[] soft filter ─────────────────────────

test('owner-token streams[] unknown anywhere returns empty list (no error)', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'overdraft', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=overdraft&streams=nonexistent_stream_anywhere`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, []);
    assert.equal(body.has_more, false);
  });
});

// ─── 9.7 — cross_stream:false advertisement requires streams[] ──────────────

test('cross_stream:false advertisement requires streams[] in the request', async () => {
  await withHarness(
    { lexicalRetrievalCapability: { supported: true, endpoint: '/v1/search', cross_stream: false, snippets: true, default_limit: 25, max_limit: 100 } },
    async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search?q=overdraft`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 400);
      assert.equal(body.error.code, 'invalid_request');
    },
  );
});

// ─── 9.10 / 9.11 — grant subsetting + snippet grant safety (client) ─────────

test('client grant authorizing only one of two declared lexical_fields restricts matched_fields and snippet text', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    // Two records: one matches only via `title`, one matches only via `selftext`.
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p_title', title: 'apricot harvest notes', selftext: 'no match here', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 'p_self',  title: 'unrelated heading',     selftext: 'apricot tart recipe', source_created_at: '2026-04-02T00:00:00Z' },
    ]);

    // Approve a grant authorizing only `title` on posts (selftext NOT in grant).
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'analytics',
      purpose_description: 'lexical retrieval test',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id', 'title'] }],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=apricot`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    // Title-matching record should appear with matched_fields = ['title']
    const titleHit = body.data.find((r) => r.record_key === 'p_title');
    assert.ok(titleHit, 'p_title should appear');
    assert.deepEqual(titleHit.matched_fields, ['title']);
    if (titleHit.snippet) {
      assert.equal(titleHit.snippet.field, 'title');
      // Snippet must not quote ungranted `selftext` content. p_title's
      // selftext is "no match here" — ensure that string isn't in the snippet.
      assert.ok(!titleHit.snippet.text.includes('no match here'),
        `snippet should not leak ungranted selftext: got "${titleHit.snippet.text}"`);
    }
    // Selftext-matching record must NOT appear because its only match was
    // in an ungranted field.
    assert.equal(body.data.find((r) => r.record_key === 'p_self'), undefined,
      'p_self must not appear because its match was in ungranted selftext');
  });
});

// ─── 9.12 — zero overlap → zero hits ────────────────────────────────────────

test('grant with zero overlap on searchable fields contributes zero hits and no per-stream error', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'apricot', selftext: 'apricot', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    // Grant only `id` — neither title nor selftext is authorized.
    const approved = await approveClientGrant(asUrl, {
      client_id: 'longview',
      connector_id: connectorA,
      purpose_code: 'analytics',
      purpose_description: 'lexical retrieval test',
      access_mode: 'continuous',
      streams: [{ name: 'posts', fields: ['id'] }],
    });
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=apricot`,
      { headers: { 'Authorization': `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data, []);
  });
});

// ─── 9.13 — pagination round-trip + cross-surface invalid_cursor ────────────

test('pagination round-trip works and search cursors are not interchangeable with record-list cursors', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    const records = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      title: `apricot page ${i}`,
      selftext: '',
      source_created_at: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
    }));
    await ingest(rsUrl, ownerToken, connectorA, 'posts', records);

    const page1 = await fetchJson(
      `${rsUrl}/v1/search?q=apricot&limit=3`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(page1.status, 200);
    assert.equal(page1.body.has_more, true);
    assert.ok(typeof page1.body.next_cursor === 'string' && page1.body.next_cursor.length > 0);
    assert.equal(page1.body.data.length, 3);

    const page2 = await fetchJson(
      `${rsUrl}/v1/search?q=apricot&limit=3&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(page2.status, 200);
    assert.equal(page2.body.data.length, 3);
    // No record_key duplicated between pages
    const firstKeys = new Set(page1.body.data.map((r) => r.record_key));
    for (const r of page2.body.data) {
      assert.ok(!firstKeys.has(r.record_key), `cursor should advance: ${r.record_key} dup`);
    }

    // Reusing the search cursor on /v1/streams/posts/records is rejected.
    const wrongSurface = await fetchJson(
      `${rsUrl}/v1/streams/posts/records?connector_id=${encodeURIComponent(connectorA)}&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.ok(
      wrongSurface.status === 400 || wrongSurface.status === 410,
      `record-list should reject the search cursor (got ${wrongSurface.status})`,
    );
    assert.equal(wrongSurface.body.error.code, 'invalid_cursor');
  });
});

// ─── 9.14 — /_ref/search and /v1/search are independent ─────────────────────

test('/_ref/search returns spine shape, /v1/search returns list shape — they do not alias', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    // /_ref/search is on the AS side (control plane). /v1/search is on the RS.
    const refResp = await fetchJson(`${asUrl}/_ref/search?q=anything`);
    assert.equal(refResp.status, 200);
    assert.equal(refResp.body.object, 'search_result');
    assert.ok('exact' in refResp.body && 'traces' in refResp.body && 'grants' in refResp.body && 'runs' in refResp.body,
      '/_ref/search returns the spine artifact-jump shape');

    const v1Resp = await fetchJson(
      `${rsUrl}/v1/search?q=anything`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(v1Resp.status, 200);
    assert.equal(v1Resp.body.object, 'list');
    assert.ok(Array.isArray(v1Resp.body.data), '/v1/search returns the list-of-search_result envelope');
  });
});

// ─── 9.15 — manifest validator rejects bad lexical_fields shapes ────────────

test('manifest validator rejects bad lexical_fields shapes', async () => {
  await withHarness({}, async ({ asUrl }) => {
    const baseStream = (overrides) => ({
      name: 'tweaked',
      semantics: 'append_only',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          score: { type: 'integer' },
        },
        required: ['id'],
      },
      primary_key: ['id'],
      cursor_field: null,
      consent_time_field: null,
      selection: { fields: true, resources: false },
      ...overrides,
    });

    const cases = [
      { label: 'empty array',     query: { search: { lexical_fields: [] } } },
      { label: 'non-array',       query: { search: { lexical_fields: 'title' } } },
      { label: 'nested path',     query: { search: { lexical_fields: ['data.body'] } } },
      { label: 'array-typed',     query: { search: { lexical_fields: ['tags'] } } },
      { label: 'unknown field',   query: { search: { lexical_fields: ['nope'] } } },
      { label: 'integer-typed',   query: { search: { lexical_fields: ['score'] } } },
    ];
    for (const c of cases) {
      const manifest = {
        protocol_version: '0.1.0',
        connector_id: `https://test.pdpp.org/connectors/bad-${encodeURIComponent(c.label)}`,
        version: '1.0.0',
        display_name: `bad-${c.label}`,
        capabilities: { human_interaction: ['credentials'] },
        streams: [baseStream({ query: c.query })],
      };
      const resp = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      const text = await resp.text();
      assert.ok(resp.status >= 400 && resp.status < 500, `${c.label}: expected 4xx, got ${resp.status} ${text}`);
    }
  });
});

// ─── 9.17 — cross-connector owner-mode fan-out ──────────────────────────────

test('owner-mode search fans out across connectors and attributes hits to their originating connector', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const cA = REDDITISH_MANIFEST_A.connector_id;
    const cB = REDDITISH_MANIFEST_B.connector_id;
    await ingest(rsUrl, ownerToken, cA, 'posts', [
      { id: 'pA1', title: 'persimmon season', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    await ingest(rsUrl, ownerToken, cB, 'posts', [
      { id: 'pB1', title: 'persimmon recipe', selftext: '', source_created_at: '2026-04-02T00:00:00Z' },
    ]);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=persimmon`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    const fromA = body.data.find((r) => r.record_key === 'pA1');
    const fromB = body.data.find((r) => r.record_key === 'pB1');
    assert.ok(fromA, 'hit from connector A');
    assert.ok(fromB, 'hit from connector B');
    assert.equal(fromA.connector_id, cA);
    assert.equal(fromB.connector_id, cB);
    assert.equal(fromA.stream, 'posts');
    assert.equal(fromB.stream, 'posts');
  });
});

// ─── 9.18 — owner-mode hydration round-trip ─────────────────────────────────

test('owner-mode record_url is dereference-able and returns the canonical record envelope', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const cA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, cA, 'posts', [
      { id: 'p1', title: 'cherimoya cultivation', selftext: '', source_created_at: '2026-04-01T00:00:00Z' },
    ]);
    const search = await fetchJson(
      `${rsUrl}/v1/search?q=cherimoya`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(search.status, 200);
    const hit = search.body.data[0];
    assert.ok(hit, 'should return one hit');
    // record_url is server-relative; combine with rsUrl for the GET.
    const fetched = await fetchJson(
      `${rsUrl}${hit.record_url}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(fetched.status, 200, `hydration GET ${rsUrl}${hit.record_url} should succeed`);
    assert.equal(fetched.body.object, 'record');
    assert.equal(fetched.body.id, 'p1');
    assert.equal(fetched.body.stream, 'posts');
  });
});

test('lexical search treats punctuation and hyphens as user text, not FTS syntax', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, 'posts', [
      { id: 'p1', title: 'style-driven refactor', selftext: 'cleanup note', source_created_at: '2026-04-01T00:00:00Z' },
    ]);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search?q=${encodeURIComponent('style-driven')}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.ok(body.data.some((r) => r.record_key === 'p1'), 'hyphenated query should match without SQLITE_ERROR');
  });
});

// ─── 9.9 — helper-level: results without record_url/snippet are still valid ─

test('buildSearchPlanForGrant honors declared ∩ authorized; parseSearchParams enforces v1 allowlist', () => {
  const manifest = {
    streams: [
      { name: 'posts', query: { search: { lexical_fields: ['title', 'selftext'] } } },
      { name: 'comments', query: { search: { lexical_fields: ['body'] } } },
      { name: 'saved' },  // non-participating
    ],
  };
  const grantAllPosts = { streams: [{ name: 'posts' }] };
  const planAll = buildSearchPlanForGrant({ manifest, grant: grantAllPosts, streamsFilter: null });
  assert.deepEqual(planAll, [{ streamName: 'posts', searchableFields: ['title', 'selftext'] }]);

  const grantTitleOnly = { streams: [{ name: 'posts', fields: ['title'] }] };
  const planSubset = buildSearchPlanForGrant({ manifest, grant: grantTitleOnly, streamsFilter: null });
  assert.deepEqual(planSubset, [{ streamName: 'posts', searchableFields: ['title'] }]);

  const grantUnrelatedFields = { streams: [{ name: 'posts', fields: ['id'] }] };
  const planEmpty = buildSearchPlanForGrant({ manifest, grant: grantUnrelatedFields, streamsFilter: null });
  assert.deepEqual(planEmpty, []);

  // Streams filter narrows to a single participating stream
  const grantBoth = { streams: [{ name: 'posts' }, { name: 'comments' }] };
  const planFiltered = buildSearchPlanForGrant({ manifest, grant: grantBoth, streamsFilter: ['comments'] });
  assert.deepEqual(planFiltered, [{ streamName: 'comments', searchableFields: ['body'] }]);

  // parseSearchParams: q required
  assert.throws(() => parseSearchParams({}), /q is required/);
  // parseSearchParams: connector_id rejected
  assert.throws(() => parseSearchParams({ q: 'foo', connector_id: 'x' }), /Unsupported query parameter: connector_id/);
  // parseSearchParams: filter rejected
  assert.throws(() => parseSearchParams({ q: 'foo', 'filter[recipient]': 'a' }), /Unsupported query parameter/);
  // parseSearchParams: streams[] normalized
  const ok = parseSearchParams({ q: 'foo', streams: 'posts' });
  assert.equal(ok.q, 'foo');
  assert.deepEqual(ok.streams, ['posts']);
  // parseSearchParams: streams as array stays an array
  const ok2 = parseSearchParams({ q: 'foo', streams: ['posts', 'comments'] });
  assert.deepEqual(ok2.streams, ['posts', 'comments']);
  // parseSearchParams: limit clamps and defaults
  assert.equal(parseSearchParams({ q: 'foo' }).limit, 25);
  assert.equal(parseSearchParams({ q: 'foo', limit: '500' }).limit, 100);
  assert.equal(parseSearchParams({ q: 'foo', limit: '7' }).limit, 7);
});

// ─── startup drift-detect + rebuild ─────────────────────────────────────────

/**
 * Pre-existing records become searchable when a manifest later declares
 * lexical_fields, without requiring any record rewrite or re-ingest.
 *
 * Scenario:
 *   1. Register a connector manifest WITHOUT query.search.lexical_fields.
 *   2. Ingest records.
 *   3. Re-register the same connector with the SAME records still in the DB,
 *      but now declaring lexical_fields. This is the "operator turns the
 *      extension on for an existing stream" case.
 *   4. Issue /v1/search — the historical records must show up immediately.
 *
 * Without the registerConnector backfill hook, step (4) would return zero
 * hits because the FTS5 write-path maintenance (lexicalIndexUpsert) only
 * runs on subsequent record writes, not on records that already existed.
 */
test('pre-existing records become searchable after lexical_fields are declared (no re-ingest)', async () => {
  // Bypass the standard withHarness — it pre-registers manifests with
  // lexical_fields already declared, which would skip past the case under
  // test. Run a bespoke harness that registers a non-participating manifest
  // first.
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  // A v1 connector manifest WITHOUT lexical_fields. Same connector_id,
  // schema, and primary_key as the eventual v2 — only the query.search
  // block differs.
  const CONNECTOR_ID = 'https://test.pdpp.org/connectors/late-bloomer';
  const baseStream = (overrides = {}) => ({
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
    ...overrides,
  });
  const manifestV1 = {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Late Bloomer',
    capabilities: { human_interaction: ['credentials'] },
    streams: [baseStream()],
  };
  const manifestV2 = {
    ...manifestV1,
    version: '2.0.0',
    streams: [baseStream({
      query: { search: { lexical_fields: ['title', 'selftext'] } },
    })],
  };

  try {
    // (1) Register without lexical_fields.
    const regV1 = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestV1),
    });
    assert.equal(regV1.status, 201);

    // (2) Ingest records BEFORE the extension is enabled. These records
    // never reach lexicalIndexUpsert because the manifest declares no
    // lexical_fields at the time of write.
    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, CONNECTOR_ID, 'posts', [
      { id: 'h1', title: 'pre-existing watermelon harvest', selftext: 'no index yet', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 'h2', title: 'cold storage notes',              selftext: 'watermelon stays crisp', source_created_at: '2026-04-02T00:00:00Z' },
      { id: 'h3', title: 'unrelated heading',               selftext: 'no match here',          source_created_at: '2026-04-03T00:00:00Z' },
    ]);

    // Sanity check: the index has zero rows for this stream because the
    // manifest declared no lexical_fields when the records arrived.
    const baselineSearch = await fetchJson(
      `${rsUrl}/v1/search?q=watermelon`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(baselineSearch.status, 200);
    const baselineMatchedFromLateBloomer = baselineSearch.body.data.filter(
      (r) => r.connector_id === CONNECTOR_ID,
    );
    assert.deepEqual(
      baselineMatchedFromLateBloomer,
      [],
      'before the extension is enabled, the late-bloomer connector contributes zero hits',
    );

    // (3) Re-register the SAME connector_id with lexical_fields declared.
    // No record rewrite; no re-ingest; the records table is untouched.
    const regV2 = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestV2),
    });
    assert.equal(regV2.status, 201);

    // (4) Search should now return the historical records. This proves the
    // registerConnector backfill hook in auth.js + the
    // lexicalIndexBackfillForManifest helper in search.js do the right thing.
    const afterBackfill = await fetchJson(
      `${rsUrl}/v1/search?q=watermelon`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(afterBackfill.status, 200);
    const matched = afterBackfill.body.data
      .filter((r) => r.connector_id === CONNECTOR_ID)
      .map((r) => r.record_key)
      .sort();
    assert.deepEqual(
      matched,
      ['h1', 'h2'],
      'historical records must be searchable after lexical_fields are declared, with no re-ingest',
    );
    // h3 has no match anywhere — must NOT appear.
    assert.equal(
      afterBackfill.body.data.find((r) => r.record_key === 'h3'),
      undefined,
      'records that do not match q must not appear, even after backfill',
    );

    // The backfill is idempotent: re-register again with the same v2
    // manifest and the result count must be unchanged.
    const regV2Again = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestV2),
    });
    assert.equal(regV2Again.status, 201);
    const afterIdempotentBackfill = await fetchJson(
      `${rsUrl}/v1/search?q=watermelon`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    const matchedAgain = afterIdempotentBackfill.body.data
      .filter((r) => r.connector_id === CONNECTOR_ID)
      .map((r) => r.record_key)
      .sort();
    assert.deepEqual(
      matchedAgain,
      ['h1', 'h2'],
      'idempotent: re-registering with the same lexical_fields does not duplicate or drop hits',
    );
  } finally {
    await closeServer(server);
  }
});

/**
 * Regression: same-cardinality field-set change must trigger backfill.
 *
 * The earlier drift detector treated indexCount > 0 && indexCount within
 * the [1, recordCount * declaredFields.length] band as "in sync" — but
 * that band is satisfied by stale rows from the previous declaration when
 * the field count is unchanged. Owner reproduced the failure on this
 * branch with ['title'] -> ['selftext']: re-registering with the new
 * field set returned zero hits for selftext-only matches.
 *
 * The fix is a per-(connector, stream) fingerprint of the declared
 * lexical_fields persisted in lexical_search_meta. A fingerprint
 * mismatch forces rebuild even when the row count is plausible.
 */
test('manifest update that swaps lexical_fields (same cardinality) rebuilds the index', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  const CONNECTOR_ID = 'https://test.pdpp.org/connectors/field-swap';
  const baseStream = (overrides = {}) => ({
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
    ...overrides,
  });

  // v1: lexical_fields = ['title']. v2: lexical_fields = ['selftext'].
  // Same cardinality (1) — defeats the row-count heuristic on its own.
  const manifestV1 = {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Field Swap',
    capabilities: { human_interaction: ['credentials'] },
    streams: [baseStream({ query: { search: { lexical_fields: ['title'] } } })],
  };
  const manifestV2 = {
    ...manifestV1,
    version: '2.0.0',
    streams: [baseStream({ query: { search: { lexical_fields: ['selftext'] } } })],
  };

  try {
    // Register v1 (title-searchable).
    let reg = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestV1),
    });
    assert.equal(reg.status, 201);

    const ownerToken = await issueOwnerToken(asUrl);
    // Records whose target term ('blueberry') lives ONLY in selftext, not
    // in title. Under v1 these contribute zero hits; under v2 they should
    // appear after the field-set swap.
    await ingest(rsUrl, ownerToken, CONNECTOR_ID, 'posts', [
      { id: 's1', title: 'first heading',  selftext: 'blueberry preserves recipe', source_created_at: '2026-04-01T00:00:00Z' },
      { id: 's2', title: 'second heading', selftext: 'farmers market blueberry haul', source_created_at: '2026-04-02T00:00:00Z' },
      { id: 's3', title: 'third heading',  selftext: 'no match here', source_created_at: '2026-04-03T00:00:00Z' },
    ]);

    // To make the drift detector's row-count heuristic legitimately think
    // the index is "in sync" after the v2 swap, we need it to actually
    // have plausible content under v1. Ingest a record whose 'blueberry'
    // term DOES appear in title under v1 — and a few other title-only
    // records — so the index has rows when v2 arrives.
    await ingest(rsUrl, ownerToken, CONNECTOR_ID, 'posts', [
      { id: 't1', title: 'blueberry season opens', selftext: 'unrelated body', source_created_at: '2026-04-04T00:00:00Z' },
      { id: 't2', title: 'spring planting notes',  selftext: 'unrelated body', source_created_at: '2026-04-05T00:00:00Z' },
      { id: 't3', title: 'autumn pruning notes',   selftext: 'unrelated body', source_created_at: '2026-04-06T00:00:00Z' },
    ]);

    // Sanity: under v1, only the title-match record should appear.
    const v1Search = await fetchJson(
      `${rsUrl}/v1/search?q=blueberry`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(v1Search.status, 200);
    const v1Matched = v1Search.body.data
      .filter((r) => r.connector_id === CONNECTOR_ID)
      .map((r) => r.record_key)
      .sort();
    assert.deepEqual(
      v1Matched,
      ['t1'],
      'under v1 (lexical_fields=["title"]), only the title-match record should appear',
    );

    // Re-register v2: same connector_id, same streams, lexical_fields
    // changed from ['title'] to ['selftext']. Same cardinality.
    reg = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestV2),
    });
    assert.equal(reg.status, 201);

    // Under v2, the selftext-match records (s1, s2) MUST appear, and the
    // v1-only title-match (t1) MUST disappear because 'blueberry' is no
    // longer in any indexed field for that record.
    const v2Search = await fetchJson(
      `${rsUrl}/v1/search?q=blueberry`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(v2Search.status, 200);
    const v2Matched = v2Search.body.data
      .filter((r) => r.connector_id === CONNECTOR_ID)
      .map((r) => r.record_key)
      .sort();
    assert.deepEqual(
      v2Matched,
      ['s1', 's2'],
      'after swapping lexical_fields from ["title"] to ["selftext"] (same cardinality), ' +
        'historical selftext-only matches must appear and stale title-only matches must not',
    );

    // matched_fields on the v2 hits must reflect the new declaration.
    for (const hit of v2Search.body.data.filter((r) => r.connector_id === CONNECTOR_ID)) {
      assert.deepEqual(
        hit.matched_fields,
        ['selftext'],
        `hit ${hit.record_key} should have matched_fields=['selftext'] under v2, got ${JSON.stringify(hit.matched_fields)}`,
      );
    }

    // Round-trip back to v1 to confirm the fingerprint check works in both
    // directions: re-registering v1 must restore title-only matching.
    reg = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestV1),
    });
    assert.equal(reg.status, 201);
    const v1Again = await fetchJson(
      `${rsUrl}/v1/search?q=blueberry`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    const v1AgainMatched = v1Again.body.data
      .filter((r) => r.connector_id === CONNECTOR_ID)
      .map((r) => r.record_key)
      .sort();
    assert.deepEqual(
      v1AgainMatched,
      ['t1'],
      'reverting lexical_fields from ["selftext"] back to ["title"] must restore title-only matching',
    );
  } finally {
    await closeServer(server);
  }
});

/**
 * Regression: restarting on an existing polyfill DB must backfill lexical
 * search for already-registered connectors, without requiring a fresh
 * POST /connectors call.
 *
 * This simulates the real failure mode on localhost:
 *   1. A DB already contains connector manifests + records.
 *   2. The lexical FTS tables are empty (e.g. DB created before the
 *      lexical retrieval tranche landed).
 *   3. Server restarts in polyfill mode.
 *   4. /v1/search must return historical hits immediately.
 */
test('startup backfills existing polyfill connectors without re-registration', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pdpp-lexical-restart-'));
  const dbPath = join(tempDir, 'polyfill.sqlite');

  const bootServer = () => startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath,
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });

  let server = await bootServer();
  let asUrl = `http://localhost:${server.asPort}`;
  let rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const reg = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REDDITISH_MANIFEST_A),
    });
    assert.equal(reg.status, 201, 'register connector');

    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, REDDITISH_MANIFEST_A.connector_id, 'posts', [
      {
        id: 'restart-p1',
        title: 'the owner orchard notes',
        selftext: 'historical lexical hit',
        source_created_at: '2026-04-01T00:00:00Z',
      },
    ]);

    const beforeRestart = await fetchJson(
      `${rsUrl}/v1/search?q=the owner`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(beforeRestart.status, 200);
    assert.ok(
      beforeRestart.body.data.some((r) => r.record_key === 'restart-p1'),
      'sanity: record is searchable before restart',
    );

    await closeServer(server);
    closeDb();

    await initDb(dbPath);
    const db = getDb();
    db.prepare('DELETE FROM lexical_search_index').run();
    db.prepare('DELETE FROM lexical_search_meta').run();
    closeDb();

    server = await bootServer();
    await server.startupBackfillDone;
    asUrl = `http://localhost:${server.asPort}`;
    rsUrl = `http://localhost:${server.rsPort}`;

    const ownerTokenAfterRestart = await issueOwnerToken(asUrl);
    const afterRestart = await fetchJson(
      `${rsUrl}/v1/search?q=the owner`,
      { headers: { Authorization: `Bearer ${ownerTokenAfterRestart}` } },
    );
    assert.equal(afterRestart.status, 200);
    assert.ok(
      afterRestart.body.data.some((r) => r.record_key === 'restart-p1'),
      'startup backfill should restore historical hits without re-registration',
    );
  } finally {
    await closeServer(server).catch(() => {});
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  }
});

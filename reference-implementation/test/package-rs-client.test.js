// Focused unit tests for the hosted-MCP PackageRsClient fan-out adapter.
//
// These tests stub `fetch` and verify the per-route behavior of
// reference-implementation/server/package-rs-client.js without standing
// up the full hosted MCP OAuth flow. Behaviors covered:
//
//   - schema fan-out: per-source stream tagging + package metadata
//   - protected-resource metadata: server-global passthrough
//   - list_streams fan-out: rows tagged with source identity
//   - search fan-out: hits tagged with source identity
//   - search scoped by connection_id: single child call only
//   - query_records ambiguous: typed 409 + available_connections
//   - query_records with selector: routes to one child
//   - fetch_blob (getRaw) requires selector
//   - event subscription create: selector required when >1 child
//   - event subscription create: single-child package infers child
//   - event subscription list: fans out and merges
//   - event subscription get/patch/delete: locates owning child
//   - selector not in members: typed not_found
//
// Spec: openspec/changes/add-hosted-mcp-grant-packages

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPackageRsClient } from '../server/package-rs-client.js';

const PROVIDER = 'https://pdpp.test';

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        const lc = name.toLowerCase();
        if (lc === 'content-type') return 'application/json';
        if (lc === 'x-request-id') return headers['x-request-id'] || null;
        return null;
      },
    },
    async json() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function makeRouter(routes) {
  // routes: function(req:{url, method, token, body}) -> Response
  return async function fakeFetch(url, init = {}) {
    const u = new URL(url);
    const headers = init.headers || {};
    const token = (headers.Authorization || '').replace(/^Bearer\s+/, '');
    const req = {
      url: u,
      path: u.pathname,
      query: u.searchParams,
      method: init.method || 'GET',
      token,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    return routes(req);
  };
}

function memberA() {
  return {
    grant_id: 'grant_A',
    token: 'tok_A',
    source: { kind: 'connector', id: 'github' },
    connection_id: 'gh_main',
  };
}
function memberB() {
  return {
    grant_id: 'grant_B',
    token: 'tok_B',
    source: { kind: 'connector', id: 'slack' },
    connection_id: 'slack_main',
  };
}

test('schema fan-out merges streams per source and tags package metadata', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ token: req.token, path: req.path });
    if (req.token === 'tok_A') {
      return jsonResponse(200, {
        data: {
          streams: [{ name: 'repos' }, { name: 'issues' }],
          granted_connections: [{ connection_id: 'gh_main' }],
        },
      });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, {
        data: {
          streams: [{ name: 'messages' }],
          granted_connections: [{ connection_id: 'slack_main' }],
        },
      });
    }
    return jsonResponse(500, { error: 'unknown_token' });
  });

  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/schema');
  assert.equal(out.ok, true);
  assert.equal(out.body.data.streams.length, 3);
  for (const s of out.body.data.streams) {
    assert.ok(s.source && s.source.grant_id, 'every stream carries source identity');
    assert.equal(s.source.connector_key, s.source.connector_id, 'source tag keeps connector_id compatibility while adding connector_key');
  }
  assert.equal(out.body.data.package.member_count, 2);
  assert.equal(out.body.data.package.sources.length, 2);
  assert.equal(out.body.meta.package.member_count, 2);
  assert.equal(calls.length, 2);
});

test('schema fan-out understands the canonical { data: { connectors: [{ streams }] } } shape', async () => {
  // Mirror the real RS /v1/schema envelope: each child returns one
  // connector item under data.connectors[] with its streams nested inside.
  // This is the shape exercised by reference-implementation/test/hosted-mcp-oauth.test.js
  // ("multi-source hosted MCP picker..."), here as a focused unit test so a
  // future PackageRsClient regression is caught without the OAuth scaffold.
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') {
      return jsonResponse(200, {
        data: {
          object: 'schema',
          connectors: [
            {
              object: 'connector',
              source: { kind: 'connector', id: 'github' },
              connector_id: 'github',
              stream_count: 2,
              streams: [
                { name: 'repos', granted_connections: [{ connection_id: 'gh_main' }] },
                { name: 'issues' },
              ],
            },
          ],
          connector_count: 1,
          stream_count: 2,
        },
      });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, {
        data: {
          object: 'schema',
          connectors: [
            {
              object: 'connector',
              source: { kind: 'connector', id: 'slack' },
              connector_id: 'slack',
              stream_count: 1,
              streams: [{ name: 'messages' }],
            },
          ],
          connector_count: 1,
          stream_count: 1,
        },
      });
    }
    return jsonResponse(500, { error: 'unknown_token' });
  });

  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/schema');
  assert.equal(out.ok, true);
  assert.equal(out.body.data.streams.length, 3, 'streams from every child connector are flattened');
  for (const s of out.body.data.streams) {
    assert.ok(s.source && s.source.grant_id, 'each stream carries source identity');
  }
  assert.equal(out.body.data.package.member_count, 2);
  assert.equal(out.body.data.package.sources.length, 2);
  assert.equal(out.body.meta.package.member_count, 2);
  // Canonical connectors[] is preserved so callers that already speak the
  // schema envelope keep working.
  assert.equal(out.body.data.connectors.length, 2);
  // Per-stream granted_connections are flattened to the top-level
  // package-fanout `granted_connections` so consumers get one list.
  assert.ok(Array.isArray(out.body.data.granted_connections));
  assert.equal(out.body.data.granted_connections.length, 1);
});

test('schema scoped to connection_id calls only that child and strips the package selector', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ token: req.token, path: req.path, query: req.query.toString() });
    if (req.token === 'tok_B') {
      return jsonResponse(200, {
        data: {
          streams: [{ name: 'messages' }],
          granted_connections: [{ connection_id: 'slack_main' }],
        },
      });
    }
    return jsonResponse(500, { error: 'wrong_child' });
  });

  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/schema', { query: { stream: 'messages', connection_id: 'slack_main' } });

  assert.equal(out.ok, true);
  assert.equal(out.body.data.streams.length, 1);
  assert.equal(out.body.data.streams[0].name, 'messages');
  assert.equal(out.body.data.streams[0].source.connection_id, 'slack_main');
  assert.deepEqual(calls, [{ token: 'tok_B', path: '/v1/schema', query: 'stream=messages' }]);
});

test('schema with unknown connection_id returns not_found without fanout', async () => {
  let called = 0;
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/schema', { query: { connection_id: 'unknown' } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error.code, 'not_found');
  assert.equal(called, 0, 'unknown connection_id is rejected before touching child grants');
});

test('schema detail=full rejects shared stream names before package full-schema fanout', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ token: req.token, query: req.query.toString() });
    if (req.query.get('view') !== 'compact') {
      return jsonResponse(500, { error: 'full_schema_should_not_be_called' });
    }
    if (req.token === 'tok_A') {
      return jsonResponse(200, {
        data: {
          object: 'schema',
          connectors: [
            {
              connector_id: 'github',
              streams: [{ name: 'messages', granted_connections: [{ connection_id: 'gh_main' }] }],
            },
          ],
        },
      });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, {
        data: {
          object: 'schema',
          connectors: [
            {
              connector_id: 'slack',
              streams: [{ name: 'messages', granted_connections: [{ connection_id: 'slack_main' }] }],
            },
          ],
        },
      });
    }
    return jsonResponse(500, {});
  });

  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/schema', { query: { stream: 'messages', detail: 'full' } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.error.code, 'ambiguous_schema_detail');
  assert.equal(out.error.retry_with, 'connection_id');
  assert.deepEqual(
    out.error.available_connections.map((entry) => entry.connection_id).sort(),
    ['gh_main', 'slack_main'],
  );
  assert.deepEqual(
    calls.map((call) => call.query).sort(),
    ['stream=messages&view=compact', 'stream=messages&view=compact'],
    'package client should only perform compact preflight before returning ambiguity',
  );
});

test('schema detail=full with a single matching package source routes to that child only', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ token: req.token, query: req.query.toString() });
    if (req.token === 'tok_A') {
      return jsonResponse(200, {
        data: {
          object: 'schema',
          connectors: [
            {
              connector_id: 'github',
              streams: [],
            },
          ],
        },
      });
    }
    if (req.token === 'tok_B' && req.query.get('view') === 'compact') {
      return jsonResponse(200, {
        data: {
          object: 'schema',
          connectors: [
            {
              connector_id: 'slack',
              streams: [{ name: 'messages', granted_connections: [{ connection_id: 'slack_main' }] }],
            },
          ],
        },
      });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, {
        data: {
          object: 'schema',
          connectors: [
            {
              connector_id: 'slack',
              streams: [{ name: 'messages', field_capabilities: { id: { schema: { type: 'string' } } } }],
            },
          ],
        },
      });
    }
    return jsonResponse(500, {});
  });

  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/schema', { query: { stream: 'messages', detail: 'full' } });

  assert.equal(out.ok, true);
  assert.equal(out.body.data.connectors.length, 1);
  assert.equal(out.body.data.connectors[0].connector_id, 'slack');
  assert.deepEqual(calls, [
    { token: 'tok_A', query: 'stream=messages&view=compact' },
    { token: 'tok_B', query: 'stream=messages&view=compact' },
    { token: 'tok_B', query: 'stream=messages&detail=full' },
  ]);
});

test('protected-resource metadata is a server-global passthrough, not a source-required read', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ token: req.token, path: req.path, query: req.query.toString() });
    return jsonResponse(200, {
      resource: 'https://pdpp.test/mcp',
      capabilities: {
        client_event_subscriptions: {
          supported: true,
          endpoint: '/v1/event-subscriptions',
        },
      },
    });
  });

  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/.well-known/oauth-protected-resource', {
    query: { resource: 'https://pdpp.test/mcp' },
  });
  assert.equal(out.ok, true);
  assert.equal(out.body.capabilities.client_event_subscriptions.supported, true);
  assert.deepEqual(calls, [
    {
      token: 'tok_A',
      path: '/.well-known/oauth-protected-resource',
      query: 'resource=https%3A%2F%2Fpdpp.test%2Fmcp',
    },
  ]);
});

test('list_streams fan-out tags rows and exposes meta.package.member_count', async () => {
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') return jsonResponse(200, { data: [{ name: 'repos' }, { name: 'issues' }] });
    if (req.token === 'tok_B') return jsonResponse(200, { data: [{ name: 'messages' }] });
    return jsonResponse(500, { error: 'unknown_token' });
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams');
  assert.equal(out.ok, true);
  assert.equal(out.body.data.length, 3);
  for (const row of out.body.data) assert.ok(row.source);
  assert.equal(out.body.meta.package.member_count, 2);
});

test('list_streams scoped to connection_id calls only that child', async () => {
  let aCalled = 0;
  let bCalled = 0;
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') aCalled += 1;
    if (req.token === 'tok_B') bCalled += 1;
    return jsonResponse(200, { data: [{ name: 'messages' }] });
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  await rs.getJson('/v1/streams', { query: { connection_id: 'slack_main' } });
  assert.equal(aCalled, 0);
  assert.equal(bCalled, 1);
});

test('list_streams with unknown connection_id returns not_found without fanout', async () => {
  let called = 0;
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams', { query: { connection_id: 'unknown' } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error.code, 'not_found');
  assert.equal(out.error.available_connections.length, 2);
  assert.equal(called, 0, 'unknown connection_id is rejected before touching child grants');
});

test('search fan-out merges hits across children', async () => {
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') {
      return jsonResponse(200, { data: { results: [{ id: 'a:1', title: 'Repo One' }] } });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, { data: { results: [{ id: 'b:1', title: 'Msg One' }, { id: 'b:2', title: 'Msg Two' }] } });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/search', { query: { q: 'one' } });
  assert.equal(out.ok, true);
  assert.equal(out.body.data.results.length, 3);
  for (const hit of out.body.data.results) assert.ok(hit.source);
});

test('search fan-out applies limit globally and exposes source mix', async () => {
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') {
      return jsonResponse(200, {
        data: {
          results: [
            { id: 'repo:1', stream: 'repos', title: 'Repo One' },
            { id: 'repo:2', stream: 'repos', title: 'Repo Two' },
          ],
        },
      });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, {
        data: {
          results: [
            { id: 'msg:1', stream: 'messages', title: 'Msg One' },
            { id: 'msg:2', stream: 'messages', title: 'Msg Two' },
          ],
        },
      });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/search', { query: { q: 'one', limit: 3 } });

  assert.equal(out.ok, true);
  assert.equal(out.body.data.results.length, 3, 'limit must apply to merged fan-in result, not per child');
  assert.equal(out.body.has_more, true, 'truncated merged fan-in result must advertise has_more');
  assert.deepEqual(
    out.body.data.results.map((hit) => hit.connection_id),
    ['gh_main', 'gh_main', 'slack_main'],
  );
  assert.deepEqual(out.body.meta.package.source_mix, [
    { connection_id: 'gh_main', connector_key: 'github', count: 2 },
    { connection_id: 'slack_main', connector_key: 'slack', count: 1 },
  ]);
});

test('search fan-out merges canonical list-envelope data arrays across children', async () => {
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') {
      return jsonResponse(200, {
        object: 'list',
        data: [{ object: 'search_result', record_key: 'a', connection_id: 'gh_main' }],
      });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, {
        object: 'list',
        data: [{ object: 'search_result', record_key: 'b', connection_id: 'slack_main' }],
      });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/search', { query: { q: 'one' } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.body.data.map((hit) => hit.record_key).sort(), ['a', 'b']);
  for (const hit of out.body.data) assert.ok(hit.source);
});

test('search fan-out merges nested data.data envelopes across children', async () => {
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') {
      return jsonResponse(200, { data: { data: [{ object: 'search_result', record_key: 'a' }] } });
    }
    if (req.token === 'tok_B') {
      return jsonResponse(200, { data: { data: [{ object: 'search_result', record_key: 'b' }] } });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/search', { query: { q: 'one' } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.body.data.data.map((hit) => hit.record_key).sort(), ['a', 'b']);
});

test('search fan-out intersects requested streams with each child grant', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    const streams = req.query.getAll('streams');
    calls.push({ token: req.token, streams });
    if (req.token === 'tok_A') {
      assert.deepEqual(streams, ['conversations']);
      return jsonResponse(200, {
        object: 'list',
        data: [{ object: 'search_result', stream: 'conversations', record_key: 'c1' }],
      });
    }
    if (req.token === 'tok_B') {
      assert.deepEqual(streams, ['messages']);
      return jsonResponse(200, {
        object: 'list',
        data: [{ object: 'search_result', stream: 'messages', record_key: 'm1' }],
      });
    }
    return jsonResponse(500, {});
  });
  const members = [
    { ...memberA(), grant: { streams: [{ name: 'conversations' }] } },
    { ...memberB(), grant: { streams: [{ name: 'messages' }] } },
  ];
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members, fetch });

  const out = await rs.getJson('/v1/search', {
    query: { q: 'redactable', streams: ['messages', 'conversations', 'comments'] },
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.body.data.map((hit) => hit.record_key).sort(), ['c1', 'm1']);
  assert.deepEqual(calls.map((call) => call.streams), [['conversations'], ['messages']]);
});

test('search fan-out skips children with no requested streams in their grant', async () => {
  let aCalled = 0;
  let bCalled = 0;
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') {
      aCalled += 1;
      return jsonResponse(400, { error: { type: 'permission_error', code: 'grant_stream_not_allowed' } });
    }
    if (req.token === 'tok_B') {
      bCalled += 1;
      assert.deepEqual(req.query.getAll('streams'), ['messages']);
      return jsonResponse(200, {
        object: 'list',
        data: [{ object: 'search_result', stream: 'messages', record_key: 'm1' }],
      });
    }
    return jsonResponse(500, {});
  });
  const members = [
    { ...memberA(), grant: { streams: [{ name: 'conversations' }] } },
    { ...memberB(), grant: { streams: [{ name: 'messages' }] } },
  ];
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members, fetch });

  const out = await rs.getJson('/v1/search', { query: { q: 'redactable', streams: ['messages'] } });

  assert.equal(out.ok, true);
  assert.deepEqual(out.body.data.map((hit) => hit.record_key), ['m1']);
  assert.equal(aCalled, 0);
  assert.equal(bCalled, 1);
});

test('search with unknown connection_id returns not_found without fanout', async () => {
  let called = 0;
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/search', { query: { q: 'one', connection_id: 'unknown' } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error.code, 'not_found');
  assert.equal(out.error.available_connections.length, 2);
  assert.equal(called, 0, 'unknown connection_id is rejected before touching child grants');
});

test('query_records without selector returns ambiguous_connection 409 with candidates', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, token: req.token });
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { limit: 10 } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.error.code, 'ambiguous_connection');
  assert.equal(out.error.available_connections.length, 2);
  assert.equal(out.error.available_connection_count, 2);
  assert.deepEqual(calls, [], 'ambiguity is computed from package membership without probing child grants');
});

test('query_records with connection_id routes to one child only', async () => {
  let aCalled = 0;
  let bCalled = 0;
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') aCalled += 1;
    if (req.token === 'tok_B') bCalled += 1;
    return jsonResponse(200, { data: [{ record_id: 'r1' }] });
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { connection_id: 'gh_main' } });
  assert.equal(out.ok, true);
  assert.equal(aCalled, 1);
  assert.equal(bCalled, 0);
});

test('query_records ambiguity is fast and does not probe child health', async () => {
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous read should not touch child grant ${req.token} ${req.path}`);
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { limit: 10 } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.error.code, 'ambiguous_connection');
  assert.deepEqual(out.error.available_connections.map((entry) => entry.connection_id), ['gh_main', 'slack_main']);
  assert.equal(out.error.unavailable_connections, undefined);
});

test('query_records with selected invalid child preserves the child grant_invalid response', async () => {
  let aCalled = 0;
  let bCalled = 0;
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') aCalled += 1;
    if (req.token === 'tok_B') bCalled += 1;
    if (req.token === 'tok_B' && req.path === '/v1/streams/repos/records') {
      return jsonResponse(403, {
        error: { type: 'grant_invalid', code: 'grant_invalid', message: 'Grant is no longer usable' },
      });
    }
    return jsonResponse(200, { data: [] });
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { connection_id: 'slack_main' } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.equal(out.error.code, 'grant_invalid');
  assert.equal(aCalled, 0);
  assert.equal(bCalled, 1);
});

test('query_records with unknown connection_id returns not_found', async () => {
  const fetch = makeRouter(async () => jsonResponse(200, { data: [] }));
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { connection_id: 'unknown' } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error.code, 'not_found');
});

test('fetch_blob (getRaw) requires selector and never returns multi-source default', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, token: req.token });
    return jsonResponse(200, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getRaw('/v1/blobs/blob-xyz');
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.deepEqual(calls, [], 'blob ambiguity is computed without child health probes');
});

test('create_event_subscription with multi-source package requires connection_id', async () => {
  const calls = [];
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, token: req.token });
    return jsonResponse(201, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.postJson('/v1/event-subscriptions', { body: { callback_url: 'https://x/y' } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.deepEqual(calls, [], 'event-sub ambiguity is computed without child health probes');
});

test('create_event_subscription with single-source package infers the child', async () => {
  let tokensSeen = [];
  let bodiesSeen = [];
  const fetch = makeRouter(async (req) => {
    tokensSeen.push(req.token);
    bodiesSeen.push(req.body);
    return jsonResponse(201, { subscription_id: 'sub_1', secret: 'whsec_x', status: 'pending_verification', callback_url: req.body.callback_url, created_at: '2026-05-27T00:00:00Z' });
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA()], fetch });
  const out = await rs.postJson('/v1/event-subscriptions', { body: { callback_url: 'https://x/y' } });
  assert.equal(out.ok, true);
  assert.deepEqual(tokensSeen, ['tok_A']);
  // connection_id key never forwarded to RS even if accidentally sent (single-source path doesn't pass one).
  assert.equal(bodiesSeen[0].connection_id, undefined);
});

test('create_event_subscription routes to selected child and strips connection_id from RS body', async () => {
  let tokensSeen = [];
  let bodiesSeen = [];
  const fetch = makeRouter(async (req) => {
    tokensSeen.push(req.token);
    bodiesSeen.push(req.body);
    return jsonResponse(201, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  await rs.postJson('/v1/event-subscriptions', {
    body: { callback_url: 'https://x/y', connection_id: 'slack_main' },
  });
  assert.deepEqual(tokensSeen, ['tok_B']);
  assert.equal(bodiesSeen[0].connection_id, undefined, 'PackageRsClient strips selector before forwarding');
});

test('list_event_subscriptions fans out across children and merges with source tags', async () => {
  const fetch = makeRouter(async (req) => {
    if (req.token === 'tok_A') return jsonResponse(200, { data: [{ subscription_id: 'sub_a' }] });
    if (req.token === 'tok_B') return jsonResponse(200, { data: [{ subscription_id: 'sub_b1' }, { subscription_id: 'sub_b2' }] });
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/event-subscriptions');
  assert.equal(out.ok, true);
  assert.equal(out.body.data.length, 3);
  for (const row of out.body.data) assert.ok(row.source && row.source.grant_id);
});

test('get_event_subscription locates owning child via per-member probe', async () => {
  const fetch = makeRouter(async (req) => {
    if (req.path === '/v1/event-subscriptions/sub_xyz') {
      if (req.token === 'tok_A') return jsonResponse(404, { error: { type: 'not_found', code: 'not_found' } });
      if (req.token === 'tok_B') return jsonResponse(200, { subscription_id: 'sub_xyz', status: 'active' });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/event-subscriptions/sub_xyz');
  assert.equal(out.ok, true);
  assert.equal(out.body.subscription_id, 'sub_xyz');
});

test('delete_event_subscription locates owning child and forwards under that bearer', async () => {
  let deleteTokens = [];
  const fetch = makeRouter(async (req) => {
    if (req.method === 'GET' && req.path === '/v1/event-subscriptions/sub_xyz') {
      if (req.token === 'tok_A') return jsonResponse(404, { error: { type: 'not_found' } });
      if (req.token === 'tok_B') return jsonResponse(200, { subscription_id: 'sub_xyz' });
    }
    if (req.method === 'DELETE' && req.path === '/v1/event-subscriptions/sub_xyz') {
      deleteTokens.push(req.token);
      return jsonResponse(204, null);
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.deleteJson('/v1/event-subscriptions/sub_xyz');
  assert.equal(out.ok, true);
  assert.deepEqual(deleteTokens, ['tok_B']);
});

test('unknown event subscription returns adapter not_found without touching record/RS state', async () => {
  const fetch = makeRouter(async () => jsonResponse(404, { error: { type: 'not_found' } }));
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/event-subscriptions/nope');
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error.code, 'not_found');
});

// Spec: openspec/changes/canonicalize-connector-keys/specs/agent-consent-bundling/spec.md
// available_connections entries MUST include grant_id, connector_key, connection_id (not connector_id).
// These are regression tests for task 5.3.

test('ambiguous_connection error envelope includes grant_id and connector_key (not connector_id)', async () => {
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous read should not touch child grant ${req.token} ${req.path}`);
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { limit: 10 } });
  assert.equal(out.error.code, 'ambiguous_connection');
  const conns = out.error.available_connections;
  assert.equal(conns.length, 2);
  for (const entry of conns) {
    assert.ok('grant_id' in entry, 'available_connections entry must carry grant_id');
    assert.ok('connector_key' in entry, 'available_connections entry must carry connector_key (not connector_id)');
    assert.ok('connection_id' in entry, 'available_connections entry must carry connection_id');
    assert.ok(!('connector_id' in entry), 'available_connections entry must NOT advertise connector_id');
  }
  assert.equal(conns[0].grant_id, 'grant_A');
  assert.equal(conns[0].connector_key, 'github');
  assert.equal(conns[0].connection_id, 'gh_main');
  assert.equal(conns[1].grant_id, 'grant_B');
  assert.equal(conns[1].connector_key, 'slack');
  assert.equal(conns[1].connection_id, 'slack_main');
});

test('ambiguous_connection caps large packages and points callers at schema for the full index', async () => {
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous read should not touch child grant ${req.token} ${req.path}`);
    return jsonResponse(500, {});
  });
  const members = Array.from({ length: 25 }, (_, index) => ({
    grant_id: `grant_${index}`,
    token: `tok_${index}`,
    source: { kind: 'connector', id: index % 2 === 0 ? 'slack' : 'gmail' },
    connection_id: `conn_${index}`,
  }));
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members, fetch });
  const out = await rs.getJson('/v1/streams/messages/records', { query: { limit: 10 } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.error.code, 'ambiguous_connection');
  assert.equal(out.error.available_connections.length, 12);
  assert.equal(out.error.available_connection_count, 25);
  assert.equal(out.error.available_connections_truncated, true);
  assert.equal(out.error.available_connections_omitted, 13);
  assert.match(out.error.discovery_hint, /schema/);
});

test('not_found error envelope includes grant_id and connector_key for event subscription create', async () => {
  const fetch = makeRouter(async () => jsonResponse(500, {}));
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.postJson('/v1/event-subscriptions', {
    body: { callback_url: 'https://x/y', connection_id: 'unknown_conn' },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error.code, 'not_found');
  const conns = out.error.available_connections;
  assert.equal(conns.length, 2);
  for (const entry of conns) {
    assert.ok('grant_id' in entry, 'not_found envelope must carry grant_id per member');
    assert.ok('connector_key' in entry, 'not_found envelope must carry connector_key (not connector_id)');
    assert.ok(!('connector_id' in entry), 'not_found envelope must NOT advertise connector_id');
  }
});

test('create_event_subscription ambiguous envelope carries connector_key and grant_id', async () => {
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous event-sub write should not touch child grant ${req.token} ${req.path}`);
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.postJson('/v1/event-subscriptions', { body: { callback_url: 'https://x/y' } });
  assert.equal(out.error.code, 'ambiguous_connection');
  const conns = out.error.available_connections;
  assert.equal(conns.length, 2);
  for (const entry of conns) {
    assert.ok('grant_id' in entry);
    assert.ok('connector_key' in entry);
    assert.ok(!('connector_id' in entry));
  }
});

// ---------------------------------------------------------------------------
// F1 regression — route hosted-MCP package-adapter self-calls to the internal
// base, not the public edge that 405s PATCH.
//
// Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
//
// `createPackageRsClient` takes a single `providerUrl` that becomes every
// child RsClient's fetch base. Before the fix, `handleHostedMcp` passed the
// public `resource` (the externally-fronted origin) here, so a server-internal
// PATCH self-call hairpinned through the public edge — which 405s PATCH —
// producing a typed `rs_error` `http_405`. After the fix the adapter passes the
// internal RS base (`referenceTopology.rsInternalUrl`) here while the advertised
// resource/discovery/`providerUrl` stay public; that split is exercised at the
// `createPackageRsClient` boundary below.
const PUBLIC_EDGE = 'https://pdpp.test';     // advertised resource; edge 405s PATCH
const INTERNAL_BASE = 'http://localhost:7663'; // configured internal RS; method-routes PATCH

// A 405 with no JSON body — exactly what a method-blocking reverse proxy
// returns. A non-JSON, empty body flows through rs-client's parseRsResponse →
// normalizeErrorEnvelope as the typed { type: 'rs_error', code: 'http_405' }.
function bodilessMethodNotAllowed() {
  return {
    status: 405,
    headers: {
      get(name) {
        // text/plain (not application/json) — the edge's bare 405 page.
        if (name.toLowerCase() === 'content-type') return 'text/plain';
        return null;
      },
    },
    async json() {
      throw new Error('405 page is not JSON');
    },
    async text() {
      return '';
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

// Host-aware router: the public edge 405s every PATCH; the internal base
// method-routes PATCH. GET (the locate probe) is allowed on either host.
function makeHostAwareRouter(recorder) {
  return makeRouter(async (req) => {
    const origin = req.url.origin;
    // Public edge drops PATCH regardless of path (measured behavior of the
    // external reverse proxy fronting the public origin).
    if (req.method === 'PATCH' && origin === PUBLIC_EDGE) {
      return bodilessMethodNotAllowed();
    }
    // Locate probe: GET per child to find the owning grant. tok_B owns sub_xyz.
    if (req.method === 'GET' && req.path === '/v1/event-subscriptions/sub_xyz') {
      if (req.token === 'tok_B') return jsonResponse(200, { subscription_id: 'sub_xyz', status: 'active' });
      return jsonResponse(404, { error: { type: 'not_found', code: 'not_found' } });
    }
    // The actual PATCH self-call against the internal base (method-routed).
    if (req.method === 'PATCH' && req.path === '/v1/event-subscriptions/sub_xyz' && origin === INTERNAL_BASE) {
      if (recorder) recorder.push({ origin, token: req.token, method: req.method });
      return jsonResponse(200, { subscription: { subscription_id: 'sub_xyz', status: 'disabled' } });
    }
    return jsonResponse(500, { error: { type: 'unexpected', code: 'unexpected_route' } });
  });
}

test('F1: package-token update routes PATCH to the internal base, not the public edge that 405s', async () => {
  const recorded = [];
  const fetch = makeHostAwareRouter(recorded);
  // The fix passes the INTERNAL base as the child fetch base while the
  // advertised resource stays public; here we model that by constructing the
  // client against the internal base.
  const rs = createPackageRsClient({ providerUrl: INTERNAL_BASE, members: [memberA(), memberB()], fetch });
  const out = await rs.patchJson('/v1/event-subscriptions/sub_xyz', { body: { enabled: false } });

  assert.equal(out.ok, true, 'PATCH succeeds when routed to the internal base');
  assert.equal(out.status, 200);
  // The regression guard: we did NOT inherit the public edge's 405.
  assert.notEqual(out.error?.code, 'http_405');
  // The self-call hit the internal base, not the public edge.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].origin, INTERNAL_BASE);
  assert.equal(recorded[0].method, 'PATCH');
  // Owning-child bearer preserved — no authority widening.
  assert.equal(recorded[0].token, 'tok_B');
});

test('F1 falsifiability: PATCH against the public edge yields http_405 (pre-fix behavior)', async () => {
  const fetch = makeHostAwareRouter(null);
  // Pre-fix: the adapter used the public resource as the child fetch base.
  const rs = createPackageRsClient({ providerUrl: PUBLIC_EDGE, members: [memberA(), memberB()], fetch });
  const out = await rs.patchJson('/v1/event-subscriptions/sub_xyz', { body: { enabled: false } });

  assert.equal(out.ok, false, 'PATCH fails when routed through the public edge');
  assert.equal(out.status, 405);
  assert.equal(out.error.code, 'http_405', 'public-edge PATCH surfaces the typed http_405 error');
});

test('F1 fallback parity: GET/POST/DELETE still succeed through the public base (only PATCH is edge-blocked)', async () => {
  // With the internal base unset the adapter falls back to the public resource.
  // GET/POST/DELETE pass the edge today; only PATCH is dropped — so the public
  // fallback preserves all non-PATCH behavior. Asserting GET here proves the
  // fix is needed precisely (and only) for the method the edge blocks.
  let getProbes = 0;
  let deletes = 0;
  const fetch = makeRouter(async (req) => {
    const origin = req.url.origin;
    if (req.method === 'PATCH' && origin === PUBLIC_EDGE) return bodilessMethodNotAllowed();
    if (req.method === 'GET' && req.path === '/v1/event-subscriptions/sub_xyz') {
      getProbes += 1;
      if (req.token === 'tok_B') return jsonResponse(200, { subscription_id: 'sub_xyz', status: 'active' });
      return jsonResponse(404, { error: { type: 'not_found', code: 'not_found' } });
    }
    if (req.method === 'DELETE' && req.path === '/v1/event-subscriptions/sub_xyz') {
      deletes += 1;
      return jsonResponse(204, null);
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PUBLIC_EDGE, members: [memberA(), memberB()], fetch });

  const got = await rs.getJson('/v1/event-subscriptions/sub_xyz');
  assert.equal(got.ok, true, 'GET passes the public edge (fallback parity)');
  assert.ok(getProbes >= 1);

  const deleted = await rs.deleteJson('/v1/event-subscriptions/sub_xyz');
  assert.equal(deleted.ok, true, 'DELETE passes the public edge (fallback parity)');
  assert.equal(deletes, 1);
});

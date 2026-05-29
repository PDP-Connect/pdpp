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
  let called = 0;
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { limit: 10 } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.error.code, 'ambiguous_connection');
  assert.equal(out.error.available_connections.length, 2);
  assert.equal(called, 0, 'no child token is called when the package is ambiguous');
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

test('query_records with unknown connection_id returns not_found', async () => {
  const fetch = makeRouter(async () => jsonResponse(200, { data: [] }));
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getJson('/v1/streams/repos/records', { query: { connection_id: 'unknown' } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.error.code, 'not_found');
});

test('fetch_blob (getRaw) requires selector and never returns multi-source default', async () => {
  let called = 0;
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(200, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.getRaw('/v1/blobs/blob-xyz');
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(called, 0);
});

test('create_event_subscription with multi-source package requires connection_id', async () => {
  let called = 0;
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(201, {});
  });
  const rs = createPackageRsClient({ providerUrl: PROVIDER, members: [memberA(), memberB()], fetch });
  const out = await rs.postJson('/v1/event-subscriptions', { body: { callback_url: 'https://x/y' } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(called, 0, 'no child is called without a selector');
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
  const fetch = makeRouter(async () => jsonResponse(500, {}));
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
  const fetch = makeRouter(async () => jsonResponse(500, {}));
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

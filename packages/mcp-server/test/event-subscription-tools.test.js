import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

/**
 * Fake RS that knows the six client event-subscription endpoints. Stores nothing —
 * it just records every inbound request so tests can assert method/path/body/auth and
 * then returns a canned response. Errors are surfaced via the typed RS envelope so the
 * MCP error-passthrough path is exercised.
 */
function makeFakeRs(overrides = {}) {
  const calls = [];
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    const auth = init.headers?.Authorization;
    let parsedBody;
    if (init.body) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({
      url: url.toString(),
      pathname: url.pathname,
      method: init.method ?? 'GET',
      auth,
      body: parsedBody,
      contentType: init.headers?.['Content-Type'],
    });

    // RFC 9728 protected-resource metadata is public. Serve the canned
    // advertisement before the bearer check so the discovery tool exercises
    // the unauthenticated path.
    if (url.pathname === '/.well-known/oauth-protected-resource' && (init.method === 'GET' || !init.method)) {
      if (overrides[`GET ${url.pathname}`]) {
        return overrides[`GET ${url.pathname}`](url, init, parsedBody);
      }
      return jsonResponse({
        resource: 'https://provider.test',
        issuer: 'https://provider.test',
        capabilities: {
          client_event_subscriptions: {
            supported: true,
            stability: 'reference_extension',
            scope: 'reference_implementation',
            endpoint: '/v1/event-subscriptions',
            envelope: { format: 'cloudevents+json', specversion: '1.0' },
            signing: { profile: 'standard-webhooks', algorithm: 'HMAC-SHA256' },
            event_types: ['pdpp.subscription.verify', 'pdpp.subscription.test', 'pdpp.records.changed', 'pdpp.grant.revoked'],
            hint_cursor_location: 'data.changes_since',
            callback_url: { max_bytes: 2048, requires_https: true, localhost_dev_allowed: true },
            retry: { schedule: ['1m', '5m', '30m', '2h', '24h'], max_attempts: 12 },
          },
        },
      });
    }

    if (auth !== 'Bearer scoped-token') {
      return jsonResponse(
        { error: { type: 'authentication', code: 'invalid_token', message: 'bad token' } },
        401
      );
    }

    if (overrides[`${init.method ?? 'GET'} ${url.pathname}`]) {
      return overrides[`${init.method ?? 'GET'} ${url.pathname}`](url, init, parsedBody);
    }

    if (url.pathname === '/v1/event-subscriptions' && init.method === 'POST') {
      if (typeof parsedBody?.callback_url !== 'string' || parsedBody.callback_url.startsWith('http://example')) {
        return jsonResponse(
          {
            error: {
              type: 'invalid_request',
              code: 'invalid_request',
              message: 'callback_url must use https:// (http://localhost permitted for development)',
            },
          },
          400
        );
      }
      return jsonResponse(
        {
          subscription_id: 'sub_abc123',
          secret: 'whsec_dGVzdHNlY3JldA==',
          status: 'pending_verification',
          callback_url: parsedBody.callback_url,
          created_at: '2026-05-28T00:00:00.000Z',
        },
        201
      );
    }
    if (url.pathname === '/v1/event-subscriptions' && (init.method === 'GET' || !init.method)) {
      return jsonResponse({
        data: [
          {
            subscription_id: 'sub_abc123',
            grant_id: 'g_one',
            client_id: 'c_one',
            callback_url: 'https://example.test/hook',
            status: 'active',
            scope: { source: 'rest', streams: [{ name: 'orders' }] },
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
            disabled_reason: null,
          },
        ],
      });
    }
    if (url.pathname === '/v1/event-subscriptions/sub_abc123' && (init.method === 'GET' || !init.method)) {
      return jsonResponse({
        subscription_id: 'sub_abc123',
        grant_id: 'g_one',
        client_id: 'c_one',
        callback_url: 'https://example.test/hook',
        status: 'active',
        scope: { source: 'rest', streams: [{ name: 'orders' }] },
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
        disabled_reason: null,
      });
    }
    if (url.pathname === '/v1/event-subscriptions/sub_abc123' && init.method === 'PATCH') {
      return jsonResponse({
        subscription: {
          subscription_id: 'sub_abc123',
          status: parsedBody?.enabled === false ? 'disabled' : 'active',
          callback_url: 'https://example.test/hook',
          updated_at: '2026-05-28T00:00:01.000Z',
        },
        ...(parsedBody?.rotate_secret === true ? { secret: 'whsec_bmV3c2VjcmV0' } : {}),
      });
    }
    if (url.pathname === '/v1/event-subscriptions/sub_abc123' && init.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/v1/event-subscriptions/sub_abc123/test-event' && init.method === 'POST') {
      return jsonResponse({ event_id: 'evt_xyz' }, 202);
    }
    if (url.pathname === '/v1/event-subscriptions/sub_missing' && init.method === 'GET') {
      return jsonResponse(
        {
          error: { type: 'not_found', code: 'not_found', message: 'subscription not found' },
        },
        404
      );
    }

    return jsonResponse(
      {
        error: {
          type: 'rs_error',
          code: 'unknown',
          message: `Fake RS does not implement ${init.method ?? 'GET'} ${url.pathname}`,
        },
      },
      404
    );
  };
  return { fetch, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
  });
}

async function connectClient(fetch) {
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('tools/list exposes all six event-subscription tools alongside read tools', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of [
      'create_event_subscription',
      'list_event_subscriptions',
      'get_event_subscription',
      'update_event_subscription',
      'delete_event_subscription',
      'send_test_event',
    ]) {
      assert.ok(names.includes(expected), `missing ${expected} in ${JSON.stringify(names)}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('annotations encode side effects honestly', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const tools = await client.listTools();
    const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));

    // Read tools
    for (const readName of ['list_event_subscriptions', 'get_event_subscription']) {
      const tool = byName[readName];
      assert.equal(tool.annotations?.readOnlyHint, true, `${readName} readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${readName} destructiveHint`);
      assert.equal(tool.annotations?.idempotentHint, true, `${readName} idempotentHint`);
      assert.equal(tool.annotations?.openWorldHint, false, `${readName} openWorldHint`);
    }

    // Mutating, non-destructive, non-idempotent
    for (const writeName of ['create_event_subscription', 'update_event_subscription', 'send_test_event']) {
      const tool = byName[writeName];
      assert.equal(tool.annotations?.readOnlyHint, false, `${writeName} readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${writeName} destructiveHint`);
      assert.equal(tool.annotations?.idempotentHint, false, `${writeName} idempotentHint`);
      assert.equal(tool.annotations?.openWorldHint, false, `${writeName} openWorldHint`);
    }

    // Delete is destructive but idempotent (delete of a deleted subscription is a no-op).
    const del = byName.delete_event_subscription;
    assert.equal(del.annotations?.readOnlyHint, false);
    assert.equal(del.annotations?.destructiveHint, true);
    assert.equal(del.annotations?.idempotentHint, true);
    assert.equal(del.annotations?.openWorldHint, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('create_event_subscription forwards POST with scoped bearer and JSON body', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'create_event_subscription',
      arguments: { callback_url: 'https://example.test/hook' },
    });
    assert.equal(result.isError, undefined);

    const call = calls.find((c) => c.method === 'POST' && c.pathname === '/v1/event-subscriptions');
    assert.ok(call, 'must POST /v1/event-subscriptions');
    assert.equal(call.auth, 'Bearer scoped-token');
    assert.equal(call.contentType, 'application/json');
    assert.deepEqual(call.body, { callback_url: 'https://example.test/hook' });

    assert.equal(result.structuredContent.data.subscription_id, 'sub_abc123');
    assert.ok(
      typeof result.structuredContent.data.secret === 'string' &&
        result.structuredContent.data.secret.startsWith('whsec_'),
      'must surface whsec_-prefixed secret'
    );
    assert.equal(result.structuredContent.http_status, 201);
    assert.equal(result.structuredContent.provider_url, 'https://provider.test');
    assert.equal(result.structuredContent.request_id, 'req_test');
  } finally {
    await client.close();
    await server.close();
  }
});

test('create_event_subscription surfaces the one-time secret verbatim in tool text', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'create_event_subscription',
      arguments: { callback_url: 'https://example.test/hook' },
    });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    // The literal secret must appear so a chat agent that cannot read
    // structuredContent can still relay it to the receiver.
    assert.match(text, /one_time_secret=whsec_dGVzdHNlY3JldA==/);
    // And the text must say it is returned once and should be stored now.
    assert.match(text, /returned once/);
    assert.match(text, /store it/);
    // Structured envelope stays canonical.
    assert.equal(result.structuredContent.data.secret, 'whsec_dGVzdHNlY3JldA==');
  } finally {
    await client.close();
    await server.close();
  }
});

test('create_event_subscription forwards optional filters.streams body field', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    await client.callTool({
      name: 'create_event_subscription',
      arguments: {
        callback_url: 'https://example.test/hook',
        filters: { streams: ['orders', 'emails'] },
      },
    });
    const call = calls.find((c) => c.method === 'POST' && c.pathname === '/v1/event-subscriptions');
    assert.deepEqual(call.body, {
      callback_url: 'https://example.test/hook',
      filters: { streams: ['orders', 'emails'] },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test('create_event_subscription preserves typed invalid_request error envelope', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'create_event_subscription',
      arguments: { callback_url: 'http://example.com/insecure' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.type, 'invalid_request');
    assert.equal(result.structuredContent.error.code, 'invalid_request');
    assert.match(result.structuredContent.error.message, /https/);
    assert.equal(result.structuredContent.http_status, 400);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.pathname === '/v1/event-subscriptions').length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('list_event_subscriptions forwards GET /v1/event-subscriptions', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({ name: 'list_event_subscriptions', arguments: {} });
    assert.equal(result.isError, undefined);
    const call = calls.find((c) => c.pathname === '/v1/event-subscriptions' && c.method === 'GET');
    assert.ok(call, 'must GET /v1/event-subscriptions');
    assert.equal(call.auth, 'Bearer scoped-token');
    assert.equal(result.structuredContent.data.data.length, 1);
    assert.equal(result.structuredContent.data.data[0].subscription_id, 'sub_abc123');
  } finally {
    await client.close();
    await server.close();
  }
});

test('get_event_subscription forwards GET with subscription_id', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'get_event_subscription',
      arguments: { subscription_id: 'sub_abc123' },
    });
    assert.equal(result.isError, undefined);
    const call = calls.find((c) => c.pathname === '/v1/event-subscriptions/sub_abc123' && c.method === 'GET');
    assert.ok(call);
    assert.equal(result.structuredContent.data.subscription_id, 'sub_abc123');
  } finally {
    await client.close();
    await server.close();
  }
});

test('get_event_subscription propagates 404 not_found envelope', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'get_event_subscription',
      arguments: { subscription_id: 'sub_missing' },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'not_found');
    assert.equal(result.structuredContent.http_status, 404);
  } finally {
    await client.close();
    await server.close();
  }
});

test('get_event_subscription rejects path-traversal subscription_id before any HTTP call', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'get_event_subscription',
      arguments: { subscription_id: '../escape' },
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0, 'must not hit RS for unsafe subscription_id');
  } finally {
    await client.close();
    await server.close();
  }
});

test('update_event_subscription forwards PATCH with enabled and rotate_secret', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'update_event_subscription',
      arguments: { subscription_id: 'sub_abc123', enabled: false, rotate_secret: true },
    });
    assert.equal(result.isError, undefined);
    const call = calls.find((c) => c.pathname === '/v1/event-subscriptions/sub_abc123' && c.method === 'PATCH');
    assert.ok(call);
    assert.deepEqual(call.body, { enabled: false, rotate_secret: true });
    assert.equal(result.structuredContent.data.subscription.status, 'disabled');
    assert.ok(result.structuredContent.data.secret.startsWith('whsec_'));
    // Rotation returns a fresh secret nested beside the `subscription`
    // projection; the literal rotated value must reach the tool text.
    const text = result.content[0].text;
    assert.match(text, /one_time_secret=whsec_bmV3c2VjcmV0/);
    assert.match(text, /returned once/);
    // The nested subscription_id/status are still surfaced for context.
    assert.match(text, /subscription_id=sub_abc123/);
    assert.match(text, /status=disabled/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('update_event_subscription omits unset fields from body', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    await client.callTool({
      name: 'update_event_subscription',
      arguments: { subscription_id: 'sub_abc123', enabled: true },
    });
    const call = calls.find((c) => c.pathname === '/v1/event-subscriptions/sub_abc123' && c.method === 'PATCH');
    assert.deepEqual(call.body, { enabled: true });
  } finally {
    await client.close();
    await server.close();
  }
});

test('non-secret subscription responses never invent a whsec_ placeholder in tool text', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const results = [
      await client.callTool({ name: 'list_event_subscriptions', arguments: {} }),
      await client.callTool({
        name: 'get_event_subscription',
        arguments: { subscription_id: 'sub_abc123' },
      }),
      // Non-rotating update: RS returns no `secret`, so neither should the text.
      await client.callTool({
        name: 'update_event_subscription',
        arguments: { subscription_id: 'sub_abc123', enabled: true },
      }),
      await client.callTool({
        name: 'send_test_event',
        arguments: { subscription_id: 'sub_abc123' },
      }),
      await client.callTool({
        name: 'delete_event_subscription',
        arguments: { subscription_id: 'sub_abc123' },
      }),
    ];
    for (const r of results) {
      assert.equal(r.isError, undefined);
      assert.doesNotMatch(r.content[0].text, /whsec_/, 'must not expose a secret placeholder');
      assert.doesNotMatch(r.content[0].text, /one_time_secret/, 'must not claim a one-time secret');
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('delete_event_subscription forwards DELETE and surfaces 204 without synthetic body', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'delete_event_subscription',
      arguments: { subscription_id: 'sub_abc123' },
    });
    assert.equal(result.isError, undefined);
    const call = calls.find((c) => c.pathname === '/v1/event-subscriptions/sub_abc123' && c.method === 'DELETE');
    assert.ok(call);
    assert.equal(call.auth, 'Bearer scoped-token');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.http_status, 204);
    assert.match(result.content[0].text, /204 No Content/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('send_test_event forwards POST /:id/test-event and returns event_id', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'send_test_event',
      arguments: { subscription_id: 'sub_abc123' },
    });
    assert.equal(result.isError, undefined);
    const call = calls.find(
      (c) => c.pathname === '/v1/event-subscriptions/sub_abc123/test-event' && c.method === 'POST'
    );
    assert.ok(call);
    assert.deepEqual(call.body, {});
    assert.equal(result.structuredContent.data.event_id, 'evt_xyz');
    assert.equal(result.structuredContent.http_status, 202);
  } finally {
    await client.close();
    await server.close();
  }
});

test('subscription tools never leak the bearer token in tool output', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const calls = [
      await client.callTool({
        name: 'create_event_subscription',
        arguments: { callback_url: 'https://example.test/hook' },
      }),
      await client.callTool({ name: 'list_event_subscriptions', arguments: {} }),
      await client.callTool({
        name: 'get_event_subscription',
        arguments: { subscription_id: 'sub_abc123' },
      }),
      await client.callTool({
        name: 'update_event_subscription',
        arguments: { subscription_id: 'sub_abc123', enabled: false },
      }),
      await client.callTool({
        name: 'delete_event_subscription',
        arguments: { subscription_id: 'sub_abc123' },
      }),
      await client.callTool({
        name: 'send_test_event',
        arguments: { subscription_id: 'sub_abc123' },
      }),
    ];
    for (const r of calls) {
      const serialized = JSON.stringify(r);
      assert.equal(serialized.includes('scoped-token'), false, 'token leaked in tool output');
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('subscription tool descriptions are static (no manifest interpolation)', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const tools = await client.listTools();
    const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
    for (const name of [
      'create_event_subscription',
      'list_event_subscriptions',
      'get_event_subscription',
      'update_event_subscription',
      'delete_event_subscription',
      'send_test_event',
    ]) {
      const desc = byName[name].description;
      assert.ok(desc && desc.length > 60, `${name} must have a substantive description`);
      // Receiver constraints surfaced for LLM efficiency.
      assert.ok(/HTTPS|https/.test(desc) || name.startsWith('get_') || name === 'list_event_subscriptions' || name === 'delete_event_subscription', `${name} should mention HTTPS receiver constraint`);
    }
    // Every write tool must point at the protected-resource metadata for authoritative wire shape.
    for (const name of [
      'create_event_subscription',
      'update_event_subscription',
      'send_test_event',
    ]) {
      assert.match(byName[name].description, /capabilities\.client_event_subscriptions/);
    }
    // Every write tool must explain events-vs-polling so an agent does not
    // default to subscriptions for one-shot reads.
    for (const name of [
      'create_event_subscription',
      'update_event_subscription',
      'send_test_event',
    ]) {
      assert.match(byName[name].description, /polling|query_records.*changes_since/);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('discover_event_subscription_capabilities returns capability block when advertised', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({ name: 'discover_event_subscription_capabilities', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.supported, true);
    assert.equal(result.structuredContent.capability.endpoint, '/v1/event-subscriptions');
    assert.deepEqual(result.structuredContent.capability.event_types, [
      'pdpp.subscription.verify',
      'pdpp.subscription.test',
      'pdpp.records.changed',
      'pdpp.grant.revoked',
    ]);
    assert.equal(result.structuredContent.http_status, 200);
    const lastCall = calls.at(-1);
    assert.equal(lastCall.method, 'GET');
    assert.equal(lastCall.pathname, '/.well-known/oauth-protected-resource');
  } finally {
    await client.close();
    await server.close();
  }
});

test('discover_event_subscription_capabilities surfaces supported=false when capability absent', async () => {
  const { fetch } = makeFakeRs({
    'GET /.well-known/oauth-protected-resource': () =>
      new Response(
        JSON.stringify({ resource: 'https://provider.test', issuer: 'https://provider.test', capabilities: {} }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' } }
      ),
  });
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({ name: 'discover_event_subscription_capabilities', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.supported, false);
    assert.equal(result.structuredContent.capability, null);
    assert.match(result.content[0].text, /NOT advertised|polling/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('discover_event_subscription_capabilities propagates RS error envelope', async () => {
  const { fetch } = makeFakeRs({
    'GET /.well-known/oauth-protected-resource': () =>
      new Response(
        JSON.stringify({ error: { type: 'untrusted_host', code: 'untrusted_host', message: 'host not allowed' } }),
        { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' } }
      ),
  });
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({ name: 'discover_event_subscription_capabilities', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'untrusted_host');
    assert.equal(result.structuredContent.http_status, 400);
  } finally {
    await client.close();
    await server.close();
  }
});

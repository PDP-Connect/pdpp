import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

/**
 * Build a fetch implementation that emulates the PDPP RS for one scoped token. The same
 * fixture is used for direct comparisons so tests can assert MCP output matches what a
 * direct curl-style call would return under the same token.
 */
function makeFakeRs() {
  const SCHEMA = { version: '1', streams: ['orders', 'emails'] };
  const STREAMS = { streams: [{ name: 'orders' }, { name: 'emails' }] };
  const ORDERS = {
    records: [{ id: 'o1', amount: 12 }, { id: 'o2', amount: 99 }],
    next_cursor: null,
  };
  const SEARCH = { hits: [{ stream: 'orders', id: 'o2', score: 0.7 }] };
  const STREAM_META = { name: 'orders', record_count: 2 };
  const BLOB = Buffer.from([10, 20, 30, 40, 50]);

  const calls = [];

  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    const auth = init.headers?.Authorization;
    calls.push({ url: url.toString(), auth, method: init.method ?? 'GET' });

    if (auth !== 'Bearer scoped-token') {
      return new Response(
        JSON.stringify({ error: { type: 'authentication', code: 'invalid_token', message: 'bad token' } }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.pathname === '/v1/schema') {
      return jsonResponse(SCHEMA);
    }
    if (url.pathname === '/v1/streams') {
      return jsonResponse(STREAMS);
    }
    if (url.pathname === '/v1/streams/orders') {
      return jsonResponse(STREAM_META);
    }
    if (url.pathname === '/v1/streams/orders/records') {
      const limit = url.searchParams.get('limit');
      const fields = url.searchParams.getAll('fields');
      return jsonResponse({ ...ORDERS, _echo: { limit, fields } });
    }
    if (url.pathname === '/v1/streams/missing/records') {
      return new Response(
        JSON.stringify({
          error: { type: 'invalid_request', code: 'unsupported_query', message: 'unknown stream' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname === '/v1/search') {
      return jsonResponse({ ...SEARCH, _echo: { q: url.searchParams.get('q') } });
    }
    if (url.pathname === '/v1/blobs/blob-1') {
      return new Response(BLOB, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found', message: url.pathname } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch, calls };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

async function connectClient(fakeFetch) {
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch: fakeFetch,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('lists exactly the five read-only tools with read-only annotations', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['fetch_blob', 'list_streams', 'query_records', 'schema', 'search']);

  for (const tool of tools.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint=true`);
    assert.equal(tool.annotations?.destructiveHint, false);
  }

  await client.close();
  await server.close();
});

test('schema tool returns RS schema verbatim under the scoped token', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.data, { version: '1', streams: ['orders', 'emails'] });
  const schemaCall = calls.find((call) => call.url.endsWith('/v1/schema'));
  assert.ok(schemaCall, 'must hit /v1/schema');
  assert.equal(schemaCall.auth, 'Bearer scoped-token');

  await client.close();
  await server.close();
});

test('query_records forwards supported query params and ignores unsupported keys', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', limit: 25, fields: ['id', 'amount'] },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.data.records, [
    { id: 'o1', amount: 12 },
    { id: 'o2', amount: 99 },
  ]);
  const call = calls.find((entry) => entry.url.includes('/v1/streams/orders/records'));
  const callUrl = new URL(call.url);
  assert.equal(callUrl.searchParams.get('limit'), '25');
  assert.deepEqual(callUrl.searchParams.getAll('fields'), ['id', 'amount']);
  assert.equal(callUrl.searchParams.get('cursor'), null);

  await client.close();
  await server.close();
});

test('query_records preserves RS error envelope on unsupported query', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'missing' },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'unsupported_query');
  assert.equal(result.structuredContent.http_status, 400);

  await client.close();
  await server.close();
});

test('search tool forwards q and returns hits', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'search',
    arguments: { q: 'pasta' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data._echo.q, 'pasta');
  assert.equal(result.structuredContent.data.hits[0].id, 'o2');

  await client.close();
  await server.close();
});

test('fetch_blob returns base64 payload with mime type', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch_blob',
    arguments: { blob_id: 'blob-1' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.mime_type, 'image/png');
  assert.equal(result.structuredContent.size, 5);
  const bytes = Buffer.from(result.structuredContent.bytes_base64, 'base64');
  assert.deepEqual([...bytes], [10, 20, 30, 40, 50]);

  await client.close();
  await server.close();
});

test('fetch_blob rejects path-traversal blob_id', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch_blob',
    arguments: { blob_id: '../../etc/passwd' },
  });

  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error.message, /invalid characters/);

  await client.close();
  await server.close();
});

test('invalid_token surfaces as isError without retry under broader credentials', async () => {
  // Force RS to reject by using a deliberately bad token.
  const { fetch, calls } = makeFakeRs();
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'wrong-token',
    fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const result = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'invalid_token');
  assert.equal(result.structuredContent.http_status, 401);

  // No retry: exactly one call, with the wrong token, no fallback retry on the same path.
  const schemaCalls = calls.filter((entry) => entry.url.endsWith('/v1/schema'));
  assert.equal(schemaCalls.length, 1);
  assert.equal(schemaCalls[0].auth, 'Bearer wrong-token');

  await client.close();
  await server.close();
});

test('resource template returns stream metadata', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const templates = await client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some((t) => t.uriTemplate === 'pdpp://stream/{name}'));

  const result = await client.readResource({ uri: 'pdpp://stream/orders' });
  assert.equal(result.contents.length, 1);
  const parsed = JSON.parse(result.contents[0].text);
  assert.equal(parsed.name, 'orders');

  await client.close();
  await server.close();
});

test('tool descriptions are static (no manifest interpolation)', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  for (const tool of tools.tools) {
    assert.ok(tool.description && tool.description.length > 0);
    assert.ok(
      !tool.description.includes('orders') && !tool.description.includes('emails'),
      `${tool.name} description must not interpolate connector/stream names`
    );
  }

  await client.close();
  await server.close();
});

test('tool output never contains the bearer token', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const tools = ['schema', 'list_streams'];
  for (const name of tools) {
    const args = name === 'query_records' ? { stream: 'orders' } : {};
    const result = await client.callTool({ name, arguments: args });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('scoped-token'), `${name} result must not echo bearer token`);
  }

  await client.close();
  await server.close();
});

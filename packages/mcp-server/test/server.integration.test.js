import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer, handleStreamableHttpRequest } from '../src/server.js';

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
  const SEARCH = {
    hits: [
      {
        stream: 'orders',
        id: 'o2',
        title: 'Order o2',
        url: 'https://merchant.test/o2',
        score: 0.7,
      },
    ],
  };
  const ORDER_O2 = {
    id: 'o2',
    stream: 'orders',
    title: 'Order o2',
    text: 'Pasta order for $99.',
    url: 'https://merchant.test/o2',
    metadata: { amount: 99 },
  };
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
    if (url.pathname === '/v1/streams/orders/records/o2') {
      return jsonResponse(ORDER_O2);
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

function makeDiscoveryFakeRs() {
  const fieldCapability = ({
    type,
    granted = true,
    exact = false,
    rangeOps = null,
    lexical = false,
    semantic = false,
    aggregations = [],
  }) => ({
    ...(type ? { type } : {}),
    schema: { type: type === 'timestamp' ? 'string' : type || 'string' },
    granted,
    exact_filter: { declared: exact, usable: exact && granted },
    range_filter: rangeOps
      ? { declared: true, usable: granted, operators: rangeOps }
      : { declared: false, usable: false },
    lexical_search: { declared: lexical, usable: lexical && granted },
    semantic_search: { declared: semantic, usable: semantic && granted },
    aggregation: Object.fromEntries(
      ['sum', 'min', 'max', 'group_by', 'group_by_time', 'count_distinct'].map((name) => [
        name,
        { declared: aggregations.includes(name), usable: granted && aggregations.includes(name) },
      ]),
    ),
  });

  const SCHEMA = {
    data: {
      object: 'schema',
      connector_count: 1,
      stream_count: 1,
      connectors: [
        {
          object: 'connector',
          connector_id: 'claude-code',
          source: { kind: 'connector', id: 'claude-code', display_name: 'Claude Code' },
          stream_count: 1,
          streams: [
            {
              object: 'stream_metadata',
              name: 'conversations',
              granted_connections: [{ connection_id: 'conn_work', display_name: 'Work Claude' }],
              field_capabilities: {
                id: fieldCapability({ type: 'string', exact: true }),
                created_at: fieldCapability({
                  type: 'timestamp',
                  rangeOps: ['gte', 'lt'],
                  aggregations: ['group_by_time'],
                }),
                title: fieldCapability({ type: 'text', lexical: true, semantic: true }),
              },
              expand_capabilities: [],
            },
          ],
        },
      ],
    },
  };
  const STREAMS = {
    object: 'list',
    data: [
      {
        object: 'stream',
        name: 'conversations',
        record_count: 12,
        connection_id: 'conn_work',
        display_name: 'Work Claude',
        source: {
          grant_id: 'grant_pkg_1',
          connector_key: 'claude-code',
          connection_id: 'conn_work',
          display_name: 'Work Claude',
        },
      },
      {
        object: 'stream',
        name: 'messages',
        record_count: 5,
        connection_id: 'conn_personal',
        display_name: 'Personal Claude',
        source: {
          grant_id: 'grant_pkg_2',
          connector_key: 'claude-code',
          connection_id: 'conn_personal',
          display_name: 'Personal Claude',
        },
      },
    ],
  };

  const fetch = async (urlInput) => {
    const url = new URL(urlInput.toString());
    if (url.pathname === '/v1/schema') {
      return jsonResponse(SCHEMA);
    }
    if (url.pathname === '/v1/streams') {
      return jsonResponse(STREAMS);
    }
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found', message: url.pathname } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch, schemaBody: SCHEMA, streamsBody: STREAMS };
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

test('lists the expected tools and annotates read-only tools as read-only', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'aggregate',
    'create_event_subscription',
    'delete_event_subscription',
    'discover_event_subscription_capabilities',
    'fetch',
    'fetch_blob',
    'get_event_subscription',
    'list_event_subscriptions',
    'list_streams',
    'query_records',
    'schema',
    'search',
    'send_test_event',
    'update_event_subscription',
  ]);

  const READ_ONLY = new Set([
    'aggregate',
    'schema',
    'list_streams',
    'query_records',
    'search',
    'fetch',
    'fetch_blob',
    'list_event_subscriptions',
    'get_event_subscription',
    'discover_event_subscription_capabilities',
  ]);
  for (const tool of tools.tools) {
    if (READ_ONLY.has(tool.name)) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint=true`);
      assert.equal(tool.annotations?.destructiveHint, false);
    } else {
      assert.equal(tool.annotations?.readOnlyHint, false, `${tool.name} must be readOnlyHint=false`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} must be openWorldHint=false`);
    }
  }

  await client.close();
  await server.close();
});

test('schema tool returns RS schema verbatim under the scoped token with detail=full', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: { detail: 'full' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.data, { version: '1', streams: ['orders', 'emails'] });
  const schemaCall = calls.find((call) => call.url.endsWith('/v1/schema'));
  assert.ok(schemaCall, 'must hit /v1/schema');
  assert.equal(schemaCall.auth, 'Bearer scoped-token');

  await client.close();
  await server.close();
});

test('discovery tools include parseable stream and schema facts in text content', async () => {
  const { fetch, streamsBody } = makeDiscoveryFakeRs();
  const { client, server } = await connectClient(fetch);

  const schemaResult = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(schemaResult.isError, undefined);
  // Default detail is compact: each field collapses to a terse capability flag
  // string (type, grant, usable filter/search/aggregation flags) — the raw
  // per-field JSON Schema and verbose {declared,usable} sub-objects are dropped.
  // Connection identity and connector metadata survive.
  const compactConnector = schemaResult.structuredContent.data.data.connectors[0];
  const compactStream = compactConnector.streams[0];
  assert.equal(typeof compactStream.field_capabilities.id, 'string', 'compact schema field is a terse flag string');
  assert.match(compactStream.field_capabilities.id, /t=string/, 'compact flag string keeps declared field type');
  assert.match(compactStream.field_capabilities.id, /(^|,)eq(,|$)/, 'compact flag string keeps usable capability flags');
  assert.match(
    compactStream.field_capabilities.created_at,
    /r=gte\|lt/,
    'compact flag string keeps usable range operators',
  );
  assert.deepEqual(
    compactConnector.granted_connections,
    [{ connection_id: 'conn_work', display_name: 'Work Claude' }],
    'compact schema must preserve shared connection identity at connector level',
  );
  assert.equal(compactStream.granted_connections, undefined, 'compact schema must not repeat shared connection identity per stream');
  assert.equal(schemaResult.structuredContent.data.data.detail, 'compact');
  const schemaText = schemaResult.content[0].text;
  assert.match(schemaText, /PDPP schema: connectors=1 streams=1/);
  assert.match(schemaText, /stream name="conversations"/);
  assert.match(schemaText, /connector_key="claude-code"/);
  assert.match(schemaText, /display_name="Claude Code"/);
  assert.match(schemaText, /connections=\{connection_id:conn_work,display_name:Work_Claude\}/);
  assert.match(schemaText, /id\[t=string,eq\]/);
  assert.match(schemaText, /created_at\[t=timestamp,r=gte\|lt,a=group_by_time\]/);
  assert.doesNotMatch(schemaText, /See structuredContent\.data/);

  const streamsResult = await client.callTool({ name: 'list_streams', arguments: {} });
  assert.equal(streamsResult.isError, undefined);
  assert.deepEqual(streamsResult.structuredContent.data, streamsBody);
  const streamsText = streamsResult.content[0].text;
  assert.match(streamsText, /PDPP streams: 2 stream\(s\)/);
  assert.match(streamsText, /stream name="conversations" connection_id="conn_work" connector_key="claude-code" display_name="Work Claude" record_count=12/);
  assert.match(streamsText, /stream name="messages" connection_id="conn_personal" connector_key="claude-code" display_name="Personal Claude" record_count=5/);
  assert.doesNotMatch(streamsText, /See structuredContent\.data/);

  await client.close();
  await server.close();
});

test('query_records forwards supported query params', async () => {
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
  assert.match(result.content[0].text, /records from stream "orders": 2 record\(s\)/);
  assert.match(result.content[0].text, /record\[0\] \{"id":"o1","amount":12\}/);
  assert.match(result.content[0].text, /record\[1\] \{"id":"o2","amount":99\}/);
  const call = calls.find((entry) => entry.url.includes('/v1/streams/orders/records'));
  const callUrl = new URL(call.url);
  assert.equal(callUrl.searchParams.get('limit'), '25');
  assert.deepEqual(callUrl.searchParams.getAll('fields'), ['id', 'amount']);
  assert.equal(callUrl.searchParams.get('cursor'), null);

  await client.close();
  await server.close();
});

test('query_records rejects unsupported MCP arguments before hitting RS', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', unsupported_extra: true },
  });

  assert.equal(result.isError, true);
  assert.equal(calls.some((entry) => entry.url.includes('/v1/streams/orders/records')), false);
  assert.match(result.content[0].text, /unsupported_extra|Unrecognized key/);

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
  assert.deepEqual(result.structuredContent.results, [
    { id: 'orders:o2', title: 'Order o2', url: 'https://merchant.test/o2' },
  ]);
  // Prose content is a concise summary, not a JSON dump.
  assert.match(result.content[0].text, /search: 1 hit/i);
  assert.match(result.content[0].text, /structuredContent/);

  await client.close();
  await server.close();
});

test('fetch tool returns ChatGPT-compatible document shape', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'orders:o2' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.id, 'orders:o2');
  assert.equal(result.structuredContent.title, 'Order o2');
  assert.equal(result.structuredContent.text, 'Pasta order for $99.');
  assert.equal(result.structuredContent.url, 'https://merchant.test/o2');
  assert.deepEqual(result.structuredContent.metadata.amount, 99);
  assert.ok(calls.some((entry) => entry.url.endsWith('/v1/streams/orders/records/o2')));

  await client.close();
  await server.close();
});

test('fetch tool rejects path-traversal result ids before hitting RS', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'orders:../../etc/passwd' },
  });

  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error.message, /invalid characters/);
  assert.equal(calls.some((entry) => entry.url.includes('/v1/streams/orders/records')), false);

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
  const schemaCalls = calls.filter((entry) => new URL(entry.url).pathname === '/v1/schema');
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

test('Streamable HTTP helper handles initialize and tools/list statelessly', async () => {
  const { fetch } = makeFakeRs();

  const initialize = await postMcpJson(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'http-test', version: '0.0.0' },
      },
    },
    fetch
  );
  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.get('mcp-session-id'), null);
  const initialized = await initialize.json();
  assert.equal(initialized.result.serverInfo.name, 'pdpp-mcp-server');

  const tools = await postMcpJson(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    },
    fetch
  );
  assert.equal(tools.status, 200);
  const listed = await tools.json();
  assert.ok(listed.result.tools.some((tool) => tool.name === 'fetch'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'search'));
});

async function postMcpJson(message, fakeFetch) {
  return await handleStreamableHttpRequest(
    new Request('https://provider.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    }),
    {
      providerUrl: 'https://provider.test',
      accessToken: 'scoped-token',
      fetch: fakeFetch,
    }
  );
}

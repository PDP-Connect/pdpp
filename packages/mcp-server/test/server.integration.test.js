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
    has_more: true,
    next_cursor: 'cursor_orders_page_2',
    next_changes_since: 'changes_orders_next',
    meta: { count: { kind: 'exact', value: 42 } },
  };
  const SEARCH = {
    has_more: true,
    next_cursor: 'search_cursor_page_2',
    hits: [
      {
        stream: 'orders',
        id: 'o2',
        title: 'Order o2',
        url: 'https://merchant.test/o2',
        connection_id: 'conn_orders',
        display_name: 'Merchant orders',
        snippet: { text: 'Pasta order for $99.' },
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
    connection_id: 'conn_orders',
    display_name: 'Merchant orders',
    metadata: { amount: 99 },
  };
  const CONVERSATION_C1 = {
    object: 'record',
    id: 'c1',
    stream: 'conversations',
    data: {
      id: 'c1',
      title: 'Redactable developer ODCs',
      content: 'Jeremy and I had a call with Redactable yesterday and I was so unimpressed.',
      url: 'https://chatgpt.test/c/c1',
      connection_id: 'conn_chatgpt',
      connector_key: 'chatgpt',
      display_name: 'ChatGPT - everyone@appears.blue',
    },
    emitted_at: '2026-04-19T07:16:43.755Z',
    connection_id: 'conn_chatgpt',
    connector_instance_id: 'conn_chatgpt',
    display_name: 'ChatGPT - everyone@appears.blue',
  };
  const SLACK_MESSAGE_M1 = {
    id: 'm1',
    stream: 'messages',
    text: 'A Slack message without an explicit title.',
    sent_at: '2026-04-20T14:23:13.467Z',
    emitted_at: '2026-06-09T00:00:00.000Z',
    connection_id: 'conn_slack',
    connector_key: 'slack',
    display_name: 'Vana Slack',
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
      if (url.searchParams.get('detail') === 'full' && !url.searchParams.get('stream')) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request',
              code: 'invalid_request',
              param: 'detail',
              message: 'schema detail "full" requires `stream`',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return jsonResponse(schemaBodyForQuery(SCHEMA, url));
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
    if (url.pathname === '/v1/streams/conversations/records/c1') {
      return jsonResponse(CONVERSATION_C1);
    }
    if (url.pathname === '/v1/streams/messages/records/m1') {
      return jsonResponse(SLACK_MESSAGE_M1);
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
      if (url.searchParams.get('q') === 'untitled') {
        return jsonResponse({
          hits: [
            {
              stream: 'messages',
              id: 'm1',
              sent_at: '2026-04-20T14:23:13.467Z',
              emitted_at: '2026-06-09T00:00:00.000Z',
              connection_id: 'conn_slack',
              connector_key: 'slack',
              display_name: 'Vana Slack',
              snippet: { text: 'A Slack message without an explicit title.' },
            },
          ],
        });
      }
      if (url.searchParams.get('q') === 'nested-untitled') {
        return jsonResponse({
          hits: [
            {
              stream: 'messages',
              id: 'm2',
              data: { sent_at: '2026-04-08T16:57:06.018Z' },
              emitted_at: '2026-04-20T14:23:13.467Z',
              connection_id: 'conn_slack',
              connector_key: 'slack',
              display_name: 'Vana Slack',
              snippet: { text: 'A nested Slack message without an explicit title.' },
            },
          ],
        });
      }
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
                sender: fieldCapability({ type: 'string', exact: true, aggregations: ['count_distinct', 'group_by'] }),
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
      return jsonResponse(schemaBodyForQuery(SCHEMA, url));
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

function schemaBodyForQuery(schema, url) {
  const streamName = url.searchParams.get('stream');
  if (!streamName) return schema;
  if (Array.isArray(schema.streams)) {
    const streams = schema.streams.filter((entry) => schemaStreamName(entry) === streamName);
    return { ...schema, streams, stream_count: streams.length };
  }
  if (schema.data && typeof schema.data === 'object' && Array.isArray(schema.data.streams)) {
    const streams = schema.data.streams.filter((entry) => schemaStreamName(entry) === streamName);
    return { ...schema, data: { ...schema.data, streams, stream_count: streams.length } };
  }
  return schema;
}

function schemaStreamName(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.name ?? entry?.stream ?? entry?.stream_name ?? null;
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
    'fetch',
    'query_records',
    'schema',
    'search',
  ]);

  const READ_ONLY = new Set([
    'aggregate',
    'schema',
    'query_records',
    'search',
    'fetch',
  ]);
  for (const tool of tools.tools) {
    assert.ok(READ_ONLY.has(tool.name), `${tool.name} must be part of the read-only normal surface`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint=true`);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, true);
    assert.equal(tool.annotations?.openWorldHint, false);
  }

  await client.close();
  await server.close();
});

test('schema detail=full requires stream to avoid global schema blowups', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: { detail: 'full' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'invalid_request');
  assert.equal(result.structuredContent.error.param, 'detail');
  assert.equal(
    calls.filter((call) => new URL(call.url).pathname === '/v1/schema').length,
    1,
    'global full rejection is canonical RS behavior, not MCP-local preflight',
  );

  const scoped = await client.callTool({ name: 'schema', arguments: { stream: 'orders', detail: 'full' } });
  assert.equal(scoped.isError, undefined);
  assert.deepEqual(scoped.structuredContent.data, { version: '1', streams: ['orders'], stream_count: 1 });
  const schemaCall = calls.find((call) => new URL(call.url).pathname === '/v1/schema');
  assert.ok(schemaCall, 'scoped full must hit /v1/schema');
  assert.equal(schemaCall.auth, 'Bearer scoped-token');
  const schemaCalls = calls
    .filter((call) => new URL(call.url).pathname === '/v1/schema')
    .map((call) => new URL(call.url));
  assert.equal(schemaCalls.length, 2, 'global full and scoped full should each forward once to RS');
  assert.equal(schemaCalls[1].searchParams.has('view'), false, 'full fetch must not request compact view');
  assert.equal(schemaCalls[1].searchParams.get('detail'), 'full');
  assert.equal(schemaCalls[1].searchParams.get('stream'), 'orders', 'scoped full must ask the RS for the selected stream');

  await client.close();
  await server.close();
});

test('discovery tools include parseable stream and schema facts in text content', async () => {
  const { fetch } = makeDiscoveryFakeRs();
  const { client, server } = await connectClient(fetch);

  const schemaResult = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(schemaResult.isError, undefined);
  // Default detail is compact index-only: stream/source identity survives, but
  // per-field capability detail waits for schema(stream).
  const compactConnector = schemaResult.structuredContent.data.connectors[0];
  const compactStream = compactConnector.streams[0];
  assert.equal(compactStream.field_capabilities, undefined, 'global schema is an index, not field detail');
  assert.deepEqual(
    compactConnector.granted_connections,
    [{ connection_id: 'conn_work', display_name: 'Work Claude' }],
    'compact schema must preserve shared connection identity at connector level',
  );
  assert.equal(compactStream.granted_connections, undefined, 'compact schema must not repeat shared connection identity per stream');
  assert.equal(schemaResult.structuredContent.data.detail, 'compact');
  const schemaText = schemaResult.content[0].text;
  assert.match(schemaText, /PDPP schema: connectors=1 streams=1/);
  assert.match(schemaText, /stream name="conversations"/);
  assert.match(schemaText, /connector_key="claude-code"/);
  assert.match(schemaText, /display_name="Claude Code"/);
  assert.match(schemaText, /connections=\{connection_id:conn_work,display_name:Work_Claude\}/);
  assert.match(schemaText, /call schema\(stream, connection_id\?\) for per-field capability flags/);
  assert.doesNotMatch(schemaText, /id\[t=string,eq\]/);

  const scopedSchema = await client.callTool({ name: 'schema', arguments: { stream: 'conversations' } });
  const scopedStream = scopedSchema.structuredContent.data.connectors[0].streams[0];
  assert.equal(typeof scopedStream.field_capabilities.id, 'string', 'scoped schema field is a terse flag string');
  assert.match(scopedStream.field_capabilities.id, /t=string/, 'scoped flag string keeps declared field type');
  assert.match(scopedStream.field_capabilities.id, /(^|,)eq(,|$)/, 'scoped flag string keeps usable capability flags');
  assert.match(scopedStream.field_capabilities.created_at, /r=gte\|lt/, 'scoped flag string keeps usable range operators');
  const scopedText = scopedSchema.content[0].text;
  assert.match(scopedText, /field_capability_legend/);
  assert.match(scopedText, /id\[t=string,eq\]/);
  assert.match(scopedText, /created_at\[t=timestamp,r=gte\|lt,a=group_by_time\]/);
  assert.match(scopedText, /sender\[t=string,eq,a=count_distinct\|group_by\]/);
  assert.match(scopedText, /aggregations=count_distinct=sender;group_by=sender;group_by_time=created_at/);
  assert.doesNotMatch(schemaText, /See structuredContent\.data/);

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
  assert.match(result.content[0].text, /has_more=true/);
  assert.match(result.content[0].text, /next_cursor="cursor_orders_page_2"/);
  assert.match(result.content[0].text, /next_changes_since="changes_orders_next"/);
  assert.match(result.content[0].text, /count=exact:42/);
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

test('query_records encodes typed expand_limit as bracket query params', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', expand: ['line_items'], expand_limit: { line_items: 3 } },
  });

  assert.equal(result.isError, undefined);
  const call = calls.find((entry) => entry.url.includes('/v1/streams/orders/records'));
  const callUrl = new URL(call.url);
  assert.deepEqual(callUrl.searchParams.getAll('expand'), ['line_items']);
  assert.equal(callUrl.searchParams.get('expand_limit[line_items]'), '3');
  assert.equal(callUrl.searchParams.get('expand_limit'), null, 'must not forward expand_limit as a JSON object string');

  await client.close();
  await server.close();
});

test('query_records rejects empty or pre-encoded expand_limit objects before hitting RS', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  for (const expand_limit of [{}, { 'expand_limit[line_items]': 3 }]) {
    const result = await client.callTool({
      name: 'query_records',
      arguments: { stream: 'orders', expand: ['line_items'], expand_limit },
    });
    assert.equal(result.isError, true, `expand_limit ${JSON.stringify(expand_limit)} must be rejected`);
    assert.equal(result.structuredContent.error.code, 'invalid_expand');
  }

  assert.equal(calls.some((entry) => entry.url.includes('/v1/streams/orders/records')), false);

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
  assert.equal(result.structuredContent.data.results_ref, 'structuredContent.results');
  assert.equal(result.structuredContent.data.result_count, 1);
  assert.equal(result.structuredContent.data.hits, undefined);
  assert.deepEqual(result.structuredContent.results, [
    {
      id: 'orders:o2',
      title: 'Order o2',
      url: 'https://merchant.test/o2',
      stream: 'orders',
      record_key: 'o2',
      connection_id: 'conn_orders',
      display_name: 'Merchant orders',
      snippet: 'Pasta order for $99.',
    },
  ]);
  // Prose content is a concise, agent-visible preview, not a JSON dump.
  assert.match(result.content[0].text, /search: 1 hit/i);
  assert.match(result.content[0].text, /has_more=true/);
  assert.match(result.content[0].text, /next_cursor="search_cursor_page_2"/);
  assert.match(result.content[0].text, /id=orders:o2/);
  assert.match(result.content[0].text, /connection_id=conn_orders/);
  assert.match(result.content[0].text, /Pasta order/);
  assert.match(result.content[0].text, /structuredContent/);

  await client.close();
  await server.close();
});

test('search fallback title uses authored timestamp before emitted_at', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'search',
    arguments: { q: 'untitled' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.results[0].title, 'Vana Slack / messages / 2026-04-20T14:23:13.467Z');
  assert.equal(result.structuredContent.results[0].connector_key, 'slack');

  await client.close();
  await server.close();
});

test('search fallback title uses nested authored timestamp before top-level emitted_at', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'search',
    arguments: { q: 'nested-untitled' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.results[0].title, 'Vana Slack / messages / 2026-04-08T16:57:06.018Z');

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
  assert.equal(result.structuredContent.data, undefined);
  const mirrored = JSON.parse(result.content[0].text);
  assert.deepEqual(mirrored, result.structuredContent);
  assert.equal(mirrored.metadata.connection_id, 'conn_orders');
  assert.equal(mirrored.metadata.display_name, 'Merchant orders');
  assert.ok(calls.some((entry) => entry.url.endsWith('/v1/streams/orders/records/o2')));

  await client.close();
  await server.close();
});

test('fetch content text mirrors document JSON for hosts that hide structured output', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'conversations:c1', connection_id: 'conn_chatgpt' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.id, 'conversations:c1');
  assert.equal(result.structuredContent.title, 'Redactable developer ODCs');
  assert.equal(
    result.structuredContent.text,
    'Jeremy and I had a call with Redactable yesterday and I was so unimpressed.',
  );
  assert.equal(result.structuredContent.url, 'https://chatgpt.test/c/c1');

  // This is the model-visible path for clients that hide structuredContent.
  const text = JSON.parse(result.content[0].text);
  assert.deepEqual(text, result.structuredContent);
  assert.equal(text.metadata.connection_id, 'conn_chatgpt');
  assert.equal(text.metadata.connector_key, 'chatgpt');
  assert.equal(text.metadata.display_name, 'ChatGPT - everyone@appears.blue');
  assert.match(text.text, /Jeremy and I had a call with Redactable yesterday/);

  await client.close();
  await server.close();
});

test('fetch fallback title uses source identity and authored timestamp', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'messages:m1', connection_id: 'conn_slack' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.title, 'Vana Slack / messages / 2026-04-20T14:23:13.467Z');
  assert.equal(result.structuredContent.metadata.connector_key, 'slack');

  await client.close();
  await server.close();
});

test('search to fetch journey is executable from model-visible text alone', async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const searchResult = await client.callTool({
    name: 'search',
    arguments: { q: 'pasta' },
  });
  const searchText = searchResult.content[0].text;
  const id = /id=([^\s]+)/.exec(searchText)?.[1];
  const connectionId = /connection_id=([^\s]+)/.exec(searchText)?.[1];

  assert.equal(id, 'orders:o2');
  assert.equal(connectionId, 'conn_orders');

  const fetchResult = await client.callTool({
    name: 'fetch',
    arguments: { id, connection_id: connectionId },
  });
  const fetchText = JSON.parse(fetchResult.content[0].text);

  assert.equal(fetchText.id, 'orders:o2');
  assert.equal(fetchText.title, 'Order o2');
  assert.equal(fetchText.metadata.connection_id, 'conn_orders');
  assert.equal(fetchText.text, 'Pasta order for $99.');

  await client.close();
  await server.close();
});

test('fetch encodes typed expand_limit as bracket query params', async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'orders:o2', expand: ['line_items'], expand_limit: { line_items: 2 } },
  });

  assert.equal(result.isError, undefined);
  const call = calls.find((entry) => entry.url.includes('/v1/streams/orders/records/o2'));
  const callUrl = new URL(call.url);
  assert.deepEqual(callUrl.searchParams.getAll('expand'), ['line_items']);
  assert.equal(callUrl.searchParams.get('expand_limit[line_items]'), '2');
  assert.equal(callUrl.searchParams.get('expand_limit'), null);

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

  const tools = ['schema', 'query_records', 'aggregate', 'search', 'fetch'];
  for (const name of tools) {
    const args =
      name === 'query_records'
        ? { stream: 'orders' }
        : name === 'aggregate'
          ? { stream: 'orders', metric: 'count' }
          : name === 'search'
            ? { q: 'orders' }
            : name === 'fetch'
              ? { id: 'orders:o1' }
              : {};
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
  assert.deepEqual(initialized.result.serverInfo.icons, [
    { src: 'https://provider.test/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
  ]);

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
  assert.equal(tools.headers.get('x-pdpp-mcp-profile'), null);
  const listed = await tools.json();
  const names = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['aggregate', 'fetch', 'query_records', 'schema', 'search']);
  assert.ok(listed.result.tools.some((tool) => tool.name === 'fetch'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'search'));
});

async function postMcpJson(message, fakeFetch, path = '/mcp') {
  return await handleStreamableHttpRequest(
    new Request(`https://provider.test${path}`, {
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
      serverIcons: [{ src: 'https://provider.test/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }],
    }
  );
}

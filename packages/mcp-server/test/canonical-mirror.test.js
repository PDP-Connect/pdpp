import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

// MCP tools mirror the canonical public read contract. These tests assert
// the four mirror invariants from
//   openspec/changes/canonicalize-public-read-contract/tasks.md (§5):
// 5.1 input schemas expose the canonical read args
// 5.2 outputSchema declared so SDK validates the structuredContent envelope
// 5.3 content[] is a concise summary, not a JSON contract dump
// 5.4 unsupported args that REST would reject are not silently dropped

function recordingFetch() {
  const calls = [];
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? 'GET' });

    // Mirror the RS strict-validation posture: any param not in the
    // canonical allowlist surfaces as a typed unsupported_query error. This
    // lets us prove MCP forwards rather than drops unsupported args.
    const REST_ALLOWLIST = new Set([
      'q',
      'streams',
      'mode',
      'limit',
      'cursor',
      'order',
      'filter',
      'fields',
      'view',
      'expand',
      'expand_limit',
      'changes_since',
      'connection_id',
      'connector_instance_id',
    ]);
    for (const key of url.searchParams.keys()) {
      if (!REST_ALLOWLIST.has(key)) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request',
              code: 'unsupported_query',
              message: `Unsupported query parameter: ${key}`,
              param: key,
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
    }

    if (url.pathname === '/v1/schema') {
      return jsonResponse({ object: 'schema', bearer: {}, connectors: [] });
    }
    if (url.pathname === '/v1/streams') {
      return jsonResponse({ object: 'list', data: [] });
    }
    if (url.pathname === '/v1/streams/orders/records') {
      return jsonResponse({
        object: 'list',
        data: [
          { id: 'o1', amount: 12 },
          { id: 'o2', amount: 99 },
        ],
        has_more: false,
      });
    }
    if (url.pathname === '/v1/streams/bulky/records') {
      return jsonResponse({
        object: 'list',
        data: [{ id: 'big-1', body: 'y'.repeat(5000) }],
        has_more: true,
      });
    }
    if (url.pathname === '/v1/streams/manylarge/records') {
      return jsonResponse({
        object: 'list',
        data: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, body: 'z'.repeat(2000) })),
        has_more: true,
      });
    }
    if (url.pathname === '/v1/streams/nested/records') {
      return jsonResponse({
        object: 'list',
        data: { records: [{ id: 'n1' }, { id: 'n2' }] },
        has_more: false,
      });
    }
    if (url.pathname === '/v1/search') {
      return jsonResponse({ object: 'list', data: [], has_more: false });
    }
    if (url.pathname === '/v1/search/semantic') {
      return jsonResponse({ object: 'list', data: [], has_more: false, _mode: 'semantic' });
    }
    if (url.pathname === '/v1/search/hybrid') {
      return jsonResponse({ object: 'list', data: [], has_more: false, _mode: 'hybrid' });
    }
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function connectClient(fakeFetch) {
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch: fakeFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'canonical-mirror-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('5.1 query_records exposes canonical read args (fields, expand, expand_limit, filter, sort, cursor, limit, count)', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const queryRecords = tools.tools.find((t) => t.name === 'query_records');
  const expected = [
    'stream',
    'fields',
    'expand',
    'expand_limit',
    'filter',
    'sort',
    'cursor',
    'limit',
    'count',
    'connection_id',
    'connector_instance_id',
  ];
  for (const name of expected) {
    assert.ok(
      queryRecords.inputSchema.properties[name],
      `query_records must expose canonical arg "${name}"`,
    );
  }

  await client.close();
  await server.close();
});

test('5.1 description points callers to /v1/schema as the capability source', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  for (const name of ['schema', 'list_streams', 'query_records', 'search']) {
    const tool = tools.tools.find((t) => t.name === name);
    assert.match(
      tool.description,
      /\/v1\/schema/,
      `${name}.description must reference /v1/schema as the canonical capability source`,
    );
  }

  await client.close();
  await server.close();
});

test('5.1 descriptions prefer connection_id and connector_key source identity', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const byName = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool]));
  for (const name of [
    'schema',
    'list_streams',
    'query_records',
    'aggregate',
    'search',
    'fetch',
    'fetch_blob',
    'create_event_subscription',
  ]) {
    assert.match(
      byName[name].description,
      /connection_id/,
      `${name} must prefer connection_id for source selection`,
    );
    assert.match(
      byName[name].description,
      /connector_key/,
      `${name} must describe canonical connector_key metadata`,
    );
    assert.doesNotMatch(
      byName[name].description,
      /https:\/\/registry\.pdpp\.org/,
      `${name} must not advertise registry URLs as connector identity`,
    );
  }

  const queryInput = byName.query_records.inputSchema.properties;
  assert.match(
    queryInput.connection_id.description,
    /available_connections.*connector_key.*connection_id/s,
    'connection_id schema guidance must point clients from typed errors to connector_key-tagged candidates',
  );
  assert.match(
    queryInput.connector_instance_id.description,
    /Deprecated.*connection_id/s,
    'connector_instance_id schema guidance must clearly demote the legacy alias',
  );

  await client.close();
  await server.close();
});

test('5.2 every read tool declares an outputSchema for structuredContent', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  for (const name of ['schema', 'list_streams', 'query_records', 'search', 'fetch', 'fetch_blob']) {
    const tool = tools.tools.find((t) => t.name === name);
    assert.ok(tool.outputSchema, `${name} must declare an outputSchema`);
    assert.equal(tool.outputSchema.type, 'object', `${name}.outputSchema must be an object schema`);
  }

  await client.close();
  await server.close();
});

test('5.2 successful tool calls carry canonical structuredContent that matches the outputSchema', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(result.isError, undefined);
  // The SDK validates structuredContent against outputSchema before returning.
  // Reaching this assertion proves validation passed.
  assert.ok(result.structuredContent);
  assert.ok(result.structuredContent.data);
  assert.equal(typeof result.structuredContent.provider_url, 'string');

  await client.close();
  await server.close();
});

test('5.3 content[] is a bounded readable preview, not a JSON dump', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders' },
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  // Text content should be readable by model loops that cannot consume
  // structuredContent, while still avoiding the legacy multi-line dump of the
  // entire canonical RS envelope.
  assert.ok(
    !text.includes('\n  '),
    'content[] must not include multi-line JSON indentation',
  );
  assert.match(text, /record\[0\]/, 'summary must include a bounded record preview');
  assert.ok(text.length < 1800, `summary should stay bounded (got ${text.length} chars)`);

  await client.close();
  await server.close();
});

test('5.4 MCP forwards canonical args verbatim — `sort` reaches RS rather than being silently dropped', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  // `sort` is a canonical primitive (sign-prefix) advertised by /v1/schema.
  // The reference runtime does not implement it yet; the mock RS rejects
  // unknown params with a typed unsupported_query error. The test proves
  // MCP forwards the parameter rather than silently dropping it client-side.
  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', sort: '-emitted_at' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'unsupported_query');
  // And it reached the RS — proof the MCP layer did not strip it.
  const recordCalls = calls.filter((c) => c.url.includes('/v1/streams/orders/records'));
  assert.equal(recordCalls.length, 1, 'MCP must forward sort to RS, not short-circuit');
  const url = new URL(recordCalls[0].url);
  assert.equal(url.searchParams.get('sort'), '-emitted_at');

  await client.close();
  await server.close();
});

test('5.4 MCP forwards `count` verbatim and surfaces typed RS rejection', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', count: 'estimated' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'unsupported_query');
  const recordCalls = calls.filter((c) => c.url.includes('/v1/streams/orders/records'));
  const url = new URL(recordCalls[0].url);
  assert.equal(url.searchParams.get('count'), 'estimated');

  await client.close();
  await server.close();
});

test('5.4 MCP rejects Zod-unknown args at the input schema layer rather than silently dropping them', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', bogus_param: 'x' },
  });
  // Strict zod schema rejects before hitting RS.
  assert.equal(result.isError, true);
  assert.equal(
    calls.some((c) => c.url.includes('/v1/streams/orders/records')),
    false,
    'unknown arg must not reach RS — MCP rejects at the input boundary',
  );

  await client.close();
  await server.close();
});

test('5.4 search forwards mode to the correct RS endpoint (lexical/semantic/hybrid) — no silent fallback', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  await client.callTool({ name: 'search', arguments: { q: 'a', mode: 'semantic' } });
  await client.callTool({ name: 'search', arguments: { q: 'a', mode: 'hybrid' } });
  await client.callTool({ name: 'search', arguments: { q: 'a' } });

  const paths = calls.map((c) => new URL(c.url).pathname);
  assert.ok(paths.includes('/v1/search/semantic'), 'semantic mode must hit /v1/search/semantic');
  assert.ok(paths.includes('/v1/search/hybrid'), 'hybrid mode must hit /v1/search/hybrid');
  assert.ok(paths.includes('/v1/search'), 'default mode must hit /v1/search');

  await client.close();
  await server.close();
});

test('7.4 token-efficiency: prose content[] is far smaller than structuredContent JSON', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders' },
  });
  const proseLen = result.content[0].text.length;
  const structuredLen = JSON.stringify(result.structuredContent).length;
  // Hard cap on the prose preview regardless of body size. This is a
  // regression guard against re-introducing the legacy "dump the entire JSON
  // envelope in content[]" pattern while still letting agents read records.
  assert.ok(proseLen < 1800, `prose content[] must stay bounded (got ${proseLen})`);
  assert.ok(
    proseLen < structuredLen || structuredLen < 100,
    'prose content[] must not be larger than structuredContent',
  );

  await client.close();
  await server.close();
});

test('7.5 oversized records stay bounded yet still surface readable payload', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'bulky' },
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.equal(result.structuredContent.data.data[0].body.length, 5000);
  assert.ok(text.length < 1800, `preview must stay bounded (got ${text.length})`);
  assert.match(text, /record\[0\] \{"id":"big-1"/);
  assert.ok(text.includes('yyyy'), 'truncated preview must still carry record payload');
  assert.ok(text.endsWith('…'), 'oversized record must be truncated with an ellipsis');

  await client.close();
  await server.close();
});

test('7.5 multiple oversized records emit a bounded early-break marker', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'manylarge' },
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.ok(text.length < 1800, `preview must stay bounded (got ${text.length})`);
  assert.match(text, /record\[0\] \{"id":"m0"/);
  assert.match(text, /record_preview_truncated=true/);

  await client.close();
  await server.close();
});

test('7.5 nested data.records envelope is previewed', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'nested' },
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /records from stream "nested": 2 record\(s\)/);
  assert.match(text, /record\[0\] \{"id":"n1"\}/);
  assert.match(text, /record\[1\] \{"id":"n2"\}/);

  await client.close();
  await server.close();
});

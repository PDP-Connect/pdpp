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
      'sort',
      'count',
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

test('5.1 query_records exposes canonical read args (fields, expand, expand_limit, filter, sort, cursor, changes_since, limit, count)', async () => {
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
    'changes_since',
    'limit',
    'count',
    'connection_id',
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
  for (const name of ['schema', 'query_records', 'search']) {
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
    'query_records',
    'aggregate',
    'search',
    'fetch',
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
    queryInput.changes_since.description,
    /beginning/,
    'changes_since description must teach the cold-start sentinel',
  );
  assert.match(
    queryInput.changes_since.description,
    /next_changes_since/,
    'changes_since description must teach the opaque follow-up bookmark',
  );
  assert.match(
    queryInput.changes_since.description,
    /Do not pass an ISO timestamp/,
    'changes_since must explicitly warn that timestamp input is invalid',
  );
  assert.match(
    queryInput.connection_id.description,
    /available_connections.*connector_key.*connection_id/s,
    'connection_id schema guidance must point clients from typed errors to connector_key-tagged candidates',
  );
  assert.equal(
    queryInput.connector_instance_id,
    undefined,
    'MCP query_records must not advertise the deprecated connector_instance_id alias',
  );

  await client.close();
  await server.close();
});

test('5.2 every read tool declares an outputSchema for structuredContent', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  for (const name of ['schema', 'query_records', 'search', 'fetch']) {
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

test('grant-scoped query_records does not add owner-only diagnostics', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.data[0].id, 'o1');

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'acquisition_coverage',
    'import_receipt',
    'artifact_sha256',
    'media_coverage',
    'rendered_verdict',
    'detail_gap_backlog',
    'tone_cause',
    'channel_cause',
    'suppressed_evidence',
    'satisfied_when',
  ]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not appear in MCP grant-scoped reads`);
  }

  await client.close();
  await server.close();
});

test('5.4 MCP forwards canonical args verbatim — `sort` reaches RS rather than being silently dropped', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', sort: '-emitted_at' },
  });
  assert.equal(result.isError, undefined);
  const recordCalls = calls.filter((c) => c.url.includes('/v1/streams/orders/records'));
  assert.equal(recordCalls.length, 1, 'MCP must forward sort to RS, not short-circuit');
  const url = new URL(recordCalls[0].url);
  assert.equal(url.searchParams.get('sort'), '-emitted_at');

  await client.close();
  await server.close();
});

test('5.4 MCP forwards `count` verbatim without expecting stale RS rejection', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', count: 'estimated' },
  });
  assert.equal(result.isError, undefined);
  const recordCalls = calls.filter((c) => c.url.includes('/v1/streams/orders/records'));
  const url = new URL(recordCalls[0].url);
  assert.equal(url.searchParams.get('count'), 'estimated');

  await client.close();
  await server.close();
});

test('5.4 MCP forwards `view` verbatim — a query-time projection the RS applies, not an inert no-op', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  // `view` is a real query-time projection on `/v1/streams/{stream}/records`:
  // the RS resolves the named view to its declared field set and projects the
  // page down to it (see reference-implementation operations/rs-records-list
  // and the query-contract `view=basic` projection guard). MCP must therefore
  // advertise and forward it verbatim rather than dropping it client-side.
  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', view: 'basic' },
  });
  assert.notEqual(result.isError, true);
  const recordCalls = calls.filter((c) => c.url.includes('/v1/streams/orders/records'));
  assert.equal(recordCalls.length, 1, 'MCP must forward view to RS, not strip it');
  const url = new URL(recordCalls[0].url);
  assert.equal(url.searchParams.get('view'), 'basic');

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

test('5.1 search input schema caps `limit` at 100, matching the published search contract', async () => {
  // The published `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid`
  // contract (packages/reference-contract -> OpenAPI) declares `limit`
  // `{minimum:1, maximum:100}` and all three RS modes honor MAX_LIMIT=100
  // (advertised as `capabilities.*_retrieval.max_limit`). The MCP search tool
  // previously advertised `max(200)`, over-promising a page size the RS would
  // silently clamp. The bound here mirrors the contract so the page size an
  // agent asks for is the page size it gets.
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const searchTool = tools.tools.find((t) => t.name === 'search');
  assert.ok(searchTool, 'search tool must be exposed');
  assert.equal(
    searchTool.inputSchema.properties.limit.maximum,
    100,
    'search limit input must advertise the contract maximum of 100, not a larger value the RS would clamp',
  );
  assert.ok(
    searchTool.inputSchema.properties.limit.exclusiveMaximum === undefined,
    'the maximum must be inclusive so limit=100 is accepted',
  );

  await client.close();
  await server.close();
});

test('5.4 search rejects an over-max `limit` at input validation rather than forwarding it to be clamped', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const overMax = await client.callTool({
    name: 'search',
    arguments: { q: 'a', limit: 200 },
  });
  assert.equal(overMax.isError, true, 'an over-max search limit must be an error result');
  const overMaxText = overMax.content?.map((c) => c.text ?? '').join('\n') ?? '';
  assert.match(
    overMaxText,
    /validation|too_big|less than or equal to 100/i,
    'the error must be an input-validation rejection of the over-max limit',
  );
  // It must NOT have reached any search endpoint — the cap is enforced before forwarding.
  assert.equal(
    calls.some((c) => new URL(c.url).pathname.startsWith('/v1/search')),
    false,
    'over-max limit must be rejected at the MCP input boundary, not forwarded to the RS to be silently clamped',
  );

  // The inclusive boundary value is accepted and forwarded verbatim.
  const atMax = await client.callTool({
    name: 'search',
    arguments: { q: 'a', limit: 100 },
  });
  assert.equal(atMax.isError, undefined, 'limit=100 is a valid argument against the published schema');
  const searchCall = calls.find((c) => new URL(c.url).pathname === '/v1/search');
  assert.ok(searchCall, 'limit=100 search must reach the RS');
  assert.equal(new URL(searchCall.url).searchParams.get('limit'), '100', 'the at-max limit is forwarded verbatim');

  await client.close();
  await server.close();
});

test('search description teaches the 100 cap and safe paging so agents stay token-efficient', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const searchTool = tools.tools.find((t) => t.name === 'search');
  assert.ok(searchTool, 'search tool must be exposed');
  assert.match(
    searchTool.description,
    /capped at 100/,
    'description must state the limit cap (100)',
  );
  assert.match(
    searchTool.description,
    /cursor/,
    'description must teach paging with the returned cursor instead of asking for a larger page',
  );
  assert.doesNotMatch(
    searchTool.description,
    /\b200\b/,
    'description must not advertise the stale 200 cap',
  );

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

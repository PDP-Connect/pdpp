import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

// Live external MCP testing exposed an agent-usability failure: MCP advertised
// `filter` as a string, so agents sent JSON or `filter[user_id]=...` strings
// that became a bare REST `filter=` param the RS silently ignored
// (query_records) or rejected (aggregate). REST itself is correct — its
// `qs.parse(filter[field][op]=value)` decodes the canonical bracket shape.
// This suite pins the MCP-layer fix: MCP accepts a JSON-native typed filter
// object, encodes it into `filter[field]=value` / `filter[field][op]=value`,
// and rejects every string filter before it can reach REST.

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Decode the `filter[field]` / `filter[field][op]` bracket params the RS
// receives back into the nested object the RS's `qs.parse` would build, so the
// test asserts on the structure the resource server actually consumes.
function decodeFilterParams(searchParams) {
  const filter = {};
  for (const [key, value] of searchParams.entries()) {
    const match = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(key);
    if (!match) continue;
    const [, field, op] = match;
    if (op) {
      filter[field] = filter[field] && typeof filter[field] === 'object' ? filter[field] : {};
      filter[field][op] = value;
    } else {
      filter[field] = value;
    }
  }
  return filter;
}

function recordingFetch() {
  const calls = [];
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    const filter = decodeFilterParams(url.searchParams);
    calls.push({ url: url.toString(), method: init.method ?? 'GET', filter, searchParams: url.searchParams });

    if (url.pathname === '/v1/streams/messages/records') {
      // Echo a row only when the canonical user_id exact filter arrived; a
      // bare `filter=` param (the old bug) or a wrong value yields zero rows.
      const wantUser = filter.user_id;
      const rows = wantUser === 'U123' ? [{ id: 'm1', user_id: 'U123', text: 'hi' }] : [];
      return jsonResponse({ records: rows, has_more: false });
    }
    if (url.pathname === '/v1/streams/messages/aggregate') {
      const metric = url.searchParams.get('metric');
      const groupBy = url.searchParams.get('group_by');
      if (groupBy) {
        return jsonResponse({
          object: 'aggregation',
          stream: 'messages',
          metric,
          group_by: groupBy,
          approximate: false,
          filtered_record_count: 7,
          limit: 100,
          groups: [
            { key: 'U123', count: 4 },
            { key: 'U999', count: 3 },
          ],
        });
      }
      // Ungrouped scalar count, scoped by the forwarded filter.
      const value = filter.user_id === 'U123' ? 4 : 7;
      return jsonResponse({
        object: 'aggregation',
        stream: 'messages',
        metric: metric ?? 'count',
        field: url.searchParams.get('field'),
        approximate: false,
        filtered_record_count: value,
        value,
      });
    }
    if (url.pathname === '/v1/search') {
      return jsonResponse({ hits: [{ id: 'messages:m1', title: 'hi' }] });
    }
    return jsonResponse({ error: { type: 'not_found', code: 'not_found' } }, 404);
  };
  return { fetch, calls };
}

async function connectClient(fakeFetch) {
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch: fakeFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'typed-filter-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function resultText(result) {
  return result.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

test('tools/list advertises filter as a typed object record on query_records, aggregate, and search', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const { tools } = await client.listTools();
  for (const name of ['query_records', 'aggregate', 'search']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} tool must be registered`);
    const filterSchema = tool.inputSchema.properties.filter;
    assert.equal(filterSchema.type, 'object', `${name}.filter must advertise an object, not only a string`);
    assert.ok(filterSchema.additionalProperties, `${name}.filter must advertise record values`);
    assert.equal(filterSchema.anyOf, undefined, `${name}.filter must not be a top-level object/string union`);
    assert.equal(filterSchema.oneOf, undefined, `${name}.filter must not be a top-level object/string union`);
    assert.match(
      JSON.stringify(filterSchema.additionalProperties),
      /gte/,
      `${name}.filter record values must include range operator objects`,
    );
  }

  await client.close();
  await server.close();
});

test('query_records typed exact filter forwards as filter[field]=value and narrows results', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'messages', filter: { user_id: 'U123' } },
  });
  assert.equal(result.isError, undefined);

  const call = calls.find((c) => c.url.includes('/v1/streams/messages/records'));
  assert.equal(call.searchParams.get('filter[user_id]'), 'U123', 'must forward bracketed exact filter');
  assert.equal(call.searchParams.get('filter'), null, 'must NOT forward a bare filter= param');
  assert.deepEqual(call.filter, { user_id: 'U123' });
  assert.equal(result.structuredContent.data.records.length, 1, 'narrowed to the matching row');

  await client.close();
  await server.close();
});

test('query_records typed range filter forwards as filter[field][op]=value', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  await client.callTool({
    name: 'query_records',
    arguments: {
      stream: 'messages',
      filter: { created_at: { gte: '2026-01-01T00:00:00Z', lt: '2026-02-01T00:00:00Z' } },
    },
  });

  const call = calls.find((c) => c.url.includes('/v1/streams/messages/records'));
  assert.equal(call.searchParams.get('filter[created_at][gte]'), '2026-01-01T00:00:00Z');
  assert.equal(call.searchParams.get('filter[created_at][lt]'), '2026-02-01T00:00:00Z');
  assert.deepEqual(call.filter, {
    created_at: { gte: '2026-01-01T00:00:00Z', lt: '2026-02-01T00:00:00Z' },
  });

  await client.close();
  await server.close();
});

test('query_records rejects string filters at MCP validation and never reaches REST', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  for (const filter of ['filter[user_id]=U123', 'user_id=U123', 'amount>100', '{"user_id":"U123"}', '']) {
    const result = await client.callTool({
      name: 'query_records',
      arguments: { stream: 'messages', filter },
    });
    assert.equal(result.isError, true, `string filter ${JSON.stringify(filter)} must be rejected`);
    assert.match(resultText(result), /validation|object|string|invalid/i);
  }
  assert.equal(calls.length, 0, 'string filters must be rejected before any REST request');

  await client.close();
  await server.close();
});

test('aggregate and search reject string filters at MCP validation and never reach REST', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const aggregate = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'messages', metric: 'count', filter: 'filter[user_id]=U123' },
  });
  assert.equal(aggregate.isError, true);
  assert.match(resultText(aggregate), /validation|object|string|invalid/i);

  const search = await client.callTool({
    name: 'search',
    arguments: { q: 'hi', filter: 'filter[user_id]=U123' },
  });
  assert.equal(search.isError, true);
  assert.match(resultText(search), /validation|object|string|invalid/i);
  assert.equal(calls.length, 0, 'string filters must be rejected before any REST request');

  await client.close();
  await server.close();
});

test('query_records rejects empty/no-op filter shapes instead of silently dropping them', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  for (const filter of ['', '   ', {}, { 'filter[user_id]': 'U123' }]) {
    const result = await client.callTool({
      name: 'query_records',
      arguments: { stream: 'messages', filter },
    });
    assert.equal(result.isError, true, `filter ${JSON.stringify(filter)} must be rejected, not silently ignored`);
  }

  assert.equal(
    calls.some((c) => c.searchParams.get('filter') !== null || c.searchParams.get('filter[user_id]') !== null),
    false,
    'empty or pre-encoded typed filters must not reach the RS as query params',
  );

  await client.close();
  await server.close();
});

test('query_records rejects an unsupported range operator with an actionable error', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'messages', filter: { amount: { between: 5 } } },
  });
  assert.equal(result.isError, true);
  // `between` is not a key of the strict typed range object, so the MCP SDK
  // rejects it at the input boundary before the handler runs (an input-
  // validation error result, not a handler `structuredContent.error`). Either
  // way the agent gets a typed, actionable rejection rather than a silent
  // forward of an unsupported operator.
  const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
  assert.match(text, /validation|unrecognized|between|invalid/i, 'must surface an input-validation rejection');

  await client.close();
  await server.close();
});

test('aggregate typed filter forwards as bracket params and scopes the count', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'messages', metric: 'count', filter: { user_id: 'U123' } },
  });
  assert.equal(result.isError, undefined);

  const call = calls.find((c) => c.url.includes('/v1/streams/messages/aggregate'));
  assert.equal(call.searchParams.get('filter[user_id]'), 'U123');
  assert.equal(call.searchParams.get('filter'), null);
  assert.equal(result.structuredContent.data.value, 4, 'count scoped by the forwarded filter');

  await client.close();
  await server.close();
});

test('aggregate text content includes the metric, stream, and numeric result (not only structuredContent)', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'messages', metric: 'count' },
  });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => c.text).join('\n');
  assert.match(text, /count/, 'text must name the metric');
  assert.match(text, /messages/, 'text must name the stream');
  assert.match(text, /\b7\b/, 'text must include the numeric aggregate result');
  // Compact, not a full JSON dump.
  assert.ok(text.length < 400, `aggregate text must stay compact, got ${text.length} chars`);
  // Canonical envelope still validates and carries the value.
  assert.equal(result.structuredContent.data.value, 7);

  await client.close();
  await server.close();
});

test('aggregate grouped result previews buckets with counts in text', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'messages', metric: 'count', group_by: 'user_id' },
  });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => c.text).join('\n');
  assert.match(text, /group_by=/, 'text must name the grouping dimension');
  assert.match(text, /U123/, 'text must preview a bucket key');
  assert.match(text, /\b4\b/, 'text must preview a bucket count');
  assert.equal(result.structuredContent.data.groups.length, 2);

  await client.close();
  await server.close();
});

test('search typed filter forwards as bracket params (same fix as query_records)', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'search',
    arguments: { q: 'hi', filter: { user_id: 'U123' } },
  });
  assert.equal(result.isError, undefined);

  const call = calls.find((c) => c.url.includes('/v1/search'));
  assert.equal(call.searchParams.get('q'), 'hi', 'search must forward q');
  assert.equal(call.searchParams.get('filter[user_id]'), 'U123');
  assert.equal(call.searchParams.get('filter'), null);

  await client.close();
  await server.close();
});

test('search surfaces readable hit handles in content text', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'search', arguments: { q: 'hi' } });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => c.text).join('\n');
  assert.match(text, /1|result|hit/i, 'search text must surface a usable result summary');
  assert.match(text, /id=messages:m1/, 'search text must include a fetchable result id');
  assert.equal(result.structuredContent.results.length, 1, 'flattened results must be populated');

  await client.close();
  await server.close();
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

// MCP aggregate tool mirrors the canonical aggregate read contract from
//   openspec/changes/add-aggregate-time-buckets-and-distinct
// It forwards metric/field/group_by/group_by_time/granularity/time_zone/
// limit/filter/connection_id verbatim to /v1/streams/{stream}/aggregate and
// mirrors the RS body into structuredContent. It must not silently drop a
// parameter the RS would reject.

function recordingFetch() {
  const calls = [];
  const REST_ALLOWLIST = new Set([
    'metric',
    'field',
    'group_by',
    'group_by_time',
    'granularity',
    'time_zone',
    'limit',
    'filter',
    'connection_id',
  ]);
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? 'GET' });

    if (url.pathname === '/v1/streams/events/aggregate') {
      for (const key of url.searchParams.keys()) {
        if (!REST_ALLOWLIST.has(key)) {
          return jsonResponse(
            {
              error: {
                type: 'invalid_request',
                code: 'unsupported_query',
                message: `Unsupported query parameter: ${key}`,
                param: key,
              },
            },
            400,
          );
        }
      }
      // Mirror the single-dimension rule the RS enforces.
      if (url.searchParams.get('group_by') && url.searchParams.get('group_by_time')) {
        return jsonResponse(
          { error: { type: 'invalid_request', code: 'invalid_request', message: 'two grouping dimensions' } },
          400,
        );
      }
      return jsonResponse({
        object: 'aggregation',
        stream: 'events',
        metric: url.searchParams.get('metric'),
        group_by_time: url.searchParams.get('group_by_time'),
        granularity: url.searchParams.get('granularity'),
        time_zone: url.searchParams.get('time_zone') ?? 'UTC',
        approximate: false,
        filtered_record_count: 3,
        limit: 100,
        groups: [{ key: '2026-05-01', count: 3 }],
      });
    }
    return jsonResponse({ error: { type: 'not_found', code: 'not_found' } }, 404);
  };
  return { fetch, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
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
  const client = new Client({ name: 'aggregate-tool-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('aggregate tool exposes the metric and granularity enums and grouping args', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const aggregate = tools.tools.find((t) => t.name === 'aggregate');
  assert.ok(aggregate, 'aggregate tool must be registered');
  const props = aggregate.inputSchema.properties;
  for (const name of ['stream', 'metric', 'field', 'group_by', 'group_by_time', 'granularity', 'time_zone', 'limit', 'filter']) {
    assert.ok(props[name], `aggregate must expose "${name}"`);
  }
  assert.deepEqual(props.metric.enum, ['count', 'sum', 'min', 'max', 'count_distinct']);
  assert.deepEqual(props.granularity.enum, ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);
  assert.ok(aggregate.outputSchema, 'aggregate must declare an outputSchema');
  assert.match(aggregate.description, /\/v1\/schema/, 'description must reference /v1/schema');
  assert.match(aggregate.description, /XOR|exactly one/i, 'description must document the single grouping dimension rule');

  await client.close();
  await server.close();
});

test('aggregate description teaches the token-efficient path (prefer over paging query_records)', async () => {
  // Token-efficiency guard. `aggregate` answers count/sum/distinct/group-by
  // questions by returning small bucket rows, never record bodies — it is the
  // cheap alternative to paging `query_records` and counting client-side. If a
  // future edit drops that framing, agents lose the signal that analytics
  // questions have a context-cheap answer, mirroring the schema/query_records
  // description guards in schema-token-budget.test.js.
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const aggregate = tools.tools.find((t) => t.name === 'aggregate');
  assert.ok(aggregate, 'aggregate tool must be registered');

  assert.match(
    aggregate.description,
    /query_records/,
    'description must contrast aggregate with paging query_records',
  );
  assert.match(
    aggregate.description,
    /never record bodies/i,
    'description must state aggregate returns buckets, not record bodies',
  );

  await client.close();
  await server.close();
});

test('aggregate forwards a group_by_time request and mirrors the RS body into structuredContent', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'events', metric: 'count', group_by_time: 'occurred_at', granularity: 'day' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.object, 'aggregation');
  assert.equal(result.structuredContent.data.group_by_time, 'occurred_at');
  assert.equal(result.structuredContent.data.granularity, 'day');
  assert.equal(result.structuredContent.data.time_zone, 'UTC');
  assert.equal(result.structuredContent.data.approximate, false);
  assert.match(
    result.content[0].text,
    /time_zone="UTC"/,
    'group_by_time prose must echo the applied time zone for model-visible verification',
  );

  const aggCall = calls.find((c) => c.url.includes('/v1/streams/events/aggregate'));
  const url = new URL(aggCall.url);
  assert.equal(url.searchParams.get('metric'), 'count');
  assert.equal(url.searchParams.get('group_by_time'), 'occurred_at');
  assert.equal(url.searchParams.get('granularity'), 'day');

  await client.close();
  await server.close();
});

test('aggregate forwards count_distinct and time_zone verbatim', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const timeZoneResult = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'events', metric: 'count', group_by_time: 'occurred_at', granularity: 'day', time_zone: 'America/New_York' },
  });
  await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'events', metric: 'count_distinct', field: 'sender' },
  });
  const urls = calls.map((c) => new URL(c.url));
  assert.ok(urls.some((u) => u.searchParams.get('time_zone') === 'America/New_York'));
  assert.ok(urls.some((u) => u.searchParams.get('metric') === 'count_distinct' && u.searchParams.get('field') === 'sender'));
  assert.match(timeZoneResult.content[0].text, /time_zone="America\/New_York"/);

  await client.close();
  await server.close();
});

test('aggregate surfaces the RS rejection of two grouping dimensions rather than silently succeeding', async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'events', metric: 'count', group_by: 'sender', group_by_time: 'occurred_at', granularity: 'day' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'invalid_request');

  await client.close();
  await server.close();
});

test('aggregate rejects Zod-unknown args at the input boundary, never reaching RS', async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'aggregate',
    arguments: { stream: 'events', metric: 'count', bogus_param: 'x' },
  });
  assert.equal(result.isError, true);
  assert.equal(
    calls.some((c) => c.url.includes('/v1/streams/events/aggregate')),
    false,
    'unknown arg must not reach RS',
  );

  await client.close();
  await server.close();
});

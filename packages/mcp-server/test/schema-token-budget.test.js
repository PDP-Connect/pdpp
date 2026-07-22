// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'tsx';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

const { projectSchemaCompactView, projectSchemaStreamScope, schemaSourceOptions } = await import(
  '../../../reference-implementation/operations/rs-schema-get/compact-view.ts'
);

function mcpCompactSchemaExpected(schema, opts) {
  return stripDeprecatedConnectorInstanceAlias(projectSchemaCompactView(schema, opts));
}

function stripDeprecatedConnectorInstanceAlias(value) {
  if (Array.isArray(value)) return value.map(stripDeprecatedConnectorInstanceAlias);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'connector_instance_id') continue;
    out[key] = stripDeprecatedConnectorInstanceAlias(nested);
  }
  return out;
}

// Token-efficiency acceptance checks for the `schema` MCP tool.
//
// Owned by openspec/changes/expose-connection-identity-on-public-read/tasks.md
// (§7 MCP discovery/schema token-efficiency target):
//   "make `schema -> compact schema(stream) -> query_records` the default
//    agent path; keep package-level `schema` responses compact enough for
//    chat-agent context, make exhaustive JSON opt-in via explicit
//    detail/per-stream/per-field controls, and add enforceable byte/token-budget
//    acceptance checks."
//
// Live agent clients observed package-level `schema` returning ~2 MB of JSON.
// These tests build a representative large grant-scoped schema (many streams,
// many fields, each carrying a verbose per-field JSON Schema blob) and assert
// the DEFAULT MCP `schema` response stays under a documented byte budget, that
// per-stream scope is usable and compact, that `detail: "full"` is constrained
// to a single stream, and that connection identity survives compaction.

// Documented byte budgets for the MCP `schema` tool result. These are the
// regression guards: if a future change re-introduces verbatim-by-default or
// stops dropping the per-field JSON Schema blobs, these fail locally.
//
// The budgets are deliberately generous relative to the compact projection's
// real size so legitimate growth (more streams/fields) does not flap the test,
// while still being ~30x smaller than the verbatim body for this fixture.
const PACKAGE_SCHEMA_STRUCTURED_BYTE_BUDGET = 60_000; // full grant, all streams
const STREAM_SCHEMA_STRUCTURED_BYTE_BUDGET = 6_000; // one stream, compact

// Size of the verbose per-field JSON Schema blob the RS attaches to every field.
// This is the dominant size driver the compact projection drops.
const FIELD_SCHEMA_BLOB_PADDING = 1_200;

function makeLargeSchemaFetch({ connectorCount = 4, streamsPerConnector = 6, fieldsPerStream = 30 } = {}) {
  const connectors = Array.from({ length: connectorCount }, (_, c) => {
    const connectorKey = `connector-${c}`;
    return {
      object: 'connector',
      connector_id: connectorKey,
      connector_key: connectorKey,
      source: { kind: 'connector', id: connectorKey, display_name: `Connector ${c}` },
      stream_count: streamsPerConnector,
      streams: Array.from({ length: streamsPerConnector }, (_, s) => ({
        object: 'stream_metadata',
        name: `stream_${c}_${s}`,
        connection_id: `conn_${c}`,
        connector_instance_id: `conn_${c}`,
        display_name: `Connection ${c}`,
        granted_connections: [{ connection_id: `conn_${c}`, display_name: `Connection ${c}` }],
        field_capabilities: Object.fromEntries(
          Array.from({ length: fieldsPerStream }, (_, f) => [
            `field_${f}`,
            {
              type: 'string',
              role: f === 0 ? 'primary-title' : undefined,
              granted: true,
              // The verbose per-field JSON Schema blob — the size driver the
              // compact projection drops. A real RS attaches the full declared
              // JSON Schema (descriptions, enums, examples, nested objects).
              schema: {
                type: 'string',
                description: 'x'.repeat(FIELD_SCHEMA_BLOB_PADDING),
                examples: Array.from({ length: 4 }, (_, e) => `example-${f}-${e}`.repeat(8)),
              },
              exact_filter: { declared: true, usable: true },
              range_filter: { declared: false, usable: false },
              lexical_search: { declared: f % 5 === 0, usable: f % 5 === 0 },
              semantic_search: { declared: f % 7 === 0, usable: f % 7 === 0 },
              aggregation: {
                sum: { declared: false, usable: false },
                count_distinct: { declared: true, usable: true },
              },
            },
          ]),
        ),
        expand_capabilities: [],
      })),
    };
  });

  const SCHEMA = {
    data: {
      object: 'schema',
      connector_count: connectorCount,
      stream_count: connectorCount * streamsPerConnector,
      connectors,
    },
  };

  const fetch = async (urlInput) => {
    const url = new URL(urlInput.toString());
    if (url.pathname === '/v1/schema') {
      const canonicalError = canonicalFullSchemaErrorForQuery(SCHEMA, url);
      if (canonicalError) return canonicalError;
      return new Response(JSON.stringify(schemaBodyForQuery(SCHEMA, url)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch, schemaBody: SCHEMA };
}

function schemaBodyForQuery(schemaBody, url) {
  const stream = url.searchParams.get('stream');
  const connectionId = url.searchParams.get('connection_id');
  const opts = { stream, connectionId };
  if (url.searchParams.get('view') === 'compact') {
    return { data: projectSchemaCompactView(schemaBody.data, opts) };
  }
  return { data: projectSchemaStreamScope(schemaBody.data, opts) };
}

function canonicalFullSchemaErrorForQuery(schemaBody, url) {
  if (url.searchParams.get('detail') !== 'full') return null;
  const stream = url.searchParams.get('stream');
  const connectionId = url.searchParams.get('connection_id');
  if (!stream) {
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
  if (!connectionId) {
    const available = schemaSourceOptions(schemaBody.data, { stream });
    if (available.length > 1) {
      return new Response(
        JSON.stringify({
          error: {
            type: 'ambiguous_schema_detail',
            code: 'ambiguous_schema_detail',
            param: 'connection_id',
            retry_with: 'connection_id',
            available_connections: available,
            message: `schema detail "full" for stream "${stream}" matches ${available.length} sources; retry with connection_id to fetch one source's exhaustive schema.`,
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    }
  }
  return null;
}

async function connectClient(fakeFetch) {
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch: fakeFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-token-budget-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

test('the fixture is large enough to model the ~2 MB verbatim-schema problem', async () => {
  const { schemaBody } = makeLargeSchemaFetch();
  const verbatimBytes = byteLength(schemaBody);
  // Sanity: the verbatim body must be large, so the budget assertions below
  // are meaningful rather than vacuously passing on a tiny fixture.
  assert.ok(
    verbatimBytes > 300_000,
    `fixture verbatim schema should be large to model the problem (got ${verbatimBytes} bytes)`,
  );
});

test('default schema response stays under the documented package byte budget', async () => {
  const { fetch, schemaBody } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(result.isError, undefined);

  const verbatimBytes = byteLength(schemaBody);
  const structuredBytes = byteLength(result.structuredContent);
  const contentBytes = Buffer.byteLength(result.content[0].text, 'utf8');

  assert.ok(
    structuredBytes < PACKAGE_SCHEMA_STRUCTURED_BYTE_BUDGET,
    `default schema structuredContent must stay under ${PACKAGE_SCHEMA_STRUCTURED_BYTE_BUDGET} bytes (got ${structuredBytes}; verbatim was ${verbatimBytes})`,
  );
  // The whole point: the default must be dramatically smaller than verbatim.
  assert.ok(
    structuredBytes < verbatimBytes / 5,
    `default schema must be far smaller than verbatim (got ${structuredBytes} vs verbatim ${verbatimBytes})`,
  );
  // The text summary stays bounded too.
  assert.ok(contentBytes < 8_000, `schema content[] summary must stay bounded (got ${contentBytes})`);

  await client.close();
  await server.close();
});

test('default schema is an index: drops field capability detail but keeps connection identity', async () => {
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: {} });
  const connector = result.structuredContent.data.connectors[0];
  const stream = connector.streams[0];

  assert.equal(
    stream.field_capabilities,
    undefined,
    'global compact schema must not carry per-field capability detail',
  );
  assert.deepEqual(result.structuredContent.data.field_capability_legend, {
    t: 'declared type',
    eq: 'exact filter supported',
    r: 'range filter operators',
    lex: 'lexical search field',
    sem: 'semantic search field',
    a: 'aggregation capabilities',
    'g=false': 'field is not granted',
  });
  assert.deepEqual(
    connector.granted_connections,
    [{ connection_id: 'conn_0', display_name: 'Connection 0' }],
    'compact schema must preserve shared connection identity at connector level',
  );
  assert.equal(stream.granted_connections, undefined, 'compact schema must not repeat shared connection identity per stream');
  assert.equal(stream.connection_id, 'conn_0', 'compact schema must keep connection_id');
  assert.equal(
    stream.connector_instance_id,
    undefined,
    'compact schema must omit deprecated connector_instance_id alias',
  );
  assert.equal(result.structuredContent.data.detail, 'compact');

  await client.close();
  await server.close();
});

test('MCP compact schema drops duplicate top-level streams when connectors are present', async () => {
  const { schemaBody } = makeLargeSchemaFetch({ connectorCount: 2, streamsPerConnector: 2, fieldsPerStream: 2 });
  schemaBody.data.streams = schemaBody.data.connectors.flatMap((connector) =>
    connector.streams.map((stream) => ({ ...stream, source: { connector_key: connector.connector_key } })),
  );
  const { client, server } = await connectClient(async (urlInput) => {
    const url = new URL(urlInput.toString());
    if (url.pathname === '/v1/schema') {
      return new Response(JSON.stringify(schemaBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });

  const result = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.data, undefined, 'schema MCP data must be the schema document, not a nested REST data envelope');
  assert.equal(
    result.structuredContent.data.streams,
    undefined,
    'MCP compact schema must not duplicate the same stream list at data.streams and connectors[].streams',
  );
  assert.ok(Array.isArray(result.structuredContent.data.connectors[0].streams));

  await client.close();
  await server.close();
});

test('global schema text indexes every stream name even when detailed rows are capped', async () => {
  const { fetch } = makeLargeSchemaFetch({ connectorCount: 4, streamsPerConnector: 20 });
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: {} });
  const text = result.content[0].text;

  assert.match(text, /stream_index connector_key="connector-3"/);
  assert.match(text, /stream_count=20 streams=stream_3_0\|stream_3_1/);
  assert.match(text, /stream_3_19/, 'a stream hidden beyond the detailed row cap must still be model-visible');
  assert.match(text, /more_streams=30/, 'detailed stream rows remain bounded');
  assert.ok(
    Buffer.byteLength(text, 'utf8') < 18_000,
    `indexed global schema text should stay bounded (got ${Buffer.byteLength(text, 'utf8')} bytes)`,
  );

  await client.close();
  await server.close();
});

test('default schema requests the REST compact view when the RS supports it', async () => {
  const { schemaBody } = makeLargeSchemaFetch();
  const requested = [];
  const fetch = async (urlInput) => {
    const url = new URL(urlInput.toString());
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/v1/schema' && url.searchParams.get('view') === 'compact') {
      const stream = url.searchParams.get('stream');
      return new Response(
        JSON.stringify({
          data: projectSchemaCompactView(schemaBody.data, { stream }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(schemaBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: { stream: 'stream_1_2' } });
  assert.equal(result.isError, undefined);

  assert.deepEqual(
    requested,
    ['/v1/schema?view=compact&stream=stream_1_2'],
    'compact MCP schema must delegate to the REST compact projection instead of fetching the full body first',
  );
  assert.deepEqual(result.structuredContent.data.field_capability_legend, {
    t: 'declared type',
    eq: 'exact filter supported',
    r: 'range filter operators',
    lex: 'lexical search field',
    sem: 'semantic search field',
    a: 'aggregation capabilities',
    'g=false': 'field is not granted',
  });
  const { field_capability_legend: _legend, ...actualWithoutLegend } = result.structuredContent.data;
  assert.deepEqual(
    actualWithoutLegend,
    mcpCompactSchemaExpected(schemaBody.data, { stream: 'stream_1_2' }),
    'MCP compact output must match the REST compact projection minus deprecated MCP aliases, plus its self-documenting legend',
  );

  await client.close();
  await server.close();
});

test('legacy full-schema fallback still renders the global MCP index projection', async () => {
  const { fetch, schemaBody } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: {} });
  assert.equal(result.isError, undefined);

  const expected = mcpCompactSchemaExpected(schemaBody.data);
  assert.equal(result.structuredContent.data.connectors.length, expected.connectors.length);
  assert.equal(result.structuredContent.data.connectors[0].streams[0].field_capabilities, undefined);
  assert.equal(result.structuredContent.data.detail, 'compact');

  await client.close();
  await server.close();
});

test('per-stream schema is usable and compact (the discovery middle step)', async () => {
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: { stream: 'stream_1_2' } });
  assert.equal(result.isError, undefined);

  const structuredBytes = byteLength(result.structuredContent);
  assert.ok(
    structuredBytes < STREAM_SCHEMA_STRUCTURED_BYTE_BUDGET,
    `per-stream schema must stay under ${STREAM_SCHEMA_STRUCTURED_BYTE_BUDGET} bytes (got ${structuredBytes})`,
  );

  // Exactly one connector with exactly the one requested stream survives.
  const connectors = result.structuredContent.data.connectors;
  assert.equal(connectors.length, 1, 'per-stream scope must keep only the contributing connector');
  assert.equal(connectors[0].streams.length, 1, 'per-stream scope must keep only the requested stream');
  assert.equal(connectors[0].streams[0].name, 'stream_1_2');
  assert.equal(result.structuredContent.data.stream_count, 1);
  // Still usable: capability flags survive on the scoped stream.
  assert.match(connectors[0].streams[0].field_capabilities.field_0, /t=string/);
  assert.match(connectors[0].streams[0].field_capabilities.field_0, /role=primary-title/);

  await client.close();
  await server.close();
});

test('stream-scoped schema text includes field detail across connectors sharing one stream name', async () => {
  const { fetch, schemaBody } = makeLargeSchemaFetch({ connectorCount: 2, streamsPerConnector: 1, fieldsPerStream: 4 });
  for (const connector of schemaBody.data.connectors) {
    connector.streams[0].name = 'messages';
  }
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: { stream: 'messages' } });
  const text = result.content[0].text;

  assert.match(text, /stream name="messages" connector_key="connector-0".*fields=/s);
  assert.match(text, /stream name="messages" connector_key="connector-1".*fields=/s);
  assert.match(text, /field_0\[t=string,role=primary-title,eq,lex,sem,a=count_distinct\]/);
  assert.match(text, /aggregations=count_distinct=field_0\|field_1\|field_2\|field_3/);

  await client.close();
  await server.close();
});

test('shared-stream detail=full requires connection_id instead of returning a multi-source schema dump', async () => {
  const { fetch, schemaBody } = makeLargeSchemaFetch({ connectorCount: 2, streamsPerConnector: 1, fieldsPerStream: 4 });
  for (const connector of schemaBody.data.connectors) {
    connector.streams[0].name = 'messages';
  }
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'schema',
    arguments: { stream: 'messages', detail: 'full' },
  });

  assert.equal(result.isError, true, 'ambiguous full schema must be rejected before sending a broad payload');
  assert.equal(result.structuredContent.error.code, 'ambiguous_schema_detail');
  assert.equal(result.structuredContent.error.retry_with, 'connection_id');
  assert.equal(result.structuredContent.error.available_connections.length, 2);
  assert.match(result.content[0].text, /connection_id/);

  await client.close();
  await server.close();
});

test('shared-stream detail=full with connection_id returns one source only', async () => {
  const { fetch, schemaBody } = makeLargeSchemaFetch({ connectorCount: 2, streamsPerConnector: 1, fieldsPerStream: 4 });
  for (const connector of schemaBody.data.connectors) {
    connector.streams[0].name = 'messages';
  }
  schemaBody.data.streams = schemaBody.data.connectors.flatMap((connector) =>
    connector.streams.map((stream) => ({ ...stream, source: { connector_key: connector.connector_key } })),
  );
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'schema',
    arguments: { stream: 'messages', connection_id: 'conn_1', detail: 'full' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.data, undefined, 'detail=full must not carry a second nested schema envelope');
  const connectors = result.structuredContent.data.connectors;
  assert.equal(connectors.length, 1);
  assert.equal(
    result.structuredContent.data.streams,
    undefined,
    'detail=full must not duplicate the selected stream in both data.streams and data.connectors[].streams',
  );
  assert.equal(connectors[0].connector_key, 'connector-1');
  assert.equal(connectors[0].streams.length, 1);
  assert.equal(connectors[0].streams[0].name, 'messages');
  assert.ok(connectors[0].streams[0].field_capabilities.field_0.schema, 'detail=full keeps raw JSON Schema');

  await client.close();
  await server.close();
});

test('per-stream + detail=full returns the exhaustive single-stream JSON Schema', async () => {
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'schema',
    arguments: { stream: 'stream_0_0', detail: 'full' },
  });
  assert.equal(result.isError, undefined);

  const stream = result.structuredContent.data.connectors[0].streams[0];
  assert.ok(stream.field_capabilities.field_0.schema, 'detail=full must retain per-field JSON Schema');
  assert.equal(
    stream.field_capabilities.field_0.schema.description.length,
    FIELD_SCHEMA_BLOB_PADDING,
    'detail=full must retain the full JSON Schema blob verbatim',
  );

  await client.close();
  await server.close();
});

test('global detail=full forwards to canonical RS rejection instead of MCP-local preflight', async () => {
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'schema', arguments: { detail: 'full' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'invalid_request');
  assert.equal(result.structuredContent.error.param, 'detail');
  assert.match(result.content[0].text, /requires `stream`/);

  await client.close();
  await server.close();
});

test('schema tool description teaches the compact discovery path', async () => {
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const schemaTool = tools.tools.find((t) => t.name === 'schema');

  assert.match(schemaTool.description, /compact/i, 'description must mention the compact default');
  assert.match(
    schemaTool.description,
    /schema\s*->\s*schema\(stream\)\s*->\s*schema\(stream,\s*connection_id\)\s*->\s*query_records/,
    'description must teach the scoped schema discovery path',
  );
  assert.match(schemaTool.description, /detail: "full"/, 'description must document the full opt-in');
  assert.match(schemaTool.description, /allowed only with `stream`/, 'description must prevent global full schema calls');

  // The detail/stream/connection inputs are advertised so an agent can opt in.
  assert.ok(schemaTool.inputSchema.properties.detail, 'schema must expose a detail input');
  assert.ok(schemaTool.inputSchema.properties.stream, 'schema must expose a stream input');
  assert.ok(schemaTool.inputSchema.properties.connection_id, 'schema must expose a connection_id input');
  assert.deepEqual(
    schemaTool.inputSchema.properties.detail.enum,
    ['compact', 'full'],
    'detail input must be a compact|full enum',
  );

  await client.close();
  await server.close();
});

test('query_records description documents the bounded default page and readable preview', async () => {
  // Token-efficiency guard for the query step of the discovery path. An agent
  // reading the tool description must be able to tell that calling
  // query_records without a `limit` is cheap and bounded (the RS defaults to 25
  // and caps at 100) and that the content[] text preview is readable without
  // pulling the full structured page. If a future edit drops these affordances
  // from the description, agents lose the signal that the call is safe to make
  // before knowing a stream is small.
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const queryTool = tools.tools.find((t) => t.name === 'query_records');
  assert.ok(queryTool, 'query_records tool must be exposed');

  assert.match(
    queryTool.description,
    /at most 25 records/,
    'description must state the default page size (25)',
  );
  assert.match(
    queryTool.description,
    /capped at 100/,
    'description must state the limit cap (100)',
  );
  assert.match(
    queryTool.description,
    /limit_clamped/,
    'description must name the REST limit_clamped warning so the behavior is never silent',
  );
  assert.match(
    queryTool.description,
    /previews up to the first 5 records/,
    'description must state the bounded readable record preview',
  );
  assert.match(
    queryTool.description,
    /structuredContent\.data/,
    'description must point at the machine envelope in structuredContent.data',
  );

  await client.close();
  await server.close();
});

test('fetch description documents projected text fallback', async () => {
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const fetchTool = tools.tools.find((t) => t.name === 'fetch');
  assert.ok(fetchTool, 'fetch tool must be exposed');

  assert.match(
    fetchTool.description,
    /if the projection excludes every text-like field/i,
    'description must explain that fetch(fields) can project away the document body',
  );
  assert.match(
    fetchTool.description,
    /compact JSON for the projected record/i,
    'description must explain what appears in text when no text-like field remains',
  );

  await client.close();
  await server.close();
});

test('query_records input schema caps `limit` at 100 and rejects an over-max value', async () => {
  // The MCP layer mirrors the spec-core §8 contract (`limit` max 100). Rather
  // than forward `limit=500` and let the RS silently clamp it, the tool's input
  // schema caps `limit` at 100 so an over-max value is rejected at validation —
  // the page size an agent asks for through this tool is the page size it gets.
  const { fetch } = makeLargeSchemaFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const queryTool = tools.tools.find((t) => t.name === 'query_records');
  assert.ok(queryTool, 'query_records tool must be exposed');
  assert.equal(
    queryTool.inputSchema.properties.limit.maximum,
    100,
    'limit input must advertise the contract maximum of 100',
  );

  // The MCP SDK validates arguments against the published input schema before
  // the handler runs, returning a typed input-validation error result (it does
  // not reach the RS). An over-max `limit` therefore never silently clamps.
  const overMax = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', limit: 500 },
  });
  assert.equal(overMax.isError, true, 'an over-max limit must be an error result');
  const overMaxText = overMax.content?.map((c) => c.text ?? '').join('\n') ?? '';
  assert.match(
    overMaxText,
    /validation|too_big|less than or equal to 100/i,
    'the error must be an input-validation rejection of the over-max limit',
  );

  // The cap is inclusive: `limit=100` is a valid argument against the published
  // schema (proves the boundary is not a blanket rejection of large pages).
  const limitSchema = queryTool.inputSchema.properties.limit;
  assert.equal(limitSchema.maximum, 100);
  assert.ok(
    limitSchema.exclusiveMaximum === undefined,
    'the maximum must be inclusive so limit=100 is accepted',
  );

  await client.close();
  await server.close();
});

test('compact projection scales: doubling field count does not blow the budget', async () => {
  // Guards against the compact projection accidentally retaining per-field size
  // drivers — if it did, doubling fields would roughly double the payload and
  // approach the verbatim curve.
  const small = makeLargeSchemaFetch({ fieldsPerStream: 15 });
  const large = makeLargeSchemaFetch({ fieldsPerStream: 30 });

  const { client: c1, server: s1 } = await connectClient(small.fetch);
  const r1 = await c1.callTool({ name: 'schema', arguments: {} });
  const bytes1 = byteLength(r1.structuredContent);
  await c1.close();
  await s1.close();

  const { client: c2, server: s2 } = await connectClient(large.fetch);
  const r2 = await c2.callTool({ name: 'schema', arguments: {} });
  const bytes2 = byteLength(r2.structuredContent);
  await c2.close();
  await s2.close();

  assert.ok(
    bytes2 < PACKAGE_SCHEMA_STRUCTURED_BYTE_BUDGET,
    `compact schema must stay under budget even at 30 fields/stream (got ${bytes2})`,
  );
  // The compact field projection is small per field, so the growth from 15->30
  // fields is bounded and nowhere near the verbatim ~1.2 KB/field blob.
  const perFieldGrowth = (bytes2 - bytes1) / (15 * 4 * 6); // added fields * connectors * streams
  assert.ok(
    perFieldGrowth < 200,
    `compact per-field cost must stay small (got ~${Math.round(perFieldGrowth)} bytes/field)`,
  );
});

// Defense-in-depth for the `schema` tool `detail` grade. The Zod enum
// (`compact|full`) already protects the normal MCP boundary; this pins the
// handler's internal resolution so a value that slips past Zod (a future enum
// loosening, or a caller that bypasses the parse) fails loudly instead of
// silently downgrading the response to `compact`.
test('resolveSchemaDetail defaults to compact, passes valid grades, and rejects unknown values', async () => {
  const { __internal } = await import('../src/tools.js');
  const { resolveSchemaDetail } = __internal;
  assert.equal(resolveSchemaDetail(undefined), 'compact', 'absent detail defaults to compact');
  assert.equal(resolveSchemaDetail(null), 'compact');
  assert.equal(resolveSchemaDetail('compact'), 'compact');
  assert.equal(resolveSchemaDetail('full'), 'full', 'full is preserved, not coerced');
  // Anything outside the enum must throw, not silently coerce to compact.
  assert.throws(() => resolveSchemaDetail('summary'), /Invalid schema detail/);
  assert.throws(() => resolveSchemaDetail('FULL'), /Invalid schema detail/);
  assert.throws(() => resolveSchemaDetail(''), /Invalid schema detail/);
});

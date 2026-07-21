// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'tsx';

import { handleStreamableHttpRequest } from '../src/server.js';

const { projectSchemaCompactView, projectSchemaStreamScope, schemaSourceOptions } = await import(
  '../../../reference-implementation/operations/rs-schema-get/compact-view.ts'
);

// Hosted-transport parity for the `schema` MCP tool token budget.
//
// `schema-token-budget.test.js` proves the compact default over the in-memory
// transport (the stdio/local path). This file closes the remaining residual
// risk called out in
// `tmp/workstreams/ri-mcp-schema-token-efficiency-closeout-v1-report.md`:
//
//   "Hosted MCP gateway parity is out-of-repo ... If the hosted gateway
//    re-serializes global schema verbatim, an agent there could still see
//    ~1.4 MB."
//
// The hosted ChatGPT/Claude *registration* is external, but the bytes those
// gateways forward are produced in-repo by `handleStreamableHttpRequest`, which
// builds the very same tools through `createPdppMcpServer` -> `buildTools` ->
// `toSchemaToolResult`. The one thing the in-memory test does NOT prove is that
// the compact projection survives the real Streamable HTTP JSON-RPC wire: a
// `tools/call` for `schema` issued over `handleStreamableHttpRequest`, with the
// response parsed back off the wire, must carry the same compact budget.
//
// These tests drive `tools/call schema` (default and `detail: "full"`) through
// the hosted transport and measure the on-wire payload. They are the in-repo
// proof that the hosted gateway path serves the compact default and keeps the
// `detail: "full"` escape hatch scoped instead of grant-wide.

// Mirror the budgets asserted over the in-memory transport. The hosted wire
// frames the same `structuredContent`, so the same regression guard applies.
const PACKAGE_SCHEMA_STRUCTURED_BYTE_BUDGET = 60_000; // full grant, all streams
const FIELD_SCHEMA_BLOB_PADDING = 1_200;

// Exercise the hosted transport with the same initialize-then-tools/call shape a
// gateway uses, while keeping the test stateless so no session id is threaded.
const PROTOCOL_VERSION = '2025-06-18';

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
              granted: true,
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

  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    const auth = init.headers?.Authorization;
    if (auth !== 'Bearer scoped-token') {
      return new Response(
        JSON.stringify({ error: { type: 'authentication', code: 'invalid_token' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
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
    },
  );
}

// Streamable HTTP with enableJsonResponse may answer as a single JSON body or as
// an SSE `data:` frame depending on the request. Parse either into the JSON-RPC
// response object so the assertions read the same on-wire bytes a gateway sees.
async function readJsonRpc(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter(Boolean);
    assert.ok(dataLines.length > 0, `SSE response carried no data frame: ${text.slice(0, 200)}`);
    // The final data frame holds the JSON-RPC response for the request id.
    return JSON.parse(dataLines.at(-1));
  }
  return JSON.parse(text);
}

// A stateless hosted request that needs an initialized session: the SDK lets a
// single `tools/call` succeed without a prior handshake on the same connection
// only when session ids are disabled. We mirror a real gateway by sending the
// initialize first, then the tools/call, each as its own stateless request.
async function callSchemaTool(args, fakeFetch) {
  // Initialize handshake (stateless; no session id threaded back).
  const init = await postMcpJson(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'hosted-budget-test', version: '0.0.0' },
      },
    },
    fakeFetch,
  );
  assert.equal(init.status, 200, 'hosted initialize must succeed');

  const response = await postMcpJson(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'schema', arguments: args },
    },
    fakeFetch,
  );
  assert.equal(response.status, 200, 'hosted tools/call must succeed');
  const rpc = await readJsonRpc(response);
  assert.equal(rpc.error, undefined, `tools/call returned a JSON-RPC error: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}

test('hosted Streamable HTTP schema tool/call serves the compact default under the package byte budget', async () => {
  const { fetch, schemaBody } = makeLargeSchemaFetch();

  const result = await callSchemaTool({}, fetch);
  assert.equal(result.isError, undefined, 'hosted schema call must not be an error result');

  const verbatimBytes = Buffer.byteLength(JSON.stringify(schemaBody), 'utf8');
  const structuredBytes = Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8');

  assert.ok(
    structuredBytes < PACKAGE_SCHEMA_STRUCTURED_BYTE_BUDGET,
    `hosted default schema must stay under ${PACKAGE_SCHEMA_STRUCTURED_BYTE_BUDGET} bytes over the wire (got ${structuredBytes}; verbatim was ${verbatimBytes})`,
  );
  assert.ok(
    structuredBytes < verbatimBytes / 5,
    `hosted default schema must be far smaller than verbatim (got ${structuredBytes} vs verbatim ${verbatimBytes})`,
  );

  // The compact grade survives the wire as an index: field capability detail is
  // absent by default, and connection identity is preserved.
  const stream = result.structuredContent.data.connectors[0].streams[0];
  assert.equal(
    stream.field_capabilities,
    undefined,
    'hosted global compact schema must not include per-field capability detail',
  );
  assert.equal(stream.connection_id, 'conn_0', 'hosted compact schema must keep connection_id');
  assert.equal(result.structuredContent.data.detail, 'compact', 'hosted default must report detail=compact');
});

test('hosted Streamable HTTP forwards global schema detail=full to canonical RS rejection', async () => {
  const { fetch } = makeLargeSchemaFetch();

  const result = await callSchemaTool({ detail: 'full' }, fetch);
  assert.equal(result.isError, true, 'hosted global full schema call must be an error result');
  assert.equal(result.structuredContent.error.code, 'invalid_request');
  assert.equal(result.structuredContent.error.param, 'detail');
  assert.match(result.content[0].text, /requires `stream`/);
});

test('hosted Streamable HTTP per-stream schema scopes the document over the wire', async () => {
  const { fetch } = makeLargeSchemaFetch();

  const result = await callSchemaTool({ stream: 'stream_1_2' }, fetch);
  assert.equal(result.isError, undefined, 'hosted per-stream schema call must not be an error result');

  const connectors = result.structuredContent.data.connectors;
  assert.equal(connectors.length, 1, 'hosted per-stream scope must keep only the contributing connector');
  assert.equal(connectors[0].streams.length, 1, 'hosted per-stream scope must keep only the requested stream');
  assert.equal(connectors[0].streams[0].name, 'stream_1_2');
  assert.equal(
    typeof connectors[0].streams[0].field_capabilities.field_0,
    'string',
    'hosted stream-scoped compact schema must keep field capability flags',
  );
});

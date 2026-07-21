/**
 * Regression tests for MCP tool-surface footprint reduction.
 *
 * Asserts:
 * - initialize includes server instructions covering core PDPP usage guidance
 * - tools/list exposes the exact profile-free normal read surface
 * - tools/list serialized size stays below its budget
 * - filter remains object-shaped for query_records, aggregate, and search
 * - connection_id recovery paragraph is not duplicated verbatim across tool schemas
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  PDPP_MCP_TOOL_NAMES,
  createPdppMcpServer,
  handleStreamableHttpRequest,
  PDPP_MCP_INSTRUCTIONS,
} from '../src/server.js';

const NORMAL_SURFACE_BYTE_BUDGET = 24 * 1024;

function makeFakeRs() {
  const fetch = async () =>
    new Response(JSON.stringify({ streams: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  return { fetch };
}

async function connectClient() {
  const { fetch } = makeFakeRs();
  const { server } = createPdppMcpServer({
    providerUrl: 'https://pdpp.test',
    accessToken: 'test-token',
    fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function postHostedMcpJson(message) {
  const { fetch } = makeFakeRs();
  return await handleStreamableHttpRequest(
    new Request('https://pdpp.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    }),
    {
      providerUrl: 'https://pdpp.test',
      accessToken: 'test-token',
      fetch,
    },
  );
}

async function readJsonRpc(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) return JSON.parse(text);
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  assert.ok(dataLines.length > 0, `SSE response carried no data frame: ${text.slice(0, 200)}`);
  return JSON.parse(dataLines.at(-1));
}

test('initialize includes server instructions', async () => {
  const { client } = await connectClient();
  const instructions = client.getInstructions();
  assert.ok(
    typeof PDPP_MCP_INSTRUCTIONS === 'string' && PDPP_MCP_INSTRUCTIONS.length > 0,
    'PDPP_MCP_INSTRUCTIONS must be a non-empty string',
  );
  assert.equal(instructions, PDPP_MCP_INSTRUCTIONS, 'initialize must expose server instructions');
});

test('instructions first 512 chars mention schema-first, connection_id, typed filters, paging', () => {
  const first512 = PDPP_MCP_INSTRUCTIONS.slice(0, 512);
  assert.ok(
    first512.includes('schema'),
    'first 512 chars must mention schema-first discovery',
  );
  assert.ok(first512.includes('connection_id'), 'first 512 chars must mention connection_id');
  assert.ok(
    /filter/i.test(first512) || /typed/i.test(first512),
    'first 512 chars must mention typed filters',
  );
  assert.ok(
    /limit|page|narrow|cursor/i.test(first512),
    'first 512 chars must mention paging/narrowing',
  );
});

test('instructions keep resource reads optional for ordinary evidence', () => {
  assert.match(PDPP_MCP_INSTRUCTIONS, /read_record_field/);
  assert.match(PDPP_MCP_INSTRUCTIONS, /projected records/);
  assert.match(PDPP_MCP_INSTRUCTIONS, /bounded field windows/);
  assert.doesNotMatch(
    PDPP_MCP_INSTRUCTIONS,
    /read the returned `pdpp:\/\/record\/\.\.\.` and `pdpp:\/\/field-window\/\.\.\.` resource URIs/
  );
});

test('setup docs enumerate the normal MCP read surface without event-management overclaim', () => {
  const hostedSetup = readFileSync(new URL('../../../docs/operator/hosted-mcp-setup.md', import.meta.url), 'utf8');
  const selfhostQuickstart = readFileSync(
    new URL('../../../docs/operator/selfhost-quickstart.md', import.meta.url),
    'utf8'
  );

  for (const toolName of PDPP_MCP_TOOL_NAMES) {
    assert.match(hostedSetup, new RegExp(`\\\`${toolName}\\\``), `hosted setup must mention ${toolName}`);
  }
  assert.match(
    hostedSetup,
    /read_record_field` is the model-callable bounded-read path/,
    'hosted setup must teach the bounded-read continuation path'
  );
  assert.doesNotMatch(
    selfhostQuickstart,
    /supports\s+PDPP read tools and event-subscription management/i,
    'normal /mcp docs must not claim support for event-subscription management as part of the read surface'
  );
  assert.match(
    selfhostQuickstart,
    /event-subscription management stays in\s+the operator console and REST\/control-plane docs/i
  );
});

test('tools/list exposes exact profile-free normal read surface', async () => {
  const { client, server } = await connectClient();
  try {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    const expected = [...PDPP_MCP_TOOL_NAMES].sort();
    assert.deepEqual(names, expected, `normal surface tools must be: ${expected.join(', ')}`);
  } finally {
    await client.close();
    await server.close();
  }
});

test('hosted tools/list exposes read-only annotations for every normal tool', async () => {
  const init = await postHostedMcpJson({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'hosted-tool-footprint-test', version: '0.0.0' },
    },
  });
  assert.equal(init.status, 200, 'hosted initialize must succeed');

  const response = await postHostedMcpJson({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  assert.equal(response.status, 200, 'hosted tools/list must succeed');
  const rpc = await readJsonRpc(response);
  assert.equal(rpc.error, undefined, `tools/list returned JSON-RPC error: ${JSON.stringify(rpc.error)}`);

  const tools = rpc.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...PDPP_MCP_TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} destructiveHint`);
    assert.equal(tool.annotations?.idempotentHint, true, `${tool.name} idempotentHint`);
    assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} openWorldHint`);
  }
});

test('record handle tool schemas teach pdpp record uri continuation', async () => {
  const { client, server } = await connectClient();
  try {
    const result = await client.listTools();
    const fetchTool = result.tools.find((tool) => tool.name === 'fetch');
    const readFieldTool = result.tools.find((tool) => tool.name === 'read_record_field');

    assert.match(fetchTool?.inputSchema?.properties?.id?.description ?? '', /pdpp:\/\/record/);
    assert.match(readFieldTool?.description ?? '', /pdpp:\/\/record/);
    assert.match(readFieldTool?.inputSchema?.properties?.id?.description ?? '', /pdpp:\/\/record/);
  } finally {
    await client.close();
    server.close();
  }
});

test('tools/list serialized size is below normal surface budget', async () => {
  const { client, server } = await connectClient();
  try {
    const result = await client.listTools();
    const serialized = JSON.stringify(result.tools);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    assert.ok(
      bytes < NORMAL_SURFACE_BYTE_BUDGET,
      `normal tools/list is ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB), expected < ${NORMAL_SURFACE_BYTE_BUDGET} bytes`,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('normal surface does not expose event or developer/test tools', async () => {
  const { client, server } = await connectClient();
  try {
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    for (const disallowed of [
      'list_streams',
      'fetch_blob',
      'discover_event_subscription_capabilities',
      'create_event_subscription',
      'list_event_subscriptions',
      'get_event_subscription',
      'update_event_subscription',
      'delete_event_subscription',
      'send_test_event',
    ]) {
      assert.equal(names.has(disallowed), false, `normal surface must not expose ${disallowed}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('filter is object-shaped for query_records, aggregate, and search', async () => {
  const { client } = await connectClient();
  const result = await client.listTools();
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));

  for (const toolName of ['query_records', 'aggregate', 'search']) {
    const tool = byName[toolName];
    assert.ok(tool, `${toolName} must exist`);
    const filterSchema = tool.inputSchema?.properties?.filter;
    assert.ok(filterSchema, `${toolName} must have a filter property`);
    // filter must be typed as object (record/additionalProperties), not a string
    assert.notEqual(
      filterSchema.type,
      'string',
      `${toolName} filter must not be type:string (should be object)`,
    );
  }
});

test('long connection_id recovery paragraph is not repeated across tools', async () => {
  const { client } = await connectClient();
  const result = await client.listTools();

  // A distinctive phrase from the old long CONNECTION_ID_DESCRIPTION
  const longPhraseFragment = 'can change when the owner reconnects';

  const toolsWithLongPhrase = result.tools.filter((t) =>
    t.description?.includes(longPhraseFragment),
  );
  assert.equal(
    toolsWithLongPhrase.length,
    0,
    `Long connection_id recovery text ("${longPhraseFragment}") must not appear in any tool description`,
  );
});

/**
 * Regression tests for MCP tool-surface footprint reduction.
 *
 * Asserts:
 * - initialize includes server instructions covering core PDPP usage guidance
 * - tools/list exposes exactly 14 tool names
 * - tools/list serialized size is below 45 KB
 * - filter remains object-shaped for query_records, aggregate, and search
 * - long event-subscription guidance is not duplicated across CRUD tools
 * - connection_id recovery paragraph is not duplicated verbatim across tool schemas
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer, PDPP_MCP_INSTRUCTIONS } from '../src/server.js';
import { buildTools } from '../src/tools.js';

const EXPECTED_TOOL_NAMES = [
  'schema',
  'list_streams',
  'query_records',
  'aggregate',
  'search',
  'fetch',
  'discover_event_subscription_capabilities',
  'create_event_subscription',
  'list_event_subscriptions',
  'get_event_subscription',
  'update_event_subscription',
  'delete_event_subscription',
  'send_test_event',
  'fetch_blob',
];

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
    first512.includes('schema') || first512.includes('list_streams'),
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

test('tools/list exposes exactly 14 tool names', async () => {
  const { client } = await connectClient();
  const result = await client.listTools();
  const names = result.tools.map((t) => t.name).sort();
  const expected = [...EXPECTED_TOOL_NAMES].sort();
  assert.deepEqual(names, expected, `Expected 14 tools: ${expected.join(', ')}`);
});

test('tools/list serialized size is below 45 KB', async () => {
  const { client } = await connectClient();
  const result = await client.listTools();
  const serialized = JSON.stringify(result.tools);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  assert.ok(
    bytes < 45 * 1024,
    `tools/list is ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB), expected < 45 KB`,
  );
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

test('long event-subscription footer does not appear verbatim on CRUD tools', async () => {
  const { client } = await connectClient();
  const result = await client.listTools();
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));

  // The long footer text that appeared on every event tool pre-refactor
  const oldFooterFragment =
    'Standard Webhooks';

  const crudEventTools = [
    'create_event_subscription',
    'list_event_subscriptions',
    'get_event_subscription',
    'update_event_subscription',
    'delete_event_subscription',
    'send_test_event',
  ];

  for (const toolName of crudEventTools) {
    const tool = byName[toolName];
    assert.ok(tool, `${toolName} must exist`);
    assert.ok(
      !tool.description?.includes(oldFooterFragment),
      `${toolName} must not contain the long event-subscription footer ("${oldFooterFragment}"); move it to discover_event_subscription_capabilities`,
    );
  }

  const discovery = byName.discover_event_subscription_capabilities;
  assert.ok(discovery.description.includes(oldFooterFragment), 'discovery tool keeps the signing contract');
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

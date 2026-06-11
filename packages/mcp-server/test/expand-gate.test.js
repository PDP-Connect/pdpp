/**
 * Tests for the per-stream expand capability gate.
 *
 * The MCP adapter must reject `expand` requests on streams that do not
 * advertise `expand_capabilities` in GET /v1/schema, returning a typed
 * `invalid_expand` error. Streams that DO advertise expand_capabilities must
 * pass through to the RS without interference.
 *
 * Three conformance properties verified:
 *   1. Advertised expand on a capable stream → forwarded (no early rejection).
 *   2. Unadvertised expand on a stream with no expand_capabilities → typed
 *      `invalid_expand` adapter error before any records call reaches the RS.
 *   3. Schema advertisement matches enforcement: the gate uses the live schema
 *      document, so changes to advertised expand_capabilities take effect
 *      immediately without any tool restart.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';
import { __internal } from '../src/tools.js';

const { assertExpandCapabilities, UnadvertisedExpandError } = __internal;

// ── Unit tests for assertExpandCapabilities ──────────────────────────────────

function makeSchemaRs(streamRows) {
  return {
    getJson: async (path, opts = {}) => {
      if (path === '/v1/schema') {
        const requestedStream = opts.query?.stream;
        const rows = requestedStream
          ? streamRows.filter((s) => s.name === requestedStream || s.stream === requestedStream)
          : streamRows;
        return {
          ok: true,
          body: { object: 'schema', streams: rows },
          status: 200,
          requestId: null,
        };
      }
      return { ok: false, status: 404, error: { code: 'not_found' }, requestId: null };
    },
  };
}

test('assertExpandCapabilities: passes silently when stream has expand_capabilities', async () => {
  const rs = makeSchemaRs([
    {
      name: 'transactions',
      expand_capabilities: [{ name: 'account', cardinality: 'has_one' }],
    },
  ]);
  // Must not throw
  await assertExpandCapabilities(rs, 'transactions', ['account'], undefined);
});

test('assertExpandCapabilities: throws UnadvertisedExpandError when stream has no expand_capabilities', async () => {
  const rs = makeSchemaRs([
    { name: 'statements' /* no expand_capabilities field */ },
  ]);
  await assert.rejects(
    () => assertExpandCapabilities(rs, 'statements', ['transactions'], undefined),
    (err) => {
      assert.ok(err instanceof UnadvertisedExpandError, 'error must be UnadvertisedExpandError');
      assert.equal(err.code, 'invalid_expand', 'error.code must be invalid_expand');
      assert.ok(err.message.includes('statements'), 'message must name the stream');
      assert.ok(err.message.includes('transactions'), 'message must name the requested relation');
      return true;
    },
  );
});

test('assertExpandCapabilities: throws UnadvertisedExpandError when expand_capabilities is an empty array', async () => {
  const rs = makeSchemaRs([{ name: 'accounts', expand_capabilities: [] }]);
  await assert.rejects(
    () => assertExpandCapabilities(rs, 'accounts', ['statements'], undefined),
    (err) => {
      assert.equal(err.code, 'invalid_expand');
      return true;
    },
  );
});

test('assertExpandCapabilities: passes silently when schema fetch fails (let RS enforce)', async () => {
  const rs = {
    getJson: async () => ({ ok: false, status: 503, error: { code: 'unavailable' }, requestId: null }),
  };
  // Must not throw — RS unavailability must not block the call
  await assertExpandCapabilities(rs, 'any_stream', ['rel'], undefined);
});

test('assertExpandCapabilities: passes silently when stream is unknown in schema (let RS enforce)', async () => {
  const rs = makeSchemaRs([{ name: 'other_stream', expand_capabilities: [] }]);
  // 'unknown_stream' not in schema — let RS reject
  await assertExpandCapabilities(rs, 'unknown_stream', ['rel'], undefined);
});

test('assertExpandCapabilities: forwards connection_id to schema request', async () => {
  const seen = [];
  const rs = {
    getJson: async (path, opts = {}) => {
      seen.push({ path, query: opts.query });
      return {
        ok: true,
        body: {
          object: 'schema',
          streams: [{ name: 'transactions', expand_capabilities: [{ name: 'account' }] }],
        },
        status: 200,
        requestId: null,
      };
    },
  };
  await assertExpandCapabilities(rs, 'transactions', ['account'], 'conn_chase');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].query?.connection_id, 'conn_chase', 'connection_id must be forwarded to schema call');
});

// ── Integration tests via MCP client ─────────────────────────────────────────

function makeIntegrationRs({ streamName, hasExpandCaps, recordsBody }) {
  const calls = [];
  const fetch = async (urlInput) => {
    const url = new URL(urlInput.toString());
    calls.push(url.pathname + url.search);

    if (url.pathname === '/v1/schema') {
      const expandCaps = hasExpandCaps
        ? [{ name: 'account', cardinality: 'has_one', usable: true }]
        : undefined;
      const stream = { name: streamName };
      if (expandCaps !== undefined) stream.expand_capabilities = expandCaps;
      return new Response(
        JSON.stringify({ object: 'schema', streams: [stream] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname.startsWith(`/v1/streams/${encodeURIComponent(streamName)}/records`)) {
      return new Response(
        JSON.stringify(recordsBody ?? { records: [], has_more: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ error: { code: 'not_found', message: 'not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, getCalls: () => calls };
}

async function connectClient(rsOptions) {
  const { fetch } = rsOptions;
  const { server } = createPdppMcpServer({
    providerUrl: 'https://pdpp.test',
    accessToken: 'test-token',
    fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, getCalls: rsOptions.getCalls };
}

test('query_records: advertised expand is forwarded to RS (no early rejection)', async () => {
  const rsOptions = makeIntegrationRs({ streamName: 'transactions', hasExpandCaps: true });
  const { client, getCalls } = await connectClient(rsOptions);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'transactions', expand: ['account'] },
  });

  assert.equal(result.isError, undefined, `must not be an error; got: ${JSON.stringify(result)}`);
  const recordsCalls = getCalls().filter((c) => c.includes('/records'));
  assert.ok(recordsCalls.length > 0, 'records endpoint must be called when expand is advertised');
  assert.ok(
    recordsCalls.some((c) => c.includes('expand=account')),
    'expand relation must be forwarded in query string',
  );
});

test('query_records: unadvertised expand returns typed invalid_expand error', async () => {
  const rsOptions = makeIntegrationRs({ streamName: 'statements', hasExpandCaps: false });
  const { client, getCalls } = await connectClient(rsOptions);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'statements', expand: ['transactions'] },
  });

  assert.equal(result.isError, true, 'result must be an error');
  const text = result.content?.[0]?.text ?? '';
  const parsed = JSON.parse(text);
  assert.equal(parsed.code, 'invalid_expand', 'error code must be invalid_expand');
  assert.ok(parsed.message.includes('statements'), 'error must name the stream');

  const recordsCalls = getCalls().filter((c) => c.includes('/records'));
  assert.equal(recordsCalls.length, 0, 'records endpoint must NOT be called when expand is unadvertised');
});

test('query_records: schema advertisement matches enforcement (expand_capabilities added → passes)', async () => {
  // Simulate a schema where expand_capabilities is present — must pass through.
  const rsOptions = makeIntegrationRs({
    streamName: 'conversations',
    hasExpandCaps: true,
    recordsBody: { records: [{ id: 'c1', title: 'Test' }], has_more: false },
  });
  const { client } = await connectClient(rsOptions);

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'conversations', expand: ['messages'] },
  });
  assert.equal(result.isError, undefined, 'must succeed when expand_capabilities is advertised');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

// Asserts the local @pdpp/mcp-server forwards `connection_id` (and the
// deprecated `connector_instance_id` alias) verbatim to the RS so multi-
// connection callers can disambiguate without an extra round trip. Owned
// by openspec/changes/expose-connection-identity-on-public-read.

function makeRecordingFetch() {
  const calls = [];
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? 'GET' });

    if (url.pathname === '/v1/streams') {
      return jsonResponse({
        streams: [
          {
            object: 'stream',
            name: 'orders',
            connection_id: 'cin_aaa',
            display_name: 'peregrine Amazon',
            connector_instance_id: 'cin_aaa',
          },
          {
            object: 'stream',
            name: 'orders',
            connection_id: 'cin_bbb',
            display_name: 'vivid fish Amazon',
            connector_instance_id: 'cin_bbb',
          },
        ],
      });
    }
    if (url.pathname === '/v1/streams/orders/records') {
      return jsonResponse({ records: [] });
    }
    if (url.pathname === '/v1/search') {
      return jsonResponse({ hits: [] });
    }
    if (url.pathname === '/v1/streams/orders/records/o1') {
      // Echo back an ambiguous_connection 409 so the caller can prove it
      // received the typed envelope and would know how to retry.
      const conn = url.searchParams.get('connection_id');
      if (!conn) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request',
              code: 'ambiguous_connection',
              message:
                "Record id 'o1' resolves to more than one connection under the caller's grant.",
              request_id: 'req-ambig-1',
              available_connections: [
                { connection_id: 'cin_aaa', display_name: 'peregrine Amazon' },
                { connection_id: 'cin_bbb', display_name: 'vivid fish Amazon' },
              ],
              retry_with: {
                field: 'connection_id',
                guidance: 'Retry with one of the listed connection_id values.',
              },
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        );
      }
      return jsonResponse({ id: 'o1', stream: 'orders', connection_id: conn });
    }
    if (url.pathname === '/v1/blobs/blob-1') {
      const conn = url.searchParams.get('connection_id');
      if (!conn) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request',
              code: 'ambiguous_connection',
              message: "Blob 'blob-1' resolves to more than one connection under the caller's grant.",
              request_id: 'req-ambig-2',
              available_connections: [
                { connection_id: 'cin_aaa', display_name: 'peregrine Amazon' },
                { connection_id: 'cin_bbb', display_name: 'vivid fish Amazon' },
              ],
              retry_with: {
                field: 'connection_id',
                guidance: 'Retry with one of the listed connection_id values.',
              },
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
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
  const client = new Client({ name: 'connection-id-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function findCall(calls, predicate) {
  const call = calls.find((entry) => predicate(new URL(entry.url)));
  assert.ok(call, 'expected a matching call to RS');
  return new URL(call.url);
}

test('list_streams forwards connection_id and exposes it as a tool input', async () => {
  const { fetch, calls } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const listStreams = tools.tools.find((tool) => tool.name === 'list_streams');
  assert.ok(listStreams.inputSchema.properties.connection_id, 'list_streams must declare connection_id');
  assert.ok(
    listStreams.inputSchema.properties.connector_instance_id,
    'list_streams must declare connector_instance_id alias',
  );
  assert.match(
    listStreams.description,
    /connection_id/,
    'list_streams description must advertise connection_id',
  );

  await client.callTool({ name: 'list_streams', arguments: { connection_id: 'cin_aaa' } });
  const url = findCall(calls, (u) => u.pathname === '/v1/streams');
  assert.equal(url.searchParams.get('connection_id'), 'cin_aaa');

  await client.close();
  await server.close();
});

test('query_records forwards connection_id', async () => {
  const { fetch, calls } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', connection_id: 'cin_bbb' },
  });
  const url = findCall(calls, (u) => u.pathname === '/v1/streams/orders/records');
  assert.equal(url.searchParams.get('connection_id'), 'cin_bbb');

  await client.close();
  await server.close();
});

test('query_records forwards the deprecated connector_instance_id alias verbatim', async () => {
  const { fetch, calls } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  await client.callTool({
    name: 'query_records',
    arguments: { stream: 'orders', connector_instance_id: 'cin_aaa' },
  });
  const url = findCall(calls, (u) => u.pathname === '/v1/streams/orders/records');
  assert.equal(url.searchParams.get('connector_instance_id'), 'cin_aaa');
  assert.equal(url.searchParams.get('connection_id'), null);

  await client.close();
  await server.close();
});

test('search forwards connection_id', async () => {
  const { fetch, calls } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  await client.callTool({
    name: 'search',
    arguments: { q: 'pasta', connection_id: 'cin_bbb' },
  });
  const url = findCall(calls, (u) => u.pathname === '/v1/search');
  assert.equal(url.searchParams.get('connection_id'), 'cin_bbb');

  await client.close();
  await server.close();
});

test('fetch surfaces ambiguous_connection envelope and accepts retry with connection_id', async () => {
  const { fetch, calls } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  // First call without connection_id: RS returns 409 ambiguous_connection.
  const ambiguous = await client.callTool({ name: 'fetch', arguments: { id: 'orders:o1' } });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.structuredContent.error.code, 'ambiguous_connection');
  assert.equal(
    ambiguous.structuredContent.error.available_connections.length,
    2,
    'envelope must list candidate connections',
  );
  assert.equal(
    ambiguous.structuredContent.error.retry_with.field,
    'connection_id',
    'envelope must direct the caller to connection_id',
  );

  // Retry passing connection_id from the envelope. Tool succeeds and the
  // RS sees the forwarded query param.
  const retried = await client.callTool({
    name: 'fetch',
    arguments: { id: 'orders:o1', connection_id: 'cin_aaa' },
  });
  assert.equal(retried.isError, undefined);
  const retryUrl = findCall(
    calls.filter((c) => c.url.includes('/v1/streams/orders/records/o1')),
    (u) => u.searchParams.get('connection_id') === 'cin_aaa',
  );
  assert.equal(retryUrl.searchParams.get('connection_id'), 'cin_aaa');

  await client.close();
  await server.close();
});

test('fetch_blob surfaces ambiguous_connection envelope and forwards connection_id', async () => {
  const { fetch, calls } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  const ambiguous = await client.callTool({ name: 'fetch_blob', arguments: { blob_id: 'blob-1' } });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.structuredContent.error.code, 'ambiguous_connection');
  assert.equal(
    ambiguous.structuredContent.error.retry_with.field,
    'connection_id',
  );

  const ok = await client.callTool({
    name: 'fetch_blob',
    arguments: { blob_id: 'blob-1', connection_id: 'cin_aaa' },
  });
  assert.equal(ok.isError, undefined);
  const url = findCall(
    calls.filter((c) => c.url.includes('/v1/blobs/blob-1')),
    (u) => u.searchParams.get('connection_id') === 'cin_aaa',
  );
  assert.equal(url.searchParams.get('connection_id'), 'cin_aaa');

  await client.close();
  await server.close();
});

test('every tool input schema declares optional connection_id and connector_instance_id', async () => {
  const { fetch } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  const expected = ['list_streams', 'query_records', 'search', 'fetch', 'fetch_blob'];
  const tools = await client.listTools();
  for (const toolName of expected) {
    const tool = tools.tools.find((t) => t.name === toolName);
    assert.ok(tool, `tool ${toolName} must exist`);
    assert.ok(
      tool.inputSchema.properties.connection_id,
      `${toolName} input must declare connection_id`,
    );
    assert.ok(
      tool.inputSchema.properties.connector_instance_id,
      `${toolName} input must declare connector_instance_id alias`,
    );
    const required = tool.inputSchema.required ?? [];
    assert.ok(
      !required.includes('connection_id'),
      `${toolName} connection_id must remain optional`,
    );
  }

  await client.close();
  await server.close();
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

function makeFieldWindowFetch() {
  const calls = [];
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? 'GET' });

    if (url.pathname === '/v1/streams/orders/records/o1/field-window') {
      return jsonResponse({
        object: 'field_window',
        stream: 'orders',
        record_id: 'o1',
        connection_id: url.searchParams.get('connection_id'),
        field: { path: url.searchParams.get('field'), type: 'string' },
        window: {
          text: 'window text',
          start_chars: Number.parseInt(url.searchParams.get('offset_chars') ?? '0', 10),
          end_chars: 11,
          limit_chars: Number.parseInt(url.searchParams.get('limit_chars') ?? '64', 10),
          total_chars: 11,
          complete: true,
          has_more: false,
          next_offset_chars: null,
          previous_offset_chars: null,
        },
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
  const client = new Client({ name: 'read-record-field-selector-contract-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function assertSelectorError(result, expectedMessage) {
  assert.equal(result.isError, true);
  const textError = JSON.parse(result.content[0].text);
  assert.match(textError.message, expectedMessage);
  assert.match(result.structuredContent.error.message, expectedMessage);
}

test('read_record_field rejects invalid MCP-layer selectors before calling RS', async () => {
  const cases = [
    {
      name: 'id plus explicit triple',
      arguments: {
        id: 'conn_orders/orders:o1',
        connection_id: 'conn_orders',
        stream: 'orders',
        record_id: 'o1',
        field_path: 'text',
      },
      message: /`id` is exclusive with explicit `connection_id`, `stream`, and `record_id`/,
    },
    {
      name: 'legacy id without connection_id',
      arguments: { id: 'orders:o1', field_path: 'text' },
      message: /must include connection_id/,
    },
    {
      name: 'neither id nor full triple',
      arguments: { connection_id: 'conn_orders', stream: 'orders', field_path: 'text' },
      message: /requires either `id` \+ `field_path` or `connection_id` \+ `stream` \+ `record_id`/,
    },
    {
      name: 'cursor plus offset_chars',
      arguments: { id: 'conn_orders/orders:o1', field_path: 'text', cursor: '12', offset_chars: 12 },
      message: /`cursor` is exclusive with `offset_chars`/,
    },
    {
      name: 'q plus offset_chars',
      arguments: { id: 'conn_orders/orders:o1', field_path: 'text', q: 'needle', offset_chars: 12 },
      message: /`q` is exclusive with `cursor` and `offset_chars`/,
    },
    {
      name: 'before_chars without q',
      arguments: { id: 'conn_orders/orders:o1', field_path: 'text', before_chars: 8 },
      message: /`before_chars` and `after_chars` require `q`/,
    },
    {
      name: 'non-integer cursor',
      arguments: { id: 'conn_orders/orders:o1', field_path: 'text', cursor: 'abc' },
      message: /field-window cursor must be a non-negative integer offset/,
    },
  ];

  for (const contractCase of cases) {
    const { fetch, calls } = makeFieldWindowFetch();
    const { client, server } = await connectClient(fetch);
    try {
      const result = await client.callTool({ name: 'read_record_field', arguments: contractCase.arguments });
      assertSelectorError(result, contractCase.message);
      assert.equal(calls.length, 0, `${contractCase.name} should not reach the RS`);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test('read_record_field accepts a valid self-contained id selector and forwards field-window query', async () => {
  const { fetch, calls } = makeFieldWindowFetch();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: 'read_record_field',
      arguments: { id: 'conn_orders/orders:o1', field_path: 'text', offset_chars: 4 },
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    const routeUrl = new URL(calls[0].url);
    assert.equal(routeUrl.pathname, '/v1/streams/orders/records/o1/field-window');
    assert.equal(routeUrl.searchParams.get('connection_id'), 'conn_orders');
    assert.equal(routeUrl.searchParams.get('field'), 'text');
    assert.equal(routeUrl.searchParams.get('offset_chars'), '4');
  } finally {
    await client.close();
    await server.close();
  }
});

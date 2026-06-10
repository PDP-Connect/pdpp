import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

// Self-contained search-result ids (`{connection_id}/{stream}:{record_id}`).
//
// Live finding (2026-06-09 ChatGPT retest of the 5-tool surface): search hits
// carried `id` = `stream:record_id` PLUS a separate `connection_id` field; on a
// multi-source hosted package, `fetch(id)` without `connection_id` returned a
// typed 409 `ambiguous_connection`. ChatGPT's rendered envelope buried the
// second field and its model never completed a fetch. OpenAI's search/fetch
// contract treats ids as single opaque handles — so the id must be
// self-contained.
//
// Canon rule (design-notes/full-context-refresh.md, 2026-06-01): journey tests
// consume ONLY what the model can see (`content[]` text), extract the next
// handle, and complete the workflow. The journey test below does exactly that
// against a multi-source fixture whose unscoped record reads 409.

const AMBIGUOUS_RECORD_ERROR = {
  error: {
    type: 'invalid_request',
    code: 'ambiguous_connection',
    message: "Record id 'o1' resolves to more than one connection under the caller's grant.",
    available_connections: [
      { connection_id: 'cin_aaa', display_name: 'peregrine Amazon' },
      { connection_id: 'cin_bbb', display_name: 'vivid fish Amazon' },
    ],
    retry_with: {
      field: 'connection_id',
      guidance: 'Retry with one of the listed connection_id values.',
    },
  },
};

// A fake multi-source RS: the same stream/record-key shape exists under two
// connections, and record fetches WITHOUT `connection_id` are ambiguous.
function makeMultiSourceFetch() {
  const calls = [];
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? 'GET' });

    if (url.pathname === '/v1/search') {
      return jsonResponse({
        object: 'list',
        hits: [
          {
            stream: 'orders',
            id: 'o1',
            title: 'Order o1 (peregrine)',
            connection_id: 'cin_aaa',
            connector_key: 'amazon',
            display_name: 'peregrine Amazon',
            snippet: { text: 'Pasta maker, $89.' },
          },
          {
            stream: 'orders',
            id: 'o9',
            title: 'Order o9 (vivid fish)',
            connection_id: 'cin_bbb',
            connector_key: 'amazon',
            display_name: 'vivid fish Amazon',
            snippet: { text: 'Pasta drying rack, $19.' },
          },
        ],
      });
    }
    if (url.pathname === '/v1/streams/orders/records/o1') {
      const conn = url.searchParams.get('connection_id');
      if (!conn) {
        return new Response(JSON.stringify(AMBIGUOUS_RECORD_ERROR), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonResponse({
        id: 'o1',
        stream: 'orders',
        title: 'Order o1 (peregrine)',
        text: 'Pasta maker, $89.',
        connection_id: conn,
        connector_key: 'amazon',
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
  const client = new Client({ name: 'self-contained-id-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('multi-source search returns self-contained ids in structured results and content text', async () => {
  const { fetch } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'search', arguments: { q: 'pasta' } });
  assert.equal(result.isError, undefined);

  const [first, second] = result.structuredContent.results;
  assert.equal(first.id, 'cin_aaa/orders:o1');
  assert.equal(second.id, 'cin_bbb/orders:o9');
  // Machine envelope still carries the discrete source handles.
  assert.equal(first.connection_id, 'cin_aaa');
  assert.equal(second.connection_id, 'cin_bbb');

  // Model-visible text carries the complete handles, untruncated.
  const text = result.content[0].text;
  assert.match(text, /id=cin_aaa\/orders:o1/);
  assert.match(text, /id=cin_bbb\/orders:o9/);
  // The connection is embedded in the id; it is not repeated as a second
  // model-carried field the host could bury.
  assert.doesNotMatch(text, /connection_id=/);

  await client.close();
  await server.close();
});

test('search to fetch journey completes from content[] text alone with ONE handle on a multi-source grant', async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const searchResult = await client.callTool({ name: 'search', arguments: { q: 'pasta' } });

  // Consume ONLY what the model can see: content[] text.
  const searchText = searchResult.content[0].text;
  const id = /id=([^\s]+)/.exec(searchText)?.[1];
  assert.equal(id, 'cin_aaa/orders:o1');

  // ONE opaque handle, no connection_id argument — the exact call shape the
  // live ChatGPT model produced when it failed against the old contract.
  const fetchResult = await client.callTool({ name: 'fetch', arguments: { id } });
  assert.equal(
    fetchResult.isError,
    undefined,
    `single-handle fetch must succeed on a multi-source grant, got: ${fetchResult.content?.[0]?.text}`,
  );

  const document = JSON.parse(fetchResult.content[0].text);
  assert.equal(document.id, 'cin_aaa/orders:o1', 'document id must echo the self-contained handle');
  assert.equal(document.title, 'Order o1 (peregrine)');
  assert.equal(document.text, 'Pasta maker, $89.');
  assert.equal(document.metadata.connection_id, 'cin_aaa');

  // The embedded connection reached the RS as the canonical query param, so
  // the ambiguous_connection branch never fired.
  const recordCalls = calls.filter((entry) => entry.url.includes('/v1/streams/orders/records/o1'));
  assert.equal(recordCalls.length, 1);
  assert.equal(new URL(recordCalls[0].url).searchParams.get('connection_id'), 'cin_aaa');

  await client.close();
  await server.close();
});

test('legacy stream:record_id ids keep their semantics: unscoped 409s, explicit connection_id scopes (backcompat)', async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  // Unscoped legacy id still surfaces the typed RS ambiguity envelope.
  const ambiguous = await client.callTool({ name: 'fetch', arguments: { id: 'orders:o1' } });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.structuredContent.error.code, 'ambiguous_connection');

  // Legacy id + explicit connection_id argument is unchanged.
  const scoped = await client.callTool({
    name: 'fetch',
    arguments: { id: 'orders:o1', connection_id: 'cin_aaa' },
  });
  assert.equal(scoped.isError, undefined);
  assert.equal(scoped.structuredContent.id, 'orders:o1', 'legacy requests echo the legacy id');
  const scopedCall = calls
    .map((entry) => new URL(entry.url))
    .find((u) => u.pathname === '/v1/streams/orders/records/o1' && u.searchParams.get('connection_id') === 'cin_aaa');
  assert.ok(scopedCall, 'explicit connection_id must reach the RS');

  await client.close();
  await server.close();
});

test('self-contained id plus matching connection_id argument is accepted', async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'cin_aaa/orders:o1', connection_id: 'cin_aaa' },
  });
  assert.equal(result.isError, undefined);
  const call = calls.map((entry) => new URL(entry.url)).find((u) => u.pathname === '/v1/streams/orders/records/o1');
  assert.equal(call.searchParams.get('connection_id'), 'cin_aaa');

  await client.close();
  await server.close();
});

test('conflicting embedded and explicit connection ids are rejected with a typed error before any RS call', async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'cin_aaa/orders:o1', connection_id: 'cin_bbb' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'conflicting_connection_id');
  assert.match(result.structuredContent.error.message, /cin_aaa/);
  assert.match(result.structuredContent.error.message, /cin_bbb/);
  assert.equal(
    calls.some((entry) => entry.url.includes('/v1/streams/')),
    false,
    'a conflicting handle pair must not reach the RS',
  );

  await client.close();
  await server.close();
});

test('self-contained ids reject path traversal and malformed segments before any RS call', async () => {
  const { fetch, calls } = makeMultiSourceFetch();
  const { client, server } = await connectClient(fetch);

  for (const id of [
    'cin_aaa/orders:../../etc/passwd',
    '../cin_aaa/orders:o1',
    'cin_aaa/',
    '/orders:o1',
    'cin_aaa/orders',
    'cin_aaa/extra/orders:o1',
  ]) {
    const result = await client.callTool({ name: 'fetch', arguments: { id } });
    assert.equal(result.isError, true, `id ${JSON.stringify(id)} must be rejected`);
  }
  assert.equal(
    calls.some((entry) => entry.url.includes('/v1/streams/')),
    false,
    'malformed ids must never reach the RS',
  );

  await client.close();
  await server.close();
});

test('hits without a connection keep plain stream:record_id ids', async () => {
  const calls = [];
  const singleSourceFetch = async (urlInput) => {
    const url = new URL(urlInput.toString());
    calls.push(url.toString());
    if (url.pathname === '/v1/search') {
      return jsonResponse({ hits: [{ stream: 'messages', id: 'm1', title: 'hi' }] });
    }
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { client, server } = await connectClient(singleSourceFetch);

  const result = await client.callTool({ name: 'search', arguments: { q: 'hi' } });
  assert.equal(result.structuredContent.results[0].id, 'messages:m1');
  assert.match(result.content[0].text, /id=messages:m1/);

  await client.close();
  await server.close();
});

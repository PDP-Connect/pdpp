import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

// Token-efficiency acceptance checks for the DATA-bearing read tools
// (`query_records`, `search`, `fetch`). The `schema` discovery path is covered
// by schema-token-budget.test.js + hosted-schema-token-budget.test.js; this file
// guards the record path the schema lanes did not cover.
//
// Design invariants under test (consistent with the existing 7.4/7.5 checks in
// canonical-mirror.test.js and the mcp-adapter spec):
//   * `content[]` prose is bounded for record-list/search/aggregate discovery.
//     `fetch` is the OpenAI search/fetch exception: it mirrors the fetched
//     document JSON in `content[]` so hosts that hide structuredContent still
//     receive the document body.
//   * `query_records(fields)` forwards projection to the canonical RS and
//     renders the already-projected record payloads without re-projecting them
//     in the MCP adapter.
//   * `fetch(fields)` forwards projection to the canonical RS before rendering
//     the OpenAI-compatible document; it does not expose a canonical
//     `structuredContent.data` record or a second MCP-owned projection contract.
//   * `search` carries the flattened page once in `structuredContent.results`;
//     `structuredContent.data` keeps envelope metadata and a pointer, not a
//     duplicate hit array.
//   * `fetch.text` returns a declared text-like field verbatim (the document
//     text ChatGPT consumes). When NO such field is declared, the JSON-stringify
//     fallback is bounded and points at the structured read tools — it must not
//     pretty-print an unbounded record into `text` or a second canonical payload.

// Bound the prose preview every read tool emits. The record preview hard cap is
// 1792 chars + a small footer; 1800 is the same ceiling 7.4/7.5 assert.
const PROSE_BYTE_BUDGET = 1_800;
// Bound the `fetch.text` JSON-stringify fallback (no declared text field). The
// source constant is 1024 chars; 1200 bytes leaves headroom for multibyte and
// the trailing pointer without flapping.
const FETCH_TEXT_FALLBACK_BYTE_BUDGET = 1_200;

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-budget' },
  });
}

const OPERATIONAL_RECORD_KEYS = new Set([
  'object',
  'id',
  'record_id',
  'recordId',
  'stream',
  'stream_name',
  'streamName',
  'connection_id',
  'connector_key',
  'connector_id',
  'display_name',
  'source',
]);

function requestedFields(url) {
  return new Set(url.searchParams.getAll('fields').filter((field) => field.length > 0));
}

function projectPayload(payload, fields) {
  if (fields.size === 0 || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = {};
  for (const key of OPERATIONAL_RECORD_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) out[field] = payload[field];
  }
  return out;
}

function projectRecordBody(body, url) {
  const fields = requestedFields(url);
  if (fields.size === 0) return body;
  if (Array.isArray(body?.data)) {
    return { ...body, data: body.data.map((record) => projectPayload(record, fields)) };
  }
  return projectPayload(body, fields);
}

// A fetch stub that returns large bodies so the bounds are exercised against a
// realistic fat-record grant rather than a toy payload. It also simulates the
// canonical RS `fields` behavior so MCP tests verify forwarding/rendering, not
// an adapter-local projection path.
function makeFatFetch() {
  const big = (n) => 'x'.repeat(n);
  return async (urlInput) => {
    const url = new URL(urlInput.toString());
    // query_records: 500 records each ~1.5 KB of body.
    if (url.pathname === '/v1/streams/mail/records') {
      return jsonResponse(projectRecordBody({
        object: 'list',
        data: Array.from({ length: 500 }, (_, i) => ({
          object: 'record',
          id: `m${i}`,
          subject: `Subject ${i}`,
          text: big(1500),
          connection_id: 'conn_1',
          channel_id: 'C-noisy',
          ts: `1710000000.${String(i).padStart(6, '0')}`,
          metadata: { replicated: big(200) },
        })),
        has_more: true,
      }, url));
    }
    // search: 200 hits with fat snippets.
    if (url.pathname === '/v1/search') {
      return jsonResponse({
        object: 'list',
        results: Array.from({ length: 200 }, (_, i) => ({
          id: `m${i}`,
          stream: 'mail',
          title: `Subject ${i}`,
          snippet: { text: big(500) },
          connection_id: 'conn_1',
          score: 0.9,
        })),
        has_more: true,
      });
    }
    // fetch of a record WITH a declared text field (returned verbatim).
    if (url.pathname === '/v1/streams/mail/records/withtext') {
      return jsonResponse(projectRecordBody({
        id: 'withtext',
        stream: 'mail',
        title: 'A real message',
        text: big(50_000),
        url: 'https://mail.test/withtext',
        connection_id: 'conn_1',
      }, url));
    }
    // fetch of a record with NO text-like field (JSON-stringify fallback path).
    if (url.pathname === '/v1/streams/orders/records/notext') {
      return jsonResponse({
        id: 'notext',
        stream: 'orders',
        line_items: Array.from({ length: 200 }, (_, i) => ({
          sku: `sku-${i}`,
          name: big(100),
          qty: i,
        })),
        connection_id: 'conn_1',
      });
    }
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function connectClient(fetchImpl) {
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch: fetchImpl,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'record-budget-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test('query_records(fields) returns a strict projected envelope with only operational handles', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  const result = await client.callTool({
    name: 'query_records',
    arguments: { stream: 'mail', limit: 100, fields: ['id'] },
  });
  assert.equal(result.isError, undefined);

  const proseBytes = byteLength(result.content[0].text);
  const structuredBytes = byteLength(result.structuredContent);

  assert.ok(
    proseBytes < PROSE_BYTE_BUDGET,
    `query_records prose must stay under ${PROSE_BYTE_BUDGET} bytes (got ${proseBytes}; structuredContent was ${structuredBytes})`,
  );
  assert.ok(
    structuredBytes < 48_000,
    `projected query_records structuredContent must stay compact (got ${structuredBytes})`,
  );
  assert.equal(result.structuredContent.data.data.length, 500);
  assert.deepEqual(result.structuredContent.data.data[0], {
    object: 'record',
    id: 'm0',
    connection_id: 'conn_1',
  });
  assert.equal(result.structuredContent.data.data[0].subject, undefined);
  assert.equal(result.structuredContent.data.data[0].text, undefined);
  assert.equal(result.structuredContent.data.data[0].channel_id, undefined);
  assert.equal(result.structuredContent.data.data[0].ts, undefined);
  assert.equal(result.structuredContent.data.data[0].metadata, undefined);
  assert.doesNotMatch(result.content[0].text, /Subject 0|C-noisy|1710000000/);

  await client.close();
  await server.close();
});

test('search prose stays bounded and result hits are not duplicated in structuredContent.data', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  // `limit: 100` is the in-contract maximum (the published search contract caps
  // `limit` at 100); the fat fetch returns its 200-hit body regardless of the
  // requested limit, so this still exercises the prose-boundedness lever while
  // staying within the MCP input cap. (Was `limit: 200`, an out-of-contract
  // value the input schema now rejects before the handler runs.)
  const result = await client.callTool({ name: 'search', arguments: { q: 'invoice', limit: 100 } });
  assert.equal(result.isError, undefined);

  const proseBytes = byteLength(result.content[0].text);
  assert.ok(
    proseBytes < PROSE_BYTE_BUDGET,
    `search prose must stay under ${PROSE_BYTE_BUDGET} bytes (got ${proseBytes})`,
  );
  assert.match(result.content[0].text, /id=conn_1\/mail:m0/);
  // The connection is embedded in the self-contained id; the prose budget is
  // not spent repeating it as a separate handle.
  assert.doesNotMatch(result.content[0].text, /connection_id=/);
  assert.match(result.content[0].text, /Subject 0/);
  assert.equal(result.structuredContent.data.results_ref, 'structuredContent.results');
  assert.equal(result.structuredContent.data.result_count, 100);
  assert.equal(result.structuredContent.data.results, undefined);
  assert.equal(result.structuredContent.data.hits, undefined);
  assert.equal(result.structuredContent.data.data, undefined);
  // Disambiguation data the agent needs survives once, in the flattened page.
  assert.equal(result.structuredContent.results.length, 100);
  for (const hit of result.structuredContent.results) {
    assert.ok(hit.id && hit.title && hit.url, 'each search result must carry id/title/url');
  }

  await client.close();
  await server.close();
});

test('search hit title does not fall back to the snippet', async () => {
  const { client, server } = await connectClient(async (urlInput) => {
    const url = new URL(urlInput.toString());
    if (url.pathname === '/v1/search') {
      return jsonResponse({
        results: [
          {
            id: 'm1',
            stream: 'mail',
            record_key: 'm1',
            connection_id: 'conn_1',
            display_name: 'Mail',
            snippet: { text: '<mark>budget</mark> status update' },
          },
        ],
      });
    }
    return new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });

  const result = await client.callTool({ name: 'search', arguments: { q: 'budget' } });

  assert.equal(result.isError, undefined);
  const [hit] = result.structuredContent.results;
  assert.equal(hit.snippet, '<mark>budget</mark> status update');
  assert.notEqual(hit.title, hit.snippet);
  assert.match(hit.title, /Mail \/ mail/);

  await client.close();
  await server.close();
});

test('fetch returns a declared text field verbatim (no truncation of real document text)', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  const result = await client.callTool({ name: 'fetch', arguments: { id: 'mail:withtext' } });
  assert.equal(result.isError, undefined);

  // A declared `text` field IS the document text ChatGPT consumes — returned
  // verbatim and unbounded. This is the contract; do not truncate it.
  assert.equal(result.structuredContent.text.length, 50_000);
  assert.equal(result.structuredContent.id, 'mail:withtext');
  assert.equal(result.structuredContent.title, 'A real message');
  assert.equal(result.structuredContent.data, undefined);
  const mirrored = JSON.parse(result.content[0].text);
  const { content_ladder: contentLadder, ...structuredDocument } = result.structuredContent;
  assert.deepEqual(mirrored, structuredDocument);
  assert.equal(contentLadder.record_uri, undefined);
  assert.equal(contentLadder.id, 'conn_1/mail:withtext');
  assert.doesNotMatch(JSON.stringify(contentLadder), /pdpp:\/\/record\//);
  assert.equal(mirrored.text.length, 50_000);
  assert.equal(mirrored.id, 'mail:withtext');

  await client.close();
  await server.close();
});

test('fetch(fields) projects before rendering the document and preserves source handles', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'mail:withtext', fields: ['id'] },
  });
  assert.equal(result.isError, undefined);

  assert.equal(result.structuredContent.data, undefined);
  assert.equal(result.structuredContent.metadata.stream, 'mail');
  assert.equal(result.structuredContent.metadata.connection_id, 'conn_1');
  assert.equal(result.structuredContent.text.includes('"id": "withtext"'), true);
  assert.equal(result.structuredContent.text.includes('"text"'), false);
  assert.match(result.structuredContent.text, /"id": "withtext"/);
  assert.doesNotMatch(result.structuredContent.text, /x{100}/);
  assert.ok(
    byteLength(result.structuredContent) < 2_500,
    `projected fetch must not carry the full document body (got ${byteLength(result.structuredContent)} bytes)`,
  );
  assert.equal(
    result.content.some((part) => part.type === 'resource_link'),
    false,
    'projected fetch must stay inline and avoid file/resource materialization'
  );

  await client.close();
  await server.close();
});

test('fetch text JSON-stringify fallback is bounded and points at structured reads', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  const result = await client.callTool({ name: 'fetch', arguments: { id: 'orders:notext' } });
  assert.equal(result.isError, undefined);

  const textBytes = byteLength(result.structuredContent.text);
  // The fallback must NOT pretty-print the entire record into `text` — that
  // would turn document fetch into an unbounded record-read path.
  assert.ok(
    textBytes < FETCH_TEXT_FALLBACK_BYTE_BUDGET,
    `fetch text fallback must stay under ${FETCH_TEXT_FALLBACK_BYTE_BUDGET} bytes (got ${textBytes})`,
  );
  // It stays honest: it points the agent at structured read tools.
  assert.match(result.structuredContent.text, /query_records|fetch\(fields\)/);
  assert.equal(result.structuredContent.data, undefined);
  assert.equal(result.structuredContent.metadata.line_items, undefined);
  assert.equal(result.structuredContent.id, 'orders:notext');

  await client.close();
  await server.close();
});

// Regression guard proving the fallback bound is non-vacuous: the verbatim
// JSON-stringify of the no-text record is far larger than the budget, so the
// truncation is genuinely doing work.
test('the no-text record JSON-stringify is far larger than the fallback budget (guard is non-vacuous)', async () => {
  const record = {
    id: 'notext',
    stream: 'orders',
    line_items: Array.from({ length: 200 }, (_, i) => ({ sku: `sku-${i}`, name: 'x'.repeat(100), qty: i })),
    connection_id: 'conn_1',
  };
  const verbatim = byteLength(JSON.stringify(record, null, 2));
  assert.ok(
    verbatim > FETCH_TEXT_FALLBACK_BYTE_BUDGET * 10,
    `fixture must model a fat no-text record (verbatim JSON was ${verbatim})`,
  );
});

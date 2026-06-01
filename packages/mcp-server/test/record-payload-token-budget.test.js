import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createPdppMcpServer } from '../src/server.js';

// Token-efficiency acceptance checks for the DATA-bearing read tools
// (`query_records`, `search`, `fetch`). The `schema`/`list_streams` discovery
// path is covered by schema-token-budget.test.js + hosted-schema-token-budget
// .test.js; this file guards the record path the schema lanes did not cover.
//
// Design invariants under test (consistent with the existing 7.4/7.5 checks in
// canonical-mirror.test.js and the mcp-adapter spec):
//   * `content[]` prose is ALWAYS bounded, regardless of body size, for every
//     read tool. It is a navigable summary, never a JSON contract dump.
//   * `structuredContent.data` is the canonical envelope and is intentionally
//     verbatim/unbounded for `query_records`/`search` — the agent controls size
//     via `limit`. We do NOT compact it (that would be lossy); we only pin that
//     the PROSE stays small so a verbatim envelope never leaks into `content[]`.
//   * `fetch.text` returns a declared text-like field verbatim (the document
//     text ChatGPT consumes). When NO such field is declared, the JSON-stringify
//     fallback is bounded and points at `structuredContent.data` — it must not
//     pretty-print an unbounded record into `text`.

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

// A fetch stub that returns large bodies so the bounds are exercised against a
// realistic fat-record grant rather than a toy payload.
function makeFatFetch() {
  const big = (n) => 'x'.repeat(n);
  return async (urlInput) => {
    const url = new URL(urlInput.toString());
    // query_records: 500 records each ~1.5 KB of body.
    if (url.pathname === '/v1/streams/mail/records') {
      return jsonResponse({
        object: 'list',
        data: Array.from({ length: 500 }, (_, i) => ({
          id: `m${i}`,
          subject: `Subject ${i}`,
          text: big(1500),
          connection_id: 'conn_1',
        })),
        has_more: true,
      });
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
          score: 0.9,
        })),
        has_more: true,
      });
    }
    // fetch of a record WITH a declared text field (returned verbatim).
    if (url.pathname === '/v1/streams/mail/records/withtext') {
      return jsonResponse({
        id: 'withtext',
        stream: 'mail',
        title: 'A real message',
        text: big(50_000),
        url: 'https://mail.test/withtext',
        connection_id: 'conn_1',
      });
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

test('query_records prose stays bounded while the canonical envelope remains verbatim in structuredContent.data', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  const result = await client.callTool({ name: 'query_records', arguments: { stream: 'mail', limit: 500 } });
  assert.equal(result.isError, undefined);

  const proseBytes = byteLength(result.content[0].text);
  const structuredBytes = byteLength(result.structuredContent);

  // The prose preview is the bounded surface. It must stay tiny even when the
  // verbatim envelope is multi-MB — this is the regression guard against the
  // legacy "dump the whole JSON envelope into content[]" pattern.
  assert.ok(
    proseBytes < PROSE_BYTE_BUDGET,
    `query_records prose must stay under ${PROSE_BYTE_BUDGET} bytes (got ${proseBytes}; structuredContent was ${structuredBytes})`,
  );
  // The canonical envelope is deliberately verbatim and far larger than the
  // prose — agents read it from structuredContent.data and control size via
  // `limit`. We assert it stays the full payload (not silently compacted).
  assert.ok(
    structuredBytes > proseBytes * 100,
    `structuredContent.data must remain the verbatim canonical envelope (got ${structuredBytes} vs prose ${proseBytes})`,
  );
  // The records the agent needs are still present and addressable.
  assert.equal(result.structuredContent.data.data.length, 500);
  assert.equal(result.structuredContent.data.data[0].connection_id, 'conn_1');

  await client.close();
  await server.close();
});

test('search prose stays bounded; structuredContent carries both the envelope and the flattened results', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  const result = await client.callTool({ name: 'search', arguments: { q: 'invoice', limit: 200 } });
  assert.equal(result.isError, undefined);

  const proseBytes = byteLength(result.content[0].text);
  assert.ok(
    proseBytes < PROSE_BYTE_BUDGET,
    `search prose must stay under ${PROSE_BYTE_BUDGET} bytes (got ${proseBytes})`,
  );
  // Disambiguation data the agent needs survives: every hit has a stable id +
  // title + url in the flattened projection.
  assert.equal(result.structuredContent.results.length, 200);
  for (const hit of result.structuredContent.results) {
    assert.ok(hit.id && hit.title && hit.url, 'each search result must carry id/title/url');
  }

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
  // Prose stays bounded regardless.
  assert.ok(byteLength(result.content[0].text) < PROSE_BYTE_BUDGET);

  await client.close();
  await server.close();
});

test('fetch text JSON-stringify fallback is bounded and points at the canonical record', async () => {
  const { client, server } = await connectClient(makeFatFetch());

  const result = await client.callTool({ name: 'fetch', arguments: { id: 'orders:notext' } });
  assert.equal(result.isError, undefined);

  const textBytes = byteLength(result.structuredContent.text);
  // The fallback must NOT pretty-print the entire record into `text` — that
  // would duplicate the canonical record already present in
  // structuredContent.data (measured at tens of KB, unbounded for fat records).
  assert.ok(
    textBytes < FETCH_TEXT_FALLBACK_BYTE_BUDGET,
    `fetch text fallback must stay under ${FETCH_TEXT_FALLBACK_BYTE_BUDGET} bytes (got ${textBytes})`,
  );
  // It stays honest: it points the agent at the full record in structuredContent.
  assert.match(result.structuredContent.text, /structuredContent\.data/);
  // The full canonical record is still available — nothing the agent needs is lost.
  assert.equal(result.structuredContent.data.line_items.length, 200);
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

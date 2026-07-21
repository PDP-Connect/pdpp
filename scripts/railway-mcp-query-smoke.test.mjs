// Offline unit tests for the pure core of railway-mcp-query-smoke.mjs.
//
// These run with zero dependencies and no network/Docker (node --test), exactly
// like check-railway-deploy-env.test.mjs. They prove the seed-corpus shape, the
// MCP JSON-RPC framing, the dual-transport response parser, the seeded-record
// assertion, the anonymous-refusal classifier, and the owner-session form
// parsing — the logic that decides pass/fail in the live run — without standing
// up a stack. The live HTTP driver itself is exercised by the operator against a
// real composed origin (see deploy/railway/README.md), not in CI.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEED_RECORDS,
  SEED_STREAM,
  SEED_CONNECTOR_ID,
  buildSeedNdjson,
  findSetCookiePair,
  extractCsrfFieldValue,
  mcpInitializeMessage,
  mcpToolsListMessage,
  mcpQueryRecordsMessage,
  parseMcpResponseText,
  extractRecordsFromQueryResult,
  assertSeedRecordsPresent,
  classifyAnonymousMcpStatus,
  pkceChallenge,
  parseArgs,
} from './railway-mcp-query-smoke.mjs';

test('seed corpus: keys and data.id agree (ingestRecord identity rule)', () => {
  assert.ok(SEED_RECORDS.length >= 1);
  for (const record of SEED_RECORDS) {
    assert.equal(typeof record.key, 'string');
    assert.equal(record.data.id, record.key, 'data.id must equal key or ingest rejects it');
    assert.match(record.emitted_at, /^\d{4}-\d{2}-\d{2}T/, 'deterministic ISO emitted_at');
  }
});

test('buildSeedNdjson: one JSON record per line, round-trips', () => {
  const ndjson = buildSeedNdjson();
  const lines = ndjson.split('\n');
  assert.equal(lines.length, SEED_RECORDS.length);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed, SEED_RECORDS);
  // No trailing newline so the operation's non-empty-line filter sees exactly N.
  assert.ok(!ndjson.endsWith('\n'));
});

test('buildSeedNdjson: deterministic across calls (byte-identical)', () => {
  assert.equal(buildSeedNdjson(), buildSeedNdjson());
});

test('findSetCookiePair: extracts the named pair, ignores attributes/others', () => {
  const headers = [
    'pdpp_owner_csrf=abc123; Path=/; HttpOnly; SameSite=Lax',
    'pdpp_owner_session=sess999; Path=/; Secure; HttpOnly',
  ];
  assert.equal(findSetCookiePair(headers, 'pdpp_owner_csrf'), 'pdpp_owner_csrf=abc123');
  assert.equal(findSetCookiePair(headers, 'pdpp_owner_session'), 'pdpp_owner_session=sess999');
  assert.equal(findSetCookiePair(headers, 'missing'), null);
});

test('extractCsrfFieldValue: reads the hidden _csrf input', () => {
  const html = '<form><input type="hidden" name="_csrf" value="tok-42" /><input name="password"></form>';
  assert.equal(extractCsrfFieldValue(html), 'tok-42');
  assert.equal(extractCsrfFieldValue('<form>no csrf here</form>'), null);
});

test('mcp framing: initialize/tools.list/query_records are well-formed JSON-RPC', () => {
  const init = mcpInitializeMessage(7);
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.id, 7);
  assert.equal(init.method, 'initialize');

  const list = mcpToolsListMessage(8);
  assert.equal(list.method, 'tools/list');

  const query = mcpQueryRecordsMessage(SEED_STREAM, { sort: '-emitted_at', limit: 10 }, 9);
  assert.equal(query.method, 'tools/call');
  assert.equal(query.params.name, 'query_records');
  assert.equal(query.params.arguments.stream, SEED_STREAM);
  assert.equal(query.params.arguments.sort, '-emitted_at');
  assert.equal(query.params.arguments.limit, 10);
});

test('parseMcpResponseText: handles application/json', () => {
  const rpc = parseMcpResponseText('application/json', '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  assert.equal(rpc.result.ok, true);
});

test('parseMcpResponseText: handles SSE text/event-stream framing', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  const rpc = parseMcpResponseText('text/event-stream', sse);
  assert.equal(rpc.result.ok, true);
});

test('parseMcpResponseText: empty body yields null', () => {
  assert.equal(parseMcpResponseText('application/json', ''), null);
});

test('extractRecordsFromQueryResult: bare array, {data}, {records}, and empty', () => {
  const asArray = { result: { structuredContent: { data: [{ key: 'a' }] } } };
  assert.deepEqual(extractRecordsFromQueryResult(asArray), [{ key: 'a' }]);

  const asData = { result: { structuredContent: { data: { data: [{ key: 'b' }] } } } };
  assert.deepEqual(extractRecordsFromQueryResult(asData), [{ key: 'b' }]);

  const asRecords = { result: { structuredContent: { data: { records: [{ key: 'c' }] } } } };
  assert.deepEqual(extractRecordsFromQueryResult(asRecords), [{ key: 'c' }]);

  assert.deepEqual(extractRecordsFromQueryResult({ result: {} }), []);
});

test('assertSeedRecordsPresent: passes when all seeded keys are returned', () => {
  const rpc = {
    result: {
      structuredContent: {
        data: { data: SEED_RECORDS.map((r) => ({ key: r.key, data: r.data })) },
      },
    },
  };
  const verdict = assertSeedRecordsPresent(rpc);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.foundKeys, SEED_RECORDS.map((r) => r.key));
});

test('assertSeedRecordsPresent: matches on data.id when key is absent', () => {
  const rpc = {
    result: { structuredContent: { data: SEED_RECORDS.map((r) => ({ data: r.data })) } },
  };
  assert.equal(assertSeedRecordsPresent(rpc).ok, true);
});

test('assertSeedRecordsPresent: fails when a seeded key is missing', () => {
  const rpc = { result: { structuredContent: { data: [{ key: SEED_RECORDS[0].key }] } } };
  const verdict = assertSeedRecordsPresent(rpc);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /missing/);
});

test('assertSeedRecordsPresent: fails on an MCP tool error', () => {
  const rpc = { result: { isError: true, content: [{ type: 'text', text: 'nope' }] } };
  const verdict = assertSeedRecordsPresent(rpc);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /MCP error/);
});

test('classifyAnonymousMcpStatus: 401/403 refuse, 2xx is a hard failure', () => {
  assert.deepEqual(classifyAnonymousMcpStatus(401), { refused: true, code: 'unauthorized' });
  assert.deepEqual(classifyAnonymousMcpStatus(403), { refused: true, code: 'forbidden' });
  assert.equal(classifyAnonymousMcpStatus(200).refused, false);
  assert.equal(classifyAnonymousMcpStatus(204).refused, false);
  assert.equal(classifyAnonymousMcpStatus(500).refused, true);
});

test('pkceChallenge: deterministic base64url S256 of the verifier', () => {
  // RFC 7636 Appendix B reference vector.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('parseArgs: parses origin, owner-password, subject, json, help', () => {
  const parsed = parseArgs([
    'node',
    'script',
    '--origin',
    'https://x.up.railway.app',
    '--owner-password',
    'secret',
    '--subject',
    'owner_x',
    '--json',
  ]);
  assert.equal(parsed.origin, 'https://x.up.railway.app');
  assert.equal(parsed.ownerPassword, 'secret');
  assert.equal(parsed.subjectId, 'owner_x');
  assert.equal(parsed.json, true);
  assert.equal(parseArgs(['node', 'script', '--help']).help, true);
});

test('parseArgs: --no-seed sets noSeed; absent leaves it falsy', () => {
  assert.equal(parseArgs(['node', 'script', '--origin', 'x', '--no-seed']).noSeed, true);
  assert.equal(parseArgs(['node', 'script', '--origin', 'x']).noSeed, undefined);
});

test('seed constants are wired to the spotify fixture connector', () => {
  assert.equal(SEED_CONNECTOR_ID, 'https://registry.pdpp.org/connectors/spotify');
  assert.equal(SEED_STREAM, 'top_artists');
});

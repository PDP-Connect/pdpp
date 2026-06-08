import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUrl,
  bodyErrorCode,
  classifyAmbiguousConnection,
  classifyCliHelp,
  classifyToolNames,
  cliCredentialCacheFile,
  extractListData,
  extractMcpToolData,
  extractMcpToolError,
  extractRecordId,
  mcpInitializeMessage,
  mcpToolCallMessage,
  mcpToolsListMessage,
  normalizeOrigin,
  parseArgs,
  parseMcpResponseText,
  summarizeResults,
} from './read-surface-smoke.mjs';

test('parseArgs: parses the live smoke options and defaults', () => {
  const opts = parseArgs([
    'node',
    'script',
    '--origin',
    'https://pdpp.example/',
    '--token',
    'tok',
    '--connection-id',
    'cin_123',
    '--stream',
    'messages',
    '--search-query',
    'hello',
    '--date-field',
    'created_at',
    '--since',
    '2026-01-01T00:00:00Z',
    '--timeout-ms',
    '1234',
    '--skip-rest',
    '--skip-cli',
    '--json',
  ]);
  assert.equal(opts.origin, 'https://pdpp.example/');
  assert.equal(opts.token, 'tok');
  assert.equal(opts.connectionId, 'cin_123');
  assert.equal(opts.stream, 'messages');
  assert.equal(opts.searchQuery, 'hello');
  assert.equal(opts.dateField, 'created_at');
  assert.equal(opts.since, '2026-01-01T00:00:00Z');
  assert.equal(opts.timeoutMs, 1234);
  assert.equal(opts.skipRest, true);
  assert.equal(opts.skipCli, true);
  assert.equal(opts.json, true);
});

test('normalizeOrigin and buildUrl: trim origin and encode arrays/bracket params', () => {
  assert.equal(normalizeOrigin('https://pdpp.example///'), 'https://pdpp.example');
  const url = buildUrl('https://pdpp.example/', '/v1/streams/messages/records', {
    limit: 1,
    streams: ['messages', 'files'],
    'filter[sent_at][gte]': '2026-01-01T00:00:00Z',
    empty: '',
    missing: null,
  });
  assert.equal(
    url,
    'https://pdpp.example/v1/streams/messages/records?limit=1&streams=messages&streams=files&filter%5Bsent_at%5D%5Bgte%5D=2026-01-01T00%3A00%3A00Z',
  );
});

test('MCP framing helpers produce JSON-RPC messages', () => {
  assert.deepEqual(mcpToolsListMessage(2), { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(mcpInitializeMessage(1).method, 'initialize');
  const call = mcpToolCallMessage('query_records', { stream: 'messages' }, 3);
  assert.equal(call.method, 'tools/call');
  assert.equal(call.params.name, 'query_records');
  assert.equal(call.params.arguments.stream, 'messages');
});

test('parseMcpResponseText: parses JSON and SSE responses', () => {
  assert.equal(parseMcpResponseText('application/json', '{"result":{"ok":true}}').result.ok, true);
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.equal(parseMcpResponseText('text/event-stream', sse).result.ok, true);
  assert.equal(parseMcpResponseText('application/json', ''), null);
});

test('extractListData and extractRecordId handle common envelopes', () => {
  assert.deepEqual(extractListData([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(extractListData({ data: [{ key: 'b' }] }), [{ key: 'b' }]);
  assert.deepEqual(extractListData({ records: [{ record_id: 'c' }] }), [{ record_id: 'c' }]);
  assert.equal(extractRecordId({ id: 'a' }), 'a');
  assert.equal(extractRecordId({ key: 'b' }), 'b');
  assert.equal(extractRecordId({ data: { id: 'c' } }), 'c');
  assert.equal(extractRecordId(null), null);
});

test('MCP tool data/error extraction handles structured content and text JSON', () => {
  const okRpc = { result: { structuredContent: { data: { data: [{ id: 'r1' }] } } } };
  assert.deepEqual(extractMcpToolData(okRpc), { data: [{ id: 'r1' }] });

  const textRpc = { result: { content: [{ type: 'text', text: '{"code":"x","message":"bad"}' }] } };
  assert.deepEqual(extractMcpToolData(textRpc), { code: 'x', message: 'bad' });

  const errRpc = { result: { isError: true, structuredContent: { data: { code: 'invalid_filter', message: 'bad filter' } } } };
  assert.deepEqual(extractMcpToolError(errRpc), { code: 'invalid_filter', message: 'bad filter' });

  assert.equal(extractMcpToolError({ result: { structuredContent: {} } }), null);
});

test('bodyErrorCode and ambiguous connection classifier cover expected outcomes', () => {
  assert.equal(bodyErrorCode({ type: 'ambiguous_connection' }), 'ambiguous_connection');
  assert.equal(bodyErrorCode({ error: { code: 'invalid_request' } }), 'invalid_request');
  assert.equal(classifyAmbiguousConnection(200, {}).status, 'pass');
  assert.equal(classifyAmbiguousConnection(409, { code: 'ambiguous_connection' }).status, 'pass');
  assert.equal(classifyAmbiguousConnection(400, { code: 'invalid_request' }).status, 'fail');
});

test('classifyToolNames distinguishes missing core tools from optional event gaps', () => {
  const allCore = ['schema', 'list_streams', 'query_records', 'fetch', 'search', 'aggregate'];
  assert.equal(classifyToolNames(allCore).ok, true);
  assert.equal(classifyToolNames(allCore).missingEvent.length > 0, true);
  const missing = classifyToolNames(['schema']);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingCore, ['list_streams', 'query_records', 'fetch', 'search', 'aggregate']);
});

test('CLI helpers map credential cache path and detect missing read commands', () => {
  assert.equal(
    cliCredentialCacheFile('/cache', 'https://pdpp.vivid.fish/'),
    '/cache/clients/pdpp.vivid.fish.json',
  );
  const help = 'PDPP CLI\nUsage:\n  pdpp connect <provider-url>\n  pdpp token <provider-url>\n';
  assert.deepEqual(classifyCliHelp(help), { hasCliHelp: true, hasGrantScopedReadCommands: false });
  assert.equal(classifyCliHelp(`${help}\n  pdpp query-records <stream>\n`).hasGrantScopedReadCommands, true);
});


test('summarizeResults: only fail entries make the report not ok', () => {
  assert.deepEqual(summarizeResults([{ status: 'pass' }, { status: 'warn' }, { status: 'skip' }]), {
    ok: true,
    counts: { pass: 1, fail: 0, warn: 1, skip: 1 },
  });
  assert.equal(summarizeResults([{ status: 'fail' }]).ok, false);
});

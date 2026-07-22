// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUrl,
  bodyErrorCode,
  buildParityMatrix,
  classifyAmbiguousConnection,
  classifyCliHelp,
  classifyExcludedBearer,
  classifyPageHandles,
  classifySearchLimitAndSource,
  classifySourceIdentity,
  classifyScopedSchema,
  classifyStrictProjection,
  classifyToolNames,
  cliCredentialCacheFile,
  extractListData,
  extractMcpToolData,
  extractMcpToolError,
  extractMcpToolStructuredContent,
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
  const searchRpc = {
    result: {
      structuredContent: {
        data: { object: 'list', results_ref: 'structuredContent.results' },
        results: [{ id: 'r1', connection_id: 'cin_1' }],
      },
    },
  };
  assert.deepEqual(extractMcpToolStructuredContent(searchRpc), searchRpc.result.structuredContent);

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

test('classifyExcludedBearer fails served non-grant reads and accepts bounded auth errors', () => {
  assert.equal(classifyExcludedBearer(200, { object: 'schema' }).status, 'fail');
  assert.equal(classifyExcludedBearer(401, { code: 'invalid_token' }).status, 'pass');
  assert.equal(classifyExcludedBearer(401, { code: 'authentication_error' }).status, 'pass');
  assert.equal(classifyExcludedBearer(403, { error: { code: 'insufficient_scope' } }).status, 'pass');
  assert.equal(classifyExcludedBearer(500, { code: 'api_error' }).status, 'warn');
});

test('classifyScopedSchema requires requested stream and connection_id only', () => {
  const scoped = {
    object: 'schema',
    connectors: [
      {
        connector_key: 'slack',
        granted_connections: [{ connection_id: 'cin_slack', display_name: 'Slack' }],
        streams: [{ name: 'messages', connector_key: 'slack' }],
      },
    ],
  };
  assert.equal(classifyScopedSchema(scoped, 'messages', 'cin_slack').status, 'pass');
  assert.equal(classifySourceIdentity(scoped, 'cin_slack').status, 'pass');

  const broad = {
    object: 'schema',
    connectors: [
      {
        granted_connections: [
          { connection_id: 'cin_slack', display_name: 'Slack' },
          { connection_id: 'cin_gmail', display_name: 'Gmail' },
        ],
        streams: [{ name: 'messages' }],
      },
    ],
  };
  assert.equal(classifyScopedSchema(broad, 'messages', 'cin_slack').status, 'fail');

  const wrongStream = {
    object: 'schema',
    connectors: [
      {
        granted_connections: [{ connection_id: 'cin_slack', display_name: 'Slack' }],
        streams: [{ name: 'channels' }],
      },
    ],
  };
  assert.equal(classifyScopedSchema(wrongStream, 'messages', 'cin_slack').status, 'fail');
});

test('classifyStrictProjection fails leaked fields', () => {
  assert.equal(classifyStrictProjection({ data: { id: 'm1' } }, ['id']).status, 'pass');
  const leaked = classifyStrictProjection({ data: { id: 'm1', sent_at: '2026-06-09T00:00:00Z' } }, ['id']);
  assert.equal(leaked.status, 'fail');
  assert.match(leaked.detail, /expected exactly id/);
});

test('classifySearchLimitAndSource catches per-source fanout and missing source identity', () => {
  assert.equal(
    classifySearchLimitAndSource({
      data: {
        results: [
          { id: 'a', connection_id: 'cin_a' },
          { id: 'b', source: { connection_id: 'cin_b' } },
        ],
      },
    }, 3).status,
    'pass',
  );
  assert.equal(
    classifySearchLimitAndSource({
      data: { object: 'list', results_ref: 'structuredContent.results' },
      results: [{ id: 'a', connection_id: 'cin_a' }],
    }, 3).status,
    'pass',
  );
  assert.equal(
    classifySearchLimitAndSource({ data: { results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] } }, 3).status,
    'fail',
  );
  assert.equal(classifySearchLimitAndSource({ data: { results: [{ id: 'a' }] } }, 3).status, 'fail');
});

test('classifyPageHandles requires a cursor when has_more=true and accepts visible counts', () => {
  assert.equal(classifyPageHandles({ data: { has_more: true }, meta: { count: { kind: 'exact', value: 10 } } }).status, 'fail');
  assert.equal(
    classifyPageHandles({
      data: { has_more: true, next_cursor: 'cur_2' },
      meta: { count: { kind: 'exact', value: 10 } },
    }).status,
    'pass',
  );
});

test('classifyToolNames requires the exact normal read tool surface', () => {
  const allCore = ['schema', 'query_records', 'fetch', 'search', 'aggregate'];
  assert.equal(classifyToolNames(allCore).ok, true);
  const missing = classifyToolNames(['schema']);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingCore, ['query_records', 'fetch', 'search', 'aggregate']);
  const extra = classifyToolNames([...allCore, 'list_streams', 'list_event_subscriptions']);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.forbiddenPresent, ['list_streams', 'list_event_subscriptions']);
  assert.deepEqual(extra.unexpectedTools, ['list_streams', 'list_event_subscriptions']);
});

test('CLI helpers map credential cache path and detect missing read commands', () => {
  assert.equal(
    cliCredentialCacheFile('/cache', 'https://pdpp.example.com/'),
    '/cache/clients/pdpp.example.com.json',
  );
  const help = 'PDPP CLI\nUsage:\n  pdpp connect <provider-url>\n  pdpp token <provider-url>\n';
  assert.deepEqual(classifyCliHelp(help), { hasCliHelp: true, hasGrantScopedReadCommands: false });
  assert.equal(classifyCliHelp(`${help}\n  pdpp query-records <stream>\n`).hasGrantScopedReadCommands, true);
});

test('buildParityMatrix fails one-adapter divergence but ignores transport-specific rows', () => {
  const matrix = buildParityMatrix([
    { surface: 'REST', name: 'query_records.projection', status: 'pass' },
    { surface: 'MCP', name: 'query_records.projection', status: 'fail' },
    { surface: 'CLI', name: 'help', status: 'fail' },
  ]);
  assert.equal(matrix.ok, false);
  assert.equal(matrix.rows.find((row) => row.row === 'projection').diverged, true);
  assert.equal(matrix.rows.find((row) => row.row === 'compact_schema').diverged, false);
});

test('summarizeResults: only fail entries make the report not ok', () => {
  assert.deepEqual(summarizeResults([{ status: 'pass' }, { status: 'warn' }, { status: 'skip' }]), {
    ok: true,
    counts: { pass: 1, fail: 0, warn: 1, skip: 1 },
  });
  assert.equal(summarizeResults([{ status: 'fail' }]).ok, false);
});

#!/usr/bin/env node
// Token-based public read-surface smoke for a live PDPP origin.
//
// This is the reusable counterpart to railway-mcp-query-smoke.mjs: it does not
// seed records or run owner OAuth. Instead it uses an existing client or MCP
// package bearer and exercises the same surface a ChatGPT MCP host, CLI client,
// or REST client depends on.
//
// Usage:
//   PDPP_READ_SURFACE_TOKEN=... node scripts/read-surface-smoke.mjs \
//     --origin https://pdpp.example --connection-id cin_... --stream messages

import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE_MCP_TOOLS = ['schema', 'list_streams', 'query_records', 'fetch', 'search', 'aggregate'];
const EVENT_MCP_TOOLS = [
  'discover_event_subscription_capabilities',
  'list_event_subscriptions',
  'create_event_subscription',
  'get_event_subscription',
  'send_test_event',
  'update_event_subscription',
  'delete_event_subscription',
];

const DEFAULT_STREAM = 'messages';
const DEFAULT_SEARCH_QUERY = 'test';
const DEFAULT_DATE_FIELD = 'sent_at';
const DEFAULT_SINCE = '1970-01-01T00:00:00.000Z';
const DEFAULT_TIMEOUT_MS = 30_000;

export function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    json: false,
    skipCli: false,
    skipMcp: false,
    skipRest: false,
    stream: DEFAULT_STREAM,
    searchQuery: DEFAULT_SEARCH_QUERY,
    dateField: DEFAULT_DATE_FIELD,
    since: DEFAULT_SINCE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--skip-cli') out.skipCli = true;
    else if (arg === '--skip-mcp') out.skipMcp = true;
    else if (arg === '--skip-rest') out.skipRest = true;
    else if (arg === '--origin') out.origin = args[++i];
    else if (arg === '--token') out.token = args[++i];
    else if (arg === '--connection-id') out.connectionId = args[++i];
    else if (arg === '--stream') out.stream = args[++i];
    else if (arg === '--search-query') out.searchQuery = args[++i];
    else if (arg === '--date-field') out.dateField = args[++i];
    else if (arg === '--since') out.since = args[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = Number(args[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

export function normalizeOrigin(origin) {
  return String(origin || '').replace(/\/+$/, '');
}

export function buildUrl(origin, path, params = {}) {
  const url = new URL(path, normalizeOrigin(origin));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function mcpInitializeMessage(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pdpp-read-surface-smoke', version: '1' },
    },
  };
}

export function mcpToolsListMessage(id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

export function mcpToolCallMessage(name, args = {}, id = 3) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

export function parseMcpResponseText(contentType, text) {
  if (!text) return null;
  if (String(contentType || '').includes('text/event-stream')) {
    const dataLines = String(text)
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const payload = dataLines.find((line) => line !== '[DONE]');
    return payload ? JSON.parse(payload) : null;
  }
  return JSON.parse(text);
}

export function extractListData(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.records)) return body.records;
  if (Array.isArray(body?.result?.data)) return body.result.data;
  return [];
}

export function extractRecordId(record) {
  const candidate = record?.id ?? record?.key ?? record?.record_id ?? record?.data?.id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export function extractMcpToolData(rpc) {
  const structured = rpc?.result?.structuredContent;
  if (structured && typeof structured === 'object' && 'error' in structured) return structured.error;
  if (structured && typeof structured === 'object' && 'data' in structured) return structured.data;
  if (structured !== undefined) return structured;
  const text = rpc?.result?.content?.find?.((entry) => entry?.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractMcpToolError(rpc) {
  if (rpc?.error) {
    return {
      code: rpc.error.code ? String(rpc.error.code) : 'json_rpc_error',
      message: String(rpc.error.message ?? 'JSON-RPC error'),
    };
  }
  if (!rpc?.result?.isError) return null;
  const data = extractMcpToolData(rpc);
  if (data && typeof data === 'object') {
    return {
      code: String(data.code ?? data.type ?? 'tool_error'),
      message: String(data.message ?? JSON.stringify(data)),
    };
  }
  return { code: 'tool_error', message: String(data ?? 'MCP tool error') };
}

export function bodyErrorCode(body) {
  return body?.code ?? body?.type ?? body?.error?.code ?? body?.error?.type ?? null;
}

export function classifyAmbiguousConnection(status, body) {
  if (status >= 200 && status < 300) {
    return { ok: true, status: 'pass', detail: 'request succeeded without connection_id; grant may be single-source' };
  }
  const code = bodyErrorCode(body);
  if (status === 409 && code === 'ambiguous_connection') {
    return { ok: true, status: 'pass', detail: 'returned typed ambiguous_connection' };
  }
  return {
    ok: false,
    status: 'fail',
    detail: `expected 2xx or typed ambiguous_connection; got HTTP ${status}${code ? ` ${code}` : ''}`,
  };
}

export function classifyToolNames(toolNames) {
  const missingCore = CORE_MCP_TOOLS.filter((name) => !toolNames.includes(name));
  const missingEvent = EVENT_MCP_TOOLS.filter((name) => !toolNames.includes(name));
  return {
    missingCore,
    missingEvent,
    ok: missingCore.length === 0,
    detail: `${toolNames.length} advertised tool(s)`,
  };
}

export function summarizeResults(results) {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const result of results) counts[result.status] += 1;
  return { ok: counts.fail === 0, counts };
}

export function cliCredentialCacheFile(cacheRoot, origin) {
  const host = new URL(normalizeOrigin(origin)).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  return join(cacheRoot, 'clients', `${host}.json`);
}

export function classifyCliHelp(stdout) {
  const text = String(stdout || '');
  const hasCliHelp = /PDPP CLI/.test(text);
  const advertisedReadCommands = [
    /\bquery[_-]?records\b/i,
    /\bsearch\b/i,
    /\baggregate\b/i,
    /\bfetch\b/i,
  ].filter((pattern) => pattern.test(text));
  return {
    hasCliHelp,
    hasGrantScopedReadCommands: advertisedReadCommands.length > 0,
  };
}

function result(status, surface, name, detail, extra = {}) {
  return { status, surface, name, detail, ...extra };
}

function ok(surface, name, detail, extra) {
  return result('pass', surface, name, detail, extra);
}

function warn(surface, name, detail, extra) {
  return result('warn', surface, name, detail, extra);
}

function fail(surface, name, detail, extra) {
  return result('fail', surface, name, detail, extra);
}

function skip(surface, name, detail, extra) {
  return result('skip', surface, name, detail, extra);
}

async function fetchText(url, { token, method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, accept = 'application/json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: accept };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: resp.status, contentType: resp.headers.get('content-type'), text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(origin, path, params, opts) {
  return fetchText(buildUrl(origin, path, params), opts);
}

async function mcpPost(origin, token, message, timeoutMs) {
  const resp = await fetchText(`${normalizeOrigin(origin)}/mcp`, {
    token,
    method: 'POST',
    body: message,
    timeoutMs,
    accept: 'application/json, text/event-stream',
  });
  const rpc = resp.text ? parseMcpResponseText(resp.contentType, resp.text) : null;
  return { ...resp, rpc };
}

async function pushChecked(results, surface, name, fn) {
  try {
    results.push(await fn());
  } catch (error) {
    results.push(fail(surface, name, error?.message ?? String(error)));
  }
}

function require2xx(resp, surface, name) {
  if (resp.status >= 200 && resp.status < 300) return null;
  const code = bodyErrorCode(resp.json);
  return fail(surface, name, `HTTP ${resp.status}${code ? ` ${code}` : ''}`, { body: resp.json ?? resp.text });
}

function requireMcpOk(resp, name) {
  if (resp.status < 200 || resp.status >= 300) {
    return fail('MCP', name, `HTTP ${resp.status}`, { body: resp.json ?? resp.text });
  }
  const toolError = extractMcpToolError(resp.rpc);
  if (toolError) return fail('MCP', name, `${toolError.code}: ${toolError.message}`);
  return null;
}

async function runRestChecks({ origin, token, connectionId, stream, searchQuery, dateField, since, timeoutMs }) {
  const results = [];
  let firstRecordId = null;

  await pushChecked(results, 'REST', 'schema', async () => {
    const resp = await getJson(origin, '/v1/schema', {}, { token, timeoutMs });
    const failure = require2xx(resp, 'REST', 'schema');
    return failure ?? ok('REST', 'schema', 'schema returned');
  });

  await pushChecked(results, 'REST', 'list_streams.scoped', async () => {
    const resp = await getJson(origin, '/v1/streams', { connection_id: connectionId }, { token, timeoutMs });
    const failure = require2xx(resp, 'REST', 'list_streams.scoped');
    if (failure) return failure;
    const streams = extractListData(resp.json);
    return ok('REST', 'list_streams.scoped', `${streams.length} stream(s) returned`);
  });

  await pushChecked(results, 'REST', 'query_records.basic', async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'query_records.basic');
    if (failure) return failure;
    const records = extractListData(resp.json);
    firstRecordId = extractRecordId(records[0]);
    return ok('REST', 'query_records.basic', `${records.length} record(s) returned`, { firstRecordId });
  });

  await pushChecked(results, 'REST', 'query_records.omit_connection_id', async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1 },
      { token, timeoutMs },
    );
    const verdict = classifyAmbiguousConnection(resp.status, resp.json);
    return result(verdict.status, 'REST', 'query_records.omit_connection_id', verdict.detail);
  });

  await pushChecked(results, 'REST', 'query_records.sort', async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId, sort: `-${dateField}` },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'query_records.sort');
    if (!failure) return ok('REST', 'query_records.sort', `sort=-${dateField} accepted`);
    if (bodyErrorCode(resp.json) === 'unsupported_query') return warn('REST', 'query_records.sort', failure.detail);
    return failure;
  });

  await pushChecked(results, 'REST', 'query_records.count', async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId, count: 'exact' },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'query_records.count');
    if (!failure) return ok('REST', 'query_records.count', 'count=exact accepted');
    if (bodyErrorCode(resp.json) === 'unsupported_query') return warn('REST', 'query_records.count', failure.detail);
    return failure;
  });

  await pushChecked(results, 'REST', 'query_records.filter_object', async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId, [`filter[${dateField}][gte]`]: since },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'query_records.filter_object');
    return failure ? warn('REST', 'query_records.filter_object', failure.detail) : ok('REST', 'query_records.filter_object', 'typed bracket filter accepted');
  });

  await pushChecked(results, 'REST', 'record_detail', async () => {
    if (!firstRecordId) return skip('REST', 'record_detail', 'no record id returned by basic query');
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(firstRecordId)}`,
      { connection_id: connectionId },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'record_detail');
    return failure ?? ok('REST', 'record_detail', `record ${firstRecordId} returned`);
  });

  await pushChecked(results, 'REST', 'search.lexical', async () => {
    const resp = await getJson(
      origin,
      '/v1/search',
      { q: searchQuery, streams: stream, limit: 1, connection_id: connectionId },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'search.lexical');
    return failure ?? ok('REST', 'search.lexical', 'lexical search returned');
  });

  await pushChecked(results, 'REST', 'aggregate.count', async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/aggregate`,
      { metric: 'count', connection_id: connectionId },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'aggregate.count');
    return failure ?? ok('REST', 'aggregate.count', 'count aggregate returned');
  });

  await pushChecked(results, 'REST', 'aggregate.group_by_time', async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/aggregate`,
      { metric: 'count', group_by_time: dateField, granularity: 'day', limit: 7, connection_id: connectionId },
      { token, timeoutMs },
    );
    const failure = require2xx(resp, 'REST', 'aggregate.group_by_time');
    return failure ? warn('REST', 'aggregate.group_by_time', failure.detail) : ok('REST', 'aggregate.group_by_time', `${dateField}/day aggregate returned`);
  });

  await pushChecked(results, 'REST', 'event_capabilities', async () => {
    const resp = await getJson(origin, '/.well-known/oauth-protected-resource', {}, { timeoutMs });
    const failure = require2xx(resp, 'REST', 'event_capabilities');
    if (failure) return failure;
    const supported = resp.json?.capabilities?.client_event_subscriptions?.supported;
    return supported === true
      ? ok('REST', 'event_capabilities', 'client event subscriptions advertised')
      : warn('REST', 'event_capabilities', 'client event subscriptions not advertised');
  });

  await pushChecked(results, 'REST', 'list_event_subscriptions', async () => {
    const resp = await getJson(origin, '/v1/event-subscriptions', {}, { token, timeoutMs });
    const failure = require2xx(resp, 'REST', 'list_event_subscriptions');
    return failure ?? ok('REST', 'list_event_subscriptions', 'event subscriptions listed');
  });

  return { results, firstRecordId };
}

async function runMcpChecks({ origin, token, connectionId, stream, searchQuery, dateField, since, timeoutMs }) {
  const results = [];
  let id = 1;
  let firstRecordId = null;
  const call = (name, args) => mcpPost(origin, token, mcpToolCallMessage(name, args, id++), timeoutMs);

  await pushChecked(results, 'MCP', 'initialize', async () => {
    const resp = await mcpPost(origin, token, mcpInitializeMessage(id++), timeoutMs);
    if (resp.status >= 200 && resp.status < 300 && !resp.rpc?.error) return ok('MCP', 'initialize', 'initialized');
    return fail('MCP', 'initialize', `HTTP ${resp.status}: ${resp.rpc?.error?.message ?? resp.text}`);
  });

  let toolNames = [];
  await pushChecked(results, 'MCP', 'tools.list', async () => {
    const resp = await mcpPost(origin, token, mcpToolsListMessage(id++), timeoutMs);
    if (resp.status < 200 || resp.status >= 300 || resp.rpc?.error) {
      return fail('MCP', 'tools.list', `HTTP ${resp.status}: ${resp.rpc?.error?.message ?? resp.text}`);
    }
    toolNames = (resp.rpc?.result?.tools ?? []).map((tool) => tool?.name).filter(Boolean);
    const verdict = classifyToolNames(toolNames);
    if (!verdict.ok) return fail('MCP', 'tools.list', `missing core tool(s): ${verdict.missingCore.join(', ')}`);
    if (verdict.missingEvent.length > 0) {
      return warn('MCP', 'tools.list', `${verdict.detail}; missing event tool(s): ${verdict.missingEvent.join(', ')}`);
    }
    return ok('MCP', 'tools.list', `${verdict.detail}; all expected tools present`);
  });

  await pushChecked(results, 'MCP', 'schema', async () => {
    const resp = await call('schema', {});
    const failure = requireMcpOk(resp, 'schema');
    return failure ?? ok('MCP', 'schema', 'schema returned');
  });

  await pushChecked(results, 'MCP', 'list_streams.scoped', async () => {
    const resp = await call('list_streams', { connection_id: connectionId });
    const failure = requireMcpOk(resp, 'list_streams.scoped');
    return failure ?? ok('MCP', 'list_streams.scoped', 'streams returned');
  });

  await pushChecked(results, 'MCP', 'query_records.basic', async () => {
    const resp = await call('query_records', { stream, limit: 1, connection_id: connectionId });
    const failure = requireMcpOk(resp, 'query_records.basic');
    if (failure) return failure;
    const records = extractListData(extractMcpToolData(resp.rpc));
    firstRecordId = extractRecordId(records[0]);
    return ok('MCP', 'query_records.basic', `${records.length} record(s) returned`, { firstRecordId });
  });

  await pushChecked(results, 'MCP', 'query_records.omit_connection_id', async () => {
    const resp = await call('query_records', { stream, limit: 1 });
    const toolError = extractMcpToolError(resp.rpc);
    if (!toolError && resp.status >= 200 && resp.status < 300) {
      return ok('MCP', 'query_records.omit_connection_id', 'request succeeded without connection_id; grant may be single-source');
    }
    if (toolError?.code === 'ambiguous_connection') {
      return ok('MCP', 'query_records.omit_connection_id', 'returned typed ambiguous_connection');
    }
    return fail('MCP', 'query_records.omit_connection_id', `expected success or ambiguous_connection; got ${toolError?.code ?? `HTTP ${resp.status}`}`);
  });

  await pushChecked(results, 'MCP', 'query_records.sort_count', async () => {
    const resp = await call('query_records', { stream, limit: 1, connection_id: connectionId, sort: `-${dateField}`, count: 'exact' });
    const failure = requireMcpOk(resp, 'query_records.sort_count');
    if (!failure) return ok('MCP', 'query_records.sort_count', `sort=-${dateField} and count=exact accepted`);
    return failure.detail.includes('unsupported_query') ? warn('MCP', 'query_records.sort_count', failure.detail) : failure;
  });

  await pushChecked(results, 'MCP', 'query_records.filter_object', async () => {
    const resp = await call('query_records', {
      stream,
      limit: 1,
      connection_id: connectionId,
      filter: { [dateField]: { gte: since } },
    });
    const failure = requireMcpOk(resp, 'query_records.filter_object');
    return failure ? warn('MCP', 'query_records.filter_object', failure.detail) : ok('MCP', 'query_records.filter_object', 'typed filter object accepted');
  });

  await pushChecked(results, 'MCP', 'query_records.filter_legacy_literal', async () => {
    const resp = await call('query_records', {
      stream,
      limit: 1,
      connection_id: connectionId,
      filter: `filter[${dateField}][gte]=${since}`,
    });
    const failure = requireMcpOk(resp, 'query_records.filter_legacy_literal');
    return failure ? warn('MCP', 'query_records.filter_legacy_literal', failure.detail) : ok('MCP', 'query_records.filter_legacy_literal', 'legacy literal bracket filter accepted by direct MCP');
  });

  await pushChecked(results, 'MCP', 'query_records.filter_legacy_encoded', async () => {
    const resp = await call('query_records', {
      stream,
      limit: 1,
      connection_id: connectionId,
      filter: `filter%5B${dateField}%5D%5Bgte%5D=${encodeURIComponent(since)}`,
    });
    const toolError = extractMcpToolError(resp.rpc);
    if (toolError?.code === 'invalid_filter') {
      return ok('MCP', 'query_records.filter_legacy_encoded', 'encoded raw filter rejected with invalid_filter');
    }
    if (!toolError && resp.status >= 200 && resp.status < 300) {
      return warn('MCP', 'query_records.filter_legacy_encoded', 'encoded raw filter unexpectedly accepted; confirm this is intentional');
    }
    return warn('MCP', 'query_records.filter_legacy_encoded', `expected invalid_filter; got ${toolError?.code ?? `HTTP ${resp.status}`}`);
  });

  await pushChecked(results, 'MCP', 'fetch', async () => {
    if (!firstRecordId) return skip('MCP', 'fetch', 'no record id returned by basic query');
    const resp = await call('fetch', { id: `${stream}:${firstRecordId}`, connection_id: connectionId });
    const failure = requireMcpOk(resp, 'fetch');
    return failure ?? ok('MCP', 'fetch', `fetched ${stream}:${firstRecordId}`);
  });

  await pushChecked(results, 'MCP', 'search.lexical', async () => {
    const resp = await call('search', { q: searchQuery, streams: [stream], limit: 1, mode: 'lexical', connection_id: connectionId });
    const failure = requireMcpOk(resp, 'search.lexical');
    return failure ?? ok('MCP', 'search.lexical', 'lexical search returned');
  });

  await pushChecked(results, 'MCP', 'aggregate.count', async () => {
    const resp = await call('aggregate', { stream, metric: 'count', connection_id: connectionId });
    const failure = requireMcpOk(resp, 'aggregate.count');
    return failure ?? ok('MCP', 'aggregate.count', 'count aggregate returned');
  });

  await pushChecked(results, 'MCP', 'aggregate.group_by_time', async () => {
    const resp = await call('aggregate', {
      stream,
      metric: 'count',
      group_by_time: dateField,
      granularity: 'day',
      limit: 7,
      connection_id: connectionId,
    });
    const failure = requireMcpOk(resp, 'aggregate.group_by_time');
    return failure ? warn('MCP', 'aggregate.group_by_time', failure.detail) : ok('MCP', 'aggregate.group_by_time', `${dateField}/day aggregate returned`);
  });

  await pushChecked(results, 'MCP', 'discover_event_subscription_capabilities', async () => {
    const resp = await call('discover_event_subscription_capabilities', {});
    const failure = requireMcpOk(resp, 'discover_event_subscription_capabilities');
    return failure ?? ok('MCP', 'discover_event_subscription_capabilities', 'event subscription capabilities returned');
  });

  await pushChecked(results, 'MCP', 'list_event_subscriptions', async () => {
    const resp = await call('list_event_subscriptions', {});
    const failure = requireMcpOk(resp, 'list_event_subscriptions');
    return failure ?? ok('MCP', 'list_event_subscriptions', 'event subscriptions listed');
  });

  results.push(skip('MCP', 'create_event_subscription', 'not run by default; creating a webhook subscription is a side effect'));
  results.push(warn('ChatGPT host', 'direct_recipient_routing', 'direct MCP cannot reproduce ChatGPT host resource invalidation; rerun the ChatGPT-host checklist after this passes'));
  return { results, toolNames };
}

async function runCliChecks({ origin, token, connectionId, stream, dateField, timeoutMs }) {
  const results = [];
  const { spawnSync } = await import('node:child_process');
  const cliBin = join(process.cwd(), 'packages/cli/bin/pdpp.js');
  let parent = null;
  let cacheRoot = null;

  async function ensureCache() {
    if (cacheRoot) return cacheRoot;
    parent = await mkdtemp(join(tmpdir(), 'pdpp-read-surface-cli-'));
    cacheRoot = join(parent, '.pdpp');
    const cacheFile = cliCredentialCacheFile(cacheRoot, origin);
    await mkdir(join(cacheRoot, 'clients'), { recursive: true, mode: 0o700 });
    await writeFile(
      cacheFile,
      `${JSON.stringify(
        {
          provider_url: normalizeOrigin(origin),
          authorization_server: normalizeOrigin(origin),
          scope: 'pdpp:read',
          client: { client_id: 'read-surface-smoke' },
          credential: { access_token: token, token_type: 'Bearer' },
          created_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return cacheRoot;
  }

  function spawnCli(args) {
    return spawnSync('node', [cliBin, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    });
  }

  try {
  await pushChecked(results, 'CLI', 'help', async () => {
    const child = spawnCli(['--help']);
    if (child.status !== 0) return fail('CLI', 'help', `pdpp --help exited ${child.status}: ${child.stderr || child.stdout}`);
    const verdict = classifyCliHelp(child.stdout);
    if (!verdict.hasCliHelp) return fail('CLI', 'help', 'help output did not identify the PDPP CLI');
    return ok('CLI', 'help', 'pdpp --help returned');
  });

  await pushChecked(results, 'CLI', 'token_cache', async () => {
    const root = await ensureCache();
    const child = spawnCli(['token', normalizeOrigin(origin), '--cache-root', root]);
    if (child.status !== 0) return fail('CLI', 'token_cache', `pdpp token exited ${child.status}: ${child.stderr || child.stdout}`);
    if (child.stdout.trim() !== token) return fail('CLI', 'token_cache', 'pdpp token did not return the cached bearer');
    return ok('CLI', 'token_cache', 'stored credential can be read by pdpp token');
  });

  await pushChecked(results, 'CLI', 'grant_scoped_read_commands', async () => {
    const child = spawnCli(['--help']);
    if (child.status !== 0) return fail('CLI', 'grant_scoped_read_commands', `pdpp --help exited ${child.status}`);
    const verdict = classifyCliHelp(child.stdout);
    return verdict.hasGrantScopedReadCommands
      ? ok('CLI', 'grant_scoped_read_commands', 'grant-scoped read commands are advertised')
      : warn('CLI', 'grant_scoped_read_commands', 'current pdpp CLI exposes connect/token but not query_records/search/aggregate/fetch read commands');
  });

  await pushChecked(results, 'CLI', 'schema', async () => {
    const root = await ensureCache();
    const child = spawnCli(['read', 'schema', normalizeOrigin(origin), '--cache-root', root, '--format', 'json']);
    if (child.status !== 0) return fail('CLI', 'schema', `pdpp read schema exited ${child.status}: ${child.stderr || child.stdout}`);
    const parsed = JSON.parse(child.stdout);
    return parsed ? ok('CLI', 'schema', 'schema returned through cached grant') : fail('CLI', 'schema', 'empty schema output');
  });

  await pushChecked(results, 'CLI', 'query_records.basic', async () => {
    const root = await ensureCache();
    const child = spawnCli([
      'read',
      'query-records',
      normalizeOrigin(origin),
      stream,
      '--connection-id',
      connectionId,
      '--limit',
      '1',
      '--sort',
      `-${dateField}`,
      '--cache-root',
      root,
      '--format',
      'json',
    ]);
    if (child.status !== 0) return fail('CLI', 'query_records.basic', `pdpp read query-records exited ${child.status}: ${child.stderr || child.stdout}`);
    const records = extractListData(JSON.parse(child.stdout));
    return ok('CLI', 'query_records.basic', `${records.length} record(s) returned through cached grant`);
  });

  await pushChecked(results, 'CLI', 'aggregate.count', async () => {
    const root = await ensureCache();
    const child = spawnCli([
      'read',
      'aggregate',
      normalizeOrigin(origin),
      stream,
      '--metric',
      'count',
      '--connection-id',
      connectionId,
      '--cache-root',
      root,
      '--format',
      'json',
    ]);
    if (child.status !== 0) return fail('CLI', 'aggregate.count', `pdpp read aggregate exited ${child.status}: ${child.stderr || child.stdout}`);
    const parsed = JSON.parse(child.stdout);
    return parsed ? ok('CLI', 'aggregate.count', 'count aggregate returned through cached grant') : fail('CLI', 'aggregate.count', 'empty aggregate output');
  });
  } finally {
    if (parent) await rm(parent, { recursive: true, force: true });
  }

  return { results };
}

export async function runReadSurfaceSmoke(options) {
  const all = [];
  if (!options.skipRest) {
    const rest = await runRestChecks(options);
    all.push(...rest.results);
  }
  if (!options.skipMcp) {
    const mcp = await runMcpChecks(options);
    all.push(...mcp.results);
  }
  if (!options.skipCli) {
    const cli = await runCliChecks(options);
    all.push(...cli.results);
  }
  return { results: all, summary: summarizeResults(all) };
}

function printTextReport(origin, report) {
  process.stdout.write(`PDPP read-surface smoke against ${origin}\n`);
  for (const entry of report.results) {
    const marker = entry.status.toUpperCase().padEnd(4);
    process.stdout.write(`  ${marker} ${entry.surface}.${entry.name}: ${entry.detail}\n`);
  }
  const { counts } = report.summary;
  process.stdout.write(`\nSummary: ${counts.pass} pass, ${counts.warn} warn, ${counts.skip} skip, ${counts.fail} fail\n`);
}

const USAGE = `Usage: node scripts/read-surface-smoke.mjs --origin <url> --connection-id <cin> [options]

Options:
  --origin <url>            PDPP composed origin / resource server origin.
  --token <bearer>          Client or MCP package bearer. Defaults to
                            PDPP_READ_SURFACE_TOKEN.
  --connection-id <cin>     Connection id to use for scoped read tests.
  --stream <name>           Stream to test (default: messages).
  --search-query <q>        Lexical search probe query (default: test).
  --date-field <field>      Date field for sort/filter/time-bucket probes
                            (default: sent_at).
  --since <iso>             Lower bound for filter probes (default: 1970-01-01).
  --timeout-ms <n>          Per-request timeout (default: 30000).
  --skip-rest               Only run MCP checks.
  --skip-mcp                Only run REST checks.
  --skip-cli                Skip local CLI credential/help checks.
  --json                    Emit machine-readable JSON.
  -h, --help                Show this help.

Exit code 0 means every core REST/MCP check passed. Warnings call out optional
or host-only evidence gaps, including ChatGPT direct-recipient routing and the
current CLI lack of grant-scoped read commands.`;

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const token = opts.token ?? process.env.PDPP_READ_SURFACE_TOKEN;
  if (!opts.origin || !token || !opts.connectionId) {
    process.stderr.write(`--origin, --connection-id, and --token/PDPP_READ_SURFACE_TOKEN are required.\n\n${USAGE}\n`);
    process.exit(2);
  }
  const options = {
    ...opts,
    origin: normalizeOrigin(opts.origin),
    token,
  };
  const report = await runReadSurfaceSmoke(options);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ origin: options.origin, ...report }, null, 2)}\n`);
  } else {
    printTextReport(options.origin, report);
  }
  process.exit(report.summary.ok ? 0 : 1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main(process.argv).catch((error) => {
    process.stderr.write(`read-surface smoke failed: ${error?.message ?? String(error)}\n`);
    process.exit(1);
  });
}

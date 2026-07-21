// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectError, normalizeProviderUrl, readStoredCredential } from '../connect/flow.js';
import { parseArgs, requirePositional } from '../ref/args.js';
import { PdppHttpError, PdppUsageError } from '../ref/errors.js';
import { resolveFormat, writeData, writeEnvelopeWarnings } from '../ref/output.js';

const COMMANDS = new Set(['schema', 'streams', 'query-records', 'fetch', 'field-window', 'search', 'aggregate']);

export function readHelp(binName = 'pdpp') {
  return `Grant-scoped reads (uses pdpp connect/token cache, never owner credentials):
  ${binName} read schema <provider-url> [--view compact] [--stream <name>] [--connection-id <cin>] [--cache-root <dir>] [--format json|table]
  ${binName} read streams <provider-url> [--connection-id <cin>] [--cache-root <dir>] [--format json|table]
  ${binName} read query-records <provider-url> <stream> [--connection-id <cin>] [--limit <n>] [--cursor <cursor>] [--fields a,b] [--sort <spec>] [--count none|estimated|exact] [--filter-json <json>] [--format json|jsonl|table]
  ${binName} read fetch <provider-url> <stream> <record-id> [--connection-id <cin>] [--fields a,b] [--format json|table]
  ${binName} read field-window <provider-url> <stream> <record-id> --field <path> [--connection-id <cin>] [--q <text>] [--offset-chars <n>] [--limit-chars <n>] [--before-chars <n>] [--after-chars <n>] [--format json|table]
  ${binName} read search <provider-url> <query> [--connection-id <cin>] [--streams a,b] [--mode lexical|semantic|hybrid] [--limit <n>] [--format json|jsonl|table]
  ${binName} read aggregate <provider-url> <stream> --metric <metric> [--field <field>] [--connection-id <cin>] [--group-by <field> | --group-by-time <field> --granularity <unit>] [--limit <n>] [--format json|table]`;
}

export async function runRead(argv, io = {}, fetchImpl = globalThis.fetch) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out.write(`${readHelp()}\n`);
    return 0;
  }

  if (!COMMANDS.has(command)) {
    throw new PdppUsageError(`Unknown read command: ${command}`);
  }

  const { flags, positionals } = parseArgs(rest);
  const providerUrl = requirePositional(positionals, 0, 'provider-url');
  let credential;
  let normalizedProviderUrl;
  try {
    const stored = await readStoredCredential(providerUrl, { cacheRoot: flags['cache-root'] });
    credential = stored.credential;
    normalizedProviderUrl = stored.providerUrl;
  } catch (error) {
    if (error instanceof ConnectError) {
      throw new PdppUsageError(error.message);
    }
    throw error;
  }

  const request = buildReadRequest(command, positionals.slice(1), flags, normalizedProviderUrl);
  const body = await fetchReadJson(request, credential.access_token, fetchImpl);
  writeData(projectOutput(body, flags), resolveFormat(flags, 'json', 'json'), out);
  writeEnvelopeWarnings(body, err);
  return 0;
}

export function buildReadRequest(command, positionals, flags, providerUrl) {
  const origin = normalizeProviderUrl(providerUrl);
  if (!origin) throw new PdppUsageError(`Invalid provider URL: ${providerUrl}`);

  if (command === 'schema') {
    return {
      method: 'GET',
      url: buildUrl(origin, '/v1/schema', pickQuery(flags, ['connector-id', 'connection-id', 'stream', 'view'])),
    };
  }

  if (command === 'streams') {
    return {
      method: 'GET',
      url: buildUrl(origin, '/v1/streams', pickQuery(flags, ['connection-id', 'connector-instance-id'])),
    };
  }

  if (command === 'query-records') {
    const stream = requirePositional(positionals, 0, 'stream');
    const query = {
      ...pickQuery(flags, [
        'connection-id',
        'connector-instance-id',
        'cursor',
        'limit',
        'order',
        'sort',
        'count',
        'changes-since',
      ]),
      ...csvQuery(flags, 'fields'),
      ...jsonFilterQuery(flags),
    };
    return { method: 'GET', url: buildUrl(origin, `/v1/streams/${encodeURIComponent(stream)}/records`, query) };
  }

  if (command === 'fetch') {
    const stream = requirePositional(positionals, 0, 'stream');
    const recordId = requirePositional(positionals, 1, 'record-id');
    const query = {
      ...pickQuery(flags, ['connection-id', 'connector-instance-id']),
      ...csvQuery(flags, 'fields'),
    };
    return {
      method: 'GET',
      url: buildUrl(
        origin,
        `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`,
        query,
      ),
    };
  }

  if (command === 'field-window') {
    const stream = requirePositional(positionals, 0, 'stream');
    const recordId = requirePositional(positionals, 1, 'record-id');
    if (!flags.field) throw new PdppUsageError('Missing required flag: --field');
    const query = pickQuery(flags, [
      'connection-id',
      'field',
      'cursor',
      'offset-chars',
      'limit-chars',
      'q',
      'before-chars',
      'after-chars',
    ]);
    return {
      method: 'GET',
      url: buildUrl(
        origin,
        `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}/field-window`,
        query
      ),
    };
  }

  if (command === 'search') {
    const queryText = requirePositional(positionals, 0, 'query');
    const mode = flags.mode ? String(flags.mode) : undefined;
    const path = mode === 'semantic' ? '/v1/search/semantic' : mode === 'hybrid' ? '/v1/search/hybrid' : '/v1/search';
    const query = {
      q: queryText,
      ...pickQuery(flags, ['connection-id', 'connector-instance-id', 'cursor', 'limit']),
      ...csvQuery(flags, 'streams'),
    };
    return { method: 'GET', url: buildUrl(origin, path, query) };
  }

  if (command === 'aggregate') {
    const stream = requirePositional(positionals, 0, 'stream');
    if (!flags.metric) throw new PdppUsageError('Missing required flag: --metric');
    if (flags['group-by'] && flags['group-by-time']) {
      throw new PdppUsageError('Use only one of --group-by or --group-by-time.');
    }
    const query = pickQuery(flags, [
      'connection-id',
      'connector-instance-id',
      'field',
      'granularity',
      'limit',
      'metric',
      'time-zone',
    ]);
    if (flags['group-by']) query.group_by = flags['group-by'];
    if (flags['group-by-time']) query.group_by_time = flags['group-by-time'];
    return { method: 'GET', url: buildUrl(origin, `/v1/streams/${encodeURIComponent(stream)}/aggregate`, query) };
  }

  throw new PdppUsageError(`Unsupported read command: ${command}`);
}

async function fetchReadJson(request, token, fetchImpl) {
  let resp;
  try {
    resp = await fetchImpl(request.url, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new PdppUsageError(`Network request failed: ${error.message}`);
  }

  const text = typeof resp.text === 'function' ? await resp.text() : '';
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (resp.status >= 400) {
    const message =
      parsed?.error_description ||
      parsed?.error?.message ||
      parsed?.message ||
      `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
    throw new PdppHttpError(String(message), resp.status, parsed, {
      request_id: resp.headers?.get?.('x-request-id') ?? null,
    });
  }

  return parsed;
}

function buildUrl(origin, path, query = {}) {
  const url = new URL(path, `${origin}/`);
  for (const [key, value] of Object.entries(query)) {
    appendQuery(url, key, value);
  }
  return url.toString();
}

function appendQuery(url, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const entry of value) appendQuery(url, key, entry);
    return;
  }
  url.searchParams.append(key, String(value));
}

function pickQuery(flags, names) {
  const query = {};
  for (const name of names) {
    const value = flags[name];
    if (value === undefined || value === true) continue;
    query[name.replaceAll('-', '_')] = value;
  }
  return query;
}

function csvQuery(flags, name) {
  const raw = flags[name];
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  return { [name]: raw.split(',').map((entry) => entry.trim()).filter(Boolean) };
}

function jsonFilterQuery(flags) {
  if (flags.filter !== undefined && flags['filter-json'] !== undefined) {
    throw new PdppUsageError('Use only one of --filter or --filter-json.');
  }
  if (typeof flags.filter === 'string') {
    return { filter: flags.filter };
  }
  if (flags['filter-json'] === undefined) return {};

  let parsed;
  try {
    parsed = JSON.parse(flags['filter-json']);
  } catch (error) {
    throw new PdppUsageError(`--filter-json must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PdppUsageError('--filter-json must be a JSON object.');
  }
  const query = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [op, opValue] of Object.entries(value)) {
        query[`filter[${field}][${op}]`] = opValue;
      }
    } else {
      query[`filter[${field}]`] = value;
    }
  }
  return query;
}

function projectOutput(body, flags) {
  if (!flags.data) return body;
  if (body && typeof body === 'object' && Array.isArray(body.data)) return body.data;
  if (body && typeof body === 'object' && Array.isArray(body.records)) return body.records;
  return body;
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { getPdppCacheLayout, writePdppSecretFile } from '../src/cache-layout.js';
import { runCli } from '../src/index.js';

const PROVIDER = 'https://provider.test';

test('read help advertises grant-scoped read commands', async () => {
  const captured = captureIo();
  const code = await runCli(['read', '--help'], captured.io);

  assert.equal(code, 0);
  assert.match(captured.stdout(), /read schema/);
  assert.match(captured.stdout(), /read streams/);
  assert.match(captured.stdout(), /read query-records/);
  assert.match(captured.stdout(), /read fetch/);
  assert.match(captured.stdout(), /read search/);
  assert.match(captured.stdout(), /read aggregate/);
  assert.match(captured.stdout(), /read schema .*--stream <name>.*--connection-id <cin>/s);
  assert.doesNotMatch(captured.stdout(), /connector-instance-id/);
});

test('read schema maps compact stream and connection selectors through cached grant', async () => {
  const cacheRoot = await makeCredentialCache('schema-token');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, '/v1/schema');
    assert.equal(url.searchParams.get('view'), 'compact');
    assert.equal(url.searchParams.get('stream'), 'messages');
    assert.equal(url.searchParams.get('connection_id'), 'cin_slack');
    assert.equal(init.headers.Authorization, 'Bearer schema-token');

    return jsonResponse(200, {
      object: 'schema',
      detail: 'compact',
      connectors: [{ stream_count: 1, streams: [{ name: 'messages' }] }],
    });
  };

  try {
    const captured = captureIo();
    const code = await runCli([
      'read',
      'schema',
      PROVIDER,
      '--view',
      'compact',
      '--stream',
      'messages',
      '--connection-id',
      'cin_slack',
      '--cache-root',
      cacheRoot,
    ], captured.io);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(captured.stdout()).detail, 'compact');
    assert.doesNotMatch(captured.stdout(), /schema-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('read query-records uses cached grant, builds query params, and writes warnings to stderr', async () => {
  const cacheRoot = await makeCredentialCache('query-token');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, '/v1/streams/messages/records');
    assert.equal(url.searchParams.get('connection_id'), 'cin_slack');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.getAll('fields').join(','), 'id,text');
    assert.equal(url.searchParams.get('count'), 'exact');
    assert.equal(url.searchParams.get('filter[sent_at][gte]'), '2026-01-01T00:00:00Z');
    assert.equal(init.headers.Authorization, 'Bearer query-token');

    return jsonResponse(200, {
      object: 'list',
      data: [{ id: 'm1', text: 'hello' }],
      meta: { warnings: [{ code: 'count_downgraded', message: 'exact count unavailable' }] },
    });
  };

  try {
    const captured = captureIo();
    const code = await runCli([
      'read',
      'query-records',
      PROVIDER,
      'messages',
      '--connection-id',
      'cin_slack',
      '--limit',
      '1',
      '--fields',
      'id,text',
      '--count',
      'exact',
      '--filter-json',
      '{"sent_at":{"gte":"2026-01-01T00:00:00Z"}}',
      '--cache-root',
      cacheRoot,
    ], captured.io);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout()).data, [{ id: 'm1', text: 'hello' }]);
    assert.match(captured.stderr(), /warning: count_downgraded/);
    assert.doesNotMatch(captured.stdout(), /query-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('read fetch forwards projection fields through cached grant', async () => {
  const cacheRoot = await makeCredentialCache('fetch-token');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, '/v1/streams/messages/records/messages%3Am1');
    assert.equal(url.searchParams.get('connection_id'), 'cin_slack');
    assert.equal(url.searchParams.getAll('fields').join(','), 'id,sent_at');
    assert.equal(init.headers.Authorization, 'Bearer fetch-token');

    return jsonResponse(200, { object: 'record', data: { id: 'messages:m1', sent_at: '2026-06-09T00:00:00Z' } });
  };

  try {
    const captured = captureIo();
    const code = await runCli([
      'read',
      'fetch',
      PROVIDER,
      'messages',
      'messages:m1',
      '--connection-id',
      'cin_slack',
      '--fields',
      'id,sent_at',
      '--cache-root',
      cacheRoot,
    ], captured.io);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout()).data, { id: 'messages:m1', sent_at: '2026-06-09T00:00:00Z' });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('read search routes modes and stream scopes through cached grant', async () => {
  const cacheRoot = await makeCredentialCache('search-token');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, '/v1/search/hybrid');
    assert.equal(url.searchParams.get('q'), 'pdpp');
    assert.equal(url.searchParams.get('connection_id'), 'cin_slack');
    assert.deepEqual(url.searchParams.getAll('streams'), ['messages', 'channels']);
    assert.equal(url.searchParams.get('limit'), '3');
    assert.equal(init.headers.Authorization, 'Bearer search-token');

    return jsonResponse(200, { object: 'search_result_list', data: [{ id: 'messages:m1' }] });
  };

  try {
    const captured = captureIo();
    const code = await runCli([
      'read',
      'search',
      PROVIDER,
      'pdpp',
      '--mode',
      'hybrid',
      '--streams',
      'messages,channels',
      '--connection-id',
      'cin_slack',
      '--limit',
      '3',
      '--cache-root',
      cacheRoot,
    ], captured.io);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(captured.stdout()).data, [{ id: 'messages:m1' }]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('read commands ignore owner-token flags and use cached client grant only', async () => {
  const cacheRoot = await makeCredentialCache('client-read-token');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.searchParams.has('owner_token'), false);
    assert.equal(init.headers.Authorization, 'Bearer client-read-token');

    return jsonResponse(200, { object: 'schema', connectors: [] });
  };

  try {
    const captured = captureIo();
    const code = await runCli([
      'read',
      'schema',
      PROVIDER,
      '--owner-token',
      'owner-secret',
      '--cache-root',
      cacheRoot,
    ], captured.io);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(captured.stdout(), /owner-secret|client-read-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('read aggregate builds group_by_time aggregate requests from cached grant', async () => {
  const cacheRoot = await makeCredentialCache('aggregate-token');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });

    assert.equal(url.pathname, '/v1/streams/messages/aggregate');
    assert.equal(url.searchParams.get('connection_id'), 'cin_slack');
    assert.equal(url.searchParams.get('metric'), 'count');
    assert.equal(url.searchParams.get('group_by_time'), 'sent_at');
    assert.equal(url.searchParams.get('granularity'), 'day');
    assert.equal(init.headers.Authorization, 'Bearer aggregate-token');

    return jsonResponse(200, { object: 'aggregation', metric: 'count', value: 12 });
  };

  try {
    const captured = captureIo();
    const code = await runCli([
      'read',
      'aggregate',
      PROVIDER,
      'messages',
      '--metric',
      'count',
      '--group-by-time',
      'sent_at',
      '--granularity',
      'day',
      '--connection-id',
      'cin_slack',
      '--cache-root',
      cacheRoot,
    ], captured.io);

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(captured.stdout()).value, 12);
    assert.equal(captured.stderr(), '');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

async function makeCredentialCache(accessToken) {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'pdpp-cli-read-'));
  const layout = getPdppCacheLayout(cacheRoot);
  writePdppSecretFile(
    layout.credentialFile(PROVIDER),
    `${JSON.stringify(
      {
        provider_url: PROVIDER,
        authorization_server: PROVIDER,
        scope: 'pdpp:read',
        client: { client_id: 'test-client' },
        credential: { access_token: accessToken, token_type: 'Bearer' },
        created_at: '2026-06-08T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
  return cacheRoot;
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function jsonResponse(status, body) {
  return {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return 'application/json';
        return null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

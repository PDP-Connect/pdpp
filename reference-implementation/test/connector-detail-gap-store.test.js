import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';
import {
  createSqliteConnectorDetailGapStore,
  sanitizeDetailGapMetadata,
} from '../server/stores/connector-detail-gap-store.js';
import { runConnector } from '../runtime/index.js';

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-detail-gaps-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createConnector(messages) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-detail-gap-connector-'));
  const connectorPath = join(dir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  for (const message of ${JSON.stringify(messages)}) {
    process.stdout.write(JSON.stringify(message) + '\\n');
  }
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`, 'utf8');
  return { connectorPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('connector detail gap store upserts pending gaps, updates status, and redacts unsafe metadata', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    parentStream: 'conversation_list',
    recordKey: 'conv_1',
    detailLocator: {
      conversation_id: 'conv_1',
      url: 'https://chatgpt.com/backend-api/conversation/conv_1?access_token=secret',
      headers: { cookie: 'sid=secret', authorization: 'Bearer secret' },
      request_body: { private: 'payload' },
    },
    listCursor: { after: 'cursor_30' },
    lastError: {
      message: 'rate limited',
      response_url: 'https://chatgpt.com/api?bearer=secret',
      token: 'secret',
    },
    discoveredRunId: 'run_a',
  });

  assert.equal(gap.status, 'pending');
  assert.equal(gap.connector_id, 'chatgpt');
  assert.equal(gap.detail_locator.headers.cookie, '[redacted]');
  assert.equal(gap.detail_locator.headers.authorization, '[redacted]');
  assert.equal(gap.detail_locator.request_body, '[redacted]');
  assert.equal(gap.detail_locator.url.host, 'chatgpt.com');
  assert.equal(gap.detail_locator.url.path_hash.length, 16);
  assert.equal(gap.last_error.token, '[redacted]');
  assert.equal(gap.last_error.response_url.host, 'chatgpt.com');

  const pending = await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_1', streams: ['conversations'] });
  assert.deepEqual(pending.map((entry) => entry.gap_id), [gap.gap_id]);

  const inProgress = await store.markGapStatus(gap.gap_id, 'in_progress', { runId: 'run_b' });
  assert.equal(inProgress.status, 'in_progress');
  assert.equal(inProgress.attempt_count, 1);
  assert.equal(inProgress.last_run_id, 'run_b');

  const recovered = await store.markGapStatus(gap.gap_id, 'recovered', { runId: 'run_b' });
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.recovered_run_id, 'run_b');
}));

test('sanitizeDetailGapMetadata does not preserve full URLs or secret-bearing fields', () => {
  const sanitized = sanitizeDetailGapMetadata({
    href: 'https://example.test/path/to/private?id=123',
    access_token: 'secret',
    nested: { bearer: 'secret', ok: 'safe' },
  });
  assert.deepEqual(sanitized.href, { scheme: 'https', host: 'example.test', path_hash: sanitized.href.path_hash });
  assert.equal(sanitized.access_token, '[redacted]');
  assert.equal(sanitized.nested.bearer, '[redacted]');
  assert.equal(sanitized.nested.ok, 'safe');
});

test('runtime records DETAIL_GAP before successful terminal handling', withTempDb(async () => {
  const calls = [];
  const detailGapStore = {
    async upsertPendingGap(input) {
      calls.push(input);
      return {
        gap_id: 'gap_test',
        stream: input.stream,
        parent_stream: input.parentStream,
        record_key: input.recordKey,
        reason: input.reason,
        status: 'pending',
        detail_locator: { conversation_id: 'conv_1' },
        list_cursor: { after: 'cursor_30' },
        last_error: { message: 'pressure' },
      };
    },
  };
  const { connectorPath, cleanup } = createConnector([
    {
      type: 'DETAIL_GAP',
      stream: 'conversations',
      parent_stream: 'conversation_list',
      record_key: 'conv_1',
      detail_locator: { conversation_id: 'conv_1' },
      list_cursor: { after: 'cursor_30' },
      reason: 'upstream_pressure',
      retryable: true,
      last_error: { message: 'pressure' },
    },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'conversations' }] },
      persistState: false,
      detailGapStore,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stream, 'conversations');
    assert.equal(result.detail_gaps[0].gap_id, 'gap_test');
  } finally {
    cleanup();
  }
}));

test('runtime fails closed when DETAIL_GAP persistence fails', withTempDb(async () => {
  const detailGapStore = {
    async upsertPendingGap() {
      throw new Error('durable gap write failed');
    },
  };
  const { connectorPath, cleanup } = createConnector([
    {
      type: 'DETAIL_GAP',
      stream: 'conversations',
      detail_locator: { conversation_id: 'conv_1' },
    },
    { type: 'STATE', stream: 'conversations', cursor: { after: 'cursor_30' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  try {
    await assert.rejects(
      () => runConnector({
        connectorPath,
        connectorId: 'chatgpt',
        ownerToken: 'owner',
        manifest: { streams: [{ name: 'conversations' }] },
        state: {},
        detailGapStore,
        onProgress: () => {},
      }),
      /durable gap write failed/,
    );
  } finally {
    cleanup();
  }
}));

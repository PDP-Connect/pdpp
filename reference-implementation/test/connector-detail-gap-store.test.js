import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

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

function createConnector(messages, { exitCode = 0 } = {}) {
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
  process.stdout.write('', () => process.exit(${JSON.stringify(exitCode)}));
});
`, 'utf8');
  return { connectorPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function createStartCaptureConnector(outputPath, messages = [{ type: 'DONE', status: 'succeeded', records_emitted: 0 }]) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-detail-gap-start-'));
  const connectorPath = join(dir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(msg), 'utf8');
  for (const message of ${JSON.stringify(messages)}) {
    process.stdout.write(JSON.stringify(message) + '\\n');
  }
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`, 'utf8');
  return { connectorPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withStateServer(fn) {
  const stateWrites = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'PUT' && req.url?.startsWith('/v1/state/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      stateWrites.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/v1/ingest/')) {
      for await (const _chunk of req) {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await fn({
      rsUrl: `http://127.0.0.1:${address.port}`,
      stateWrites,
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
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
  const networkPressure = {
    endpoint_route: 'GET /conversation/{conversation_id}',
    error_class: 'http_429',
    method: 'GET',
    attempt: 12,
    max_attempts: 12,
    status: 429,
    retry_after_ms: 120000,
    safe_headers: { 'retry-after-ms': 120000 },
  };
  const detailGapStore = {
    async listPendingGaps() {
      return [];
    },
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
        last_error: input.lastError,
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
      last_error: {
        message: 'pressure',
        network_pressure: networkPressure,
      },
    },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  const progressMessages = [];
  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'conversations' }] },
      persistState: false,
      detailGapStore,
      onProgress: (msg) => {
        progressMessages.push(msg);
      },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stream, 'conversations');
    assert.deepEqual(calls[0].lastError.network_pressure, networkPressure);
    assert.equal(result.detail_gaps[0].gap_id, 'gap_test');
    const progressGap = progressMessages.find((msg) => msg.type === 'DETAIL_GAP');
    assert.deepEqual(progressGap.last_error.network_pressure, networkPressure);
  } finally {
    cleanup();
  }
}));

test('runtime includes pending detail gaps in START as reference-only safe rows', withTempDb(async (dir) => {
  const startPath = join(dir, 'start.json');
  const pendingGap = {
    gap_id: 'gap_pending',
    stream: 'messages',
    record_key: 'conv_1',
    status: 'pending',
    detail_locator: {
      kind: 'chatgpt.conversation',
      conversation_id: 'conv_1',
      list_item: { id: 'conv_1', title: 'Safe title' },
    },
  };
  const detailGapStore = {
    async listPendingGaps(input) {
      assert.equal(input.connectorId, 'chatgpt');
      assert.equal(input.grantId, 'grant_1');
      assert.deepEqual(input.streams, ['messages']);
      return [pendingGap];
    },
    async upsertPendingGap() {
      throw new Error('unused');
    },
  };
  const { connectorPath, cleanup } = createStartCaptureConnector(startPath);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
    const start = JSON.parse(readFileSync(startPath, 'utf8'));
    assert.deepEqual(start.detail_gaps, [{ ...pendingGap, reference_only: true }]);
  } finally {
    cleanup();
  }
}));

test('runtime fails closed when pending detail gap loading fails before START', withTempDb(async () => {
  const detailGapStore = {
    async listPendingGaps() {
      throw new Error('pending gap load failed');
    },
  };
  const { connectorPath, cleanup } = createConnector([{ type: 'DONE', status: 'succeeded', records_emitted: 0 }]);

  try {
    await assert.rejects(
      () => runConnector({
        connectorPath,
        connectorId: 'chatgpt',
        ownerToken: 'owner',
        manifest: { streams: [{ name: 'messages' }] },
        persistState: false,
        detailGapStore,
        onProgress: () => {},
      }),
      /pending gap load failed/,
    );
  } finally {
    cleanup();
  }
}));

test('runtime marks DETAIL_GAP_RECOVERED only after prior records flush successfully', withTempDb(async () => {
  await withStateServer(async ({ rsUrl }) => {
    const statusCalls = [];
    const detailGapStore = {
      async listPendingGaps() {
        return [];
      },
      async markGapStatus(gapId, status, options) {
        statusCalls.push({ gapId, status, options });
        return {
          gap_id: gapId,
          stream: 'messages',
          record_key: 'conv_1',
          reason: 'rate_limited',
          status,
        };
      },
    };
    const { connectorPath, cleanup } = createConnector([
      {
        type: 'RECORD',
        stream: 'messages',
        key: 'msg_1',
        data: { id: 'msg_1', conversation_id: 'conv_1' },
        emitted_at: new Date().toISOString(),
      },
      {
        type: 'DETAIL_GAP_RECOVERED',
        reference_only: true,
        gap_id: 'gap_conv_1',
        stream: 'messages',
        record_key: 'conv_1',
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId: 'chatgpt',
        ownerToken: 'owner',
        manifest: { streams: [{ name: 'messages' }] },
        rsUrl,
        persistState: false,
        detailGapStore,
        onProgress: () => {},
      });
      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 1);
      assert.equal(statusCalls.length, 1);
      assert.equal(statusCalls[0].gapId, 'gap_conv_1');
      assert.equal(statusCalls[0].status, 'recovered');
      assert.equal(statusCalls[0].options.runId, result.run_id);
    } finally {
      cleanup();
    }
  });
}));

test('runtime fails closed when DETAIL_GAP persistence fails', withTempDb(async () => {
  const detailGapStore = {
    async listPendingGaps() {
      return [];
    },
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

test('runtime rejects state commit when required DETAIL_COVERAGE has no hydrated detail or durable gap', withTempDb(async () => {
  await withStateServer(async ({ rsUrl, stateWrites }) => {
    const { connectorPath, cleanup } = createConnector([
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'conversation_list',
        stream: 'conversations',
        required_keys: ['conv_1'],
        hydrated_keys: [],
      },
      { type: 'STATE', stream: 'conversation_list', cursor: { after: 'cursor_30' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'chatgpt',
          ownerToken: 'owner',
          manifest: { streams: [{ name: 'conversation_list' }, { name: 'conversations' }] },
          state: {},
          rsUrl,
          onProgress: () => {},
        }),
        /Connector detail coverage incomplete: state_stream=conversation_list stream=conversations missing_required_keys=1/,
      );
      assert.equal(stateWrites.length, 0);
    } finally {
      cleanup();
    }
  });
}));

test('runtime commits state when required DETAIL_COVERAGE is backed by matching pending DETAIL_GAP', withTempDb(async () => {
  await withStateServer(async ({ rsUrl, stateWrites }) => {
    const detailGapStore = {
      async listPendingGaps() {
        return [];
      },
      async upsertPendingGap(input) {
        return {
          gap_id: 'gap_conv_1',
          stream: input.stream,
          parent_stream: input.parentStream,
          record_key: input.recordKey,
          reason: input.reason,
          status: 'pending',
          detail_locator: input.detailLocator,
          list_cursor: input.listCursor,
          last_error: input.lastError,
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
      },
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'conversation_list',
        stream: 'conversations',
        required_keys: ['conv_1'],
        hydrated_keys: [],
        gap_keys: ['conv_1'],
      },
      { type: 'STATE', stream: 'conversation_list', cursor: { after: 'cursor_30' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId: 'chatgpt',
        ownerToken: 'owner',
        manifest: { streams: [{ name: 'conversation_list' }, { name: 'conversations' }] },
        state: {},
        rsUrl,
        detailGapStore,
        onProgress: () => {},
      });

      assert.equal(result.status, 'succeeded');
      assert.deepEqual(stateWrites, [{ state: { conversation_list: { after: 'cursor_30' } } }]);
      assert.deepEqual(result.state, { conversation_list: { after: 'cursor_30' } });
    } finally {
      cleanup();
    }
  });
}));

test('runtime preserves no-commit behavior for failed, cancelled, and protocol-violating runs', withTempDb(async () => {
  const cases = [
    {
      name: 'failed',
      messages: [
        { type: 'STATE', stream: 'conversation_list', cursor: { after: 'cursor_30' } },
        {
          type: 'DONE',
          status: 'failed',
          records_emitted: 0,
          error: { message: 'upstream failure', retryable: true },
        },
      ],
      exitCode: 1,
      expectReject: false,
    },
    {
      name: 'cancelled',
      messages: [
        { type: 'STATE', stream: 'conversation_list', cursor: { after: 'cursor_30' } },
        {
          type: 'DONE',
          status: 'cancelled',
          records_emitted: 0,
          error: { message: 'operator cancelled', retryable: false },
        },
      ],
      exitCode: 1,
      expectReject: false,
    },
    {
      name: 'protocol-violating',
      messages: [
        { type: 'STATE', stream: 'conversation_list', cursor: { after: 'cursor_30' } },
        { type: 'DONE', status: 'succeeded', records_emitted: 1 },
      ],
      exitCode: 0,
      expectReject: /Connector reported records_emitted 1 but runtime observed 0/,
    },
  ];

  for (const scenario of cases) {
    await withStateServer(async ({ rsUrl, stateWrites }) => {
      const { connectorPath, cleanup } = createConnector(scenario.messages, { exitCode: scenario.exitCode });
      try {
        const run = () => runConnector({
          connectorPath,
          connectorId: 'chatgpt',
          ownerToken: 'owner',
          manifest: { streams: [{ name: 'conversation_list' }] },
          state: {},
          rsUrl,
          onProgress: () => {},
        });

        if (scenario.expectReject) {
          await assert.rejects(run, scenario.expectReject);
        } else {
          const result = await run();
          assert.equal(result.status, scenario.name);
        }

        assert.equal(stateWrites.length, 0, `${scenario.name} run must not persist staged STATE`);
      } finally {
        cleanup();
      }
    });
  }
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import { closeDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';
import {
  createPostgresConnectorDetailGapStore,
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

function createPagedRecoveryConnector(outputPath, { maxBytes = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-detail-gap-paged-'));
  const connectorPath = join(dir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
const pages = [];
let requestCounter = 0;
const maxBytes = ${JSON.stringify(maxBytes)};
function emit(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function recover(gaps, source) {
  pages.push({ source, count: gaps.length });
  for (const gap of gaps) {
    emit({
      type: 'DETAIL_GAP_RECOVERED',
      reference_only: true,
      gap_id: gap.gap_id,
      stream: gap.stream,
      record_key: gap.record_key,
    });
  }
}
function requestNext() {
  const request_id = 'page_' + (++requestCounter);
  emit({
    type: 'DETAIL_GAPS_PAGE_REQUEST',
    reference_only: true,
    request_id,
    streams: ['messages'],
    ...(maxBytes ? { max_bytes: maxBytes } : {}),
  });
}
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    recover(msg.detail_gaps || [], 'start');
    requestNext();
    return;
  }
  if (msg.type === 'DETAIL_GAPS_PAGE_RESPONSE') {
    const gaps = msg.detail_gaps || [];
    recover(gaps, msg.request_id);
    if (gaps.length === 0) {
      writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ pages }), 'utf8');
      rl.close();
      emit({ type: 'DONE', status: 'succeeded', records_emitted: 0 });
      process.stdout.write('', () => process.exit(0));
      return;
    }
    requestNext();
  }
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

async function seedPendingDetailGaps(store, count, { connectorId = 'chatgpt', payloadFields = 0, stream = 'messages' } = {}) {
  for (let index = 0; index < count; index += 1) {
    const recordKey = `${stream.replace(/[^a-z0-9]+/gi, '_')}_${String(index).padStart(4, '0')}`;
    const listItem = {
      id: recordKey,
      title: `Conversation ${index}`,
    };
    for (let field = 0; field < payloadFields; field += 1) {
      listItem[`padding_${field}`] = `${field}:`.padEnd(300, 'x');
    }
    await store.upsertPendingGap({
      connectorId,
      grantId: 'grant_1',
      stream,
      recordKey,
      detailLocator: {
        kind: 'chatgpt.conversation',
        conversation_id: recordKey,
        list_item: listItem,
      },
      reason: 'retry_exhausted',
    });
  }
}

async function assertConnectorEmittedDetailGapRoundTrip({
  dir,
  store,
  connectorId = 'chatgpt',
  connectorInstanceId = null,
  grantId = 'grant_1',
}) {
  // Host-side linchpin for the ChatGPT 429 resume contract.
  //
  // The package-level connector tests prove the connector EMITS DETAIL_GAP on
  // retry exhaustion and CONSUMES START.detail_gaps on the next run. The two
  // single-direction runtime tests (`runtime records DETAIL_GAP …` and
  // `runtime includes pending detail gaps in START …`) each prove one half of
  // the host seam against a MOCK store, and the instance-isolation test seeds
  // the real store BY HAND. This helper proves the full chain through a REAL
  // store: a connector-emitted gap, written by the runtime's DETAIL_GAP
  // handler, read back verbatim by the next run's START construction.
  const emittedGap = {
    type: 'DETAIL_GAP',
    stream: 'messages',
    parent_stream: 'conversation_list',
    record_key: 'conv_deferred',
    detail_locator: {
      kind: 'chatgpt.conversation',
      conversation_id: 'conv_deferred',
      list_item: { id: 'conv_deferred', title: 'Deferred under pressure' },
    },
    list_cursor: { after: 'cursor_30' },
    reason: 'upstream_pressure',
    retryable: true,
    last_error: {
      message: 'rate limited after retry budget',
      network_pressure: {
        endpoint_route: 'GET /conversation/{conversation_id}',
        error_class: 'http_429',
        status: 429,
        attempt: 12,
        max_attempts: 12,
      },
    },
  };
  const runtimeArgs = {
    connectorId,
    connectorInstanceId,
    grantId,
    ownerToken: 'owner',
    manifest: { streams: [{ name: 'messages' }] },
    persistState: false,
    detailGapStore: store,
    onProgress: () => {},
  };

  // Run 1: connector emits a realistic ChatGPT 429-deferral DETAIL_GAP, then
  // completes successfully (honest partial coverage). The runtime persists the
  // gap through the real store.
  const emitter = createConnector([
    emittedGap,
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  let persistedGapId = null;
  try {
    const run1 = await runConnector({
      ...runtimeArgs,
      connectorPath: emitter.connectorPath,
    });
    assert.equal(run1.status, 'succeeded');
    assert.equal(run1.detail_gaps.length, 1, 'run 1 reports the durable gap it persisted');
    persistedGapId = run1.detail_gaps[0].gap_id;
    assert.ok(persistedGapId, 'persisted gap has a stable id');
  } finally {
    emitter.cleanup();
  }

  // Independent proof the row actually landed in the real store (not just that
  // the runtime echoed it back in-memory).
  const persisted = await store.listPendingGaps({
    connectorId,
    connectorInstanceId,
    grantId,
    streams: ['messages'],
  });
  assert.deepEqual(persisted.map((gap) => gap.gap_id), [persistedGapId]);

  // Run 2: a fresh run with the SAME store. The START construction must load
  // the persisted gap and hand it to the connector as a reference-only row.
  const startPath = join(dir, 'roundtrip-start.json');
  const capturer = createStartCaptureConnector(startPath);
  try {
    const run2 = await runConnector({
      ...runtimeArgs,
      connectorPath: capturer.connectorPath,
    });
    assert.equal(run2.status, 'succeeded');
  } finally {
    capturer.cleanup();
  }

  const start = JSON.parse(readFileSync(startPath, 'utf8'));
  assert.equal(start.detail_gaps.length, 1, 'next run START carries exactly the one deferred gap');
  const startGap = start.detail_gaps[0];
  assert.equal(startGap.gap_id, persistedGapId, 'same gap identity survives the round-trip');
  assert.equal(startGap.stream, 'messages');
  assert.equal(startGap.record_key, 'conv_deferred', 'the deferred conversation is the one returned for retry');
  assert.equal(startGap.status, 'pending');
  assert.equal(startGap.reference_only, true, 'gap is handed back as a reference-only recovery row');
  assert.deepEqual(
    startGap.detail_locator,
    emittedGap.detail_locator,
    'the locator the connector needs to re-fetch survives persistence verbatim',
  );
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

test('connector detail gaps are isolated by connector instance', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const first = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    connectorInstanceId: 'cin_chatgpt_work',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'conv_1',
    detailLocator: { conversation_id: 'conv_1' },
  });
  const second = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    connectorInstanceId: 'cin_chatgpt_personal',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'conv_1',
    detailLocator: { conversation_id: 'conv_1' },
  });

  assert.notEqual(first.gap_id, second.gap_id);
  assert.equal(first.connector_instance_id, 'cin_chatgpt_work');
  assert.equal(second.connector_instance_id, 'cin_chatgpt_personal');

  assert.deepEqual(
    (await store.listPendingGaps({ connectorId: 'chatgpt', connectorInstanceId: 'cin_chatgpt_work', grantId: 'grant_1' }))
      .map((gap) => gap.gap_id),
    [first.gap_id],
  );
  assert.deepEqual(
    (await store.listPendingGaps({ connectorId: 'chatgpt', connectorInstanceId: 'cin_chatgpt_personal', grantId: 'grant_1' }))
      .map((gap) => gap.gap_id),
    [second.gap_id],
  );

  await store.markGapStatus(first.gap_id, 'recovered', { runId: 'run_recovery_a' });
  assert.deepEqual(
    (await store.listPendingGaps({ connectorId: 'chatgpt', connectorInstanceId: 'cin_chatgpt_work', grantId: 'grant_1' }))
      .map((gap) => gap.gap_id),
    [],
  );
  assert.deepEqual(
    (await store.listPendingGaps({ connectorId: 'chatgpt', connectorInstanceId: 'cin_chatgpt_personal', grantId: 'grant_1' }))
      .map((gap) => gap.gap_id),
    [second.gap_id],
  );
}));

test('connector detail gap store is idempotent by gap identity when connector-supplied gap ids change', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const first = await store.upsertPendingGap({
    gapId: 'gap_transient_a',
    connectorId: 'chatgpt',
    connectorInstanceId: 'cin_chatgpt_personal',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'conv_1',
    detailLocator: { conversation_id: 'conv_1' },
    reason: 'rate_limited',
    discoveredRunId: 'run_a',
    lastRunId: 'run_a',
  });
  const second = await store.upsertPendingGap({
    gapId: 'gap_transient_b',
    connectorId: 'chatgpt',
    connectorInstanceId: 'cin_chatgpt_personal',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'conv_1',
    detailLocator: { conversation_id: 'conv_1' },
    reason: 'source_pressure',
    discoveredRunId: 'run_b',
    lastRunId: 'run_b',
  });

  assert.equal(second.gap_id, first.gap_id);
  assert.equal(second.reason, 'source_pressure');
  assert.equal(second.discovered_run_id, 'run_a');
  assert.equal(second.last_run_id, 'run_b');
  assert.deepEqual(
    (await store.listPendingGaps({ connectorId: 'chatgpt', connectorInstanceId: 'cin_chatgpt_personal', grantId: 'grant_1' }))
      .map((gap) => gap.gap_id),
    [first.gap_id],
  );
}));

test('listPendingGapsForConnector returns gaps across every connector instance for diagnostics', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const work = await store.upsertPendingGap({
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_laptop_a',
    grantId: 'grant_local',
    stream: 'local-collector/policy_budget/messages',
    recordKey: 'work-1',
    source: { kind: 'local_device', device_id: 'dev_a', source_instance_id: 'src_a' },
  });
  const home = await store.upsertPendingGap({
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_laptop_b',
    grantId: 'grant_local',
    stream: 'local-collector/policy_budget/messages',
    recordKey: 'home-1',
    source: { kind: 'local_device', device_id: 'dev_b', source_instance_id: 'src_b' },
  });

  // Operator-console projection must see both per-device gaps even
  // without naming a connector instance — the per-instance default
  // fallback in `listPendingGaps` would silently drop these.
  const projected = await store.listPendingGapsForConnector('codex', { limit: 100 });
  assert.deepEqual(
    projected.map((gap) => gap.gap_id).sort(),
    [work.gap_id, home.gap_id].sort(),
  );

  // Each gap still carries the source identity that distinguishes the
  // two devices.
  const byDevice = new Map(projected.map((gap) => [gap.source.device_id, gap]));
  assert.equal(byDevice.get('dev_a').source.source_instance_id, 'src_a');
  assert.equal(byDevice.get('dev_b').source.source_instance_id, 'src_b');

  // Marking one instance recovered must not affect the other.
  await store.markGapStatus(work.gap_id, 'recovered', { runId: 'run_recovery' });
  const afterRecovery = await store.listPendingGapsForConnector('codex', { limit: 100 });
  assert.deepEqual(afterRecovery.map((gap) => gap.gap_id), [home.gap_id]);
}));

// Reason-scoped count-by-status aggregate backing the source-pressure backlog
// rollup's optional `recovered` count
// (`surface-source-pressure-detail-gap-backlog`). It is connector-wide (every
// instance), exact (a real COUNT(*), never a floor), status-scoped, and
// reason-scoped to source pressure — the count-by-status analogue of the
// connector-wide pending read the projection already does.
async function seedRecoveredCountFixture(store, connectorId) {
  // Two recovered source-pressure gaps across two different instances...
  const a = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: 'cin_recovered_a',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_a',
    reason: 'upstream_pressure',
  });
  const b = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: 'cin_recovered_b',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_b',
    reason: 'rate_limited',
  });
  await store.markGapStatus(a.gap_id, 'recovered', { runId: 'run_r1' });
  await store.markGapStatus(b.gap_id, 'recovered', { runId: 'run_r2' });
  // ...a recovered gap with a NON-source-pressure reason (must NOT be counted)...
  const c = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: 'cin_recovered_c',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_c',
    reason: 'temporary_unavailable',
  });
  await store.markGapStatus(c.gap_id, 'recovered', { runId: 'run_r3' });
  // ...and a still-PENDING source-pressure gap (different status, must NOT be
  // counted by the recovered aggregate but proves status scoping).
  await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: 'cin_recovered_d',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_d',
    reason: 'upstream_pressure',
  });
}

async function assertRecoveredCountAggregate(store, connectorId) {
  // Recovered + source-pressure only: a (upstream_pressure) + b (rate_limited).
  const recovered = await store.countGapsByStatusForConnector(connectorId, {
    status: 'recovered',
    reasons: ['rate_limited', 'upstream_pressure'],
  });
  assert.equal(recovered, 2, 'counts only recovered source-pressure gaps across every instance');

  // The pending source-pressure gap proves the status filter: it is NOT in the
  // recovered count, but IS in the pending count (same reason scope).
  const pending = await store.countGapsByStatusForConnector(connectorId, {
    status: 'pending',
    reasons: ['rate_limited', 'upstream_pressure'],
  });
  assert.equal(pending, 1, 'status scope excludes recovered rows from the pending count');

  // Without a reason scope, the non-source-pressure recovered gap is included
  // (3 recovered total: a, b, c) — proving the reason filter is what excludes it
  // above, not some unrelated narrowing.
  const recoveredAnyReason = await store.countGapsByStatusForConnector(connectorId, {
    status: 'recovered',
  });
  assert.equal(recoveredAnyReason, 3, 'no reason scope counts every recovered reason');

  // A connector with no rows drains to a real exact 0 (never null/NaN).
  const empty = await store.countGapsByStatusForConnector('no_such_connector', {
    status: 'recovered',
    reasons: ['rate_limited', 'upstream_pressure'],
  });
  assert.equal(empty, 0, 'an unmatched connector yields an exact 0, not a fabricated value');

  // Guards the contract by construction: an unsupported status throws.
  await assert.rejects(
    () => Promise.resolve(store.countGapsByStatusForConnector(connectorId, { status: 'bogus' })),
    /Unsupported connector detail gap status/,
  );
}

test('countGapsByStatusForConnector returns an exact reason-scoped recovered count across instances', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  await seedRecoveredCountFixture(store, 'chatgpt');
  await assertRecoveredCountAggregate(store, 'chatgpt');
}));

test('sanitizeDetailGapMetadata does not preserve full URLs or secret-bearing fields', () => {
  const sanitized = sanitizeDetailGapMetadata({
    href: 'https://example.test/path/to/private?id=123',
    access_token: 'secret',
    network_pressure: {
      endpoint_route: 'GET /conversation/{conversation_id}',
      unsafe_endpoint_route: 'GET /conversation/private-id?token=secret',
    },
    nested: { bearer: 'secret', ok: 'safe' },
  });
  assert.deepEqual(sanitized.href, { scheme: 'https', host: 'example.test', path_hash: sanitized.href.path_hash });
  assert.equal(sanitized.access_token, '[redacted]');
  assert.equal(sanitized.network_pressure.endpoint_route, 'GET /conversation/{conversation_id}');
  assert.equal(sanitized.network_pressure.unsafe_endpoint_route, '[redacted-url]');
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
  const markedInProgress = [];
  const detailGapStore = {
    async listPendingGaps(input) {
      assert.equal(input.connectorId, 'chatgpt');
      assert.equal(input.grantId, 'grant_1');
      assert.deepEqual(input.streams, ['messages']);
      return [pendingGap];
    },
    async markGapStatus(gapId, status) {
      markedInProgress.push({ gapId, status });
      return { ...pendingGap, status };
    },
    async upsertPendingGap() {
      throw new Error('unused');
    },
    async reclaimStrandedInProgressGaps() {},
    async resetServedInProgressGaps() {},
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
    assert.equal(markedInProgress.length, 1, 'served gap is marked in_progress before connector gets it');
    assert.equal(markedInProgress[0].gapId, pendingGap.gap_id);
    assert.equal(markedInProgress[0].status, 'in_progress');
  } finally {
    cleanup();
  }
}));

test('runtime loads pending detail gaps only for the requested connector instance', withTempDb(async (dir) => {
  const store = createSqliteConnectorDetailGapStore();
  await store.upsertPendingGap({
    connectorId: 'chatgpt',
    connectorInstanceId: 'cin_chatgpt_work',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'work_conv',
    detailLocator: { conversation_id: 'work_conv' },
  });
  const personalGap = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    connectorInstanceId: 'cin_chatgpt_personal',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'personal_conv',
    detailLocator: { conversation_id: 'personal_conv' },
  });
  const startPath = join(dir, 'start-instance.json');
  const { connectorPath, cleanup } = createStartCaptureConnector(startPath);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      connectorInstanceId: 'cin_chatgpt_personal',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
    const start = JSON.parse(readFileSync(startPath, 'utf8'));
    assert.deepEqual(start.detail_gaps.map((gap) => gap.gap_id), [personalGap.gap_id]);
    assert.deepEqual(start.detail_gaps.map((gap) => gap.record_key), ['personal_conv']);
  } finally {
    cleanup();
  }
}));

test('connector-emitted DETAIL_GAP survives real-store persistence and reappears in the next run START.detail_gaps', withTempDb(async (dir) => {
  const store = createSqliteConnectorDetailGapStore();
  // Both runs omit connectorInstanceId so they resolve to the same
  // default-account instance — the production single-owner SQLite path.
  await assertConnectorEmittedDetailGapRoundTrip({ dir, store });
}));

test('runtime drains more than 100 pending detail gaps in one run through paged recovery requests', withTempDb(async (dir) => {
  const store = createSqliteConnectorDetailGapStore();
  await seedPendingDetailGaps(store, 150);
  const pageStatsPath = join(dir, 'paged-recovery.json');
  const connector = createPagedRecoveryConnector(pageStatsPath);
  const pageResponses = [];

  try {
    const result = await runConnector({
      connectorPath: connector.connectorPath,
      connectorId: 'chatgpt',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: (msg) => {
        if (msg?.type === 'DETAIL_GAPS_PAGE_RESPONSE') pageResponses.push(msg);
      },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(
      result.detail_gaps.filter((gap) => gap.status === 'recovered').length,
      150,
      'one logical runtime run recovers every seeded gap, not just the first page',
    );
  } finally {
    connector.cleanup();
  }

  const stats = JSON.parse(readFileSync(pageStatsPath, 'utf8'));
  const positivePages = stats.pages.filter((page) => page.count > 0);
  assert.equal(
    positivePages.reduce((sum, page) => sum + page.count, 0),
    150,
    'connector saw and recovered all gaps across START plus requested pages',
  );
  assert.equal(
    (await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_1', streams: ['messages'], limit: 500 }))
      .length,
    0,
    'durable pending backlog is drained',
  );
  assert.ok(pageResponses.some((page) => page.count === 0), 'runtime eventually returns an empty page');
}));

test('runtime pages large detail-gap payloads by byte budget while still draining semantics', withTempDb(async (dir) => {
  const store = createSqliteConnectorDetailGapStore();
  await seedPendingDetailGaps(store, 12, { payloadFields: 20 });
  const pageStatsPath = join(dir, 'byte-paged-recovery.json');
  const connector = createPagedRecoveryConnector(pageStatsPath, { maxBytes: 16 * 1024 });
  const priorTarget = process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES;
  process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES = String(16 * 1024);

  try {
    const result = await runConnector({
      connectorPath: connector.connectorPath,
      connectorId: 'chatgpt',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.detail_gaps.filter((gap) => gap.status === 'recovered').length, 12);
  } finally {
    if (priorTarget === undefined) {
      delete process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES;
    } else {
      process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES = priorTarget;
    }
    connector.cleanup();
  }

  const stats = JSON.parse(readFileSync(pageStatsPath, 'utf8'));
  const positivePages = stats.pages.filter((page) => page.count > 0);
  assert.ok(positivePages.length > 1, 'large payloads are split across multiple pages');
  assert.ok(
    positivePages.every((page) => page.count < 12),
    'no positive page carries the whole large backlog under the byte budget',
  );
  assert.equal(positivePages.reduce((sum, page) => sum + page.count, 0), 12);
  assert.equal(
    (await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_1', streams: ['messages'], limit: 500 }))
      .length,
    0,
  );
}));

// ─── Attempt-persistence acceptance tests ────────────────────────────────────
//
// These tests prove the cross-run adaptive recovery contract: a pending gap
// served to a connector for recovery increments attempt_count before any
// provider requests are made, so the scheduler-source-pressure cooldown governor
// sees persistence > 0 on subsequent runs and applies a more conservative wait.

test('serving a pending gap in START increments attempt_count to 1 via in_progress mark', withTempDb(async (dir) => {
  const store = createSqliteConnectorDetailGapStore();
  const startPath = join(dir, 'attempt-start.json');

  const seeded = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_attempt',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_attempt' },
    reason: 'upstream_pressure',
  });
  assert.equal(seeded.attempt_count, 0, 'freshly seeded gap starts at attempt_count=0');

  const { connectorPath, cleanup } = createStartCaptureConnector(startPath);
  try {
    await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
  } finally {
    cleanup();
  }

  // Gap was served in START → must now be in_progress with attempt_count=1.
  // listPendingGaps excludes in_progress, so we query via markGapStatus round-trip.
  const afterRun = await store.markGapStatus(seeded.gap_id, 'pending');
  assert.equal(afterRun.attempt_count, 1, 'serving gap in START marks it in_progress and increments attempt_count');
}));

test('recovered gap preserves incremented attempt_count after DETAIL_GAP_RECOVERED', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  const seeded = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_recover',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_recover' },
    reason: 'rate_limited',
  });

  // Mark in_progress (simulates serving gap) — increments to 1.
  await store.markGapStatus(seeded.gap_id, 'in_progress', { runId: 'run_x' });

  // Now recover it.
  const recovered = await store.markGapStatus(seeded.gap_id, 'recovered', { runId: 'run_x' });
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.attempt_count, 1, 'recovered gap retains incremented attempt_count');
  assert.equal(recovered.recovered_run_id, 'run_x');
}));

test('re-deferred pressure gap remains pending with attempt_count > 0 after runtime re-defers it', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  // Seed a gap, serve it (mark in_progress → attempt_count=1), then re-defer
  // it (connector emits DETAIL_GAP again → upsertPendingGap → status=pending,
  // attempt_count stays at 1 because upsert does not reset attempt_count).
  const seeded = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_redefer',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_redefer' },
    reason: 'upstream_pressure',
  });

  // Simulate runtime serving the gap (in_progress).
  await store.markGapStatus(seeded.gap_id, 'in_progress', { runId: 'run_a' });

  // Simulate connector re-deferring it (DETAIL_GAP emitted again).
  const reDeferred = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_redefer',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_redefer' },
    reason: 'upstream_pressure',
    lastRunId: 'run_a',
  });

  assert.equal(reDeferred.status, 'pending', 're-deferred gap is pending');
  assert.equal(reDeferred.attempt_count, 1, 'attempt_count is preserved at 1 after re-deferral');
  assert.equal(reDeferred.gap_id, seeded.gap_id, 'same gap identity persists across re-deferral');
}));

// ─── Durable lease acceptance tests ──────────────────────────────────────────
//
// These tests prove the lease fix: gaps marked in_progress when served are
// reset back to pending if the connector exits without recovering or re-deferring
// them, so they remain retryable. Recovered gaps are never reset.

test('gap served but not recovered is reset to pending after connector exits without recovery', withTempDb(async (dir) => {
  const store = createSqliteConnectorDetailGapStore();
  const startPath = join(dir, 'lease-exit-start.json');

  const seeded = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_lease',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_lease' },
    reason: 'upstream_pressure',
  });
  assert.equal(seeded.attempt_count, 0);

  // Run a connector that receives the gap (increments attempt_count to 1) but
  // exits without emitting DETAIL_GAP_RECOVERED or re-deferring via DETAIL_GAP.
  const { connectorPath, cleanup } = createStartCaptureConnector(startPath);
  try {
    await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
  } finally {
    cleanup();
  }

  // Gap must be back to pending so it can be retried.
  const pending = await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_1', streams: ['messages'] });
  assert.equal(pending.length, 1, 'gap is retryable (pending) after connector exits without recovery');
  assert.equal(pending[0].gap_id, seeded.gap_id);
  // attempt_count must still reflect the attempt that was made.
  assert.equal(pending[0].attempt_count, 1, 'attempt_count is preserved at 1 after reset to pending');
}));

test('recovered gap is not reset to pending by run cleanup', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  const seeded = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_recovered_lease',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_recovered_lease' },
    reason: 'rate_limited',
  });

  // Simulate a run: serve the gap (in_progress) then recover it.
  const emittedGap = {
    type: 'DETAIL_GAP_RECOVERED',
    reference_only: true,
    gap_id: seeded.gap_id,
    stream: 'messages',
    record_key: seeded.record_key,
  };
  const { connectorPath, cleanup } = createConnector([
    emittedGap,
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
  } finally {
    cleanup();
  }

  // Gap must remain recovered, not be reset to pending.
  const pending = await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_1', streams: ['messages'] });
  assert.equal(pending.length, 0, 'recovered gap is not reset to pending by cleanup');
}));

test('prior-run in_progress gap is reclaimed to pending before a new run serves gaps', withTempDb(async (dir) => {
  const store = createSqliteConnectorDetailGapStore();

  const seeded = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'conv_stranded',
    detailLocator: { kind: 'chatgpt.conversation', conversation_id: 'conv_stranded' },
    reason: 'upstream_pressure',
  });

  // Simulate a prior crashed run: mark gap in_progress with a prior run id.
  await store.markGapStatus(seeded.gap_id, 'in_progress', { runId: 'run_prior_crashed' });

  // Gap is now in_progress and invisible to listPendingGaps.
  const beforeReclaim = await store.listPendingGaps({ connectorId: 'chatgpt', grantId: 'grant_1', streams: ['messages'] });
  assert.equal(beforeReclaim.length, 0, 'stranded in_progress gap is not returned by listPendingGaps');

  // A new run should reclaim it and see it in START.
  const startPath = join(dir, 'reclaim-start.json');
  const { connectorPath, cleanup } = createStartCaptureConnector(startPath);
  try {
    await runConnector({
      connectorPath,
      connectorId: 'chatgpt',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'messages' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
  } finally {
    cleanup();
  }

  const start = JSON.parse(readFileSync(startPath, 'utf8'));
  assert.equal(start.detail_gaps.length, 1, 'new run serves the previously stranded gap after reclaiming it');
  assert.equal(start.detail_gaps[0].gap_id, seeded.gap_id, 'reclaimed gap has same identity');
}));

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('connector-emitted DETAIL_GAP survives Postgres persistence and reappears in START.detail_gaps (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
  test('countGapsByStatusForConnector returns an exact reason-scoped recovered count (Postgres) (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('countGapsByStatusForConnector returns an exact reason-scoped recovered count (Postgres)', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `chatgpt_pg_recovered_${suffix}`;

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      // Same fixture + assertions as the SQLite test: proves backend parity for
      // the bounded reason-scoped count-by-status aggregate.
      await seedRecoveredCountFixture(store, connectorId);
      await assertRecoveredCountAggregate(store, connectorId);
    } finally {
      try {
        await postgresQuery(
          'DELETE FROM connector_detail_gaps WHERE connector_id = $1',
          [connectorId],
        );
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
  test('connector-emitted DETAIL_GAP survives Postgres persistence and reappears in START.detail_gaps', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `chatgpt_pg_gap_${suffix}`;
    const connectorInstanceId = `cin_chatgpt_pg_gap_${suffix}`;
    const grantId = `grant_pg_gap_${suffix}`;
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-detail-gaps-pg-'));

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      await assertConnectorEmittedDetailGapRoundTrip({
        dir,
        store,
        connectorId,
        connectorInstanceId,
        grantId,
      });
    } finally {
      try {
        await postgresQuery(
          'DELETE FROM connector_detail_gaps WHERE connector_instance_id = $1',
          [connectorInstanceId],
        );
      } catch {}
      await closePostgresStorage();
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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

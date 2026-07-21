import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import { closeDb, getDb, initDb } from '../server/db.js';
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

// P1 review finding (independent review of commit 5712f3afe): a gap recovered
// with NO run id (e.g. `markGapStatus(id, 'recovered', {})`, the shape
// `ref-device-exporters.ts:recoverLocalCollectorGap` uses for the
// local-collector policy-budget drain — no spine run backs that recovery)
// stayed sticky FOREVER under an earlier revision's
// `recovered_run_id IS NULL OR recovered_run_id = excluded.last_run_id`
// clause, because NULL made the OR branch match unconditionally. A NULL
// `recovered_run_id` carries no same-attempt run context to compare against,
// so it must never behave as a stickiness wildcard — every re-upsert of such
// a row (which the runtime's own DETAIL_GAP handler always issues with a
// real, non-null `lastRunId`) is definitionally later, independent evidence
// and must reopen the row to `pending`.
test('a gap recovered with NO run id reopens to pending on any later re-upsert (does not stay sticky forever)', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const seeded = await store.upsertPendingGap({
    connectorId: 'claude-code',
    connectorInstanceId: 'cin_local_device',
    stream: 'local-collector/policy_budget',
    recordKey: 'budget_window_1',
    detailLocator: { kind: 'local_collector.policy_budget' },
    reason: 'policy_budget',
  });
  // Run-id-less recovery: the local-collector policy-budget drain path calls
  // markGapStatus(id, 'recovered', {}) with no runId.
  const recovered = await store.markGapStatus(seeded.gap_id, 'recovered', {});
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.recovered_run_id, null, 'no run id was supplied, so recovered_run_id stays null');

  // A LATER, independent event re-upserts the SAME identity with a real run
  // id (the shape a genuine connector run, or a second local-collector
  // heartbeat cycle with fresh evidence, would produce).
  const reupserted = await store.upsertPendingGap({
    connectorId: 'claude-code',
    connectorInstanceId: 'cin_local_device',
    stream: 'local-collector/policy_budget',
    recordKey: 'budget_window_1',
    detailLocator: { kind: 'local_collector.policy_budget' },
    reason: 'policy_budget',
    discoveredRunId: 'run_later',
    lastRunId: 'run_later',
  });
  assert.equal(reupserted.gap_id, seeded.gap_id, 'same identity — same row');
  assert.equal(reupserted.status, 'pending', 'a null-recovered_run_id row must reopen on any later re-upsert, not stay sticky forever');
  assert.equal(reupserted.recovered_run_id, null, 'the null recovered_run_id from the original recovery is left as-is (not overwritten by the SET clause)');
}));

test('a gap recovered with NO run id, then re-upserted with ALSO no run id, still reopens (never a wildcard match)', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const seeded = await store.upsertPendingGap({
    connectorId: 'claude-code',
    connectorInstanceId: 'cin_local_device',
    stream: 'local-collector/policy_budget',
    recordKey: 'budget_window_2',
    detailLocator: { kind: 'local_collector.policy_budget' },
    reason: 'policy_budget',
  });
  await store.markGapStatus(seeded.gap_id, 'recovered', {});

  // Even a second run-id-less re-upsert (lastRunId also null/absent) must NOT
  // be treated as matching the stored NULL recovered_run_id — SQL NULL never
  // equals NULL, so there is no same-attempt context to protect here either.
  const reupserted = await store.upsertPendingGap({
    connectorId: 'claude-code',
    connectorInstanceId: 'cin_local_device',
    stream: 'local-collector/policy_budget',
    recordKey: 'budget_window_2',
    detailLocator: { kind: 'local_collector.policy_budget' },
    reason: 'policy_budget',
  });
  assert.equal(reupserted.gap_id, seeded.gap_id);
  assert.equal(reupserted.status, 'pending', 'a null-vs-null recovered_run_id comparison must not be treated as a stickiness match');
}));

test('listPendingGaps returns only retry-eligible pending gaps', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const now = '2026-07-06T12:00:00.000Z';
  const due = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'due',
    detailLocator: { conversation_id: 'due' },
    nextAttemptAfter: '2026-07-06T11:59:00.000Z',
  });
  const noFloor = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'no-floor',
    detailLocator: { conversation_id: 'no-floor' },
  });
  const future = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'future',
    detailLocator: { conversation_id: 'future' },
    nextAttemptAfter: '2026-07-06T12:30:00.000Z',
  });

  const eligible = await store.listPendingGaps({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    streams: ['conversations'],
    now,
  });
  assert.deepEqual(
    eligible.map((gap) => gap.gap_id).sort(),
    [due.gap_id, noFloor.gap_id].sort(),
    'runtime recovery serving must not retry gaps before next_attempt_after',
  );

  const diagnostics = await store.listPendingGapsForConnector('chatgpt', { limit: 100 });
  assert.ok(
    diagnostics.some((gap) => gap.gap_id === future.gap_id),
    'diagnostic pending-gap listing still includes future-scheduled gaps',
  );
}));

test('listPendingGaps prefers lower-attempt work so one hot row cannot starve fresh gaps', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const hot = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'hot',
    detailLocator: { conversation_id: 'hot' },
  });

  for (let attempt = 0; attempt < 24; attempt++) {
    await store.markGapStatus(hot.gap_id, 'in_progress', { runId: `run_hot_${attempt}` });
    await store.resetServedInProgressGaps([hot.gap_id]);
  }

  const cold = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'cold',
    detailLocator: { conversation_id: 'cold' },
  });

  const pending = await store.listPendingGaps({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    streams: ['conversations'],
  });

  assert.deepEqual(
    pending.map((gap) => gap.gap_id),
    [cold.gap_id, hot.gap_id],
    'fresh work must be served ahead of a repeatedly failing pending row'
  );
  assert.equal(pending[0].attempt_count, 0);
  assert.equal(pending[1].attempt_count, 24);
}));

test('listPendingGaps ages older eligible work ahead of fresh arrivals after the rotation window', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const now = '2026-07-14T12:00:00.000Z';
  const agedFresh = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'aged-fresh',
    detailLocator: { conversation_id: 'aged-fresh' },
    now: '2026-07-14T11:30:00.000Z',
  });

  const fresh = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'fresh',
    detailLocator: { conversation_id: 'fresh' },
    now: '2026-07-14T11:59:30.000Z',
  });

  const hot = await store.upsertPendingGap({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    stream: 'conversations',
    recordKey: 'hot-aged',
    detailLocator: { conversation_id: 'hot-aged' },
    now: '2026-07-14T11:58:00.000Z',
  });
  await store.markGapStatus(hot.gap_id, 'in_progress', { now: '2026-07-14T11:58:30.000Z', runId: 'run_hot_aged' });
  await store.resetServedInProgressGaps([hot.gap_id]);

  const pending = await store.listPendingGaps({
    connectorId: 'chatgpt',
    grantId: 'grant_1',
    streams: ['conversations'],
    now,
  });

  assert.deepEqual(
    pending.map((gap) => gap.gap_id),
    [agedFresh.gap_id, fresh.gap_id, hot.gap_id],
    'older eligible work should outrank younger arrivals once it has aged into the rotation bucket'
  );
  assert.equal(pending[0].attempt_count, 0);
  assert.equal(pending[1].attempt_count, 0);
  assert.equal(pending[2].attempt_count, 1);
}));

// ─── Recovery-page fair-progress across multiple runs (gap starvation) ────
//
// Reproduces the live Gmail attachment shape: a pending backlog larger than
// one recovery page, where a fixed head-of-queue subset is served every run
// (every 15 minutes, matching the live cadence) but never recovered. Proves
// that with the aging-bucket ordering every eligible row eventually gets a
// turn across successive runs, while backoff and terminal rows are still
// respected regardless of attempt_count or age.

const RUN_CADENCE_ISO_STEP_MS = 15 * 60 * 1000; // matches PENDING_GAP_ROTATION_WINDOW_SECONDS

function isoAfter(baseIso, stepIndex, stepMs = RUN_CADENCE_ISO_STEP_MS) {
  return new Date(Date.parse(baseIso) + stepIndex * stepMs).toISOString();
}

/** Seed `headCount` "stuck" gaps (oldest by created_at) plus `tailCount`
 * "fresh" gaps (created later, never yet served), matching the live shape:
 * 256 rows repeatedly re-attempted vs. 10,012 rows at attempt_count=0. */
async function seedStarvationBacklog(store, { headCount, tailCount, connectorId, grantId, stream, baseIso }) {
  const head = [];
  for (let i = 0; i < headCount; i++) {
    head.push(await store.upsertPendingGap({
      connectorId, grantId, stream,
      recordKey: `head-${i}`,
      detailLocator: { id: `head-${i}` },
      reason: 'temporary_unavailable',
      now: isoAfter(baseIso, 0, 1000 * i),
    }));
  }
  const tail = [];
  for (let i = 0; i < tailCount; i++) {
    tail.push(await store.upsertPendingGap({
      connectorId, grantId, stream,
      recordKey: `tail-${i}`,
      detailLocator: { id: `tail-${i}` },
      reason: 'temporary_unavailable',
      now: isoAfter(baseIso, 1, 1000 * i),
    }));
  }
  return { head, tail };
}

/** Simulate one run: page `pageSize` eligible gaps as of `runIso`, serve them
 * (in_progress), then reset every served-but-unrecovered gap back to pending
 * at run cleanup — mirroring a connector (like pre-fix Gmail attachments)
 * that never consumes served detail gaps for recovery. */
async function simulateOneStarvedRun(store, { connectorId, grantId, stream, pageSize, runId, runIso }) {
  const page = await store.listPendingGaps({ connectorId, grantId, streams: [stream], limit: pageSize, now: runIso });
  for (const gap of page) {
    await store.markGapStatus(gap.gap_id, 'in_progress', { runId, now: runIso });
  }
  await store.resetServedInProgressGaps(page.map((gap) => gap.gap_id));
  return page;
}

test('fair-progress: a multi-page backlog eventually serves every eligible row across successive 15-minute runs, not just the head-of-queue subset', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const connectorId = 'gmail';
  const grantId = 'grant_1';
  const stream = 'attachments';
  const headCount = 20;
  const tailCount = 60;
  const pageSize = 20; // page size « backlog size, matching the live byte-bounded page « 10,268-row backlog shape.
  const baseIso = '2026-07-01T00:00:00.000Z';

  const { head, tail } = await seedStarvationBacklog(store, { headCount, tailCount, connectorId, grantId, stream, baseIso });

  // Simulate many successful runs, each 15 minutes apart (the live cadence),
  // where the connector never recovers or re-defers what it's served.
  const seenGapIds = new Set();
  for (let run = 0; run < 40; run++) {
    const runIso = isoAfter(baseIso, run + 2);
    const served = await simulateOneStarvedRun(store, { connectorId, grantId, stream, pageSize, runId: `run_${run}`, runIso });
    for (const gap of served) seenGapIds.add(gap.gap_id);
  }

  const allIds = [...head, ...tail].map((gap) => gap.gap_id);
  const neverServed = allIds.filter((id) => !seenGapIds.has(id));
  assert.deepEqual(
    neverServed,
    [],
    `every eligible row must eventually be served across successive runs; starved: ${neverServed.length}/${allIds.length}`,
  );

  // The tail rows (initially unattempted) must have been served, not just the
  // original head-of-queue subset repeating forever.
  for (const gap of tail) {
    assert.ok(seenGapIds.has(gap.gap_id), `tail row ${gap.record_key} was never selected for a recovery page`);
  }
}));

test('fair-progress: backoff-deferred rows stay excluded across runs regardless of attempt_count or age', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const connectorId = 'gmail';
  const grantId = 'grant_1';
  const stream = 'attachments';
  const baseIso = '2026-07-15T12:00:00.000Z';

  // A row served many times (high attempt_count, old) but currently under its
  // own backoff floor must never be selected, even though both the
  // attempt_count and age components of the ordering would otherwise favor it.
  // `markGapStatus('in_progress')` clears next_attempt_after unconditionally (a
  // row being actively attempted has no floor), so attempt_count is built by
  // re-upserting WITH a floor each time (the connector-re-defer shape), not the
  // plain serve/reset cycle used elsewhere in this suite.
  let backedOff = await store.upsertPendingGap({
    connectorId, grantId, stream, recordKey: 'backed-off', detailLocator: { id: 'backed-off' },
    reason: 'temporary_unavailable', nextAttemptAfter: isoAfter(baseIso, 100),
    now: baseIso,
  });
  for (let i = 0; i < 5; i++) {
    await store.markGapStatus(backedOff.gap_id, 'in_progress', { runId: `r${i}`, now: baseIso });
    backedOff = await store.upsertPendingGap({
      connectorId, grantId, stream, recordKey: 'backed-off', detailLocator: { id: 'backed-off' },
      reason: 'temporary_unavailable', nextAttemptAfter: isoAfter(baseIso, 100),
      lastRunId: `r${i}`, now: baseIso,
    });
  }
  assert.ok(backedOff.attempt_count >= 5, 'backed-off row has a high attempt_count going into the assertion');

  const fresh = await store.upsertPendingGap({
    connectorId, grantId, stream, recordKey: 'fresh', detailLocator: { id: 'fresh' },
    reason: 'temporary_unavailable', now: baseIso,
  });

  for (let run = 0; run < 10; run++) {
    const runIso = isoAfter(baseIso, run);
    const page = await store.listPendingGaps({ connectorId, grantId, streams: [stream], now: runIso });
    assert.deepEqual(
      page.map((gap) => gap.gap_id),
      [fresh.gap_id],
      `a backoff-deferred row must be excluded from the page at run ${run} even with a favorable attempt_count/age sort key`,
    );
  }
}));

test('fair-progress: terminal rows never resurface into a recovery page across runs regardless of attempt_count or age', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const connectorId = 'gmail';
  const grantId = 'grant_1';
  const stream = 'attachments';
  const baseIso = '2026-07-01T00:00:00.000Z';

  const terminalCandidate = await store.upsertPendingGap({
    connectorId, grantId, stream, recordKey: 'gone', detailLocator: { id: 'gone' },
    reason: 'temporary_unavailable', now: baseIso,
  });
  await store.markGapStatus(terminalCandidate.gap_id, 'terminal', { reason: 'quarantined', now: baseIso });

  const fresh = await store.upsertPendingGap({
    connectorId, grantId, stream, recordKey: 'fresh', detailLocator: { id: 'fresh' },
    reason: 'temporary_unavailable', now: baseIso,
  });

  for (let run = 0; run < 10; run++) {
    const runIso = isoAfter(baseIso, run);
    const page = await store.listPendingGaps({ connectorId, grantId, streams: [stream], now: runIso });
    assert.deepEqual(
      page.map((gap) => gap.gap_id),
      [fresh.gap_id],
      `a terminal row must never be selected for a recovery page at run ${run} regardless of its attempt_count or age`,
    );
  }
}));

test('fair-progress: a backlog within one page is unaffected by the aging-bucket ordering (membership, not just order)', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const connectorId = 'gmail';
  const grantId = 'grant_1';
  const stream = 'attachments';
  const baseIso = '2026-07-01T00:00:00.000Z';

  const gaps = [];
  for (let i = 0; i < 5; i++) {
    gaps.push(await store.upsertPendingGap({
      connectorId, grantId, stream, recordKey: `g${i}`, detailLocator: { id: `g${i}` },
      reason: 'temporary_unavailable', now: baseIso,
    }));
  }
  // Serve the first a few times (raising its attempt_count) without a large
  // backlog — every row should still be returned since the page limit
  // exceeds the total backlog size.
  for (let i = 0; i < 3; i++) {
    await store.markGapStatus(gaps[0].gap_id, 'in_progress', { runId: `r${i}`, now: baseIso });
    await store.resetServedInProgressGaps([gaps[0].gap_id]);
  }

  const page = await store.listPendingGaps({ connectorId, grantId, streams: [stream], limit: 100, now: baseIso });
  assert.deepEqual(
    page.map((gap) => gap.gap_id).sort(),
    gaps.map((gap) => gap.gap_id).sort(),
    'a backlog smaller than the page limit still returns every eligible row',
  );
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

  const scopedRecovered = await store.countGapsByStatusForConnector(connectorId, {
    status: 'recovered',
    reasons: ['rate_limited', 'upstream_pressure'],
    connectorInstanceId: 'cin_recovered_a',
  });
  assert.equal(scopedRecovered, 1, 'connection-scoped aggregate excludes sibling recovered gaps');

  const scopedEmpty = await store.countGapsByStatusForConnector(connectorId, {
    status: 'recovered',
    reasons: ['rate_limited', 'upstream_pressure'],
    connectorInstanceId: 'cin_missing',
  });
  assert.equal(scopedEmpty, 0, 'connection-scoped aggregate returns exact 0 when no sibling rows match');

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

  const recoveredByStream = await store.countGapsByStatusByStreamForConnector(connectorId, {
    status: 'recovered',
  });
  assert.deepEqual(recoveredByStream, [{ stream: 'messages', count: 3 }], 'stream aggregate groups by stream');

  const scopedRecoveredByStream = await store.countGapsByStatusByStreamForConnector(connectorId, {
    status: 'recovered',
    connectorInstanceId: 'cin_recovered_b',
  });
  assert.deepEqual(
    scopedRecoveredByStream,
    [{ stream: 'messages', count: 1 }],
    'stream aggregate respects connection scope',
  );

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
  await assert.rejects(
    () => Promise.resolve(store.countGapsByStatusByStreamForConnector(connectorId, { status: 'bogus' })),
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
    async markGapStatus(gapId, status, options) {
      markedInProgress.push({ gapId, status, options });
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
    assert.equal(markedInProgress[0].options.runId, result.run_id);
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

test('DETAIL_GAPS_PAGE_RESPONSE carries connector-neutral recovery admission evidence without gating the served set', withTempDb(async (dir) => {
  // Tasks 2.1/2.6: the page response now carries recovery admission evidence
  // (admitted/deferred counts + deferral reason classes) so owner-only
  // diagnostics can answer "why did (or didn't) recovery proceed" — recorded,
  // NOT enforced: every seeded non-pressure gap is still drained.
  const store = createSqliteConnectorDetailGapStore();
  await seedPendingDetailGaps(store, 40); // reason: retry_exhausted → non-pressure, all admitted
  const pageStatsPath = join(dir, 'admission-evidence.json');
  const connector = createPagedRecoveryConnector(pageStatsPath);
  const pageResponses = [];
  const startAdmissions = [];

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
        if (msg?.type === 'DETAIL_GAPS_START_ADMISSION') startAdmissions.push(msg);
      },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.detail_gaps.filter((gap) => gap.status === 'recovered').length, 40);
  } finally {
    connector.cleanup();
  }

  // The START-time page emits its own admission evidence line.
  assert.equal(startAdmissions.length, 1, 'START recovery page emits one admission-evidence event');
  assert.ok(startAdmissions[0].admission, 'START admission evidence is present');
  assert.equal(startAdmissions[0].reference_only, true);

  // Every page response carries an admission summary.
  assert.ok(pageResponses.length > 0);
  for (const page of pageResponses) {
    assert.ok(page.admission, 'each page response carries admission evidence');
    assert.equal(page.admission.candidates, page.count, 'candidate count matches the served page size');
    // All seeded gaps are non-pressure (retry_exhausted): every candidate is
    // admitted, none deferred — the recorded evidence agrees with the drained set.
    assert.equal(page.admission.admitted, page.count);
    assert.equal(page.admission.deferred, 0);
    assert.equal(page.admission.deferred_by_reason, undefined, 'no deferral reasons when everything is admitted');
  }

  // The full backlog drained: admission recorded evidence, it never gated the page.
  const allAdmitted = [startAdmissions[0].admission, ...pageResponses.map((p) => p.admission)]
    .reduce((sum, a) => sum + a.admitted, 0);
  assert.equal(allAdmitted, 40, 'all 40 non-pressure gaps were admitted across START + paged requests');
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

test('runtime does not quarantine Amazon planned run-cap re-deferrals carried as retry_exhausted + run_cap_deferred class', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const orderId = '111-2222222-3333333';
  const detailLocator = { kind: 'amazon.order_detail', order_id: orderId, order_date: '2026-01-05' };
  const seeded = await store.upsertPendingGap({
    connectorId: 'amazon',
    grantId: 'grant_1',
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: orderId,
    detailLocator,
    reason: 'retry_exhausted',
    lastError: { class: 'run_cap_deferred' },
  });

  for (let i = 0; i < 7; i++) {
    await store.markGapStatus(seeded.gap_id, 'in_progress', { runId: `prior_run_${i}` });
    await store.resetServedInProgressGaps([seeded.gap_id]);
  }

  const { connectorPath, cleanup } = createConnector([
    {
      type: 'DETAIL_GAP',
      stream: 'order_items',
      parent_stream: 'orders',
      record_key: orderId,
      detail_locator: detailLocator,
      reason: 'retry_exhausted',
      retryable: true,
      reference_only: true,
      last_error: { class: 'run_cap_deferred' },
    },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'amazon',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'order_items' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
  } finally {
    cleanup();
  }

  const pending = await store.listPendingGaps({ connectorId: 'amazon', grantId: 'grant_1', streams: ['order_items'] });
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal' }), 0);
  assert.equal(pending.length, 1, 'planned cap remains queued for the next eligible recovery envelope');
  assert.equal(pending[0].gap_id, seeded.gap_id);
  assert.equal(pending[0].attempt_count, 8, 'the served attempt is counted without turning planned cap into poison');
  assert.equal(pending[0].reason, 'retry_exhausted');
  assert.equal(pending[0].last_error.class, 'run_cap_deferred');
}));

test('runtime quarantines Amazon-shaped repeated no-progress re-deferrals at the per-item threshold', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const orderId = '111-2222222-3333334';
  const detailLocator = { kind: 'amazon.order_detail', order_id: orderId, order_date: '2026-01-05' };
  const seeded = await store.upsertPendingGap({
    connectorId: 'amazon',
    grantId: 'grant_1',
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: orderId,
    detailLocator,
    reason: 'temporary_unavailable',
    lastError: { class: 'transient_no_progress' },
  });

  for (let i = 0; i < 7; i++) {
    await store.markGapStatus(seeded.gap_id, 'in_progress', { runId: `prior_run_${i}` });
    await store.resetServedInProgressGaps([seeded.gap_id]);
  }

  const { connectorPath, cleanup } = createConnector([
    {
      type: 'DETAIL_GAP',
      stream: 'order_items',
      parent_stream: 'orders',
      record_key: orderId,
      detail_locator: detailLocator,
      reason: 'temporary_unavailable',
      retryable: true,
      reference_only: true,
      last_error: { class: 'transient_no_progress' },
    },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'amazon',
      grantId: 'grant_1',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'order_items' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
  } finally {
    cleanup();
  }

  const pending = await store.listPendingGaps({ connectorId: 'amazon', grantId: 'grant_1', streams: ['order_items'] });
  const terminal = await store.getGapById(seeded.gap_id);
  assert.equal(pending.length, 0, 'poison item no longer consumes the fillable-pending recovery budget');
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal' }), 1);
  assert.deepEqual(
    await store.countGapsByStatusByStreamForConnector('amazon', { status: 'terminal' }),
    [{ stream: 'order_items', count: 1 }],
    'terminal stream aggregate makes quarantined detail gaps visible to source projection',
  );
  assert.equal(terminal.status, 'terminal');
  assert.equal(terminal.reason, 'quarantined');
  assert.equal(terminal.last_error.class, 'quarantined');
  assert.equal(terminal.last_error.failure_class, 'transient_no_progress');
  assert.equal(terminal.last_error.attempt_count, 8);
}));

test('store deliberately requeues quarantined terminal gaps with a fresh no-progress budget', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const connectorInstanceId = 'cin_amazon_retry_test';
  const orderId = '111-2222222-3333335';
  const seeded = await store.upsertPendingGap({
    connectorId: 'amazon',
    connectorInstanceId,
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: orderId,
    detailLocator: { kind: 'amazon.order_detail', order_id: orderId, order_date: '2026-01-06' },
    reason: 'retry_exhausted',
    lastError: { class: 'transient_no_progress' },
  });
  for (let i = 0; i < 8; i++) {
    await store.markGapStatus(seeded.gap_id, 'in_progress', { runId: `prior_run_${i}` });
    await store.resetServedInProgressGaps([seeded.gap_id]);
  }
  await store.markGapStatus(seeded.gap_id, 'terminal', {
    reason: 'quarantined',
    lastError: {
      class: 'quarantined',
      reason: 'retry_exhausted',
      failure_class: 'transient_no_progress',
      attempt_count: 8,
      threshold: 8,
    },
  });

  const summary = await store.requeueQuarantinedTerminalGapsForConnectorInstance('amazon', connectorInstanceId, {
    streams: ['order_items'],
    now: '2026-07-09T12:00:00.000Z',
  });

  assert.deepEqual(summary, { matched: 1, requeued: 1 });
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal', connectorInstanceId }), 0);
  const pending = await store.listPendingGaps({
    connectorId: 'amazon',
    connectorInstanceId,
    streams: ['order_items'],
    now: '2026-07-09T12:00:00.000Z',
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].gap_id, seeded.gap_id);
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].reason, 'retry_exhausted');
  assert.equal(pending[0].attempt_count, 0);
  assert.equal(pending[0].last_attempt_at, null);
  assert.equal(pending[0].next_attempt_after, null);
  assert.equal(pending[0].last_error.class, 'quarantine_retry_requested');
  assert.equal(pending[0].last_error.previous_class, 'quarantined');
  assert.equal(pending[0].last_error.previous_failure_class, 'transient_no_progress');
}));

test('store requeue path does not revive non-quarantined terminal gaps', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const connectorInstanceId = 'cin_amazon_terminal_test';
  const orderId = '111-2222222-3333336';
  const seeded = await store.upsertPendingGap({
    connectorId: 'amazon',
    connectorInstanceId,
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: orderId,
    detailLocator: { kind: 'amazon.order_detail', order_id: orderId, order_date: '2026-01-07' },
    reason: 'temporary_unavailable',
    lastError: { class: 'transient_no_progress' },
  });
  await store.markGapStatus(seeded.gap_id, 'terminal', {
    reason: 'not_found',
    lastError: { class: 'not_found', status: 404 },
  });

  const summary = await store.requeueQuarantinedTerminalGapsForConnectorInstance('amazon', connectorInstanceId, {
    streams: ['order_items'],
  });

  assert.deepEqual(summary, { matched: 0, requeued: 0 });
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal', connectorInstanceId }), 1);
  const pending = await store.listPendingGaps({ connectorId: 'amazon', connectorInstanceId, streams: ['order_items'] });
  assert.equal(pending.length, 0);
  const terminal = await store.getGapById(seeded.gap_id);
  assert.equal(terminal.status, 'terminal');
  assert.equal(terminal.reason, 'not_found');
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
  test('Postgres locator drift re-upserts the same identity and recovery closes the old-shape pending (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
  test('fair-progress: a multi-page backlog eventually serves every eligible row across successive runs (Postgres) (skipped: PDPP_TEST_POSTGRES_URL unset)', {
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
  test('Postgres locator drift re-upserts the same identity and recovery closes the old-shape pending', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `amazon_pg_drift_${suffix}`;
    const connectorInstanceId = `cin_amazon_pg_${suffix}`;
    const grantId = `grant_pg_drift_${suffix}`;

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      // Backend parity for the locator-drift fix: old-shape locator (no
      // order_date) then a new-shape re-discovery must resolve to the SAME
      // identity, and recovery must close the old-shape pending row.
      const oldShape = await store.upsertPendingGap({
        connectorId, connectorInstanceId, grantId,
        stream: 'order_items', parentStream: 'orders', recordKey: 'order-A',
        detailLocator: { kind: 'amazon.order_detail', order_id: 'order-A' },
        reason: 'temporary_unavailable',
      });
      const newShape = await store.upsertPendingGap({
        connectorId, connectorInstanceId, grantId,
        stream: 'order_items', parentStream: 'orders', recordKey: 'order-A',
        detailLocator: { kind: 'amazon.order_detail', order_id: 'order-A', order_date: '2024-11-18' },
        reason: 'temporary_unavailable',
      });
      assert.equal(newShape.gap_id, oldShape.gap_id, 'locator drift re-upserts the same identity on Postgres');
      assert.equal(newShape.detail_locator?.order_date, '2024-11-18', 'Postgres stores the newer locator shape on identity conflict');

      const pendingBefore = await store.listPendingGaps({ connectorId, connectorInstanceId, grantId, streams: ['order_items'] });
      assert.deepEqual(pendingBefore.map((g) => g.gap_id), [oldShape.gap_id], 'exactly one pending row survives the drift');

      await store.markGapStatus(newShape.gap_id, 'recovered', { runId: 'run_recover' });
      const pendingAfter = await store.listPendingGaps({ connectorId, connectorInstanceId, grantId, streams: ['order_items'] });
      assert.equal(pendingAfter.length, 0, 'recovery closes the old-shape pending — no immortal orphan on Postgres');

      // Locator fallback preserved: distinct locators with no record_key stay distinct.
      const locA = await store.upsertPendingGap({
        connectorId, connectorInstanceId, grantId, stream: 'nokey', recordKey: null, detailLocator: { page: 1 },
      });
      const locB = await store.upsertPendingGap({
        connectorId, connectorInstanceId, grantId, stream: 'nokey', recordKey: null, detailLocator: { page: 2 },
      });
      assert.notEqual(locA.gap_id, locB.gap_id, 'without a record_key the locator still disambiguates on Postgres');
    } finally {
      try {
        await postgresQuery('DELETE FROM connector_detail_gaps WHERE connector_instance_id = $1', [connectorInstanceId]);
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
  test('fair-progress: a multi-page backlog eventually serves every eligible row across successive runs (Postgres)', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `gmail_pg_fairness_${suffix}`;
    const grantId = `grant_pg_fairness_${suffix}`;
    const stream = 'attachments';
    const baseIso = '2026-07-01T00:00:00.000Z';

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      const headCount = 20;
      const tailCount = 60;
      const pageSize = 20;
      const { head, tail } = await seedStarvationBacklog(store, { headCount, tailCount, connectorId, grantId, stream, baseIso });

      const seenGapIds = new Set();
      for (let run = 0; run < 40; run++) {
        const runIso = isoAfter(baseIso, run + 2);
        const served = await simulateOneStarvedRun(store, { connectorId, grantId, stream, pageSize, runId: `run_${run}`, runIso });
        for (const gap of served) seenGapIds.add(gap.gap_id);
      }

      const allIds = [...head, ...tail].map((gap) => gap.gap_id);
      const neverServed = allIds.filter((id) => !seenGapIds.has(id));
      assert.deepEqual(
        neverServed,
        [],
        `Postgres: every eligible row must eventually be served across successive runs; starved: ${neverServed.length}/${allIds.length}`,
      );
    } finally {
      try {
        await postgresQuery('DELETE FROM connector_detail_gaps WHERE connector_id = $1', [connectorId]);
      } catch {}
      await closePostgresStorage();
      closeDb();
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

// Chase-shaped end-to-end: a successful retry that emits DETAIL_GAP_RECOVERED for
// the served account gap (the exact message packages/polyfill-connectors chase
// now emits) clears the matching pending transactions gap and leaves an
// unmatched pending gap untouched. Proves the durable half of the Chase fix
// against a real store + real runtime, without driving Playwright.
test('chase 0-transaction retry recovers the matching served account gap and leaves an unmatched gap pending', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  // The account the retry reaches (matches the served gap it recovers).
  const matched = await store.upsertPendingGap({
    connectorId: 'chase',
    grantId: 'grant_chase',
    stream: 'transactions',
    parentStream: 'accounts',
    recordKey: '1212486749',
    detailLocator: { kind: 'chase.account', account_id: '1212486749' },
    reason: 'temporary_unavailable',
  });
  // A second pending gap for a different account the run never reaches. It must
  // stay pending — recovery must not clear unrelated gaps.
  const unmatched = await store.upsertPendingGap({
    connectorId: 'chase',
    grantId: 'grant_chase',
    stream: 'transactions',
    parentStream: 'accounts',
    recordKey: '9999999999',
    detailLocator: { kind: 'chase.account', account_id: '9999999999' },
    reason: 'temporary_unavailable',
  });

  // The chase connector, on a 0-transaction successful parse of the reached
  // account, emits exactly this DETAIL_GAP_RECOVERED for the served gap_id.
  const { connectorPath, cleanup } = createConnector([
    { type: 'DETAIL_GAP_RECOVERED', reference_only: true, gap_id: matched.gap_id, stream: 'transactions', record_key: '1212486749' },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId: 'chase',
      grantId: 'grant_chase',
      ownerToken: 'owner',
      manifest: { streams: [{ name: 'accounts' }, { name: 'transactions' }] },
      persistState: false,
      detailGapStore: store,
      onProgress: () => {},
    });
    assert.equal(result.status, 'succeeded');
  } finally {
    cleanup();
  }

  const matchedRow = await store.getGapById(matched.gap_id);
  assert.equal(matchedRow.status, 'recovered', 'the reached account gap moves to recovered');
  assert.ok(matchedRow.recovered_run_id, 'recovered_run_id is set on the recovered gap');

  const unmatchedRow = await store.getGapById(unmatched.gap_id);
  assert.equal(unmatchedRow.status, 'pending', 'the unreached account gap stays pending — no collateral recovery');
  assert.equal(unmatchedRow.recovered_run_id, null, 'the unmatched gap never gets a recovered_run_id');

  const pending = await store.listPendingGaps({ connectorId: 'chase', grantId: 'grant_chase', streams: ['transactions'] });
  assert.deepEqual(
    pending.map((g) => g.record_key).sort(),
    ['9999999999'],
    'only the unmatched account remains pending after the retry'
  );
}));

// ─── Locator-schema-drift identity tests ─────────────────────────────────────
//
// The durable gap identity is `(instance, grant, stream, parent, record_key)`
// with the VOLATILE `detail_locator_json` deliberately excluded when a
// record_key is present. This closes the "immortal orphan" class observed live
// on Amazon: a connector changed its detail_locator shape (added `order_date`),
// which — when the locator was part of identity — minted a NEW gap_id for the
// SAME record, orphaning the old-shape pending row so it could never be closed
// when the record was later recovered under the new shape.

test('locator-schema drift re-upserts the SAME gap identity (no orphan) when record_key is stable', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  // Old-shape locator: no `order_date` (the exact live Amazon orphan shape).
  const oldShape = await store.upsertPendingGap({
    connectorId: 'amazon',
    connectorInstanceId: 'cin_amazon',
    grantId: 'grant_1',
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: '113-0037140-4304201',
    detailLocator: { kind: 'amazon.order_detail', order_id: '113-0037140-4304201' },
    reason: 'temporary_unavailable',
  });

  // New-shape locator for the SAME record: the connector now also emits
  // `order_date`. Under locator-in-identity this minted a second row; now it
  // must resolve to the SAME identity and update the existing row in place.
  const newShape = await store.upsertPendingGap({
    connectorId: 'amazon',
    connectorInstanceId: 'cin_amazon',
    grantId: 'grant_1',
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: '113-0037140-4304201',
    detailLocator: { kind: 'amazon.order_detail', order_id: '113-0037140-4304201', order_date: '2024-11-18' },
    reason: 'temporary_unavailable',
  });

  assert.equal(newShape.gap_id, oldShape.gap_id, 'a locator-shape change re-upserts the same identity, not a new orphan');
  assert.equal(newShape.detail_locator?.order_date, '2024-11-18', 'the durable row stores the newer locator shape');

  // Exactly one durable row exists for the record — the orphan can never form.
  const pending = await store.listPendingGaps({
    connectorId: 'amazon', connectorInstanceId: 'cin_amazon', grantId: 'grant_1', streams: ['order_items'],
  });
  assert.deepEqual(pending.map((g) => g.gap_id), [oldShape.gap_id], 'exactly one pending row survives the locator drift');
}));

test('recovery under a new-shape locator closes the pre-existing old-shape pending gap', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  // A pending gap discovered under the OLD locator shape.
  const pendingOld = await store.upsertPendingGap({
    connectorId: 'amazon',
    connectorInstanceId: 'cin_amazon',
    grantId: 'grant_1',
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: 'order-A',
    detailLocator: { kind: 'amazon.order_detail', order_id: 'order-A' },
    reason: 'temporary_unavailable',
  });

  // The next run rediscovers the record under a NEW locator shape and recovers
  // it. Because identity ignores the locator, the recovered gap_id is the SAME
  // row — recovery closes the very pending row that was previously immortal.
  const rediscovered = await store.upsertPendingGap({
    connectorId: 'amazon',
    connectorInstanceId: 'cin_amazon',
    grantId: 'grant_1',
    stream: 'order_items',
    parentStream: 'orders',
    recordKey: 'order-A',
    detailLocator: { kind: 'amazon.order_detail', order_id: 'order-A', order_date: '2024-11-18' },
    reason: 'temporary_unavailable',
  });
  assert.equal(rediscovered.gap_id, pendingOld.gap_id);

  const recovered = await store.markGapStatus(rediscovered.gap_id, 'recovered', { runId: 'run_recover' });
  assert.equal(recovered.status, 'recovered');

  const stillPending = await store.listPendingGaps({
    connectorId: 'amazon', connectorInstanceId: 'cin_amazon', grantId: 'grant_1', streams: ['order_items'],
  });
  assert.equal(stillPending.length, 0, 'no immortal old-shape orphan remains after recovery');
}));

test('a record_key literally starting with "loc:" never collides with a locator-only gap', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();

  // A real record whose key literally begins with the locator-fallback prefix.
  const keyed = await store.upsertPendingGap({
    connectorId: 'x',
    connectorInstanceId: 'cin_x',
    grantId: 'grant_1',
    stream: 's',
    recordKey: 'loc:hello',
    detailLocator: { any: 'thing' },
  });

  // A DIFFERENT gap with NO record_key whose locator text could hash toward the
  // same string if branches were not namespaced. These MUST remain distinct.
  const locatorOnly = await store.upsertPendingGap({
    connectorId: 'x',
    connectorInstanceId: 'cin_x',
    grantId: 'grant_1',
    stream: 's',
    recordKey: null,
    detailLocator: 'hello',
  });

  assert.notEqual(keyed.gap_id, locatorOnly.gap_id, 'key: and loc: namespaces are disjoint — no cross-branch collision');
  const pending = await store.listPendingGaps({ connectorId: 'x', connectorInstanceId: 'cin_x', grantId: 'grant_1', streams: ['s'] });
  assert.equal(pending.length, 2, 'both distinct gaps persist');
}));

test('with no record_key, distinct locators still form distinct identities (locator fallback preserved)', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const first = await store.upsertPendingGap({
    connectorId: 'x', connectorInstanceId: 'cin_x', grantId: 'grant_1', stream: 's', recordKey: null,
    detailLocator: { page: 1 },
  });
  const second = await store.upsertPendingGap({
    connectorId: 'x', connectorInstanceId: 'cin_x', grantId: 'grant_1', stream: 's', recordKey: null,
    detailLocator: { page: 2 },
  });
  assert.notEqual(first.gap_id, second.gap_id, 'without a record_key the locator still disambiguates');
  const pending = await store.listPendingGaps({ connectorId: 'x', connectorInstanceId: 'cin_x', grantId: 'grant_1', streams: ['s'] });
  assert.equal(pending.length, 2);
}));

// Migration reconciliation: a DB carrying pre-existing duplicate rows (the live
// state — same record, two locator shapes) is collapsed to one row on init,
// keeping the most-resolved sibling and deleting the orphan pending row. This
// also proves the new UNIQUE identity index can be built over previously-dup'd
// data without a constraint violation.
test('migration collapses pre-existing locator-drift duplicate rows, keeping the resolved sibling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-detail-gaps-migrate-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  try {
    initDb(dbPath);
    // Simulate the live pre-fix state: two rows for ONE record differing only in
    // detail_locator_json — an old-shape pending orphan and a new-shape recovered
    // sibling. Insert them directly with the identity index dropped so the legacy
    // (locator-in-identity) duplicate can exist, exactly as it does in prod.
    const raw = getDb();
    raw.exec('DROP INDEX IF EXISTS uniq_connector_detail_gaps_identity');
    const insert = raw.prepare(`
      INSERT INTO connector_detail_gaps(
        gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key,
        detail_locator_json, reason, status, attempt_count, created_at, updated_at
      ) VALUES (?, 'amazon', 'cin_amazon', 'grant_1', '{}', 'order_items', 'orders', 'order-A', ?, 'temporary_unavailable', ?, ?, ?, ?)
    `);
    // Old-shape pending orphan (high attempt count, older) …
    insert.run('gap_old_orphan', JSON.stringify({ kind: 'amazon.order_detail', order_id: 'order-A' }), 'pending', 17, '2026-06-19T00:00:00.000Z', '2026-06-26T00:00:00.000Z');
    // … and the new-shape recovered sibling (the record IS actually covered).
    insert.run('gap_new_recovered', JSON.stringify({ kind: 'amazon.order_detail', order_id: 'order-A', order_date: '2024-11-18' }), 'recovered', 3, '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z');
    closeDb();

    // Re-open the SAME file: the detail-gap migration runs, reconciling the
    // duplicates before rebuilding the unique identity index.
    initDb(dbPath);
    const reopened = getDb();
    const rows = reopened.prepare("SELECT gap_id, status FROM connector_detail_gaps WHERE record_key = 'order-A' ORDER BY gap_id").all();
    assert.deepEqual(
      rows,
      [{ gap_id: 'gap_new_recovered', status: 'recovered' }],
      'migration keeps the resolved sibling and deletes the immortal old-shape pending orphan',
    );

    // The rebuilt unique identity index now rejects a re-inserted duplicate.
    assert.throws(
      () => reopened.prepare(`
        INSERT INTO connector_detail_gaps(gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key, detail_locator_json, reason, status, attempt_count, created_at, updated_at)
        VALUES ('gap_dupe_attempt', 'amazon', 'cin_amazon', 'grant_1', '{}', 'order_items', 'orders', 'order-A', ?, 'x', 'pending', 0, ?, ?)
      `).run(JSON.stringify({ kind: 'amazon.order_detail', order_id: 'order-A', order_date: '2099-01-01' }), '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z'),
      /UNIQUE|constraint/i,
      'the rebuilt identity index is locator-independent: a third locator shape for the same record is a duplicate',
    );
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

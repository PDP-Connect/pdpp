import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { closeDb } from '../server/db.js';
import { createScheduler } from '../runtime/scheduler.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();

  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 2000);

    srv.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
  ]);
}

function writeLoggingConnector(tmpDir, name = 'scheduled-connector.mjs') {
  const attemptsPath = join(tmpDir, 'scheduled-attempts.log');
  const connectorPath = join(tmpDir, name);
  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');
  return { attemptsPath, connectorPath };
}

function readAttempts(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function closeHttpServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { status: resp.status, body };
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: device.user_code,
      subject_id: subjectId,
    }).toString(),
  });
  assert.equal(approveResp.status, 200);

  const { body: token } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: device.device_code,
    }).toString(),
  });

  return token.access_token;
}

async function waitFor(condition, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for scheduler run to complete');
}

function cancelledInteractionResponse(interaction) {
  return {
    type: 'INTERACTION_RESPONSE',
    request_id: interaction.request_id,
    status: 'cancelled',
  };
}

test('server-owned scheduler starts persisted enabled schedules after startup', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-server-scheduler-enabled-'));
  const dbPath = join(tmpDir, 'pdpp.sqlite');
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  let server = null;

  try {
    server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath });
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      interval_seconds: 60,
      jitter_seconds: 0,
      enabled: true,
    });
    await closeServer(server);
    closeDb();
    server = null;

    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      connectorPathResolver: () => connectorPath,
    });

    await waitFor(() => readAttempts(attemptsPath).length === 1, 5000);
  } finally {
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server-owned scheduler refreshes after schedule route mutations', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-server-scheduler-route-refresh-'));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    connectorPathResolver: () => connectorPath,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const putResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(spotifyManifest.connector_id)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 60, jitter_seconds: 0, enabled: true }),
    });
    assert.equal(putResp.status, 200);
    await waitFor(() => readAttempts(attemptsPath).length === 1, 5000);

    const pauseResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(spotifyManifest.connector_id)}/schedule/pause`, {
      method: 'POST',
    });
    assert.equal(pauseResp.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(readAttempts(attemptsPath).length, 1, 'paused route mutation should stop the live scheduler');
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server-owned scheduler ignores paused and deleted persisted schedules', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-server-scheduler-paused-deleted-'));
  const dbPath = join(tmpDir, 'pdpp.sqlite');
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  let server = null;

  try {
    server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath });
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      interval_seconds: 60,
      jitter_seconds: 0,
      enabled: true,
    });
    await server.controller.setScheduleEnabled(spotifyManifest.connector_id, false);
    await closeServer(server);
    closeDb();
    server = null;

    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      connectorPathResolver: () => connectorPath,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(readAttempts(attemptsPath).length, 0, 'paused schedule should not run after startup');

    await closeServer(server);
    closeDb();
    server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath });
    await server.controller.deleteSchedule(spotifyManifest.connector_id);
    await closeServer(server);
    closeDb();
    server = null;

    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      connectorPathResolver: () => connectorPath,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(readAttempts(attemptsPath).length, 0, 'deleted schedule should not run after startup');
  } finally {
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scheduler history records checkpoint summaries from runConnector results', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];
  const stateStore = new Map();

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest: spotifyManifest,
          ownerToken,
          intervalMs: 60_000,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async (connectorId) => stateStore.get(connectorId) || null,
      setState: async (connectorId, state) => {
        stateStore.set(connectorId, state);
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'succeeded');
    assert.deepEqual(record.source, {
      kind: 'connector',
      id: spotifyManifest.connector_id,
    });
    assert.ok(record.runId);
    assert.ok(record.traceId);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'committed',
      records_flushed: 21,
      buffered_records_dropped: 0,
      state_streams_staged: 2,
      state_streams_committed: 2,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.deepEqual(historyRecord.source, record.source);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    assert.deepEqual(
      stats[spotifyManifest.connector_id].lastRun?.source,
      record.source,
    );
    assert.deepEqual(
      stats[spotifyManifest.connector_id].lastRun?.checkpointSummary,
      record.checkpointSummary,
    );

    const persistedState = stateStore.get(spotifyManifest.connector_id);
    assert.ok(persistedState?.top_artists);
    assert.ok(persistedState?.saved_tracks);
  } finally {
    await closeServer(server);
  }
});

test('scheduler hydrates persisted history without bypassing a fresh persisted last-run interval', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];
  const appendedHistory = [];
  const lastRunUpserts = [];
  const persistedHistory = {
    connectorId: 'https://registry.pdpp.org/connectors/persisted-history',
    source: {
      kind: 'connector',
      id: 'https://registry.pdpp.org/connectors/persisted-history',
    },
    status: 'skipped',
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    checkpointSummary: null,
    knownGaps: [],
    connectorError: null,
    runId: null,
    traceId: null,
    failureReason: null,
    terminalReason: null,
    startedAt: '2026-04-29T00:00:00.000Z',
    completedAt: '2026-04-29T00:00:00.000Z',
    attempt: 0,
  };

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_persistence_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest: spotifyManifest,
          ownerToken,
          intervalMs: 60_000,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
      schedulerStore: {
        appendRunHistory: async (record) => appendedHistory.push(record),
        listLastRunTimes: async () => [
          {
            connector_id: spotifyManifest.connector_id,
            last_run_time_ms: Date.now(),
            updated_at: '2026-04-29T00:00:00.000Z',
          },
        ],
        listRunHistory: async () => [persistedHistory],
        upsertLastRunTime: async (connectorId, lastRunTimeMs, updatedAt) => {
          lastRunUpserts.push({ connectorId, lastRunTimeMs, updatedAt });
        },
      },
    });

    scheduler.start();
    await waitFor(() => scheduler.getHistory().length >= 1, 8000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    scheduler.stop();

    assert.equal(scheduler.getHistory()[0].connectorId, persistedHistory.connectorId);
    assert.equal(appendedHistory.length, 0);
    assert.equal(lastRunUpserts.length, 0);
    assert.equal(completedRuns.length, 0);
  } finally {
    await closeServer(server);
  }
});

test('scheduler preserves failure reasons and checkpoint summaries from failed runConnector results', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-failure-test',
    version: '1.0.0',
    display_name: 'Scheduler Failure Test Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-failure-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'unexpected_items',
    key: 'oops',
    data: { id: 'oops', value: 'bad stream' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_failure_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.failureReason, 'connector_protocol_violation');
    assert.equal(record.terminalReason, 'connector_protocol_violation');
    assert.equal(record.connectorError, null);
    assert.match(record.error || '', /Connector emitted RECORD for undeclared stream/);
    assert.ok(record.runId);
    assert.ok(record.traceId);
    assert.deepEqual(record.source, {
      kind: 'connector',
      id: manifest.connector_id,
    });
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'not_committed',
      records_flushed: 0,
      buffered_records_dropped: 0,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.failureReason, record.failureReason);
    assert.equal(historyRecord.runId, record.runId);
    assert.equal(historyRecord.traceId, record.traceId);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].failed, 1);
    assert.equal(stats[manifest.connector_id].lastRun?.failureReason, 'connector_protocol_violation');
    assert.deepEqual(
      stats[manifest.connector_id].lastRun?.checkpointSummary,
      record.checkpointSummary,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler preserves partial checkpoint commit summaries from state persistence failures after DONE(succeeded)', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-partial-checkpoint-test',
    version: '1.0.0',
    display_name: 'Scheduler Partial Checkpoint Test Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
      {
        name: 'other_items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-partial-checkpoint-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_partial_items',
    data: { id: 'scheduler_partial_items', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'scheduler_partial_other_items',
    data: { id: 'scheduler_partial_other_items', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'other_items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const completedRuns = [];
  const committedState = [];
  let stateWriteCount = 0;
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname.startsWith('/v1/ingest/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
      return;
    }

    if (req.method === 'PUT' && url.pathname === `/v1/state/${encodeURIComponent(manifest.connector_id)}`) {
      let body = '';
      for await (const chunk of req) body += chunk;
      stateWriteCount += 1;
      const payload = JSON.parse(body || '{}');
      if (stateWriteCount === 1) {
        committedState.push(payload.state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated_state_write_failure' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await new Promise((resolve) => rsServer.listen(0, resolve));
    const rsPort = rsServer.address().port;

    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_partial_checkpoint_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 0,
        },
      ],
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {
        throw new Error('setState should not be called when checkpoint commit fails');
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.failureReason, 'runtime_error');
    assert.equal(record.terminalReason, 'runtime_error');
    assert.equal(record.connectorError, null);
    assert.equal(record.recordsEmitted, 2);
    assert.equal(record.reportedRecordsEmitted, 2);
    assert.match(record.error || '', /State persistence failed for other_items: 500/);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'partially_committed',
      records_flushed: 2,
      buffered_records_dropped: 0,
      state_streams_staged: 2,
      state_streams_committed: 1,
    });
    assert.deepEqual(committedState, [{ items: { cursor: 'items_cursor_partial_commit' } }]);

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.failureReason, record.failureReason);
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].failed, 1);
    assert.equal(stats[manifest.connector_id].lastRun?.failureReason, 'runtime_error');
    assert.equal(stats[manifest.connector_id].lastRun?.terminalReason, 'runtime_error');
    assert.equal(stats[manifest.connector_id].lastRun?.recordsEmitted, 2);
    assert.equal(stats[manifest.connector_id].lastRun?.reportedRecordsEmitted, 2);
    assert.deepEqual(
      stats[manifest.connector_id].lastRun?.checkpointSummary,
      record.checkpointSummary,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeHttpServer(rsServer);
    await closeServer(server);
  }
});

test('scheduler preserves terminal counter mismatch failures from runConnector results', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-terminal-counter-mismatch-test',
    version: '1.0.0',
    display_name: 'Scheduler Terminal Counter Mismatch Test Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-terminal-counter-mismatch-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_terminal_counter_mismatch',
    data: { id: 'scheduler_terminal_counter_mismatch', value: 'before mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'scheduler_terminal_counter_mismatch_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_terminal_counter_mismatch_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {
        throw new Error('setState should not be called when terminal counter validation fails');
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.recordsEmitted, 1);
    assert.equal(record.reportedRecordsEmitted, 2);
    assert.equal(record.failureReason, 'connector_protocol_violation');
    assert.equal(record.terminalReason, 'connector_protocol_violation');
    assert.equal(record.connectorError, null);
    assert.match(record.error || '', /Connector reported records_emitted 2 but runtime observed 1/);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'not_committed',
      records_flushed: 1,
      buffered_records_dropped: 0,
      state_streams_staged: 1,
      state_streams_committed: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.failureReason, record.failureReason);
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].failed, 1);
    assert.equal(stats[manifest.connector_id].lastRun?.recordsEmitted, 1);
    assert.equal(stats[manifest.connector_id].lastRun?.reportedRecordsEmitted, 2);
    assert.equal(stats[manifest.connector_id].lastRun?.failureReason, 'connector_protocol_violation');
    assert.equal(stats[manifest.connector_id].lastRun?.terminalReason, 'connector_protocol_violation');
    assert.deepEqual(
      stats[manifest.connector_id].lastRun?.checkpointSummary,
      record.checkpointSummary,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler preserves connector-declared terminal error details from failed runs', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-terminal-error-test',
    version: '1.0.0',
    display_name: 'Scheduler Terminal Error Test Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-terminal-error-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_terminal_error',
    data: { id: 'scheduler_terminal_error', value: 'before failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 1,
    error: { message: 'Remote provider rate limit', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_terminal_error_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, 'connector_reported_failed');
    assert.deepEqual(record.connectorError, {
      message: 'Remote provider rate limit',
      retryable: true,
    });
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'not_committed',
      records_flushed: 0,
      buffered_records_dropped: 1,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.connectorError, record.connectorError);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].lastRun?.terminalReason, 'connector_reported_failed');
    assert.deepEqual(stats[manifest.connector_id].lastRun?.connectorError, {
      message: 'Remote provider rate limit',
      retryable: true,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler preserves known gaps from partial connector runs', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-known-gap-test',
    version: '1.0.0',
    display_name: 'Scheduler Known Gap Test Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-known-gap-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'items',
    reason: 'http_429',
    message: 'provider returned 429',
    resource_ids: ['item_1'],
  }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_known_gap_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'succeeded');
    assert.equal(record.knownGaps.length, 1);
    assert.equal(record.knownGaps[0].kind, 'skip_result');
    assert.equal(record.knownGaps[0].recovery_hint.action, 'retry_by_runtime');
    assert.deepEqual(record.knownGaps[0].scope.resource_ids, ['item_1']);

    const stats = scheduler.getStats();
    assert.deepEqual(stats[manifest.connector_id].lastRun?.knownGaps, record.knownGaps);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler preserves connector-declared terminal error details from cancelled runs', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-cancelled-terminal-error-test',
    version: '1.0.0',
    display_name: 'Scheduler Cancelled Terminal Error Test Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-cancelled-terminal-error-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_cancelled_terminal_error',
    data: { id: 'scheduler_cancelled_terminal_error', value: 'before cancellation' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'cancelled',
    records_emitted: 1,
    error: { message: 'User denied follow-up verification', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_cancelled_terminal_error_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, 'connector_reported_cancelled');
    assert.deepEqual(record.connectorError, {
      message: 'User denied follow-up verification',
      retryable: false,
    });
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'not_committed',
      records_flushed: 0,
      buffered_records_dropped: 1,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.connectorError, record.connectorError);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].lastRun?.terminalReason, 'connector_reported_cancelled');
    assert.deepEqual(stats[manifest.connector_id].lastRun?.connectorError, {
      message: 'User denied follow-up verification',
      retryable: false,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler does not retry deterministic connector protocol violations', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-no-retry-protocol-violation',
    version: '1.0.0',
    display_name: 'Scheduler No Retry Protocol Violation Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-no-retry-protocol-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';
const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'wrong_items',
    key: 'protocol_violation',
    data: { id: 'protocol_violation' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_no_retry_protocol_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, 'connector_protocol_violation');
    assert.equal(record.terminalReason, 'connector_protocol_violation');
    assert.match(record.error || '', /Connector emitted RECORD for undeclared stream/);

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 1, 'protocol violations should not be retried by the scheduler');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler retries connector-declared retryable failures and records the succeeding attempt', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-retryable-terminal-error',
    version: '1.0.0',
    display_name: 'Scheduler Retryable Terminal Error Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-retryable-terminal-error-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'readline';
const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  if (attempts === 1) {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'failed',
      records_emitted: 0,
      error: { message: 'Rate limited, retry later', retryable: true },
    }) + '\\n');
    rl.close();
    process.exit(1);
    return;
  }

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'retry_success',
    data: { id: 'retry_success', value: 'after retry' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_retryable_terminal_error_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 8000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'succeeded');
    assert.equal(record.attempt, 2);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.equal(record.recordsEmitted, 1);

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 2, 'retryable terminal failures should be retried once before succeeding');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler does not retry connector-declared non-retryable failures', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-nonretryable-terminal-error',
    version: '1.0.0',
    display_name: 'Scheduler Nonretryable Terminal Error Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-nonretryable-terminal-error-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';
const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 0,
    error: { message: 'Credentials revoked', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_nonretryable_terminal_error_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, 'connector_reported_failed');
    assert.deepEqual(record.connectorError, {
      message: 'Credentials revoked',
      retryable: false,
    });

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 1, 'explicitly non-retryable connector failures should not be retried');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler does not retry runtime authentication failures from ingest', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-authentication-error',
    version: '1.0.0',
    display_name: 'Scheduler Authentication Error Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-authentication-error-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_authentication_error',
    data: { id: 'scheduler_authentication_error', value: 'before auth failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

  const completedRuns = [];
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Invalid or expired token',
          },
        }));
        return;
      }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await new Promise((resolve) => rsServer.listen(0, resolve));
    const rsPort = rsServer.address().port;
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken: 'invalid_owner_token',
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, 'authentication_error');
    assert.equal(record.terminalReason, 'authentication_error');
    assert.equal(record.connectorError, null);
    assert.match(record.error || '', /Ingest failed for items: 401/);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'not_committed',
      records_flushed: 0,
      buffered_records_dropped: 1,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.failureReason, 'authentication_error');
    assert.equal(historyRecord.terminalReason, 'authentication_error');
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].failed, 1);
    assert.equal(stats[manifest.connector_id].lastRun?.failureReason, 'authentication_error');
    assert.equal(stats[manifest.connector_id].lastRun?.terminalReason, 'authentication_error');
    assert.deepEqual(stats[manifest.connector_id].lastRun?.checkpointSummary, record.checkpointSummary);

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 1, 'runtime authentication failures should not be retried');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeHttpServer(rsServer);
  }
});

test('scheduler does not retry runtime permission failures from state persistence', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-permission-error',
    version: '1.0.0',
    display_name: 'Scheduler Permission Error Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-permission-error-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_permission_error',
    data: { id: 'scheduler_permission_error', value: 'before permission failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'permission_error_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

  const completedRuns = [];
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
      return;
    }

      if (req.method === 'PUT' && url.pathname === `/v1/state/${encodeURIComponent(manifest.connector_id)}`) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Owner token required',
          },
        }));
        return;
      }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await new Promise((resolve) => rsServer.listen(0, resolve));
    const rsPort = rsServer.address().port;
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken: 'client_token_instead_of_owner',
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, 'permission_error');
    assert.equal(record.terminalReason, 'permission_error');
    assert.equal(record.connectorError, null);
    assert.match(record.error || '', /State persistence failed for items: 403/);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'not_committed',
      records_flushed: 1,
      buffered_records_dropped: 0,
      state_streams_staged: 1,
      state_streams_committed: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.failureReason, 'permission_error');
    assert.equal(historyRecord.terminalReason, 'permission_error');
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].failed, 1);
    assert.equal(stats[manifest.connector_id].lastRun?.failureReason, 'permission_error');
    assert.equal(stats[manifest.connector_id].lastRun?.terminalReason, 'permission_error');
    assert.deepEqual(stats[manifest.connector_id].lastRun?.checkpointSummary, record.checkpointSummary);

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 1, 'runtime permission failures should not be retried');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeHttpServer(rsServer);
  }
});

test('scheduler does not retry deterministic runtime connector_invalid failures', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-connector-invalid',
    version: '1.0.0',
    display_name: 'Scheduler Connector Invalid Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-connector-invalid-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_connector_invalid',
    data: { id: 'scheduler_connector_invalid', value: 'before connector invalid' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

  const completedRuns = [];
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'connector_invalid',
          message: 'Connector manifest is malformed',
        },
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await new Promise((resolve) => rsServer.listen(0, resolve));
    const rsPort = rsServer.address().port;
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken: 'owner_token',
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'failed');
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, 'connector_invalid');
    assert.equal(record.terminalReason, 'connector_invalid');
    assert.equal(record.connectorError, null);
    assert.match(record.error || '', /Ingest failed for items: 400/);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'not_committed',
      records_flushed: 0,
      buffered_records_dropped: 1,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.equal(historyRecord.failureReason, 'connector_invalid');
    assert.equal(historyRecord.terminalReason, 'connector_invalid');
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    assert.equal(stats[manifest.connector_id].failed, 1);
    assert.equal(stats[manifest.connector_id].lastRun?.failureReason, 'connector_invalid');
    assert.equal(stats[manifest.connector_id].lastRun?.terminalReason, 'connector_invalid');
    assert.deepEqual(stats[manifest.connector_id].lastRun?.checkpointSummary, record.checkpointSummary);

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 1, 'deterministic runtime connector_invalid failures should not be retried');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeHttpServer(rsServer);
  }
});

test('scheduler retries runtime rate_limit_error failures and records the succeeding attempt', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-rate-limit-error',
    version: '1.0.0',
    display_name: 'Scheduler Rate Limit Error Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-rate-limit-error-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: attempts === 1 ? 'scheduler_rate_limit_retry_1' : 'scheduler_rate_limit_retry_2',
    data: {
      id: attempts === 1 ? 'scheduler_rate_limit_retry_1' : 'scheduler_rate_limit_retry_2',
      value: attempts === 1 ? 'before rate limit' : 'after retry',
    },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

  let ingestAttempts = 0;
  const completedRuns = [];
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
      ingestAttempts += 1;
      if (ingestAttempts === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Too many requests',
          },
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await new Promise((resolve) => rsServer.listen(0, resolve));
    const rsPort = rsServer.address().port;
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken: 'owner_token',
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 8000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'succeeded');
    assert.equal(record.attempt, 2);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'committed',
      records_flushed: 1,
      buffered_records_dropped: 0,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 2, 'runtime rate_limit_error failures should be retried');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeHttpServer(rsServer);
  }
});

test('scheduler retries transient runtime 500 failures and records the succeeding attempt', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-runtime-500-retry',
    version: '1.0.0',
    display_name: 'Scheduler Runtime 500 Retry Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-runtime-500-retry-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const attemptsPath = join(tmpDir, 'attempts.log');
  writeFileSync(connectorPath, `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: attempts === 1 ? 'scheduler_runtime_500_retry_1' : 'scheduler_runtime_500_retry_2',
    data: {
      id: attempts === 1 ? 'scheduler_runtime_500_retry_1' : 'scheduler_runtime_500_retry_2',
      value: attempts === 1 ? 'before transient failure' : 'after retry',
    },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

  let ingestAttempts = 0;
  const completedRuns = [];
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
      ingestAttempts += 1;
      if (ingestAttempts === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporary_upstream_failure' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await new Promise((resolve) => rsServer.listen(0, resolve));
    const rsPort = rsServer.address().port;
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken: 'owner_token',
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 8000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.equal(record.status, 'succeeded');
    assert.equal(record.attempt, 2);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.deepEqual(record.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'committed',
      records_flushed: 1,
      buffered_records_dropped: 0,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 2, 'transient runtime 500 failures should be retried');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeHttpServer(rsServer);
  }
});

test('scheduler treats single_use grants as one successful run followed by exhausted skips without persisting state', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];
  const persistedStates = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_single_use_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest: spotifyManifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
          grantAccessMode: 'single_use',
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => ({ top_artists: { cursor: 'should_not_be_used' } }),
      setState: async (_connectorId, state) => {
        persistedStates.push(state);
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 2, 5000);
    scheduler.stop();

    const [first, second] = completedRuns;
    assert.equal(first.status, 'succeeded');
    assert.equal(first.attempt, 1);
    assert.equal(first.recordsEmitted, 21);
    assert.deepEqual(first.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'disabled',
      records_flushed: 21,
      buffered_records_dropped: 0,
      state_streams_staged: 2,
      state_streams_committed: 0,
    });

    assert.equal(second.status, 'skipped');
    assert.equal(second.attempt, 0);
    assert.equal(second.recordsEmitted, 0);
    assert.equal(second.error, 'single_use grant already consumed');
    assert.equal(second.checkpointSummary, null);
    assert.deepEqual(second.source, {
      kind: 'connector',
      id: spotifyManifest.connector_id,
    });

    assert.deepEqual(persistedStates, [], 'single_use scheduler runs should not persist connector state');

    const history = scheduler.getHistory();
    assert.equal(history.length >= 2, true);
    assert.equal(history[0].status, 'succeeded');
    assert.equal(history[1].status, 'skipped');

    const stats = scheduler.getStats();
    assert.equal(stats[spotifyManifest.connector_id].succeeded, 1);
    assert.equal(stats[spotifyManifest.connector_id].failed, 0);
    assert.equal(stats[spotifyManifest.connector_id].totalRuns >= 2, true);
    assert.equal(stats[spotifyManifest.connector_id].lastRun?.status, 'skipped');
  } finally {
    await closeServer(server);
  }
});

test('scheduler does not start overlapping runs for the same connector while a prior run is active', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-active-run-'));
  const attemptsPath = join(tmpDir, 'attempts.log');
  const connectorPath = join(tmpDir, 'slow-connector.mjs');

  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'succeeded',
      records_emitted: 0,
    }) + '\\n');
    rl.close();
    process.exit(0);
  }, 150);
});
`, 'utf8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_active_run_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          ownerToken,
          intervalMs: 50,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 5000);
    scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 125));

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 1, 'scheduler should not start overlapping runs for the same connector');
    assert.equal(completedRuns.length, 1, 'scheduler should only complete the original active run before stop');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler keeps single_use grants reusable after failed runs until a later success consumes them', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-single-use-retry-'));
  const attemptsPath = join(tmpDir, 'attempts.log');
  const connectorPath = join(tmpDir, 'flaky-single-use-connector.mjs');

  writeFileSync(connectorPath, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function getAttemptCount() {
  try {
    return readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  const attempt = getAttemptCount() + 1;
  appendFileSync(attemptsPath, \`attempt-\${attempt}\\n\`, 'utf8');
  if (attempt === 1) {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'failed',
      records_emitted: 0,
      error: { message: 'Transient upstream failure', retryable: false },
    }) + '\\n');
    rl.close();
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];
  const persistedStates = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_single_use_retry_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          ownerToken,
          intervalMs: 50,
          maxRetries: 0,
          grantAccessMode: 'single_use',
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => ({ top_artists: { cursor: 'should_not_be_used' } }),
      setState: async (_connectorId, state) => {
        persistedStates.push(state);
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 3, 5000);
    scheduler.stop();

    const [first, second, third] = completedRuns;
    assert.equal(first.status, 'failed');
    assert.equal(first.attempt, 1);
    assert.equal(first.terminalReason, 'connector_reported_failed');
    assert.deepEqual(first.connectorError, {
      message: 'Transient upstream failure',
      retryable: false,
    });

    assert.equal(second.status, 'succeeded');
    assert.equal(second.attempt, 1);
    assert.deepEqual(second.checkpointSummary, {
      mode: 'checkpointed_streaming',
      commit_status: 'disabled',
      records_flushed: 0,
      buffered_records_dropped: 0,
      state_streams_staged: 0,
      state_streams_committed: 0,
    });

    assert.equal(third.status, 'skipped');
    assert.equal(third.attempt, 0);
    assert.equal(third.error, 'single_use grant already consumed');

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 2, 'single_use grants should remain usable after a failed run until a later success consumes them');
    assert.deepEqual(persistedStates, [], 'single_use scheduler runs should not persist connector state even across failed-then-successful runs');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler stop prevents retryable failures from launching another attempt after backoff', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-stop-retry-'));
  const attemptsPath = join(tmpDir, 'attempts.log');
  const connectorPath = join(tmpDir, 'retryable-connector.mjs');

  writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 0,
    error: { message: 'Temporary upstream outage', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_stop_retry_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 2,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => {
      try {
        const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
        return attempts.length === 1;
      } catch {
        return false;
      }
    }, 5000);
    scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(attempts.length, 1, 'scheduler stop should prevent retry backoff from launching a second attempt');
    assert.equal(completedRuns.length, 1, 'scheduler should emit a single failed run record when stop cancels further retries');
    assert.equal(completedRuns[0].status, 'failed');
    assert.equal(completedRuns[0].attempt, 1);
    assert.equal(completedRuns[0].terminalReason, 'connector_reported_failed');
    assert.deepEqual(completedRuns[0].connectorError, {
      message: 'Temporary upstream outage',
      retryable: true,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('scheduler start is idempotent and does not launch a second immediate run', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_idempotent_start_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest: spotifyManifest,
          ownerToken,
          intervalMs: 10_000,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 5000);
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    assert.equal(completedRuns.length, 1, 'calling start twice should not trigger a second immediate run or duplicate schedules');
    assert.equal(completedRuns[0].status, 'succeeded');
    assert.equal(completedRuns[0].attempt, 1);
  } finally {
    await closeServer(server);
  }
});

test('scheduler emits one disabled skip after deterministic grant lifecycle failures and then stays quiet', async () => {
  for (const terminalReason of ['grant_invalid', 'grant_revoked', 'grant_expired', 'grant_consumed']) {
    const manifest = {
      protocol_version: '0.1.0',
      connector_id: `https://registry.pdpp.org/connectors/scheduler-${terminalReason}`,
      version: '1.0.0',
      display_name: `Scheduler ${terminalReason} Connector`,
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
          primary_key: ['id'],
        },
      ],
    };
    const tmpDir = mkdtempSync(join(tmpdir(), `pdpp-scheduler-${terminalReason}-`));
    const connectorPath = join(tmpDir, 'connector.mjs');
    const attemptsPath = join(tmpDir, 'attempts.log');

    writeFileSync(connectorPath, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: ${JSON.stringify(`scheduler_${terminalReason}`)},
    data: { id: ${JSON.stringify(`scheduler_${terminalReason}`)}, value: 'before grant lifecycle failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

    const completedRuns = [];
    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: terminalReason,
            message: `${terminalReason} while scheduling`,
          },
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    try {
      await new Promise((resolve) => rsServer.listen(0, resolve));
      const rsPort = rsServer.address().port;
      const scheduler = createScheduler({
        connectors: [
          {
            connectorId: manifest.connector_id,
            connectorPath,
            manifest,
            ownerToken: 'grant_token',
            intervalMs: 50,
            maxRetries: 2,
          },
        ],
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
        onRunComplete: (record) => completedRuns.push(record),
        getState: async () => null,
        setState: async () => {},
      });

      scheduler.start();
      await waitFor(() => completedRuns.length >= 2, 5000);
      await new Promise((resolve) => setTimeout(resolve, 180));
      scheduler.stop();

      const [first, second] = completedRuns;
      assert.equal(first.status, 'failed');
      assert.equal(first.attempt, 1);
      assert.equal(first.failureReason, terminalReason);
      assert.equal(first.terminalReason, terminalReason);
      assert.equal(first.error?.includes('403'), true);

      assert.equal(second.status, 'skipped');
      assert.equal(second.attempt, 0);
      assert.equal(second.terminalReason, terminalReason);
      assert.equal(second.error, `${terminalReason} grant no longer usable`);
      assert.equal(completedRuns.length, 2, `${terminalReason} should emit a single disabled skip before future intervals go quiet`);

      const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(attempts.length, 1, `${terminalReason} should disable future scheduled attempts after the first deterministic failure`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeHttpServer(rsServer);
    }
  }
});

test('scheduler skips automatic run with needs_human_attention when isNeedsHuman returns true', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_nhuman_skip_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest: spotifyManifest,
          ownerToken,
          // Short interval so several ticks fire during the test window.
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
      isNeedsHuman: () => true,
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    // Let several more ticks fire to verify suppression.
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    const [first] = completedRuns;
    assert.equal(first.status, 'skipped');
    assert.equal(first.attempt, 0);
    assert.ok(
      first.error?.startsWith('needs_human_attention:'),
      `expected needs_human_attention skip, got: ${first.error}`,
    );
    assert.equal(
      completedRuns.length,
      1,
      'needs-human skip should be emitted exactly once — subsequent ticks must be suppressed',
    );
  } finally {
    await closeServer(server);
  }
});

test('scheduler records one not-ready skip for automatic runs when runtime prerequisites are absent', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const manifest = {
    ...spotifyManifest,
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-not-ready-test',
  };
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];
  const readinessCalls = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_not_ready_skip_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
      readinessChecker: async () => {
        readinessCalls.push(Date.now());
        return { ready: false, reason: 'missing docker prerequisite for test' };
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    const [first] = completedRuns;
    assert.equal(first.status, 'skipped');
    assert.equal(first.attempt, 0);
    assert.equal(first.error, 'not_ready: missing docker prerequisite for test');
    assert.equal(completedRuns.length, 1, 'stable not-ready skips should be emitted once, not spammed');
    assert.ok(readinessCalls.length > 1, 'scheduler should keep probing readiness on later ticks');
  } finally {
    await closeServer(server);
  }
});

test('scheduler emits a fresh not-ready skip when readiness reason changes', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const manifest = {
    ...spotifyManifest,
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-not-ready-changing-test',
  };
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];
  let readinessCalls = 0;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_not_ready_changing_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
      readinessChecker: async () => {
        readinessCalls += 1;
        return {
          ready: false,
          reason: readinessCalls < 3 ? 'missing prerequisite A' : 'missing prerequisite B',
        };
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 2, 5000);
    scheduler.stop();

    assert.deepEqual(
      completedRuns.map((record) => record.error),
      ['not_ready: missing prerequisite A', 'not_ready: missing prerequisite B'],
    );
  } finally {
    await closeServer(server);
  }
});

test('scheduler default readiness checker skips missing manifest-declared external tools', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const manifest = {
    ...spotifyManifest,
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-missing-tool-test',
    runtime_requirements: {
      bindings: { network: { required: true } },
      external_tools: [
        {
          name: 'definitely-missing-tool',
          license: 'test-only',
          purpose: 'Prove scheduler readiness gating',
          install_hint: 'install definitely-missing-tool',
          detect: { command: 'definitely-missing-tool-pdpp-test --help', exit_code: 0 },
        },
      ],
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-missing-tool-'));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_missing_tool_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    scheduler.stop();

    const [first] = completedRuns;
    assert.equal(first.status, 'skipped');
    assert.match(first.error, /^not_ready: required external tool definitely-missing-tool is not available\./);
    assert.equal(readAttempts(attemptsPath).length, 0, 'not-ready scheduler runs must not spawn the connector');
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scheduler default readiness checker probes SLACKDUMP_BIN with version despite stale manifest command', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const manifest = {
    ...spotifyManifest,
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-slackdump-bin-test',
    runtime_requirements: {
      bindings: { network: { required: true } },
      external_tools: [
        {
          name: 'slackdump',
          license: 'AGPL-3.0',
          purpose: 'Session-token Slack archive export',
          install_hint: 'mount slackdump and set SLACKDUMP_BIN',
          detect: { command: 'slackdump stale-detect-command', exit_code: 0 },
        },
      ],
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-slackdump-bin-'));
  const fakeSlackdumpPath = join(tmpDir, 'mounted-slackdump');
  writeFileSync(fakeSlackdumpPath, '#!/bin/sh\n[ "$1" = "version" ] || exit 2\nexit 0\n', 'utf8');
  chmodSync(fakeSlackdumpPath, 0o755);
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const previousSlackdumpBin = process.env.SLACKDUMP_BIN;
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    process.env.SLACKDUMP_BIN = fakeSlackdumpPath;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_slackdump_bin_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 60_000,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => readAttempts(attemptsPath).length === 1, 5000);
    scheduler.stop();
  } finally {
    if (previousSlackdumpBin === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = previousSlackdumpBin;
    }
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scheduler default readiness checker does not treat browser bindings as ready by default', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const manifest = {
    ...spotifyManifest,
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-browser-not-ready-test',
    runtime_requirements: {
      bindings: { browser: { required: true }, network: { required: true } },
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-browser-not-ready-'));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const previousRemoteCdp = process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
  const previousUnmanagedOptIn = process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  try {
    delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_browser_not_ready_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    scheduler.stop();

    const [first] = completedRuns;
    assert.equal(first.status, 'skipped');
    assert.equal(first.error, 'not_ready: required browser runtime is not configured for unattended scheduled runs');
    assert.equal(readAttempts(attemptsPath).length, 0);
  } finally {
    if (previousRemoteCdp === undefined) {
      delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    } else {
      process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL = previousRemoteCdp;
    }
    if (previousUnmanagedOptIn === undefined) {
      delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    } else {
      process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES = previousUnmanagedOptIn;
    }
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scheduler marks connector as needs-human when automatic run triggers interaction', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-interaction-test',
    version: '1.0.0',
    display_name: 'Interaction Test Connector',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
  };

  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scheduler-interaction-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  // Connector that emits one INTERACTION then exits after response.
  writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    process.exit(0);
  }
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'req_1',
    kind: 'otp',
    message: 'Enter OTP',
  }) + '\\n');
});
`, 'utf-8');

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];
  const interactions = [];
  const markedConnectors = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_interaction_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath,
          manifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => {
        interactions.push(interaction);
        return cancelledInteractionResponse(interaction);
      },
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
      markNeedsHuman: (connectorId) => markedConnectors.push(connectorId),
      isNeedsHuman: (connectorId) => markedConnectors.includes(connectorId),
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 2, 8000);
    scheduler.stop();

    assert.ok(
      markedConnectors.includes(manifest.connector_id),
      'markNeedsHuman should be called when an automatic run triggers an interaction',
    );
    const [interactionRun, needsHumanSkip] = completedRuns;
    assert.equal(interactionRun?.status, 'succeeded');
    assert.notEqual(interactionRun?.terminalReason, 'interaction_handler_invalid_response');
    assert.equal(interactions[0]?.connector_id, manifest.connector_id);
    assert.equal(interactions[0]?.connector_display_name, manifest.display_name);
    assert.equal(interactions[0]?.run_id, interactionRun?.runId);
    assert.equal(needsHumanSkip?.status, 'skipped');
    assert.ok(needsHumanSkip?.error?.startsWith('needs_human_attention:'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

// ─── Regression: 1970 next_attempt_at on back-off skips ─────────────────────
//
// Symptom from production probe: Reddit `scheduler_backoff_applied` skip
// rows surfaced `next attempt at 1970-01-02T00:00:00.000Z`. Cause: hydrated
// history contained 3+ same-class failures, but `scheduler_last_run_times`
// had no row for the connector (separate write; can drop on process crash
// or older runtime). `evaluateBackoffDispatch` then computed
// `nextRunAt = 0 + effectiveIntervalMs`, surfacing an epoch-derived
// timestamp. Fix derives `lastRun` from the newest history record when
// the last-run map is empty, and the skip-message formatter substitutes
// safe phrasing if the resolved timestamp is still epoch-suspicious.
test('scheduler backoff skip derives next_attempt_at from history when last_run_time is missing', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const manifest = {
    ...spotifyManifest,
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-backoff-1970-regression',
  };
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  const recentEpochMs = Date.now() - 60_000;
  const historyRecords = [];
  for (let i = 0; i < 4; i++) {
    const startedAtMs = recentEpochMs + i * 1000;
    historyRecords.push({
      connectorId: manifest.connector_id,
      source: { kind: 'connector', id: manifest.connector_id },
      status: 'failed',
      recordsEmitted: 0,
      reportedRecordsEmitted: null,
      checkpointSummary: null,
      knownGaps: [],
      connectorError: { reason: 'reddit_login_unexpected_ui' },
      runId: null,
      traceId: null,
      failureReason: null,
      terminalReason: null,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(startedAtMs + 500).toISOString(),
      attempt: 1,
    });
  }

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_backoff_1970_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
      readinessChecker: async () => ({ ready: false, reason: 'simulated unattended gate' }),
      schedulerStore: {
        appendRunHistory: async () => {},
        listLastRunTimes: async () => [],
        listRunHistory: async () => historyRecords,
        upsertLastRunTime: async () => {},
      },
    });

    scheduler.start();
    await waitFor(
      () => completedRuns.some((r) => r.error?.startsWith('scheduler_backoff_applied:')),
      5000,
    );
    scheduler.stop();

    const backoffSkip = completedRuns.find((r) => r.error?.startsWith('scheduler_backoff_applied:'));
    assert.ok(backoffSkip, 'expected a scheduler_backoff_applied skip event');
    assert.equal(backoffSkip.status, 'skipped');
    assert.doesNotMatch(
      backoffSkip.error,
      /1970/,
      `backoff skip must never reference 1970 epoch; got: ${backoffSkip.error}`,
    );
    const nextAttemptMatch = backoffSkip.error.match(/next attempt at (.+)$/);
    assert.ok(nextAttemptMatch, `expected explicit next-attempt phrase, got: ${backoffSkip.error}`);
    const nextAttemptPhrase = nextAttemptMatch[1];
    if (/^\d{4}-/.test(nextAttemptPhrase)) {
      const parsed = Date.parse(nextAttemptPhrase);
      assert.ok(Number.isFinite(parsed), `parseable ISO timestamp, got: ${nextAttemptPhrase}`);
      assert.ok(
        parsed >= recentEpochMs,
        `next_attempt_at should be at or after the most recent failure (${new Date(recentEpochMs).toISOString()}); got: ${nextAttemptPhrase}`,
      );
    } else {
      // Acceptable alternate: explicit safe phrasing when no anchor is
      // available. Should not be hit with history present.
      assert.match(nextAttemptPhrase, /unknown|not scheduled/);
    }
  } finally {
    await closeServer(server);
  }
});

// ─── Regression: blocked-state backoff skip messaging ───────────────────────
//
// When a streak crosses the BLOCKED_PROMOTION_THRESHOLD, the scheduler
// suppresses auto-dispatch entirely. A timestamp in the skip message is
// then misleading — no retry is planned. Verify the skip uses explicit
// `gave_up` phrasing instead, and a one-shot `schedule.gave_up` event
// fires.
test('scheduler backoff skip uses gave_up phrasing once health-state crosses blocked threshold', async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const manifest = {
    ...spotifyManifest,
    connector_id: 'https://registry.pdpp.org/connectors/scheduler-backoff-blocked-msg',
  };
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns = [];

  const recentEpochMs = Date.now() - 60_000;
  const historyRecords = [];
  for (let i = 0; i < 20; i++) {
    const startedAtMs = recentEpochMs + i * 1000;
    historyRecords.push({
      connectorId: manifest.connector_id,
      source: { kind: 'connector', id: manifest.connector_id },
      status: 'failed',
      recordsEmitted: 0,
      reportedRecordsEmitted: null,
      checkpointSummary: null,
      knownGaps: [],
      connectorError: { reason: 'reddit_login_unexpected_ui' },
      runId: null,
      traceId: null,
      failureReason: null,
      terminalReason: null,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(startedAtMs + 500).toISOString(),
      attempt: 1,
    });
  }

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, 'scheduler_backoff_blocked_msg_user');
    const scheduler = createScheduler({
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
          manifest,
          ownerToken,
          intervalMs: 25,
          maxRetries: 0,
        },
      ],
      rsUrl,
      onInteraction: async (interaction) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      getState: async () => null,
      setState: async () => {},
      readinessChecker: async () => ({ ready: false, reason: 'simulated unattended gate' }),
      schedulerStore: {
        appendRunHistory: async () => {},
        listLastRunTimes: async () => [],
        listRunHistory: async () => historyRecords,
        upsertLastRunTime: async () => {},
      },
    });

    scheduler.start();
    await waitFor(
      () => completedRuns.some((r) => r.error?.startsWith('scheduler_backoff_applied:')),
      5000,
    );
    scheduler.stop();

    const backoffSkip = completedRuns.find((r) => r.error?.startsWith('scheduler_backoff_applied:'));
    assert.ok(backoffSkip, 'expected a scheduler_backoff_applied skip event');
    assert.doesNotMatch(backoffSkip.error, /1970/);
    assert.match(
      backoffSkip.error,
      /not scheduled \(gave_up/,
      `blocked-state skip should say gave_up, not a misleading retry time. got: ${backoffSkip.error}`,
    );

    const gaveUpEvent = completedRuns.find((r) => r.error?.startsWith('schedule.gave_up:'));
    assert.ok(gaveUpEvent, 'expected a one-shot schedule.gave_up spine event');
  } finally {
    await closeServer(server);
  }
});

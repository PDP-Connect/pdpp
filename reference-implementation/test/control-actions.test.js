/**
 * Control-plane operator/control action tests.
 *
 * Exercises the /_ref operator surfaces added in W3:
 *
 *   - GET /_ref/connectors                         (read-only summary feed)
 *   - GET /_ref/connectors/:connectorId            (manifest excerpt + stream summaries)
 *
 * Mutation endpoints (run, schedule upsert/pause/resume/delete, approvals,
 * records timeline) will land as later W3 sub-steps; they require a typed
 * runtime controller and schedule persistence that are not in this slice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import { resolveDefaultConnectorPath } from '../runtime/controller.ts';
import { createTraceContext, emitSpineEvent } from '../lib/spine.ts';
import { validateRequest, listOperations } from '@pdpp/reference-contract';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const POLYFILL_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors', 'manifests');

// The connector catalog, run summaries, and schedule rows are all keyed by the
// canonical connector key (Decision 1): registering the URL-shaped manifest
// connector_id stores and projects it as `spotify`. Output assertions compare
// against this canonical key; request inputs may still carry the URL shape
// because the server canonicalizes connector ids at the boundary.
const SPOTIFY_CONNECTOR_KEY = canonicalConnectorKey('spotify');

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.('test shutdown');
  await Promise.resolve(server.startupBackfillDone).catch(() => {});
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ...(arguments[1] || {}),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201, 'register connector');
    await fn({ server, asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function waitForRunTerminal(asUrl, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    if (status === 200 && Array.isArray(body.data)) {
      const terminal = body.data.find((event) =>
        event.event_type === 'run.completed' || event.event_type === 'run.failed'
      );
      if (terminal) {
        return body;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function registerConnector(asUrl, manifest) {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(registerResp.status, 201, 'register connector');
}

async function emitSyntheticRun({
  connectorId: rawConnectorId,
  runId,
  status,
  occurredAt,
  knownGaps = [],
  source: rawSource = null,
}) {
  // The live runtime launches runs under the canonical connector key and emits
  // run.* spine events with source.id = that canonical key. Connector-summary
  // correlation (last_run / last_successful_run) queries run history by the
  // canonical key, so a synthetic run must use it too or it correlates to
  // nothing. Canonicalize the (possibly URL-shaped) test connectorId here. See
  // canonicalize-connector-keys Decision 1.
  const connectorId = canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  const source = rawSource ?? { kind: 'connector', id: connectorId };
  const trace = createTraceContext({ scenarioId: `scn_${runId}` });
  // The spine-layer enforcement requires every run.started to carry
  // boot_epoch+seq. Synthetic-run fixtures use the harness's current
  // boot epoch (startServer initializes it). See
  // docs/run-reconciliation-design-brief.md §3.3.
  const { getCurrentBootEpoch } = await import('../lib/spine.ts');
  const _epoch = getCurrentBootEpoch();
  if (!_epoch) {
    throw new Error('emitSyntheticRun: no boot epoch — harness/startServer must run first');
  }
  await emitSpineEvent({
    event_type: 'run.started',
    occurred_at: occurredAt,
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    actor_type: 'runtime',
    actor_id: connectorId,
    object_type: 'run',
    object_id: runId,
    status: 'started',
    run_id: runId,
    source_kind: source.kind,
    source_id: source.id,
    data: {
      source,
      collection_mode: 'incremental',
      persist_state: true,
      state_commit_intent: 'commit_on_success',
      bindings: { network: {}, filesystem: {}, interactive: {} },
      scope: { streams: [{ name: 'top_artists' }] },
      scope_streams: ['top_artists'],
      boot_epoch: _epoch.boot_epoch,
      seq: _epoch.seq,
      controller_id: _epoch.controller_id,
    },
  });
  await emitSpineEvent({
    event_type: status === 'succeeded' ? 'run.completed' : 'run.failed',
    occurred_at: occurredAt,
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    actor_type: 'runtime',
    actor_id: connectorId,
    object_type: 'run',
    object_id: runId,
    status,
    run_id: runId,
    source_kind: source.kind,
    source_id: source.id,
    data: {
      source,
      records_emitted: 0,
      records_flushed: 0,
      buffered_records_dropped: 0,
      persist_state: true,
      checkpoint_mode: 'checkpointed_streaming',
      checkpoint_commit_status: 'not_committed',
      state_streams_staged: 0,
      state_streams_committed: 0,
      ...(knownGaps.length ? { known_gaps: knownGaps } : {}),
      ...(status === 'failed' ? { reason: 'synthetic_failure' } : {}),
    },
  });
}

test('GET /_ref/connectors lists registered connectors with stream names and freshness', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    const entry = body.data.find((c) => c.connector_id === SPOTIFY_CONNECTOR_KEY);
    assert.ok(entry, 'spotify connector should be listed');
    assert.equal(entry.display_name, 'Spotify');
    assert.ok(entry.streams.includes('top_artists'));
    assert.equal(entry.total_records, 0);
    assert.ok(entry.freshness, 'freshness is always present');
    assert.equal(entry.freshness.status, 'unknown');
    assert.equal(entry.schedule, null);
    assert.equal(entry.last_run, null);
    assert.equal(entry.last_successful_run, null);
  });
});

test('GET /_ref/connectors finds connector runs that are older than newer runs from other connectors', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const connectorId = spotifyManifest.connector_id;
    await emitSyntheticRun({
      connectorId,
      runId: 'run_spotify_older_success',
      status: 'succeeded',
      occurredAt: '2026-04-24T10:00:00.000Z',
    });
    for (let i = 0; i < 8; i += 1) {
      await emitSyntheticRun({
        connectorId: `noisy-${i}`,
        runId: `run_noisy_${i}`,
        status: 'failed',
        occurredAt: `2026-04-24T10:0${i + 1}:00.000Z`,
      });
    }

    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors`);
    assert.equal(status, 200);
    const entry = body.data.find((row) => row.connector_id === SPOTIFY_CONNECTOR_KEY);
    assert.ok(entry, 'spotify connector should be listed');
    assert.equal(entry.last_run?.run_id, 'run_spotify_older_success');
    assert.equal(entry.last_run?.status, 'succeeded');
    assert.equal(entry.last_successful_run?.run_id, 'run_spotify_older_success');
  });
});

test('GET /_ref/connectors projects known gaps from the latest run summary', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const connectorId = spotifyManifest.connector_id;
    const knownGaps = [
      {
        kind: 'skip_result',
        stream: 'top_artists',
        reason: 'http_429',
        recovery_hint: { action: 'retry_by_runtime', retryable: true },
      },
    ];
    await emitSyntheticRun({
      connectorId,
      runId: 'run_spotify_known_gap',
      status: 'succeeded',
      occurredAt: '2026-04-24T10:00:00.000Z',
      knownGaps,
    });

    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors`);
    assert.equal(status, 200);
    const entry = body.data.find((row) => row.connector_id === SPOTIFY_CONNECTOR_KEY);
    assert.ok(entry, 'spotify connector should be listed');
    assert.equal(entry.last_run?.run_id, 'run_spotify_known_gap');
    assert.deepEqual(entry.last_run?.known_gaps, knownGaps);
  });
});

test('GET /_ref/connectors/:connectorId returns manifest excerpt and stream summaries', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const url = `${asUrl}/_ref/connectors/${encodeURIComponent(spotifyManifest.connector_id)}`;
    const { status, body } = await fetchJson(url);
    assert.equal(status, 200);
    assert.equal(body.object, 'ref_connector_detail');
    assert.equal(body.connector_id, spotifyManifest.connector_id);
    assert.equal(body.display_name, 'Spotify');
    assert.ok(body.manifest_excerpt, 'manifest excerpt present');
    assert.ok(Array.isArray(body.streams));
    assert.ok(body.streams.some((s) => s.name === 'top_artists'));
  });
});

test('contract package validator loads and knows every /_ref operation', () => {
  const ops = listOperations();
  const ids = new Set(ops.map((o) => o.id));
  // Spot-check: schedule upsert and connectors listing must exist in the manifest set.
  assert.ok(ids.has('refPutConnectorSchedule'), 'refPutConnectorSchedule missing from contract manifests');
  assert.ok(ids.has('refListConnectors'), 'refListConnectors missing from contract manifests');
  assert.ok(ids.has('listRecords'), 'listRecords missing from contract manifests');

  // Valid schedule body passes validation.
  const good = validateRequest('refPutConnectorSchedule', {
    params: { connectorId: 'anything' },
    body: { interval_seconds: 300, enabled: true },
  });
  assert.deepEqual(good, { ok: true });

  // Body missing required interval_seconds fails with an error that points at
  // the missing field.
  const bad = validateRequest('refPutConnectorSchedule', {
    params: { connectorId: 'anything' },
    body: { enabled: true },
  });
  assert.equal(bad.ok, false);
  assert.ok(Array.isArray(bad.errors));
  assert.ok(bad.errors.some((e) => /interval_seconds/.test(e.message || e.instancePath || '')));
});

test('GET /_ref/connectors projects schedule when one is configured', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const cid = spotifyManifest.connector_id;
    const put = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 900 }),
    });
    assert.equal(put.status, 200);
    const { body } = await fetchJson(`${asUrl}/_ref/connectors`);
    const entry = body.data.find((c) => c.connector_id === SPOTIFY_CONNECTOR_KEY);
    assert.ok(entry);
    assert.ok(entry.schedule, 'schedule should be projected when configured');
    assert.equal(entry.schedule.interval_seconds, 900);
    assert.equal(entry.schedule.enabled, true);
    assert.equal(entry.schedule.trigger_kind, 'scheduled');
    assert.equal(entry.schedule.automation_mode, 'unattended');
  });
});

test('GET /_ref/connectors/:connectorId returns 404 for unknown connector', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors/nonexistent`);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  });
});

test('GET /_ref/records/timeline returns empty list with boundedness metadata when no records', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/records/timeline`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, []);
    assert.ok(body.meta);
    assert.equal(body.meta.bounded, true);
    assert.equal(body.meta.ordering, 'semantic_or_emitted desc');
    assert.equal(body.meta.limit, 50);
    assert.equal(body.meta.timestamp_mode, 'native');
  });
});

test('GET /_ref/records/timeline honors limit and filters records by stream', async () => {
  // Seed records directly via the owner device token path.
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  try {
    await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    // Owner device auth to obtain an owner token for ingest.
    const clientId = 'cli_longview';
    const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId }).toString(),
    });
    await fetch(`${asUrl}/device/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: device.user_code, subject_id: 'owner_local' }).toString(),
    });
    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: clientId,
      }).toString(),
    });
    const ownerToken = tokenBody.access_token;

    const rows = [
      {
        id: 'a1',
        name: 'A1',
        source_updated_at: '2026-04-01T00:00:00Z',
        emitted_at: '2026-04-10T00:00:00Z',
      },
      {
        id: 'a2',
        name: 'A2',
        source_updated_at: '2026-04-02T00:00:00Z',
        emitted_at: '2026-04-11T00:00:00Z',
      },
      {
        id: 'a3',
        name: 'A3',
        source_updated_at: '2026-04-03T00:00:00Z',
        emitted_at: '2026-04-12T00:00:00Z',
      },
    ];
    const lines = rows
      .map((r) => JSON.stringify({
        key: r.id,
        data: {
          id: r.id,
          name: r.name,
          source_updated_at: r.source_updated_at,
        },
        emitted_at: r.emitted_at,
      }))
      .join('\n');

    await fetch(`${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/x-ndjson' },
      body: lines,
    });

    const { body: all } = await fetchJson(`${asUrl}/_ref/records/timeline?limit=2`);
    assert.equal(all.data.length, 2, 'limit applied');
    assert.equal(all.data[0].id, 'a3', 'newest first');
    assert.equal(all.data[1].id, 'a2');
    assert.deepEqual(all.data[0].semantic_timestamp, {
      field: 'source_updated_at',
      value: '2026-04-03T00:00:00Z',
    });
    assert.equal(all.data[0].display_timestamp, '2026-04-03T00:00:00Z');

    const { body: nativeWindow } = await fetchJson(
      `${asUrl}/_ref/records/timeline?since=2026-04-02&until=2026-04-03`,
    );
    assert.deepEqual(
      nativeWindow.data.map((entry) => entry.id),
      ['a3', 'a2'],
      'native date window should apply to semantic timestamps',
    );

    const { body: streamFiltered } = await fetchJson(`${asUrl}/_ref/records/timeline?stream=saved_tracks`);
    assert.deepEqual(streamFiltered.data, [], 'stream filter excludes wrong streams');

    // Records are keyed by the canonical connector key, and the timeline
    // connector_id filter matches against that stored key. (Unlike the
    // /_ref/connections + admission routes, the timeline filter does not
    // canonicalize a URL-shaped query value — see owner-review note in the
    // workstream report.)
    const { body: connFiltered } = await fetchJson(`${asUrl}/_ref/records/timeline?connector_id=${encodeURIComponent(SPOTIFY_CONNECTOR_KEY)}`);
    assert.equal(connFiltered.data.length, 3);
  } finally {
    await closeServer(server);
  }
});

test('GET /_ref/approvals returns an empty list when nothing is pending', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/approvals`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, []);
  });
});

test('POST /_ref/connectors/:connectorId/run starts an async background run and projects it onto connector summaries', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const cid = spotifyManifest.connector_id;
    const runResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/run`, {
      method: 'POST',
    });
    assert.equal(runResp.status, 202);
    const started = await runResp.json();
    assert.ok(started.run_id?.startsWith('run_'));
    assert.ok(started.trace_id?.startsWith('trc_'));
    assert.equal(started.trigger_kind, 'manual');
    assert.equal(typeof started.automation_summary, 'string');
    assert.match(started.automation_mode, /^(assisted|manual_only|unattended)$/);

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const completed = (timeline.data || []).find((event) => event.event_type === 'run.completed');
    assert.ok(completed, 'manual run should complete in the background');

    const { body: connectors } = await fetchJson(`${asUrl}/_ref/connectors`);
    const entry = connectors.data.find((row) => row.connector_id === SPOTIFY_CONNECTOR_KEY);
    assert.ok(entry, 'connector should still be listed');
    assert.ok(entry.last_run, 'manual run should project onto connector summaries');
    assert.equal(entry.last_run.run_id, started.run_id);
    assert.ok(entry.last_successful_run, 'successful run should project onto connector summaries');
    assert.equal(entry.last_successful_run.run_id, started.run_id);
  });
});

test('runtime controller resolves shipped polyfill connectors from TypeScript entrypoints', () => {
  const ynabManifest = JSON.parse(
    readFileSync(join(POLYFILL_MANIFESTS_DIR, 'ynab.json'), 'utf8'),
  );
  const connectorPath = resolveDefaultConnectorPath(ynabManifest.connector_id);
  assert.ok(connectorPath, 'ynab should resolve to a runnable local connector path');
  assert.match(connectorPath, /packages\/polyfill-connectors\/connectors\/ynab\/index\.ts$/);
});

test('POST /_ref/connectors/:connectorId/run returns 409 when the connector already has an active run', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-run-now-'));
  const slowConnectorPath = join(tmpDir, 'slow-connector.mjs');
  writeFileSync(slowConnectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.once('line', () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    process.exit(0);
  }, 300);
});
  `, 'utf8');

  try {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const cid = spotifyManifest.connector_id;
      const firstResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/run`, {
        method: 'POST',
      });
      assert.equal(firstResp.status, 202);
      const first = await firstResp.json();

      const secondResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/run`, {
        method: 'POST',
      });
      assert.equal(secondResp.status, 409);
      const second = await secondResp.json();
      assert.equal(second.error.code, 'run_already_active');
      assert.match(second.error.message, new RegExp(first.run_id));

      await waitForRunTerminal(asUrl, first.run_id);
    }, {
      connectorPathResolver: () => slowConnectorPath,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('controller startup reconciles abandoned controller-managed runs after restart', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-controller-restart-'));
  const dbPath = join(tempDir, 'reference.sqlite');
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  // The connector instance, controller_active_runs rows, and run.* spine
  // events are all keyed by the canonical connector key (Decision 1), so the
  // seeded abandoned-run state and the reconciler correlate on the same key.
  const connectorId = canonicalConnectorKey(spotifyManifest.connector_id) ?? spotifyManifest.connector_id;
  const runId = 'run_controller_restart_orphan';
  let server = null;

  try {
    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
    });
    await registerConnector(`http://localhost:${server.asPort}`, spotifyManifest);
    await closeServer(server);
    closeDb();

    await initDb(dbPath);
    const db = getDb();
    const trace = createTraceContext({ scenarioId: 'scn_controller_restart_orphan' });
    const startedAt = '2026-04-24T09:00:00.000Z';

    db.prepare(`
      INSERT INTO controller_active_runs(connector_id, run_id, trace_id, scenario_id, started_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(connectorId, runId, trace.trace_id, trace.scenario_id, startedAt);

    await emitSpineEvent({
      event_type: 'run.started',
      trace_id: trace.trace_id,
      scenario_id: trace.scenario_id,
      actor_type: 'runtime',
      actor_id: connectorId,
      object_type: 'run',
      object_id: runId,
      status: 'started',
      run_id: runId,
      source_kind: 'connector',
      source_id: connectorId,
      data: {
        source: { kind: 'connector', id: connectorId },
        collection_mode: 'incremental',
        persist_state: true,
        state_commit_intent: 'commit_on_success',
        bindings: { network: {}, filesystem: {}, interactive: {} },
        scope: { streams: [{ name: 'top_tracks' }] },
        scope_streams: ['top_tracks'],
        // Synthetic "prior incarnation" stamp — this test seeds the
        // pre-crash state of an abandoned run. The boot-epoch fields
        // satisfy the spine-layer stamping requirement; their *value*
        // doesn't matter for this test (it exercises the older
        // scheduler_run_history reconciler, not the boot-epoch one).
        boot_epoch: 'prior-incarnation-epoch',
        seq: 1,
        controller_id: 'prior-incarnation',
      },
    }, db);
    await emitSpineEvent({
      event_type: 'run.interaction_required',
      trace_id: trace.trace_id,
      scenario_id: trace.scenario_id,
      actor_type: 'runtime',
      actor_id: connectorId,
      object_type: 'run',
      object_id: runId,
      status: 'started',
      run_id: runId,
      interaction_id: 'int_restart_orphan',
      source_kind: 'connector',
      source_id: connectorId,
      data: {
        source: { kind: 'connector', id: connectorId },
        kind: 'credentials',
        stream: null,
        message: 'Need a token',
        schema: {
          type: 'object',
          properties: {
            api_token: { type: 'string', format: 'password' },
          },
          required: ['api_token'],
        },
        timeout_seconds: 1800,
      },
    }, db);
    closeDb();

    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
    });
    const asUrl = `http://localhost:${server.asPort}`;

    const timeline = await waitForRunTerminal(asUrl, runId);
    const failed = timeline.data.find((event) => event.event_type === 'run.failed');
    assert.ok(failed, 'startup reconciliation should append run.failed');
    assert.equal(failed.data?.reason, 'controller_restarted');

    const { body: connectors } = await fetchJson(`${asUrl}/_ref/connectors`);
    const entry = connectors.data.find((row) => row.connector_id === SPOTIFY_CONNECTOR_KEY);
    assert.ok(entry, 'connector should still be listed after restart');
    assert.equal(entry.last_run?.run_id, runId);
    assert.equal(entry.last_run?.status, 'failed');
    assert.equal(entry.last_run?.failure_reason, 'controller_restarted');

    const remainingRows = getDb().prepare('SELECT COUNT(*) AS count FROM controller_active_runs').get();
    assert.equal(remainingRows.count, 0, 'reconciliation should clear stale controller_active_runs rows');

    const rerunResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/run`, {
      method: 'POST',
    });
    assert.equal(rerunResp.status, 202, 'reconciled abandoned run should not leave the connector locked active');
    const rerun = await rerunResp.json();
    await waitForRunTerminal(asUrl, rerun.run_id);
  } finally {
    if (server) {
      await closeServer(server).catch(() => {});
    }
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('schedule lifecycle: upsert → list → pause → resume → delete', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const cid = spotifyManifest.connector_id;

    // Empty initially.
    const { body: initial } = await fetchJson(`${asUrl}/_ref/schedules`);
    assert.deepEqual(initial.data, []);

    // Upsert.
    const putResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 1800, jitter_seconds: 30, enabled: true }),
    });
    assert.equal(putResp.status, 200);
    const upserted = await putResp.json();
    assert.equal(upserted.object, 'schedule');
    assert.equal(upserted.connector_id, SPOTIFY_CONNECTOR_KEY);
    assert.equal(upserted.interval_seconds, 1800);
    assert.equal(upserted.jitter_seconds, 30);
    assert.equal(upserted.enabled, true);
    assert.equal(upserted.trigger_kind, 'scheduled');
    assert.equal(upserted.automation_mode, 'unattended');

    // List shows it.
    const { body: listed } = await fetchJson(`${asUrl}/_ref/schedules`);
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].connector_id, SPOTIFY_CONNECTOR_KEY);

    // Pause.
    const pauseResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/schedule/pause`, {
      method: 'POST',
    });
    assert.equal(pauseResp.status, 200);
    const paused = await pauseResp.json();
    assert.equal(paused.enabled, false);

    // Resume.
    const resumeResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/schedule/resume`, {
      method: 'POST',
    });
    assert.equal(resumeResp.status, 200);
    const resumed = await resumeResp.json();
    assert.equal(resumed.enabled, true);

    // Delete.
    const deleteResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/schedule`, {
      method: 'DELETE',
    });
    assert.equal(deleteResp.status, 204);

    // Gone from list.
    const { body: afterDelete } = await fetchJson(`${asUrl}/_ref/schedules`);
    assert.deepEqual(afterDelete.data, []);

    // Idempotent-ish: deleting again returns 404 rather than succeeding silently.
    const delAgain = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/schedule`, {
      method: 'DELETE',
    });
    assert.equal(delAgain.status, 404);
  });
});

test('schedule upsert rejects bad input', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const cid = spotifyManifest.connector_id;
    const resp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(cid)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: -5 }),
    });
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error.code, 'invalid_request');
  });
});

test('schedule upsert on unknown connector returns 404', async () => {
  await withHarness(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/connectors/does-not-exist/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 60 }),
    });
    assert.equal(resp.status, 404);
  });
});

test('schedule upsert returns policy_warning when interval is below minimum_interval_seconds', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'policy-warning-test',
    version: '1.0.0',
    display_name: 'Policy Warning Test',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
    capabilities: {
      refresh_policy: {
        recommended_mode: 'automatic',
        minimum_interval_seconds: 3600,
        recommended_interval_seconds: 86400,
        interaction_posture: 'credentials',
        rationale: 'API rate limits; high-friction credentials.',
      },
    },
  };

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerConnector(asUrl, manifest);

    // Below minimum — expect policy_warning in response body.
    const putResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(manifest.connector_id)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 600 }),
    });
    assert.equal(putResp.status, 200);
    const body = await putResp.json();
    assert.equal(body.object, 'schedule');
    assert.equal(body.interval_seconds, 600);
    assert.ok(typeof body.policy_warning === 'string' && body.policy_warning.length > 0,
      'expected policy_warning string when interval is below minimum');
    assert.ok(body.policy_warning.includes('3600'), 'warning should mention minimum interval');

    // At or above recommended — policy_warning should be absent or null.
    const putResp2 = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(manifest.connector_id)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 86400 }),
    });
    assert.equal(putResp2.status, 200);
    const body2 = await putResp2.json();
    assert.ok(!body2.policy_warning, 'no policy_warning when interval meets or exceeds recommended');
  } finally {
    await closeServer(server);
  }
});

test('schedule upsert rejects enabling manual or background-unsafe connector policy', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'manual-unsafe-test',
    version: '1.0.0',
    display_name: 'Manual Unsafe Test',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
    capabilities: {
      refresh_policy: {
        recommended_mode: 'manual',
        interaction_posture: 'otp_likely',
        background_safe: false,
        rationale: 'Requires owner-present login.',
      },
    },
  };

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerConnector(asUrl, manifest);

    const putResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(manifest.connector_id)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 3600, enabled: true }),
    });
    assert.equal(putResp.status, 400);
    const body = await putResp.json();
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /manual runs|background-safe|scheduling is disabled/);
  } finally {
    await closeServer(server);
  }
});

test('schedule resume rejects a disabled schedule when connector policy is background-unsafe', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'background-unsafe-test',
    version: '1.0.0',
    display_name: 'Background Unsafe Test',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
    capabilities: {
      refresh_policy: {
        recommended_mode: 'automatic',
        background_safe: false,
        rationale: 'Automatic refresh needs an owner-present browser.',
      },
    },
  };

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerConnector(asUrl, manifest);

    const putResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(manifest.connector_id)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 3600, enabled: false }),
    });
    assert.equal(putResp.status, 200);
    const created = await putResp.json();
    assert.equal(created.enabled, false);

    const resumeResp = await fetch(
      `${asUrl}/_ref/connectors/${encodeURIComponent(manifest.connector_id)}/schedule/resume`,
      { method: 'POST' },
    );
    assert.equal(resumeResp.status, 400);
    const body = await resumeResp.json();
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /background-safe/);
  } finally {
    await closeServer(server);
  }
});

test('GET /_ref/schedules surfaces ineligibility_reason for a stale enabled row whose manifest now declares unsafe policy', async () => {
  // An enabled schedule was created under a previous manifest that permitted
  // automatic refresh. The manifest is later updated to declare manual /
  // background-unsafe policy. The persisted row remains as operator intent —
  // we do not delete it — but the scheduler skips it and the listing API
  // must surface an explicit reason so the dashboard does not imply the row
  // is running.
  const connectorId = 'stale-unsafe-reconcile-test';
  const baseManifest = {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '1.0.0',
    display_name: 'Stale Unsafe Reconcile Test',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
    capabilities: {
      refresh_policy: {
        recommended_mode: 'automatic',
        background_safe: true,
        interaction_posture: 'credentials',
        rationale: 'API refresh; safe to background.',
      },
    },
  };
  const unsafeManifest = {
    ...baseManifest,
    version: '1.1.0',
    capabilities: {
      refresh_policy: {
        recommended_mode: 'manual',
        background_safe: false,
        interaction_posture: 'otp_likely',
        rationale: 'Now requires owner-present login.',
      },
    },
  };

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerConnector(asUrl, baseManifest);

    // Persist an enabled schedule under the original (eligible) manifest.
    const putResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 86400, enabled: true }),
    });
    assert.equal(putResp.status, 200);
    const initial = await putResp.json();
    assert.equal(initial.enabled, true);
    assert.equal(initial.ineligibility_reason, null, 'fresh enabled row under safe policy should have no ineligibility reason');

    // Manifest changes underneath us: connector is now manual / background-unsafe.
    await registerConnector(asUrl, unsafeManifest);

    // Single-schedule GET surfaces the reason without mutating the persisted row.
    const { status: getStatus, body: scheduleBody } = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
    );
    assert.equal(getStatus, 200);
    assert.equal(scheduleBody.enabled, true, 'persisted operator intent must remain visible');
    assert.ok(
      typeof scheduleBody.ineligibility_reason === 'string' && scheduleBody.ineligibility_reason.length > 0,
      'expected ineligibility_reason on stale enabled row',
    );
    assert.match(scheduleBody.ineligibility_reason, /manual runs|background-safe|paused/);

    // List endpoint exposes the same reason for the same row.
    const { status: listStatus, body: listBody } = await fetchJson(`${asUrl}/_ref/schedules`);
    assert.equal(listStatus, 200);
    const entry = listBody.data.find((s) => s.connector_id === connectorId);
    assert.ok(entry, 'expected stale connector to appear in list-schedules');
    assert.equal(entry.enabled, true);
    assert.equal(entry.ineligibility_reason, scheduleBody.ineligibility_reason);

    // Resuming this row must still be rejected with the same gate.
    const resumeResp = await fetch(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule/resume`,
      { method: 'POST' },
    );
    assert.ok(resumeResp.status === 400, `expected 400 on resume of unsafe row, got ${resumeResp.status}`);
  } finally {
    await closeServer(server);
  }
});

test('GET /_ref/schedules omits ineligibility_reason when persisted row is disabled or policy is safe', async () => {
  const safeId = 'eligible-schedule-listing-test';
  const safeManifest = {
    protocol_version: '0.1.0',
    connector_id: safeId,
    version: '1.0.0',
    display_name: 'Eligible Schedule Listing Test',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
    capabilities: {
      refresh_policy: {
        recommended_mode: 'automatic',
        background_safe: true,
        interaction_posture: 'credentials',
        rationale: 'API refresh; safe to background.',
      },
    },
  };

  const disabledId = 'disabled-unsafe-listing-test';
  const disabledManifest = {
    protocol_version: '0.1.0',
    connector_id: disabledId,
    version: '1.0.0',
    display_name: 'Disabled Unsafe Listing Test',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        primary_key: ['id'],
      },
    ],
    capabilities: {
      refresh_policy: {
        recommended_mode: 'manual',
        background_safe: false,
        interaction_posture: 'otp_likely',
        rationale: 'Owner-present login required.',
      },
    },
  };

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerConnector(asUrl, safeManifest);
    await registerConnector(asUrl, disabledManifest);

    // Safe + enabled schedule: no ineligibility reason.
    const safePut = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(safeId)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 86400, enabled: true }),
    });
    assert.equal(safePut.status, 200);
    const safeBody = await safePut.json();
    assert.equal(safeBody.enabled, true);
    assert.equal(safeBody.ineligibility_reason, null);

    // Unsafe but disabled: persisted intent only, not eligible to resume, but
    // ineligibility_reason should be null because the row is not claiming to run.
    const disabledPut = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(disabledId)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 86400, enabled: false }),
    });
    assert.equal(disabledPut.status, 200);
    const disabledBody = await disabledPut.json();
    assert.equal(disabledBody.enabled, false);
    assert.equal(disabledBody.ineligibility_reason, null);

    const { body: listBody } = await fetchJson(`${asUrl}/_ref/schedules`);
    const safeEntry = listBody.data.find((s) => s.connector_id === safeId);
    const disabledEntry = listBody.data.find((s) => s.connector_id === disabledId);
    assert.equal(safeEntry.ineligibility_reason, null);
    assert.equal(disabledEntry.ineligibility_reason, null);
  } finally {
    await closeServer(server);
  }
});

test('GET /_ref/approvals surfaces pending provider-connect consents with grant preview', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    // Start a PAR request that will be pending until approve/deny.
    const parResp = await fetch(`${asUrl}/oauth/par`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'concert_recommendation_app',
        authorization_details: [{
          type: 'https://pdpp.org/data-access',
          source: { kind: 'connector', id: spotifyManifest.connector_id },
          purpose_code: 'https://pdpp.org/purpose/personalization',
          purpose_description: 'Suggest concerts based on listening history',
          access_mode: 'single_use',
          streams: [{ name: 'top_artists', fields: ['id', 'name'] }],
        }],
      }),
    });
    assert.ok([200, 201].includes(parResp.status), `PAR status ${parResp.status}`);

    const { status, body } = await fetchJson(`${asUrl}/_ref/approvals`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(body.data.length >= 1, 'expected at least one pending approval');
    const entry = body.data.find((e) => e.kind === 'consent');
    assert.ok(entry, 'expected a consent approval entry');
    assert.equal(entry.client_id, 'concert_recommendation_app');
    assert.ok(entry.grant_preview);
    assert.deepEqual(entry.grant_preview.source, { kind: 'connector', id: SPOTIFY_CONNECTOR_KEY });
    assert.equal(entry.grant_preview.access_mode, 'single_use');
    assert.ok(Array.isArray(entry.grant_preview.streams));
  });
});

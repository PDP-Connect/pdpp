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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const POLYFILL_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors', 'manifests');

async function closeServer(server) {
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

test('GET /_ref/connectors lists registered connectors with stream names and freshness', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    const entry = body.data.find((c) => c.connector_id === spotifyManifest.connector_id);
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
    const entry = body.data.find((c) => c.connector_id === cid);
    assert.ok(entry);
    assert.ok(entry.schedule, 'schedule should be projected when configured');
    assert.equal(entry.schedule.interval_seconds, 900);
    assert.equal(entry.schedule.enabled, true);
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

    const { body: connFiltered } = await fetchJson(`${asUrl}/_ref/records/timeline?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`);
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

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const completed = (timeline.data || []).find((event) => event.event_type === 'run.completed');
    assert.ok(completed, 'manual run should complete in the background');

    const { body: connectors } = await fetchJson(`${asUrl}/_ref/connectors`);
    const entry = connectors.data.find((row) => row.connector_id === cid);
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
  const connectorId = spotifyManifest.connector_id;
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
      data: {
        source: { binding_kind: 'connector', connector_id: connectorId },
        collection_mode: 'incremental',
        persist_state: true,
        state_commit_intent: 'commit_on_success',
        bindings: { network: {}, filesystem: {}, interactive: {} },
        scope: { streams: [{ name: 'top_tracks' }] },
        scope_streams: ['top_tracks'],
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
      data: {
        source: { binding_kind: 'connector', connector_id: connectorId },
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
    const entry = connectors.data.find((row) => row.connector_id === connectorId);
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
    assert.equal(upserted.connector_id, cid);
    assert.equal(upserted.interval_seconds, 1800);
    assert.equal(upserted.jitter_seconds, 30);
    assert.equal(upserted.enabled, true);

    // List shows it.
    const { body: listed } = await fetchJson(`${asUrl}/_ref/schedules`);
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].connector_id, cid);

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
          connector_id: spotifyManifest.connector_id,
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
    assert.equal(entry.grant_preview.connector_id, spotifyManifest.connector_id);
    assert.equal(entry.grant_preview.access_mode, 'single_use');
    assert.ok(Array.isArray(entry.grant_preview.streams));
  });
});

/**
 * Control-plane `_ref` listing and search helpers.
 *
 * These endpoints are reference-designated and read-only. They support the
 * operator console and the CLI. Coverage here proves:
 *
 * - pagination / limit behaves consistently across traces/grants/runs
 * - status and correlation-id filters work the way the console depends on
 * - search surfaces exact-id hits for deep-linking
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';
import { getDb } from '../server/db.js';
import { emitSpineEvent } from '../lib/spine.ts';
import { runConnector } from '../runtime/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

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
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
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
  return tokenBody.access_token;
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);
    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function seedOneRun({ asUrl, rsUrl, spotifyManifest }) {
  const ownerToken = await issueOwnerToken(asUrl);
  const runResult = await runConnector({
    connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
    connectorId: spotifyManifest.connector_id,
    ownerToken,
    manifest: spotifyManifest,
    state: null,
    collectionMode: 'full_refresh',
    rsUrl,
  });
  return { ownerToken, runResult };
}

test('_ref listing helpers', async (t) => {
  await t.test('GET /_ref/traces returns paginated trace summaries', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { status, body } = await fetchJson(`${asUrl}/_ref/traces?limit=100`);
      assert.equal(status, 200);
      assert.equal(body.object, 'list');
      assert.ok(Array.isArray(body.data));
      assert.ok(body.data.length > 0, 'expected at least one trace');
      const sample = body.data[0];
      assert.equal(sample.object, 'trace_summary');
      assert.ok(sample.trace_id.startsWith('trc_'));
      assert.ok(Array.isArray(sample.kinds));
      assert.ok(typeof sample.event_count === 'number' && sample.event_count >= 1);
    });
  });

  await t.test('GET /_ref/traces honors limit and returns has_more + cursor', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      // Seed several runs so there are multiple trace artifacts.
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { body: firstPage } = await fetchJson(`${asUrl}/_ref/traces?limit=2`);
      assert.equal(firstPage.data.length, 2);
      if (firstPage.has_more) {
        assert.ok(typeof firstPage.next_cursor === 'string');
        const { body: nextPage } = await fetchJson(
          `${asUrl}/_ref/traces?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
        );
        assert.notEqual(
          firstPage.data[0].trace_id,
          nextPage.data[0]?.trace_id ?? null,
          'cursor should advance past first page',
        );
      }
    });
  });

  await t.test('GET /_ref/runs returns run summaries with connector_id', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { status, body } = await fetchJson(`${asUrl}/_ref/runs?limit=10`);
      assert.equal(status, 200);
      assert.equal(body.object, 'list');
      assert.ok(body.data.length > 0);
      const run = body.data[0];
      assert.equal(run.object, 'run_summary');
      assert.ok(run.run_id.startsWith('run_'));
      assert.equal(run.connector_id, spotifyManifest.connector_id);
    });
  });

  await t.test('GET /_ref/runs filters by connector_id', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body } = await fetchJson(
        `${asUrl}/_ref/runs?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
      );
      assert.ok(body.data.length > 0);
      for (const r of body.data) {
        assert.equal(r.connector_id, spotifyManifest.connector_id);
      }

      const { body: none } = await fetchJson(`${asUrl}/_ref/runs?connector_id=does.not.exist`);
      assert.equal(none.data.length, 0);
    });
  });

  await t.test('GET /_ref/runs filters by status', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { body: succeeded } = await fetchJson(`${asUrl}/_ref/runs?status=succeeded`);
      for (const r of succeeded.data) assert.equal(r.status, 'succeeded');

      const { body: failed } = await fetchJson(`${asUrl}/_ref/runs?status=failed`);
      for (const r of failed.data) assert.equal(r.status, 'failed');
    });
  });

  await t.test('GET /_ref/runs reports pending interaction state without relying on event-kind sets', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const source = { connector_id: spotifyManifest.connector_id };
      // Spine-layer stamping requirement: every run.started must carry
      // boot_epoch+seq. Harness ran startServer which initialized the
      // singleton; read it once and merge into every synthetic emit.
      const { getCurrentBootEpoch } = await import('../lib/spine.ts');
      const _epoch = getCurrentBootEpoch();
      const runStartedStamp = _epoch ? {
        boot_epoch: _epoch.boot_epoch,
        seq: _epoch.seq,
        controller_id: _epoch.controller_id,
      } : { boot_epoch: 'synthetic', seq: 1, controller_id: 'synthetic' };
      const base = {
        actor_id: spotifyManifest.connector_id,
        actor_type: 'runtime',
        object_type: 'run',
        scenario_id: 'scn_pending_interaction_test',
        trace_id: 'trc_pending_interaction_test',
      };

      await emitSpineEvent({
        ...base,
        event_type: 'run.started',
        object_id: 'run_pending_input',
        occurred_at: '2026-04-24T00:00:00.000Z',
        run_id: 'run_pending_input',
        status: 'started',
        data: { source, ...runStartedStamp },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.interaction_required',
        interaction_id: 'int_first',
        object_id: 'run_pending_input',
        occurred_at: '2026-04-24T00:00:01.000Z',
        run_id: 'run_pending_input',
        status: 'started',
        data: { source, kind: 'otp', message: 'enter code' },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.started',
        object_id: 'run_terminal_stale_input',
        occurred_at: '2026-04-24T00:01:00.000Z',
        run_id: 'run_terminal_stale_input',
        status: 'started',
        data: { source, ...runStartedStamp },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.interaction_required',
        interaction_id: 'int_stale',
        object_id: 'run_terminal_stale_input',
        occurred_at: '2026-04-24T00:01:01.000Z',
        run_id: 'run_terminal_stale_input',
        status: 'started',
        data: { source, kind: 'manual_action', message: 'manual step' },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.failed',
        object_id: 'run_terminal_stale_input',
        occurred_at: '2026-04-24T00:01:02.000Z',
        run_id: 'run_terminal_stale_input',
        status: 'failed',
        data: { source, reason: 'runtime_error' },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.started',
        object_id: 'run_second_input',
        occurred_at: '2026-04-24T00:02:00.000Z',
        run_id: 'run_second_input',
        status: 'started',
        data: { source, ...runStartedStamp },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.interaction_required',
        interaction_id: 'int_old',
        object_id: 'run_second_input',
        occurred_at: '2026-04-24T00:02:01.000Z',
        run_id: 'run_second_input',
        status: 'started',
        data: { source, kind: 'credentials', message: 'credentials' },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.interaction_completed',
        interaction_id: 'int_old',
        object_id: 'run_second_input',
        occurred_at: '2026-04-24T00:02:02.000Z',
        run_id: 'run_second_input',
        status: 'success',
        data: { source, status: 'success' },
      });
      await emitSpineEvent({
        ...base,
        event_type: 'run.interaction_required',
        interaction_id: 'int_new',
        object_id: 'run_second_input',
        occurred_at: '2026-04-24T00:02:03.000Z',
        run_id: 'run_second_input',
        status: 'started',
        data: { source, kind: 'otp', message: 'new code' },
      });

      const { body } = await fetchJson(`${asUrl}/_ref/runs?limit=50&q=run_`);
      const byId = new Map(body.data.map((run) => [run.run_id, run]));

      assert.equal(byId.get('run_pending_input')?.needs_input, true);
      assert.equal(byId.get('run_terminal_stale_input')?.needs_input, false);
      assert.equal(byId.get('run_second_input')?.needs_input, true);
    });
  });

  await t.test('GET /_ref/search finds exact trace id for deep-linking', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body: tracesList } = await fetchJson(`${asUrl}/_ref/traces?limit=1`);
      const traceId = tracesList.data[0].trace_id;

      const { body: search } = await fetchJson(
        `${asUrl}/_ref/search?q=${encodeURIComponent(traceId)}`,
      );
      assert.equal(search.object, 'search_result');
      assert.deepEqual(search.exact, { kind: 'trace', id: traceId });
      assert.ok(search.traces.some((t) => t.trace_id === traceId));
    });
  });

  await t.test('GET /_ref/search finds exact run id', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body: runsList } = await fetchJson(`${asUrl}/_ref/runs?limit=1`);
      assert.ok(runsList.data.length > 0);
      const runId = runsList.data[0].run_id;

      const { body: search } = await fetchJson(
        `${asUrl}/_ref/search?q=${encodeURIComponent(runId)}`,
      );
      assert.deepEqual(search.exact, { kind: 'run', id: runId });
    });
  });

  await t.test('GET /_ref/search with empty query returns empty result without error', async () => {
    await withHarness(async ({ asUrl }) => {
      const { status, body } = await fetchJson(`${asUrl}/_ref/search?q=`);
      assert.equal(status, 200);
      assert.equal(body.object, 'search_result');
      assert.equal(body.exact, null);
      assert.deepEqual(body.traces, []);
      assert.deepEqual(body.grants, []);
      assert.deepEqual(body.runs, []);
    });
  });

  await t.test('GET /_ref/grants summarizes status as grant lifecycle (issued), not raw event status', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      // A run doesn't create grants; register a client + go through PAR/consent
      // is heavy for this coverage. Use the seeded client set instead: seed
      // records then do an owner device flow (issues a grant).
      await issueOwnerToken(asUrl);
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { body } = await fetchJson(`${asUrl}/_ref/grants?limit=50`);
      for (const g of body.data) {
        // Status must be one of the lifecycle states, not `succeeded` or other
        // raw event statuses that leak through without lifecycle derivation.
        assert.ok(
          ['issued', 'revoked', 'denied', 'failed', 'pending'].includes(g.status),
          `expected grant lifecycle status, got ${g.status}`,
        );
      }
    });
  });

  await t.test('operator journey: list run → pivot to timeline preserves correlation', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body: runs } = await fetchJson(`${asUrl}/_ref/runs?limit=1`);
      assert.ok(runs.data.length > 0);
      const runId = runs.data[0].run_id;

      const { status, body: timeline } = await fetchJson(
        `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`,
      );
      assert.equal(status, 200);
      assert.equal(timeline.object, 'run_timeline');
      assert.equal(timeline.run_id, runId);
      assert.ok(timeline.data.length > 0);
      const startedEvent = timeline.data.find((e) => e.event_type === 'run.started');
      assert.ok(startedEvent);
      // actor_id on runtime events is the connectorId, which the run list should report.
      assert.equal(startedEvent.actor_id, spotifyManifest.connector_id);
    });
  });
});

test('_ref dataset summary', async (t) => {
  await t.test('empty instance returns zeros, null timestamps, and empty top_connectors', async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = await resp.json();
      assert.equal(resp.status, 200);
      assert.equal(body.object, 'dataset_summary');
      assert.equal(body.connector_count, 0);
      assert.equal(body.stream_count, 0);
      assert.equal(body.record_count, 0);
      assert.equal(body.record_json_bytes, 0);
      assert.equal(body.record_changes_json_bytes, 0);
      assert.equal(body.blob_bytes, 0);
      assert.equal(body.total_retained_bytes, 0);
      assert.equal(body.earliest_record_time, null);
      assert.equal(body.latest_record_time, null);
      assert.equal(body.earliest_ingested_at, null);
      assert.equal(body.latest_ingested_at, null);
      assert.deepEqual(body.top_connectors, []);
    });
  });

  await t.test('populated instance reports honest aggregates across connectors and streams', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      // Seed records directly via ingestRecord so the test does not depend on
      // the full Collection-Profile runtime; the dataset summary reads raw
      // storage regardless of ingestion path.
      //
      // The spotify manifest registered by withHarness declares streams
      // `top_artists` (consent_time_field: source_updated_at), `saved_tracks`
      // (saved_at), and `recently_played` (played_at). Seed records matching
      // those streams with real-world timestamps so the dataset summary's
      // `consent_time_field`-driven bounds exercise the live manifest.
      const spotifyId = spotifyManifest.connector_id;
      await ingestRecord(spotifyId, {
        stream: 'saved_tracks',
        key: 'track_1',
        data: { id: 'track_1', name: 'Alpha', saved_at: '2023-01-01T00:00:00.000Z' },
        emitted_at: '2026-04-20T00:00:00.000Z',
      });
      await ingestRecord(spotifyId, {
        stream: 'saved_tracks',
        key: 'track_2',
        data: { id: 'track_2', name: 'Bravo', saved_at: '2024-06-15T12:00:00.000Z' },
        emitted_at: '2026-04-20T00:00:00.000Z',
      });
      await ingestRecord(spotifyId, {
        stream: 'recently_played',
        key: 'play_1',
        data: { id: 'play_1', track_id: 'track_1', played_at: '2022-07-03T09:15:00.000Z' },
        emitted_at: '2026-04-20T00:00:00.000Z',
      });
      // Non-temporal stream (top_artists records without source_updated_at
      // are still valid; consent_time_field MIN/MAX will just see NULLs).
      await ingestRecord(spotifyId, {
        stream: 'top_artists',
        key: 'artist_1',
        data: { id: 'artist_1', name: 'X', source_updated_at: '2025-03-10T18:00:00.000Z' },
        emitted_at: '2026-04-20T00:00:00.000Z',
      });

      // Seed a blob directly so blob_bytes is exercised.
      getDb().prepare(`
        INSERT INTO blobs(blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data)
        VALUES ('blob_test_1', ?, 'covers', 'cover_1', 'image/png', 2048, 'deadbeef', NULL)
      `).run(spotifyId);

      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = await resp.json();
      assert.equal(resp.status, 200);
      assert.equal(body.object, 'dataset_summary');
      assert.equal(body.connector_count, 1, 'one distinct connector_id with live records');
      assert.equal(body.stream_count, 3, 'distinct (connector_id, stream) pairs with live records');
      assert.equal(body.record_count, 4);
      assert.ok(body.record_json_bytes > 0, 'record_json_bytes should be positive with seeded records');
      assert.ok(
        body.record_changes_json_bytes >= body.record_json_bytes,
        'record_changes_json_bytes should include at least one version per seeded record',
      );
      assert.equal(body.blob_bytes, 2048);
      assert.equal(
        body.total_retained_bytes,
        body.record_json_bytes + body.record_changes_json_bytes + body.blob_bytes,
      );

      // Real-world bounds pulled from manifest-declared consent_time_field
      // values inside record data.
      assert.equal(
        body.earliest_record_time,
        '2022-07-03T09:15:00.000Z',
        'earliest_record_time comes from recently_played.played_at',
      );
      assert.equal(
        body.latest_record_time,
        '2025-03-10T18:00:00.000Z',
        'latest_record_time comes from top_artists.source_updated_at',
      );

      // Ingestion bounds come from the runtime-set emitted_at column and are
      // always reported, independent of consent_time_field presence.
      assert.equal(body.earliest_ingested_at, '2026-04-20T00:00:00.000Z');
      assert.equal(body.latest_ingested_at, '2026-04-20T00:00:00.000Z');

      // top_connectors is sorted by record_count desc.
      assert.equal(body.top_connectors.length, 1);
      assert.equal(body.top_connectors[0].connector_id, spotifyId);
      assert.equal(body.top_connectors[0].record_count, 4);
    });
  });

  await t.test('soft-deleted records are excluded from counts, bytes, and timestamp bounds', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const spotifyId = spotifyManifest.connector_id;
      await ingestRecord(spotifyId, {
        stream: 'saved_tracks',
        key: 'track_live',
        data: { id: 'track_live', name: 'Live', saved_at: '2024-01-01T00:00:00.000Z' },
        emitted_at: '2026-04-20T00:00:00.000Z',
      });
      await ingestRecord(spotifyId, {
        stream: 'saved_tracks',
        key: 'track_tombstoned',
        data: { id: 'track_tombstoned', name: 'Tombstoned', saved_at: '2099-12-31T23:59:59.000Z' },
        emitted_at: '2026-04-20T00:00:00.000Z',
      });
      await ingestRecord(spotifyId, {
        stream: 'saved_tracks',
        key: 'track_tombstoned',
        data: { id: 'track_tombstoned' },
        op: 'delete',
        emitted_at: '2026-04-20T00:00:00.000Z',
      });

      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = await resp.json();
      assert.equal(body.record_count, 1, 'soft-deleted rows must not count');
      assert.equal(
        body.latest_record_time,
        '2024-01-01T00:00:00.000Z',
        'tombstoned row must not shift latest_record_time',
      );
    });
  });

  await t.test('streams without consent_time_field do not contribute to record-time bounds', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const spotifyId = spotifyManifest.connector_id;
      // `tracks` is NOT a spotify manifest stream. Records seeded into it have
      // no manifest-declared consent_time_field, so they MUST NOT contribute
      // to earliest/latest_record_time even if data contains a timestamp-ish
      // property.
      await ingestRecord(spotifyId, {
        stream: 'tracks',
        key: 'track_unmanifested',
        data: { id: 'track_unmanifested', saved_at: '1999-01-01T00:00:00.000Z' },
        emitted_at: '2026-04-20T00:00:00.000Z',
      });

      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = await resp.json();
      assert.equal(body.record_count, 1);
      assert.equal(
        body.earliest_record_time,
        null,
        'unmanifested stream data MUST NOT be mined for record-time bounds',
      );
      assert.equal(body.latest_record_time, null);
      assert.equal(
        body.earliest_ingested_at,
        '2026-04-20T00:00:00.000Z',
        'ingestion bounds are still reported for unmanifested streams',
      );
    });
  });

  await t.test('record history is counted separately from live payload and folded into total_retained_bytes', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const spotifyId = spotifyManifest.connector_id;
      // Three versions of the same record — one live row, two prior versions
      // in record_changes. The live payload counts once under
      // record_json_bytes; every version (including the live one) is mirrored
      // into record_changes and counts under record_changes_json_bytes.
      await ingestRecord(spotifyId, {
        stream: 'tracks',
        key: 'track_versioned',
        data: { id: 'track_versioned', name: 'v1', extra: 'x'.repeat(100) },
        emitted_at: '2024-01-01T00:00:00.000Z',
      });
      await ingestRecord(spotifyId, {
        stream: 'tracks',
        key: 'track_versioned',
        data: { id: 'track_versioned', name: 'v2', extra: 'x'.repeat(100) },
        emitted_at: '2024-01-02T00:00:00.000Z',
      });
      await ingestRecord(spotifyId, {
        stream: 'tracks',
        key: 'track_versioned',
        data: { id: 'track_versioned', name: 'v3', extra: 'x'.repeat(100) },
        emitted_at: '2024-01-03T00:00:00.000Z',
      });

      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = await resp.json();
      assert.equal(body.record_count, 1, 'still one live record after three versions');
      assert.ok(
        body.record_changes_json_bytes > body.record_json_bytes,
        'three retained versions must exceed one live-payload size',
      );
      assert.equal(
        body.total_retained_bytes,
        body.record_json_bytes + body.record_changes_json_bytes + body.blob_bytes,
        'total_retained_bytes must sum the three labeled concepts',
      );
    });
  });

  await t.test('response carries Request-Id correlation header for log cross-reference', async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      assert.equal(resp.status, 200);
      const requestId = resp.headers.get('request-id');
      assert.ok(requestId, 'Request-Id header must be present on _ref responses');
    });
  });
});

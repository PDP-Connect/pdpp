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

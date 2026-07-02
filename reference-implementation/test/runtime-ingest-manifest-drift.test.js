// Regression coverage for OpenSpec change
// `harden-ingest-against-transient-manifest-drift`.
//
// Reproduces the live GitHub `user_stats` failure shape: the runtime admits a
// stream into START scope from the manifest it was handed, but the resource
// server's *registered* manifest lags (a stale connectors row), so that stream's
// ingest is rejected 404 `not_found`. The runtime must treat this as a transient
// per-stream gap — skip the stream, keep its cursor uncommitted, and still commit
// every other in-scope stream — instead of aborting the whole run.
//
// The drift is constructed honestly against a REAL resource server: we register a
// manifest WITHOUT the drift stream (so the RS 404s it) while passing a manifest
// WITH the drift stream to runConnector (so the runtime validates it into START
// scope). No mocks of the ingest path.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { startServer } from '../server/index.js';
import { isTransientManifestDriftIngestFailure, loadSyncState, runConnector } from '../runtime/index.js';

// ── local harness (kept self-contained; mirrors collection-profile.test.js) ──

async function fetchJson(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function streamSchema() {
  return {
    type: 'object',
    properties: { id: { type: 'string' }, value: { type: 'string' } },
    required: ['id'],
  };
}

// Manifest as the RESOURCE SERVER sees it: only `items` (the drift stream is
// absent, simulating a stale connectors row).
function rsRegisteredManifest(connectorId) {
  return {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '1.0.0',
    display_name: 'Drift Test Connector',
    streams: [{ name: 'items', semantics: 'append_only', schema: streamSchema(), primary_key: ['id'] }],
  };
}

// Manifest as the RUNTIME sees it: `items` + the drift stream. The runtime
// validates the drift stream into START scope; the RS will still 404 it.
function runtimeManifest(connectorId) {
  return {
    ...rsRegisteredManifest(connectorId),
    streams: [
      { name: 'items', semantics: 'append_only', schema: streamSchema(), primary_key: ['id'] },
      { name: 'drift_stream', semantics: 'append_only', schema: streamSchema(), primary_key: ['id'] },
    ],
  };
}

function createTestConnector(messages) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-drift-connector-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const done = [...messages].reverse().find((m) => m.type === 'DONE') || null;
    const exitCode = !done ? 0 : (done.status === 'succeeded' ? 0 : 1);
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(exitCode);
  }
});
`;
  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

async function registerManifest(asUrl, manifest) {
  await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
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

const nowIso = () => new Date().toISOString();

test('transient manifest drift: scope-stream ingest not_found degrades to a per-stream gap', async (t) => {
  await t.test('drift stream is skipped, other streams commit, run succeeds', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const asUrl = `http://localhost:${asPort}`;
    const connectorId = 'drift-test';
    await registerManifest(asUrl, rsRegisteredManifest(connectorId)); // RS lacks drift_stream
    const ownerToken = await issueOwnerToken(asUrl);

    // items ingests fine (200); drift_stream 404s (RS manifest lacks it).
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'ok' }, emitted_at: nowIso() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'items_committed' } },
      { type: 'RECORD', stream: 'drift_stream', key: 'd1', data: { id: 'd1', value: 'drift' }, emitted_at: nowIso() },
      { type: 'STATE', stream: 'drift_stream', cursor: { cursor: 'drift_should_not_commit' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 2 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: runtimeManifest(connectorId), // runtime scope INCLUDES drift_stream
        scope: { streams: [{ name: 'items' }, { name: 'drift_stream' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      // Run is NOT aborted by the drift 404.
      assert.equal(result.status, 'succeeded', 'run should succeed despite drift stream 404');

      // A transient known gap names the drift stream.
      const driftGap = (result.known_gaps || []).find((g) => g.stream === 'drift_stream');
      assert.ok(driftGap, 'a known gap should name drift_stream');
      assert.equal(driftGap.reason, 'manifest_stream_unresolved');
      assert.equal(driftGap.severity, 'transient');

      // The healthy stream committed its cursor; the drift stream did NOT.
      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.equal(state?.items?.cursor, 'items_committed', 'items cursor should be committed');
      assert.ok(
        !state?.drift_stream || state.drift_stream.cursor !== 'drift_should_not_commit',
        'drift stream cursor must NOT be committed so the next run re-collects it',
      );

      // The healthy stream's record reached the RS.
      const { body: itemsBody } = await fetchJson(
        `http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.ok((itemsBody.data || itemsBody.records || []).length >= 1, 'items record should be ingested');

      // Timeline shows a stream_skipped for the drift stream and NOT a run.failed.
      const { body: timeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const events = timeline.data || [];
      const types = events.map((e) => e.event_type);
      assert.ok(types.includes('run.stream_skipped'), 'timeline should include run.stream_skipped');
      assert.ok(types.includes('run.completed'), 'timeline should include run.completed');
      assert.ok(!types.includes('run.failed'), 'timeline should NOT include run.failed');
      const skip = events.find((e) => e.event_type === 'run.stream_skipped');
      assert.equal(skip.stream_id, 'drift_stream');
      assert.equal(skip.data?.reason, 'manifest_stream_unresolved');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('a genuinely unknown-to-runtime stream still fails terminally (guard)', async () => {
    // Here the drift stream is NOT in the runtime manifest/scope either, so a
    // RECORD for it is an undeclared-stream protocol violation — the runtime must
    // still fail. This proves the fix does not silently accept records for
    // streams the runtime never validated.
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const asUrl = `http://localhost:${asPort}`;
    const connectorId = 'drift-guard';
    await registerManifest(asUrl, rsRegisteredManifest(connectorId));
    const ownerToken = await issueOwnerToken(asUrl);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'not_in_scope', key: 'x1', data: { id: 'x1' }, emitted_at: nowIso() },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      // The runtime rejects an undeclared-stream RECORD as a protocol violation
      // BEFORE any ingest — it never reaches flushBatch, so the drift branch can
      // never mask it. This must remain terminal.
      await assert.rejects(
        () =>
          runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: rsRegisteredManifest(connectorId), // runtime scope EXCLUDES not_in_scope
            scope: { streams: [{ name: 'items' }] },
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({}),
          }),
        (err) => {
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /undeclared stream: not_in_scope/);
          return true;
        },
        'undeclared-stream RECORD must still fail the run terminally',
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('predicate reclassifies ONLY a 404 not_found for an in-scope stream', () => {
    const inScope = (s) => s === 'items';
    const driftErr = {
      response_status: 404,
      pdpp_error_code: 'not_found',
      ingest_failure: { phase: 'http_response', http_status: 404 },
    };

    // Positive: the exact transient-drift shape for an in-scope stream.
    assert.equal(isTransientManifestDriftIngestFailure(driftErr, 'items', inScope), true);

    // Negative — stream is NOT in START scope (never validated against manifest).
    assert.equal(isTransientManifestDriftIngestFailure(driftErr, 'other', inScope), false);

    // Negative — a different status (400 ambiguous_connector_instance, 5xx, 401).
    for (const status of [400, 401, 403, 409, 500, 503]) {
      const err = { ...driftErr, response_status: status, ingest_failure: { phase: 'http_response', http_status: status } };
      assert.equal(
        isTransientManifestDriftIngestFailure(err, 'items', inScope),
        false,
        `HTTP ${status} must NOT be reclassified as transient drift`,
      );
    }

    // Negative — 404 but a different error code (e.g. connector-level not_found).
    assert.equal(
      isTransientManifestDriftIngestFailure({ ...driftErr, pdpp_error_code: 'grant_invalid' }, 'items', inScope),
      false,
    );

    // Negative — 404 not_found but not the ingest http_response phase.
    assert.equal(
      isTransientManifestDriftIngestFailure(
        { ...driftErr, ingest_failure: { phase: 'request', http_status: 404 } },
        'items',
        inScope,
      ),
      false,
    );

    // Negative — no ingest_failure envelope at all (a plain 404 elsewhere).
    assert.equal(
      isTransientManifestDriftIngestFailure({ response_status: 404, pdpp_error_code: 'not_found' }, 'items', inScope),
      false,
    );

    // Negative — nullish error.
    assert.equal(isTransientManifestDriftIngestFailure(null, 'items', inScope), false);
  });
});

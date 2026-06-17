/**
 * Connector-summary read-model dirty-hook wiring tests.
 *
 * Pins the write-hook slice of `maintain-connector-summary-read-model`
 * (tasks 2.1 / 2.2): the maintained connector-summary evidence read model is
 * marked dirty from the seams that already invalidate connector summaries or
 * retained-size evidence.
 *
 *   - Record ingest (`ingestRecord`) dirties the matching connection's summary
 *     evidence, colocated with the retained-size delta — proving the record
 *     ingest hook (task 2.2).
 *   - The owner revoke route (`POST /v1/owner/connections/:id/revoke`) dirties
 *     that exact connection's summary evidence after the soft-revoke mutation
 *     commits — proving one async owner-mutation seam (task 2.1).
 *
 * These hooks are scoped (`markConnectorSummaryEvidenceDirty` with a known
 * `connector_instance_id`), awaited at their call sites, and best-effort: the
 * marker is an `UPDATE ... WHERE connector_instance_id = ?`, so it is a no-op
 * until the read model has a row for the connection (warmed by a rebuild).
 * Each test warms the evidence with `rebuildConnectorSummaryEvidence()` first
 * so the marker has a row to flip — which mirrors the steady state once the
 * read model backs the hot path.
 *
 * Falsifiability: deleting the `markConnectorSummaryEvidenceDirty` call from the
 * `ingestRecord` after-commit block (or from the revoke route after the cache
 * invalidation) makes the corresponding assertion fail because the evidence row
 * stays `dirty = false` / `state = 'fresh'`.
 *
 * Spec: openspec/changes/maintain-connector-summary-read-model/
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';
import {
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from '../server/connector-summary-read-model.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';
const OWNER_CLIENT_ID = 'cli_longview';
const NOW = '2026-06-17T00:00:00.000Z';

// ── Record-ingest seam (task 2.2): no server needed ─────────────────────────

// Use a real reference manifest so the after-commit lexical-index step (which
// loads and validates the connector manifest) succeeds. A synthetic
// `{ connector_id }` stub fails manifest validation; `connector_instances` also
// FK-references `connectors`, so the row must exist. The spotify manifest is a
// stable, committed fixture with declared streams.
const SPOTIFY_MANIFEST = JSON.parse(
  readFileSync(join(REFERENCE_IMPL_DIR, 'manifests', 'spotify.json'), 'utf8'),
);
const SPOTIFY_CONNECTOR_KEY = canonicalConnectorKey(SPOTIFY_MANIFEST.connector_id);
const SPOTIFY_STREAM = SPOTIFY_MANIFEST.streams[0].name;

function seedInstanceSqlite({ connectorInstanceId, displayName = 'Spotify source' }) {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(SPOTIFY_CONNECTOR_KEY, JSON.stringify(SPOTIFY_MANIFEST), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(
      connectorInstanceId,
      OWNER_SUBJECT_ID,
      SPOTIFY_CONNECTOR_KEY,
      displayName,
      connectorInstanceId,
      NOW,
      NOW,
    );
}

function storageTargetFor(connectorInstanceId) {
  return { connector_id: SPOTIFY_CONNECTOR_KEY, connector_instance_id: connectorInstanceId };
}

test('record ingest dirties the matching connection summary evidence', async () => {
  initDb();
  try {
    const instanceId = 'cin_summary_ingest_a';
    seedInstanceSqlite({ connectorInstanceId: instanceId });

    // Warm the read model so the scoped marker has a row to flip.
    await rebuildConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence(instanceId);
    assert.equal(before.dirty, false, 'evidence is clean immediately after rebuild');
    assert.equal(before.state, 'fresh');

    // A changed record write moves this connection's count evidence.
    const result = await ingestRecord(storageTargetFor(instanceId), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1', name: 'first' },
      emitted_at: NOW,
    });
    assert.equal(result.changed, true, 'a new record is a changed write');

    const after = await getConnectorSummaryEvidence(instanceId);
    assert.equal(after.dirty, true, 'record ingest marks the connection evidence dirty');
    assert.equal(after.state, 'stale');
  } finally {
    closeDb();
  }
});

test('record ingest only dirties the connection that received the record', async () => {
  initDb();
  try {
    const ingested = 'cin_summary_ingest_target';
    const untouched = 'cin_summary_ingest_other';
    seedInstanceSqlite({ connectorInstanceId: ingested, displayName: 'Target' });
    seedInstanceSqlite({ connectorInstanceId: untouched, displayName: 'Other' });
    await rebuildConnectorSummaryEvidence();

    await ingestRecord(storageTargetFor(ingested), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1' },
      emitted_at: NOW,
    });

    assert.equal((await getConnectorSummaryEvidence(ingested)).dirty, true);
    assert.equal(
      (await getConnectorSummaryEvidence(untouched)).dirty,
      false,
      'a sibling connection that received no record stays clean (scoped marker, not a full sweep)',
    );
  } finally {
    closeDb();
  }
});

test('no-op re-ingest does not dirty summary evidence', async () => {
  initDb();
  try {
    const instanceId = 'cin_summary_ingest_noop';
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    const storageTarget = storageTargetFor(instanceId);
    await ingestRecord(storageTarget, {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1', name: 'first' },
      emitted_at: NOW,
    });

    // Rebuild AFTER the first ingest so evidence is clean, then re-ingest the
    // identical payload (a no-op). The marker only fires for changed writes.
    await rebuildConnectorSummaryEvidence();
    assert.equal((await getConnectorSummaryEvidence(instanceId)).dirty, false);

    const result = await ingestRecord(storageTarget, {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1', name: 'first' },
      emitted_at: NOW,
    });
    assert.equal(result.changed, false, 'identical re-ingest is a no-op');
    assert.equal(
      (await getConnectorSummaryEvidence(instanceId)).dirty,
      false,
      'a no-op re-ingest must not dirty summary evidence',
    );
  } finally {
    closeDb();
  }
});

// ── Owner revoke seam (task 2.1): exercised end-to-end over the route ────────

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, resp, status: resp.status };
}

async function withServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
  });
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
      server,
    });
  } finally {
    await closeServer(server);
  }
}

async function issueOwnerToken(asUrl) {
  const device = (await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
  })).body;
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: OWNER_SUBJECT_ID }).toString(),
  });
  const tok = (await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: OWNER_CLIENT_ID,
    }).toString(),
  })).body;
  assert.ok(tok.access_token, 'device exchange should issue an owner token');
  return tok.access_token;
}

function loadReferenceManifest(name) {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests', `${name}.json`), 'utf8'));
}

async function registerConnector(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

async function seedInstance({ connectorInstanceId, connectorId, displayName, sourceBindingKey }) {
  await createSqliteConnectorInstanceStore().upsert({
    connectorInstanceId,
    ownerSubjectId: OWNER_SUBJECT_ID,
    connectorId,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account_hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

test('owner revoke route dirties the revoked connection summary evidence', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const instanceId = 'cin_spotify_revoke_summary';
    await seedInstance({
      connectorInstanceId: instanceId,
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    // Warm the read model so the revoke seam's scoped marker has a row to flip.
    await rebuildConnectorSummaryEvidence();
    assert.equal((await getConnectorSummaryEvidence(instanceId)).dirty, false);

    const ownerToken = await issueOwnerToken(asUrl);
    const revoke = await fetchJson(`${rsUrl}/v1/owner/connections/${instanceId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
    });
    assert.equal(revoke.status, 200, 'owner revoke should succeed');
    assert.equal(revoke.body.status, 'revoked');

    const after = await getConnectorSummaryEvidence(instanceId);
    assert.equal(after.dirty, true, 'revoke marks the connection summary evidence dirty');
    assert.equal(after.state, 'stale');
  });
});

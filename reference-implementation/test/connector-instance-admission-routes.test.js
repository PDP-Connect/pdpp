// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const NOW = '2026-05-18T12:00:00.000Z';

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

async function registerSpotify(asUrl) {
  const manifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201);
  return manifest;
}

async function seedTwoSpotifyInstances(connectorId) {
  const store = createSqliteConnectorInstanceStore();
  // connector_instances.connector_id references connectors(connector_id),
  // which registerConnector stores under the canonical key (the manifest's
  // URL-shaped connector_id is canonicalized to `spotify`). Seed instances
  // under that same canonical key so the FK resolves and the route's
  // canonical admission lookup finds them. See canonicalize-connector-keys
  // Decision 1: connector instances bind to canonical keys only.
  const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
  await store.upsert({
    connectorInstanceId: 'cin_spotify_personal',
    ownerSubjectId: 'owner_local',
    connectorId: canonicalId,
    displayName: 'Spotify - personal',
    sourceKind: 'account',
    sourceBindingKey: 'acct_personal',
    sourceBinding: { account_hint: 'personal' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsert({
    connectorInstanceId: 'cin_spotify_work',
    ownerSubjectId: 'owner_local',
    connectorId: canonicalId,
    displayName: 'Spotify - work',
    sourceKind: 'account',
    sourceBindingKey: 'acct_work',
    sourceBinding: { account_hint: 'work' },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedDraftSpotifyInstance(connectorId) {
  const store = createSqliteConnectorInstanceStore();
  const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
  await store.upsert({
    connectorInstanceId: 'cin_spotify_draft',
    ownerSubjectId: 'owner_local',
    connectorId: canonicalId,
    displayName: 'Spotify - draft',
    status: 'draft',
    sourceKind: 'manual',
    sourceBindingKey: 'draft_upload',
    sourceBinding: { kind: 'manual_upload_draft' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  return store;
}

test('owner-auth state route rejects ambiguous connector-only admission', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const ownerToken = await issueOwnerToken(asUrl);

    const resp = await fetchJson(`${rsUrl}/v1/state/${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, 'ambiguous_connector_instance');
  } finally {
    await closeServer(server);
  }
});

test('owner-auth state route admits explicit draft instance for first-run checkpointing', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    const store = await seedDraftSpotifyInstance(connectorId);
    const ownerToken = await issueOwnerToken(asUrl);
    const draftUrl =
      `${rsUrl}/v1/state/${encodeURIComponent(connectorId)}?connector_instance_id=cin_spotify_draft`;

    const put = await fetchJson(draftUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: { top_artists: { cursor: 'draft-checkpoint' } } }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.state.top_artists, { cursor: 'draft-checkpoint' });

    const get = await fetchJson(draftUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.state.top_artists, { cursor: 'draft-checkpoint' });
    assert.equal((await store.get('cin_spotify_draft')).status, 'draft');
  } finally {
    await closeServer(server);
  }
});

test('owner-auth state route uses explicit connector_instance_id for migrated sync state', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const draftStore = await seedDraftSpotifyInstance(connectorId);
    assert.equal((await draftStore.get('cin_spotify_draft')).status, 'draft');
    const ownerToken = await issueOwnerToken(asUrl);

    const workUrl =
      `${rsUrl}/v1/state/${encodeURIComponent(connectorId)}?connector_instance_id=cin_spotify_work`;
    const personalUrl =
      `${rsUrl}/v1/state/${encodeURIComponent(connectorId)}?connector_instance_id=cin_spotify_personal`;

    const workPut = await fetchJson(workUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: { top_artists: { cursor: 'work' } } }),
    });
    assert.equal(workPut.status, 200);
    assert.equal(workPut.body.connector_instance_id, undefined);
    assert.deepEqual(workPut.body.state.top_artists, { cursor: 'work' });

    const personalPut = await fetchJson(personalUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: { top_artists: { cursor: 'personal' } } }),
    });
    assert.equal(personalPut.status, 200);
    assert.equal(personalPut.body.connector_instance_id, undefined);
    assert.deepEqual(personalPut.body.state.top_artists, { cursor: 'personal' });

    const workGet = await fetchJson(workUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(workGet.status, 200);
    assert.equal(workGet.body.connector_instance_id, undefined);
    assert.deepEqual(workGet.body.state.top_artists, { cursor: 'work' });

    const personalGet = await fetchJson(personalUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(personalGet.status, 200);
    assert.equal(personalGet.body.connector_instance_id, undefined);
    assert.deepEqual(personalGet.body.state.top_artists, { cursor: 'personal' });
  } finally {
    await closeServer(server);
  }
});

test('owner-auth ingest route stores same record key under explicit connector instances', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const ownerToken = await issueOwnerToken(asUrl);

    const ambiguousIngest = await fetchJson(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: `${JSON.stringify({ key: 'artist_1', data: { id: 'artist_1', name: 'ambiguous' } })}\n`,
      },
    );
    assert.equal(ambiguousIngest.status, 400);
    assert.equal(ambiguousIngest.body.error.code, 'ambiguous_connector_instance');

    for (const [connectorInstanceId, name] of [
      ['cin_spotify_personal', 'personal artist'],
      ['cin_spotify_work', 'work artist'],
    ]) {
      const ingestResp = await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${connectorInstanceId}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: `${JSON.stringify({ key: 'artist_1', data: { id: 'artist_1', name } })}\n`,
        },
      );
      assert.equal(ingestResp.status, 200);
      assert.equal(ingestResp.body.records_accepted, 1);
      assert.equal(ingestResp.body.connector_instance_id, undefined);
    }

    const personalRecord = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/records/artist_1?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_personal`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(personalRecord.status, 200);
    // Public read contract (expose-connection-identity-on-public-read):
    // records carry canonical `connection_id` and the deprecated alias
    // `connector_instance_id` mirrored to the same value during the
    // migration window. The previous baseline asserted these were absent;
    // that pre-dated the canonicalization tranche.
    assert.equal(personalRecord.body.connection_id, 'cin_spotify_personal');
    assert.equal(personalRecord.body.connector_instance_id, 'cin_spotify_personal');
    assert.equal(personalRecord.body.data.name, 'personal artist');

    const workRecord = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/records/artist_1?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(workRecord.status, 200);
    assert.equal(workRecord.body.connection_id, 'cin_spotify_work');
    assert.equal(workRecord.body.connector_instance_id, 'cin_spotify_work');
    assert.equal(workRecord.body.data.name, 'work artist');
  } finally {
    await closeServer(server);
  }
});

test('owner-auth blob upload and read route through explicit connector instance bindings', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const draftStore = await seedDraftSpotifyInstance(connectorId);
    assert.equal((await draftStore.get('cin_spotify_draft')).status, 'draft');
    const ownerToken = await issueOwnerToken(asUrl);

    const ambiguousUpload = await fetchJson(
      `${rsUrl}/v1/blobs?connector_id=${encodeURIComponent(connectorId)}&stream=top_artists&record_key=artist_blob`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'text/plain',
        },
        body: 'ambiguous blob',
      },
    );
    assert.equal(ambiguousUpload.status, 400);
    assert.equal(ambiguousUpload.body.error.code, 'ambiguous_connector_instance');

    const uploadResp = await fetchJson(
      `${rsUrl}/v1/blobs?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work&stream=top_artists&record_key=artist_blob`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'text/plain',
        },
        body: 'work blob',
      },
    );
    assert.equal(uploadResp.status, 200);
    assert.equal(uploadResp.body.object, 'blob');

    const ingestResp = await fetchJson(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: `${JSON.stringify({
          key: 'artist_blob',
          data: {
            id: 'artist_blob',
            name: 'work blob artist',
            blob_ref: { blob_id: uploadResp.body.blob_id },
          },
        })}\n`,
      },
    );
    assert.equal(ingestResp.status, 200);

    const workRead = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadResp.body.blob_id)}?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(workRead.status, 200);
    assert.equal(await workRead.text(), 'work blob');

    const personalRead = await fetchJson(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadResp.body.blob_id)}?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_personal`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(personalRead.status, 404);
    assert.equal(personalRead.body.error.code, 'blob_not_found');
    assert.equal((await draftStore.get('cin_spotify_draft')).status, 'draft');

    const draftUploadResp = await fetchJson(
      `${rsUrl}/v1/blobs?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_draft&stream=top_artists&record_key=draft_blob`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'text/plain',
        },
        body: 'draft blob',
      },
    );
    assert.equal(draftUploadResp.status, 200, JSON.stringify(draftUploadResp.body));
    assert.equal(draftUploadResp.body.object, 'blob');
    assert.equal((await draftStore.get('cin_spotify_draft')).status, 'draft');
  } finally {
    await closeServer(server);
  }
});

test('reference run and schedule actions reject ambiguous connector-only admission', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);

    const scheduleReadResp = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`);
    assert.equal(scheduleReadResp.status, 400);
    assert.equal(scheduleReadResp.body.error.code, 'ambiguous_connector_instance');

    const runResp = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/run`, {
      method: 'POST',
    });
    assert.equal(runResp.status, 400);
    assert.equal(runResp.body.error.code, 'ambiguous_connector_instance');

    const scheduleResp = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 3600 }),
    });
    assert.equal(scheduleResp.status, 400);
    assert.equal(scheduleResp.body.error.code, 'ambiguous_connector_instance');

    const pauseResp = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule/pause`, {
      method: 'POST',
    });
    assert.equal(pauseResp.status, 400);
    assert.equal(pauseResp.body.error.code, 'ambiguous_connector_instance');

    const resumeResp = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule/resume`, {
      method: 'POST',
    });
    assert.equal(resumeResp.status, 400);
    assert.equal(resumeResp.body.error.code, 'ambiguous_connector_instance');

    const deleteResp = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`, {
      method: 'DELETE',
    });
    assert.equal(deleteResp.status, 400);
    assert.equal(deleteResp.body.error.code, 'ambiguous_connector_instance');
  } finally {
    await closeServer(server);
  }
});

test('reference connections list and detail expose owner-facing instance labels', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    // The wire exposes the canonical operational key, not the manifest's
    // URL-shaped connector_id (canonicalize-connector-keys Decision 1).
    const canonicalConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    await seedTwoSpotifyInstances(connectorId);

    const listResp = await fetchJson(`${asUrl}/_ref/connections?connector_id=${encodeURIComponent(connectorId)}`);
    assert.equal(listResp.status, 200);
    assert.equal(listResp.body.object, 'list');
    assert.deepEqual(
      listResp.body.data.map((connection) => [connection.connector_instance_id, connection.display_name]),
      [
        ['cin_spotify_personal', 'Spotify - personal'],
        ['cin_spotify_work', 'Spotify - work'],
      ],
    );

    const detailResp = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_work`);
    assert.equal(detailResp.status, 200);
    assert.equal(detailResp.body.object, 'ref_connection');
    assert.equal(detailResp.body.connector_id, canonicalConnectorId);
    assert.equal(detailResp.body.connector_instance_id, 'cin_spotify_work');
    assert.equal(detailResp.body.display_name, 'Spotify - work');
  } finally {
    await closeServer(server);
  }
});

test('reference connection schedule actions target one connector instance', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    const canonicalConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    await seedTwoSpotifyInstances(connectorId);

    const personalPut = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_personal/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 3600, enabled: true }),
    });
    assert.equal(personalPut.status, 200);
    assert.equal(personalPut.body.connector_id, canonicalConnectorId);
    assert.equal(personalPut.body.connector_instance_id, 'cin_spotify_personal');
    assert.equal(personalPut.body.enabled, true);

    const workPut = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_work/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 7200, enabled: true }),
    });
    assert.equal(workPut.status, 200);
    assert.equal(workPut.body.connector_instance_id, 'cin_spotify_work');

    const pauseResp = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_work/schedule/pause`, {
      method: 'POST',
    });
    assert.equal(pauseResp.status, 200);
    assert.equal(pauseResp.body.connector_instance_id, 'cin_spotify_work');
    assert.equal(pauseResp.body.enabled, false);

    const listResp = await fetchJson(`${asUrl}/_ref/connections?connector_id=${encodeURIComponent(connectorId)}`);
    assert.equal(listResp.status, 200);
    const schedules = new Map(listResp.body.data.map((connection) => [
      connection.connector_instance_id,
      connection.schedule,
    ]));
    assert.equal(schedules.get('cin_spotify_personal').enabled, true);
    assert.equal(schedules.get('cin_spotify_work').enabled, false);
  } finally {
    await closeServer(server);
  }
});

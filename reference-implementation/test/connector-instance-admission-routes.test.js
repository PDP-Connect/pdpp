import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const NOW = '2026-05-18T12:00:00.000Z';

async function closeServer(server) {
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
  await store.upsert({
    connectorInstanceId: 'cin_spotify_personal',
    ownerSubjectId: 'owner_local',
    connectorId,
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
    connectorId,
    displayName: 'Spotify - work',
    sourceKind: 'account',
    sourceBindingKey: 'acct_work',
    sourceBinding: { account_hint: 'work' },
    createdAt: NOW,
    updatedAt: NOW,
  });
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

test('owner-auth state route rejects explicit connector_instance_id until storage is migrated', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const ownerToken = await issueOwnerToken(asUrl);

    const resp = await fetchJson(
      `${rsUrl}/v1/state/${encodeURIComponent(connectorId)}?connector_instance_id=cin_spotify_work`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    );

    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, 'connector_instance_storage_not_migrated');
  } finally {
    await closeServer(server);
  }
});

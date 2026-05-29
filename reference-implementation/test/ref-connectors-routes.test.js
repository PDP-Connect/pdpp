/**
 * Route regression tests for the `_ref/connectors`, `_ref/connections`,
 * and `_ref/connector-instances` route family extracted to
 * `server/routes/ref-connectors.ts`.
 *
 * Exercises each mounted route at the HTTP level to catch wiring
 * regressions that operation-level and auth-gate tests cannot reach.
 * Server runs in open mode (no owner password) so auth does not mask
 * routing errors. Each test verifies the response status code and a
 * top-level envelope discriminator or error code.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const NOW = '2026-05-28T12:00:00.000Z';
const OWNER_SUBJECT_ID = 'owner_local';
const SPOTIFY_INSTANCE_ID = 'cin_spotify_test';

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

async function withServer(fn) {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

async function registerSpotifyManifest(asUrl) {
  const manifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register spotify failed: ${resp.status}`);
  return manifest;
}

function connectorKeyForManifest(manifest) {
  return canonicalConnectorKeyFromManifest(manifest) ?? manifest.connector_id;
}

async function seedSpotifyInstance(connectorId) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId: SPOTIFY_INSTANCE_ID,
    ownerSubjectId: OWNER_SUBJECT_ID,
    connectorId,
    displayName: 'Spotify - test',
    sourceKind: 'account',
    sourceBindingKey: 'acct_test',
    sourceBinding: { account_hint: 'test' },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

test('GET /_ref/connectors returns list envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  });
});

test('GET /_ref/connectors/:connectorId returns not_found for unknown connector', async () => {
  await withServer(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors/does_not_exist`);
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'not_found');
  });
});

test('GET /_ref/connectors/:connectorId returns ref_connector_detail for registered connector', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    const connectorId = connectorKeyForManifest(manifest);
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`,
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'ref_connector_detail');
    assert.equal(body.connector_id, connectorId);
  });
});

test('GET /_ref/connectors/:connectorId/schedule returns not_found when no schedule exists', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    const connectorId = connectorKeyForManifest(manifest);
    await seedSpotifyInstance(connectorId);
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
    );
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'not_found');
  });
});

test('GET /_ref/connections returns list envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/connections`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  });
});

test('GET /_ref/connector-instances returns list envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/connector-instances`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  });
});

test('GET /_ref/connections projects display_name and schedule for seeded instance', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    const connectorId = connectorKeyForManifest(manifest);
    await seedSpotifyInstance(connectorId);
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections?connector_id=${encodeURIComponent(connectorId)}`,
    );
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].object, 'ref_connection');
    assert.equal(body.data[0].connector_instance_id, SPOTIFY_INSTANCE_ID);
    assert.equal(body.data[0].display_name, 'Spotify - test');
    assert.equal(body.data[0].schedule, null);
  });
});

test('GET /_ref/connections/:connectorInstanceId returns ref_connection envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}`,
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'ref_connection');
    assert.equal(body.connector_instance_id, SPOTIFY_INSTANCE_ID);
  });
});

test('GET /_ref/connector-instances/:connectorInstanceId returns ref_connection envelope (alias)', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connector-instances/${SPOTIFY_INSTANCE_ID}`,
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'ref_connection');
    assert.equal(body.connector_instance_id, SPOTIFY_INSTANCE_ID);
  });
});

test('PATCH /_ref/connections/:connectorInstanceId rejects empty display_name with invalid_request', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: '   ' }),
      },
    );
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    assert.equal(body?.error?.param, 'display_name');
  });
});

test('PATCH /_ref/connections/:connectorInstanceId updates owner-facing display_name', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'Renamed' }),
      },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'ref_connection');
    assert.equal(body.connector_instance_id, SPOTIFY_INSTANCE_ID);
    assert.equal(body.display_name, 'Renamed');
  });
});

test('POST /_ref/connections/:connectorInstanceId/run returns 202 (started run)', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    const resp = await fetchJson(`${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/run`, {
      method: 'POST',
    });
    assert.equal(resp.status, 202);
    assert.ok(resp.body !== null && typeof resp.body === 'object');
  });
});

test('PUT /_ref/connections/:connectorInstanceId/schedule upserts and returns schedule', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    const connectorId = connectorKeyForManifest(manifest);
    await seedSpotifyInstance(connectorId);
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval_seconds: 3600, enabled: true }),
      },
    );
    assert.equal(status, 200);
    assert.equal(body.connector_id, connectorId);
    assert.equal(body.connector_instance_id, SPOTIFY_INSTANCE_ID);
    assert.equal(body.enabled, true);
  });
});

test('POST /_ref/connections/:connectorInstanceId/schedule/pause disables an existing schedule', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    await fetchJson(`${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 3600, enabled: true }),
    });
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule/pause`,
      { method: 'POST' },
    );
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
  });
});

test('POST /_ref/connections/:connectorInstanceId/schedule/resume enables a paused schedule', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    await fetchJson(`${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 3600, enabled: false }),
    });
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule/resume`,
      { method: 'POST' },
    );
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
  });
});

test('DELETE /_ref/connections/:connectorInstanceId/schedule returns 204 after deletion', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    await fetchJson(`${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval_seconds: 3600, enabled: true }),
    });
    const resp = await fetch(`${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule`, {
      method: 'DELETE',
    });
    assert.equal(resp.status, 204);
  });
});

test('DELETE /_ref/connections/:connectorInstanceId/schedule returns 404 when nothing to delete', async () => {
  await withServer(async ({ asUrl }) => {
    const manifest = await registerSpotifyManifest(asUrl);
    await seedSpotifyInstance(connectorKeyForManifest(manifest));
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${SPOTIFY_INSTANCE_ID}/schedule`,
      { method: 'DELETE' },
    );
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'not_found');
  });
});

// ─── Source-identity boundary: canonical key on the wire ─────────────────
//
// These tests pin the invariant that `/_ref/connections` and
// `/_ref/connections/:id` MUST NOT expose URL-shaped connector_id values
// in their responses even when the storage row carries a registry URL (a
// pre-migration state). The `projectRefConnection` function canonicalizes
// via `ctx.canonicalConnectorKey` at the response boundary so downstream
// consumers (dashboard, MCP tools, clients) never see URL-shaped IDs.

const SPOTIFY_URL_ID = 'https://registry.pdpp.org/connectors/spotify';
const PRE_MIGRATION_INSTANCE_ID = 'cin_spotify_pre_migration';

function seedSpotifyInstanceWithUrlId() {
  // Bypass the normalizing store to simulate a pre-migration row that carries
  // a URL-shaped connector_id. The connectors FK must be satisfied first, so
  // we INSERT OR IGNORE a raw connectors row under the URL id before inserting
  // the instance. In production this situation arises when the migration has
  // not yet run; the projection boundary must canonicalize regardless.
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)',
  ).run(SPOTIFY_URL_ID, JSON.stringify({ connector_id: SPOTIFY_URL_ID }), NOW);
  db.prepare(
    `INSERT OR IGNORE INTO connector_instances(
      connector_instance_id, owner_subject_id, connector_id, display_name,
      status, source_kind, source_binding_key, source_binding_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'account', 'acct_pre', '{}', ?, ?)`,
  ).run(PRE_MIGRATION_INSTANCE_ID, OWNER_SUBJECT_ID, SPOTIFY_URL_ID, 'Spotify pre-migration', NOW, NOW);
}

test('GET /_ref/connections projects canonical connector_key even when storage row carries a URL-shaped connector_id', async () => {
  await withServer(async ({ asUrl }) => {
    // Register Spotify so the connector row exists (required by the FK and
    // namespace resolver). The manifest carries the URL connector_id;
    // registerConnector normalizes it to the canonical key. The instance
    // is then seeded with the raw URL id to simulate a pre-migration row.
    await registerSpotifyManifest(asUrl);
    seedSpotifyInstanceWithUrlId();

    const { status, body } = await fetchJson(`${asUrl}/_ref/connections`);
    assert.equal(status, 200);
    const row = body.data.find((r) => r.connector_instance_id === PRE_MIGRATION_INSTANCE_ID);
    assert.ok(row, 'pre-migration instance must appear in list');
    assert.equal(
      row.connector_id,
      'spotify',
      'URL-shaped connector_id must be projected as the canonical short key',
    );
    assert.ok(
      !row.connector_id.startsWith('https://'),
      'connector_id MUST NOT start with https:// on the wire',
    );
  });
});

test('GET /_ref/connections canonical connector_id filter matches pre-migration URL-id instance', async () => {
  await withServer(async ({ asUrl }) => {
    await registerSpotifyManifest(asUrl);
    seedSpotifyInstanceWithUrlId();

    const { status, body } = await fetchJson(`${asUrl}/_ref/connections?connector_id=spotify`);
    assert.equal(status, 200);
    const row = body.data.find((r) => r.connector_instance_id === PRE_MIGRATION_INSTANCE_ID);
    assert.ok(row, 'canonical connector_id filter must match pre-migration instance');
    assert.equal(row.connector_id, 'spotify');
  });
});

test('GET /_ref/connections/:id projects canonical connector_key for pre-migration URL-id instance', async () => {
  await withServer(async ({ asUrl }) => {
    await registerSpotifyManifest(asUrl);
    seedSpotifyInstanceWithUrlId();

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/connections/${PRE_MIGRATION_INSTANCE_ID}`,
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'ref_connection');
    assert.equal(
      body.connector_id,
      'spotify',
      'URL-shaped connector_id must be projected as the canonical short key on detail',
    );
  });
});

test('GET /_ref/connector-instances projects canonical connector_key for pre-migration URL-id instance', async () => {
  await withServer(async ({ asUrl }) => {
    await registerSpotifyManifest(asUrl);
    seedSpotifyInstanceWithUrlId();

    const { status, body } = await fetchJson(`${asUrl}/_ref/connector-instances`);
    assert.equal(status, 200);
    const row = body.data.find((r) => r.connector_instance_id === PRE_MIGRATION_INSTANCE_ID);
    assert.ok(row, 'pre-migration instance must appear in connector-instances list');
    assert.equal(
      row.connector_id,
      'spotify',
      'URL-shaped connector_id must be projected as the canonical short key on connector-instances list',
    );
  });
});

test('GET /_ref/connector-instances canonical connector_id filter matches pre-migration URL-id instance', async () => {
  await withServer(async ({ asUrl }) => {
    await registerSpotifyManifest(asUrl);
    seedSpotifyInstanceWithUrlId();

    const { status, body } = await fetchJson(`${asUrl}/_ref/connector-instances?connector_id=spotify`);
    assert.equal(status, 200);
    const row = body.data.find((r) => r.connector_instance_id === PRE_MIGRATION_INSTANCE_ID);
    assert.ok(row, 'canonical connector_id filter must match pre-migration instance');
    assert.equal(row.connector_id, 'spotify');
  });
});

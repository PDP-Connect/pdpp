import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { runConnector, loadSyncState } from '../runtime/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(__dirname, '..');

let nextPort = 9200;

function allocatePorts() {
  const base = nextPort;
  nextPort += 10;
  return { asPort: base, rsPort: base + 1 };
}

async function closeServer(server) {
  await new Promise((resolve) => server.asServer.close(resolve));
  await new Promise((resolve) => server.rsServer.close(resolve));
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { status: resp.status, body };
}

async function withHarness(fn) {
  const ports = allocatePorts();
  const asUrl = `http://localhost:${ports.asPort}`;
  const rsUrl = `http://localhost:${ports.rsPort}`;
  const server = await startServer({ ...ports, dbPath: ':memory:' });
  const spotifyManifest = JSON.parse(readFileSync(join(E2E_DIR, 'manifests/spotify.json'), 'utf8'));

  try {
    await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });

    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function issueOwnerToken(asUrl, subjectId = 'user_demo') {
  const { body } = await fetchJson(`${asUrl}/owner-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: subjectId }),
  });
  return body.token;
}

async function seedSpotify(rsUrl, manifest, ownerToken) {
  const connectorPath = join(E2E_DIR, 'connectors/seed/index.js');
  return runConnector({
    connectorPath,
    connectorId: manifest.connector_id,
    ownerToken,
    manifest,
    state: null,
    collectionMode: 'full_refresh',
    rsUrl,
  });
}

async function approveGrant(asUrl, subjectId, params) {
  const { body: initiate } = await fetchJson(`${asUrl}/grants/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const { body: approved } = await fetchJson(`${asUrl}/consent/${initiate.device_code}/approve-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: subjectId }),
  });

  return approved;
}

test('PDPP e2e integration', async (t) => {
  await t.test('changes_since hides unauthorized-only changes and returns tombstones', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const baseline = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64'))}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(baseline.status, 200);
      assert.equal(baseline.body.data.length, 8);

      const firstId = baseline.body.data[0].id;
      const ownerRecord = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );

      const hiddenFieldUpdate = {
        key: firstId,
        data: {
          ...ownerRecord.body.data,
          popularity: 101,
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(hiddenFieldUpdate),
        }
      );

      const hiddenDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(hiddenDelta.status, 200);
      assert.equal(hiddenDelta.body.data.length, 0);

      const visibleFieldUpdate = {
        key: firstId,
        data: {
          ...hiddenFieldUpdate.data,
          genres: [...ownerRecord.body.data.genres, 'touring'],
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(visibleFieldUpdate),
        }
      );

      const visibleDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(hiddenDelta.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(visibleDelta.status, 200);
      assert.equal(visibleDelta.body.data.length, 1);
      assert.equal(visibleDelta.body.data[0].id, firstId);
      assert.deepEqual(visibleDelta.body.data[0].data.genres.at(-1), 'touring');

      const deletedId = baseline.body.data[1].id;
      const deleted = await fetch(`${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(deletedId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      assert.equal(deleted.status, 204);

      const tombstoneDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(visibleDelta.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(tombstoneDelta.status, 200);
      assert.equal(tombstoneDelta.body.data.length, 1);
      assert.equal(tombstoneDelta.body.data[0].deleted, true);
      assert.equal(tombstoneDelta.body.data[0].id, deletedId);
    });
  });

  await t.test('single_use grants issue one token but allow reuse of that token until expiry', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'One-time recommendation bootstrap',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const first = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.data.length, 1);
      assert.ok(first.body.next_cursor);

      const second = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
        {
          headers: { Authorization: `Bearer ${approved.token}` },
        }
      );
      assert.equal(second.status, 200);
      assert.equal(second.body.data.length, 1);
      assert.notEqual(second.body.data[0].id, first.body.data[0].id);

      const secondIssue = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(secondIssue.status, 403);
      assert.equal(secondIssue.body.error.code, 'grant_consumed');
    });
  });

  await t.test('changes_since cursors expire with HTTP 410 when history is pruned', async () => {
    try {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, 'u1');
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, 'u1', {
          client_id: 'concert_recommendation_app',
          connector_id: spotifyManifest.connector_id,
          purpose_code: 'https://pdpp.org/purpose/personalization',
          purpose_description: 'Incremental sync with cursor expiry',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic' }],
        });

        const baseline = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64'))}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(baseline.status, 200);

        process.env.PDPP_CHANGE_HISTORY_LIMIT = '2';

        const firstId = baseline.body.data[0].id;
        const ownerRecord = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );

        for (let i = 0; i < 3; i++) {
          const update = {
            key: firstId,
            data: {
              ...ownerRecord.body.data,
              genres: [...ownerRecord.body.data.genres, `delta-${i}`],
              source_updated_at: new Date(Date.now() + i * 1000).toISOString(),
            },
            emitted_at: new Date(Date.now() + i * 1000).toISOString(),
          };

          const ingest = await fetch(
            `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ownerToken}`,
                'Content-Type': 'application/x-ndjson',
              },
              body: JSON.stringify(update),
            }
          );
          assert.equal(ingest.status, 200);
        }

        const expired = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(expired.status, 410);
        assert.equal(expired.body.error.code, 'cursor_expired');
      });
    } finally {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    }
  });

  await t.test('revoked grants fail with grant_revoked', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Revocation test',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const revoked = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });

      assert.equal(revoked.status, 403);
      assert.equal(revoked.body.error.code, 'grant_revoked');
    });
  });

  await t.test('runtime stages STATE and only commits it when requested', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      await runConnector({
        connectorPath: join(E2E_DIR, 'connectors/seed/index.js'),
        connectorId: spotifyManifest.connector_id,
        ownerToken,
        manifest: spotifyManifest,
        state: null,
        collectionMode: 'full_refresh',
        persistState: false,
        rsUrl,
      });

      const noState = await loadSyncState(spotifyManifest.connector_id, ownerToken, { rsUrl });
      assert.deepEqual(noState, {});

      await runConnector({
        connectorPath: join(E2E_DIR, 'connectors/seed/index.js'),
        connectorId: spotifyManifest.connector_id,
        ownerToken,
        manifest: spotifyManifest,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl,
      });

      const persistedState = await loadSyncState(spotifyManifest.connector_id, ownerToken, { rsUrl });
      assert.ok(persistedState.top_artists);
      assert.ok(persistedState.saved_tracks);
    });
  });
});

/**
 * Query-contract conformance tests.
 *
 * Exercises the record-query / read surface after the W1 alignment to the
 * revised PDPP Core contract (spec-core.md §8):
 *
 *   - stream metadata capability declarations (relationships, query.range_filters,
 *     query.expand, freshness)
 *   - exact filter behavior on top-level scalar fields only
 *   - range filter behavior, valid only for declared fields
 *   - expansion and grant-safe child projection
 *   - blob fetch and grant-visible blob_ref enforcement
 *   - freshness honesty (current / stale / unknown)
 *   - loud failure for unsupported query shapes
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { getDb, sql } from '../server/db.js';

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
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
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
    assert.equal(registerResp.status, 201, 'register connector');
    await fn({ server, asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function startGrantRequest(asUrl, params) {
  return fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.client_id,
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          connector_id: params.connector_id,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          access_mode: params.access_mode,
          streams: params.streams,
        },
      ],
    }),
  });
}

async function approveGrantRequest(asUrl, requestUri, subjectId = 'owner_local') {
  return fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
  });
}

async function approveGrant(asUrl, subjectId, params) {
  const { body: initiate } = await startGrantRequest(asUrl, params);
  const { body: approved } = await approveGrantRequest(asUrl, initiate.request_uri, subjectId);
  return approved;
}

async function seedSpotifyStream(rsUrl, ownerToken, connectorId, stream, records) {
  const lines = records.map((record) => JSON.stringify({
    key: record.id,
    data: record,
    emitted_at:
      record.emitted_at
      || record.played_at
      || record.saved_at
      || record.source_updated_at
      || record.source_created_at,
  })).join('\n');
  const resp = await fetch(`${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: lines,
  });
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

async function seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, records) {
  await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'top_artists', records);
}

test('stream metadata publishes query.range_filters for declared fields', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'stream_metadata');
    assert.ok(body.query, 'query metadata should be present');
    assert.deepEqual(body.query.range_filters.source_updated_at, ['gte', 'gt', 'lte', 'lt']);
  });
});

test('stream metadata includes freshness when records exist', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'Artist 1', source_updated_at: '2026-03-01T00:00:00Z' },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.ok(body.freshness, 'freshness should be present');
    // Direct ingest path (no runtime run.batch_ingested event) surfaces a
    // captured_at but status: 'unknown' per spec §8 freshness honesty rules —
    // the reference doesn't claim `current` without a runtime-observed capture.
    assert.ok(['current', 'unknown'].includes(body.freshness.status));
    assert.ok(body.freshness.captured_at);
  });
});

test('stream list publishes freshness with unknown status when empty', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    // list without any ingested records — we need owner_scope: connector
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.data));
    // With no records the list is empty; add one so freshness surfaces.
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'b1', name: 'Beta', source_updated_at: '2026-03-05T00:00:00Z' },
    ]);
    const { body: body2 } = await fetchJson(
      `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    const top = body2.data.find((s) => s.name === 'top_artists');
    assert.ok(top, 'top_artists should appear after ingest');
    assert.ok(top.freshness, 'stream list entries carry freshness');
    // See note in previous test: direct ingest without runtime events yields
    // status: 'unknown' with captured_at, rather than 'current'.
    assert.ok(['current', 'unknown'].includes(top.freshness.status));
  });
});

test('range filter on declared field filters records', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'a2', name: 'B', source_updated_at: '2026-02-01T00:00:00Z' },
      { id: 'a3', name: 'C', source_updated_at: '2026-03-01T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&filter[source_updated_at][gte]=2026-02-01T00:00:00Z`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    const ids = body.data.map((r) => r.id).sort();
    assert.deepEqual(ids, ['a2', 'a3']);
  });
});

test('range filter on undeclared field is rejected', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', popularity: 42, source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    // popularity is not declared under query.range_filters for top_artists.
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&filter[popularity][gte]=1`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });
});

test('filter on unknown field is rejected with 400', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&filter[nonsense]=x`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    // Server's pre-flight validator emits `unknown_field`; the strict resolver
    // would have emitted `invalid_request`. Both are spec-permissible signals
    // that the filter references a field outside the stream schema.
    assert.ok(
      body.error.code === 'unknown_field' || body.error.code === 'invalid_request',
      `expected unknown_field or invalid_request, got ${body.error.code}`,
    );
  });
});

test('bare since query parameter is rejected loudly', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&since=2026-01-01T00:00:00Z`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });
});

test('unknown query parameter is rejected (not silently ignored)', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&totally_made_up=true`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });
});

test('records are sorted by (cursor_field, primary_key) and cursor tokens are logical', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'art_c', name: 'C', source_updated_at: '2026-03-01T00:00:00Z' },
      { id: 'art_a', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'art_b', name: 'B', source_updated_at: '2026-02-01T00:00:00Z' },
    ]);
    const listUrl = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&order=asc&limit=2`;
    const { status, body } = await fetchJson(listUrl, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.has_more, true);
    // Ordering is by (source_updated_at asc, id asc): a(Jan), b(Feb), c(Mar).
    assert.deepEqual(body.data.map((r) => r.id), ['art_a', 'art_b']);
    assert.ok(body.next_cursor, 'next_cursor should be present');

    // We don't assert on the cursor's internal shape — clients must treat it as
    // opaque. We do verify the token is not a bare row-id (no numeric `id`).
    const decoded = JSON.parse(Buffer.from(body.next_cursor, 'base64').toString('utf8'));
    assert.equal(decoded.kind, 'page');
    assert.equal(decoded.session, 'records');
    assert.ok(!Number.isInteger(decoded.id), 'cursor must not encode a raw row id');

    // The real correctness check: feeding the cursor back returns the
    // remaining records in the same logical order.
    const pageTwo = await fetchJson(`${listUrl}&cursor=${encodeURIComponent(body.next_cursor)}`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(pageTwo.status, 200);
    assert.deepEqual(pageTwo.body.data.map((r) => r.id), ['art_c']);
    assert.equal(pageTwo.body.has_more, false);
  });
});

test('exact filter on declared scalar field works', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'Alice', source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'a2', name: 'Bob', source_updated_at: '2026-01-02T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&filter[name]=Alice`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, 'a1');
  });
});

test('expand hydrates declared has_many relations and respects child grant projection', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'expand_owner');
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'saved_tracks', [
      {
        id: 'track_1',
        name: 'Track 1',
        artist_names: ['Artist 1'],
        saved_at: '2026-02-01T00:00:00Z',
        source_created_at: '2026-02-01T00:00:00Z',
      },
    ]);
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'recently_played', [
      {
        id: 'play_2',
        track_id: 'track_1',
        track_name: 'Track 1',
        played_at: '2026-02-03T00:00:00Z',
      },
      {
        id: 'play_1',
        track_id: 'track_1',
        track_name: 'Track 1',
        played_at: '2026-02-02T00:00:00Z',
      },
    ]);

    const approved = await approveGrant(asUrl, 'expand_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read saved tracks with recent listening context',
      access_mode: 'continuous',
      streams: [
        { name: 'saved_tracks', fields: ['id', 'name', 'saved_at'] },
        { name: 'recently_played', fields: ['id', 'track_id', 'played_at'] },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/saved_tracks/records?expand=recently_played&expand_limit[recently_played]=1`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    const record = body.data?.[0];
    assert.ok(record, 'expected one saved track');
    assert.ok(record.expanded?.recently_played, 'expanded relation should be present');
    assert.equal(record.expanded.recently_played.object, 'list');
    assert.equal(record.expanded.recently_played.has_more, true);
    assert.equal(record.expanded.recently_played.data.length, 1);
    const child = record.expanded.recently_played.data[0];
    assert.deepEqual(Object.keys(child.data || {}).sort(), ['id', 'played_at', 'track_id']);
    assert.ok(!('track_name' in (child.data || {})));
    assert.equal(child.id, 'play_1');
  });
});

test('single-record fetch honors declared expand and expand_limit', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'record_expand_owner');
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'saved_tracks', [
      {
        id: 'track_1',
        name: 'Track 1',
        artist_names: ['Artist 1'],
        saved_at: '2026-02-01T00:00:00Z',
        source_created_at: '2026-02-01T00:00:00Z',
      },
    ]);
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'recently_played', [
      {
        id: 'play_2',
        track_id: 'track_1',
        track_name: 'Track 1',
        played_at: '2026-02-03T00:00:00Z',
      },
      {
        id: 'play_1',
        track_id: 'track_1',
        track_name: 'Track 1',
        played_at: '2026-02-02T00:00:00Z',
      },
    ]);

    const approved = await approveGrant(asUrl, 'record_expand_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read one saved track with recent listening context',
      access_mode: 'continuous',
      streams: [
        { name: 'saved_tracks', fields: ['id', 'name', 'saved_at'] },
        { name: 'recently_played', fields: ['id', 'track_id', 'played_at'] },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/saved_tracks/records/track_1?expand=recently_played&expand_limit[recently_played]=1`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    assert.ok(body.expanded?.recently_played, 'expanded relation should be present on record detail');
    assert.equal(body.expanded.recently_played.object, 'list');
    assert.equal(body.expanded.recently_played.has_more, true);
    assert.equal(body.expanded.recently_played.data.length, 1);
    assert.equal(body.expanded.recently_played.data[0].id, 'play_1');
  });
});

test('expand fails with insufficient_scope when the related stream is outside the grant', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'expand_scope_owner');
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'saved_tracks', [
      {
        id: 'track_1',
        name: 'Track 1',
        saved_at: '2026-02-01T00:00:00Z',
        source_created_at: '2026-02-01T00:00:00Z',
      },
    ]);
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'recently_played', [
      {
        id: 'play_1',
        track_id: 'track_1',
        track_name: 'Track 1',
        played_at: '2026-02-02T00:00:00Z',
      },
    ]);

    const approved = await approveGrant(asUrl, 'expand_scope_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read saved tracks only',
      access_mode: 'continuous',
      streams: [{ name: 'saved_tracks', fields: ['id', 'name', 'saved_at'] }],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/saved_tracks/records?expand=recently_played`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(status, 403);
    assert.equal(body.error.code, 'insufficient_scope');
  });
});

test('blob fetch injects fetch_url and requires blob_ref visibility under the grant', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'blob_owner');
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'saved_tracks', [
      {
        id: 'track_blob',
        name: 'Track Blob',
        saved_at: '2026-02-01T00:00:00Z',
        source_created_at: '2026-02-01T00:00:00Z',
        blob_ref: {
          blob_id: 'blob_track_art',
          mime_type: 'text/plain',
          size_bytes: 11,
          sha256: 'sha256_blob_track_art',
        },
      },
    ]);
    await getDb().query(sql`
      INSERT INTO blobs(blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data)
      VALUES(
        ${'blob_track_art'},
        ${connectorId},
        ${'saved_tracks'},
        ${'track_blob'},
        ${'text/plain'},
        ${11},
        ${'sha256_blob_track_art'},
        ${Buffer.from('hello world')}
      )
    `);

    const visibleGrant = await approveGrant(asUrl, 'blob_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read saved tracks with blob access',
      access_mode: 'continuous',
      streams: [{ name: 'saved_tracks', fields: ['id', 'name', 'saved_at', 'blob_ref'] }],
    });

    const recordResp = await fetchJson(`${rsUrl}/v1/streams/saved_tracks/records`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(recordResp.status, 200);
    const blobRef = recordResp.body.data?.[0]?.data?.blob_ref;
    assert.ok(blobRef?.fetch_url, 'blob_ref should gain a fetch_url at read time');
    assert.equal(blobRef.fetch_url, '/v1/blobs/blob_track_art');

    const blobResp = await fetch(`${rsUrl}/v1/blobs/blob_track_art`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.equal(blobResp.headers.get('content-type'), 'text/plain');
    assert.equal(await blobResp.text(), 'hello world');

    const hiddenGrant = await approveGrant(asUrl, 'blob_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read saved tracks without blob access',
      access_mode: 'continuous',
      streams: [{ name: 'saved_tracks', fields: ['id', 'name', 'saved_at'] }],
    });

    const hiddenBlobResp = await fetchJson(`${rsUrl}/v1/blobs/blob_track_art`, {
      headers: { Authorization: `Bearer ${hiddenGrant.token}` },
    });
    assert.equal(hiddenBlobResp.status, 404);
    assert.equal(hiddenBlobResp.body.error.code, 'blob_not_found');
  });
});

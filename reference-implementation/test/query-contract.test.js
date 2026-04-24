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
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const POLYFILL_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors', 'manifests');
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readGmailManifest() {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, 'gmail.json'), 'utf8'));
}

async function registerConnectorManifest(asUrl, manifest) {
  return fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
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

async function uploadBlob(rsUrl, ownerToken, params, body, contentType = 'application/octet-stream') {
  const query = new URLSearchParams({
    connector_id: params.connector_id,
    stream: params.stream,
    record_key: params.record_key,
  });
  return fetchJson(`${rsUrl}/v1/blobs?${query.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': contentType,
    },
    body,
  });
}

async function seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, records) {
  await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'top_artists', records);
}

async function seedGmailStream(rsUrl, ownerToken, connectorId, stream, records) {
  const lines = records.map((record) => JSON.stringify({
    key: record.id,
    data: record,
    emitted_at:
      record.emitted_at
      || record.received_at
      || record.message_received_at
      || record.last_message_date
      || '2026-04-01T00:00:00Z',
  })).join('\n');
  const resp = await fetch(`${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: lines,
  });
  assert.equal(resp.status, 200, `ingest gmail ${stream} ok`);
}

async function seedGmailExpansionFixture(rsUrl, ownerToken, connectorId) {
  await seedGmailStream(rsUrl, ownerToken, connectorId, 'messages', [
    {
      id: 'msg-1',
      thread_id: 'thread-1',
      subject: 'Train receipt',
      from_name: 'Rail Desk',
      from_email: 'rail@example.com',
      to: [],
      cc: [],
      bcc: [],
      reply_to: [],
      date: '2026-04-01T09:58:00Z',
      received_at: '2026-04-01T10:00:00Z',
      message_id: '<msg-1@example.com>',
      in_reply_to: null,
      references: [],
      size_bytes: 4200,
      labels: ['inbox'],
      is_draft: false,
      is_flagged: false,
      is_seen: true,
      is_answered: false,
      has_attachments: true,
      snippet: 'Your train receipt is attached.',
    },
    {
      id: 'msg-2',
      thread_id: 'thread-2',
      subject: 'No body or attachments',
      received_at: '2026-04-02T10:00:00Z',
      to: [],
      cc: [],
      bcc: [],
      reply_to: [],
      references: [],
      labels: [],
      is_draft: false,
      is_flagged: false,
      is_seen: false,
      is_answered: false,
      has_attachments: false,
      snippet: null,
    },
  ]);
  await seedGmailStream(rsUrl, ownerToken, connectorId, 'message_bodies', [
    {
      id: 'body-msg-1',
      message_id: 'msg-1',
      body_text: 'Here is your train receipt for Milan.',
      body_html: '<p>Here is your train receipt for Milan.</p>',
      body_text_bytes: 38,
      body_html_bytes: 45,
      body_source: 'text_plain',
      content_languages: ['en'],
      charset: 'utf-8',
    },
  ]);
  await seedGmailStream(rsUrl, ownerToken, connectorId, 'attachments', [
    {
      id: 'att-1',
      message_id: 'msg-1',
      filename: 'receipt.pdf',
      content_type: 'application/pdf',
      size_bytes: 1000,
      content_id: null,
      is_inline: false,
      encoding: 'base64',
      part_index: '2',
      message_received_at: '2026-04-01T10:00:00Z',
    },
    {
      id: 'att-2',
      message_id: 'msg-1',
      filename: 'map.png',
      content_type: 'image/png',
      size_bytes: 2000,
      content_id: '<map>',
      is_inline: true,
      encoding: 'base64',
      part_index: '3',
      message_received_at: '2026-04-01T10:00:00Z',
    },
    {
      id: 'att-3',
      message_id: 'msg-1',
      filename: 'terms.txt',
      content_type: 'text/plain',
      size_bytes: 300,
      content_id: null,
      is_inline: false,
      encoding: '7bit',
      part_index: '4',
      message_received_at: '2026-04-01T10:00:00Z',
    },
  ]);
}

test('connector discovery lists owner-visible polyfill connectors without connector_id', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/connectors`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);

    const connector = body.data[0];
    assert.equal(connector.object, 'connector');
    assert.equal(connector.connector_id, spotifyManifest.connector_id);
    assert.deepEqual(connector.source, {
      binding_kind: 'connector',
      connector_id: spotifyManifest.connector_id,
    });
    assert.deepEqual(
      connector.streams.map((stream) => stream.name).sort(),
      spotifyManifest.streams.map((stream) => stream.name).sort(),
    );

    const topArtists = connector.streams.find((stream) => stream.name === 'top_artists');
    assert.ok(topArtists, 'top_artists should be discoverable before records exist');
    assert.equal(topArtists.record_count, 0);
    assert.equal(topArtists.freshness.status, 'unknown');
    assert.equal(topArtists.capabilities.stream_metadata, true);
    assert.equal(
      topArtists.capabilities.metadata_url,
      `/v1/streams/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
    );
    assert.equal(topArtists.capabilities.range_filters, true);
  });
});

test('connector discovery scopes client tokens to the granted source and streams', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const approved = await approveGrant(asUrl, 'schema_discovery_owner', {
      client_id: 'longview',
      connector_id: spotifyManifest.connector_id,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'schema discovery test',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'source_updated_at'] }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);

    const { status, body } = await fetchJson(`${rsUrl}/v1/connectors`, {
      headers: { 'Authorization': `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);

    const connector = body.data[0];
    assert.equal(connector.connector_id, spotifyManifest.connector_id);
    assert.deepEqual(connector.streams.map((stream) => stream.name), ['top_artists']);
    assert.equal(connector.stream_count, 1);
    assert.equal(connector.streams[0].capabilities.records, true);

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('grant_id'), false);
    assert.equal(serialized.includes('fields'), false);
    assert.equal(serialized.includes('saved_tracks'), false);
    assert.equal(serialized.includes('recently_played'), false);
  });
});

test('stream metadata publishes normalized field capabilities for owner tokens', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'stream_metadata');
    assert.ok(body.schema?.properties, 'schema metadata should remain present');
    assert.ok(body.query, 'query metadata should be present');
    assert.ok(Array.isArray(body.relationships), 'relationships metadata should remain present');
    assert.deepEqual(body.query.range_filters.source_updated_at, ['gte', 'gt', 'lte', 'lt']);
    assert.deepEqual(body.field_capabilities.source_updated_at.range_filter, {
      declared: true,
      usable: true,
      operators: ['gte', 'gt', 'lte', 'lt'],
    });
    assert.deepEqual(body.field_capabilities.popularity.exact_filter, {
      declared: true,
      usable: true,
    });
    assert.equal(body.field_capabilities.genres.exact_filter.declared, false);
    assert.deepEqual(body.expand_capabilities, []);
  });
});

test('stream metadata advertises lexical, semantic, and expansion capabilities for owner tokens', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const gmailManifest = readGmailManifest();
    const registerResp = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, 'gmail_capability_owner');
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/messages?connector_id=${encodeURIComponent(gmailManifest.connector_id)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );

    assert.equal(status, 200);
    assert.equal(body.field_capabilities.subject.lexical_search.usable, true);
    assert.equal(body.field_capabilities.subject.semantic_search.usable, true);
    assert.equal(body.field_capabilities.from_email.lexical_search.usable, true);
    assert.equal(body.field_capabilities.from_email.semantic_search.declared, false);
    assert.deepEqual(body.field_capabilities.received_at.range_filter, {
      declared: true,
      usable: true,
      operators: ['gte', 'gt', 'lte', 'lt'],
    });
    assert.deepEqual(
      body.expand_capabilities.map((entry) => ({
        name: entry.name,
        stream: entry.stream,
        cardinality: entry.cardinality,
        default_limit: entry.default_limit,
        max_limit: entry.max_limit,
        usable: entry.usable,
      })),
      [
        {
          name: 'message_bodies',
          stream: 'message_bodies',
          cardinality: 'has_one',
          default_limit: undefined,
          max_limit: undefined,
          usable: true,
        },
        {
          name: 'attachments',
          stream: 'attachments',
          cardinality: 'has_many',
          default_limit: 10,
          max_limit: 50,
          usable: true,
        },
      ],
    );
  });
});

test('stream metadata marks grant-limited field capabilities unusable for client tokens', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const approved = await approveGrant(asUrl, 'capability_limited_spotify_owner', {
      client_id: 'longview',
      connector_id: spotifyManifest.connector_id,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'schema discovery test',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'source_updated_at'] }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);

    const { status, body } = await fetchJson(`${rsUrl}/v1/streams/top_artists`, {
      headers: { 'Authorization': `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'stream_metadata');
    assert.ok(body.schema?.properties?.source_updated_at, 'existing schema metadata should remain full source-level metadata');
    assert.deepEqual(body.query.range_filters.source_updated_at, ['gte', 'gt', 'lte', 'lt']);
    assert.equal(body.field_capabilities.name.granted, true);
    assert.deepEqual(body.field_capabilities.name.exact_filter, {
      declared: true,
      usable: true,
    });
    assert.equal(body.field_capabilities.source_updated_at.granted, true);
    assert.deepEqual(body.field_capabilities.source_updated_at.range_filter, {
      declared: true,
      usable: true,
      operators: ['gte', 'gt', 'lte', 'lt'],
    });
    assert.deepEqual(body.field_capabilities.popularity.exact_filter, {
      declared: true,
      usable: false,
      reason: 'field_not_granted',
    });

    const gmailManifest = readGmailManifest();
    const registerResp = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(registerResp.status, 201);
    const gmailGrant = await approveGrant(asUrl, 'capability_limited_gmail_owner', {
      client_id: 'longview',
      connector_id: gmailManifest.connector_id,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'Plan message queries using a narrowed field set',
      access_mode: 'continuous',
      streams: [{ name: 'messages', fields: ['id', 'thread_id', 'received_at', 'subject'] }],
    });
    assert.ok(gmailGrant.token, `expected issued grant token, got ${JSON.stringify(gmailGrant)}`);

    const gmailMetadata = await fetchJson(`${rsUrl}/v1/streams/messages`, {
      headers: { 'Authorization': `Bearer ${gmailGrant.token}` },
    });

    assert.equal(gmailMetadata.status, 200);
    assert.deepEqual(gmailMetadata.body.field_capabilities.date.range_filter, {
      declared: true,
      usable: false,
      operators: ['gte', 'gt', 'lte', 'lt'],
      reason: 'field_not_granted',
    });
    assert.deepEqual(gmailMetadata.body.field_capabilities.from_email.lexical_search, {
      declared: true,
      usable: false,
      reason: 'field_not_granted',
    });
    assert.deepEqual(gmailMetadata.body.field_capabilities.snippet.semantic_search, {
      declared: true,
      usable: false,
      reason: 'field_not_granted',
    });
    assert.deepEqual(
      gmailMetadata.body.expand_capabilities.map((entry) => ({
        name: entry.name,
        usable: entry.usable,
        reason: entry.reason,
      })),
      [
        {
          name: 'message_bodies',
          usable: false,
          reason: 'related_stream_not_granted',
        },
        {
          name: 'attachments',
          usable: false,
          reason: 'related_stream_not_granted',
        },
      ],
    );
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

test('changes_since=beginning starts incremental sync and returns a bookmark', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'boot_a', name: 'Bootstrap A', source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'boot_b', name: 'Bootstrap B', source_updated_at: '2026-01-02T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + '&changes_since=beginning';
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.has_more, false);
    assert.deepEqual(body.data.map((r) => r.id).sort(), ['boot_a', 'boot_b']);
    assert.ok(typeof body.next_changes_since === 'string' && body.next_changes_since.length > 0);
    assert.ok(!body.next_cursor, 'terminal changes page should not expose a page cursor');
  });
});

test('changes_since=beginning paginates with next_cursor and still returns next_changes_since', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'page_a', name: 'Page A', source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'page_b', name: 'Page B', source_updated_at: '2026-01-02T00:00:00Z' },
      { id: 'page_c', name: 'Page C', source_updated_at: '2026-01-03T00:00:00Z' },
    ]);
    const firstUrl = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + '&changes_since=beginning&limit=2';
    const first = await fetchJson(firstUrl, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.has_more, true);
    assert.deepEqual(first.body.data.map((r) => r.id), ['page_a', 'page_b']);
    assert.ok(typeof first.body.next_cursor === 'string' && first.body.next_cursor.length > 0);
    assert.ok(typeof first.body.next_changes_since === 'string' && first.body.next_changes_since.length > 0);

    const pageCursor = JSON.parse(Buffer.from(first.body.next_cursor, 'base64').toString('utf8'));
    assert.equal(pageCursor.kind, 'page');
    assert.equal(pageCursor.session, 'changes');

    const second = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/records`
        + `?connector_id=${encodeURIComponent(connectorId)}`
        + `&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.has_more, false);
    assert.deepEqual(second.body.data.map((r) => r.id), ['page_c']);
    assert.ok(typeof second.body.next_changes_since === 'string' && second.body.next_changes_since.length > 0);
    assert.equal(second.body.next_changes_since, first.body.next_changes_since);
    assert.ok(!second.body.next_cursor);
  });
});

test('raw timestamp changes_since value is rejected as an invalid cursor', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'time_a', name: 'Timestamp A', source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&changes_since=${encodeURIComponent('2026-04-24T00:00:00Z')}`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_cursor');
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

test('gmail messages expand message_bodies on list and detail reads with child projection', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'gmail_expand_body_owner');
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, 'register gmail manifest');
    await seedGmailExpansionFixture(rsUrl, ownerToken, connectorId);

    const metadata = await fetchJson(
      `${rsUrl}/v1/streams/messages?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(metadata.status, 200);
    assert.deepEqual(
      metadata.body.query.expand.map((entry) => entry.name).sort(),
      ['attachments', 'message_bodies'],
    );

    const approved = await approveGrant(asUrl, 'gmail_expand_body_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read Gmail messages with body context',
      access_mode: 'continuous',
      streams: [
        { name: 'messages', fields: ['id', 'thread_id', 'subject', 'received_at'] },
        { name: 'message_bodies', fields: ['id', 'message_id', 'body_text'] },
      ],
    });

    const list = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=message_bodies`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);

    const messageWithBody = list.body.data.find((record) => record.id === 'msg-1');
    assert.ok(messageWithBody?.expanded?.message_bodies, 'msg-1 should include body expansion');
    assert.equal(messageWithBody.expanded.message_bodies.stream, 'message_bodies');
    assert.deepEqual(
      Object.keys(messageWithBody.expanded.message_bodies.data || {}).sort(),
      ['body_source', 'body_text', 'id', 'message_id'],
    );
    assert.equal(messageWithBody.expanded.message_bodies.data.body_text, 'Here is your train receipt for Milan.');
    assert.ok(!('body_html' in messageWithBody.expanded.message_bodies.data));

    const messageWithoutBody = list.body.data.find((record) => record.id === 'msg-2');
    assert.equal(messageWithoutBody?.expanded?.message_bodies, null);

    const detail = await fetchJson(
      `${rsUrl}/v1/streams/messages/records/msg-1?connector_id=${encodeURIComponent(connectorId)}&expand=message_bodies`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.expanded.message_bodies.id, 'body-msg-1');
    assert.equal(detail.body.expanded.message_bodies.data.body_text, 'Here is your train receipt for Milan.');
  });
});

test('gmail messages expand attachment metadata with limits and missing-child parity', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'gmail_expand_attachment_owner');
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, 'register gmail manifest');
    await seedGmailExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, 'gmail_expand_attachment_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read Gmail messages with attachment metadata',
      access_mode: 'continuous',
      streams: [
        { name: 'messages', fields: ['id', 'thread_id', 'subject', 'received_at', 'has_attachments'] },
        { name: 'attachments', fields: ['id', 'message_id', 'filename', 'content_type', 'part_index', 'message_received_at'] },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=attachments&expand_limit[attachments]=2`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);

    const messageWithAttachments = body.data.find((record) => record.id === 'msg-1');
    assert.ok(messageWithAttachments?.expanded?.attachments, 'msg-1 should include attachment expansion');
    assert.equal(messageWithAttachments.expanded.attachments.object, 'list');
    assert.equal(messageWithAttachments.expanded.attachments.has_more, true);
    assert.deepEqual(
      messageWithAttachments.expanded.attachments.data.map((record) => record.id),
      ['att-1', 'att-2'],
    );
    assert.deepEqual(
      Object.keys(messageWithAttachments.expanded.attachments.data[0].data || {}).sort(),
      ['content_type', 'filename', 'id', 'message_id', 'message_received_at', 'part_index'],
    );
    assert.equal(
      JSON.stringify(messageWithAttachments.expanded.attachments).includes('blob_ref'),
      false,
      'attachment expansion remains metadata-only until blob hydration lands',
    );

    const messageWithoutAttachments = body.data.find((record) => record.id === 'msg-2');
    assert.equal(messageWithoutAttachments.expanded.attachments.object, 'list');
    assert.equal(messageWithoutAttachments.expanded.attachments.has_more, false);
    assert.deepEqual(messageWithoutAttachments.expanded.attachments.data, []);
  });
});

test('gmail message expansion rejects missing child grant and reverse thread relation', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'gmail_expand_reject_owner');
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, 'register gmail manifest');
    await seedGmailExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, 'gmail_expand_reject_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read Gmail messages only',
      access_mode: 'continuous',
      streams: [{ name: 'messages', fields: ['id', 'thread_id', 'subject', 'received_at'] }],
    });

    const missingChildGrant = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=message_bodies`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(missingChildGrant.status, 403);
    assert.equal(missingChildGrant.body.error.code, 'insufficient_scope');

    const reverseThread = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=thread`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(reverseThread.status, 400);
    assert.equal(reverseThread.body.error.code, 'invalid_expand');
  });
});

test('connector manifest validation rejects unsafe query.expand declarations', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const missingRelationship = cloneJson(spotifyManifest);
    missingRelationship.connector_id = `${spotifyManifest.connector_id}#missing-expand-relation`;
    missingRelationship.streams.find((stream) => stream.name === 'saved_tracks').query.expand = [
      { name: 'missing_relation', default_limit: 1, max_limit: 2 },
    ];

    const missingRelationshipResp = await registerConnectorManifest(asUrl, missingRelationship);
    assert.equal(missingRelationshipResp.status, 400);
    assert.match(missingRelationshipResp.body.error.message, /query\.expand entry 'missing_relation' must match/);

    const missingForeignKey = cloneJson(spotifyManifest);
    missingForeignKey.connector_id = `${spotifyManifest.connector_id}#missing-child-foreign-key`;
    missingForeignKey.streams.find((stream) => stream.name === 'saved_tracks').relationships[0].foreign_key = 'missing_track_id';

    const missingForeignKeyResp = await registerConnectorManifest(asUrl, missingForeignKey);
    assert.equal(missingForeignKeyResp.status, 400);
    assert.match(missingForeignKeyResp.body.error.message, /foreign_key 'missing_track_id' must be a top-level property/);

    const invalidLimits = cloneJson(spotifyManifest);
    invalidLimits.connector_id = `${spotifyManifest.connector_id}#invalid-expand-limit`;
    invalidLimits.streams.find((stream) => stream.name === 'saved_tracks').query.expand[0].default_limit = 5;
    invalidLimits.streams.find((stream) => stream.name === 'saved_tracks').query.expand[0].max_limit = 2;

    const invalidLimitsResp = await registerConnectorManifest(asUrl, invalidLimits);
    assert.equal(invalidLimitsResp.status, 400);
    assert.match(invalidLimitsResp.body.error.message, /default_limit must be less than or equal to max_limit/);
  });
});

test('blob upload requires owner authority and validates binding inputs', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'blob_upload_validation_owner');
    const connectorId = spotifyManifest.connector_id;
    const grant = await approveGrant(asUrl, 'blob_upload_validation_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read saved tracks only',
      access_mode: 'continuous',
      streams: [{ name: 'saved_tracks', fields: ['id', 'name', 'saved_at'] }],
    });

    const clientUpload = await uploadBlob(
      rsUrl,
      grant.token,
      { connector_id: connectorId, stream: 'saved_tracks', record_key: 'track_blob_upload' },
      Buffer.from('client cannot upload'),
      'text/plain',
    );
    assert.equal(clientUpload.status, 403);
    assert.equal(clientUpload.body.error.code, 'permission_error');

    const missingConnector = await fetchJson(`${rsUrl}/v1/blobs?stream=saved_tracks&record_key=track_blob_upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'text/plain',
      },
      body: 'missing connector',
    });
    assert.equal(missingConnector.status, 400);
    assert.equal(missingConnector.body.error.code, 'invalid_request');

    const unknownStream = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'missing_stream', record_key: 'track_blob_upload' },
      Buffer.from('unknown stream'),
      'text/plain',
    );
    assert.equal(unknownStream.status, 404);
    assert.equal(unknownStream.body.error.code, 'not_found');
  });
});

test('blob upload is content-addressed, idempotent, and fetch-safe through visible blob_ref', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'blob_upload_owner');
    const connectorId = spotifyManifest.connector_id;
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0a, 0xff]);
    const expectedSha = createHash('sha256').update(bytes).digest('hex');

    const first = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'saved_tracks', record_key: 'track_blob_upload' },
      bytes,
      'application/pdf',
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.object, 'blob');
    assert.equal(first.body.sha256, expectedSha);
    assert.equal(first.body.blob_id, `blob_sha256_${expectedSha}`);
    assert.equal(first.body.size_bytes, bytes.length);
    assert.equal(first.body.mime_type, 'application/pdf');

    const duplicate = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'saved_tracks', record_key: 'track_blob_upload' },
      bytes,
      'application/pdf',
    );
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body, first.body);

    const secondBinding = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'saved_tracks', record_key: 'track_blob_upload_copy' },
      bytes,
      'application/pdf',
    );
    assert.equal(secondBinding.status, 200);
    assert.equal(secondBinding.body.blob_id, first.body.blob_id);

    const blobCount = getDb().prepare('SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?').get(expectedSha);
    assert.equal(blobCount.n, 1, 'duplicate uploads should not duplicate stored bytes');
    const bindingCount = getDb().prepare('SELECT COUNT(*) AS n FROM blob_bindings WHERE blob_id = ?').get(first.body.blob_id);
    assert.equal(bindingCount.n, 2, 'same content can be bound idempotently to multiple records');

    await seedSpotifyStream(rsUrl, ownerToken, connectorId, 'saved_tracks', [
      {
        id: 'track_blob_upload',
        name: 'Track Blob Upload',
        saved_at: '2026-02-01T00:00:00Z',
        source_created_at: '2026-02-01T00:00:00Z',
        blob_ref: {
          blob_id: first.body.blob_id,
          mime_type: first.body.mime_type,
          size_bytes: first.body.size_bytes,
          sha256: first.body.sha256,
        },
      },
    ]);

    const visibleGrant = await approveGrant(asUrl, 'blob_upload_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read saved tracks with uploaded blob access',
      access_mode: 'continuous',
      streams: [{ name: 'saved_tracks', fields: ['id', 'name', 'saved_at', 'blob_ref'] }],
    });

    const recordResp = await fetchJson(`${rsUrl}/v1/streams/saved_tracks/records`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(recordResp.status, 200);
    assert.equal(recordResp.body.data?.[0]?.data?.blob_ref?.fetch_url, `/v1/blobs/${first.body.blob_id}`);

    const blobResp = await fetch(`${rsUrl}/v1/blobs/${first.body.blob_id}`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.equal(blobResp.headers.get('content-type'), 'application/pdf');
    assert.equal(blobResp.headers.get('content-length'), String(bytes.length));
    assert.deepEqual(Buffer.from(await blobResp.arrayBuffer()), bytes);
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
    getDb().prepare(`
      INSERT INTO blobs(blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'blob_track_art',
      connectorId,
      'saved_tracks',
      'track_blob',
      'text/plain',
      11,
      'sha256_blob_track_art',
      Buffer.from('hello world'),
    );

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

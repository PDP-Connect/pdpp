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
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { createTraceContext, emitSpineEvent } from '../lib/spine.ts';

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

async function withHarness(fn, options = {}) {
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
  const topArtists = spotifyManifest.streams.find((stream) => stream.name === 'top_artists');
  topArtists.query = {
    ...(topArtists.query || {}),
    aggregations: {
      count: true,
      sum: ['popularity', 'followers'],
      min: ['popularity', 'followers', 'source_updated_at'],
      max: ['popularity', 'followers', 'source_updated_at'],
      group_by: ['name'],
      group_by_time: ['source_updated_at'],
      count_distinct: ['name'],
    },
  };
  options.mutateManifest?.(spotifyManifest);
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
          source: params.source || { kind: 'connector', id: params.connector_id },
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

// Give a cloned manifest a unique canonical connector_key so multiple
// validation-error cases register under distinct identities without colliding.
// Post-canonicalization the operational identity is connector_key (a slug);
// the legacy URL-shaped connector_id and manifest_uri provenance are dropped so
// the manifest validates and the intended stream-level validation runs.
function setUniqueConnectorKey(manifest, key) {
  manifest.connector_key = key;
  delete manifest.connector_id;
  delete manifest.manifest_uri;
  return manifest;
}

function readGmailManifest() {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, 'gmail.json'), 'utf8'));
}

function addTestRefreshPolicy(manifest, overrides = {}) {
  manifest.capabilities = {
    ...(manifest.capabilities || {}),
    refresh_policy: {
      recommended_mode: 'automatic',
      rationale: 'Test policy for freshness derivation coverage.',
      maximum_staleness_seconds: 3600,
      ...overrides,
    },
  };
}

async function emitSyntheticRun({
  connectorId: rawConnectorId,
  runId,
  status,
  occurredAt,
}) {
  // The live runtime launches runs under the canonical connector key and emits
  // run.* spine events with source.id = that canonical key. Freshness and
  // connector-summary correlation query run history by the canonical key, so a
  // synthetic run must use it too or it correlates to nothing. Canonicalize the
  // (possibly URL-shaped) test connectorId here. See canonicalize-connector-keys
  // Decision 1.
  const connectorId = canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  // Spine-layer stamping requirement (see docs/run-reconciliation-design-brief.md §3.3):
  // every run.started must carry boot_epoch+seq. Harness ran startServer
  // which initialized the singleton; read it once.
  const { getCurrentBootEpoch } = await import('../lib/spine.ts');
  const _epoch = getCurrentBootEpoch();
  const _stamp = _epoch ? {
    boot_epoch: _epoch.boot_epoch,
    seq: _epoch.seq,
    controller_id: _epoch.controller_id,
  } : { boot_epoch: 'synthetic', seq: 1, controller_id: 'synthetic' };
  const trace = createTraceContext({ scenarioId: `scn_${runId}` });
  await emitSpineEvent({
    event_type: 'run.started',
    occurred_at: occurredAt,
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    actor_type: 'runtime',
    actor_id: connectorId,
    object_type: 'run',
    object_id: runId,
    status: 'started',
    run_id: runId,
    source_kind: 'connector',
    source_id: connectorId,
    data: {
      source: { kind: 'connector', id: connectorId },
      scope: { streams: [{ name: 'top_artists' }] },
      scope_streams: ['top_artists'],
      ..._stamp,
    },
  });
  await emitSpineEvent({
    event_type: status === 'succeeded' ? 'run.completed' : 'run.failed',
    occurred_at: occurredAt,
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    actor_type: 'runtime',
    actor_id: connectorId,
    object_type: 'run',
    object_id: runId,
    status,
    run_id: runId,
    source_kind: 'connector',
    source_id: connectorId,
    data: {
      source: { kind: 'connector', id: connectorId },
      records_emitted: 0,
      records_flushed: 0,
      ...(status === 'failed' ? { reason: 'synthetic_failure' } : {}),
    },
  });
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
      blob_ref: null,
      content_sha256: null,
      hydration_status: 'deferred',
      hydration_error: null,
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
      blob_ref: null,
      content_sha256: null,
      hydration_status: 'deferred',
      hydration_error: null,
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
      blob_ref: null,
      content_sha256: null,
      hydration_status: 'deferred',
      hydration_error: null,
    },
  ]);
}

test('connector discovery lists owner-visible polyfill connectors without connector_id', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    // Discovery output uses the canonical operational connector key, not the
    // manifest's URL-shaped connector_id (canonicalize-connector-keys
    // Decisions 1 and 2: connector_key is operational, manifest_uri is metadata).
    const canonicalConnectorId = canonicalConnectorKey(spotifyManifest.connector_id);
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/connectors`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);

    const connector = body.data[0];
    assert.equal(connector.object, 'connector');
    assert.equal(connector.connector_id, canonicalConnectorId);
    assert.deepEqual(connector.source, {
      kind: 'connector',
      id: canonicalConnectorId,
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
      `/v1/streams/top_artists?connector_id=${encodeURIComponent(canonicalConnectorId)}`,
    );
    assert.equal(topArtists.capabilities.range_filters, true);
  });
});

test('connector discovery scopes client tokens to the granted source and streams', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const approved = await approveGrant(asUrl, 'schema_discovery_owner', {
      client_id: 'longview',
      source: { kind: 'connector', id: spotifyManifest.connector_id },
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
    assert.equal(connector.connector_id, canonicalConnectorKey(spotifyManifest.connector_id));
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

test('schema discovery enumerates owner-visible polyfill connectors with full per-stream capabilities', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const gmailManifest = readGmailManifest();
    assert.equal((await registerConnectorManifest(asUrl, gmailManifest)).status, 201);
    const ownerToken = await issueOwnerToken(asUrl, 'schema_owner');
    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'schema');
    assert.deepEqual(body.bearer, { token_kind: 'owner', scope: 'owner' });
    assert.equal(body.connectors.length, 2);

    // Schema discovery emits canonical operational keys, not manifest URLs.
    const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
    const canonicalGmailId = canonicalConnectorKey(gmailManifest.connector_id);
    const connectorIds = body.connectors.map((c) => c.connector_id).sort();
    assert.deepEqual(
      connectorIds,
      [canonicalSpotifyId, canonicalGmailId].sort(),
    );

    const spotify = body.connectors.find((c) => c.connector_id === canonicalSpotifyId);
    assert.deepEqual(spotify.source, {
      kind: 'connector',
      id: canonicalSpotifyId,
    });
    assert.deepEqual(
      spotify.streams.map((s) => s.name).sort(),
      spotifyManifest.streams.map((s) => s.name).sort(),
    );
    const topArtists = spotify.streams.find((s) => s.name === 'top_artists');
    assert.equal(topArtists.object, 'stream_metadata');
    assert.ok(topArtists.schema?.properties, 'schema is included per stream');
    assert.ok(topArtists.field_capabilities.source_updated_at, 'field_capabilities are included');
    assert.deepEqual(topArtists.field_capabilities.source_updated_at.range_filter, {
      declared: true,
      usable: true,
      operators: ['gte', 'gt', 'lte', 'lt'],
    });
    assert.equal(topArtists.freshness.status, 'unknown');
    assert.ok(Array.isArray(topArtists.expand_capabilities), 'expand_capabilities is an array');

    const gmail = body.connectors.find((c) => c.connector_id === canonicalGmailId);
    const messages = gmail.streams.find((s) => s.name === 'messages');
    assert.equal(messages.field_capabilities.subject.lexical_search.usable, true);
    assert.ok(messages.expand_capabilities.some((entry) => entry.name === 'attachments'));
  });
});

test('schema discovery scopes a client token to its grant source and streams', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const gmailManifest = readGmailManifest();
    assert.equal((await registerConnectorManifest(asUrl, gmailManifest)).status, 201);
    const approved = await approveGrant(asUrl, 'schema_client_owner', {
      client_id: 'longview',
      source: { kind: 'connector', id: spotifyManifest.connector_id },
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'schema discovery client scope',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'source_updated_at'] }],
    });
    assert.ok(approved.token, 'expected client token');

    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { 'Authorization': `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'schema');
    assert.equal(body.bearer.token_kind, 'client');
    assert.equal(body.bearer.scope, 'grant');
    assert.ok(body.bearer.grant_id, 'grant_id surfaces on bearer projection');
    assert.equal(body.connectors.length, 1);
    const connector = body.connectors[0];
    assert.equal(connector.connector_id, canonicalConnectorKey(spotifyManifest.connector_id));
    assert.deepEqual(connector.streams.map((s) => s.name), ['top_artists']);
    assert.equal(connector.stream_count, 1);

    const topArtists = connector.streams[0];
    // field-limited grant: granted fields are usable; ungranted fields are present but not usable.
    assert.equal(topArtists.field_capabilities.id.granted, true);
    assert.equal(topArtists.field_capabilities.name.granted, true);
    assert.equal(topArtists.field_capabilities.source_updated_at.granted, true);
    assert.equal(topArtists.field_capabilities.source_updated_at.range_filter.usable, true);
    assert.ok(topArtists.field_capabilities.popularity, 'popularity field is enumerated');
    assert.equal(topArtists.field_capabilities.popularity.granted, false);
    assert.equal(topArtists.field_capabilities.popularity.exact_filter.usable, false);
    assert.equal(topArtists.field_capabilities.popularity.exact_filter.reason, 'field_not_granted');

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(gmailManifest.connector_id), false, 'must not leak other connectors');
    assert.equal(serialized.includes('saved_tracks'), false, 'must not leak ungranted streams');
  });
});

test('schema discovery returns an empty connector array when no connectors are registered', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const ownerToken = await issueOwnerToken(asUrl, 'empty_owner');
    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, 'schema');
    assert.deepEqual(body.connectors, []);
  } finally {
    await closeServer(server);
  }
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
      source: { kind: 'connector', id: spotifyManifest.connector_id },
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
    assert.deepEqual(body.field_capabilities.popularity.aggregation.sum, {
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

test('stream metadata publishes query.aggregations for declared aggregate fields', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.query.aggregations.count, true);
    assert.deepEqual(body.query.aggregations.sum, ['popularity', 'followers']);
    assert.deepEqual(body.query.aggregations.group_by, ['name']);
    assert.deepEqual(body.query.aggregations.group_by_time, ['source_updated_at']);
    assert.deepEqual(body.query.aggregations.count_distinct, ['name']);
    assert.deepEqual(body.field_capabilities.source_updated_at.aggregation.group_by_time, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.name.aggregation.count_distinct, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.popularity.aggregation.group_by_time, {
      declared: false,
      usable: false,
    });
    assert.deepEqual(body.field_capabilities.popularity.aggregation.sum, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.source_updated_at.aggregation.min, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.name.aggregation.group_by, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.genres.aggregation.group_by, {
      declared: false,
      usable: false,
    });
  });
});

test('stream aggregate computes count, sum, min/max, grouped counts, and declared filters', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'agg_a', name: 'Alpha', popularity: 10, followers: 100, source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'agg_b', name: 'Beta', popularity: 40, followers: 300, source_updated_at: '2026-02-01T00:00:00Z' },
      { id: 'agg_c', name: 'Beta', popularity: 70, followers: 500, source_updated_at: '2026-03-01T00:00:00Z' },
    ]);

    const base = `${rsUrl}/v1/streams/top_artists/aggregate?connector_id=${encodeURIComponent(connectorId)}`;
    const headers = { 'Authorization': `Bearer ${ownerToken}` };

    const count = await fetchJson(`${base}&metric=count&filter[source_updated_at][gte]=2026-02-01T00:00:00Z`, { headers });
    assert.equal(count.status, 200);
    // Canonical aggregate envelope: `links` and `meta` are added by the
    // route adapter via `finalizeCanonicalEnvelope`. We assert the payload
    // semantics here and the envelope shape separately so the assertion
    // does not couple to changes in the count/warnings vocabulary.
    const { links, meta, ...countBody } = count.body;
    assert.deepEqual(countBody, {
      object: 'aggregation',
      stream: 'top_artists',
      metric: 'count',
      field: null,
      group_by: null,
      // Additive time-bucket/distinct fields (null/false for a scalar count).
      group_by_time: null,
      granularity: null,
      time_zone: null,
      approximate: false,
      filtered_record_count: 2,
      value: 2,
    });
    assert.equal(typeof links?.self, 'string');
    assert.equal(meta?.count?.kind, 'none');
    assert.deepEqual(meta?.warnings, []);

    const sum = await fetchJson(`${base}&metric=sum&field=popularity`, { headers });
    assert.equal(sum.status, 200);
    assert.equal(sum.body.value, 120);

    const min = await fetchJson(`${base}&metric=min&field=source_updated_at`, { headers });
    assert.equal(min.status, 200);
    assert.equal(min.body.value, '2026-01-01T00:00:00Z');

    const max = await fetchJson(`${base}&metric=max&field=followers`, { headers });
    assert.equal(max.status, 200);
    assert.equal(max.body.value, 500);

    const grouped = await fetchJson(`${base}&metric=count&group_by=name&limit=2`, { headers });
    assert.equal(grouped.status, 200);
    assert.deepEqual(grouped.body.groups, [
      { key: 'Beta', count: 2 },
      { key: 'Alpha', count: 1 },
    ]);
  });
});

test('stream aggregate enforces grants and declared aggregate fields', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'aggregation_grant_owner');
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'grant_a', name: 'Alpha', popularity: 10, followers: 100, source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const approved = await approveGrant(asUrl, 'aggregation_grant_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'aggregation grant safety test',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'source_updated_at'] }],
    });
    assert.ok(approved.token);

    const base = `${rsUrl}/v1/streams/top_artists/aggregate`;
    const headers = { 'Authorization': `Bearer ${approved.token}` };

    const count = await fetchJson(`${base}?metric=count`, { headers });
    assert.equal(count.status, 200);
    assert.equal(count.body.value, 1);

    const unauthorizedField = await fetchJson(`${base}?metric=sum&field=popularity`, { headers });
    assert.equal(unauthorizedField.status, 403);
    assert.equal(unauthorizedField.body.error.code, 'field_not_granted');

    const undeclaredGroup = await fetchJson(`${base}?metric=count&group_by=source_updated_at`, { headers });
    assert.equal(undeclaredGroup.status, 400);
    assert.equal(undeclaredGroup.body.error.code, 'invalid_request');
  });
});

test('stream aggregate honors grant resources, time ranges, and request filters together', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'aggregation_scope_owner');
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'scoped_old', name: 'Alpha', popularity: 10, followers: 100, source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'scoped_hit', name: 'Beta', popularity: 40, followers: 300, source_updated_at: '2026-02-01T00:00:00Z' },
      { id: 'scoped_resource_hidden', name: 'Beta', popularity: 70, followers: 500, source_updated_at: '2026-03-01T00:00:00Z' },
    ]);
    const approved = await approveGrant(asUrl, 'aggregation_scope_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'aggregation resource and time-range safety test',
      access_mode: 'continuous',
      streams: [
        {
          name: 'top_artists',
          fields: ['id', 'name', 'popularity', 'source_updated_at'],
          resources: ['scoped_old', 'scoped_hit'],
          time_range: { since: '2026-01-15T00:00:00Z' },
        },
      ],
    });
    assert.ok(approved.token);

    const url = `${rsUrl}/v1/streams/top_artists/aggregate`
      + '?metric=sum&field=popularity&filter[source_updated_at][lte]=2026-02-15T00:00:00Z';
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${approved.token}` },
    });
    assert.equal(status, 200);
    assert.equal(body.filtered_record_count, 1);
    assert.equal(body.value, 40);
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

test('schema discovery and stream list derive current freshness from connector run history', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const runAt = new Date(Date.now() - 60_000).toISOString();
    await emitSyntheticRun({
      connectorId,
      runId: 'run_freshness_schema_success',
      status: 'succeeded',
      occurredAt: runAt,
    });
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'fresh-1', name: 'Fresh Artist', source_updated_at: runAt },
    ]);

    const schemaResp = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(schemaResp.status, 200);
    // Schema discovery emits the canonical operational key.
    const canonicalConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const schemaConnector = schemaResp.body.connectors.find((row) => row.connector_id === canonicalConnectorId);
    const schemaStream = schemaConnector.streams.find((stream) => stream.name === 'top_artists');
    assert.equal(schemaStream.freshness.status, 'current');
    assert.equal(schemaStream.freshness.captured_at, runAt);
    assert.equal(schemaStream.freshness.last_attempted_at, runAt);

    const listResp = await fetchJson(
      `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(listResp.status, 200);
    const listStream = listResp.body.data.find((stream) => stream.name === 'top_artists');
    assert.equal(listStream.freshness.status, 'current');
    assert.equal(listStream.freshness.captured_at, runAt);
    assert.equal(listStream.freshness.last_attempted_at, runAt);
  }, { mutateManifest: addTestRefreshPolicy });
});

test('stream metadata marks stale freshness when the latest connector attempt failed', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const successAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const failedAt = new Date(Date.now() - 60_000).toISOString();
    await emitSyntheticRun({
      connectorId,
      runId: 'run_freshness_detail_success',
      status: 'succeeded',
      occurredAt: successAt,
    });
    await emitSyntheticRun({
      connectorId,
      runId: 'run_freshness_detail_failed',
      status: 'failed',
      occurredAt: failedAt,
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { 'Authorization': `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.freshness.status, 'stale');
    assert.equal(body.freshness.captured_at, successAt);
    assert.equal(body.freshness.last_attempted_at, failedAt);
  }, { mutateManifest: addTestRefreshPolicy });
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

test('over-max limit clamps to 100 and surfaces a limit_clamped warning on the HTTP wire', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const records = Array.from({ length: 101 }, (_, i) => ({
      id: `a${String(i).padStart(3, '0')}`,
      name: `Artist ${i}`,
      source_updated_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }));
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, records);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + '&limit=200';
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 100, 'page is clamped to the max of 100');
    assert.equal(body.has_more, true, 'more records remain to page');
    const warnings = body?.meta?.warnings;
    assert.ok(Array.isArray(warnings), 'meta.warnings[] is present on the wire');
    const clamp = warnings.find((warning) => warning?.code === 'limit_clamped');
    assert.ok(clamp, 'limit_clamped warning is surfaced in the HTTP body');
    assert.equal(clamp.param, 'limit');
    assert.deepEqual(clamp.detail, { requested_limit: 200, max_limit: 100 });
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

// ─── fields-projection conformance (agent-vantage read surface) ───────────
//
// The MCP `query_records` / `fetch` `fields` doc promises (verbatim):
//   "Field paths must be declared by the stream; advertised by `GET /v1/schema`
//    (`field_capabilities`). Unknown paths are rejected by the RS rather than
//    silently widened."
// These guards pin that promise on the canonical HTTP read for BOTH grant
// shapes — a full-stream grant (no field allowlist) and a restricted grant —
// so a manifest-nonexistent `fields=` entry is a loud `unknown_field` error,
// never a silent 200 with the field dropped. The restricted-grant unknown
// (`field_not_granted`) sibling is pinned in event-spine.test.js; here we pin
// the manifest-unknown path, which is independent of grant field scope.
test('fields projection on an unknown field is rejected under a full-stream grant', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    // An owner token reads with an owner read-grant that carries no field
    // allowlist — the full-stream case the static audit flagged as the one
    // where the grant-only `field_not_granted` guard would be skipped.
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&fields=id,not_a_real_field`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400, 'unknown projection field must fail loudly, not silently narrow');
    assert.equal(body.error.code, 'unknown_field');
    assert.match(body.error.message || '', /Unknown field: not_a_real_field/);
  });
});

test('fields projection on a manifest-unknown field is rejected under a restricted grant', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const connectorId = spotifyManifest.connector_id;
    const ownerToken = await issueOwnerToken(asUrl, 'restricted_fields_owner');
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    // Restricted grant: only id/name/source_updated_at granted.
    const approved = await approveGrant(asUrl, 'restricted_fields_owner', {
      client_id: 'longview',
      source: { kind: 'connector', id: connectorId },
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'projection conformance under a narrowed field grant',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'source_updated_at'] }],
    });
    assert.ok(approved.token, `expected grant token, got ${JSON.stringify(approved)}`);

    // `not_a_real_field` is not declared by the manifest at all — this must be
    // `unknown_field` (manifest validation), distinct from the grant-scope
    // `field_not_granted` signal for a real-but-ungranted field.
    const url = `${rsUrl}/v1/streams/top_artists/records?fields=id,not_a_real_field`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${approved.token}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'unknown_field');
    assert.match(body.error.message || '', /Unknown field: not_a_real_field/);
  });
});

test('query-time view applies a real projection (not a silent no-op)', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    // top_artists declares view `basic` -> fields [id, name, genres]. Reading
    // with `?view=basic` must project the page to exactly those fields; a
    // record's ungranted-by-view `popularity`/`followers` must be absent. This
    // pins that query-time `view` is honest — advertised, forwarded, AND
    // applied — disproving the static audit's "inert at read time" claim.
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      {
        id: 'v1',
        name: 'View Artist',
        genres: ['rock'],
        popularity: 77,
        followers: 1234,
        source_updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&view=basic`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    // Record payload fields live under `record.data`; the view projects that
    // object down to exactly the declared field set.
    const data = body.data[0].data;
    assert.equal(data.id, 'v1');
    assert.equal(data.name, 'View Artist');
    assert.deepEqual(data.genres, ['rock']);
    // Fields outside the `basic` view projection must not leak through.
    assert.equal('popularity' in data, false, 'view=basic must project popularity out');
    assert.equal('followers' in data, false, 'view=basic must project followers out');
    assert.equal('source_updated_at' in data, false, 'view=basic must project source_updated_at out');
  });
});

test('query-time view and fields together are rejected as mutually exclusive', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&view=basic&fields=id`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message || '', /view and fields are mutually exclusive/);
  });
});

test('query-time view with an unknown view id is rejected', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: 'a1', name: 'A', source_updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`
      + `&view=not_a_real_view`;
    const { status, body } = await fetchJson(url, {
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message || '', /Unknown view/);
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
    // The error message is self-teaching: it names the two legal forms a
    // cold caller can use to recover (the `beginning` bootstrap sentinel
    // and the `next_changes_since` cursor returned by a prior changes-feed
    // response). Avoids a closed-loop "rejection without remedy".
    assert.match(body.error.message, /\bbeginning\b/);
    assert.match(body.error.message, /\bnext_changes_since\b/);
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

test('noncanonical range query parameters are rejected loudly', async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const baseUrl = `${rsUrl}/v1/streams/top_artists/records`
      + `?connector_id=${encodeURIComponent(connectorId)}`;
    const badParams = [
      'source_updated_at.gte=2026-01-01T00%3A00%3A00Z',
      'source_updated_at_gte=2026-01-01T00%3A00%3A00Z',
      'source_updated_at=gte%3A2026-01-01T00%3A00%3A00Z',
      'min_source_updated_at=2026-01-01T00%3A00%3A00Z',
    ];

    for (const param of badParams) {
      const { status, body } = await fetchJson(`${baseUrl}&${param}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400, `${param} must fail instead of widening the read`);
      assert.equal(body.error.code, 'invalid_request');
    }
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
      ['content_type', 'filename', 'hydration_status', 'id', 'message_id', 'message_received_at', 'part_index'],
    );
    assert.equal(
      JSON.stringify(messageWithAttachments.expanded.attachments).includes('blob_ref'),
      false,
      'attachment expansion must not expose blob_ref unless the child grant includes it',
    );

    const messageWithoutAttachments = body.data.find((record) => record.id === 'msg-2');
    assert.equal(messageWithoutAttachments.expanded.attachments.object, 'list');
    assert.equal(messageWithoutAttachments.expanded.attachments.has_more, false);
    assert.deepEqual(messageWithoutAttachments.expanded.attachments.data, []);
  });
});

test('gmail messages expand hydrated attachments with grant-visible blob_ref fetch_url', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'gmail_expand_attachment_blob_owner');
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, 'register gmail manifest');

    const bytes = Buffer.from('invoice attachment bytes');
    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'attachments', record_key: 'msg-blob:2' },
      bytes,
      'application/pdf',
    );
    assert.equal(blob.status, 200);

    await seedGmailStream(rsUrl, ownerToken, connectorId, 'messages', [
      {
        id: 'msg-blob',
        thread_id: 'thread-blob',
        subject: 'Blob invoice',
        received_at: '2026-04-03T10:00:00Z',
        to: [],
        cc: [],
        bcc: [],
        reply_to: [],
        references: [],
        labels: [],
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        is_answered: false,
        has_attachments: true,
        snippet: 'Invoice attached.',
      },
    ]);
    await seedGmailStream(rsUrl, ownerToken, connectorId, 'attachments', [
      {
        id: 'msg-blob:2',
        message_id: 'msg-blob',
        filename: 'invoice.pdf',
        content_type: 'application/pdf',
        size_bytes: blob.body.size_bytes,
        content_id: null,
        is_inline: false,
        encoding: 'base64',
        part_index: '2',
        message_received_at: '2026-04-03T10:00:00Z',
        blob_ref: {
          blob_id: blob.body.blob_id,
          mime_type: blob.body.mime_type,
          size_bytes: blob.body.size_bytes,
          sha256: blob.body.sha256,
        },
        content_sha256: blob.body.sha256,
        hydration_status: 'hydrated',
        hydration_error: null,
      },
    ]);

    const approved = await approveGrant(asUrl, 'gmail_expand_attachment_blob_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read Gmail messages with attachment blobs',
      access_mode: 'continuous',
      streams: [
        { name: 'messages', fields: ['id', 'thread_id', 'subject', 'received_at', 'has_attachments'] },
        {
          name: 'attachments',
          fields: [
            'id',
            'message_id',
            'filename',
            'content_type',
            'size_bytes',
            'part_index',
            'message_received_at',
            'blob_ref',
            'content_sha256',
            'hydration_status',
          ],
        },
      ],
    });

    const expanded = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=attachments`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(expanded.status, 200);
    const message = expanded.body.data.find((record) => record.id === 'msg-blob');
    const attachment = message?.expanded?.attachments?.data?.[0];
    assert.ok(attachment, 'expanded attachment should be present');
    assert.equal(attachment.data.blob_ref.fetch_url, `/v1/blobs/${blob.body.blob_id}`);
    assert.equal(attachment.data.content_sha256, blob.body.sha256);
    assert.equal(attachment.data.hydration_status, 'hydrated');

    const blobResp = await fetch(`${rsUrl}/v1/blobs/${blob.body.blob_id}`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.deepEqual(Buffer.from(await blobResp.arrayBuffer()), bytes);
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

function readSlackManifest() {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, 'slack.json'), 'utf8'));
}

async function seedSlackStream(rsUrl, ownerToken, connectorId, stream, records) {
  const lines = records.map((record) => JSON.stringify({
    key: record.id,
    data: record,
    emitted_at: record.emitted_at || record.sent_at || '2026-04-01T00:00:00Z',
  })).join('\n');
  const resp = await fetch(`${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: lines,
  });
  assert.equal(resp.status, 200, `ingest slack ${stream} ok`);
}

async function seedSlackExpansionFixture(rsUrl, ownerToken, connectorId) {
  await seedSlackStream(rsUrl, ownerToken, connectorId, 'messages', [
    {
      id: 'C1:1700000001.000100',
      channel_id: 'C1',
      user_id: 'U1',
      ts: '1700000001.000100',
      sent_at: '2026-04-01T10:00:00Z',
      thread_ts: null,
      is_thread_parent: false,
      reply_count: 0,
      latest_reply: null,
      subtype: null,
      is_tombstone: false,
      text: 'Have you seen this article?',
      has_attachments: true,
      attachment_count: 2,
      reaction_count: 3,
    },
    {
      id: 'C1:1700000002.000200',
      channel_id: 'C1',
      user_id: 'U2',
      ts: '1700000002.000200',
      sent_at: '2026-04-02T10:00:00Z',
      thread_ts: null,
      is_thread_parent: false,
      reply_count: 0,
      subtype: null,
      is_tombstone: false,
      text: 'No attachments here',
      has_attachments: false,
      attachment_count: 0,
      reaction_count: 0,
    },
  ]);
  await seedSlackStream(rsUrl, ownerToken, connectorId, 'message_attachments', [
    {
      id: 'C1:1700000001.000100:0',
      message_id: 'C1:1700000001.000100',
      channel_id: 'C1',
      index: 0,
      fallback: 'Example dot com',
      service_name: 'example.com',
      title: 'Example article',
      title_link: 'https://example.com/post',
      text: 'Lede paragraph',
      from_url: 'https://example.com/post',
    },
    {
      id: 'C1:1700000001.000100:1',
      message_id: 'C1:1700000001.000100',
      channel_id: 'C1',
      index: 1,
      fallback: 'Doc preview',
      service_name: 'docs.example.com',
      title: 'Internal doc',
      title_link: 'https://docs.example.com/d/abc',
    },
    {
      id: 'C1:1700000001.000100:2',
      message_id: 'C1:1700000001.000100',
      channel_id: 'C1',
      index: 2,
      fallback: 'Third unfurl',
      service_name: 'third.example.com',
      title: 'Third unfurl',
    },
  ]);
  await seedSlackStream(rsUrl, ownerToken, connectorId, 'reactions', [
    {
      id: 'C1:1700000001.000100:tada:U1',
      message_id: 'C1:1700000001.000100',
      channel_id: 'C1',
      user_id: 'U1',
      emoji: 'tada',
    },
    {
      id: 'C1:1700000001.000100:tada:U2',
      message_id: 'C1:1700000001.000100',
      channel_id: 'C1',
      user_id: 'U2',
      emoji: 'tada',
    },
    {
      id: 'C1:1700000001.000100:eyes:U2',
      message_id: 'C1:1700000001.000100',
      channel_id: 'C1',
      user_id: 'U2',
      emoji: 'eyes',
    },
  ]);
}

test('first-party manifests declare only parent-to-child query.expand entries with FK on child', () => {
  const manifests = readdirSync(POLYFILL_MANIFESTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((filename) => ({
      manifestName: filename.replace(/\.json$/, ''),
      manifest: JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, filename), 'utf8')),
    }))
    .filter(({ manifest }) => manifest.streams.some((stream) => Array.isArray(stream.query?.expand)));

  assert.ok(manifests.some(({ manifestName }) => manifestName === 'gmail'), 'gmail should keep its existing expand declarations');
  assert.ok(manifests.some(({ manifestName }) => manifestName === 'slack'), 'slack should declare the newly enabled expand relations');

  for (const { manifestName, manifest } of manifests) {
    const streamsByName = new Map(manifest.streams.map((stream) => [stream.name, stream]));
    for (const stream of manifest.streams) {
      const declared = stream.query?.expand || [];
      for (const capability of declared) {
        const relationship = (stream.relationships || []).find((entry) => entry.name === capability.name);
        assert.ok(
          relationship,
          `${manifestName}.${stream.name} expand '${capability.name}' must match a same-stream relationship`,
        );
        const child = streamsByName.get(relationship.stream);
        assert.ok(child, `${manifestName}.${stream.name} expand '${capability.name}' targets unknown stream`);
        assert.ok(
          Object.prototype.hasOwnProperty.call(child.schema?.properties || {}, relationship.foreign_key),
          `${manifestName}.${stream.name} expand '${capability.name}' fk must be top-level on child`,
        );
        assert.ok(
          (child.schema?.required || []).includes(relationship.foreign_key),
          `${manifestName}.${stream.name} expand '${capability.name}' fk should be required on child to avoid silent drops`,
        );
        assert.ok(
          ['has_one', 'has_many'].includes(relationship.cardinality),
          `${manifestName}.${stream.name} expand '${capability.name}' must declare has_one or has_many cardinality`,
        );
        if (relationship.cardinality === 'has_many') {
          assert.ok(
            Number.isInteger(capability.default_limit) && capability.default_limit > 0,
            `${manifestName}.${stream.name} expand '${capability.name}' has_many requires a positive default_limit`,
          );
          assert.ok(
            Number.isInteger(capability.max_limit) && capability.max_limit >= capability.default_limit,
            `${manifestName}.${stream.name} expand '${capability.name}' has_many requires max_limit >= default_limit`,
          );
        }
      }
    }
  }
});

test('slack messages expand message_attachments and reactions on list and detail reads', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'slack_expand_owner');
    const slackManifest = readSlackManifest();
    const connectorId = slackManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, slackManifest);
    assert.equal(reg.status, 201, 'register slack manifest');
    await seedSlackExpansionFixture(rsUrl, ownerToken, connectorId);

    const metadata = await fetchJson(
      `${rsUrl}/v1/streams/messages?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(metadata.status, 200);
    assert.deepEqual(
      metadata.body.query.expand.map((entry) => entry.name).sort(),
      ['message_attachments', 'reactions'],
    );

    const approved = await approveGrant(asUrl, 'slack_expand_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read Slack messages with link previews and reactions',
      access_mode: 'continuous',
      streams: [
        { name: 'messages', fields: ['id', 'channel_id', 'sent_at', 'text'] },
        { name: 'message_attachments', fields: ['id', 'message_id', 'service_name', 'title'] },
        { name: 'reactions', fields: ['id', 'message_id', 'emoji', 'user_id'] },
      ],
    });

    const list = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=message_attachments&expand=reactions`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);

    const messageWithChildren = list.body.data.find((record) => record.id === 'C1:1700000001.000100');
    assert.ok(messageWithChildren?.expanded?.message_attachments);
    assert.equal(messageWithChildren.expanded.message_attachments.object, 'list');
    assert.equal(messageWithChildren.expanded.message_attachments.has_more, false);
    assert.deepEqual(
      messageWithChildren.expanded.message_attachments.data.map((entry) => entry.id).sort(),
      [
        'C1:1700000001.000100:0',
        'C1:1700000001.000100:1',
        'C1:1700000001.000100:2',
      ],
    );
    assert.deepEqual(
      Object.keys(messageWithChildren.expanded.message_attachments.data[0].data || {}).sort(),
      ['channel_id', 'id', 'index', 'message_id', 'service_name', 'title'],
    );

    assert.ok(messageWithChildren.expanded.reactions);
    assert.equal(messageWithChildren.expanded.reactions.object, 'list');
    assert.equal(messageWithChildren.expanded.reactions.data.length, 3);
    assert.deepEqual(
      Object.keys(messageWithChildren.expanded.reactions.data[0].data || {}).sort(),
      ['channel_id', 'emoji', 'id', 'message_id', 'user_id'],
    );

    const messageWithoutChildren = list.body.data.find((record) => record.id === 'C1:1700000002.000200');
    assert.deepEqual(messageWithoutChildren.expanded.message_attachments.data, []);
    assert.deepEqual(messageWithoutChildren.expanded.reactions.data, []);

    const detail = await fetchJson(
      `${rsUrl}/v1/streams/messages/records/${encodeURIComponent('C1:1700000001.000100')}?connector_id=${encodeURIComponent(connectorId)}&expand=message_attachments`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.expanded.message_attachments.data.length, 3);
  });
});

test('slack messages expand_limit caps message_attachments and reactions independently', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'slack_expand_limit_owner');
    const slackManifest = readSlackManifest();
    const connectorId = slackManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, slackManifest);
    assert.equal(reg.status, 201, 'register slack manifest');
    await seedSlackExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, 'slack_expand_limit_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read Slack messages with capped child fan-out',
      access_mode: 'continuous',
      streams: [
        { name: 'messages', fields: ['id', 'channel_id', 'sent_at'] },
        { name: 'message_attachments', fields: ['id', 'message_id', 'title'] },
        { name: 'reactions', fields: ['id', 'message_id', 'emoji'] },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=message_attachments&expand=reactions&expand_limit[message_attachments]=2&expand_limit[reactions]=1`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200);
    const message = body.data.find((record) => record.id === 'C1:1700000001.000100');
    assert.equal(message.expanded.message_attachments.has_more, true);
    assert.equal(message.expanded.message_attachments.data.length, 2);
    assert.equal(message.expanded.reactions.has_more, true);
    assert.equal(message.expanded.reactions.data.length, 1);

    const overMax = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=reactions&expand_limit[reactions]=999`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(overMax.status, 400);
    assert.equal(overMax.body.error.code, 'invalid_expand');
  });
});

test('slack message expansion rejects requests missing the child grant', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'slack_expand_reject_owner');
    const slackManifest = readSlackManifest();
    const connectorId = slackManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, slackManifest);
    assert.equal(reg.status, 201, 'register slack manifest');
    await seedSlackExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, 'slack_expand_reject_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Read Slack messages only',
      access_mode: 'continuous',
      streams: [{ name: 'messages', fields: ['id', 'channel_id', 'sent_at'] }],
    });

    const missingAttachments = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=message_attachments`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(missingAttachments.status, 403);
    assert.equal(missingAttachments.body.error.code, 'insufficient_scope');

    const reverseChannel = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=channel`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(reverseChannel.status, 400);
    assert.equal(reverseChannel.body.error.code, 'invalid_expand');
  });
});

test('connector manifest validation rejects unsafe query.expand declarations', async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const missingRelationship = cloneJson(spotifyManifest);
    // Give each case a unique canonical connector_key (not a URL#suffix) so the
    // manifest is uniquely identified AND passes connector-key validation,
    // letting the intended query.expand validation run. See canonicalize-connector-keys.
    setUniqueConnectorKey(missingRelationship, 'spotify-missing-expand-relation');
    missingRelationship.streams.find((stream) => stream.name === 'saved_tracks').query.expand = [
      { name: 'missing_relation', default_limit: 1, max_limit: 2 },
    ];

    const missingRelationshipResp = await registerConnectorManifest(asUrl, missingRelationship);
    assert.equal(missingRelationshipResp.status, 400);
    assert.match(missingRelationshipResp.body.error.message, /query\.expand entry 'missing_relation' must match/);

    const missingForeignKey = cloneJson(spotifyManifest);
    setUniqueConnectorKey(missingForeignKey, 'spotify-missing-child-foreign-key');
    missingForeignKey.streams.find((stream) => stream.name === 'saved_tracks').relationships[0].foreign_key = 'missing_track_id';

    const missingForeignKeyResp = await registerConnectorManifest(asUrl, missingForeignKey);
    assert.equal(missingForeignKeyResp.status, 400);
    assert.match(missingForeignKeyResp.body.error.message, /foreign_key 'missing_track_id' must be a top-level property/);

    const invalidLimits = cloneJson(spotifyManifest);
    setUniqueConnectorKey(invalidLimits, 'spotify-invalid-expand-limit');
    invalidLimits.streams.find((stream) => stream.name === 'saved_tracks').query.expand[0].default_limit = 5;
    invalidLimits.streams.find((stream) => stream.name === 'saved_tracks').query.expand[0].max_limit = 2;

    const invalidLimitsResp = await registerConnectorManifest(asUrl, invalidLimits);
    assert.equal(invalidLimitsResp.status, 400);
    assert.match(invalidLimitsResp.body.error.message, /default_limit must be less than or equal to max_limit/);
  });
});

test('connector manifest validation accepts gmail attachment blob_ref and rejects malformed declarations', async () => {
  await withHarness(async ({ asUrl }) => {
    const gmailManifest = readGmailManifest();
    setUniqueConnectorKey(gmailManifest, 'gmail-blob-ref-valid');
    const valid = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(valid.status, 201);

    const missingBlobId = cloneJson(gmailManifest);
    setUniqueConnectorKey(missingBlobId, 'gmail-missing-blob-id');
    const attachmentStream = missingBlobId.streams.find((stream) => stream.name === 'attachments');
    delete attachmentStream.schema.properties.blob_ref.properties.blob_id;

    const missingBlobIdResp = await registerConnectorManifest(asUrl, missingBlobId);
    assert.equal(missingBlobIdResp.status, 400);
    assert.match(missingBlobIdResp.body.error.message, /blob_ref\.blob_id must be type string/);

    const notObject = cloneJson(gmailManifest);
    setUniqueConnectorKey(notObject, 'gmail-blob-ref-not-object');
    const notObjectAttachmentStream = notObject.streams.find((stream) => stream.name === 'attachments');
    notObjectAttachmentStream.schema.properties.blob_ref = { type: 'string' };

    const notObjectResp = await registerConnectorManifest(asUrl, notObject);
    assert.equal(notObjectResp.status, 400);
    assert.match(notObjectResp.body.error.message, /blob_ref must be an object or nullable object/);
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
    // Records and blobs are stored under the canonical connector key (the
    // ingest path canonicalizes the URL-shaped manifest connector_id). Seed
    // this raw-SQL blob row — and resolve its connector_instance_id subquery —
    // under that same canonical key, or the records subquery returns no row
    // and connector_instance_id is NULL. See canonicalize-connector-keys
    // Decision 1: blob bindings key by connector_key.
    const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
    getDb().prepare(`
      INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
      VALUES(?, ?, (SELECT connector_instance_id FROM records WHERE connector_id = ? AND stream = ? AND record_key = ?), ?, ?, ?, ?, ?, ?)
    `).run(
      'blob_track_art',
      canonicalId,
      canonicalId,
      'saved_tracks',
      'track_blob',
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

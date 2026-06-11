/**
 * B3 conformance — token introspection and resources[] doc proof.
 *
 * Verifies that the documented shapes in:
 *   - apps/site/content/docs/reference-implementation-examples.md (Examples 4 + 5)
 *   - docs/agent-skills/pdpp-data-access/references/grant-design.md
 *
 * match the actual responses returned by the reference implementation.
 *
 * Each test is self-contained: it starts a server, issues a grant, calls
 * POST /introspect, and asserts the documented field set.
 *
 * Gate: all tests green; documented JSON shapes match reality.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, 'manifests');

// ─── shared helpers ─────────────────────────────────────────────────────────

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
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

/**
 * Issue an owner token via the device flow. Needed to seed records before
 * issuing a client-scoped grant.
 */
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
    body: new URLSearchParams({
      user_code: device.user_code,
      subject_id: subjectId,
    }).toString(),
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

/**
 * Stage a PAR request and approve it in one call, returning the token and grant.
 */
async function issueClientGrant(asUrl, subjectId, params) {
  const { body: par } = await fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.client_id,
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: { kind: 'connector', id: params.connector_id },
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          access_mode: params.access_mode,
          streams: params.streams,
        },
      ],
    }),
  });
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_uri: par.request_uri,
      subject_id: subjectId,
    }),
  });
  return approved;
}

/**
 * Seed records into a stream via the NDJSON ingest endpoint.
 */
async function seedStream(rsUrl, ownerToken, connectorId, stream, records) {
  const ndjson = records
    .map((r) =>
      JSON.stringify({
        key: r.id,
        data: r,
        emitted_at: r.emitted_at || '2026-01-01T00:00:00Z',
      }),
    )
    .join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    },
  );
  assert.equal(resp.status, 200, `seed ${stream} ok`);
}

function readSpotifyManifest() {
  return JSON.parse(
    readFileSync(join(MANIFESTS_DIR, 'spotify.json'), 'utf8'),
  );
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  // Register Spotify connector (with aggregation enabled for aggregate tests)
  const manifest = readSpotifyManifest();
  const topArtists = manifest.streams.find((s) => s.name === 'top_artists');
  topArtists.query = {
    ...(topArtists.query || {}),
    aggregations: {
      count: true,
      sum: ['popularity', 'followers'],
      min: ['popularity', 'source_updated_at'],
      max: ['popularity', 'source_updated_at'],
    },
  };
  const regResp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(regResp.status, 201, 'register spotify connector');

  try {
    await fn({ asUrl, rsUrl, connectorId: manifest.connector_id });
  } finally {
    await closeServer(server);
  }
}

// ─── B3.1 — active client token introspection shape ─────────────────────────

test('introspection: active client token returns documented fields (B3)', async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b3_introspect_owner');
    await seedStream(rsUrl, ownerToken, connectorId, 'top_artists', [
      { id: 'a1', name: 'Artist One', popularity: 80, source_updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const approved = await issueClientGrant(asUrl, 'b3_introspect_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'assist.summarize',
      purpose_description: 'B3 introspection proof',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'popularity'] }],
    });

    const { status, body } = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: approved.token }),
    });

    assert.equal(status, 200, 'introspect returns 200');

    // Documented invariants from reference-implementation-examples.md Example 4
    assert.equal(body.active, true, 'active: true for a valid token');
    assert.equal(body.pdpp_token_kind, 'client', 'pdpp_token_kind: "client"');
    assert.ok(typeof body.subject_id === 'string', 'subject_id present');
    assert.equal(body.grant_id, approved.grant.grant_id, 'grant_id matches issued grant');
    assert.equal(body.client_id, 'longview', 'client_id matches requester');

    // grant object must be present and contain the source + streams
    assert.ok(body.grant, 'grant object present');
    assert.equal(body.grant.grant_id, approved.grant.grant_id, 'grant.grant_id matches');
    assert.equal(body.grant.source?.kind, 'connector', 'grant.source.kind = connector');
    assert.equal(body.grant.access_mode, 'continuous', 'grant.access_mode matches');
    assert.ok(Array.isArray(body.grant.streams), 'grant.streams is an array');
    assert.equal(body.grant.streams[0].name, 'top_artists', 'stream name preserved');

    // exp: either null or a number
    assert.ok(body.exp === null || typeof body.exp === 'number', 'exp is null or numeric Unix timestamp');

    // grant_storage_binding MUST NOT appear in the public response (operation redacts it)
    assert.ok(
      !('grant_storage_binding' in body),
      'grant_storage_binding must not appear in public introspection response',
    );
  });
});

// ─── B3.2 — inactive token: grant_revoked ───────────────────────────────────

test('introspection: revoked grant returns active=false with inactive_reason (B3)', async () => {
  await withHarness(async ({ asUrl, connectorId }) => {
    const approved = await issueClientGrant(asUrl, 'b3_revoke_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'assist.summarize',
      purpose_description: 'B3 revoke proof',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name'] }],
    });

    // Revoke the grant using the client token itself (a token holder may
    // revoke their own grant — no owner session needed)
    const revokeResp = await fetch(
      `${asUrl}/grants/${encodeURIComponent(approved.grant.grant_id)}/revoke`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
        body: JSON.stringify({}),
      },
    );
    assert.equal(revokeResp.status, 200, `revoke returned ${revokeResp.status}`);

    const { status, body } = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: approved.token }),
    });

    assert.equal(status, 200, 'introspect still returns 200 for inactive tokens');
    assert.equal(body.active, false, 'active: false after revocation');
    assert.ok(
      ['grant_revoked', 'token_revoked'].includes(body.inactive_reason),
      `inactive_reason should be grant_revoked or token_revoked, got: ${body.inactive_reason}`,
    );
    assert.equal(body.grant_id, approved.grant.grant_id, 'grant_id still present for attribution');
    assert.ok(!('grant' in body), 'full grant object not returned for inactive tokens');
  });
});

// ─── B3.3 — missing token returns 400 invalid_request ───────────────────────

test('introspection: missing token returns 400 invalid_request (B3)', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(status, 400, 'missing token → 400');
    assert.ok(
      body.error === 'invalid_request' || body.error?.code === 'invalid_request',
      `expect invalid_request error, got: ${JSON.stringify(body.error)}`,
    );
  });
});

// ─── B3.4 — resources[] round-trip: grant scopes records, introspection reflects it ─

test('resources[] round-trip: grant contains resources, RS enforces them (B3)', async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b3_resources_owner');
    await seedStream(rsUrl, ownerToken, connectorId, 'top_artists', [
      { id: 'visible_1', name: 'Artist V1', popularity: 70, source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'visible_2', name: 'Artist V2', popularity: 60, source_updated_at: '2026-01-02T00:00:00Z' },
      { id: 'hidden_3',  name: 'Artist H3', popularity: 90, source_updated_at: '2026-01-03T00:00:00Z' },
    ]);

    const approved = await issueClientGrant(asUrl, 'b3_resources_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'assist.search',
      purpose_description: 'B3 resources[] proof — two named artists',
      access_mode: 'single_use',
      streams: [
        {
          name: 'top_artists',
          fields: ['id', 'name', 'popularity'],
          resources: ['visible_1', 'visible_2'],
        },
      ],
    });

    // 1. Introspection reflects resources[] in the grant object
    const { body: introBody } = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: approved.token }),
    });
    assert.equal(introBody.active, true, 'token is active');
    const introspectedStream = introBody.grant?.streams?.[0];
    assert.ok(introspectedStream, 'stream present in introspected grant');
    assert.deepEqual(
      introspectedStream.resources,
      ['visible_1', 'visible_2'],
      'resources[] round-tripped through introspection',
    );

    // 2. RS enforces resources[]: only the two named records are visible
    const { status: recordsStatus, body: recordsBody } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(recordsStatus, 200, 'records query succeeds');
    const ids = recordsBody.data.map((r) => r.id);
    assert.ok(ids.includes('visible_1'), 'visible_1 present');
    assert.ok(ids.includes('visible_2'), 'visible_2 present');
    assert.ok(!ids.includes('hidden_3'), 'hidden_3 absent — resources[] enforced');
    assert.equal(recordsBody.data.length, 2, 'exactly two records returned');
  });
});

// ─── B3.5 — aggregate query also honors resources[] scoping ─────────────────

test('resources[] scoping applies to aggregate queries (B3)', async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b3_agg_resources_owner');
    await seedStream(rsUrl, ownerToken, connectorId, 'top_artists', [
      { id: 'agg_in',  name: 'Included', popularity: 50, source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'agg_out', name: 'Excluded', popularity: 99, source_updated_at: '2026-01-02T00:00:00Z' },
    ]);

    const approved = await issueClientGrant(asUrl, 'b3_agg_resources_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'assist.summarize',
      purpose_description: 'B3 aggregate resources[] proof',
      access_mode: 'continuous',
      streams: [
        {
          name: 'top_artists',
          fields: ['id', 'popularity', 'source_updated_at'],
          resources: ['agg_in'],
        },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/aggregate?metric=sum&field=popularity&connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200, 'aggregate succeeds');
    // Only agg_in (popularity=50) is in scope; agg_out (99) must not contribute
    assert.equal(body.value, 50, 'aggregate sum reflects only resources[]-scoped records');
    assert.equal(body.filtered_record_count, 1, 'filtered_record_count = 1');
  });
});

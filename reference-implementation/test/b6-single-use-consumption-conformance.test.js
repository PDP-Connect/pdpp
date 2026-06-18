/**
 * B6 conformance — single-use grant consumption doc proof.
 *
 * Verifies that the documented single-use flow in:
 *   - apps/site/content/docs/reference-implementation-examples.md (Example 6)
 *
 * matches the actual behavior of the reference implementation. Single-use
 * grants are one of PDPP's load-bearing access-mode primitives (concept 30/32):
 * the grant is consumed atomically on the FIRST token issuance, the issued
 * token stays valid until expiry, but NO second token may ever be minted, and
 * single-use runs persist no STATE.
 *
 * Each test boots a real server, issues a real single_use grant over HTTP,
 * and asserts the documented request/response shapes against reality. The
 * second-issuance rejection is exercised through the real `issueToken`
 * protocol primitive (the same function every HTTP re-issuance path calls).
 *
 * Gate: all tests green; documented JSON shapes match reality. If the doc
 * drifts from the runtime, this suite fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { issueToken } from '../server/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, 'manifests');
const EXAMPLES_DOC = join(
  REFERENCE_IMPL_DIR,
  '..',
  'apps',
  'site',
  'content',
  'docs',
  'reference-implementation-examples.md',
);

// ─── shared helpers (mirrors b3 harness) ────────────────────────────────────

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
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, 'spotify.json'), 'utf8'));
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

  const manifest = readSpotifyManifest();
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

// ─── B6.1 — single_use grant is consumed on first issuance ──────────────────

test('single_use: grant returns access_mode single_use and a bounded expiry (B6)', async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b6_su_owner');
    await seedStream(rsUrl, ownerToken, connectorId, 'top_artists', [
      { id: 'a1', name: 'Artist One', popularity: 80, source_updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const approved = await issueClientGrant(asUrl, 'b6_su_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/assist_summarize',
      purpose_description: 'B6 single-use proof',
      access_mode: 'single_use',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'popularity'] }],
    });

    // Documented in Example 6 Step 2: the issued grant carries access_mode and
    // a bounded expiry (single_use grants always expire; continuous may not).
    assert.equal(approved.grant.access_mode, 'single_use', 'grant.access_mode is single_use');
    assert.ok(approved.token, 'a first token was issued');
    assert.ok(approved.grant.expires_at, 'single_use grant carries a bounded expires_at');
  });
});

// ─── B6.2 — the issued token still serves queries (consumption ≠ revocation) ─

test('single_use: the issued token stays valid for RS queries after consumption (B6)', async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b6_query_owner');
    await seedStream(rsUrl, ownerToken, connectorId, 'top_artists', [
      { id: 'a1', name: 'Artist One', popularity: 80, source_updated_at: '2026-01-01T00:00:00Z' },
      { id: 'a2', name: 'Artist Two', popularity: 70, source_updated_at: '2026-01-02T00:00:00Z' },
    ]);

    const approved = await issueClientGrant(asUrl, 'b6_query_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/assist_summarize',
      purpose_description: 'B6 single-use query proof',
      access_mode: 'single_use',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'popularity'] }],
    });

    // Documented in Example 6 Step 3: consumption applies to NEW token
    // issuance, not to the already-issued token. The token remains usable
    // until its own expiry — single_use bounds how many tokens, not how many
    // queries one token may perform.
    const { status } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/records?limit=10`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(status, 200, 'the issued single_use token still serves queries');
  });
});

// ─── B6.3 — a second token issuance on a consumed grant is rejected ─────────

test('single_use: second token issuance is rejected with grant_consumed (B6)', async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b6_reissue_owner');
    await seedStream(rsUrl, ownerToken, connectorId, 'top_artists', [
      { id: 'a1', name: 'Artist One', popularity: 80, source_updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const approved = await issueClientGrant(asUrl, 'b6_reissue_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/assist_summarize',
      purpose_description: 'B6 single-use re-issuance proof',
      access_mode: 'single_use',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'popularity'] }],
    });

    // Documented in Example 6 Step 4: the grant was consumed atomically on the
    // first issuance. Every subsequent issuance attempt against the same grant
    // — whichever HTTP re-issuance path reaches it (refresh_token grant, device
    // re-exchange) — bottoms out in the same `issueToken` primitive and is
    // rejected with code `grant_consumed`, which the error map surfaces as
    // HTTP 403. This is the consumption enforcement, not a generic error.
    await assert.rejects(
      () =>
        issueToken(approved.grant.grant_id, 'b6_reissue_owner', 'longview', null, {
          source: 'b6_second_issuance',
        }),
      (err) => {
        assert.equal(err.code, 'grant_consumed', 'error code is grant_consumed');
        assert.match(err.message, /already been consumed/i, 'message names consumption');
        return true;
      },
      'second issuance on a consumed single_use grant must throw grant_consumed',
    );
  });
});

// ─── B6.5 — the examples doc documents the load-bearing single-use facts ────

test('single_use: examples doc documents the consumption contract (B6)', () => {
  // Doc-coupling gate: the reviewer-facing Example 6 must keep stating the
  // facts the runtime enforces. If someone deletes the consumption claim from
  // the doc, this fails — the doc cannot silently drift away from the proof.
  const doc = readFileSync(EXAMPLES_DOC, 'utf8');
  assert.match(doc, /## Example 6: Single-use grant consumption/, 'Example 6 present');
  assert.match(doc, /"access_mode": "single_use"/, 'single_use access_mode shown');
  assert.match(doc, /consumed atomically on the first\s+token\s+issuance/i, 'consumption-on-first-issuance documented');
  assert.match(doc, /grant_consumed/, 'grant_consumed rejection code documented');
  assert.match(doc, /HTTP 403/, 'grant_consumed → 403 mapping documented');
  assert.match(doc, /consumption is not revocation/i, 'token-stays-valid nuance documented');
  assert.match(doc, /no STATE/i, 'no-STATE-persist property documented');
  // Semantic classes (Example 7) — refined trust model.
  assert.match(doc, /## Example 7: Semantic classes on the consent surface/, 'Example 7 present');
  assert.match(doc, /Protocol-enforced constraints/, 'class 1 documented');
  assert.match(doc, /Structured policy declarations/, 'class 2 documented');
  assert.match(doc, /Attributed client claims/, 'class 3 documented');
  assert.match(doc, /entity-scoped/, 'client_display entity-scoping documented');
  assert.match(doc, /request-scoped/, 'client_claims request-scoping documented');
  assert.match(doc, /manifest-authored/i, 'manifest-authored display.detail documented');
});

// ─── B6.4 — control: a continuous grant is NOT consumed ─────────────────────

test('single_use control: a continuous grant re-issues freely (not consumed) (B6)', async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b6_cont_owner');
    await seedStream(rsUrl, ownerToken, connectorId, 'top_artists', [
      { id: 'a1', name: 'Artist One', popularity: 80, source_updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const approved = await issueClientGrant(asUrl, 'b6_cont_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'https://pdpp.org/purpose/assist_summarize',
      purpose_description: 'B6 continuous control',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists', fields: ['id', 'name', 'popularity'] }],
    });
    assert.equal(approved.grant.access_mode, 'continuous');

    // The contrast that makes single_use meaningful: a continuous grant mints
    // additional tokens on demand until it is explicitly revoked or expires.
    const secondToken = await issueToken(
      approved.grant.grant_id,
      'b6_cont_owner',
      'longview',
      null,
      { source: 'b6_second_issuance' },
    );
    assert.ok(secondToken, 'second issuance on a continuous grant succeeds');
  });
});

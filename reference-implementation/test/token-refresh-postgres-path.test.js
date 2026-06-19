/**
 * Real auth.js Postgres-adapter path proof for the token / oauth-authorization-code /
 * oauth-refresh-token row operations.
 *
 * The token, oauth_authorization_codes, and oauth_refresh_tokens row operations
 * in `server/auth.js` each carry a Postgres adapter behind
 * `isPostgresStorageBackend()`. Before this file, the only PG-path coverage was
 * indirect: the consent + device-auth path test exercises `issueToken`'s
 * FOR-UPDATE transaction branch and the grant-package path test exercises
 * `issuePackageToken`. The dialect-only seams that the seam-march collapses into
 * `getOAuthCodeStore()` / `getRefreshTokenStore()` / `getTokenStore()` had no
 * direct Postgres-path test.
 *
 * This test closes that gap. It boots the REAL reference server with the storage
 * backend switched to Postgres and drives the exported OAuth authorization-code +
 * refresh-token grant flows over HTTP, so the production Postgres adapters
 * actually execute end to end:
 *   - issueOAuthAuthorizationCodeForDeviceCode  (oauth_authorization_codes
 *     SELECT-by-device + the issue UPDATE), during POST /consent/approve
 *   - exchangeOAuthAuthorizationCode  (oauth_authorization_codes SELECT-by-code +
 *     the consume UPDATE), during POST /oauth/token grant_type=authorization_code
 *   - issueOAuthRefreshToken  (oauth_refresh_tokens INSERT), minted alongside the
 *     access token when the client supports refresh_token
 *   - exchangeOAuthRefreshToken  (oauth_refresh_tokens SELECT-by-hash + the
 *     last_used_at UPDATE), during POST /oauth/token grant_type=refresh_token
 *   - introspect  (the tokens SELECT join), via GET /oauth/introspect and the
 *     internal exchange validation
 *   - issueOwnerTokenRecord  (tokens INSERT-owner), via the owner device flow
 *
 * `issueToken` (the grants FOR-UPDATE multi-statement transaction) and the
 * grant-revoke / package-revoke cascades are intentionally NOT migrated by the
 * seam-march and are covered elsewhere; they are exercised incidentally here but
 * are not this file's mandate.
 *
 * The whole file is gated on `PDPP_TEST_POSTGRES_URL`; when unset it registers a
 * single skipped test so default development and CI do not need Postgres.
 *
 * Run (Compose Postgres proof service):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55467/pdpp_tok \
 *     node --test --import tsx \
 *     reference-implementation/test/token-refresh-postgres-path.test.js
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { revokeGrant } from '../server/auth.js';
import { closeDb } from '../server/db.js';
import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';
import { startServer } from '../server/index.js';
import { closePostgresStorage } from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

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
  const body = text ? JSON.parse(text) : null;
  return { resp, status: resp.status, body };
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function registerConnector(asUrl, name) {
  const raw = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${name}.json`), 'utf8'),
  );
  const canonical = canonicalConnectorKeyFromManifest(raw);
  const manifest = !canonical || canonical === raw.connector_id
    ? raw
    : { ...raw, connector_id: canonical };
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
}

async function registerAuthCodeClient(asUrl, { refreshToken = true } = {}) {
  const grantTypes = refreshToken
    ? ['authorization_code', 'refresh_token']
    : ['authorization_code'];
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'token-refresh-postgres-path test client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: grantTypes,
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(status, 201);
  assert.deepEqual(body.grant_types, grantTypes);
  return body;
}

// Single-source authorization-code flow. Drives the oauth-code issue +
// consume seams and (when the client supports refresh) the refresh-token
// INSERT. Returns the access token, the refresh token, the grant id, and the
// code so callers can assert single-use replay.
async function completeOauthCodeFlow({ asUrl, client, manifest }) {
  const verifier = randomBytes(32).toString('base64url');
  const authorizationDetails = [
    {
      type: 'https://pdpp.org/data-access',
      source: { kind: 'connector', id: manifest.connector_id },
      purpose_code: 'https://pdpp.org/purpose/personal_ai_assistant',
      purpose_description: 'token-refresh postgres-path proof',
      access_mode: 'continuous',
      streams: [{ name: '*' }],
    },
  ];
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', 'state-tok');
  authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('authorization_details', JSON.stringify(authorizationDetails));

  const authorizeResp = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorizeResp.status, 302);
  const consentUrl = new URL(authorizeResp.headers.get('location'), asUrl);
  const requestUri = consentUrl.searchParams.get('request_uri');
  assert.ok(requestUri, 'authorize redirect carries a request_uri');

  // POST /consent/approve drives issueOAuthAuthorizationCodeForDeviceCode:
  // the oauth_authorization_codes SELECT-by-device + the issue UPDATE.
  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      request_uri: requestUri,
      subject_id: 'owner_local',
    }).toString(),
  });
  assert.equal(approveResp.status, 302);
  const callback = new URL(approveResp.headers.get('location'));
  assert.equal(callback.origin, 'https://client.example');
  assert.equal(callback.searchParams.get('state'), 'state-tok');
  const code = callback.searchParams.get('code');
  assert.ok(code, 'approve callback carries an authorization code');

  // POST /oauth/token grant_type=authorization_code drives
  // exchangeOAuthAuthorizationCode (oauth_authorization_codes SELECT-by-code +
  // the consume UPDATE), introspect (the tokens SELECT join), and, when the
  // client supports refresh, issueOAuthRefreshToken (oauth_refresh_tokens
  // INSERT).
  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(status, 200);
  assert.equal(body.token_type, 'Bearer');
  assert.ok(body.access_token, 'code exchange returns an access token');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    grantId: body.grant_id,
    code,
    verifier,
  };
}

if (!POSTGRES_URL) {
  test(
    'auth.js token/refresh postgres-adapter path (skipped: PDPP_TEST_POSTGRES_URL unset)',
    { skip: true },
    () => {},
  );
} else {
  // One server for the whole file. Every token / oauth-code / refresh-token
  // read and write routes to Postgres because the active storage backend is
  // postgres. Concrete proof the Postgres adapters run: the negative control
  // breaks a Postgres-only adapter and this suite goes red.
  let server = null;
  let asUrl = '';
  let client = null;
  let spotify = null;

  test.before(async () => {
    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      ownerAuthPassword: '',
      storageBackend: 'postgres',
      databaseUrl: POSTGRES_URL,
      reconcilePolyfillManifests: false,
    });
    asUrl = `http://localhost:${server.asPort}`;
    spotify = await registerConnector(asUrl, 'spotify');
    client = await registerAuthCodeClient(asUrl);
  });

  test.after(async () => {
    if (server) await closeServer(server);
    await closePostgresStorage();
    closeDb();
  });

  // ---------------------------------------------------------------------
  // A) Owner device flow -> owner token INSERT + introspection.
  //
  // Exercises issueOwnerTokenRecord (tokens INSERT-owner) and introspect (the
  // tokens SELECT join) through the real device-authorization flow.
  // ---------------------------------------------------------------------
  test('owner device flow mints + introspects an owner token through real auth.js postgres adapters', async () => {
    // cli_longview is the owner CLI client that startServer pre-seeds at boot;
    // bare owner device authorization (no resource / authorization_details) is
    // only accepted for a known client.
    const ownerClientId = 'cli_longview';
    const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: ownerClientId }).toString(),
    });
    assert.ok(device.device_code, 'device authorization returns a device_code');

    const approveResp = await fetch(`${asUrl}/device/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        user_code: device.user_code,
        subject_id: 'owner_local',
      }).toString(),
    });
    assert.equal(approveResp.status, 200);

    // grant_type=device_code drives issueOwnerTokenRecord (tokens INSERT-owner).
    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: ownerClientId,
      }).toString(),
    });
    assert.ok(tokenBody.access_token, 'owner device exchange returns an owner token');

    // Introspect the owner token: the tokens SELECT join (PG introspect adapter).
    const introspectResp = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenBody.access_token }).toString(),
    });
    assert.equal(introspectResp.status, 200);
    assert.equal(introspectResp.body.active, true, 'owner token introspects as active');
    assert.equal(introspectResp.body.subject_id, 'owner_local', 'introspection subject is owner_local');
  });

  // ---------------------------------------------------------------------
  // B) Authorization-code + refresh-token lifecycle.
  //
  // Exercises the oauth_authorization_codes seams (issue + consume), the
  // oauth_refresh_tokens INSERT, the introspect tokens SELECT, and the
  // refresh-token exchange (SELECT-by-hash + last_used_at UPDATE).
  // ---------------------------------------------------------------------
  test('authorization-code exchange + refresh rotation through real auth.js postgres adapters', async () => {
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(issued.refreshToken, 'refresh-capable client receives a refresh token');

    // Introspect the access token: the tokens SELECT join (PG introspect adapter).
    const introspectResp = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: issued.accessToken }).toString(),
    });
    assert.equal(introspectResp.status, 200);
    assert.equal(introspectResp.body.active, true, 'issued access token introspects as active');

    // Replaying the consumed code must fail: the consume UPDATE flipped the
    // row to status=consumed and the SELECT-by-code adapter reads it back.
    const replay = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: issued.code,
        client_id: client.client_id,
        redirect_uri: 'https://client.example/callback',
        code_verifier: issued.verifier,
      }).toString(),
    });
    assert.equal(replay.status, 400, 'replaying a consumed code is rejected');
    assert.equal(replay.body.error, 'invalid_grant');

    // grant_type=refresh_token drives exchangeOAuthRefreshToken: the
    // oauth_refresh_tokens SELECT-by-hash + the last_used_at UPDATE, and mints
    // a fresh access token via issueToken.
    const refreshed = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: issued.refreshToken,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(refreshed.status, 200, 'refresh exchange succeeds');
    assert.ok(refreshed.body.access_token, 'refresh returns a new access token');
    assert.notEqual(
      refreshed.body.access_token,
      issued.accessToken,
      'refresh mints a distinct access token',
    );
    assert.equal(
      refreshed.body.refresh_token,
      issued.refreshToken,
      'refresh token is reusable (last_used_at UPDATE, not rotation)',
    );

    // The new access token introspects as active (tokens SELECT join again).
    const refreshedIntrospect = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshed.body.access_token }).toString(),
    });
    assert.equal(refreshedIntrospect.body.active, true, 'refreshed access token is active');

    // A wrong-client refresh must be rejected (SELECT-by-hash reads the row,
    // client_id mismatch fails). Proves the SELECT adapter returns the bound row.
    const wrongClient = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: issued.refreshToken,
        client_id: 'not-the-issuing-client',
      }).toString(),
    });
    assert.equal(wrongClient.status, 400, 'refresh with the wrong client is rejected');
    assert.equal(wrongClient.body.error, 'invalid_grant');
  });

  // ---------------------------------------------------------------------
  // C) Revoke the grant -> the bound access token and refresh token both die.
  //
  // revokeGrant's token cascade is NOT migrated by the seam-march, but driving
  // it proves the introspect SELECT adapter reports the revoked row and the
  // refresh SELECT adapter sees the revoked refresh row.
  // ---------------------------------------------------------------------
  test('revoking the grant deactivates the issued access + refresh tokens through real auth.js postgres adapters', async () => {
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(issued.grantId, 'code exchange exposes the grant_id');
    assert.ok(issued.refreshToken, 'refresh token issued for the revoke test');

    await revokeGrant(issued.grantId, { request_id: 'tok-pg-path-revoke' });

    // Introspection now reports inactive (tokens SELECT join reads revoked=TRUE).
    const introspectResp = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: issued.accessToken }).toString(),
    });
    assert.equal(introspectResp.body.active, false, 'revoked grant token introspects as inactive');

    // The refresh token bound to the revoked grant can no longer be exchanged
    // (refresh SELECT-by-hash reads status=revoked).
    const afterRevoke = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: issued.refreshToken,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(afterRevoke.status, 400, 'refresh against a revoked grant is rejected');
    assert.equal(afterRevoke.body.error, 'invalid_grant');
  });
}

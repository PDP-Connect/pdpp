/**
 * `_ref/grant-packages` operator visibility surface — owner-session-gated
 * list, detail, and revoke endpoints introduced by the OpenSpec change
 * `add-grant-package-operator-visibility`.
 *
 * These tests drive the real reference server (in-memory SQLite, owner
 * auth disabled via `ownerAuthPassword: ''`), run a multi-source hosted
 * MCP picker flow to issue a package, then probe:
 *
 *   1. `GET /_ref/grant-packages` lists the package with member count
 *      and exposes no token/secret material.
 *   2. `GET /_ref/grant-packages/:id` returns the child cascade with
 *      `grant_id`, `grant_status`, `source`, and timestamps — and never
 *      includes secret fields.
 *   3. `GET /_ref/grant-packages/:id` returns a typed `not_found` 404
 *      envelope for unknown ids.
 *   4. `POST /_ref/grant-packages/:id/revoke` revokes every child,
 *      flips the package to `revoked`, and returns the revoke-result
 *      envelope.
 *   5. The same revoke endpoint returns `409 already_revoked` on a
 *      second call.
 *   6. `GET /_ref/grants` rows whose binding token is a package token
 *      surface `grant_package_id` on the spine row; non-package grants
 *      omit the field.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

const SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'token_hash',
  'package_secret',
  'package_token',
  'client_secret',
  'token',
]);

function assertNoSecretMaterial(value, path = '$') {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretMaterial(v, `${path}[${i}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    assert.ok(
      !SECRET_KEYS.has(key),
      `secret-shaped field "${key}" surfaced at ${path}.${key} — operator surfaces must not leak token material`,
    );
    assertNoSecretMaterial(v, `${path}.${key}`);
  }
}

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
  const manifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${name}.json`), 'utf8'),
  );
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
}

async function registerAuthCodeClient(asUrl) {
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ref-grant-packages test client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(status, 201);
  return body;
}

async function completeMultiSourcePackageFlow({ asUrl, client, connectorIds }) {
  const verifier = randomBytes(32).toString('base64url');
  const state = 'pkg-test-state';
  const challenge = pkceChallenge(verifier);

  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const pickerResp = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(pickerResp.status, 200);

  const params = new URLSearchParams();
  params.append('client_id', client.client_id);
  params.append('redirect_uri', 'https://client.example/callback');
  params.append('response_type', 'code');
  params.append('state', state);
  params.append('code_challenge', challenge);
  params.append('code_challenge_method', 'S256');
  for (const id of connectorIds) {
    params.append('selection', `connector:${id}`);
  }

  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  assert.equal(approveResp.status, 302);
  const callback = new URL(approveResp.headers.get('location'));
  const code = callback.searchParams.get('code');
  assert.ok(code);

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
  assert.ok(body.grant_package_id);
  return { packageId: body.grant_package_id };
}

function startTestServer() {
  return startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
  });
}

test('GET /_ref/grant-packages lists the package with no secret material', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, 'spotify');
    const github = await registerConnector(asUrl, 'github');
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const { status, body } = await fetchJson(`${asUrl}/_ref/grant-packages`);
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    const row = body.data.find((r) => r.package_id === packageId);
    assert.ok(row, 'newly issued package must appear in the list');
    assert.equal(row.object, 'grant_package_summary');
    assert.equal(row.status, 'active');
    assert.equal(row.member_count, 2);
    assert.equal(typeof row.subject_id, 'string');
    assert.equal(typeof row.client_id, 'string');
    assertNoSecretMaterial(body);
  } finally {
    await closeServer(server);
  }
});

test('GET /_ref/grant-packages/:id returns the child cascade with no secret material', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, 'spotify');
    const github = await registerConnector(asUrl, 'github');
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`,
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'grant_package');
    assert.equal(body.package_id, packageId);
    assert.equal(body.status, 'active');
    assert.equal(body.member_count, 2);
    assert.ok(Array.isArray(body.children));
    assert.equal(body.children.length, 2);
    for (const child of body.children) {
      assert.equal(child.object, 'grant_package_child');
      assert.equal(typeof child.grant_id, 'string');
      assert.equal(typeof child.grant_status, 'string');
      assert.equal(typeof child.member_status, 'string');
      assert.ok(child.source, 'each child carries a parsed source');
    }
    assertNoSecretMaterial(body);
  } finally {
    await closeServer(server);
  }
});

test('GET /_ref/grant-packages/:id returns typed not_found for an unknown id', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { status, body } = await fetchJson(`${asUrl}/_ref/grant-packages/gpkg_does_not_exist`);
    assert.equal(status, 404);
    assert.ok(body?.error);
    assert.equal(body.error.code ?? body.error, 'not_found');
  } finally {
    await closeServer(server);
  }
});

test('POST /_ref/grant-packages/:id/revoke cascades revocation; second call returns 409 already_revoked', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, 'spotify');
    const github = await registerConnector(asUrl, 'github');
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const revoke = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}/revoke`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.object, 'grant_package_revoke_result');
    assert.equal(revoke.body.package_id, packageId);
    assert.equal(revoke.body.status, 'revoked');
    assert.ok(revoke.body.revoked_at);
    assert.equal(revoke.body.revoked_child_count, 2);
    assertNoSecretMaterial(revoke.body);

    // Detail now shows revoked status on the package row and on every
    // member binding. The underlying `grants.status` column is not
    // flipped by package revocation — enforcement runs through the
    // revoked package-bound token + revoked `grant_package_members` row
    // — so the operator-visible cascade lives on `member_status` and the
    // member's `revoked_at`.
    const detail = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, 'revoked');
    assert.ok(detail.body.revoked_at);
    for (const child of detail.body.children) {
      assert.equal(child.member_status, 'revoked');
      assert.ok(child.revoked_at, 'revoked member must carry a revoked_at');
    }

    const again = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}/revoke`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code ?? again.body.error, 'already_revoked');
  } finally {
    await closeServer(server);
  }
});

test('GET /_ref/grants surfaces grant_package_id on child rows whose token is package-bound and omits it otherwise', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, 'spotify');
    const github = await registerConnector(asUrl, 'github');
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const detail = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`,
    );
    const childGrantIds = new Set(detail.body.children.map((c) => c.grant_id));
    assert.equal(childGrantIds.size, 2);

    const grantsList = await fetchJson(`${asUrl}/_ref/grants?limit=50`);
    assert.equal(grantsList.status, 200);
    const packageBound = grantsList.body.data.filter((g) => childGrantIds.has(g.grant_id));
    assert.equal(packageBound.length, 2, 'both child grants appear on the spine row list');
    for (const row of packageBound) {
      assert.equal(row.grant_package_id, packageId, 'package-bound child row carries grant_package_id');
    }
    const nonPackage = grantsList.body.data.filter((g) => !childGrantIds.has(g.grant_id));
    for (const row of nonPackage) {
      assert.equal(
        row.grant_package_id,
        undefined,
        `non-package grant ${row.grant_id} must omit grant_package_id`,
      );
    }
    assertNoSecretMaterial(grantsList.body);
  } finally {
    await closeServer(server);
  }
});

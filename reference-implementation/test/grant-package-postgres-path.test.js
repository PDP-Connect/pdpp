// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real auth.js Postgres-adapter path proof for the hosted-MCP grant-package
 * lifecycle.
 *
 * The grant-package row operations in `server/auth.js` (issuePackageToken,
 * getGrantPackageRow, persistChildGrantForPackage, createGrantPackage,
 * getGrantPackageMembers, listGrantPackagesByParent,
 * listActiveGrantPackageMembersForRevocation, markGrantPackageMemberRevoked,
 * markGrantPackageRevoked) each carry a Postgres adapter behind
 * `isPostgresStorageBackend()`. The existing SQLite lifecycle proof
 * (`ref-grant-packages.test.js`) runs against in-memory SQLite, so the
 * production Postgres adapters had zero automated coverage.
 *
 * This test closes that gap. It boots the REAL reference server with the
 * storage backend switched to Postgres, issues a multi-source hosted MCP
 * grant package through the real HTTP picker flow (which drives
 * createHostedMcpGrantPackage -> persistChildGrantForPackage (grants INSERT)
 * -> issuePackageToken (tokens INSERT) -> grant_package_members INSERT, all
 * on the Postgres adapters), then drives the exported owner-facing reads and
 * the revoke cascade directly:
 *   - listGrantPackagesForOwner / getGrantPackageForOwner /
 *     getGrantPackageAccess (Postgres SELECT adapters: getGrantPackageRow,
 *     getGrantPackageMembers, the active-members join)
 *   - getGrantPackageIdForGrant (Postgres member-by-grant SELECT)
 *   - revokeGrantPackage (markGrantPackageMemberRevoked +
 *     markGrantPackageRevoked Postgres UPDATE cascade)
 *
 * The whole file is gated on `PDPP_TEST_POSTGRES_URL`; when unset it registers
 * a single skipped test so default development and CI do not need Postgres.
 *
 * Run (Compose Postgres proof service):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55467/pdpp_gp \
 *     node --test --import tsx \
 *     reference-implementation/test/grant-package-postgres-path.test.js
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getGrantPackageAccess,
  getGrantPackageForOwner,
  getGrantPackageIdForGrant,
  listGrantPackagesForOwner,
  revokeGrantPackage,
} from '../server/auth.js';
import { closeDb } from '../server/db.js';
import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';
import { encodeHostedMcpSelection } from '../server/hosted-mcp-selection.js';
import { startServer } from '../server/index.js';
import { closePostgresStorage } from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

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
      `secret-shaped field "${key}" surfaced at ${path}.${key}`,
    );
    assertNoSecretMaterial(v, `${path}.${key}`);
  }
}

function renderedHostedMcpStreamValues(html) {
  return [...html.matchAll(/<input[^>]*name="stream"[^>]*value="([^"]+)"[^>]*data-hosted-mcp-stream-checkbox[^>]*>/g)]
    .map((match) => match[1]);
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

async function registerAuthCodeClient(asUrl) {
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'grant-package-postgres-path test client',
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
  const state = 'pkg-pg-test-state';
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
  const pickerHtml = await pickerResp.text();

  const params = new URLSearchParams();
  params.append('client_id', client.client_id);
  params.append('redirect_uri', 'https://client.example/callback');
  params.append('response_type', 'code');
  params.append('state', state);
  params.append('code_challenge', challenge);
  params.append('code_challenge_method', 'S256');
  for (const id of connectorIds) {
    params.append('selection', encodeHostedMcpSelection({ connectorId: id, connectionId: null }));
  }
  for (const streamValue of renderedHostedMcpStreamValues(pickerHtml)) {
    params.append('stream', streamValue);
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

if (!POSTGRES_URL) {
  test(
    'grant-package postgres-adapter path (skipped: PDPP_TEST_POSTGRES_URL unset)',
    { skip: true },
    () => {},
  );
} else {
  // One server for the whole file. Issuing happens over HTTP against the
  // Postgres-backed AS; the owner-facing reads and the revoke cascade run by
  // calling the real exported auth.js functions directly, which select the
  // Postgres adapters because the active storage backend is postgres. Concrete
  // proof the Postgres adapters run: the negative control breaks a
  // Postgres-only grant-package SELECT and this suite goes red.
  let server = null;
  let asUrl = '';
  let client = null;
  let spotify = null;
  let github = null;

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
    github = await registerConnector(asUrl, 'github');
    client = await registerAuthCodeClient(asUrl);
  });

  test.after(async () => {
    if (server) await closeServer(server);
    await closePostgresStorage();
    closeDb();
  });

  // ---------------------------------------------------------------------
  // A) Issue + list + detail through the real Postgres adapters.
  //
  // Exercises (write path, via HTTP): createHostedMcpGrantPackage ->
  // grant_packages INSERT, persistChildGrantForPackage -> grants INSERT,
  // grant_package_members INSERT, issuePackageToken -> tokens INSERT.
  // Exercises (read path, via exported fns): listGrantPackagesForOwner,
  // getGrantPackageForOwner (getGrantPackageRow SELECT + getGrantPackageMembers
  // join), getGrantPackageAccess (active-members join),
  // getGrantPackageIdForGrant (member-by-grant SELECT).
  // ---------------------------------------------------------------------
  test('issue -> list -> detail -> access through real auth.js postgres adapters', async () => {
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    // listGrantPackagesForOwner: grant_packages SELECT with member_count
    // subquery (Postgres listing adapter).
    const list = await listGrantPackagesForOwner({ limit: 50 });
    assert.ok(Array.isArray(list.data));
    const listed = list.data.find((row) => row.package_id === packageId);
    assert.ok(listed, 'newly issued package appears in the owner listing');
    assert.equal(listed.status, 'active');
    assert.equal(listed.member_count, 2);
    assert.equal(typeof listed.subject_id, 'string');
    assert.equal(typeof listed.client_id, 'string');
    assertNoSecretMaterial(list);

    // getGrantPackageForOwner: getGrantPackageRow SELECT + the all-members
    // join (Postgres detail adapters).
    const detail = await getGrantPackageForOwner(packageId);
    assert.ok(detail, 'detail returns the package');
    assert.equal(detail.package_id, packageId);
    assert.equal(detail.status, 'active');
    assert.equal(detail.member_count, 2);
    assert.equal(detail.children.length, 2);
    for (const child of detail.children) {
      assert.equal(typeof child.grant_id, 'string');
      assert.equal(child.grant_status, 'active');
      assert.equal(child.member_status, 'active');
      assert.ok(child.source, 'each child carries a parsed source');
    }
    assertNoSecretMaterial(detail);

    // getGrantPackageAccess: the active-members join (Postgres fan-out
    // adapter). Returns child grant + token for each active member.
    const access = await getGrantPackageAccess(packageId);
    assert.ok(access, 'access returns an active package');
    assert.equal(access.package.package_id, packageId);
    assert.equal(access.members.length, 2);
    for (const member of access.members) {
      assert.equal(member.package_id, packageId);
      assert.equal(typeof member.grant_id, 'string');
      assert.equal(typeof member.token, 'string', 'member exposes its child grant token');
      assert.ok(member.grant, 'member carries the parsed child grant');
    }

    // getGrantPackageIdForGrant: member-by-grant SELECT. Every child grant
    // resolves back to this package; the package token (NULL grant_id) does
    // not participate.
    for (const child of detail.children) {
      const resolved = await getGrantPackageIdForGrant(child.grant_id);
      assert.equal(resolved, packageId, 'child grant resolves to its package');
    }
  });

  // ---------------------------------------------------------------------
  // B) Revoke cascade through the real Postgres adapters.
  //
  // Exercises listActiveGrantPackageMembersForRevocation (active-members
  // join), markGrantPackageMemberRevoked (member UPDATE), and
  // markGrantPackageRevoked (the 4-statement Postgres revocation cascade:
  // grant_packages + tokens + grant_package_members + oauth_refresh_tokens).
  // ---------------------------------------------------------------------
  test('revoke cascade flips package and every child to revoked through real auth.js postgres adapters', async () => {
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const before = await getGrantPackageForOwner(packageId);
    assert.equal(before.status, 'active');
    assert.equal(before.children.length, 2);
    for (const child of before.children) {
      assert.equal(child.grant_status, 'active');
      assert.equal(child.member_status, 'active');
    }

    const revoke = await revokeGrantPackage(packageId);
    assert.equal(revoke.package_id, packageId);
    assert.equal(revoke.status, 'revoked');
    assert.ok(revoke.revoked_at);
    assert.equal(revoke.revoked_child_grants.length, 2);
    assert.deepEqual(revoke.not_revoked_child_grants, []);
    assertNoSecretMaterial(revoke);

    // Detail now shows revoked status on the package row and on every child
    // grant + member binding (markGrantPackageRevoked cascade UPDATEs).
    const after = await getGrantPackageForOwner(packageId);
    assert.equal(after.status, 'revoked');
    assert.ok(after.revoked_at);
    for (const child of after.children) {
      assert.equal(child.grant_status, 'revoked');
      assert.equal(child.member_status, 'revoked');
      assert.ok(child.revoked_at, 'revoked member carries a revoked_at');
    }

    // getGrantPackageAccess hides revoked packages entirely.
    const access = await getGrantPackageAccess(packageId);
    assert.equal(access, null, 'a revoked package is not returned by the fan-out access read');
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Incremental add-source linkage (`parent_package_id`) for the
 * reference-experimental batch consent ceremony.
 *
 * OpenSpec change `implement-batch-consent-ceremony`, task 2.10:
 *
 *   "A later same-client ceremony creates a new package linked via
 *    `parent_package_id`, issues independent grants for the added sources
 *    without re-issuing prior grants, and the dashboard renders a cumulative
 *    per-client view across linked packages."
 *
 * These tests drive the real reference server (in-memory SQLite, owner auth
 * disabled via `ownerAuthPassword: ''`) through:
 *
 *   1. An initial batch ceremony issuing a root package.
 *   2. A second same-client ceremony carrying `parent_package_id`, asserting
 *      it issues only the added source's child grant, links to the prior
 *      package, and leaves the prior package + child grants untouched.
 *   3. The cumulative per-client view across the linked lineage.
 *   4. Fail-closed handling of invalid / cross-client / inactive / malformed
 *      linkage — no new package or child grant is written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';
import { getCumulativeClientAccessForPackage, revokeGrant } from '../server/auth.js';

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

function loadManifest(name) {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${name}.json`), 'utf8'));
}

async function registerManifest(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.ok(resp.status < 400, `connector registration for ${manifest.connector_id} should succeed`);
}

async function withHarness(fn) {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const spotify = loadManifest('spotify');
  const reddit = loadManifest('reddit');
  const github = loadManifest('github');
  try {
    for (const manifest of [spotify, reddit, github]) {
      await registerManifest(asUrl, manifest);
    }
    await fn({ asUrl, spotify, reddit, github });
  } finally {
    await closeServer(server);
  }
}

function detail(source, streams, overrides = {}) {
  return {
    type: 'https://pdpp.org/data-access',
    source,
    purpose_code: 'https://pdpp.org/purpose/personalization',
    access_mode: 'single_use',
    streams,
    ...overrides,
  };
}

async function par(asUrl, authorizationDetails, extra = {}, clientId = 'longview') {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_display: { name: 'Longview' },
      authorization_details: authorizationDetails,
      ...extra,
    }),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function approve(asUrl, body) {
  const resp = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function approveBatch(asUrl, requestUri, approvedIndexes, extra = {}) {
  return approve(asUrl, {
    request_uri: requestUri,
    subject_id: 'owner_local',
    approved_source_indexes: approvedIndexes,
    ...extra,
  });
}

test('parent linkage: a later same-client ceremony links a new package and issues only the added source', async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    // Root ceremony: two sources.
    const first = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);
    assert.equal(first.status, 201);
    const root = await approveBatch(asUrl, first.body.request_uri, [0, 1]);
    assert.equal(root.status, 200);
    const rootPackageId = root.body.package_id;
    assert.ok(rootPackageId?.startsWith('gpkg_'));
    const rootChildGrantIds = root.body.grant.child_grants.map((c) => c.grant_id).sort();
    assert.equal(rootChildGrantIds.length, 2);

    // Add-source ceremony: one new source, linked to the root.
    const second = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
      { parent_package_id: rootPackageId },
    );
    assert.equal(second.status, 201);
    const added = await approveBatch(asUrl, second.body.request_uri, [0]);
    assert.equal(added.status, 200);
    const addedPackageId = added.body.package_id;
    assert.ok(addedPackageId.startsWith('gpkg_'));
    assert.notEqual(addedPackageId, rootPackageId);

    const db = getDb();
    // The new package records the linkage.
    const addedRow = db
      .prepare('SELECT parent_package_id, status FROM grant_packages WHERE package_id = ?')
      .get(addedPackageId);
    assert.equal(addedRow.parent_package_id, rootPackageId);
    assert.equal(addedRow.status, 'active');

    // The root package and its child grants are untouched — not re-issued,
    // not mutated, not linked.
    const rootRow = db
      .prepare('SELECT parent_package_id, status FROM grant_packages WHERE package_id = ?')
      .get(rootPackageId);
    assert.equal(rootRow.parent_package_id, null);
    assert.equal(rootRow.status, 'active');
    const rootMembersAfter = db
      .prepare('SELECT grant_id FROM grant_package_members WHERE package_id = ? ORDER BY grant_id')
      .all(rootPackageId)
      .map((r) => r.grant_id)
      .sort();
    assert.deepEqual(rootMembersAfter, rootChildGrantIds);

    // The added package issues its own independent child grants for the added
    // sources only.
    const addedMembers = db
      .prepare('SELECT grant_id FROM grant_package_members WHERE package_id = ?')
      .all(addedPackageId);
    assert.equal(addedMembers.length, 1);
    for (const m of addedMembers) {
      assert.ok(!rootChildGrantIds.includes(m.grant_id), 'added grants must be distinct from root grants');
    }

    // Three child grants total (2 root + 1 added), each independently revocable.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 3);
  });
});

test('parent linkage: cumulative per-client view unions child grants across linked packages', async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    const first = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);
    const root = await approveBatch(asUrl, first.body.request_uri, [0, 1]);
    const rootPackageId = root.body.package_id;

    const second = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
      { parent_package_id: rootPackageId },
    );
    const added = await approveBatch(asUrl, second.body.request_uri, [0]);
    const addedPackageId = added.body.package_id;

    // Cumulative view, resolved from EITHER end of the lineage, must agree.
    for (const anchor of [rootPackageId, addedPackageId]) {
      const view = await getCumulativeClientAccessForPackage(anchor);
      assert.equal(view.root_package_id, rootPackageId, `lineage root from ${anchor}`);
      assert.equal(view.client_id, 'longview');
      assert.equal(view.package_count, 2);
      assert.equal(view.children.length, 3, 'cumulative view unions all three child grants');
      assert.equal(view.active_child_count, 3);
      const lineagePackages = view.packages.map((p) => p.package_id).sort();
      assert.deepEqual(lineagePackages, [rootPackageId, addedPackageId].sort());
      // Each child carries its owning package id so the dashboard can group.
      const childPackages = new Set(view.children.map((c) => c.package_id));
      assert.deepEqual([...childPackages].sort(), [rootPackageId, addedPackageId].sort());
    }

    // The cumulative-view route surfaces the lineage and stays owner-gated.
    const resp = await fetch(`${asUrl}/_ref/grant-packages/${addedPackageId}/cumulative`);
    assert.equal(resp.status, 200);
    const routeBody = await resp.json();
    assert.equal(routeBody.object, 'grant_package_cumulative_view');
    assert.equal(routeBody.root_package_id, rootPackageId);
    assert.equal(routeBody.package_count, 2);
    assert.equal(routeBody.active_child_count, 3);
    assert.equal(routeBody.children.length, 3);
    // No token / secret material leaks.
    const serialized = JSON.stringify(routeBody);
    assert.doesNotMatch(serialized, /access_token|refresh_token|"token"|token_hash/);
  });
});

test('parent linkage: revoking one child grant updates the cumulative active count, leaves others active', async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    const first = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);
    const root = await approveBatch(asUrl, first.body.request_uri, [0, 1]);
    const rootPackageId = root.body.package_id;
    const spotifyChild = root.body.grant.child_grants.find((c) => c.source.id === 'spotify');

    const second = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
      { parent_package_id: rootPackageId },
    );
    const added = await approveBatch(asUrl, second.body.request_uri, [0]);

    // Revoke one root child grant directly (per-grant revocation stays primary).
    await revokeGrant(spotifyChild.grant_id, { request_id: 'parent-linkage-child-revoke-test' });

    const view = await getCumulativeClientAccessForPackage(added.body.package_id);
    assert.equal(view.children.length, 3, 'cumulative view still lists every issued child');
    assert.equal(view.active_child_count, 2, 'one child revoked, two remain active');
  });
});

test('parent linkage: a non-existent parent fails closed before issuing', async () => {
  await withHarness(async ({ asUrl, github }) => {
    const resp = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
      { parent_package_id: 'gpkg_does_not_exist' },
    );
    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, 'invalid_request');
    assert.match(resp.body.error.message, /does not exist/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_packages').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  });
});

test('parent linkage: a cross-client parent fails closed', async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    // Root package owned by 'longview'.
    const first = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);
    const root = await approveBatch(asUrl, first.body.request_uri, [0, 1]);
    const rootPackageId = root.body.package_id;

    // A different registered client attempts to link to longview's package.
    const cross = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
      { parent_package_id: rootPackageId },
      'concert_recommendation_app',
    );
    assert.equal(cross.status, 400);
    assert.match(cross.body.error.message, /different client/);
  });
});

test('parent linkage: an inactive (revoked) parent fails closed', async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    const first = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);
    const root = await approveBatch(asUrl, first.body.request_uri, [0, 1]);
    const rootPackageId = root.body.package_id;

    // Revoke the whole root package.
    const revoke = await fetch(`${asUrl}/_ref/grant-packages/${rootPackageId}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.ok(revoke.status < 400, 'package revoke should succeed');

    const linked = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
      { parent_package_id: rootPackageId },
    );
    assert.equal(linked.status, 400);
    assert.match(linked.body.error.message, /revoked|inactive/);
  });
});

test('parent linkage: a malformed parent_package_id fails closed', async () => {
  await withHarness(async ({ asUrl, github }) => {
    const resp = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
      { parent_package_id: '   ' },
    );
    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, 'invalid_request');
  });
});

test('parent linkage: a single-entry request without parent_package_id stays on the default grant path', async () => {
  await withHarness(async ({ asUrl, github }) => {
    const resp = await par(
      asUrl,
      [detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }])],
    );
    assert.equal(resp.status, 201);

    const approved = await approve(asUrl, {
      request_uri: resp.body.request_uri,
      subject_id: 'owner_local',
    });
    assert.equal(approved.status, 200);
    assert.ok(approved.body.grant.grant_id.startsWith('grt_'));
    assert.equal(approved.body.package_id, undefined);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_packages').get().n, 0);
  });
});

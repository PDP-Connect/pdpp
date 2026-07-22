// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';
import {
  getGrantPackageIdForGrant,
  listGrantPackagesForOwner,
  parsePendingConsentRequestUri,
} from '../server/auth.js';

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

async function withHarness(fn) {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const spotify = loadManifest('spotify');
  const reddit = loadManifest('reddit');
  const github = loadManifest('github');
  try {
    for (const manifest of [spotify, reddit, github]) {
      const resp = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.ok(resp.status < 400, `connector registration for ${manifest.connector_id} should succeed`);
    }
    await fn({ asUrl, spotify, reddit, github });
  } finally {
    await closeServer(server);
  }
}

async function registerManifest(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.ok(resp.status < 400, `connector registration for ${manifest.connector_id} should succeed`);
}

function detail(source, streams, overrides = {}) {
  return {
    type: 'https://pdpp.org/data-access',
    source,
    purpose_code: 'https://pdpp.org/purpose/personalization',
    access_mode: 'continuous',
    streams,
    ...overrides,
  };
}

async function par(asUrl, authorizationDetails) {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'longview',
      client_display: { name: 'Longview' },
      authorization_details: authorizationDetails,
    }),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function consentPage(asUrl, requestUri) {
  const resp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
  return { status: resp.status, html: await resp.text() };
}

async function approve(asUrl, body) {
  const resp = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function approveForm(asUrl, fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      params.append(key, String(item));
    }
  }
  const resp = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

test('batch consent gate: page defaults to per-source confirmation and suppresses approve-all for continuous all-streams', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { status, body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: '*' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);
    assert.equal(status, 201);

    const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(body.request_uri)}`);
    assert.equal(consentResp.status, 200);
    const html = await consentResp.text();
    assert.match(html, /Reference-experimental batch consent/);
    assert.match(html, /Confirm each source/);
    assert.match(html, /name="approved_source_indexes"/);
    assert.match(html, /Per-source confirmation required/);
    assert.doesNotMatch(html, /I confirm allowing all/);
  });
});

test('batch consent gate: suppressed approve-all cannot silently approve every source', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: '*' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const denied = await approve(asUrl, { request_uri: body.request_uri, subject_id: 'owner_local' });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, 'invalid_request');
    assert.match(denied.body.error.message, /Approve-all is not available/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_packages').get().n, 0);
  });
});

test('batch consent gate: sensitive source with no time bound suppresses approve-all', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    await registerManifest(asUrl, { ...spotify, sensitivity: 'sensitive' });
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }], { access_mode: 'single_use' }),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }], { access_mode: 'single_use' }),
    ]);

    const denied = await approve(asUrl, { request_uri: body.request_uri, subject_id: 'owner_local' });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error.message, /sensitive_no_time_bound/);
  });
});

test('batch consent gate: three sensitive sources suppress approve-all', async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    for (const manifest of [spotify, reddit, github]) {
      await registerManifest(asUrl, { ...manifest, sensitivity: 'sensitive' });
    }
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }], { access_mode: 'single_use' }),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }], { access_mode: 'single_use' }),
      detail({ kind: 'connector', id: github.connector_id }, [{ name: 'repositories' }], { access_mode: 'single_use' }),
    ]);

    const denied = await approve(asUrl, { request_uri: body.request_uri, subject_id: 'owner_local' });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error.message, /three_or_more_sensitive_sources/);
  });
});

test('batch consent gate: explicit per-source indexes issue only the selected child grants', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: '*' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const approved = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [1],
    });
    assert.equal(approved.status, 200);
    assert.ok(approved.body.package_id?.startsWith('gpkg_'));
    assert.equal(approved.body.grant.child_grants.length, 1);
    assert.equal(approved.body.grant.child_grants[0].source.id, 'reddit');

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_package_members').get().n, 1);
  });
});

test('batch consent gate: approved sources become independent child grants under one package', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const approved = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
    });
    assert.equal(approved.status, 200);
    assert.ok(approved.body.package_id?.startsWith('gpkg_'));
    assert.equal(approved.body.grant.package, true);
    assert.equal(approved.body.grant.child_grants.length, 2);
    assert.deepEqual(
      approved.body.grant.child_grants.map((child) => child.source.id).sort(),
      ['reddit', 'spotify'],
    );

    const db = getDb();
    const pkg = db
      .prepare('SELECT package_id, status FROM grant_packages WHERE package_id = ?')
      .get(approved.body.package_id);
    assert.equal(pkg.status, 'active');
    const members = db
      .prepare('SELECT grant_id, token_id FROM grant_package_members WHERE package_id = ?')
      .all(approved.body.package_id);
    assert.equal(members.length, 2);
    assert.equal(new Set(members.map((member) => member.grant_id)).size, 2);
    assert.equal(new Set(members.map((member) => member.token_id)).size, 2);
    assert.ok(!members.some((member) => member.token_id === approved.body.token));

    const owned = await listGrantPackagesForOwner({ limit: 50 });
    const listed = owned.data.find((entry) => entry.package_id === approved.body.package_id);
    assert.equal(listed?.member_count, 2);
    for (const member of members) {
      assert.equal(await getGrantPackageIdForGrant(member.grant_id), approved.body.package_id);
    }
  });
});

test('batch consent gate: low-risk approve-all requires re-asserting confirmation', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const entries = [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }], { access_mode: 'single_use' }),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }], { access_mode: 'single_use' }),
    ];
    const first = await par(asUrl, entries);

    const missingConfirmation = await approve(asUrl, {
      request_uri: first.body.request_uri,
      subject_id: 'owner_local',
    });
    assert.equal(missingConfirmation.status, 400);
    assert.match(missingConfirmation.body.error.message, /requires a re-asserting confirmation/);

    const second = await par(asUrl, entries);
    const approved = await approve(asUrl, {
      request_uri: second.body.request_uri,
      subject_id: 'owner_local',
      confirm_approve_all: true,
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.grant.child_grants.length, 2);
  });
});

test('batch consent gate: invalid approval indexes reject before issuing a package', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const rejected = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [2],
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /out-of-range/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_packages').get().n, 0);
  });
});

test('batch consent gate: staged batch remains source-bounded in storage', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { status, body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);
    assert.equal(status, 201);

    const deviceCode = parsePendingConsentRequestUri(body.request_uri);
    const row = getDb().prepare('SELECT params_json FROM pending_consents WHERE device_code = ?').get(deviceCode);
    const stored = JSON.parse(row.params_json);
    assert.equal(stored.request_kind, 'pdpp_selection_request_batch');
    assert.deepEqual(stored.entries.map((entry) => entry.source_binding.id), ['spotify', 'reddit']);
  });
});

test('batch consent gate: a request at the warning threshold surfaces the broad-setup warning', async () => {
  await withHarness(async ({ asUrl, spotify }) => {
    // Soft cap is 8, warning threshold is 6. Six entries warns but does not exceed the cap.
    const entries = Array.from({ length: 6 }, () =>
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]));
    const { status, body } = await par(asUrl, entries);
    assert.equal(status, 201);

    const { status: pageStatus, html } = await consentPage(asUrl, body.request_uri);
    assert.equal(pageStatus, 200);
    assert.match(html, /Broad setup/);
    assert.match(html, /reference warning threshold/);
    // At the warning threshold but not over the cap: no over-cap flag.
    assert.doesNotMatch(html, /Over the soft cap/);
  });
});

test('batch consent gate: over-soft-cap requests are flagged with affected sources, never silently dropped', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Nine entries exceeds the soft cap of 8. The first eight are spotify; the
    // ninth is reddit — the over-cap source that must be named.
    const entries = [
      ...Array.from({ length: 8 }, () =>
        detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }])),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ];
    const { status, body } = await par(asUrl, entries);
    // Soft cap is not a hard cap: the request is accepted, not rejected.
    assert.equal(status, 201);

    // All nine sources are persisted — nothing is silently truncated.
    const deviceCode = parsePendingConsentRequestUri(body.request_uri);
    const row = getDb().prepare('SELECT params_json FROM pending_consents WHERE device_code = ?').get(deviceCode);
    const stored = JSON.parse(row.params_json);
    assert.equal(stored.entries.length, 9);
    assert.equal(stored.over_soft_cap, true);
    assert.deepEqual(stored.over_cap_sources.map((source) => source.id), ['reddit']);

    // The ceremony flags the over-cap condition and names the affected source.
    const { status: pageStatus, html } = await consentPage(asUrl, body.request_uri);
    assert.equal(pageStatus, 200);
    assert.match(html, /Over the soft cap/);
    assert.match(html, /above the reference soft cap of 8/);
    assert.match(html, /reddit/);
  });
});

test('batch consent gate: a package mixing access modes across approved sources is rejected, not issued', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Two approved sources declaring different access modes. A package applies one
    // access mode to every child grant in this tranche, so the mix must be rejected
    // before any package or child grant is issued — not silently collapsed.
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }], { access_mode: 'continuous' }),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }], { access_mode: 'single_use' }),
    ]);

    const denied = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, 'invalid_request');
    assert.match(denied.body.error.message, /one access mode to every source/);
    assert.match(denied.body.error.message, /continuous, single_use/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_packages').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_package_members').get().n, 0);
  });
});

function childGrantStreams(db, packageId, sourceId) {
  const rows = db
    .prepare(
      `SELECT g.grant_json
         FROM grant_package_members m
         JOIN grants g ON g.grant_id = m.grant_id
        WHERE m.package_id = ?`,
    )
    .all(packageId)
    .map((row) => JSON.parse(row.grant_json));
  const grant = rows.find((g) => g.source?.id === sourceId);
  return grant ? grant.streams : null;
}

test('batch consent narrowing: owner defers a source by approving a subset', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    // Approve only spotify (index 0); defer reddit (index 1).
    const approved = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0],
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.grant.child_grants.length, 1);
    assert.equal(approved.body.grant.child_grants[0].source.id, 'spotify');

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 1);
    // No reddit grant issued from this ceremony.
    assert.equal(childGrantStreams(db, approved.body.package_id, 'reddit'), null);
  });
});

test('batch consent narrowing: HTML form defers a source even when nested controls submit', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const approved = await approveForm(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: '0',
      // The rendered form keeps nested stream checkboxes checked even when the
      // owner unchecks the parent source. The flat form parser must ignore the
      // deferred source's narrowing controls so ordinary defer does not fail.
      narrow_streams_0: 'top_artists',
      narrow_streams_1: 'posts',
    });

    assert.equal(approved.status, 200);
    assert.equal(approved.body.grant.child_grants.length, 1);
    assert.equal(approved.body.grant.child_grants[0].source.id, 'spotify');

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 1);
    assert.equal(childGrantStreams(db, approved.body.package_id, 'reddit'), null);
  });
});

test('batch consent narrowing: owner reduces a wildcard source to a single stream', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // spotify staged as wildcard (all streams); reddit as posts.
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: '*' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const approved = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      source_narrowing: { 0: { streams: ['top_artists'] } },
    });
    assert.equal(approved.status, 200);

    const db = getDb();
    const spotifyStreams = childGrantStreams(db, approved.body.package_id, 'spotify');
    assert.deepEqual(
      spotifyStreams.map((s) => s.name),
      ['top_artists'],
    );
    // reddit untouched.
    const redditStreams = childGrantStreams(db, approved.body.package_id, 'reddit');
    assert.deepEqual(
      redditStreams.map((s) => s.name),
      ['posts'],
    );
  });
});

// Narrowing only engages on the batch path (authorization_details.length > 1),
// so every narrowing test stages at least two source-bounded entries and
// targets narrowing at the spotify entry (index 0). reddit (index 1) is the
// second staged source.

test('batch consent narrowing: owner reduces a stream to a subset of staged fields', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [
        { name: 'top_artists', fields: ['id', 'name', 'genres', 'popularity'] },
      ]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const approved = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      source_narrowing: { 0: { fields: { top_artists: ['id', 'name'] } } },
    });
    assert.equal(approved.status, 200);

    const db = getDb();
    const streams = childGrantStreams(db, approved.body.package_id, 'spotify');
    assert.equal(streams.length, 1);
    assert.deepEqual(streams[0].fields, ['id', 'name']);
  });
});

test('batch consent narrowing: owner tightens an existing time bound', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [
        { name: 'top_artists', time_range: { since: '2026-01-01T00:00:00Z' } },
      ]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const approved = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      source_narrowing: { 0: { since: { top_artists: '2026-03-01T00:00:00Z' } } },
    });
    assert.equal(approved.status, 200);

    const db = getDb();
    const streams = childGrantStreams(db, approved.body.package_id, 'spotify');
    assert.equal(streams[0].time_range.since, '2026-03-01T00:00:00Z');
  });
});

test('batch consent narrowing: widening streams beyond the staged set is rejected', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Stage only top_artists for spotify; try to "narrow" to a stream that was
    // not staged.
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const rejected = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      source_narrowing: { 0: { streams: ['top_artists', 'saved_tracks'] } },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'invalid_request');
    assert.match(rejected.body.error.message, /widening is forbidden/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grant_packages').get().n, 0);
  });
});

test('batch consent narrowing: widening fields beyond the staged set is rejected', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [
        { name: 'top_artists', fields: ['id', 'name'] },
      ]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const rejected = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      // 'genres' is a real manifest field but was NOT in the staged field set.
      source_narrowing: { 0: { fields: { top_artists: ['id', 'genres'] } } },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /not in the staged field set/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  });
});

test('batch consent narrowing: a since bound earlier than the staged bound is rejected', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [
        { name: 'top_artists', time_range: { since: '2026-03-01T00:00:00Z' } },
      ]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const rejected = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      source_narrowing: { 0: { since: { top_artists: '2026-01-01T00:00:00Z' } } },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /earlier than the staged bound/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  });
});

test('batch consent narrowing: a malformed since value is rejected before issuing', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [
        { name: 'top_artists', time_range: { since: '2026-01-01T00:00:00Z' } },
      ]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const rejected = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      source_narrowing: { 0: { since: { top_artists: 'not-a-date' } } },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /not a valid ISO-8601 instant/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  });
});

test('batch consent narrowing: a field subset on an unprojected stream is rejected', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // spotify top_artists staged with NO field projection. A field subset
    // cannot be proven narrower against an unprojected (full-record) stream, so
    // the narrowing is rejected rather than silently issuing the full record.
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const rejected = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
      source_narrowing: { 0: { fields: { top_artists: ['id'] } } },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /no field projection/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  });
});

test('batch consent narrowing: narrowing a source that was not approved is rejected', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const rejected = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0],
      // index 1 (reddit) was deferred, so narrowing it is a mistake.
      source_narrowing: { 1: { streams: ['posts'] } },
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /not in the approved set/);

    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  });
});

test('batch consent narrowing: ceremony renders per-source narrowing controls', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [
        { name: 'top_artists', fields: ['id', 'name'], time_range: { since: '2026-01-01T00:00:00Z' } },
      ]),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }]),
    ]);

    const { status, html } = await consentPage(asUrl, body.request_uri);
    assert.equal(status, 200);
    assert.match(html, /Narrow this source/);
    assert.match(html, /name="narrow_streams_0"/);
    // top_artists staged with explicit fields → field checkboxes rendered.
    assert.match(html, /name="narrow_fields_0__/);
    // top_artists staged with a time bound → since input rendered.
    assert.match(html, /name="narrow_since_0__/);
  });
});

test('batch consent gate: a uniform-access-mode package issues all children under one access mode', async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Both sources declare single_use — a uniform-mode batch issues every child
    // grant under that one access mode.
    const { body } = await par(asUrl, [
      detail({ kind: 'connector', id: spotify.connector_id }, [{ name: 'top_artists' }], { access_mode: 'single_use' }),
      detail({ kind: 'connector', id: reddit.connector_id }, [{ name: 'posts' }], { access_mode: 'single_use' }),
    ]);

    const approved = await approve(asUrl, {
      request_uri: body.request_uri,
      subject_id: 'owner_local',
      approved_source_indexes: [0, 1],
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.grant.child_grants.length, 2);

    const db = getDb();
    const modes = db
      .prepare(
        `SELECT DISTINCT g.access_mode
           FROM grant_package_members m
           JOIN grants g ON g.grant_id = m.grant_id
          WHERE m.package_id = ?`,
      )
      .all(approved.body.package_id)
      .map((row) => row.access_mode);
    assert.deepEqual(modes, ['single_use']);
  });
});

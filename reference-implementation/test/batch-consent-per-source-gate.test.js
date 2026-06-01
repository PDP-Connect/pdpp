import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';
import { parsePendingConsentRequestUri } from '../server/auth.js';

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

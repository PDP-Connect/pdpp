// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog completeness for the reference operator console — and the
 * catalog-vs-connection lifecycle boundary.
 *
 * The honesty contract from
 * `openspec/changes/add-connector-public-listing-honesty/` says any
 * first-party manifest under `packages/polyfill-connectors/manifests/`
 * that declares `capabilities.public_listing.listed: true` SHALL be
 * visible in the reference connector catalog after the reference starts up —
 * even on a fresh database, before any schedule, run, or connection row
 * exists.
 *
 * `openspec/changes/separate-connector-catalog-from-connections/` refines
 * what "visible in the catalog" means: catalog completeness is owned by the
 * registered `connectors` table (the connectors you CAN add), NOT by
 * `connector_instances` (the connections you HAVE configured). A dashboard /
 * catalog read SHALL NOT materialize a default-account `connector_instances`
 * row for every listed connector — a read must not persist a connection, and
 * an owner with zero connections SHALL see zero connections while still being
 * able to discover the full catalog.
 *
 * This test exercises both halves end to end:
 *   1. Initialize a fresh DB.
 *   2. Run `reconcilePolyfillManifests` against the real shipped manifests.
 *   3. Catalog completeness: every listed=true first-party manifest resolves
 *      via `listPublicCatalogConnectorIds()` — which reads registered
 *      manifests, independent of any connection row — and is recognized as a
 *      public catalog connector.
 *   4. Lifecycle boundary: `listConnectorSummaries()` (the owner connection
 *      projection) returns ZERO connections on a fresh DB, and the read
 *      persists ZERO `connector_instances` rows (no phantom default-account
 *      connections).
 *
 * The complement (hidden / unproven / local-device manifests stay
 * out of the public catalog) is asserted at the unit level in
 * `polyfill-manifest-reconcile-invalidation.test.js` and the
 * per-manifest catalog filter is pinned in
 * `ref-connectors-list-operation.test.js`. Both paths are kept
 * independent so a regression in one cannot mask the other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { closeDb, initDb } from '../server/db.js';
import {
  defaultPolyfillManifestsDir,
  reconcilePolyfillManifests,
} from '../server/polyfill-manifest-reconcile.ts';
import {
  listConnectorSummaries,
  listPublicCatalogConnectorIds,
} from '../server/ref-control.ts';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = resolve(__dirname, '..', '..', 'packages', 'polyfill-connectors', 'manifests');
const REFERENCE_OWNER_SUBJECT_ID = 'owner_local';

function listFirstPartyManifestNames() {
  return readdirSync(POLYFILL_MANIFESTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function readManifest(filename) {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, filename), 'utf8'));
}

// The operator catalog projects connectors under their canonical connector
// key (Decision 1), so the expected sets here resolve each manifest's
// URL-shaped connector_id to its canonical key before comparing against the
// surface output. canonicalConnectorKey(x) ?? x leaves non-first-party shapes
// untouched, matching the runtime's own identity function.
function listedConnectorIds() {
  const ids = [];
  for (const filename of listFirstPartyManifestNames()) {
    const manifest = readManifest(filename);
    if (manifest?.capabilities?.public_listing?.listed === true && typeof manifest.connector_id === 'string') {
      ids.push(canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id);
    }
  }
  return ids.sort();
}

function unlistedConnectorIds() {
  const ids = [];
  for (const filename of listFirstPartyManifestNames()) {
    const manifest = readManifest(filename);
    if (manifest?.capabilities?.public_listing?.listed !== true && typeof manifest.connector_id === 'string') {
      ids.push(canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id);
    }
  }
  return ids.sort();
}

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-public-catalog-completeness-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('defaultPolyfillManifestsDir resolves to the shipped first-party manifests dir', () => {
  // Defensive: if defaultPolyfillManifestsDir() ever drifts, every
  // subsequent assertion in this file becomes vacuously true. Pin the
  // expected location so the gap repair stays load-bearing.
  assert.equal(defaultPolyfillManifestsDir(), POLYFILL_MANIFESTS_DIR);
});

test('every listed=true first-party manifest is catalog-visible after startup reconciliation, with no connection row', withTmpDb(async () => {
  const expectedListed = listedConnectorIds();
  assert.ok(
    expectedListed.length > 0,
    'first-party manifest set must contain at least one listed=true manifest for this test to be meaningful',
  );

  const summary = await reconcilePolyfillManifests({
    enabled: true,
    log: () => {},
  });

  assert.equal(summary.errors, 0, 'reconciliation completes without errors');
  assert.ok(
    summary.registered >= expectedListed.length,
    `reconciliation must register at least every listed manifest (registered=${summary.registered}, listed=${expectedListed.length})`,
  );

  // Catalog completeness is owned by the registered connectors table, not by
  // connection rows. The public catalog projection (`listPublicCatalogConnectorIds`,
  // which reads the registered `connectors` table filtered by
  // `isPublicReferenceConnector` and creates no connection row) must contain
  // every listed=true first-party connector.
  const catalog = await listPublicCatalogConnectorIds();
  const visible = new Set(catalog);
  const missing = expectedListed.filter((id) => !visible.has(id));
  assert.deepEqual(
    missing,
    [],
    `listed=true first-party manifests must appear in the public connector catalog after startup: missing ${missing.join(', ')}`,
  );
}));

test('a fresh-DB catalog read projects zero connections and persists no phantom connection rows', withTmpDb(async () => {
  await reconcilePolyfillManifests({ enabled: true, log: () => {} });

  const store = createSqliteConnectorInstanceStore();
  // Pre-condition: a freshly reconciled instance has registered connectors
  // but no configured connections.
  assert.equal(
    store.listByOwner(REFERENCE_OWNER_SUBJECT_ID).length,
    0,
    'fresh instance starts with zero connector_instances rows',
  );

  // The owner connection projection is the path that previously
  // materialized one default-account connection per registered connector.
  const summaries = await listConnectorSummaries();
  assert.equal(
    summaries.length,
    0,
    `owner with zero connections must see zero connections, not phantom catalog rows (saw ${summaries.length})`,
  );

  // The read SHALL NOT persist a connection. After the projection, the
  // owner's connector_instances set must still be empty.
  assert.equal(
    store.listByOwner(REFERENCE_OWNER_SUBJECT_ID).length,
    0,
    'catalog/dashboard read must not persist any connector_instances row',
  );
}));

test('hidden / unproven first-party manifests stay out of the public catalog', withTmpDb(async () => {
  const hidden = unlistedConnectorIds();
  assert.ok(
    hidden.length > 0,
    'first-party manifest set must contain at least one hidden manifest for this test to be meaningful',
  );

  await reconcilePolyfillManifests({ enabled: true, log: () => {} });

  const catalog = new Set(await listPublicCatalogConnectorIds());
  const leaks = hidden.filter((id) => catalog.has(id));
  assert.deepEqual(
    leaks,
    [],
    `hidden / unproven first-party manifests must NOT be public catalog connectors: leaked ${leaks.join(', ')}`,
  );
}));

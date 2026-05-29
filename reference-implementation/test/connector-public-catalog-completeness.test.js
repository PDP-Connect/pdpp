/**
 * Catalog completeness for the reference operator console.
 *
 * The honesty contract from
 * `openspec/changes/add-connector-public-listing-honesty/` says any
 * first-party manifest under `packages/polyfill-connectors/manifests/`
 * that declares `capabilities.public_listing.listed: true` SHALL be
 * visible on `GET /_ref/connectors` after the reference starts up —
 * even on a fresh database, before any schedule or run row exists.
 *
 * This test exercises the path that closes the gap end to end:
 *   1. Initialize a fresh DB.
 *   2. Run `reconcilePolyfillManifests` against the real shipped
 *      manifests directory.
 *   3. Project the connectors table through `listConnectorSummaries`
 *      and confirm every listed=true first-party manifest is present.
 *
 * The complement (hidden / unproven / local-device manifests stay
 * invisible) is asserted at the unit level in
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
import { listConnectorSummaries } from '../server/ref-control.ts';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = resolve(__dirname, '..', '..', 'packages', 'polyfill-connectors', 'manifests');

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

test('every listed=true first-party manifest is visible on the operator catalog after startup reconciliation', withTmpDb(async () => {
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

  const summaries = await listConnectorSummaries();
  const visibleIds = summaries.map((row) => row.connector_id).sort();

  const missing = expectedListed.filter((id) => !visibleIds.includes(id));
  assert.deepEqual(
    missing,
    [],
    `listed=true first-party manifests must appear in the operator catalog after startup: missing ${missing.join(', ')}`,
  );
}));

test('hidden / unproven first-party manifests remain invisible on the operator catalog after startup reconciliation', withTmpDb(async () => {
  const hidden = unlistedConnectorIds();
  assert.ok(
    hidden.length > 0,
    'first-party manifest set must contain at least one hidden manifest for this test to be meaningful',
  );

  await reconcilePolyfillManifests({ enabled: true, log: () => {} });

  const summaries = await listConnectorSummaries();
  const visibleIds = new Set(summaries.map((row) => row.connector_id));

  const leaks = hidden.filter((id) => visibleIds.has(id));
  assert.deepEqual(
    leaks,
    [],
    `hidden / unproven first-party manifests must NOT appear in the operator catalog: leaked ${leaks.join(', ')}`,
  );
}));

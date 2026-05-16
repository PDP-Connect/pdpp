/**
 * Polyfill manifest reconciliation must invalidate prior-shape records on
 * the narrow seed/reference-fixture → polyfill transition, and MUST preserve
 * records on every other manifest evolution. The trust contract is at
 * openspec/changes/reconcile-invalidates-stale-records/.
 *
 * The motivating bug: `pdpp seed` registers reference fixture manifests
 * under the same connector_id as the shipped polyfill manifests and emits
 * seed-fake records (Taylor Swift, Adele, etc.). Without invalidation, the
 * next reference startup overwrites the persisted manifest with the
 * polyfill version but leaves the seed-fake records sitting in the RS,
 * where the dashboard advertises them as fresh real data.
 *
 * The opposite failure mode is just as bad: deleting an owner's real
 * records on every ordinary manifest update (semantic_fields, descriptions,
 * range filters, view additions). The fingerprint-gated transition keeps
 * the destructive path narrow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  getConnectorManifest,
  registerConnector,
} from '../server/auth.js';
import { ingestRecord } from '../server/records.js';
import { reconcilePolyfillManifests } from '../server/polyfill-manifest-reconcile.ts';

const CONNECTOR_ID = 'https://registry.pdpp.test/connectors/seed-flip';

function referenceFixtureManifest(overrides = {}) {
  return {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Seed flip fixture (reference shape)',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'top_artists',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            source_updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'source_updated_at'],
        },
        primary_key: ['id'],
        cursor_field: 'source_updated_at',
        selection: { fields: true, resources: true },
      },
    ],
    ...overrides,
  };
}

function shippedPolyfillManifest(overrides = {}) {
  // Same connector_id but different (version, sorted-stream-names)
  // fingerprint, matching the real spotify reference→polyfill drift shape.
  return {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '0.1.0',
    display_name: 'Seed flip fixture (polyfill shape)',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'top_artists',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            source_updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'source_updated_at'],
        },
        primary_key: ['id'],
        cursor_field: 'source_updated_at',
        selection: { fields: true, resources: true },
      },
      {
        name: 'saved_tracks',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            saved_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'saved_at'],
        },
        primary_key: ['id'],
        cursor_field: 'saved_at',
        selection: { fields: true, resources: true },
      },
    ],
    ...overrides,
  };
}

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-reconcile-invalidate-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn({ dir });
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function writeManifestsDir(rootDir, subdir, manifests) {
  const dir = join(rootDir, subdir);
  mkdirSync(dir, { recursive: true });
  for (const [filename, manifest] of Object.entries(manifests)) {
    writeFileSync(join(dir, filename), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

function recordCount(connectorId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS count FROM records WHERE connector_id = ?')
    .get(connectorId).count;
}

function recordKeys(connectorId) {
  return getDb()
    .prepare('SELECT record_key FROM records WHERE connector_id = ? ORDER BY record_key ASC')
    .all(connectorId)
    .map((row) => row.record_key);
}

async function ingestSeedFakeArtists(connectorId) {
  // Same fixture identities the real reference seed connector emits.
  const artists = [
    { id: 'spotify:artist:0L8ExT028jH3ddEcZwqJJ5', name: 'Taylor Swift', source_updated_at: '2026-04-20T00:00:00Z' },
    { id: 'spotify:artist:4dpARuHxo51G3z768sgnrY', name: 'Adele', source_updated_at: '2026-04-15T00:00:00Z' },
  ];
  for (const data of artists) {
    await ingestRecord(connectorId, {
      stream: 'top_artists',
      key: data.id,
      data,
      emitted_at: data.source_updated_at,
    });
  }
}

async function ingestRealOwnerArtists(connectorId) {
  const artists = [
    { id: 'spotify:artist:owner-real-1', name: 'Real Owner Artist 1', source_updated_at: '2026-04-25T00:00:00Z' },
    { id: 'spotify:artist:owner-real-2', name: 'Real Owner Artist 2', source_updated_at: '2026-04-25T00:00:00Z' },
    { id: 'spotify:artist:owner-real-3', name: 'Real Owner Artist 3', source_updated_at: '2026-04-25T00:00:00Z' },
  ];
  for (const data of artists) {
    await ingestRecord(connectorId, {
      stream: 'top_artists',
      key: data.id,
      data,
      emitted_at: data.source_updated_at,
    });
  }
}

test('reconciliation invalidates seed-fake records on the reference-fixture → polyfill transition', withTmpDb(async ({ dir }) => {
  // 1. Persist the reference-fixture-shape manifest, then ingest seed-fake
  //    records under it (the `pdpp seed` flow against reference fixtures).
  await registerConnector(referenceFixtureManifest());
  await ingestSeedFakeArtists(CONNECTOR_ID);
  assert.equal(recordCount(CONNECTOR_ID), 2, 'baseline: seed-fake records present');
  assert.deepEqual(
    recordKeys(CONNECTOR_ID),
    ['spotify:artist:0L8ExT028jH3ddEcZwqJJ5', 'spotify:artist:4dpARuHxo51G3z768sgnrY'],
    'baseline: the two seed-fake artists are persisted',
  );

  // 2. Stand up a shipped-manifests directory with the polyfill-shape
  //    manifest and a reference-fixtures dir containing the fixture manifest.
  //    The reference-fixtures dir is what makes reconciliation recognize
  //    that the persisted manifest fingerprint belongs to the seed flow.
  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': shippedPolyfillManifest() });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {
    'seed-flip.json': referenceFixtureManifest(),
  });

  // 3. Run reconciliation. Persisted matches the reference-fixture
  //    fingerprint → narrow transition → invalidate.
  const lines = [];
  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: (line) => lines.push(line),
  });

  assert.equal(recordCount(CONNECTOR_ID), 0, 'no records remain for the flipped connector');
  assert.equal(summary.invalidatedConnectors, 1, 'summary counts the connector as invalidated');
  assert.equal(summary.invalidatedRecords, 2, 'summary counts deleted records');
  assert.equal(summary.updated, 1, 'manifest was re-registered to the polyfill shape');
  assert.equal(summary.errors, 0, 'no reconciliation errors');

  const persisted = await getConnectorManifest(CONNECTOR_ID);
  assert.equal(persisted.version, '0.1.0', 'persisted manifest is the shipped polyfill version');
  const streamNames = persisted.streams.map((s) => s.name).sort();
  assert.deepEqual(streamNames, ['saved_tracks', 'top_artists'], 'persisted manifest is the polyfill shape');

  const invalidationLine = lines.find((line) => line.includes('invalidated'));
  assert.ok(invalidationLine, 'reconciliation emits an invalidation log line');
  assert.match(invalidationLine, /seed-flip/);
  assert.match(invalidationLine, /2 record/);
}));

test('reconciliation preserves owner records when polyfill manifest evolves with new semantic_fields only', withTmpDb(async ({ dir }) => {
  // Persist the polyfill manifest and ingest real owner records under it.
  // Then ship an evolution that adds `query.search.semantic_fields` to a
  // stream — a structural diff, but NOT a fixture→polyfill transition.
  // Owner records MUST survive.
  await registerConnector(shippedPolyfillManifest());
  await ingestRealOwnerArtists(CONNECTOR_ID);
  assert.equal(recordCount(CONNECTOR_ID), 3);

  const evolved = shippedPolyfillManifest();
  evolved.streams[0].query = {
    search: { semantic_fields: ['name'] },
  };

  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': evolved });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {
    'seed-flip.json': referenceFixtureManifest(),
  });

  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: () => {},
  });

  assert.equal(summary.updated, 1, 'manifest evolution still re-registers');
  assert.equal(summary.invalidatedConnectors, 0, 'semantic_fields-only update must not invalidate');
  assert.equal(summary.invalidatedRecords, 0);
  assert.equal(recordCount(CONNECTOR_ID), 3, 'all owner records survive a semantic_fields update');

  const persisted = await getConnectorManifest(CONNECTOR_ID);
  assert.deepEqual(
    persisted.streams[0].query.search.semantic_fields,
    ['name'],
    'persisted manifest carries the new semantic_fields',
  );
}));

test('reconciliation preserves owner records when polyfill manifest evolves with display_name/description only', withTmpDb(async ({ dir }) => {
  await registerConnector(shippedPolyfillManifest());
  await ingestRealOwnerArtists(CONNECTOR_ID);
  assert.equal(recordCount(CONNECTOR_ID), 3);

  const evolved = shippedPolyfillManifest({
    display_name: 'Seed flip fixture (polyfill, copy revised)',
  });

  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': evolved });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {
    'seed-flip.json': referenceFixtureManifest(),
  });

  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: () => {},
  });

  assert.equal(summary.updated, 1);
  assert.equal(summary.invalidatedConnectors, 0, 'description-only update must not invalidate');
  assert.equal(summary.invalidatedRecords, 0);
  assert.equal(recordCount(CONNECTOR_ID), 3, 'all owner records survive a copy-only update');
}));

test('reconciliation preserves owner records when polyfill manifest version bumps but stream set is unchanged', withTmpDb(async ({ dir }) => {
  // Polyfill v0.1.0 → v0.2.0 with the same stream set is the common
  // "schema additions / view additions" path. Persisted fingerprint
  // (`v0.1.0`, top_artists+saved_tracks) does not match the reference
  // fixture fingerprint (`v1.0.0`, top_artists). No invalidation.
  await registerConnector(shippedPolyfillManifest());
  await ingestRealOwnerArtists(CONNECTOR_ID);
  assert.equal(recordCount(CONNECTOR_ID), 3);

  const evolved = shippedPolyfillManifest({ version: '0.2.0' });

  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': evolved });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {
    'seed-flip.json': referenceFixtureManifest(),
  });

  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: () => {},
  });

  assert.equal(summary.updated, 1);
  assert.equal(summary.invalidatedConnectors, 0, 'polyfill version bump alone must not invalidate');
  assert.equal(summary.invalidatedRecords, 0);
  assert.equal(recordCount(CONNECTOR_ID), 3, 'all owner records survive a polyfill version bump');
}));

test('reconciliation preserves owner records when no reference-fixture manifest exists for the connector_id', withTmpDb(async ({ dir }) => {
  // Polyfill-only connectors (no reference-fixture collision) cannot be in
  // the seed→polyfill transition. A manifest diff must never invalidate
  // their records.
  await registerConnector(shippedPolyfillManifest());
  await ingestRealOwnerArtists(CONNECTOR_ID);
  assert.equal(recordCount(CONNECTOR_ID), 3);

  const evolved = shippedPolyfillManifest({ version: '0.2.0' });

  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': evolved });
  // Empty reference-fixtures dir (mimics a polyfill-only connector).
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {});

  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: () => {},
  });

  assert.equal(summary.updated, 1);
  assert.equal(summary.invalidatedConnectors, 0);
  assert.equal(recordCount(CONNECTOR_ID), 3, 'records survive evolution of a polyfill-only connector');
}));

test('reconciliation does not delete records when the persisted manifest already matches the shipped manifest', withTmpDb(async ({ dir }) => {
  await registerConnector(shippedPolyfillManifest());
  await ingestRecord(CONNECTOR_ID, {
    stream: 'top_artists',
    key: 'spotify:artist:real',
    data: { id: 'spotify:artist:real', name: 'Real Artist', source_updated_at: '2026-04-25T00:00:00Z' },
    emitted_at: '2026-04-25T00:00:00Z',
  });
  assert.equal(recordCount(CONNECTOR_ID), 1, 'baseline: one record persisted under polyfill manifest');

  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': shippedPolyfillManifest() });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {
    'seed-flip.json': referenceFixtureManifest(),
  });
  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: () => {},
  });

  assert.equal(summary.unchanged, 1, 'reconciliation reports the manifest as unchanged');
  assert.equal(summary.invalidatedConnectors, 0, 'no invalidation when fingerprints match');
  assert.equal(summary.invalidatedRecords, 0, 'no records counted as invalidated');
  assert.equal(recordCount(CONNECTOR_ID), 1, 'records survive a no-op reconciliation');
}));

test('a direct registerConnector call with a different manifest does not delete records', withTmpDb(async () => {
  await registerConnector(referenceFixtureManifest());
  await ingestSeedFakeArtists(CONNECTOR_ID);
  assert.equal(recordCount(CONNECTOR_ID), 2);

  await registerConnector(shippedPolyfillManifest());
  assert.equal(
    recordCount(CONNECTOR_ID),
    2,
    'records survive a direct re-register (only reconciliation invalidates)',
  );
}));

test('reconciliation skips unlisted connectors that are not yet registered (no record invalidation, no auto-seed)', withTmpDb(async ({ dir }) => {
  // The shipped fixture used here does not declare
  // `capabilities.public_listing.listed: true`, so reconciliation MUST
  // NOT auto-seed it. This preserves the long-standing "don't surprise
  // owners with a custom-looking connector_id" guarantee for unlisted /
  // unproven manifests and keeps the destructive invalidation path
  // unreachable on first registration.
  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': shippedPolyfillManifest() });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {
    'seed-flip.json': referenceFixtureManifest(),
  });
  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: () => {},
  });

  assert.equal(summary.skipped, 1, 'unlisted connector with no persisted manifest is skipped');
  assert.equal(summary.registered, 0, 'unlisted manifests are not auto-registered');
  assert.equal(summary.updated, 0);
  assert.equal(summary.invalidatedConnectors, 0);
  assert.equal(summary.invalidatedRecords, 0);

  const persisted = await getConnectorManifest(CONNECTOR_ID);
  assert.equal(persisted, null, 'no connectors row is created for an unlisted shipped manifest');
}));

test('reconciliation auto-registers listed=true first-party manifests so the operator catalog can show them on a fresh DB', withTmpDb(async ({ dir }) => {
  // Catalog completeness: a first-party manifest that declares
  // `capabilities.public_listing.listed: true` must be present in the
  // connectors table on startup so `GET /_ref/connectors` and the
  // reference dashboard can surface it before the first schedule or run
  // row exists. See
  // openspec/changes/add-connector-public-listing-honesty/.
  const listedManifest = shippedPolyfillManifest({
    capabilities: {
      public_listing: { listed: true, status: 'proven' },
      refresh_policy: {
        recommended_mode: 'manual',
        background_safe: false,
        rationale: 'Listed first-party manifest must be visible on the operator catalog even with no schedule.',
      },
    },
  });
  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': listedManifest });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {});

  const lines = [];
  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: (line) => lines.push(line),
  });

  assert.equal(summary.registered, 1, 'listed first-party manifest is auto-registered');
  assert.equal(summary.skipped, 0, 'not skipped — the listed gate fires');
  assert.equal(summary.updated, 0, 'registration is not an update');
  assert.equal(summary.invalidatedConnectors, 0, 'first-time registration must not invalidate records');
  assert.equal(summary.invalidatedRecords, 0);
  assert.equal(summary.errors, 0);

  const persisted = await getConnectorManifest(CONNECTOR_ID);
  assert.ok(persisted, 'connector is persisted in the DB after reconciliation');
  assert.equal(persisted.connector_id, CONNECTOR_ID);
  assert.equal(persisted.capabilities?.public_listing?.listed, true);

  const registeredLine = lines.find((line) => line.includes('registered listed first-party manifest'));
  assert.ok(registeredLine, 'reconciliation emits a register log line');
  assert.match(registeredLine, /seed-flip/);
}));

test('reconciliation does not auto-register hidden manifests even when the file is shipped', withTmpDb(async ({ dir }) => {
  // The hidden/unproven half of the catalog-completeness rule: a manifest
  // shipped under packages/polyfill-connectors/manifests/ with
  // listed=false stays invisible to the operator catalog on a fresh DB.
  const hiddenManifest = shippedPolyfillManifest({
    capabilities: {
      public_listing: { listed: false, status: 'unproven' },
      refresh_policy: {
        recommended_mode: 'manual',
        background_safe: false,
        rationale: 'Unproven; hidden from the operator catalog until a credentialed run.',
      },
    },
  });
  const manifestsDir = writeManifestsDir(dir, 'polyfill', { 'seed-flip.json': hiddenManifest });
  const referenceFixturesDir = writeManifestsDir(dir, 'reference', {});

  const summary = await reconcilePolyfillManifests({
    enabled: true,
    manifestsDir,
    referenceFixturesDir,
    log: () => {},
  });

  assert.equal(summary.registered, 0, 'hidden manifest is not auto-registered');
  assert.equal(summary.skipped, 1, 'hidden manifest is skipped');
  const persisted = await getConnectorManifest(CONNECTOR_ID);
  assert.equal(persisted, null, 'no connectors row is created for a hidden shipped manifest');
}));

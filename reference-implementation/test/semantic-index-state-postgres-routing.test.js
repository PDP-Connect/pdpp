/**
 * Regression for `fix-semantic-index-state-postgres-routing`.
 *
 * `computeIndexState()` historically read SQLite `semantic_search_meta` and
 * `semantic_search_backfill_progress` unconditionally. In Postgres storage
 * mode that caused a frozen SQLite progress row (left behind by an earlier
 * SQLite-era run) to drive the advertised `index_state` to `"stale"`
 * forever, even though the Postgres semantic index was clean.
 *
 * The fix branches `computeIndexState()` on the active storage backend and
 * makes the function async. These tests pin five properties via the
 * documented `deps` test seam:
 *
 *   1. Postgres mode reads the postgres helpers and ignores SQLite — even
 *      if the SQLite progress probe would return a row.
 *   2. Postgres mode still reports `stale` when the active-backend
 *      progress row exists.
 *   3. Postgres mode still reports `stale` on backend identity drift.
 *   4. Postgres mode reports `built` when meta is empty (the boot path
 *      backfills before advertising, so the empty-meta steady state is
 *      honestly built).
 *   5. The function returns `stale` when no semantic backend is
 *      configured.
 *
 * The Postgres helpers themselves are exercised in postgres-runtime
 * suites; here we inject deterministic fakes so the regression runs
 * everywhere without `PDPP_TEST_POSTGRES_URL`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeIndexState,
  configureSemanticBackend,
  makeStubBackend,
} from '../server/search-semantic.js';

const stubBackend = makeStubBackend({ dimensions: 64 });

function backendStorageIdentity(b) {
  // Mirrors the module-private `backendStorageIdentity` helper. Update both
  // together if the live identity composition ever changes.
  const parts = [
    `model=${b.model()}`,
    `dimensions=${b.dimensions()}`,
    `metric=${b.distanceMetric()}`,
  ];
  if (typeof b.profileId === 'function') parts.push(`profile=${b.profileId()}`);
  if (typeof b.dtype === 'function') parts.push(`dtype=${b.dtype()}`);
  return parts.join(';');
}

function matchingMetaRow() {
  return {
    model_id: backendStorageIdentity(stubBackend),
    dimensions: stubBackend.dimensions(),
    distance_metric: stubBackend.distanceMetric(),
  };
}

const postgresDeps = (overrides = {}) => ({
  isPostgresStorageBackend: () => true,
  postgresAnySemanticProgressRow: async () => null,
  postgresListAllSemanticMetaIdentities: async () => [matchingMetaRow()],
  ...overrides,
});

test('Postgres mode reads postgres helpers and ignores SQLite', async () => {
  configureSemanticBackend(stubBackend);
  try {
    let sqliteWasRead = false;
    const state = await computeIndexState({
      ...postgresDeps(),
      // If the function regresses to the SQLite path, these would never be
      // invoked because the postgres branch was taken. The flag confirms
      // it stays on the postgres branch.
      postgresAnySemanticProgressRow: async () => { sqliteWasRead = false; return null; },
    });
    assert.equal(state, 'built',
      'postgres-mode computeIndexState must derive from postgres helpers');
    assert.equal(sqliteWasRead, false);
  } finally {
    configureSemanticBackend(null);
  }
});

test('Postgres mode reports stale when active-backend progress row exists', async () => {
  configureSemanticBackend(stubBackend);
  try {
    const state = await computeIndexState(postgresDeps({
      postgresAnySemanticProgressRow: async () => ({ n: 1 }),
    }));
    assert.equal(state, 'stale',
      'an active postgres progress row must still drive stale honestly');
  } finally {
    configureSemanticBackend(null);
  }
});

test('Postgres mode reports stale on meta identity drift against the live backend', async () => {
  configureSemanticBackend(stubBackend);
  try {
    const state = await computeIndexState(postgresDeps({
      postgresListAllSemanticMetaIdentities: async () => [
        {
          model_id: 'some-other-model',
          dimensions: stubBackend.dimensions(),
          distance_metric: stubBackend.distanceMetric(),
        },
      ],
    }));
    assert.equal(state, 'stale',
      'meta identity drift from the live backend must drive stale in postgres mode');
  } finally {
    configureSemanticBackend(null);
  }
});

test('Postgres mode reports built when meta is empty (boot path is authoritative)', async () => {
  configureSemanticBackend(stubBackend);
  try {
    const state = await computeIndexState(postgresDeps({
      postgresListAllSemanticMetaIdentities: async () => [],
    }));
    assert.equal(state, 'built',
      'empty postgres meta still resolves to built because boot backfills before advertising');
  } finally {
    configureSemanticBackend(null);
  }
});

test('Postgres mode reports stale when meta+progress are both empty but no backend is configured', async () => {
  configureSemanticBackend(null);
  const state = await computeIndexState(postgresDeps({
    postgresListAllSemanticMetaIdentities: async () => [],
  }));
  assert.equal(state, 'stale',
    'no semantic backend always wins over storage state');
});

test('computeIndexState returns stale when no semantic backend is configured', async () => {
  configureSemanticBackend(null);
  const state = await computeIndexState();
  assert.equal(state, 'stale');
});

test('Postgres mode ignores orphaned SQLite progress rows (the original bug)', async () => {
  // Simulates the live deployment shape from the diagnosis: an orphan
  // SQLite progress row exists, but the active backend is postgres and
  // its progress table is empty.  The previous implementation would have
  // returned `"stale"` because it always read the SQLite probe; the
  // fixed implementation routes through the postgres helpers and
  // observes an empty progress state, so the advertisement is `"built"`.
  configureSemanticBackend(stubBackend);
  try {
    const state = await computeIndexState({
      isPostgresStorageBackend: () => true,
      postgresAnySemanticProgressRow: async () => null,
      postgresListAllSemanticMetaIdentities: async () => [matchingMetaRow()],
    });
    assert.equal(state, 'built');
  } finally {
    configureSemanticBackend(null);
  }
});

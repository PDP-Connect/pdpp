import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePostgresStorage,
  getPostgresLexicalBackendState,
  initPostgresStorage,
  postgresLexicalPgSearchRequested,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

test('postgres lexical BM25 backend flag is explicit and disabled by default', () => {
  assert.equal(postgresLexicalPgSearchRequested({ env: {} }), false);
  assert.equal(
    postgresLexicalPgSearchRequested({
      env: { PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND: 'pg_search' },
    }),
    true,
  );
  assert.equal(
    postgresLexicalPgSearchRequested({
      env: { PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND: 'postgres_native_fts' },
    }),
    false,
  );
});

test('lexical backend state reports SQLite FTS when Postgres storage is inactive', async () => {
  await closePostgresStorage();

  assert.deepEqual(getPostgresLexicalBackendState({ env: {} }), {
    active: 'sqlite_fts5',
    configured: false,
    fallback: false,
    pg_search: {
      available: false,
      state: 'not_applicable',
    },
  });

  assert.deepEqual(
    getPostgresLexicalBackendState({
      env: { PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND: 'pg_search' },
    }),
    {
      active: 'sqlite_fts5',
      configured: true,
      fallback: false,
      pg_search: {
        available: false,
        state: 'not_applicable',
      },
    },
  );
});

test('Postgres startup does not require pg_search and keeps native FTS as fallback', {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
  try {
    const disabled = getPostgresLexicalBackendState({ env: {} });
    assert.equal(disabled.configured, false);
    assert.equal(disabled.fallback, false);
    assert.equal(disabled.active, 'postgres_native_fts');
    assert.ok(
      disabled.pg_search.state === 'available_disabled' || disabled.pg_search.state === 'unavailable',
      `unexpected disabled pg_search state: ${JSON.stringify(disabled.pg_search)}`,
    );

    const requested = getPostgresLexicalBackendState({
      env: { PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND: 'pg_search' },
    });
    assert.equal(requested.configured, true);
    if (requested.pg_search.available) {
      assert.equal(requested.active, 'pg_search_bm25');
      assert.equal(requested.fallback, false);
      assert.equal(requested.pg_search.state, 'enabled');
    } else {
      assert.equal(requested.active, 'postgres_native_fts');
      assert.equal(requested.fallback, true);
      assert.equal(requested.pg_search.state, 'fallback_unavailable');
    }
  } finally {
    await closePostgresStorage();
  }
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lexical snapshot pagination: Postgres production-path coverage.
 *
 * Closes a verified seam gap: a prior migration moved lexical snapshot
 * persistence behind getSearchIndexStore() with a SQLite adapter and a
 * Postgres adapter (postgresSearchIndexStore.persistSnapshot /
 * loadSnapshotRow, table lexical_search_snapshots in server/search.js). The
 * meta/index seams of that store are exercised by the existing PG lexical
 * test, but the two SNAPSHOT seams were not: breaking the snapshot SELECT
 * left every existing PG test green.
 *
 * Snapshots are exercised by lexical-search pagination on the real HTTP path.
 * Per operations/rs-search-lexical/index.ts: a fresh /v1/search request always
 * builds and persists a snapshot (page 1); a &cursor= request always loads
 * that persisted snapshot by id (page 2). So a paginated lexical search in
 * Postgres mode drives persistSnapshot (page 1) + loadSnapshot (page 2)
 * through the migrated PG adapter.
 *
 * This mirrors the SQLite pagination round-trip at
 * test/lexical-retrieval.test.js (the "pagination round-trip works" test) and
 * the Postgres harness setup of the PG lexical-recall test in that same file.
 *
 * Gated on PDPP_TEST_POSTGRES_URL so it is a clean skip without a live PG.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { closeDb } from '../server/db.js';
import { closePostgresStorage } from '../server/postgres-storage.js';

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  return tokenBody.access_token;
}

async function ingest(rsUrl, ownerToken, connectorId, stream, records) {
  const ndjson = records.map((r) => JSON.stringify({
    key: r.id,
    data: r,
    emitted_at: r.emitted_at || r.source_created_at,
  })).join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/x-ndjson' },
      body: ndjson,
    },
  );
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

if (!POSTGRES_URL) {
  test('postgres lexical snapshot pagination round-trip (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('postgres lexical snapshot pagination persists on page 1 and loads on page 2', async () => {
    // Unique connector_id + search term per run so the test is isolated even on
    // a re-used database, matching the existing PG lexical test convention.
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_snap_pagination_${suffix}`;
    const term = `pgsnapterm${suffix}`;
    const manifest = {
      protocol_version: '0.1.0',
      connector_id: connectorId,
      version: '1.0.0',
      display_name: 'Postgres Snapshot Pagination',
      capabilities: { human_interaction: ['credentials'] },
      streams: [
        {
          name: 'posts',
          semantics: 'append_only',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              source_created_at: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'title'],
          },
          primary_key: ['id'],
          cursor_field: 'source_created_at',
          consent_time_field: 'source_created_at',
          selection: { fields: true, resources: false },
          query: { search: { lexical_fields: ['title'] } },
        },
      ],
    };

    let server = null;
    try {
      server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath: ':memory:',
        storageBackend: 'postgres',
        databaseUrl: POSTGRES_URL,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        reconcilePolyfillManifests: false,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      const reg = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(reg.status, 201, `register ${connectorId}`);

      const ownerToken = await issueOwnerToken(asUrl, `owner_pg_snap_${suffix}`);

      // Seven matching records with limit=3 forces pagination: page 1 returns 3
      // hits with a non-empty next_cursor (snapshot persisted), and page 2 loads
      // the persisted snapshot to return the next slice.
      const records = Array.from({ length: 7 }, (_, i) => ({
        id: `pgp${i}`,
        title: `${term} page ${i}`,
        source_created_at: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      }));
      await ingest(rsUrl, ownerToken, connectorId, 'posts', records);

      // ── Page 1: fresh request → buildSnapshot + persistSnapshot (PG adapter).
      const page1 = await fetchJson(
        `${rsUrl}/v1/search?q=${encodeURIComponent(term)}&limit=3`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(page1.status, 200);
      assert.equal(page1.body.object, 'list');
      assert.equal(page1.body.data.length, 3, 'page 1 returns the limit');
      assert.equal(page1.body.has_more, true, 'more pages remain after page 1');
      assert.ok(
        typeof page1.body.next_cursor === 'string' && page1.body.next_cursor.length > 0,
        'page 1 emits a next_cursor (snapshot was persisted)',
      );
      const page1Keys = page1.body.data.map((r) => r.record_key);
      assert.equal(new Set(page1Keys).size, 3, 'page 1 keys are distinct');

      // ── Page 2: cursor request → loadSnapshot (PG adapter). If the snapshot
      //    did NOT load, the operation throws invalid_cursor (status 400) and
      //    these assertions fail. So a successful, key-advancing page 2 proves
      //    the persisted snapshot loaded correctly.
      const page2 = await fetchJson(
        `${rsUrl}/v1/search?q=${encodeURIComponent(term)}&limit=3&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
        { headers: { 'Authorization': `Bearer ${ownerToken}` } },
      );
      assert.equal(page2.status, 200, 'page 2 succeeds (snapshot loaded, not invalid_cursor)');
      assert.equal(page2.body.object, 'list');
      assert.equal(page2.body.data.length, 3, 'page 2 returns the next slice');

      // The cursor advanced: page 2 keys must not duplicate page 1 keys.
      const firstKeys = new Set(page1Keys);
      for (const r of page2.body.data) {
        assert.ok(
          !firstKeys.has(r.record_key),
          `cursor should advance: ${r.record_key} duplicated from page 1`,
        );
      }

      // Recall facts are a property of the whole ranked snapshot, so a correctly
      // loaded page-2 snapshot reproduces page 1's recall facts verbatim. This
      // depends on loadSnapshot returning the persisted row, not a rebuild.
      assert.deepEqual(
        page2.body.meta.recall,
        page1.body.meta.recall,
        'page 2 reuses the persisted snapshot recall facts',
      );
    } finally {
      if (server) await closeServer(server);
      await closePostgresStorage();
      closeDb();
    }
  });
}

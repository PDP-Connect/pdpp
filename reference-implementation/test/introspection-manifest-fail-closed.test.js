/**
 * Introspection MUST fail closed on an unexpected manifest-store / storage fault.
 *
 * Regression guard for a fail-open defect: `introspect()`'s client-token branch
 * validated the persisted grant against its manifest inside a try/catch that
 * returned inactive ONLY for a `grant_invalid`-coded error and SILENTLY SWALLOWED
 * every other error, then fell through to mark the token `active: true`. An
 * infrastructure fault (manifest-store outage, DB error) therefore resolved into
 * an authorization "active" decision.
 *
 * The fix: a genuine `grant_invalid` still projects inactive; any other error
 * propagates, so introspection can never convert an outage into `active: true`.
 *
 * Behavior deliberately PRESERVED (not changed by the fix):
 *   - A grant bound to an UNREGISTERED connector (manifest resolves to null) keeps
 *     the token active; the read path resolves the connector connector-first and
 *     returns a precise not_found there. That is asserted by pdpp.test.js
 *     "polyfill client reads fail connector-first ...".
 *
 * SQLite path runs everywhere; Postgres path runs only when PDPP_TEST_POSTGRES_URL
 * is set.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { introspect, registerConnector } from '../server/auth.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = 'introspection_fail_closed';
const SUBJECT_ID = 'introspection_subject';
const CLIENT_ID = 'introspection_client';

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  streams: [{
    name: 'items',
    primary_key: ['id'],
    schema: { type: 'object', properties: { id: { type: 'string' } } },
    selection: { fields: true, resources: true },
  }],
};

function persistedGrant(grantId) {
  return JSON.stringify({
    grant_id: grantId,
    subject_id: SUBJECT_ID,
    client_id: CLIENT_ID,
    manifest_version: MANIFEST.version,
    purpose_code: 'https://pdpp.org/purpose/analytics',
    access_mode: 'continuous',
    source: { kind: 'connector', id: CONNECTOR_ID },
    streams: [{ name: 'items' }],
  });
}

async function seedGrantToken(backend, grantId, tokenId) {
  const storageBinding = JSON.stringify({ connector_id: CONNECTOR_ID });
  const grantJson = persistedGrant(grantId);
  const issuedAt = new Date().toISOString();
  if (backend === 'postgres') {
    await postgresQuery(
      `INSERT INTO grants(
         grant_id, subject_id, client_id, storage_binding_json, grant_json,
         access_mode, issued_at
       ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, 'continuous', $6)`,
      [grantId, SUBJECT_ID, CLIENT_ID, storageBinding, grantJson, issuedAt],
    );
    await postgresQuery(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind)
       VALUES($1, $2, $3, $4, 'client')`,
      [tokenId, grantId, SUBJECT_ID, CLIENT_ID],
    );
    return;
  }
  getDb().prepare(`
    INSERT INTO grants(
      grant_id, subject_id, client_id, storage_binding_json, grant_json,
      access_mode, issued_at
    ) VALUES(?, ?, ?, ?, ?, 'continuous', ?)
  `).run(grantId, SUBJECT_ID, CLIENT_ID, storageBinding, grantJson, issuedAt);
  getDb().prepare(`
    INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind)
    VALUES(?, ?, ?, ?, 'client')
  `).run(tokenId, grantId, SUBJECT_ID, CLIENT_ID);
}

async function breakManifestStorage(backend) {
  // Simulate a manifest-store outage: the table introspection reads is gone.
  if (backend === 'postgres') {
    await postgresQuery('ALTER TABLE connectors RENAME TO connectors_unavailable');
    return;
  }
  getDb().exec('DROP TABLE connectors');
}

async function runFailClosedCases(t, backend) {
  initDb(':memory:');
  if (backend === 'postgres') {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
  }
  try {
    await registerConnector(MANIFEST);
    const grantId = `grant_introspection_${backend}`;
    const tokenId = `token_introspection_${backend}`;
    await seedGrantToken(backend, grantId, tokenId);

    await t.test('a valid grant introspects active before any fault', async () => {
      const result = await introspect(tokenId);
      assert.equal(result.active, true);
    });

    await t.test('an unexpected manifest-storage fault propagates and never marks active', async () => {
      await breakManifestStorage(backend);
      // The security property: introspection MUST NOT resolve an infrastructure
      // outage into `active: true`. It fails closed by propagating.
      await assert.rejects(
        introspect(tokenId),
        (error) => error?.code !== 'grant_invalid',
        'infra fault must propagate, not project the token active or as a clean grant_invalid',
      );
    });
  } finally {
    if (backend === 'postgres') await closePostgresStorage();
    closeDb();
  }
}

test('SQLite introspection fails closed on an unexpected manifest-storage fault', async (t) => {
  await runFailClosedCases(t, 'sqlite');
});

test('Postgres introspection fails closed on an unexpected manifest-storage fault', {
  skip: !POSTGRES_URL,
}, async (t) => {
  await runFailClosedCases(t, 'postgres');
});

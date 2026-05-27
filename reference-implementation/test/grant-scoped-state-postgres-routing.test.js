/**
 * Regression test for grant-scoped state grant resolution under
 * `PDPP_STORAGE_BACKEND=postgres`.
 *
 * Pins the routing invariant: `resolveGrantScopedStateGrant` MUST consult
 * the active storage backend. Before the fix it always read SQLite, so
 * any postgres-issued grant resolved as `not_found` even though the row
 * lived in postgres `grants`.
 *
 * The test seeds a row directly into postgres `grants` (no SQLite row),
 * then calls `resolveGrantScopedStateGrant`. With the fix, the function
 * locates the row; downstream resolution still throws (the seeded grant
 * does not reference a registered manifest), but the failure mode is
 * `grant_invalid` rather than `not_found`. That distinction is the
 * routing assertion: `not_found` would mean the postgres read never
 * happened.
 *
 * Env gate: PDPP_TEST_POSTGRES_URL must be set (Compose Postgres proof
 * service). Uses a uniquely-named grant_id per run so concurrent runs do
 * not collide on the shared schema.
 *
 * Spec: openspec/changes/fix-grant-scoped-state-postgres-routing/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';
import { resolveGrantScopedStateGrant } from '../server/index.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('grant-scoped state postgres routing (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('resolveGrantScopedStateGrant reads from postgres when backend is postgres', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_grant_scope_${suffix}`;
    const grantId = `grant_pg_${suffix}`;
    const clientId = `client_pg_${suffix}`;
    const subjectId = `subject_pg_${suffix}`;
    const issuedAt = new Date().toISOString();

    // SQLite stays empty for the grants table — the legacy code path
    // would always look here and miss the postgres row.
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const grantJson = {
        grant_id: grantId,
        client_id: clientId,
        subject_id: subjectId,
        access_mode: 'continuous',
        streams: [{ name: 'items' }],
        retention: { mode: 'none' },
        source: { kind: 'connector', connector_id: connectorId },
      };
      const storageBindingJson = {
        connector_id: connectorId,
        connector_instance_id: `cin_${suffix}`,
      };

      await postgresQuery(
        `INSERT INTO grants(
           grant_id, subject_id, client_id, storage_binding_json, grant_json,
           access_mode, issued_at, trace_id, scenario_id
         ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
        [
          grantId,
          subjectId,
          clientId,
          JSON.stringify(storageBindingJson),
          JSON.stringify(grantJson),
          'continuous',
          issuedAt,
          null,
          null,
        ],
      );

      // With the fix: the postgres row is reached. Downstream resolution
      // (`requireResolvedPersistedGrantState`) still throws because the
      // synthetic connector has no registered manifest — but the error
      // code is `grant_invalid`, not `not_found`. The legacy SQLite-only
      // reader would throw `not_found` here because SQLite has no row.
      let err = null;
      try {
        await resolveGrantScopedStateGrant(connectorId, grantId);
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'expected resolution to throw');
      assert.notEqual(
        err.code,
        'not_found',
        'grant must be located in postgres — `not_found` would mean the SQLite-only reader is still in use',
      );
      assert.equal(
        err.code,
        'grant_invalid',
        'unresolved manifest must surface as `grant_invalid` once the row is located',
      );

      // Negative control: a grant id that exists in neither backend
      // must still surface as `not_found`. This pins that postgres mode
      // did not accidentally invent grants.
      let missingErr = null;
      try {
        await resolveGrantScopedStateGrant(connectorId, `${grantId}_missing`);
      } catch (e) {
        missingErr = e;
      }
      assert.equal(missingErr?.code, 'not_found');
    } finally {
      try {
        await postgresQuery(`DELETE FROM grants WHERE grant_id = $1`, [grantId]);
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
}

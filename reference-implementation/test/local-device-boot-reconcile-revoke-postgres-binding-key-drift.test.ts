// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Disposable-Postgres fail-before/pass-after oracle for the identity-lookup
// gap in migratePostgresLocalDeviceConnectorInstances (server/postgres-storage.ts)
// and its SQLite sibling migrateLocalDeviceConnectorRow (server/db.ts).
//
// Both migrations resolve the UPSERT's actual conflict target as:
//   connectorInstanceId = row.connector_instance_id || existingBindingInstanceId || ...
// (row.connector_instance_id, from device_source_instances, wins when set).
//
// But the existing-lifecycle-to-preserve lookup (added by commit 8264cb5d6) is
// keyed by a FRESHLY-DERIVED binding key:
//   SELECT ... FROM connector_instances WHERE ... AND source_binding_key = $freshlyDerivedKey
//
// These two identities can diverge: a connector_instances row's OWN stored
// source_binding_key can predate a binding-key derivation change (the
// D8 fix-enroll-connector-instance-pk-collision comment in
// connector-instance-store.ts documents exactly this class of drift: a
// pre-narrowing deployment computed source_binding_key from the FULL
// sourceBinding object, not the stable {kind, local_binding_name} shape).
// When that happens, the binding-key lookup MISSES even though the row the
// UPSERT will conflict against (by connector_instance_id) already exists and
// already carries an authoritative revoked/paused lifecycle -- so the old
// code silently re-derived status from device_source_instances (which
// owner-revoke never touches) and resurrected the connection.
//
// The fix: re-check directly by the actual UPSERT conflict target
// (connector_instance_id) as a second, independent source of truth whenever
// the binding-key lookup misses -- a binding-key miss must never alone mean
// "no existing row to preserve".

import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

async function connectorInstanceRow(
  connectorInstanceId: string
): Promise<{ revoked_at: string | null; status: string }> {
  const result = await postgresQuery<{ revoked_at: string | null; status: string }>(
    "SELECT status, revoked_at FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  assert.ok(result.rows[0], "connector_instances row must exist");
  return result.rows[0];
}

test("a revoked connector_instance whose OWN source_binding_key predates the current derivation stays revoked across a Postgres restart", {
  skip: !POSTGRES_URL && "set PDPP_TEST_POSTGRES_URL to run",
}, async () => {
  if (!POSTGRES_URL) {
    throw new Error(
      "this test body must not run when PDPP_TEST_POSTGRES_URL is unset (test.skip should have prevented it)"
    );
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    await postgresQuery("DELETE FROM device_source_instances WHERE connector_id = 'bkdrift'");
    await postgresQuery("DELETE FROM device_exporters WHERE device_id = 'dexp_bkdrift'");
    await postgresQuery("DELETE FROM connector_instances WHERE connector_id = 'bkdrift'");
    await postgresQuery(
      "INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('bkdrift', '{}', '2026-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING"
    );

    // The row's OWN stored source_binding_key is deliberately a LEGACY
    // derivation -- NOT what makeConnectorInstanceSourceBindingKey({kind,
    // local_binding_name}) computes today -- so the freshly-derived
    // binding-key lookup in resolveLocalDeviceMigrationIdentity MISSES this
    // row, exactly like the D8 comment's documented legacy-key class.
    const connectorInstanceId = "cin_bkdrift_legacy_row_0000000";
    await postgresQuery(
      `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES ($1, 'owner_bkdrift', 'bkdrift', 'bkdrift device', 'revoked', 'local_device', 'legacy-binding-key-that-does-not-match-current-derivation', '{"kind":"local_device","legacy_shape":true}'::jsonb, '2026-01-01T00:00:00.000Z', '2026-08-03T16:15:16.000Z', '2026-08-03T16:15:16.000Z')`,
      [connectorInstanceId]
    );
    await postgresQuery(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at)
         VALUES ('dexp_bkdrift', 'owner_bkdrift', 'bkdrift device', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
    // device_source_instances.connector_instance_id is set (a completed
    // enrollment) -- so migratePostgresLocalDeviceConnectorInstances uses
    // THIS id directly as the UPSERT conflict target, bypassing the
    // binding-key lookup for the WRITE path. Only the lifecycle-to-preserve
    // lookup goes through the (drifted, missing) binding key.
    await postgresQuery(
      `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, local_binding_id, display_name, status, created_at, updated_at, revoked_at, connector_instance_id, source_kind)
         VALUES ('dsrc_bkdrift', 'dexp_bkdrift', 'bkdrift', 'bkdrift-binding', 'bkdrift device', 'active', '2026-01-01T00:00:00.000Z', '2026-08-03T16:15:16.000Z', NULL, $1, 'local_device')`,
      [connectorInstanceId]
    );

    const before = await connectorInstanceRow(connectorInstanceId);
    assert.equal(before.status, "revoked");
    assert.ok(before.revoked_at);

    // Simulate the reference restart: re-run bootstrap (incl.
    // migratePostgresLocalDeviceConnectorInstances) against the SAME
    // database, exactly as pdpp-reference does on every container boot.
    await bootstrapPostgresSchema({});

    const after = await connectorInstanceRow(connectorInstanceId);
    assert.equal(
      after.status,
      "revoked",
      "a binding-key derivation drift must not cause the boot-time backfill to resurrect an owner-revoked connector_instance"
    );
    assert.ok(
      after.revoked_at,
      "a binding-key derivation drift must not cause the boot-time backfill to clear revoked_at"
    );

    await postgresQuery("DELETE FROM device_source_instances WHERE connector_id = 'bkdrift'");
    await postgresQuery("DELETE FROM device_exporters WHERE device_id = 'dexp_bkdrift'");
    await postgresQuery("DELETE FROM connector_instances WHERE connector_id = 'bkdrift'");
    await postgresQuery("DELETE FROM connectors WHERE connector_id = 'bkdrift'");
  } finally {
    await closePostgresStorage();
  }
});

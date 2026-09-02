// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const TEST_POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const OWNER_SUBJECT_ID = "owner_credential_revoke_test";
const CAPTURED_AT = "2026-08-27T00:00:00.000Z";
const FIRST_REVOKED_AT = "2026-08-27T01:00:00.000Z";
const SECOND_REVOKED_AT = "2026-08-27T02:00:00.000Z";
const INJECTED_CREDENTIAL_REVOKE_FAILURE = /injected credential revoke failure/;

type ConnectorInstanceStore = ReturnType<typeof createPostgresConnectorInstanceStore>;

async function withPostgresStore(callback: (store: ConnectorInstanceStore) => Promise<void>): Promise<void> {
  assert.ok(TEST_POSTGRES_URL, "PDPP_TEST_POSTGRES_URL is required for this test");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: TEST_POSTGRES_URL,
      databaseName: `pdpp_credential_revoke_${randomUUID().replaceAll("-", "")}`,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await callback(createPostgresConnectorInstanceStore());
    }
  );
}

async function seedConnection(
  store: ConnectorInstanceStore,
  connectorInstanceId: string,
  connectorId = "heb"
): Promise<void> {
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES($1, $2::jsonb, $3)
     ON CONFLICT(connector_id) DO NOTHING`,
    [connectorId, JSON.stringify({ connector_id: connectorId }), CAPTURED_AT]
  );
  const written = await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: CAPTURED_AT,
    displayName: connectorInstanceId,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { kind: "account" },
    sourceBindingKey: `binding-${connectorInstanceId}`,
    sourceKind: "account",
    status: "active",
    updatedAt: CAPTURED_AT,
  });
  assert.ok(written, "connection fixture must be created");
  await postgresQuery(
    `INSERT INTO connector_instance_credentials(
       connector_instance_id, owner_subject_id, credential_kind, sealed_secret, fingerprint,
       status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason
     ) VALUES($1, $2, 'api_key', md5($1), NULL, 'active', $3, NULL, NULL, NULL, NULL)`,
    [connectorInstanceId, OWNER_SUBJECT_ID, CAPTURED_AT]
  );
}

async function credentialState(connectorInstanceId: string): Promise<{ revoked_at: string | null; status: string }> {
  const result = await postgresQuery<{ revoked_at: string | null; status: string }>(
    `SELECT status, revoked_at
       FROM connector_instance_credentials
      WHERE connector_instance_id = $1`,
    [connectorInstanceId]
  );
  const [row] = result.rows;
  assert.ok(row, "credential fixture must exist");
  return row;
}

async function connectionState(connectorInstanceId: string): Promise<{ revoked_at: string | null; status: string }> {
  const result = await postgresQuery<{ revoked_at: string | null; status: string }>(
    `SELECT status, revoked_at
       FROM connector_instances
      WHERE connector_instance_id = $1`,
    [connectorInstanceId]
  );
  const [row] = result.rows;
  assert.ok(row, "connection fixture must exist");
  return row;
}

// Real Postgres regression oracle: the connection lifecycle write must revoke
// the bound credential in its own transaction, rather than leaving a usable
// sealed value attached to a revoked connection.
test("Postgres connection revoke revokes its bound credential and stamps the timestamp", {
  skip: !TEST_POSTGRES_URL,
}, async () => {
  await withPostgresStore(async (store) => {
    const connectionId = "credential-revoke-target";
    await seedConnection(store, connectionId);

    await store.updateStatus(connectionId, {
      revokedAt: FIRST_REVOKED_AT,
      status: "revoked",
      updatedAt: FIRST_REVOKED_AT,
    });

    assert.deepEqual(await credentialState(connectionId), {
      revoked_at: FIRST_REVOKED_AT,
      status: "revoked",
    });
  });
});

// Scope oracle: two accounts can share a connector type. Revoking one must
// never revoke the sibling account's credential.
test("Postgres connection revoke leaves a same-connector sibling credential active", {
  skip: !TEST_POSTGRES_URL,
}, async () => {
  await withPostgresStore(async (store) => {
    const targetConnectionId = "credential-revoke-target";
    const siblingConnectionId = "credential-revoke-sibling";
    await seedConnection(store, targetConnectionId, "heb");
    await seedConnection(store, siblingConnectionId, "heb");

    await store.updateStatus(targetConnectionId, {
      revokedAt: FIRST_REVOKED_AT,
      status: "revoked",
      updatedAt: FIRST_REVOKED_AT,
    });

    assert.deepEqual(await credentialState(targetConnectionId), {
      revoked_at: FIRST_REVOKED_AT,
      status: "revoked",
    });
    assert.deepEqual(await credentialState(siblingConnectionId), {
      revoked_at: null,
      status: "active",
    });
  });
});

// Idempotency oracle: a retry must preserve the original point-in-time fact
// for both rows; a later caller timestamp cannot rewrite revocation history.
test("Postgres connection re-revoke preserves the original connection and credential timestamps", {
  skip: !TEST_POSTGRES_URL,
}, async () => {
  await withPostgresStore(async (store) => {
    const connectionId = "credential-revoke-target";
    await seedConnection(store, connectionId);

    await store.updateStatus(connectionId, {
      revokedAt: FIRST_REVOKED_AT,
      status: "revoked",
      updatedAt: FIRST_REVOKED_AT,
    });
    await store.updateStatus(connectionId, {
      revokedAt: SECOND_REVOKED_AT,
      status: "revoked",
      updatedAt: SECOND_REVOKED_AT,
    });

    assert.deepEqual(await connectionState(connectionId), {
      revoked_at: FIRST_REVOKED_AT,
      status: "revoked",
    });
    assert.deepEqual(await credentialState(connectionId), {
      revoked_at: FIRST_REVOKED_AT,
      status: "revoked",
    });
  });
});

// Transaction oracle: a credential-write failure must roll back the connection
// status write, proving the secret cannot remain active behind a revoked UI.
test("Postgres connection revoke rolls back when credential revocation fails", {
  skip: !TEST_POSTGRES_URL,
}, async () => {
  await withPostgresStore(async (store) => {
    const connectionId = "credential-revoke-target";
    await seedConnection(store, connectionId);
    await postgresQuery(
      `CREATE FUNCTION fail_credential_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'injected credential revoke failure';
         END;
       $$;
       CREATE TRIGGER fail_credential_revoke_before_update
       BEFORE UPDATE ON connector_instance_credentials
       FOR EACH ROW EXECUTE FUNCTION fail_credential_revoke();`
    );

    await assert.rejects(
      store.updateStatus(connectionId, {
        revokedAt: FIRST_REVOKED_AT,
        status: "revoked",
        updatedAt: FIRST_REVOKED_AT,
      }),
      INJECTED_CREDENTIAL_REVOKE_FAILURE
    );
    assert.deepEqual(await connectionState(connectionId), { revoked_at: null, status: "active" });
    assert.deepEqual(await credentialState(connectionId), { revoked_at: null, status: "active" });
  });
});

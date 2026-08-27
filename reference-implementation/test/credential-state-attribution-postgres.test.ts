// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { runConnectorMaintenanceSweep } from "../server/connector-maintenance-sweep.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CAPTURED_AT = "2026-08-27T07:50:00.000Z";
const REVOKED_AT = "2026-08-27T07:56:55.000Z";
const OWNER_SUBJECT_ID = "owner_credential_attribution";

type ConnectionStore = ReturnType<typeof createPostgresConnectorInstanceStore>;
type CredentialStore = ReturnType<typeof createPostgresConnectorInstanceCredentialStore>;

async function withPostgresStores(
  callback: (stores: { connectionStore: ConnectionStore; credentialStore: CredentialStore }) => Promise<void>
): Promise<void> {
  assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL is required for this test");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_credential_attribution_${randomUUID().replaceAll("-", "")}`,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        await callback({
          connectionStore: createPostgresConnectorInstanceStore(),
          credentialStore: createPostgresConnectorInstanceCredentialStore({
            env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: "test-only-credential-attribution-key" },
          }),
        });
      } finally {
        await closePostgresStorage();
      }
    }
  );
}

async function seedConnection(
  connectionStore: ConnectionStore,
  credentialStore: CredentialStore,
  connectionId: string,
  sourceBinding: Record<string, unknown> = { kind: "account" }
): Promise<void> {
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES('github', '{"connector_id":"github"}'::jsonb, $1)`,
    [CAPTURED_AT]
  );
  await connectionStore.upsert({
    connectorId: "github",
    connectorInstanceId: connectionId,
    createdAt: CAPTURED_AT,
    displayName: connectionId,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding,
    sourceBindingKey: `binding-${connectionId}`,
    sourceKind: "account",
    status: "active",
    updatedAt: CAPTURED_AT,
  });
  await credentialStore.capture({
    connectorInstanceId: connectionId,
    credentialKind: "personal_access_token",
    now: CAPTURED_AT,
    ownerSubjectId: OWNER_SUBJECT_ID,
    secret: "synthetic-test-input-not-a-production-credential",
  });
}

async function credentialAuditState(connectionId: string): Promise<{
  state_change_json: Record<string, unknown>;
  status: string;
}> {
  const result = await postgresQuery<{ state_change_json: Record<string, unknown>; status: string }>(
    `SELECT status, state_change_json
       FROM connector_instance_credentials
      WHERE connector_instance_id = $1`,
    [connectionId]
  );
  const [row] = result.rows;
  assert.ok(row, "credential fixture must exist");
  return row;
}

test("Postgres connection credential cascade records the revoking actor, cause, and trace", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgresStores(async ({ connectionStore, credentialStore }) => {
    const connectionId = "cin_attributed_owner_revoke";
    await seedConnection(connectionStore, credentialStore, connectionId);

    await connectionStore.updateStatus(connectionId, {
      credentialStateChange: {
        actorId: "owner_credential_attribution",
        actorType: "owner_session",
        cause: "owner_revoked",
        requestId: "req_credential_attribution",
        traceId: "trace_credential_attribution",
      },
      revokedAt: REVOKED_AT,
      sourceBindingPatch: { revocation_reason: "owner_revoked" },
      status: "revoked",
      updatedAt: REVOKED_AT,
    });

    assert.deepEqual(await credentialAuditState(connectionId), {
      state_change_json: {
        actorId: "owner_credential_attribution",
        actorType: "owner_session",
        cause: "owner_revoked",
        requestId: "req_credential_attribution",
        traceId: "trace_credential_attribution",
      },
      status: "revoked",
    });
    assert.equal((await connectionStore.get(connectionId))?.sourceBinding?.revocation_reason, "owner_revoked");
  });
});

test("Postgres TTL retirement records system cause and reports the retired connection ids", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgresStores(async ({ connectionStore, credentialStore }) => {
    const connectionId = "cin_attributed_ttl_retirement";
    await seedConnection(connectionStore, credentialStore, connectionId, {
      enrollment_expires_at: "2026-08-27T07:56:54.999Z",
      kind: "browser_enrollment_shell",
    });
    const logged: Array<{ cause: "ttl_expired"; connectionIds: readonly string[] }> = [];
    await runConnectorMaintenanceSweep({
      nowIso: () => REVOKED_AT,
      onShellsRetired: (info) => logged.push(info),
      runEvidenceSweep: async () => ({ incomplete: false, resumeAfterId: null }),
    });

    assert.deepEqual(logged, [{ cause: "ttl_expired", connectionIds: [connectionId] }]);
    assert.deepEqual(await credentialAuditState(connectionId), {
      state_change_json: {
        actorId: "browser_enrollment_shell_retirement",
        actorType: "system",
        cause: "ttl_expired",
      },
      status: "revoked",
    });
    assert.equal((await connectionStore.get(connectionId))?.sourceBinding?.revocation_reason, "ttl_expired");
  });
});

test("Postgres connection credential cascade leaves an unknown actor absent", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgresStores(async ({ connectionStore, credentialStore }) => {
    const connectionId = "cin_attribution_actor_unknown";
    await seedConnection(connectionStore, credentialStore, connectionId);

    await connectionStore.updateStatus(connectionId, {
      revokedAt: REVOKED_AT,
      status: "revoked",
      updatedAt: REVOKED_AT,
    });

    assert.deepEqual(await credentialAuditState(connectionId), {
      state_change_json: { cause: "connection_revoked" },
      status: "revoked",
    });
    assert.equal(
      (await connectionStore.get(connectionId))?.sourceBinding?.revocation_reason,
      "connection_revoked",
      "a context-free revoke records its true generic cause without inventing an actor"
    );
  });
});

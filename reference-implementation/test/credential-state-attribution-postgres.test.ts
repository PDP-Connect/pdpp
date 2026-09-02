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

/**
 * Seed the connection row only. Callers that need a stored credential add one
 * with `seedCredential`; the TTL sweep cases depend on the difference, because
 * a shell that holds a credential is deliberately spared (see
 * `browser-enrollment-shell-retirement.ts` and PR #199).
 */
async function seedConnectionRow(
  connectionStore: ConnectionStore,
  connectionId: string,
  sourceBinding: Record<string, unknown> = { kind: "account" }
): Promise<void> {
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
}

async function seedCredential(credentialStore: CredentialStore, connectionId: string): Promise<void> {
  await credentialStore.capture({
    connectorInstanceId: connectionId,
    credentialKind: "personal_access_token",
    now: CAPTURED_AT,
    ownerSubjectId: OWNER_SUBJECT_ID,
    secret: "synthetic-test-input-not-a-production-credential",
  });
}

async function seedConnector(): Promise<void> {
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES('github', '{"connector_id":"github"}'::jsonb, $1)
     ON CONFLICT (connector_id) DO NOTHING`,
    [CAPTURED_AT]
  );
}

async function seedConnection(
  connectionStore: ConnectionStore,
  credentialStore: CredentialStore,
  connectionId: string,
  sourceBinding: Record<string, unknown> = { kind: "account" }
): Promise<void> {
  await seedConnector();
  await seedConnectionRow(connectionStore, connectionId, sourceBinding);
  await seedCredential(credentialStore, connectionId);
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
    const bindingOwnerRevoked = (await connectionStore.get(connectionId))?.sourceBinding as
      | { revocation_reason?: string }
      | undefined;
    assert.equal(bindingOwnerRevoked?.revocation_reason, "owner_revoked");
  });
});

test("Postgres TTL retirement records system cause and reports the retired connection ids", {
  skip: !POSTGRES_URL,
}, async () => {
  await withPostgresStores(async ({ connectionStore, credentialStore }) => {
    // An abandoned shell — expired and holding NO credential — is the only
    // shape the sweep is still permitted to retire. A shell that holds the
    // owner's credential is spared no matter how long it has sat (PR #199:
    // seven venmo shells were revoked at their 2h TTL with his real password
    // captured), so `spared` below must survive this sweep untouched.
    const connectionId = "cin_attributed_ttl_retirement";
    const sparedConnectionId = "cin_attributed_ttl_credentialed";
    const shellBinding = {
      enrollment_expires_at: "2026-08-27T07:56:54.999Z",
      kind: "browser_enrollment_shell",
    };
    await seedConnector();
    await seedConnectionRow(connectionStore, connectionId, shellBinding);
    await seedConnectionRow(connectionStore, sparedConnectionId, shellBinding);
    await seedCredential(credentialStore, sparedConnectionId);

    const logged: Array<{ cause: "ttl_expired"; connectionIds: readonly string[] }> = [];
    await runConnectorMaintenanceSweep({
      nowIso: () => REVOKED_AT,
      onShellsRetired: (info) => logged.push(info),
      runEvidenceSweep: async () => ({ incomplete: false, resumeAfterId: null }),
    });

    assert.deepEqual(logged, [{ cause: "ttl_expired", connectionIds: [connectionId] }]);
    const bindingTtlExpired = (await connectionStore.get(connectionId))?.sourceBinding as
      | { revocation_reason?: string }
      | undefined;
    assert.equal(bindingTtlExpired?.revocation_reason, "ttl_expired");

    assert.equal(
      (await connectionStore.get(sparedConnectionId))?.status,
      "active",
      "a shell holding the owner's credential must survive its own TTL"
    );
    assert.deepEqual(await credentialAuditState(sparedConnectionId), {
      state_change_json: { cause: "credential_captured" },
      status: "active",
    });
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
    const bindingConnectionRevoked = (await connectionStore.get(connectionId))?.sourceBinding as
      | { revocation_reason?: string }
      | undefined;
    assert.equal(
      bindingConnectionRevoked?.revocation_reason,
      "connection_revoked",
      "a context-free revoke records its true generic cause without inventing an actor"
    );
  });
});

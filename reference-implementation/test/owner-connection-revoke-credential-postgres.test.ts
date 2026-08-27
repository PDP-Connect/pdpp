// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Characterization oracle for the owner-facing connection-revoke surface.
 *
 * The route delegates to `ConnectorInstanceStore.updateStatus(... revoked)`.
 * This real-Postgres test pins the ruled lifecycle contract at that storage
 * boundary: revoking a connection also revokes its separately stored
 * credential. A unit mock cannot prove this persistence boundary or
 * distinguish an active credential from a revoked one, so the disposable
 * Postgres database is required.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import {
  admitOwnerRunConnection,
  createPostgresConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = "github";
const CONNECTION_ID = "cin_revoke_credential_characterization";
const OWNER_SUBJECT_ID = "owner_revoke_credential_characterization";
const CAPTURED_AT = "2026-08-27T12:00:00.000Z";
const REVOKED_AT = "2026-08-27T12:05:00.000Z";

let databaseCounter = 0;

function databaseName(): string {
  databaseCounter += 1;
  return `pdpp_test_revoke_credential_${process.pid}_${Date.now()}_${databaseCounter}`;
}

test("revoking a connection also revokes its stored credential", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: databaseName(),
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
          CONNECTOR_ID,
          JSON.stringify({ connector_id: CONNECTOR_ID, streams: [] }),
          CAPTURED_AT,
        ]);
        const connectionStore = createPostgresConnectorInstanceStore();
        await connectionStore.upsert({
          connectorId: CONNECTOR_ID,
          connectorInstanceId: CONNECTION_ID,
          createdAt: CAPTURED_AT,
          displayName: "Revoke credential characterization",
          ownerSubjectId: OWNER_SUBJECT_ID,
          sourceBinding: { account: "characterization" },
          sourceBindingKey: "characterization",
          sourceKind: "account",
          status: "active",
          updatedAt: CAPTURED_AT,
        });
        const credentialStore = createPostgresConnectorInstanceCredentialStore({
          env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: "test-only-revoke-credential-key" },
        });
        await credentialStore.capture({
          connectorInstanceId: CONNECTION_ID,
          credentialKind: "personal_access_token",
          now: CAPTURED_AT,
          ownerSubjectId: OWNER_SUBJECT_ID,
          // Synthetic test input only. The test never reads, logs, or asserts
          // a credential value or its sealed representation.
          secret: "synthetic-test-input-not-a-production-credential",
        });

        // This is the exact production primitive invoked by
        // owner-connection-revoke.ts after its owner/active namespace check.
        await connectionStore.updateStatus(CONNECTION_ID, {
          revokedAt: REVOKED_AT,
          status: "revoked",
          updatedAt: REVOKED_AT,
        });

        const credential = await credentialStore.getMetadata(CONNECTION_ID);
        assert.ok(credential, "the credential row survives connection revoke as revoked metadata");
        assert.equal(credential.status, "revoked");
        assert.equal(credential.revokedAt, REVOKED_AT);
        assert.equal(await credentialStore.hasActiveCredential(CONNECTION_ID), false);
        await assert.rejects(
          () => credentialStore.recoverSecret({ connectorInstanceId: CONNECTION_ID, ownerSubjectId: OWNER_SUBJECT_ID }),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, "credential_revoked");
            return true;
          }
        );

        // Normal run creation continues to refuse the revoked connection
        // before credential resolution.
        await assert.rejects(
          () =>
            admitOwnerRunConnection({
              connectorId: CONNECTOR_ID,
              connectorInstanceId: CONNECTION_ID,
              connectorInstanceStore: connectionStore,
              ownerSubjectId: OWNER_SUBJECT_ID,
            }),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, "connector_instance_inactive");
            return true;
          }
        );
      } finally {
        await closePostgresStorage();
      }
    }
  );
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres driver counterpart of `sources-visible-identity-page.test.ts`'s
 * never-succeeded-setup-shell escape. The SQLite and Postgres templates are
 * separate literal strings (`NEVER_SUCCEEDED_SETUP_SHELL_ESCAPE_SQLITE`/
 * `..._POSTGRES` in `connector-instance-store.ts`) and can drift from each
 * other independently of any SQLite-only test suite.
 *
 * Env-gated on `PDPP_TEST_POSTGRES_URL`; registers a single skipped test when
 * unset, mirroring `aggregation-rows-conformance-postgres.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const NOW = "2026-06-10T18:00:00.000Z";
const OWNER = "owner_pg_venmo_shell";

async function seedConnector(connectorId: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES($1, $2::jsonb, $3)
     ON CONFLICT(connector_id) DO NOTHING`,
    [connectorId, JSON.stringify({ connector_id: connectorId }), NOW]
  );
}

async function insertRun(connectorInstanceId: string, connectorId: string, status: string, startedAt: string) {
  await postgresQuery(
    `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, started_at, attempt)
     VALUES($1, $2, $3, '{}'::jsonb, $4, $5, 1)`,
    [`run_${connectorInstanceId}_${startedAt}`, connectorInstanceId, connectorId, status, startedAt]
  );
}

async function cleanup(ownerSubjectId: string, connectorIds: readonly string[]) {
  await postgresQuery(
    `DELETE FROM run_history WHERE connector_instance_id IN (
       SELECT connector_instance_id FROM connector_instances WHERE owner_subject_id = $1
     )`,
    [ownerSubjectId]
  );
  await postgresQuery("DELETE FROM connector_instances WHERE owner_subject_id = $1", [ownerSubjectId]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = ANY($1::text[])", [connectorIds]);
}

if (POSTGRES_URL) {
  test("Postgres listSourcesVisibleIdentityPage returns a never-succeeded revoked browser-enrollment shell", async () => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanup(OWNER, ["venmo_pg_test"]);
      await seedConnector("venmo_pg_test");
      const store = createPostgresConnectorInstanceStore();

      await store.upsert({
        connectorId: "venmo_pg_test",
        connectorInstanceId: "cin_pg_venmo_shell",
        createdAt: NOW,
        displayName: "Venmo",
        ownerSubjectId: OWNER,
        revokedAt: NOW,
        sourceBinding: { kind: "browser_enrollment_shell" },
        sourceBindingKey: "browser_shell_venmo_pg",
        sourceKind: "browser_collector",
        status: "revoked",
        updatedAt: NOW,
      });
      await insertRun("cin_pg_venmo_shell", "venmo_pg_test", "failed", "2026-06-10T17:00:00.000Z");

      const page = await store.listSourcesVisibleIdentityPage(OWNER, { limit: 100 });
      assert.deepEqual(
        page.rows.map((row) => row.connectorInstanceId),
        ["cin_pg_venmo_shell"],
        "a never-succeeded revoked setup shell must surface on the Postgres Sources page"
      );

      const explorePage = await store.listOwnerVisibleIdentityPage(OWNER, { limit: 100 });
      assert.deepEqual(
        explorePage.rows,
        [],
        "the shared owner-visible predicate is unchanged on Postgres — the escape is Sources-only"
      );
    } finally {
      await cleanup(OWNER, ["venmo_pg_test"]);
      await closePostgresStorage();
    }
  });

  test("Postgres listSourcesVisibleIdentityPage still excludes a revoked browser-enrollment shell that succeeded", async () => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanup(OWNER, ["amazon_pg_test"]);
      await seedConnector("amazon_pg_test");
      const store = createPostgresConnectorInstanceStore();

      await store.upsert({
        connectorId: "amazon_pg_test",
        connectorInstanceId: "cin_pg_amazon_shell",
        createdAt: NOW,
        displayName: "Amazon",
        ownerSubjectId: OWNER,
        revokedAt: NOW,
        sourceBinding: { kind: "browser_enrollment_shell" },
        sourceBindingKey: "browser_shell_amazon_pg",
        sourceKind: "browser_collector",
        status: "revoked",
        updatedAt: NOW,
      });
      await store.upsert({
        connectorId: "amazon_pg_test",
        connectorInstanceId: "cin_pg_amazon_promoted",
        createdAt: NOW,
        displayName: "Amazon",
        ownerSubjectId: OWNER,
        sourceBindingKey: "default",
        sourceKind: "account",
        status: "active",
        updatedAt: NOW,
      });
      await insertRun("cin_pg_amazon_shell", "amazon_pg_test", "failed", "2026-06-10T17:00:00.000Z");
      await insertRun("cin_pg_amazon_shell", "amazon_pg_test", "succeeded", "2026-06-10T17:30:00.000Z");

      const page = await store.listSourcesVisibleIdentityPage(OWNER, { limit: 100 });
      assert.deepEqual(
        page.rows.map((row) => row.connectorInstanceId),
        ["cin_pg_amazon_promoted"],
        "a shell with a successful run stays excluded on Postgres too"
      );
    } finally {
      await cleanup(OWNER, ["amazon_pg_test"]);
      await closePostgresStorage();
    }
  });
} else {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  test("Postgres never-succeeded-setup-shell escape (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {});
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-PostgreSQL parity proof for `ProviderAppConfigStore`. The SQLite
 * backend is exercised in `provider-app-config-store.test.ts`; this file
 * proves the same get/set/delete/listConfiguredKeys and resolver behavior
 * against the real Postgres path (`createPostgresProviderAppConfigStore`),
 * including the `INSERT ... ON CONFLICT(identity_group, logical_key)`
 * upsert dialect that the SQLite-host tests do not exercise.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";
import {
  __setProviderAppConfigSetManyFaultHookForTest,
  createDeploymentConfigResolver,
  createPostgresProviderAppConfigStore,
} from "../server/stores/provider-app-config-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const INJECTED_MID_BATCH_FAULT_RE = /injected mid-batch fault/;

const NOW = "2026-08-09T12:00:00.000Z";
const LATER = "2026-08-09T12:05:00.000Z";
const TEST_KEY = "test-operator-key-do-not-use-in-prod";
const CLIENT_SECRET_VALUE = "gocspx-super-secret-client-value";
const GROUP = "shared-google-oauth-app-pg";
const OTHER_GROUP = "shared-microsoft-oauth-app-pg";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset";

function postgresStorageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

function envWithKey(key = TEST_KEY) {
  return { [CREDENTIAL_ENCRYPTION_KEY_ENV]: key };
}

async function cleanup() {
  await postgresQuery("DELETE FROM provider_app_config WHERE identity_group = $1 OR identity_group = $2", [
    GROUP,
    OTHER_GROUP,
  ]);
}

test("real PostgreSQL: set seals at rest, keyed by (identity_group, logical_key); get round-trips", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.set({ identityGroup: GROUP, logicalKey: "client_secret", updatedAt: NOW, value: CLIENT_SECRET_VALUE });

    const { rows } = await postgresQuery<{ sealed_value: string }>(
      "SELECT sealed_value FROM provider_app_config WHERE identity_group = $1 AND logical_key = $2",
      [GROUP, "client_secret"]
    );
    const [row] = rows;
    assert.ok(row, "row exists after set");
    assert.ok(row.sealed_value.startsWith("v1:"), "value is sealed, not plaintext");
    assert.ok(!row.sealed_value.includes(CLIENT_SECRET_VALUE), "at-rest column must not contain plaintext");

    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_secret" }), CLIENT_SECRET_VALUE);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: get returns null for an absent pair", { skip: POSTGRES_SKIP }, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_id" }), null);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: two identity groups holding the same logical_key do not collide", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.set({ identityGroup: GROUP, logicalKey: "client_id", updatedAt: NOW, value: "google-id-pg" });
    await store.set({ identityGroup: OTHER_GROUP, logicalKey: "client_id", updatedAt: NOW, value: "microsoft-id-pg" });
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_id" }), "google-id-pg");
    assert.equal(await store.get({ identityGroup: OTHER_GROUP, logicalKey: "client_id" }), "microsoft-id-pg");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: set is an upsert via ON CONFLICT(identity_group, logical_key) — no duplicate row, updated_at advances", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.set({ identityGroup: GROUP, logicalKey: "client_secret", updatedAt: NOW, value: "first-pg" });
    await store.set({ identityGroup: GROUP, logicalKey: "client_secret", updatedAt: LATER, value: "second-pg" });

    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_secret" }), "second-pg");
    const { rows } = await postgresQuery<{ n: string; updated_at: string }>(
      "SELECT COUNT(*)::int AS n, MAX(updated_at) AS updated_at FROM provider_app_config WHERE identity_group = $1 AND logical_key = $2",
      [GROUP, "client_secret"]
    );
    const [row] = rows;
    assert.ok(row);
    assert.equal(Number(row.n), 1, "upsert must not leave a duplicate row");
    assert.equal(row.updated_at, LATER);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: delete removes the row; get returns null afterward", { skip: POSTGRES_SKIP }, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.set({ identityGroup: GROUP, logicalKey: "client_secret", updatedAt: NOW, value: CLIENT_SECRET_VALUE });
    await store.delete({ identityGroup: GROUP, logicalKey: "client_secret" });
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_secret" }), null);
    const { rows } = await postgresQuery(
      "SELECT identity_group FROM provider_app_config WHERE identity_group = $1 AND logical_key = $2",
      [GROUP, "client_secret"]
    );
    assert.equal(rows.length, 0, "no row addressable after delete");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: listConfiguredKeys returns only logical_key names, never values", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.set({ identityGroup: GROUP, logicalKey: "client_id", updatedAt: NOW, value: "google-id-pg" });
    await store.set({
      identityGroup: GROUP,
      logicalKey: "client_secret",
      updatedAt: NOW,
      value: CLIENT_SECRET_VALUE,
    });
    await store.set({ identityGroup: OTHER_GROUP, logicalKey: "client_id", updatedAt: NOW, value: "microsoft-id-pg" });

    const keys = await store.listConfiguredKeys(GROUP);
    assert.deepEqual([...keys].sort(), ["client_id", "client_secret"]);
    const serialized = JSON.stringify(keys);
    assert.ok(!serialized.includes("google-id-pg"), "listConfiguredKeys must never leak values");
    assert.ok(!serialized.includes(CLIENT_SECRET_VALUE), "listConfiguredKeys must never leak secret values");
    assert.deepEqual(await store.listConfiguredKeys("no-such-group-pg"), []);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: set fails closed when the operator encryption key is unconfigured", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: {} });
    await assert.rejects(
      () =>
        store.set({ identityGroup: GROUP, logicalKey: "client_secret", updatedAt: NOW, value: CLIENT_SECRET_VALUE }),
      (err) => err instanceof Error && (err as { code?: string }).code === "credential_encryption_key_missing"
    );
    const { rows } = await postgresQuery("SELECT identity_group FROM provider_app_config WHERE identity_group = $1", [
      GROUP,
    ]);
    assert.equal(rows.length, 0, "nothing is written when encryption is unconfigured");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: resolver prefers the DB-stored value over a set env alias, falls back to env when the DB is unset", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.set({ identityGroup: GROUP, logicalKey: "client_id", updatedAt: NOW, value: "db-stored-id-pg" });

    const dbFirstResolver = createDeploymentConfigResolver({
      env: { ...envWithKey(), GOOGLE_OAUTH_CLIENT_ID: "env-supplied-id-pg" },
      store,
    });
    assert.equal(
      await dbFirstResolver({ envAlias: "GOOGLE_OAUTH_CLIENT_ID", identityGroup: GROUP, logicalKey: "client_id" }),
      "db-stored-id-pg"
    );

    await cleanup();
    const envFallbackResolver = createDeploymentConfigResolver({
      env: { ...envWithKey(), GOOGLE_OAUTH_CLIENT_ID: "env-supplied-id-pg" },
      store,
    });
    assert.equal(
      await envFallbackResolver({ envAlias: "GOOGLE_OAUTH_CLIENT_ID", identityGroup: GROUP, logicalKey: "client_id" }),
      "env-supplied-id-pg"
    );
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

// ---------------------------------------------------------------------------
// setMany — atomic multi-row upsert (real Postgres transaction)
// ---------------------------------------------------------------------------

test("real PostgreSQL: setMany commits every entry together in one transaction", { skip: POSTGRES_SKIP }, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.setMany({
      identityGroup: GROUP,
      updatedAt: NOW,
      values: [
        { logicalKey: "client_id", value: "google-id-pg" },
        { logicalKey: "client_secret", value: CLIENT_SECRET_VALUE },
      ],
    });
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_id" }), "google-id-pg");
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_secret" }), CLIENT_SECRET_VALUE);
    assert.deepEqual([...(await store.listConfiguredKeys(GROUP))].sort(), ["client_id", "client_secret"]);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: setMany is an upsert per entry via ON CONFLICT — no duplicate rows", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await store.setMany({
      identityGroup: GROUP,
      updatedAt: NOW,
      values: [
        { logicalKey: "client_id", value: "first-id-pg" },
        { logicalKey: "client_secret", value: "first-secret-pg" },
      ],
    });
    await store.setMany({
      identityGroup: GROUP,
      updatedAt: LATER,
      values: [
        { logicalKey: "client_id", value: "first-id-pg" },
        { logicalKey: "client_secret", value: "rotated-secret-pg" },
      ],
    });
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_id" }), "first-id-pg");
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_secret" }), "rotated-secret-pg");
    const { rows } = await postgresQuery<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM provider_app_config WHERE identity_group = $1",
      [GROUP]
    );
    const [row] = rows;
    assert.ok(row);
    assert.equal(Number(row.n), 2, "setMany upsert must not leave duplicate rows");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: setMany rejects an empty/invalid batch before any write is attempted", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });
    await assert.rejects(() => store.setMany({ identityGroup: GROUP, updatedAt: NOW, values: [] }));
    await assert.rejects(() =>
      store.setMany({
        identityGroup: GROUP,
        updatedAt: NOW,
        values: [
          { logicalKey: "client_id", value: "first" },
          { logicalKey: "client_id", value: "duplicate-key" },
        ],
      })
    );
    assert.deepEqual(await store.listConfiguredKeys(GROUP), []);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: setMany rolls back the WHOLE batch on a mid-transaction failure — no partial commit", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    const store = createPostgresProviderAppConfigStore({ env: envWithKey() });

    // Pre-existing sibling row in the same identity group, to prove the
    // rollback does not touch unrelated already-committed state either.
    await store.set({ identityGroup: GROUP, logicalKey: "unrelated_key", updatedAt: NOW, value: "unrelated-pg" });

    let sawFaultAfterRow = -1;
    __setProviderAppConfigSetManyFaultHookForTest((rowsWrittenSoFar: number) => {
      if (rowsWrittenSoFar === 2) {
        sawFaultAfterRow = rowsWrittenSoFar;
        throw new Error("injected mid-batch fault after row 2 (pg)");
      }
    });
    try {
      await assert.rejects(
        () =>
          store.setMany({
            identityGroup: GROUP,
            updatedAt: LATER,
            values: [
              { logicalKey: "client_id", value: "would-be-id-pg" },
              { logicalKey: "client_secret", value: "would-be-secret-pg" },
              { logicalKey: "third_key", value: "would-be-third-pg" },
            ],
          }),
        INJECTED_MID_BATCH_FAULT_RE
      );
    } finally {
      __setProviderAppConfigSetManyFaultHookForTest(null);
    }
    assert.equal(sawFaultAfterRow, 2, "the fault must fire mid-batch, proving rows 1-2 executed before the throw");

    // None of the batch's three entries were committed by real Postgres --
    // not even the two rows that executed before the injected throw and
    // the ROLLBACK.
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_id" }), null);
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_secret" }), null);
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "third_key" }), null);

    // The pre-existing sibling row survives untouched.
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "unrelated_key" }), "unrelated-pg");
    assert.deepEqual(await store.listConfiguredKeys(GROUP), ["unrelated_key"]);

    // A subsequent clean setMany call still succeeds -- the aborted
    // transaction did not leave the connection or table in a bad state.
    await store.setMany({
      identityGroup: GROUP,
      updatedAt: LATER,
      values: [{ logicalKey: "client_id", value: "recovered-id-pg" }],
    });
    assert.equal(await store.get({ identityGroup: GROUP, logicalKey: "client_id" }), "recovered-id-pg");
  } finally {
    __setProviderAppConfigSetManyFaultHookForTest(null);
    await cleanup();
    await closePostgresStorage();
  }
});

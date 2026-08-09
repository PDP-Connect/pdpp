// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";
import {
  __setProviderAppConfigSetManyFaultHookForTest,
  createDeploymentConfigResolver,
  createSqliteProviderAppConfigStore,
} from "../server/stores/provider-app-config-store.ts";

const INJECTED_MID_BATCH_FAULT_RE = /injected mid-batch fault/;

const NOW = "2026-08-09T12:00:00.000Z";
const LATER = "2026-08-09T12:05:00.000Z";
const TEST_KEY = "test-operator-key-do-not-use-in-prod";
const CLIENT_SECRET_VALUE = "gocspx-super-secret-client-value";

function envWithKey(key = TEST_KEY) {
  return { [CREDENTIAL_ENCRYPTION_KEY_ENV]: key };
}

function withDb(fn: () => Promise<void> | void) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

interface ProviderAppConfigRow {
  sealed_value: string;
}

// ---------------------------------------------------------------------------
// Store: get/set/delete/listConfiguredKeys — keyed by (identityGroup, logicalKey)
// ---------------------------------------------------------------------------

test(
  "set seals at rest; the row is keyed by (identity_group, logical_key), never by an env-var literal",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_secret",
      updatedAt: NOW,
      value: CLIENT_SECRET_VALUE,
    });

    const row = getDb()
      .prepare("SELECT sealed_value FROM provider_app_config WHERE identity_group = ? AND logical_key = ?")
      .get("shared-google-oauth-app", "client_secret") as ProviderAppConfigRow | undefined;
    assert.ok(row, "row exists after set, keyed by (identity_group, logical_key)");
    assert.ok(row.sealed_value.startsWith("v1:"), "value is sealed, not plaintext");
    assert.ok(!row.sealed_value.includes(CLIENT_SECRET_VALUE), "at-rest column must not contain plaintext");

    const recovered = await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" });
    assert.equal(recovered, CLIENT_SECRET_VALUE);
  })
);

test(
  "a non-secret entry (e.g. client_id) is sealed at rest exactly like a secret entry — there is no plaintext column path",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    const CLIENT_ID_VALUE = "a-non-secret-client-id-value";
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
      updatedAt: NOW,
      value: CLIENT_ID_VALUE,
    });
    const row = getDb()
      .prepare("SELECT sealed_value FROM provider_app_config WHERE identity_group = ? AND logical_key = ?")
      .get("shared-google-oauth-app", "client_id") as ProviderAppConfigRow | undefined;
    assert.ok(row, "row exists after set");
    assert.ok(row.sealed_value.startsWith("v1:"), "non-secret value is sealed, not stored as plaintext");
    assert.ok(!row.sealed_value.includes(CLIENT_ID_VALUE), "at-rest column must not contain the plaintext value");
    assert.equal(await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_id" }), CLIENT_ID_VALUE);
  })
);

test(
  "get returns null for an absent (identityGroup, logicalKey) pair",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    assert.equal(await store.get({ identityGroup: "unset-group", logicalKey: "client_id" }), null);
  })
);

test(
  "two identity groups holding the same logical_key do not collide",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
      updatedAt: NOW,
      value: "google-client-id-value",
    });
    await store.set({
      identityGroup: "shared-microsoft-oauth-app",
      logicalKey: "client_id",
      updatedAt: NOW,
      value: "microsoft-client-id-value",
    });
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_id" }),
      "google-client-id-value"
    );
    assert.equal(
      await store.get({ identityGroup: "shared-microsoft-oauth-app", logicalKey: "client_id" }),
      "microsoft-client-id-value"
    );
  })
);

test(
  "set is an upsert: a second set for the same key replaces the value and bumps updated_at",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_secret",
      updatedAt: NOW,
      value: "first-value",
    });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_secret",
      updatedAt: LATER,
      value: "second-value",
    });
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" }),
      "second-value"
    );
    const row = getDb()
      .prepare("SELECT updated_at FROM provider_app_config WHERE identity_group = ? AND logical_key = ?")
      .get("shared-google-oauth-app", "client_secret") as { updated_at: string } | undefined;
    assert.ok(row);
    assert.equal(row.updated_at, LATER);
    const countRow = getDb()
      .prepare("SELECT COUNT(*) as n FROM provider_app_config WHERE identity_group = ? AND logical_key = ?")
      .get("shared-google-oauth-app", "client_secret") as { n: number };
    assert.equal(countRow.n, 1, "upsert must not leave a duplicate row");
  })
);

test(
  "delete removes the row; get returns null afterward",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_secret",
      updatedAt: NOW,
      value: CLIENT_SECRET_VALUE,
    });
    await store.delete({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" });
    assert.equal(await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" }), null);
    const row = getDb()
      .prepare("SELECT identity_group FROM provider_app_config WHERE identity_group = ? AND logical_key = ?")
      .get("shared-google-oauth-app", "client_secret");
    assert.equal(row, undefined, "no row addressable after delete");
  })
);

test(
  "listConfiguredKeys returns only logical_key names for the given identity group, never values",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
      updatedAt: NOW,
      value: "google-client-id-value",
    });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_secret",
      updatedAt: NOW,
      value: CLIENT_SECRET_VALUE,
    });
    await store.set({
      identityGroup: "shared-microsoft-oauth-app",
      logicalKey: "client_id",
      updatedAt: NOW,
      value: "microsoft-client-id-value",
    });

    const keys = await store.listConfiguredKeys("shared-google-oauth-app");
    assert.deepEqual([...keys].sort(), ["client_id", "client_secret"]);
    const serialized = JSON.stringify(keys);
    assert.ok(!serialized.includes("google-client-id-value"), "listConfiguredKeys must never leak values");
    assert.ok(!serialized.includes(CLIENT_SECRET_VALUE), "listConfiguredKeys must never leak secret values");

    assert.deepEqual(await store.listConfiguredKeys("shared-microsoft-oauth-app"), ["client_id"]);
    assert.deepEqual(await store.listConfiguredKeys("no-such-group"), []);
  })
);

test(
  "set fails closed when the operator encryption key is unconfigured (no plaintext stored)",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: {} });
    await assert.rejects(
      () =>
        store.set({
          identityGroup: "shared-google-oauth-app",
          logicalKey: "client_secret",
          updatedAt: NOW,
          value: CLIENT_SECRET_VALUE,
        }),
      (err) => err instanceof Error && (err as { code?: string }).code === "credential_encryption_key_missing"
    );
    const row = getDb()
      .prepare("SELECT identity_group FROM provider_app_config WHERE identity_group = ?")
      .get("shared-google-oauth-app");
    assert.equal(row, undefined, "nothing is written when encryption is unconfigured");
  })
);

test(
  "get fails closed with the wrong operator key rather than returning a wrong-but-decoded value",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_secret",
      updatedAt: NOW,
      value: CLIENT_SECRET_VALUE,
    });
    const wrongKeyStore = createSqliteProviderAppConfigStore({ env: envWithKey("a-different-operator-key") });
    await assert.rejects(
      () => wrongKeyStore.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" }),
      (err) => err instanceof Error && (err as { code?: string }).code === "credential_decrypt_failed"
    );
  })
);

// ---------------------------------------------------------------------------
// Resolver: DB-first, env-alias fallback
// ---------------------------------------------------------------------------

test(
  "resolver prefers the DB-stored value over a set env alias — a Console-configured value overrides env",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
      updatedAt: NOW,
      value: "db-stored-client-id",
    });
    const resolver = createDeploymentConfigResolver({
      env: { ...envWithKey(), GOOGLE_OAUTH_CLIENT_ID: "env-supplied-client-id" },
      store,
    });
    const resolved = await resolver({
      envAlias: "GOOGLE_OAUTH_CLIENT_ID",
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
    });
    assert.equal(resolved, "db-stored-client-id");
  })
);

test(
  "resolver falls back to the env alias when the DB has no value",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    const resolver = createDeploymentConfigResolver({
      env: { ...envWithKey(), GOOGLE_OAUTH_CLIENT_ID: "env-supplied-client-id" },
      store,
    });
    const resolved = await resolver({
      envAlias: "GOOGLE_OAUTH_CLIENT_ID",
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
    });
    assert.equal(resolved, "env-supplied-client-id");
  })
);

test(
  "resolver falls back to the env alias when no envAlias is declared at all is moot -- falls back to DB with none set returns null",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    const resolver = createDeploymentConfigResolver({
      env: { ...envWithKey(), SOME_UNRELATED_ENV: "irrelevant" },
      store,
    });
    const resolved = await resolver({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" });
    assert.equal(resolved, null);
  })
);

test(
  "resolver treats a blank env alias value as unset when the DB also has nothing",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    const resolver = createDeploymentConfigResolver({
      env: { ...envWithKey(), GOOGLE_OAUTH_CLIENT_ID: "   " },
      store,
    });
    const resolved = await resolver({
      envAlias: "GOOGLE_OAUTH_CLIENT_ID",
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
    });
    assert.equal(resolved, null);
  })
);

test(
  "resolver returns null when neither the DB nor the env alias has a value",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    const resolver = createDeploymentConfigResolver({ env: envWithKey(), store });
    const resolved = await resolver({
      envAlias: "GOOGLE_OAUTH_CLIENT_ID",
      identityGroup: "shared-google-oauth-app",
      logicalKey: "client_id",
    });
    assert.equal(resolved, null);
  })
);

// ---------------------------------------------------------------------------
// setMany — atomic multi-row upsert
// ---------------------------------------------------------------------------

test(
  "setMany commits every entry together, sealed at rest, keyed under the same identity group",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.setMany({
      identityGroup: "shared-google-oauth-app",
      updatedAt: NOW,
      values: [
        { logicalKey: "client_id", value: "google-client-id-value" },
        { logicalKey: "client_secret", value: CLIENT_SECRET_VALUE },
      ],
    });
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_id" }),
      "google-client-id-value"
    );
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" }),
      CLIENT_SECRET_VALUE
    );
    assert.deepEqual([...(await store.listConfiguredKeys("shared-google-oauth-app"))].sort(), [
      "client_id",
      "client_secret",
    ]);
  })
);

test(
  "setMany is an upsert per entry: re-running with a changed subset replaces only what changed",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await store.setMany({
      identityGroup: "shared-google-oauth-app",
      updatedAt: NOW,
      values: [
        { logicalKey: "client_id", value: "first-client-id" },
        { logicalKey: "client_secret", value: "first-secret" },
      ],
    });
    await store.setMany({
      identityGroup: "shared-google-oauth-app",
      updatedAt: LATER,
      values: [
        { logicalKey: "client_id", value: "first-client-id" },
        { logicalKey: "client_secret", value: "rotated-secret" },
      ],
    });
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_id" }),
      "first-client-id"
    );
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" }),
      "rotated-secret"
    );
    const countRow = getDb()
      .prepare("SELECT COUNT(*) as n FROM provider_app_config WHERE identity_group = ?")
      .get("shared-google-oauth-app") as { n: number };
    assert.equal(countRow.n, 2, "setMany upsert must not leave duplicate rows");
  })
);

test(
  "setMany rejects an empty values array before any write is attempted",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await assert.rejects(() => store.setMany({ identityGroup: "shared-google-oauth-app", updatedAt: NOW, values: [] }));
    assert.deepEqual(await store.listConfiguredKeys("shared-google-oauth-app"), []);
  })
);

test(
  "setMany rejects a blank logicalKey or empty value before any write is attempted",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await assert.rejects(() =>
      store.setMany({
        identityGroup: "shared-google-oauth-app",
        updatedAt: NOW,
        values: [
          { logicalKey: "client_id", value: "ok-value" },
          { logicalKey: "", value: "would-be-orphaned" },
        ],
      })
    );
    await assert.rejects(() =>
      store.setMany({
        identityGroup: "shared-google-oauth-app",
        updatedAt: NOW,
        values: [
          { logicalKey: "client_id", value: "ok-value" },
          { logicalKey: "client_secret", value: "" },
        ],
      })
    );
    // Neither call should have written the valid sibling entry either.
    assert.deepEqual(await store.listConfiguredKeys("shared-google-oauth-app"), []);
  })
);

test(
  "setMany rejects a duplicate logicalKey within the same call before any write is attempted",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });
    await assert.rejects(() =>
      store.setMany({
        identityGroup: "shared-google-oauth-app",
        updatedAt: NOW,
        values: [
          { logicalKey: "client_id", value: "first" },
          { logicalKey: "client_id", value: "second" },
        ],
      })
    );
    assert.deepEqual(await store.listConfiguredKeys("shared-google-oauth-app"), []);
  })
);

test(
  "setMany fails closed when the operator encryption key is unconfigured; nothing is written",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: {} });
    await assert.rejects(
      () =>
        store.setMany({
          identityGroup: "shared-google-oauth-app",
          updatedAt: NOW,
          values: [{ logicalKey: "client_id", value: "would-be-value" }],
        }),
      (err) => err instanceof Error && (err as { code?: string }).code === "credential_encryption_key_missing"
    );
    const row = getDb()
      .prepare("SELECT identity_group FROM provider_app_config WHERE identity_group = ?")
      .get("shared-google-oauth-app");
    assert.equal(row, undefined);
  })
);

test(
  "setMany rolls back the WHOLE batch on a mid-transaction failure — no partial commit (SQLite)",
  withDb(async () => {
    const store = createSqliteProviderAppConfigStore({ env: envWithKey() });

    // Pre-existing sibling row in the same identity group, to prove the
    // rollback does not touch unrelated already-committed state either.
    await store.set({
      identityGroup: "shared-google-oauth-app",
      logicalKey: "unrelated_key",
      updatedAt: NOW,
      value: "unrelated-value",
    });

    let sawFaultAfterRow = -1;
    __setProviderAppConfigSetManyFaultHookForTest((rowsWrittenSoFar: number) => {
      if (rowsWrittenSoFar === 2) {
        sawFaultAfterRow = rowsWrittenSoFar;
        throw new Error("injected mid-batch fault after row 2");
      }
    });
    try {
      await assert.rejects(
        () =>
          store.setMany({
            identityGroup: "shared-google-oauth-app",
            updatedAt: LATER,
            values: [
              { logicalKey: "client_id", value: "would-be-client-id" },
              { logicalKey: "client_secret", value: "would-be-client-secret" },
              { logicalKey: "third_key", value: "would-be-third-value" },
            ],
          }),
        INJECTED_MID_BATCH_FAULT_RE
      );
    } finally {
      __setProviderAppConfigSetManyFaultHookForTest(null);
    }
    assert.equal(sawFaultAfterRow, 2, "the fault must fire mid-batch, proving rows 1-2 executed before the throw");

    // None of the batch's three entries were committed -- not even the two
    // rows that executed before the injected throw.
    assert.equal(await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_id" }), null);
    assert.equal(await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_secret" }), null);
    assert.equal(await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "third_key" }), null);

    // The pre-existing sibling row survives untouched.
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "unrelated_key" }),
      "unrelated-value"
    );
    assert.deepEqual(await store.listConfiguredKeys("shared-google-oauth-app"), ["unrelated_key"]);

    // A subsequent clean setMany call still succeeds -- the aborted
    // transaction did not corrupt or lock the table.
    await store.setMany({
      identityGroup: "shared-google-oauth-app",
      updatedAt: LATER,
      values: [{ logicalKey: "client_id", value: "recovered-client-id" }],
    });
    assert.equal(
      await store.get({ identityGroup: "shared-google-oauth-app", logicalKey: "client_id" }),
      "recovered-client-id"
    );
  })
);

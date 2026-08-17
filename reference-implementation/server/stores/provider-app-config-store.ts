// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries, writeTransaction } from "../../lib/db.ts";
import { postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import { createCredentialCipherFromEnv } from "./credential-encryption.ts";

interface ProviderAppConfigRow {
  identity_group: string;
  logical_key: string;
  sealed_value: string;
  updated_at: string;
}

interface PostgresTransactionClient {
  query: (sql: string, params: readonly unknown[]) => Promise<unknown>;
}

interface ProviderAppConfigStoreRead {
  getRaw: (args: { identityGroup: string; logicalKey: string }) => Promise<ProviderAppConfigRow | null>;
  listConfiguredKeys: (identityGroup: string) => Promise<readonly string[]>;
}

interface ProviderAppConfigStoreRun {
  delete: (args: { identityGroup: string; logicalKey: string }) => Promise<void>;
  upsert: (row: ProviderAppConfigRow) => Promise<void>;
  /** All rows commit together or none do -- see `ProviderAppConfigStore.setMany`. */
  upsertMany: (rows: readonly ProviderAppConfigRow[]) => Promise<void>;
}

/**
 * Deployment-scoped provider app config store (e.g. a shared OAuth client
 * id/secret), keyed generically by `(identityGroup, logicalKey)` -- never by
 * an env-var literal. Reuses `credential-encryption.ts`'s AES-256-GCM seal
 * so a secret-flagged entry (e.g. a client secret) is never stored in
 * plaintext; callers decide which entries are secret via manifest-declared
 * `deployment_config[].secret`, not this store.
 *
 * `get`/`set` always seal/unseal the value through the operator-held
 * encryption key -- there is no separate plaintext path for non-secret
 * entries (e.g. a client id). Sealing a non-secret value costs nothing
 * functionally and keeps this store's on-disk shape uniform regardless of
 * which logical keys a manifest happens to flag `secret: true`.
 */
export interface ProviderAppConfigSetManyEntry {
  logicalKey: string;
  value: string;
}

export interface ProviderAppConfigStore {
  delete: (args: { identityGroup: string; logicalKey: string }) => Promise<void>;
  get: (args: { identityGroup: string; logicalKey: string }) => Promise<string | null>;
  listConfiguredKeys: (identityGroup: string) => Promise<readonly string[]>;
  set: (args: { identityGroup: string; logicalKey: string; value: string; updatedAt: string }) => Promise<void>;
  /**
   * Atomic multi-row upsert: every entry commits together, or (on any
   * validation failure or backend error) none do. This is the sanctioned
   * write path for provider app config setup/rotation -- a manifest's
   * `deployment_config` is a set (e.g. client_id + client_secret together),
   * and a partial write would leave the identity group in an inconsistent,
   * half-configured state no read path can distinguish from "never set up."
   */
  setMany: (args: {
    identityGroup: string;
    updatedAt: string;
    values: readonly ProviderAppConfigSetManyEntry[];
  }) => Promise<void>;
}

function assertKeyArgs({ identityGroup, logicalKey }: { identityGroup: string; logicalKey: string }): void {
  if (typeof identityGroup !== "string" || !identityGroup) {
    throw new Error("identityGroup is required.");
  }
  if (typeof logicalKey !== "string" || !logicalKey) {
    throw new Error("logicalKey is required.");
  }
}

/** One entry's own shape, independent of its position or siblings in the batch. */
function assertSetManyEntryShape(entry: ProviderAppConfigSetManyEntry): void {
  if (typeof entry.logicalKey !== "string" || !entry.logicalKey) {
    throw new Error("Every setMany entry requires a non-empty logicalKey.");
  }
  if (typeof entry.value !== "string" || entry.value.length === 0) {
    throw new Error(`setMany entry '${entry.logicalKey}' requires a non-empty value.`);
  }
}

/**
 * Validate every entry up front, before any row is sealed or written, so a
 * bad entry anywhere in the batch fails the whole call with nothing
 * persisted -- not just nothing committed by the transaction, but nothing
 * even attempted.
 */
function assertSetManyArgs({
  identityGroup,
  updatedAt,
  values,
}: {
  identityGroup: string;
  updatedAt: string;
  values: readonly ProviderAppConfigSetManyEntry[];
}): void {
  if (typeof identityGroup !== "string" || !identityGroup) {
    throw new Error("identityGroup is required.");
  }
  if (typeof updatedAt !== "string" || !updatedAt) {
    throw new Error("updatedAt is required.");
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values must be a non-empty array.");
  }
  const seenKeys = new Set<string>();
  for (const entry of values) {
    assertSetManyEntryShape(entry);
    if (seenKeys.has(entry.logicalKey)) {
      throw new Error(`setMany received duplicate logicalKey '${entry.logicalKey}'.`);
    }
    seenKeys.add(entry.logicalKey);
  }
}

// Test-only fault injection for `setMany`'s atomicity. Production callers
// never set this. A test installs a hook that throws after a given number
// of rows have executed inside the write transaction, proving the whole
// batch rolls back rather than partially committing. No-op when unset.
type SetManyFaultHook = (rowsWrittenSoFar: number) => void;
let setManyFaultHook: SetManyFaultHook | null = null;

export function __setProviderAppConfigSetManyFaultHookForTest(hook: unknown): void {
  setManyFaultHook = typeof hook === "function" ? (hook as SetManyFaultHook) : null;
}

function maybeSetManyFault(rowsWrittenSoFar: number): void {
  setManyFaultHook?.(rowsWrittenSoFar);
}

function buildStore({
  run,
  read,
  cipherFactory,
}: {
  cipherFactory: typeof createCredentialCipherFromEnv;
  read: ProviderAppConfigStoreRead;
  run: ProviderAppConfigStoreRun;
}): ProviderAppConfigStore {
  function cipher() {
    // Built per-operation, matching connector-instance-credential-store.ts:
    // a key configured after process start (or rotated in tests) is always
    // picked up, and the fail-closed error surfaces at the exact get/set
    // call rather than at store construction.
    return cipherFactory();
  }

  return {
    async delete({ identityGroup, logicalKey }: { identityGroup: string; logicalKey: string }) {
      assertKeyArgs({ identityGroup, logicalKey });
      await run.delete({ identityGroup, logicalKey });
    },

    /**
     * Recover the plaintext value for one `(identityGroup, logicalKey)`
     * entry, or `null` when absent. Never returns the sealed form.
     */
    async get({ identityGroup, logicalKey }: { identityGroup: string; logicalKey: string }) {
      assertKeyArgs({ identityGroup, logicalKey });
      const row = await read.getRaw({ identityGroup, logicalKey });
      if (!row) {
        return null;
      }
      return cipher().open(row.sealed_value);
    },

    /** logical_key names only, for "already configured" UI/readiness state. */
    listConfiguredKeys(identityGroup: string) {
      if (typeof identityGroup !== "string" || !identityGroup) {
        throw new Error("identityGroup is required.");
      }
      return read.listConfiguredKeys(identityGroup);
    },

    async set({
      identityGroup,
      logicalKey,
      value,
      updatedAt,
    }: {
      identityGroup: string;
      logicalKey: string;
      updatedAt: string;
      value: string;
    }) {
      assertKeyArgs({ identityGroup, logicalKey });
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("value must be a non-empty string.");
      }
      if (typeof updatedAt !== "string" || !updatedAt) {
        throw new Error("updatedAt is required.");
      }
      const sealed = cipher().seal(value);
      await run.upsert({
        identity_group: identityGroup,
        logical_key: logicalKey,
        sealed_value: sealed,
        updated_at: updatedAt,
      });
    },

    async setMany({
      identityGroup,
      values,
      updatedAt,
    }: {
      identityGroup: string;
      updatedAt: string;
      values: readonly ProviderAppConfigSetManyEntry[];
    }) {
      assertSetManyArgs({ identityGroup, updatedAt, values });
      const c = cipher();
      const rows = values.map((entry) => ({
        identity_group: identityGroup,
        logical_key: entry.logicalKey,
        sealed_value: c.seal(entry.value),
        updated_at: updatedAt,
      }));
      await run.upsertMany(rows);
    },
  };
}

export function createSqliteProviderAppConfigStore({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv;
} = {}): ProviderAppConfigStore {
  return buildStore({
    cipherFactory: () => createCredentialCipherFromEnv(env),
    read: {
      getRaw({ identityGroup, logicalKey }: { identityGroup: string; logicalKey: string }) {
        return Promise.resolve(
          getOne<ProviderAppConfigRow>(referenceQueries.providerAppConfigGetByIdentityGroupAndLogicalKey, [
            identityGroup,
            logicalKey,
          ])
        );
      },
      listConfiguredKeys(identityGroup: string) {
        const rows = allowUnboundedReadAcknowledged<{ logical_key: string }>(
          referenceQueries.providerAppConfigListConfiguredKeysByIdentityGroup,
          [identityGroup]
        );
        return Promise.resolve(rows.map((row) => row.logical_key));
      },
    },
    run: {
      delete({ identityGroup, logicalKey }: { identityGroup: string; logicalKey: string }) {
        exec(referenceQueries.providerAppConfigDeleteByIdentityGroupAndLogicalKey, [identityGroup, logicalKey]);
        return Promise.resolve();
      },
      upsert(row: ProviderAppConfigRow) {
        exec(referenceQueries.providerAppConfigUpsert, [
          row.identity_group,
          row.logical_key,
          row.sealed_value,
          row.updated_at,
        ]);
        return Promise.resolve();
      },
      upsertMany(rows: readonly ProviderAppConfigRow[]) {
        // better-sqlite3 transactions are synchronous; writeTransaction wraps
        // BEGIN IMMEDIATE/COMMIT/ROLLBACK around the plain exec() calls below,
        // so either every row in the batch lands or (on any exec failure) the
        // whole transaction rolls back and none do.
        writeTransaction(() => {
          let written = 0;
          for (const row of rows) {
            exec(referenceQueries.providerAppConfigUpsert, [
              row.identity_group,
              row.logical_key,
              row.sealed_value,
              row.updated_at,
            ]);
            written += 1;
            maybeSetManyFault(written);
          }
        });
        return Promise.resolve();
      },
    },
  });
}

export function createPostgresProviderAppConfigStore({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv;
} = {}): ProviderAppConfigStore {
  return buildStore({
    cipherFactory: () => createCredentialCipherFromEnv(env),
    read: {
      async getRaw({
        identityGroup,
        logicalKey,
      }: {
        identityGroup: string;
        logicalKey: string;
      }): Promise<ProviderAppConfigRow | null> {
        const result = await postgresQuery<ProviderAppConfigRow>(
          `SELECT identity_group, logical_key, sealed_value, updated_at
           FROM provider_app_config
           WHERE identity_group = $1 AND logical_key = $2`,
          [identityGroup, logicalKey]
        );
        return result.rows[0] ?? null;
      },
      async listConfiguredKeys(identityGroup: string): Promise<readonly string[]> {
        const result = await postgresQuery<{ logical_key: string }>(
          "SELECT logical_key FROM provider_app_config WHERE identity_group = $1 ORDER BY logical_key ASC",
          [identityGroup]
        );
        return result.rows.map((row) => row.logical_key);
      },
    },
    run: {
      async delete({ identityGroup, logicalKey }: { identityGroup: string; logicalKey: string }): Promise<void> {
        await postgresQuery("DELETE FROM provider_app_config WHERE identity_group = $1 AND logical_key = $2", [
          identityGroup,
          logicalKey,
        ]);
      },
      async upsert(row: ProviderAppConfigRow): Promise<void> {
        await postgresQuery(
          `INSERT INTO provider_app_config(identity_group, logical_key, sealed_value, updated_at)
           VALUES($1, $2, $3, $4)
           ON CONFLICT(identity_group, logical_key) DO UPDATE SET
             sealed_value = excluded.sealed_value,
             updated_at = excluded.updated_at`,
          [row.identity_group, row.logical_key, row.sealed_value, row.updated_at]
        );
      },
      async upsertMany(rows: readonly ProviderAppConfigRow[]): Promise<void> {
        // withPostgresTransaction issues BEGIN before the callback and
        // COMMIT after it resolves, or ROLLBACK if it throws -- so a
        // mid-batch error (e.g. a connection drop) leaves zero rows
        // committed, not a partial write.
        await withPostgresTransaction(async (client: PostgresTransactionClient) => {
          let written = 0;
          for (const row of rows) {
            // biome-ignore lint/performance/noAwaitInLoops: sequential writes inside one transaction; ordering does not matter for correctness but a single shared client cannot run concurrent queries.
            await client.query(
              `INSERT INTO provider_app_config(identity_group, logical_key, sealed_value, updated_at)
               VALUES($1, $2, $3, $4)
               ON CONFLICT(identity_group, logical_key) DO UPDATE SET
                 sealed_value = excluded.sealed_value,
                 updated_at = excluded.updated_at`,
              [row.identity_group, row.logical_key, row.sealed_value, row.updated_at]
            );
            written += 1;
            maybeSetManyFault(written);
          }
        });
      },
    },
  });
}

export type DeploymentConfigResolver = (args: {
  envAlias?: string | null;
  identityGroup: string;
  logicalKey: string;
}) => Promise<string | null>;

/**
 * DB-first, env-alias-fallback resolver for a manifest-declared deployment
 * config value. The DB-backed store (Console's own configuration surface) is
 * authoritative -- when an operator sets a value there, it wins even if an
 * env var is also present, so Console-configured values can supersede a
 * stale or accidental env var without an env change. `envAlias` is optional
 * and exists only so an operator can rely on an env var for infra-as-code
 * deploys where the DB has never been configured -- it is consulted only
 * when the store has no value. Callers of the returned function never see
 * or handle env var names beyond the `envAlias` they pass in.
 */
export function createDeploymentConfigResolver({
  env = process.env,
  store,
}: {
  env?: NodeJS.ProcessEnv;
  store: Pick<ProviderAppConfigStore, "get">;
}): DeploymentConfigResolver {
  return async ({
    identityGroup,
    logicalKey,
    envAlias,
  }: {
    envAlias?: string | null;
    identityGroup: string;
    logicalKey: string;
  }) => {
    // store.get() returns null for an unset key or the sealed value it was
    // given -- set() already rejects an empty-string value before sealing,
    // so a non-null result here is never blank and needs no further check.
    const fromStore = await store.get({ identityGroup, logicalKey });
    if (fromStore !== null) {
      return fromStore;
    }
    const fromEnv = envAlias ? env[envAlias] : undefined;
    return typeof fromEnv === "string" && fromEnv.trim() ? fromEnv.trim() : null;
  };
}

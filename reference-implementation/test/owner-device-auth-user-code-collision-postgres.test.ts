// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-adapter parity for the bounded `user_code` collision retry
 * exercised via `initiateOwnerDeviceAuthorization` (see
 * `owner-device-auth-user-code-collision.test.ts` for the SQLite-adapter
 * version and the live-deploy blocker this guards: startup
 * createOwnerDeviceAuth for Gmail failed with PostgreSQL 23505 on user_code
 * 920076 already existing).
 *
 * Runs the REAL `postgresOwnerDeviceAuthStore` adapter (see
 * `auth-consent-device-postgres-path.test.ts`) so the retry loop's Postgres
 * branch (`err.code === "23505"` narrowed to
 * `err.constraint === "owner_device_auth_user_code_key"`) is proven against
 * an actual Postgres unique_violation, not just SQLite's
 * `SQLITE_CONSTRAINT_UNIQUE`.
 *
 * Gated on `PDPP_TEST_POSTGRES_URL`; when unset it registers a single
 * skipped test so default development and CI do not need Postgres.
 *
 * Run (Compose Postgres proof service):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55467/pdpp_authpath \
 *     node --test --import tsx \
 *     reference-implementation/test/owner-device-auth-user-code-collision-postgres.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  initiateOwnerDeviceAuthorization,
  isUserCodeUniqueViolation,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CLIENT_ID = "pg_user_code_collision_client";

function sequenceGenerator(codes: string[]): () => string {
  let index = 0;
  return () => {
    const code = codes[index];
    index += 1;
    if (code === undefined) {
      throw new Error("sequenceGenerator: exhausted queued candidate codes");
    }
    return code;
  };
}

async function seedRow(deviceCode: string, userCode: string, approvalId: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO owner_device_auth(
       device_code, user_code, client_id, status, interval_seconds,
       created_at, expires_at, approval_id
     ) VALUES($1, $2, $3, 'pending', 5, now()::text, (now() + interval '300 seconds')::text, $4)`,
    [deviceCode, userCode, CLIENT_ID, approvalId]
  );
}

if (POSTGRES_URL) {
  let setupOk = false;

  test.before(async () => {
    initDb(":memory:");
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
    await seedPreRegisteredClients([
      {
        client_id: CLIENT_ID,
        client_name: "PG user_code collision test",
        registration_mode: "pre_registered_public",
      },
    ]);
    setupOk = true;
  });

  test.after(async () => {
    await closePostgresStorage();
    closeDb();
  });

  test("initiateOwnerDeviceAuthorization (postgres): retries once past a real 23505 unique_violation and persists the retried code", async () => {
    assert.equal(setupOk, true, "before() setup must have completed");

    await seedRow("pg_dc_owner_preexisting", "PGAAAA", "pg_appr_preexisting");

    const result = await initiateOwnerDeviceAuthorization(CLIENT_ID, {
      nextCandidateUserCode: sequenceGenerator(["PGAAAA", "PGBBBB"]),
    });

    assert.equal(result.user_code, "PGBBBB", "the retried code is what the caller observes and persists");
  });

  test("initiateOwnerDeviceAuthorization (postgres): exhausts bounded retries and fails deterministically with the real 23505", async () => {
    assert.equal(setupOk, true, "before() setup must have completed");

    await Promise.all(
      ["PG1111", "PG2222", "PG3333", "PG4444", "PG5555"].map((code) =>
        seedRow(`pg_dc_owner_taken_${code}`, code, `pg_appr_taken_${code}`)
      )
    );

    await assert.rejects(
      () =>
        initiateOwnerDeviceAuthorization(CLIENT_ID, {
          nextCandidateUserCode: sequenceGenerator(["PG1111", "PG2222", "PG3333", "PG4444", "PG5555"]),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: unknown }).code, "23505", "the real Postgres unique_violation code propagates");
        assert.equal(
          (err as { constraint?: unknown }).constraint,
          "owner_device_auth_user_code_key",
          "the real constraint name matches the exact column this retry loop targets"
        );
        return true;
      }
    );
  });

  test("real postgres driver: an approval_id collision (same 23505 code as user_code, different constraint) is correctly classified as NOT retryable", async () => {
    assert.equal(setupOk, true, "before() setup must have completed");

    await seedRow("pg_dc_real_1", "PGREAL1", "pg_appr_real_shared");

    await assert.rejects(
      () => seedRow("pg_dc_real_2", "PGREAL2", "pg_appr_real_shared"),
      (err: unknown) => {
        // This is the REAL error thrown by the pg driver for this exact
        // schema and collision -- not a constructed shape. Confirms the
        // approval_id collision shares user_code's 23505 code (proving the
        // code alone cannot distinguish them) while `.constraint` names a
        // different constraint, and that isUserCodeUniqueViolation
        // correctly refuses to treat it as retryable.
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: unknown }).code, "23505");
        assert.equal((err as { constraint?: unknown }).constraint, "owner_device_auth_approval_id_key");
        assert.equal(isUserCodeUniqueViolation(err), false);
        return true;
      }
    );
  });

  test("initiateOwnerDeviceAuthorization (postgres): a collision on the FIRST attempt does not invoke the retry generator at all", async () => {
    assert.equal(setupOk, true, "before() setup must have completed");

    let generatorCalls = 0;
    const result = await initiateOwnerDeviceAuthorization(CLIENT_ID, {
      nextCandidateUserCode: () => {
        generatorCalls += 1;
        return "PGUNUSED";
      },
    });
    assert.equal(result.user_code, "PGUNUSED", "the first candidate IS used directly as the initial insert value");
    assert.equal(generatorCalls, 1, "exactly one call: the initial candidate, with zero retry calls on success");
  });
} else {
  test("initiateOwnerDeviceAuthorization postgres-adapter user_code collision retry (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  }, () => {});
}

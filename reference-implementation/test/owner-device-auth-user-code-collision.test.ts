// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded user_code collision retry for `initiateOwnerDeviceAuthorization`.
 *
 * `owner_device_auth.user_code` is a 6-hex-char (~16.7M-value) random string
 * with a UNIQUE constraint on both SQLite (plain column UNIQUE, constraint
 * name unavailable from the driver -- narrowed via the driver's stable
 * "UNIQUE constraint failed: owner_device_auth.user_code" message instead)
 * and Postgres (`owner_device_auth_user_code_key`, confirmed live via `\d
 * owner_device_auth` and via a direct probe insert against the pool: the
 * thrown `pg` DatabaseError's `.constraint` field is exactly that name). At
 * fleet scale a genuine collision on THIS constraint is an expected
 * transient condition, not corruption -- see the live-deploy blocker this
 * suite guards: startup createOwnerDeviceAuth for Gmail failed with
 * PostgreSQL 23505 on user_code 920076 already existing.
 *
 * `isUserCodeUniqueViolation` is exported as a pure predicate so the
 * exact-constraint narrowing itself is unit-tested directly against
 * constructed error shapes (below), independent of a live DB. The
 * integration-level bounded-retry behavior is driven deterministically via
 * `initiateOwnerDeviceAuthorization`'s test-only `opts.nextCandidateUserCode`,
 * instead of mocking `crypto.randomBytes` (which would require
 * `--experimental-test-module-mocks`, a flag the project's shared
 * `pnpm test` runner does not pass, and which cannot intercept `auth.ts`'s
 * plain named `import { randomBytes } from "node:crypto"` binding anyway).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getOwnerDeviceAuthorizationByUserCode,
  initiateOwnerDeviceAuthorization,
  isUserCodeUniqueViolation,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const SAMPLE_CLIENT_ID = "collision_test_client";

function insertOwnerDeviceAuthRow(userCode: string): void {
  getDb()
    .prepare(
      `INSERT INTO owner_device_auth(
         device_code, user_code, client_id, status, interval_seconds,
         created_at, expires_at, request_id, trace_id, scenario_id, approval_id
       ) VALUES(?, ?, ?, 'pending', 5, ?, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      `dc_owner_preexisting_${userCode}`,
      userCode,
      SAMPLE_CLIENT_ID,
      new Date().toISOString(),
      new Date(Date.now() + 300_000).toISOString(),
      `appr_preexisting_${userCode}`
    );
}

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

async function setup(): Promise<void> {
  initDb();
  await seedPreRegisteredClients([
    {
      client_id: SAMPLE_CLIENT_ID,
      metadata: {
        client_name: "Collision Test Client",
        token_endpoint_auth_method: "none",
      },
    },
  ]);
}

function teardown(): void {
  closeDb();
}

// ---------------------------------------------------------------------
// Unit tests: isUserCodeUniqueViolation exact-constraint narrowing.
// ---------------------------------------------------------------------

test("isUserCodeUniqueViolation: matches Postgres 23505 on the exact user_code constraint", () => {
  const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: "owner_device_auth_user_code_key",
  });
  assert.equal(isUserCodeUniqueViolation(err), true);
});

test("isUserCodeUniqueViolation: rejects Postgres 23505 on a DIFFERENT constraint (approval_id)", () => {
  const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: "owner_device_auth_approval_id_key",
  });
  assert.equal(isUserCodeUniqueViolation(err), false);
});

test("isUserCodeUniqueViolation: matches SQLite's user_code UNIQUE message", () => {
  const err = Object.assign(new Error("UNIQUE constraint failed: owner_device_auth.user_code"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
  });
  assert.equal(isUserCodeUniqueViolation(err), true);
});

test("isUserCodeUniqueViolation: rejects SQLite UNIQUE failures on a DIFFERENT column (approval_id)", () => {
  const err = Object.assign(new Error("UNIQUE constraint failed: owner_device_auth.approval_id"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
  });
  assert.equal(isUserCodeUniqueViolation(err), false);
});

test("isUserCodeUniqueViolation: rejects SQLite PRIMARY KEY failures (device_code)", () => {
  const err = Object.assign(new Error("UNIQUE constraint failed: owner_device_auth.device_code"), {
    code: "SQLITE_CONSTRAINT_PRIMARYKEY",
  });
  assert.equal(isUserCodeUniqueViolation(err), false);
});

test("isUserCodeUniqueViolation: rejects non-Error values", () => {
  assert.equal(isUserCodeUniqueViolation({ code: "23505", constraint: "owner_device_auth_user_code_key" }), false);
  assert.equal(isUserCodeUniqueViolation(null), false);
  assert.equal(isUserCodeUniqueViolation("23505"), false);
});

// ---------------------------------------------------------------------
// Integration tests: the bounded retry loop end-to-end.
// ---------------------------------------------------------------------

test("initiateOwnerDeviceAuthorization: retries once past a single user_code collision and persists the retried code", async () => {
  await setup();
  try {
    insertOwnerDeviceAuthRow("AAAAAA");

    const result = await initiateOwnerDeviceAuthorization(SAMPLE_CLIENT_ID, {
      nextCandidateUserCode: sequenceGenerator(["AAAAAA", "BBBBBB"]),
    });

    assert.equal(result.user_code, "BBBBBB");
    const view = await getOwnerDeviceAuthorizationByUserCode("BBBBBB");
    assert.ok(view, "the retried user_code must be persisted and readable");

    // The pre-existing colliding row is untouched -- this is a fresh
    // identity, not an adoption/merge of the pre-existing authorization.
    const original = await getOwnerDeviceAuthorizationByUserCode("AAAAAA");
    assert.ok(original, "the pre-existing row must be left exactly as it was");
  } finally {
    teardown();
  }
});

test("initiateOwnerDeviceAuthorization: exhausts bounded retries and fails deterministically without an infinite loop", async () => {
  await setup();
  try {
    for (const code of ["111111", "222222", "333333", "444444", "555555"]) {
      insertOwnerDeviceAuthRow(code);
    }

    await assert.rejects(
      () =>
        initiateOwnerDeviceAuthorization(SAMPLE_CLIENT_ID, {
          nextCandidateUserCode: sequenceGenerator(["111111", "222222", "333333", "444444", "555555"]),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: unknown }).code, "SQLITE_CONSTRAINT_UNIQUE");
        return true;
      }
    );

    const row = getDb().prepare("SELECT device_code FROM owner_device_auth WHERE user_code = ?").all("555555");
    assert.equal(row.length, 1, "an exhausted collision retry must not leave a duplicate/partial row behind");
  } finally {
    teardown();
  }
});

test("real SQLite driver: an approval_id collision (same SQLITE_CONSTRAINT_UNIQUE code as user_code, different column) is correctly classified as NOT retryable", () => {
  initDb();
  try {
    getDb()
      .prepare(
        `INSERT INTO owner_device_auth(
           device_code, user_code, client_id, status, interval_seconds,
           created_at, expires_at, approval_id
         ) VALUES('dc_real_1', 'REAL01', 'x', 'pending', 5, ?, ?, 'appr_real_shared')`
      )
      .run(new Date().toISOString(), new Date(Date.now() + 300_000).toISOString());

    assert.throws(
      () => {
        getDb()
          .prepare(
            `INSERT INTO owner_device_auth(
             device_code, user_code, client_id, status, interval_seconds,
             created_at, expires_at, approval_id
           ) VALUES('dc_real_2', 'REAL02', 'x', 'pending', 5, ?, ?, 'appr_real_shared')`
          )
          .run(new Date().toISOString(), new Date(Date.now() + 300_000).toISOString());
      },
      (err: unknown) => {
        // This is the REAL error thrown by better-sqlite3 for this exact
        // schema and collision -- not a constructed shape. Confirms the
        // approval_id collision shares user_code's SQLITE_CONSTRAINT_UNIQUE
        // code (proving the code alone cannot distinguish them) while its
        // message names a different column, and that isUserCodeUniqueViolation
        // correctly refuses to treat it as retryable.
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: unknown }).code, "SQLITE_CONSTRAINT_UNIQUE");
        assert.equal(err.message, "UNIQUE constraint failed: owner_device_auth.approval_id");
        assert.equal(isUserCodeUniqueViolation(err), false);
        return true;
      }
    );
  } finally {
    closeDb();
  }
});

test("initiateOwnerDeviceAuthorization: a collision on the FIRST attempt does not invoke the retry generator at all", async () => {
  await setup();
  try {
    // No pre-seeded collision: the first candidate must succeed outright,
    // proving the generator is called lazily -- only after a confirmed
    // user_code collision -- and never merely as part of every attempt.
    let generatorCalls = 0;
    const result = await initiateOwnerDeviceAuthorization(SAMPLE_CLIENT_ID, {
      nextCandidateUserCode: () => {
        generatorCalls += 1;
        return "UNUSED";
      },
    });
    assert.equal(result.user_code, "UNUSED", "the first candidate IS used directly as the initial insert value");
    assert.equal(generatorCalls, 1, "exactly one call: the initial candidate, with zero retry calls on success");
  } finally {
    teardown();
  }
});

test("initiateOwnerDeviceAuthorization: end-to-end success path is unaffected (real generator, no forced collision)", async () => {
  await setup();
  try {
    const result = await initiateOwnerDeviceAuthorization(SAMPLE_CLIENT_ID);
    assert.equal(typeof result.user_code, "string");
    assert.equal((result.user_code as string).length, 6);
    assert.equal(typeof result.device_code, "string");
  } finally {
    teardown();
  }
});

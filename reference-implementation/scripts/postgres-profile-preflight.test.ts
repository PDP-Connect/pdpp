// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { assertPostgresProfilePreflight } from "./postgres-profile-preflight.ts";

const PRIMARY = "postgresql://postgres:postgres@127.0.0.1:55447/pdpp_test_primary";
const RESTORE = "postgresql://postgres:postgres@127.0.0.1:55447/pdpp_test_restore";
const dedicated = (url: string | undefined) => (url?.includes("127.0.0.1:55447/") ? url : null);
const DISTINCT_TARGET_PATTERN = /must name a database distinct/;
const RESTORE_REQUIRED_PATTERN = /postgres profile requires PDPP_TEST_POSTGRES_RESTORE_URL/;
const RESTORE_URL_PATTERN =
  /PDPP_TEST_POSTGRES_RESTORE_URL must be a query- and fragment-free dedicated loopback PostgreSQL test URL/;

test("memory profile does not inspect PostgreSQL targets", async () => {
  await assertPostgresProfilePreflight({
    assertDatabase: async () => assert.fail("memory profile must not open PostgreSQL"),
    isDedicatedUrl: () => assert.fail("memory profile must not inspect URLs"),
    primaryUrl: PRIMARY,
    profile: "memory-default",
    restoreUrl: RESTORE,
  });
});

test("postgres profile admits independently provisioned primary and restore targets before child execution", async () => {
  const admitted: string[] = [];
  await assertPostgresProfilePreflight({
    assertDatabase: (url) => {
      admitted.push(url);
      return Promise.resolve();
    },
    isDedicatedUrl: dedicated,
    primaryUrl: PRIMARY,
    profile: "postgres",
    restoreUrl: RESTORE,
  });
  assert.deepEqual(admitted, [PRIMARY, RESTORE]);
});

test("postgres profile rejects a restore target before a test child can use it", async () => {
  await assert.rejects(
    assertPostgresProfilePreflight({
      assertDatabase: async () => assert.fail("invalid restore target must not be opened"),
      isDedicatedUrl: dedicated,
      primaryUrl: PRIMARY,
      profile: "postgres",
      restoreUrl: "postgresql://example.invalid/not-a-test-database",
    }),
    RESTORE_URL_PATTERN
  );
});

test("postgres profile requires a restore target before a test child can use the primary", async () => {
  await assert.rejects(
    assertPostgresProfilePreflight({
      assertDatabase: async () => assert.fail("missing restore target must not open the primary"),
      isDedicatedUrl: dedicated,
      primaryUrl: PRIMARY,
      profile: "postgres",
      restoreUrl: undefined,
    }),
    RESTORE_REQUIRED_PATTERN
  );
});

test("postgres profile rejects the same database even when its URL spells credentials differently", async () => {
  await assert.rejects(
    assertPostgresProfilePreflight({
      assertDatabase: async () => assert.fail("shared target must not be opened"),
      isDedicatedUrl: dedicated,
      primaryUrl: PRIMARY,
      profile: "postgres",
      restoreUrl: "postgresql://postgres@127.0.0.1:55447/pdpp_test_primary",
    }),
    DISTINCT_TARGET_PATTERN
  );
});

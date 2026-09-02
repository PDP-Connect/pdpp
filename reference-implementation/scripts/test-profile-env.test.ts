// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the 2026-08-30 fail-closed profile guard.
 *
 * Twice an ungated `run-tests.ts` invocation (no --accounting-authority
 * bound, e.g. `npm test` in this directory) silently defaulted an absent
 * PDPP_TEST_PROFILE to memory-default: the 2026-08-30 02:28 discarded #238
 * gate, and the prior day's #242 verification. Both times
 * storageProfileEnvironment() then deleted PDPP_TEST_POSTGRES_URL out from
 * under an operator who believed they were running the postgres profile,
 * and every PostgreSQL-only path was skipped with zero error anywhere.
 *
 * requireExplicitTestProfile() is the narrow seam `run-tests.ts` calls before
 * selecting a profile, whether accounting authority is bound or not. These
 * tests exercise it directly (no subprocess) so the guard is proven without
 * paying for a full RI test run.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessEnvLike } from "./test-env.ts";
import { requireExplicitTestProfile, storageProfileEnvironment } from "./test-profile-env.ts";

const PROFILE_MUST_BE_SET_PATTERN = /PDPP_TEST_PROFILE must be set/;
const POSTGRES_REQUIRES_URL_PATTERN = /postgres profile requires PDPP_TEST_POSTGRES_URL/;
const POSTGRES_URL = "postgresql://postgres:pw@127.0.0.1:55447/pdpp_test";

test("an absent PDPP_TEST_PROFILE hard-fails even when a PostgreSQL URL is supplied", () => {
  const env: ProcessEnvLike = { PDPP_TEST_POSTGRES_URL: POSTGRES_URL };
  assert.throws(() => requireExplicitTestProfile(env), PROFILE_MUST_BE_SET_PATTERN);
});

test("an invalid PDPP_TEST_PROFILE value hard-fails", () => {
  const env: ProcessEnvLike = { PDPP_TEST_PROFILE: "sqlite" };
  assert.throws(() => requireExplicitTestProfile(env), PROFILE_MUST_BE_SET_PATTERN);
});

test("explicit memory-default remains valid with no PostgreSQL URL required", () => {
  const env: ProcessEnvLike = { PDPP_TEST_PROFILE: "memory-default" };
  assert.equal(requireExplicitTestProfile(env), "memory-default");
});

test("explicit postgres without a URL hard-fails", () => {
  const env: ProcessEnvLike = { PDPP_TEST_PROFILE: "postgres" };
  assert.throws(() => requireExplicitTestProfile(env), POSTGRES_REQUIRES_URL_PATTERN);
});

test("explicit postgres with a URL passes and the URL is preserved downstream", () => {
  const env: ProcessEnvLike = { PDPP_TEST_POSTGRES_URL: POSTGRES_URL, PDPP_TEST_PROFILE: "postgres" };
  assert.equal(requireExplicitTestProfile(env), "postgres");
  // The guard only validates; storageProfileEnvironment is what actually
  // shapes the child env, and must not strip the URL for a postgres profile.
  assert.equal(storageProfileEnvironment("postgres", env).PDPP_TEST_POSTGRES_URL, POSTGRES_URL);
});

test("memory-default still scrubs a stray PostgreSQL URL from the child environment", () => {
  const env: ProcessEnvLike = { PDPP_TEST_POSTGRES_URL: POSTGRES_URL, PDPP_TEST_PROFILE: "memory-default" };
  assert.equal(requireExplicitTestProfile(env), "memory-default");
  assert.ok(!("PDPP_TEST_POSTGRES_URL" in storageProfileEnvironment("memory-default", env)));
});

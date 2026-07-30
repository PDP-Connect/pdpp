// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure per-file dedicated-PostgreSQL database name derivation, extracted
 * from `scripts/run-tests.ts` so it can be unit-tested directly: that script
 * is a top-level-await CLI entrypoint and starts the whole test run as a
 * side effect of being imported, so its logic could not previously be
 * exercised from a test without also running the full suite.
 *
 * The grammar this produces MUST stay consistent with
 * `test/helpers/dedicated-postgres-test-url.ts`'s
 * `isDedicatedPostgresTestDatabaseName` — see
 * `test/run-tests-dedicated-postgres-db-name-grammar.test.ts` for the
 * consistency proof and its mutation-proof counterexample.
 */

const WINDOWS_PATH_SEPARATOR_PATTERN = /\\/g;
const FILE_EXTENSION_SUFFIX_PATTERN = /\.[^.]+$/;
const NON_DB_IDENTIFIER_CHAR_PATTERN = /[^a-z0-9_]/gi;

/** The file-derived base segment's maximum length, before the runner-id/counter suffix. */
export const DEDICATED_POSTGRES_DB_NAME_BASE_MAX_LENGTH = 38;

/**
 * Derive a short, safe DB name from a test file path, a per-run random hex
 * id, and a monotonic counter, so concurrent runners and workers never
 * collide. Pure function: the caller owns the counter and runner id state.
 */
export function deriveDedicatedPostgresDbNameForFile(filePath: string, runnerId: string, fileCounter: number): string {
  // Strip directory and extension; keep only alphanumeric/underscore chars.
  const base = (filePath.replace(WINDOWS_PATH_SEPARATOR_PATTERN, "/").split("/").pop() ?? filePath)
    .replace(FILE_EXTENSION_SUFFIX_PATTERN, "")
    .replace(NON_DB_IDENTIFIER_CHAR_PATTERN, "_")
    .toLowerCase()
    .slice(0, DEDICATED_POSTGRES_DB_NAME_BASE_MAX_LENGTH);
  return `pdpp_test_${base}_${runnerId}_${fileCounter.toString(36)}`;
}

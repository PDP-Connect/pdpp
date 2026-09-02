// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Machine-checked half of the Postgres-template opt-in contract
 * (scripts/postgres-template-eligibility.ts). The reviewer HOLD on the
 * template-cloning speedup (PR #278) required both an explicit per-file
 * opt-in AND a machine-checked inventory, since they are cheap together and
 * the two catch different drift:
 *
 *   - The explicit opt-in (default cold in withTemporaryPostgresDatabase and
 *     run-tests.ts's allocateTestDb) stops an UNLISTED file from silently
 *     getting a template.
 *   - This inventory stops a file from being MISCLASSIFIED -- added to the
 *     eligible list by mistake, or newly written with cold-required content
 *     but never triaged at all -- which the opt-in default alone cannot
 *     catch, because a wrong classification still resolves cleanly to some
 *     list.
 *
 * This test walks every top-level `test/*.test.ts` file, classifies each as
 * "Postgres-profile-relevant" (calls withTemporaryPostgresDatabase, or
 * drives initPostgresStorage directly off PDPP_TEST_POSTGRES_URL), and
 * requires every relevant file to appear on EXACTLY ONE of
 * POSTGRES_TEMPLATE_ELIGIBLE_FILES / POSTGRES_TEMPLATE_COLD_REQUIRED_FILES.
 * A relevant file on neither list, or on both, fails this test -- so a new
 * Postgres test file added without triage fails closed instead of silently
 * defaulting to either list.
 *
 * Content-classification heuristic, not semantic proof. This test cannot
 * know whether a file's specific tests actually need cold bootstrap -- that
 * judgment call is made once, by a human or reviewer, when the file is
 * triaged onto one of the two lists. What this test proves mechanically is
 * narrower and durable: every file this heuristic still considers
 * Postgres-relevant is accounted for on some list, and no cold-required file
 * has drifted onto the eligible list.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  POSTGRES_TEMPLATE_COLD_REQUIRED_FILES,
  POSTGRES_TEMPLATE_ELIGIBLE_FILES,
} from "../scripts/postgres-template-eligibility.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = __dirname;

/**
 * A file is Postgres-profile-relevant when it either clones/bootstraps its
 * own scratch database via the shared helper, or drives
 * `initPostgresStorage` directly against the per-file `PDPP_TEST_POSTGRES_URL`
 * database `run-tests.ts` allocates -- the two surfaces the reviewer HOLD
 * named ("all shared PostgreSQL helper callers" plus the per-file database
 * templating in `allocateTestDb`).
 */
function isPostgresProfileRelevant(source: string): boolean {
  return source.includes("withTemporaryPostgresDatabase") || source.includes("initPostgresStorage");
}

async function discoverTopLevelTestFiles(): Promise<string[]> {
  const entries = await readdir(testDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

test("every Postgres-profile-relevant test file is classified as exactly one of eligible or cold-required", async () => {
  const eligible = new Set(POSTGRES_TEMPLATE_ELIGIBLE_FILES);
  const coldRequired = new Set(POSTGRES_TEMPLATE_COLD_REQUIRED_FILES);

  const inBoth = [...eligible].filter((path) => coldRequired.has(path));
  assert.deepEqual(inBoth, [], "no file may be both template-eligible and cold-required");

  const files = (await discoverTopLevelTestFiles()).filter(
    // This inventory test's own file mentions both helper names in prose
    // above and would otherwise flag itself.
    (relativePath) => relativePath !== "test/postgres-template-eligibility-inventory.test.ts"
  );
  const sources = await Promise.all(
    files.map((relativePath) => readFile(join(testDir, relativePath.slice("test/".length)), "utf8"))
  );
  const unclassified = files.filter((relativePath, index) => {
    const source = sources[index];
    return (
      source !== undefined &&
      isPostgresProfileRelevant(source) &&
      !(eligible.has(relativePath) || coldRequired.has(relativePath))
    );
  });
  assert.deepEqual(
    unclassified,
    [],
    `Postgres-profile-relevant test file(s) not classified as template-eligible or cold-required: ${unclassified.join(", ")}. Triage each into scripts/postgres-template-eligibility.ts before this can pass.`
  );
});

test("every listed file still exists and is still Postgres-profile-relevant (lists do not drift stale)", async () => {
  const listedPaths = [...POSTGRES_TEMPLATE_ELIGIBLE_FILES, ...POSTGRES_TEMPLATE_COLD_REQUIRED_FILES];
  for (const relativePath of listedPaths) {
    assert.ok(
      relativePath.startsWith("test/") && relativePath.endsWith(".test.ts"),
      `malformed entry: ${relativePath}`
    );
  }
  const sources = await Promise.all(
    listedPaths.map((relativePath) => readFile(join(testDir, relativePath.slice("test/".length)), "utf8"))
  );
  listedPaths.forEach((relativePath, index) => {
    assert.ok(
      isPostgresProfileRelevant(sources[index] ?? ""),
      `${relativePath} is listed in the Postgres template eligibility registry but no longer calls withTemporaryPostgresDatabase or initPostgresStorage -- remove it from the registry`
    );
  });
});

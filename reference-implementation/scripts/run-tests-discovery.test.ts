// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSelectedTestFiles, discoverTestFiles, riRelativeFromAuthorityPath } from "./run-tests-discovery.ts";

const OUTSIDE_RI_PATTERN = /outside reference-implementation/;
const MISSING_FILE_PATTERN = /is missing/;
const ESCAPES_REPOSITORY_PATTERN = /repository-relative|escapes repository/;

async function makeRiFixture(): Promise<{ repoRoot: string; testDir: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "ri-discovery-"));
  const testDir = join(repoRoot, "test");
  await mkdir(testDir, { recursive: true });
  await writeFile(join(testDir, "top-level.test.ts"), "");
  const seamSpike = join(testDir, "seam-spike");
  await mkdir(seamSpike, { recursive: true });
  await writeFile(join(seamSpike, "nested.test.ts"), "");
  const scriptsDir = join(repoRoot, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(join(scriptsDir, "helper.test.ts"), "");
  return { cleanup: () => rm(repoRoot, { force: true, recursive: true }), repoRoot, testDir };
}

test("standalone discovery finds nested test/seam-spike files alongside top-level and colocated tests", async () => {
  const fixture = await makeRiFixture();
  try {
    const files = await discoverTestFiles(fixture.repoRoot, fixture.testDir);
    assert.deepEqual(files, ["scripts/helper.test.ts", "test/seam-spike/nested.test.ts", "test/top-level.test.ts"]);
  } finally {
    await fixture.cleanup();
  }
});

test("authority-driven selection uses the issued files directly instead of re-discovering", async () => {
  const fixture = await makeRiFixture();
  try {
    // An authority that omits the top-level file and only names the nested
    // seam-spike file: proves selection is driven by the authority, not
    // independently re-derived (which would also return top-level.test.ts).
    const files = await discoverSelectedTestFiles(fixture.repoRoot, fixture.testDir, [
      "reference-implementation/test/seam-spike/nested.test.ts",
    ]);
    assert.deepEqual(files, ["test/seam-spike/nested.test.ts"]);
  } finally {
    await fixture.cleanup();
  }
});

test("an authority file outside reference-implementation is rejected fail-closed", () => {
  assert.throws(
    () => riRelativeFromAuthorityPath("/repo/reference-implementation", "packages/cli/test/escape.test.ts"),
    OUTSIDE_RI_PATTERN
  );
});

test("an authority file that does not exist on disk is rejected fail-closed", async () => {
  const fixture = await makeRiFixture();
  try {
    assert.throws(
      () => riRelativeFromAuthorityPath(fixture.repoRoot, "reference-implementation/test/does-not-exist.test.ts"),
      MISSING_FILE_PATTERN
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an authority path attempting to escape the RI tree via .. is rejected fail-closed", async () => {
  const fixture = await makeRiFixture();
  try {
    assert.throws(
      () => riRelativeFromAuthorityPath(fixture.repoRoot, "reference-implementation/../outside.test.ts"),
      ESCAPES_REPOSITORY_PATTERN
    );
  } finally {
    await fixture.cleanup();
  }
});

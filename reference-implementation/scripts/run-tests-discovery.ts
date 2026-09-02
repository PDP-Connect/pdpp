// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { compareStrings, containedPath } from "../../scripts/test-accounting/inventory.ts";

export const NODE_TEST_EXTENSIONS = [".test.js", ".test.mjs", ".test.ts"];

// Co-located unit tests for focused server modules and operator scripts. The
// discovery is intentionally narrow by directory, but extension-complete for the
// Node loader used by the supported RI CI lines, including erasable TypeScript.
//
// This list is the standalone (no accounting authority) discovery fallback
// only. It is a second, hand-maintained mirror of test-accounting.manifest.json's
// `include` globs for the `ri-default` suite and can silently drift from it --
// as happened for test/seam-spike/*.test.ts, present in the manifest but absent
// here until this directory entry was added. When an authority is available,
// discoverSelectedTestFiles() below uses it directly instead of this list.
export const COLOCATED_TEST_DIRS = [
  { dir: "runtime", extensions: NODE_TEST_EXTENSIONS },
  { dir: join("test", "seam-spike"), extensions: NODE_TEST_EXTENSIONS },
  { dir: join("server", "streaming"), extensions: NODE_TEST_EXTENSIONS },
  { dir: "scripts", extensions: NODE_TEST_EXTENSIONS },
];

/** Independent directory-walk discovery used only for standalone (no-authority) runs. */
export async function discoverTestFiles(repoRoot: string, testDir: string): Promise<string[]> {
  const entries = await readdir(testDir, { withFileTypes: true });
  const isNodeTest = (name: string) => NODE_TEST_EXTENSIONS.some((extension) => name.endsWith(extension));
  const topLevelTests = entries
    .filter((entry) => entry.isFile() && isNodeTest(entry.name))
    .map((entry) => join("test", entry.name));

  const colocatedTests: string[] = [];
  for (const { dir: relDir, extensions } of COLOCATED_TEST_DIRS) {
    const absDir = join(repoRoot, relDir);
    let dirEntries: Dirent[];
    try {
      // biome-ignore lint/performance/noAwaitInLoops: COLOCATED_TEST_DIRS is a fixed small static list read once at startup; sequential try/catch-per-dir scopes a missing directory's error to that entry alone.
      dirEntries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        colocatedTests.push(join(relDir, entry.name));
      }
    }
  }

  return [...topLevelTests, ...colocatedTests].sort();
}

// The test-accounting authority (test-accounting.manifest.json's `include`
// globs, evaluated against the tracked repository) is the single source of
// truth for which RI files belong to this suite. When an authority is
// supplied, it drives selection directly instead of this runner maintaining
// its own second, independently-hand-maintained discovery list that can
// silently drift from the manifest. Each authority-issued path is still
// validated to resolve inside the RI tree and exist on disk, so a corrupted
// or malicious authority file cannot smuggle in an arbitrary path.
export function riRelativeFromAuthorityPath(repoRoot: string, path: string): string {
  const prefix = "reference-implementation/";
  if (!path.startsWith(prefix)) {
    throw new Error(`authority file is outside reference-implementation: ${path}`);
  }
  const relative = path.slice(prefix.length);
  containedPath(repoRoot, relative, { existing: true, label: "authority file" });
  return relative;
}

/**
 * Resolve the RI child-selection file list. Uses the authority's issued
 * files directly when present (the single canonical selection); otherwise
 * falls back to the standalone directory-walk discovery.
 */
export async function discoverSelectedTestFiles(
  repoRoot: string,
  testDir: string,
  authorityFiles: readonly string[] | undefined
): Promise<string[]> {
  if (authorityFiles) {
    return [...authorityFiles].map((path) => riRelativeFromAuthorityPath(repoRoot, path)).sort(compareStrings);
  }
  return await discoverTestFiles(repoRoot, testDir);
}

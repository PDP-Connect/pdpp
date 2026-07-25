// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import path from "node:path";

export const TEST_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"]);
const RUNNABLE_TEST_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts"]);
const testFilePattern = new RegExp(`\\.test(?:${[...TEST_EXTENSIONS].sort().join("|")})$`);

export async function discoverTestFiles(packageRoot: string): Promise<string[]> {
  const testRoot = path.join(packageRoot, "test");
  const entries = await readdir(testRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && testFilePattern.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

export function assertRunnableTestFiles(testFiles: string[]): void {
  const unsupported = testFiles.filter((file) => !RUNNABLE_TEST_EXTENSIONS.has(path.extname(file)));
  if (unsupported.length > 0) {
    throw new Error(
      `Discovered tests without a configured runtime: ${unsupported.join(", ")}. Add a runner before migrating tests.`
    );
  }
}

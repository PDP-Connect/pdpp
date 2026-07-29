// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const TEST_FILE = /\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;
const TYPESCRIPT_TEST = /\.test\.(?:ts|mts|cts)$/;

export async function discoverTestFiles(testRoot: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        dirs.push(path);
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        files.push(path);
      }
    }
    // Use Promise.all to avoid await in loops
    await Promise.all(dirs.map((dir) => visit(dir)));
  }

  await visit(resolve(testRoot));
  return files.sort((a, b) => a.localeCompare(b));
}

export function needsTsx(testFiles: string[]): boolean {
  return testFiles.some((file) => TYPESCRIPT_TEST.test(file));
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const TEST_FILE = /\.test\.(?:js|mjs|cjs|ts|mts|cts)$/;

export async function discoverTestFiles(testRoot) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        files.push(path);
      }
    }
  }

  await visit(resolve(testRoot));
  return files.sort();
}

export function needsTsx(testFiles) {
  return testFiles.some((file) => /\.test\.(?:ts|mts|cts)$/.test(file));
}

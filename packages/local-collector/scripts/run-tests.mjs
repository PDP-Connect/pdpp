// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(packageRoot, "test");
const testFilePattern = /\.test\.(?:[cm]?[jt]s)$/;

async function discoverTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return discoverTests(full);
      }
      return testFilePattern.test(entry.name) ? [full] : [];
    })
  );
  return files.flat();
}

const tests = (await discoverTests(testRoot)).sort();
if (tests.length === 0) {
  throw new Error(`No test files matched ${testFilePattern} under ${testRoot}`);
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--test", "--import", "tsx", ...tests], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`Test runner exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`));
  });
});

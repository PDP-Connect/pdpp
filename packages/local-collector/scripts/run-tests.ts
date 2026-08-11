// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(packageRoot, "test");
const testFilePattern = /\.test\.(?:[cm]?[jt]s)$/;

async function discoverTests(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    // biome-ignore lint/suspicious/useAwait: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
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

// biome-ignore lint/suspicious/useArraySortCompare: Input ordering is intentionally the runtime’s established default string order.
const tests = (await discoverTests(testRoot)).sort();
if (tests.length === 0) {
  throw new Error(`No test files matched ${testFilePattern} under ${testRoot}`);
}

await new Promise<void>((resolve, reject) => {
  const concurrencyArgs = process.env.CI ? [] : ["--test-concurrency=2"];
  const child = spawn(process.execPath, ["--test", ...concurrencyArgs, "--import", "tsx", ...tests], {
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

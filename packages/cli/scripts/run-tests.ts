// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverTestFiles, needsTsx } from "./discover-tests.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = await discoverTestFiles(resolve(packageRoot, "test"));

if (testFiles.length === 0) {
  throw new Error("No CLI test files were discovered. Refusing to run an empty test selection.");
}

const args: string[] = ["--test"];
if (!process.env.CI) {
  args.push("--test-concurrency=2");
}
if (needsTsx(testFiles)) {
  args.push("--import", "tsx");
}
args.push(...testFiles);

const result = spawnSync(process.execPath, args, {
  cwd: packageRoot,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;

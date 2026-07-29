// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { assertRunnableTestFiles, discoverTestFiles } from "./discover-tests.ts";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = await discoverTestFiles(packageRoot);

if (testFiles.length === 0) {
  throw new Error("No test files were discovered under test/.");
}

assertRunnableTestFiles(testFiles);
const relativeFiles = testFiles.map((file) => path.relative(packageRoot, file));
process.stdout.write(`Discovered ${relativeFiles.length} test file(s): ${relativeFiles.join(", ")}\n`);
const { stderr, stdout } = await execFileAsync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...relativeFiles],
  { cwd: packageRoot }
);
process.stdout.write(stdout);
process.stderr.write(stderr);

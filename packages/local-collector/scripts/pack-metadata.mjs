// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Get npm's candidate-package metadata without mixing lifecycle output into
 * stdout. npm 10 still runs `prepare` during `npm pack` even when passed the
 * later `--ignore-scripts` option. Keeping lifecycle scripts in the background
 * is supported by npm 10 and 11, while `--json` reserves stdout for metadata.
 */
export async function npmPackMetadata({ cwd, dryRun = false, execute = execFileAsync }) {
  const args = ["pack", "--json", "--foreground-scripts=false"];
  if (dryRun) {
    args.push("--dry-run");
  }

  let result;
  try {
    result = await execute("npm", args, { cwd, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw withCommandOutput(error, "npm", args);
  }

  const metadata = JSON.parse(result.stdout);
  assert.ok(Array.isArray(metadata) && metadata.length === 1, "npm pack must return exactly one metadata record");
  return metadata[0];
}

function withCommandOutput(error, command, args) {
  if (!(error instanceof Error)) {
    return error;
  }
  const output = [
    ["stdout", error.stdout],
    ["stderr", error.stderr],
  ]
    .filter(([, value]) => value)
    .map(([stream, value]) => `\n${stream}:\n${value}`)
    .join("");
  error.message += `\nCommand failed: ${command} ${args.join(" ")}${output}`;
  return error;
}

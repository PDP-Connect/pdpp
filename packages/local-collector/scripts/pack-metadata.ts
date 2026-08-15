// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PackMetadataOptions {
  cwd: string;
  dryRun?: boolean;
  execute?: typeof execFileAsync;
}

interface PackMetadata {
  filename: string;
  files: Array<{ path: string }>;
  [key: string]: unknown;
}

/**
 * Get npm's candidate-package metadata without mixing lifecycle output into
 * stdout. npm 10 still runs `prepare` during `npm pack` even when passed the
 * later `--ignore-scripts` option. Keeping lifecycle scripts in the background
 * is supported by npm 10 and 11, while `--json` reserves stdout for metadata.
 */
export async function npmPackMetadata({
  cwd,
  dryRun = false,
  execute = execFileAsync,
}: PackMetadataOptions): Promise<PackMetadata> {
  const args = ["pack", "--json", "--foreground-scripts=false"];
  if (dryRun) {
    args.push("--dry-run");
  }

  let result: { stdout: string };
  try {
    result = await execute("npm", args, { cwd, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw withCommandOutput(error, "npm", args);
  }

  const parsed = JSON.parse(result.stdout);
  // npm's `pack --json` output shape changed across major versions: older
  // npm (≤11) emits a top-level array of one record; npm 12 emits an object
  // keyed by package name instead. Accept either so this script isn't pinned
  // to one npm major.
  const records = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
  assert.ok(records.length === 1, "npm pack must return exactly one metadata record");
  return records[0] as PackMetadata;
}

function withCommandOutput(error: unknown, command: string, args: string[]): Error {
  if (!(error instanceof Error)) {
    return error as Error;
  }
  const { stdout, stderr } = error as { stdout?: string; stderr?: string };
  const output = [
    ["stdout", stdout],
    ["stderr", stderr],
  ]
    .filter(([, value]) => value)
    .map(([stream, value]) => `\n${stream}:\n${value}`)
    .join("");
  error.message += `\nCommand failed: ${command} ${args.join(" ")}${output}`;
  return error;
}

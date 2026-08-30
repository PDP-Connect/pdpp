#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pnpm test:related <base-ref>` — runs `node --test` against the related
 * selection for local iteration only. See cli.ts's module comment for the
 * fail-closed contract and why this is not a merge gate.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = join(PACKAGE_ROOT, "scripts", "related-tests", "cli.ts");

const FULL_SUITE_GLOBS = ["bin/**/*.test.ts", "connectors/**/*.test.ts", "src/**/*.test.ts"];

function main(): void {
  const [baseRef] = process.argv.slice(2);
  if (!baseRef) {
    console.error("usage: pnpm test:related <base-ref>");
    process.exit(1);
  }

  const selectionOutput = execFileSync("node", ["--import", "tsx", CLI_PATH, baseRef, "--json"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  const selection = JSON.parse(selectionOutput) as { kind: string; testFiles?: string[]; reason: string };

  const targets = selection.kind === "FULL_SUITE" ? FULL_SUITE_GLOBS : (selection.testFiles ?? []);

  console.error(`[test:related] ${selection.reason}`);
  if (targets.length === 0) {
    console.error("[test:related] no related test files; nothing to run.");
    return;
  }

  execFileSync("node", ["--test", "--import", "tsx", "--test-concurrency=2", "--test-timeout=120000", ...targets], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
  });
}

main();

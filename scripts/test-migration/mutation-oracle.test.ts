// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * This test runs THE ACTUAL mutation-oracle.ts script (not a reimplementation
 * of its logic) and asserts every mutation is caught, the positive control
 * is clean, and rollback is proven — so this deliverable stays gated in
 * `pnpm test-accounting:check`/CI, not just something that was true once
 * when a human ran it by hand.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MUTATION_ORACLE_SCRIPT = fileURLToPath(new URL("./mutation-oracle.ts", import.meta.url));
const TSX_LOADER_ARGS = ["--import", "tsx", MUTATION_ORACLE_SCRIPT];
const SUMMARY_LINE_PATTERN =
  /^Summary: positive control (\w+(?: \w+)?), (\d+)\/(\d+) mutations caught, rollback (\w+)\.$/m;

test("mutation-oracle.ts: every named mutation is caught, positive control is clean, rollback is proven", () => {
  let stdout: string;
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, TSX_LOADER_ARGS, { encoding: "utf8" });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    exitCode = err.status ?? 1;
    stdout = err.stdout ?? "";
  }
  const summaryMatch = SUMMARY_LINE_PATTERN.exec(stdout);
  assert.ok(summaryMatch, `expected a Summary line in mutation-oracle output, got:\n${stdout}`);
  const [, positiveControlStatus, caughtCount, totalCount, rollbackStatus] = summaryMatch as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  assert.equal(positiveControlStatus, "clean", "positive control must report clean (no false positive)");
  assert.equal(
    caughtCount,
    totalCount,
    "every named mutation must be caught — a HOLE must fail this test, not be silently accepted"
  );
  assert.equal(rollbackStatus, "proven", "rollback must be proven byte-identical");
  assert.equal(exitCode, 0, "the script's own exit code must be 0 when everything is caught and rollback holds");
});

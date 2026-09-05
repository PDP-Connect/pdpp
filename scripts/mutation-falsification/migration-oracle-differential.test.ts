// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the existing scripts/test-migration/mutation-oracle.ts TWICE — once
 * legacy, once with --structured — and asserts every named case, catching
 * check, hole, positive-control result, and rollback result are IDENTICAL
 * between the two modes (tasks.md 1.3). This is the proof that adding
 * structured output changed nothing about the oracle's own mutation
 * scenarios, judges, or decisions — only that the same computed results are
 * ALSO serialized as JSON when requested.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { StructuredOracleReport } from "../test-migration/mutation-oracle.ts";

const MUTATION_ORACLE_SCRIPT = fileURLToPath(new URL("../test-migration/mutation-oracle.ts", import.meta.url));
const STRUCTURED_LINE_PREFIX = "MUTATION_ORACLE_STRUCTURED_JSON ";

function runOracle(args: string[]): { exitCode: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", MUTATION_ORACLE_SCRIPT, ...args], {
      encoding: "utf8",
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
  }
}

function extractStructuredReport(stdout: string): StructuredOracleReport {
  const line = stdout.split("\n").find((entry) => entry.startsWith(STRUCTURED_LINE_PREFIX));
  assert.ok(line, `expected a ${STRUCTURED_LINE_PREFIX}line in structured-mode stdout, got:\n${stdout}`);
  return JSON.parse(line.slice(STRUCTURED_LINE_PREFIX.length)) as StructuredOracleReport;
}

function humanReportWithoutStructuredLine(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !line.startsWith(STRUCTURED_LINE_PREFIX))
    .join("\n");
}

test("legacy and structured modes produce byte-identical human-readable output (structured mode is strictly additive)", () => {
  const legacy = runOracle([]);
  const structured = runOracle(["--structured"]);
  assert.equal(humanReportWithoutStructuredLine(structured.stdout), legacy.stdout);
  assert.equal(legacy.exitCode, 0);
  assert.equal(structured.exitCode, 0);
});

test("structured mode reports every named mutation case with the same caught/caughtBy/detail as the human report claims", () => {
  const legacy = runOracle([]);
  const structured = runOracle(["--structured"]);
  const report = extractStructuredReport(structured.stdout);

  const summaryMatch = /^Summary: positive control (\w+(?: \w+)?), (\d+)\/(\d+) mutations caught, rollback (\w+)\.$/m.exec(
    legacy.stdout
  );
  assert.ok(summaryMatch, "expected a Summary line in the legacy human report");
  const [, positiveControlStatus, caughtCount, totalCount, rollbackStatus] = summaryMatch as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];

  assert.equal(report.positiveControl.ok, positiveControlStatus === "clean");
  assert.equal(report.mutations.length, Number(totalCount));
  assert.equal(report.mutations.filter((m) => m.caught).length, Number(caughtCount));
  assert.equal(report.rollback.ok, rollbackStatus === "proven");
  assert.equal(report.holes.length, Number(totalCount) - Number(caughtCount));
  assert.equal(report.ok, report.positiveControl.ok && report.holes.length === 0 && report.rollback.ok);

  // Every named case's CAUGHT/HOLE line and "checked by" in the legacy
  // report must correspond exactly to structured mode's entry.
  for (const mutation of report.mutations) {
    const caughtLabel = mutation.caught ? "CAUGHT" : "\\*\\*HOLE — NOT CAUGHT\\*\\*";
    const escapedName = mutation.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const casePattern = new RegExp(`\\[${caughtLabel}\\] ${escapedName}\\n  checked by: ${mutation.caughtBy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`);
    assert.ok(casePattern.test(legacy.stdout), `expected legacy report to contain a matching case line for "${mutation.name}"`);
  }
});

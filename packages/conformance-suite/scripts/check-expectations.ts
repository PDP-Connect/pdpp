// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Compare one run against the committed expectations for that target: every
// case's outcome (report.json) and every MUST clause's rolled-up result
// (requirements.json).
//
// Why exact equality rather than "no failures": the reference implementation
// has known failures (each one a tracked defect), and many of its cases skip.
// "Exit 1 means red" cannot tell a new regression from a known defect, and
// "no new failures" would let a pass silently decay into a skip. Requiring the
// whole map to match makes every change visible in review: a fix turns `fail`
// into `pass` and the PR updates the expectation in the same diff; a regression
// turns `pass` into anything else and the job goes red. Cases are compared as
// well as clauses because some regression cases test statements the spec makes
// without an RFC 2119 keyword, which no clause carries.
//
// Usage:
//   tsx scripts/check-expectations.ts <run-dir> <expected.json>
//   tsx scripts/check-expectations.ts <run-dir> <expected.json> --update
// where <run-dir> holds the report.json and requirements.json of one run.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface RequirementsReport {
  readonly header: { readonly specSha256: string; readonly targetId: string };
  readonly must: readonly { readonly clauseId: string; readonly result: string }[];
}

interface ConformanceReport {
  readonly requirements: readonly {
    readonly cases: readonly { readonly caseId: string; readonly outcome: string }[];
  }[];
}

interface Expectations {
  readonly cases: Record<string, string>;
  readonly comment: string;
  readonly must: Record<string, string>;
  readonly specSha256?: string;
  readonly target: string;
}

const byKey = ([a]: [string, string], [b]: [string, string]): number => a.localeCompare(b, "en");
const sortedRecord = (entries: [string, string][]): Record<string, string> => Object.fromEntries(entries.sort(byKey));

const [runDir, expectedPath, flag] = process.argv.slice(2);
if (!(runDir && expectedPath) || (flag !== undefined && flag !== "--update")) {
  console.error("usage: check-expectations.ts <run-dir> <expected.json> [--update]");
  process.exit(2);
}

const requirements = JSON.parse(readFileSync(join(runDir, "requirements.json"), "utf8")) as RequirementsReport;
const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as ConformanceReport;
const actual: Omit<Expectations, "comment" | "specSha256" | "target"> = {
  cases: sortedRecord(
    report.requirements.flatMap((requirement) => requirement.cases.map((c): [string, string] => [c.caseId, c.outcome]))
  ),
  must: sortedRecord(requirements.must.map((clause): [string, string] => [clause.clauseId, clause.result])),
};

if (flag === "--update") {
  const expectations: Expectations = {
    comment:
      "Case outcomes and MUST clause results expected from this target at its pinned commit. Regenerate with scripts/check-expectations.ts --update and review the diff: every changed line is a behaviour change.",
    target: requirements.header.targetId,
    specSha256: requirements.header.specSha256,
    ...actual,
  };
  writeFileSync(expectedPath, `${JSON.stringify(expectations, null, 2)}\n`);
  console.log(
    `wrote ${Object.keys(actual.cases).length} case and ${Object.keys(actual.must).length} clause expectations to ${expectedPath}`
  );
  process.exit(0);
}

const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Expectations;
const differences: string[] = [];
// Identity before outcomes: a report for another target or another spec text
// can have identical outcome maps and still say nothing about this target.
if (expected.target !== requirements.header.targetId) {
  differences.push(`target: expected ${expected.target}, got ${requirements.header.targetId}`);
}
if (expected.specSha256 !== requirements.header.specSha256) {
  differences.push(`specSha256: expected ${expected.specSha256 ?? "(absent)"}, got ${requirements.header.specSha256}`);
}
for (const kind of ["cases", "must"] as const) {
  const want = expected[kind];
  const got = actual[kind];
  for (const id of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (want[id] !== got[id]) {
      differences.push(`${kind} ${id}: expected ${want[id] ?? "(absent)"}, got ${got[id] ?? "(absent)"}`);
    }
  }
}

if (differences.length > 0) {
  console.error(`${differences.length} result(s) differ from ${expectedPath}:`);
  for (const line of differences.sort((a, b) => a.localeCompare(b, "en"))) {
    console.error(`  ${line}`);
  }
  console.error("If the change is intended, rerun with --update and commit the new expectations.");
  process.exit(1);
}
console.log(
  `all ${Object.keys(actual.cases).length} case and ${Object.keys(actual.must).length} clause results match ${expectedPath}`
);

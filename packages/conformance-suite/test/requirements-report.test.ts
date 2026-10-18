// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The clause roll-up and the per-requirement report.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildRequirementsReport,
  type ClauseCaseOutcome,
  type ClauseResult,
  readSpecText,
  rollUpClauseResult,
} from "../src/report/requirements.ts";
import { buildReport, type CaseResult, exitCodeFor } from "../src/report/result.ts";
import { CLAUSE_MATRIX, type Observable } from "../src/requirements/matrix.ts";
import { clauseFragments, normalizeSpecText } from "../src/requirements/spec-scan.ts";
import { ALL_CASES, SUITE } from "../src/suite.ts";

const SYNTHETIC_FAILURE = /synthetic failure/;
const roll = (
  caseOutcomes: readonly ClauseCaseOutcome[],
  observable: Observable = "black-box-http",
  gapNote?: string,
  partial = false
) => rollUpClauseResult({ caseOutcomes, observable, ...(gapNote ? { gapNote } : {}), ...(partial ? { partial } : {}) });

test("roll-up: a failing case fails the clause, even when others pass or the clause is review-only", () => {
  assert.equal(roll(["pass", "fail"]).result, "fail");
  assert.equal(roll(["fail", "skip", "unsupported"]).result, "fail");
  assert.equal(roll(["fail"], "review-only").result, "fail");
});

test("roll-up: all passing, including advisory, is a pass", () => {
  assert.equal(roll(["pass"]).result, "pass");
  assert.equal(roll(["pass", "advisory"]).result, "pass");
  assert.equal(roll(["advisory"]).result, "pass");
});

test("roll-up: a partial clause never reaches pass, but can still fail", () => {
  assert.deepEqual(roll(["pass"], "black-box-http", "the expiry half is untested", true), {
    result: "partial",
    reason: "the expiry half is untested",
  });
  assert.equal(roll(["pass", "advisory"], "black-box-http", undefined, true).result, "partial");
  assert.equal(roll(["pass", "skip"], "black-box-http", "gap", true).result, "skip");
  assert.equal(roll(["pass", "fail"], "black-box-http", "gap", true).result, "fail");
  assert.equal(roll(["unsupported"], "black-box-http", "gap", true).result, "not-applicable");
});

test("roll-up: review-only without a failure is untestable and carries its gap note", () => {
  assert.deepEqual(roll([], "review-only", "internal ordering"), { result: "untestable", reason: "internal ordering" });
  assert.equal(roll(["pass"], "review-only").result, "untestable");
});

test("roll-up: no case is not-tested and carries its gap note", () => {
  assert.deepEqual(roll([], "black-box-http", "needs a blob fixture"), {
    result: "not-tested",
    reason: "needs a blob fixture",
  });
  assert.equal(roll([], "client-capture").result, "not-tested");
});

test("roll-up: only unsupported or not-run cases is not-applicable", () => {
  assert.equal(roll(["unsupported"]).result, "not-applicable");
  assert.equal(roll(["unsupported", "not-run"]).result, "not-applicable");
  assert.equal(roll(["not-run"]).result, "not-applicable");
});

test("roll-up: a case that could not run never reads as a pass", () => {
  assert.equal(roll(["pass", "skip"]).result, "skip");
  assert.equal(roll(["skip"]).result, "skip");
  assert.equal(roll(["pass", "not-tested"]).result, "skip");
});

test("roll-up: unsupported beside evidence is ignored", () => {
  assert.equal(roll(["pass", "unsupported"]).result, "pass");
  assert.equal(roll(["pass", "not-run"]).result, "pass");
});

const SPEC = readSpecText();
const target = {
  id: "synthetic",
  version: "1",
  baseUrl: "http://localhost",
  roles: ["authorization-server", "resource-server", "client"] as const,
};
const run = { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", reproducible: false };

function reportWith(outcomeOf: (caseId: string) => CaseResult["outcome"]) {
  const cases: CaseResult[] = ALL_CASES.map((c) => ({
    caseId: c.caseId,
    requirementId: c.requirementId,
    outcome: outcomeOf(c.caseId),
    assertion: c.assertion,
    ...(outcomeOf(c.caseId) === "fail" ? { detail: "synthetic failure" } : {}),
  }));
  return buildReport({ suite: SUITE, target: { ...target, roles: [...target.roles] }, run, cases });
}

test("headline: every case passing still exits 2 while a MUST clause is partial, skipped or untested", () => {
  const report = reportWith(() => "pass");
  // Every Section 9 requirement that has a case passes...
  assert.ok(report.requirements.every((r) => r.outcome === "pass" || r.outcome === "not-tested"));
  // ...yet clause-level evidence is incomplete, so the headline must not claim completion.
  const incomplete = report.summary.incompleteMustClauses.map((c) => c.clauseId);
  assert.ok(incomplete.includes("8.12-2"), "8.12-2 is acknowledged-partial and must block completion");
  assert.equal(report.summary.allApplicableMustsTestedAndPassed, false);
  assert.equal(exitCodeFor(report), 2);
});

test("headline: a failing requirement exits 1 regardless of clause completion", () => {
  const report = reportWith((id) => (id === "RS-1/get-blob-bytes" ? "fail" : "pass"));
  assert.equal(exitCodeFor(report), 1);
});

test("headline: 'has a case' and 'rolls up to pass' are separate numbers", () => {
  const report = reportWith(() => "pass");
  const { mustWithCase, mustClausesPassed, mustTotal } = report.clauseCoverage;
  assert.ok(mustClausesPassed < mustWithCase, "partial clauses have a case but do not pass");
  assert.ok(mustWithCase < mustTotal);
});

test("the requirements report has one entry per MUST clause and one per SHOULD clause", () => {
  const out = buildRequirementsReport(
    reportWith(() => "pass"),
    SPEC
  );
  assert.deepEqual(
    out.must.map((e) => e.clauseId),
    CLAUSE_MATRIX.filter((c) => c.level === "must").map((c) => c.clauseId)
  );
  assert.deepEqual(
    out.should.map((e) => e.clauseId),
    CLAUSE_MATRIX.filter((c) => c.level === "should").map((c) => c.clauseId)
  );
  assert.ok(out.must.every((e) => e.level === "must") && out.should.every((e) => e.level === "should"));
  const total = (counts: Record<ClauseResult, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total(out.summary.must), out.must.length);
  assert.equal(total(out.summary.should), out.should.length);
});

test("every entry's specLine is the line its clause text starts on", () => {
  const lines = SPEC.split("\n");
  for (const e of buildRequirementsReport(
    reportWith(() => "pass"),
    SPEC
  ).must) {
    const first = clauseFragments(e.text)[0] ?? "";
    const window = normalizeSpecText(lines.slice(e.specLine - 1, e.specLine + 7).join(" "));
    assert.ok(window.includes(first), `${e.clauseId} is not at spec-core.md line ${e.specLine}`);
  }
});

test("the header names the spec file, its SHA-256, the suite version, the target and the run time", () => {
  const out = buildRequirementsReport(
    reportWith(() => "pass"),
    SPEC
  );
  assert.equal(out.header.specFile, "spec-core.md");
  assert.equal(out.header.specSha256, createHash("sha256").update(SPEC).digest("hex"));
  assert.equal(out.header.suiteVersion, SUITE.version);
  assert.equal(out.header.targetId, "synthetic");
  assert.equal(out.header.runAt, run.startedAt);
});

test("a failing case surfaces as a failing clause with the case detail", () => {
  const out = buildRequirementsReport(
    reportWith((id) => (id === "RS-7/expired-sync-cursor-reported-as-gone" ? "fail" : "pass")),
    SPEC
  );
  const clause = out.must.find((e) => e.clauseId === "4.3-2");
  assert.equal(clause?.result, "fail");
  assert.match(clause?.reason ?? "", SYNTHETIC_FAILURE);
  assert.equal(out.summary.must.fail, out.must.filter((e) => e.result === "fail").length);
});

test("an uncovered, observable clause is not-tested and a review-only clause is untestable", () => {
  const out = buildRequirementsReport(
    reportWith(() => "pass"),
    SPEC
  );
  const byId = new Map(out.must.map((e) => [e.clauseId, e]));
  assert.equal(byId.get("12.4-3")?.result, "not-tested");
  assert.equal(byId.get("12.4-1")?.result, "untestable");
  assert.ok(byId.get("12.4-1")?.reason);
});

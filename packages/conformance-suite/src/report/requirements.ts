// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The per-requirement machine-readable result.
//
// `ConformanceReport` answers "how did each Section 9 item fare". This answers
// the finer question a third party audits: for each normative CLAUSE of
// spec-core.md, what is the evidence. One entry per v0.1 MUST clause, with the
// SHOULD clauses listed separately under their own label so a recommendation
// never lands in a MUST count.
//
// The roll-up from case outcomes to a clause result is `rollUpClauseResult`,
// a pure function. It is deliberately small: the rule a reader needs to
// trust a `pass` is one they can read in a minute.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_SOURCE } from "../requirements/catalog.ts";
import { CLAUSE_MATRIX, type ClauseEntry, type ClauseRole, type Observable } from "../requirements/matrix.ts";
import { clauseFragments, makeSpecLocator } from "../requirements/spec-scan.ts";
import type { ConformanceReport, Outcome } from "./result.ts";

export const REQUIREMENTS_REPORT_VERSION = "1";

/**
 * The result for one clause. Exactly one of:
 *
 * - `pass`: every case that ran for the clause passed (advisory counts as pass).
 * - `fail`: at least one case for the clause failed.
 * - `not-applicable`: the target declared the capability absent (every case
 *   `unsupported`), or does not claim the clause's role.
 * - `untestable`: the clause is `review-only`; black-box observation cannot reach it.
 * - `skip`: a case exists but could not be arranged in this run.
 * - `not-tested`: no case exists in this suite version.
 */
export type ClauseResult = "pass" | "partial" | "fail" | "not-applicable" | "untestable" | "skip" | "not-tested";

/** A case outcome as it appears under a clause; `not-run` marks a case whose role the target does not claim. */
export type ClauseCaseOutcome = Outcome | "not-run";

export interface ClauseCaseEntry {
  readonly caseId: string;
  readonly outcome: ClauseCaseOutcome;
}

export interface RequirementEntry {
  readonly cases: readonly ClauseCaseEntry[];
  readonly clauseId: string;
  /** What the matrix says this clause's evidence does NOT establish; present even on a pass. */
  readonly gapNote?: string;
  readonly level: "must" | "should";
  /** Why the result is what it is: the gap note, or the detail of the deciding case. Absent for a plain pass. */
  readonly reason?: string;
  readonly result: ClauseResult;
  readonly role: readonly ClauseRole[];
  /** Section number of spec-core.md ("A" for Appendix A). */
  readonly section: string;
  readonly sectionNineItems: readonly string[];
  /** 1-indexed line of spec-core.md the clause text starts on. */
  readonly specLine: number;
  readonly text: string;
}

export interface RequirementsReport {
  readonly header: {
    readonly reportVersion: typeof REQUIREMENTS_REPORT_VERSION;
    readonly runAt: string;
    readonly specFile: string;
    readonly specSha256: string;
    readonly specVersion: string;
    readonly suiteVersion: string;
    readonly targetId: string;
  };
  /** MUST clauses and SHOULD clauses counted per result value, kept apart. */
  readonly summary: {
    readonly must: Readonly<Record<ClauseResult, number>>;
    readonly should: Readonly<Record<ClauseResult, number>>;
  };
  /** One entry per v0.1 MUST clause. */
  readonly must: readonly RequirementEntry[];
  /** One entry per v0.1 SHOULD clause. A SHOULD result never counts toward conformance. */
  readonly should: readonly RequirementEntry[];
}

export const CLAUSE_RESULTS: readonly ClauseResult[] = [
  "pass",
  "partial",
  "fail",
  "not-applicable",
  "untestable",
  "skip",
  "not-tested",
];

export interface ClauseRollUp {
  readonly reason?: string;
  readonly result: ClauseResult;
}

/**
 * Roll the outcomes of a clause's cases up to one clause result.
 *
 * Precedence, first match wins:
 *  1. any case `fail`                      -> `fail` (a failure is evidence even on a review-only clause)
 *  2. clause is `review-only`              -> `untestable`
 *  3. the clause names no case             -> `not-tested`
 *  4. every named case is `not-run` or `unsupported` -> `not-applicable`
 *  5. any case `skip` or `not-tested`      -> `skip` (incomplete evidence never reads as a pass)
 *  6. every case passed but the clause is `partial` -> `partial`, reason = the gap
 *     (the cases exercised only part of the clause, so a pass would overstate it;
 *     `skip` would wrongly say the run could not arrange a case)
 *  7. otherwise (pass / advisory)          -> `pass`
 *
 * `advisory` means every MUST the case checks was met and only a SHOULD was
 * not, so for a MUST clause it is a pass. `unsupported` and `not-run` are
 * absence of obligation, ignored once another case supplied evidence.
 */
export function rollUpClauseResult(input: {
  readonly caseOutcomes: readonly ClauseCaseOutcome[];
  readonly gapNote?: string;
  readonly observable: Observable;
  readonly partial?: boolean;
}): ClauseRollUp {
  const { caseOutcomes, gapNote, observable, partial } = input;
  const gap = gapNote?.trim() || undefined;
  const withReason = (result: ClauseResult, reason: string | undefined): ClauseRollUp =>
    reason ? { result, reason } : { result };

  if (caseOutcomes.includes("fail")) {
    return { result: "fail" };
  }
  if (observable === "review-only") {
    return withReason("untestable", gap);
  }
  if (caseOutcomes.length === 0) {
    return withReason("not-tested", gap);
  }
  const evidence = caseOutcomes.filter((o) => o !== "not-run" && o !== "unsupported");
  if (evidence.length === 0) {
    return { result: "not-applicable" };
  }
  if (evidence.some((o) => o === "skip" || o === "not-tested")) {
    return { result: "skip" };
  }
  if (partial) {
    return withReason("partial", gap ?? "The cases exercise only part of this clause.");
  }
  return { result: "pass" };
}

/** The roll-up for one clause given the outcomes of the cases a run produced. */
export function rollUpClause(
  clause: ClauseEntry,
  results: ReadonlyMap<string, { readonly outcome: Outcome }>
): ClauseRollUp {
  return rollUpClauseResult({
    caseOutcomes: clause.caseIds.map((caseId) => results.get(caseId)?.outcome ?? "not-run"),
    ...(clause.gapNote ? { gapNote: clause.gapNote } : {}),
    ...(clause.partial ? { partial: true } : {}),
    observable: clause.observable,
  });
}

function sectionOf(clause: ClauseEntry): string {
  return clause.clauseId.split(".")[0] ?? "";
}

const DECIDING_OUTCOMES: Partial<Record<ClauseResult, readonly Outcome[]>> = {
  fail: ["fail"],
  skip: ["skip", "not-tested"],
  "not-applicable": ["unsupported"],
};

/** The detail a case recorded for the outcome that decided the clause, prefixed by its id. */
function decidingDetail(
  result: ClauseResult,
  caseIds: readonly string[],
  results: ReadonlyMap<string, { outcome: Outcome; detail?: string }>
): string | undefined {
  const wanted = DECIDING_OUTCOMES[result];
  for (const id of caseIds) {
    const r = results.get(id);
    if (r?.detail && wanted?.includes(r.outcome)) {
      return `${id}: ${r.detail}`;
    }
  }
  return result === "not-applicable" ? "The target does not claim the role this clause binds." : undefined;
}

function entryFor(
  clause: ClauseEntry,
  locate: (fragment: string) => number | undefined,
  results: ReadonlyMap<string, { outcome: Outcome; detail?: string }>
): RequirementEntry {
  const first = clauseFragments(clause.text)[0] ?? clause.text;
  const specLine = locate(first);
  if (specLine === undefined) {
    throw new Error(`Clause ${clause.clauseId} text is not found in the spec; the matrix and spec have drifted.`);
  }
  const cases: ClauseCaseEntry[] = clause.caseIds.map((caseId) => ({
    caseId,
    outcome: results.get(caseId)?.outcome ?? "not-run",
  }));
  const rolled = rollUpClause(clause, results);
  const reason = rolled.reason ?? decidingDetail(rolled.result, clause.caseIds, results);
  return {
    clauseId: clause.clauseId,
    level: clause.level as "must" | "should",
    role: clause.role,
    section: sectionOf(clause),
    specLine,
    text: clause.text,
    sectionNineItems: clause.requirementIds,
    cases,
    result: rolled.result,
    ...(reason ? { reason } : {}),
    ...(clause.gapNote ? { gapNote: clause.gapNote } : {}),
  };
}

function countResults(entries: readonly RequirementEntry[]): Record<ClauseResult, number> {
  const counts = Object.fromEntries(CLAUSE_RESULTS.map((r) => [r, 0])) as Record<ClauseResult, number>;
  for (const e of entries) {
    counts[e.result] += 1;
  }
  return counts;
}

/** Builds the per-requirement result from a finished run and the spec text it was judged against. */
export function buildRequirementsReport(
  report: ConformanceReport,
  specText: string,
  clauses: readonly ClauseEntry[] = CLAUSE_MATRIX
): RequirementsReport {
  const locate = makeSpecLocator(specText);
  const results = new Map<string, { outcome: Outcome; detail?: string }>();
  for (const requirement of report.requirements) {
    for (const c of requirement.cases) {
      results.set(c.caseId, { outcome: c.outcome, ...(c.detail ? { detail: c.detail } : {}) });
    }
  }
  const must = clauses.filter((c) => c.level === "must").map((c) => entryFor(c, locate, results));
  const should = clauses.filter((c) => c.level === "should").map((c) => entryFor(c, locate, results));
  return {
    header: {
      reportVersion: REQUIREMENTS_REPORT_VERSION,
      specFile: SPEC_SOURCE.path,
      specSha256: createHash("sha256").update(specText).digest("hex"),
      specVersion: report.specVersion,
      suiteVersion: report.suite.version,
      targetId: report.target.id,
      runAt: report.run.startedAt,
    },
    summary: { must: countResults(must), should: countResults(should) },
    must,
    should,
  };
}

/** Reads spec-core.md from the repository this package lives in. */
export function readSpecText(): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return readFileSync(join(repoRoot, SPEC_SOURCE.path), "utf8");
}

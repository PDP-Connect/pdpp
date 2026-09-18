// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Report-honesty properties.
//
// Protected risk: a partial run that reads, or scripts, as a complete pass.
// This is the failure mode that would make the suite dangerous rather than
// merely incomplete — a published submission showing "0 failures" against 30%
// coverage, consumed by a reviewer or a CI gate as if it were conformance.
//
// The plausible defect each case catches is a real one-line regression: folding
// `unsupported` into the pass count, dropping requirements with no case from the
// denominator, or returning exit 0 whenever `failedRequirements` is empty.
//
// A cheaper test is insufficient because these are properties of the ASSEMBLED
// report and the process exit code, not of any single function: the denominator
// bug in particular only appears once the catalogue and the case list disagree.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { renderMarkdown } from "../src/report/markdown.ts";
import { buildReport } from "../src/report/result.ts";
import { REQUIREMENTS } from "../src/requirements/catalog.ts";
import { CLAUSE_MATRIX, clausesForVersion } from "../src/requirements/matrix.ts";
import { ALL_CASES, coveredRequirementIds, runSuite } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

describe("the report cannot present a partial run as complete", () => {
  it("renders review evidence separately and never treats it as test coverage", () => {
    const report = buildReport({
      suite: { name: "t", version: "0" },
      target: {
        id: "t",
        version: "0",
        baseUrl: "http://127.0.0.1:1",
        roles: ["authorization-server"],
      },
      run: { startedAt: "", finishedAt: "", reproducible: true },
      cases: [],
      reviewEvidence: [
        {
          clauseId: "6.3-1",
          claim: "Claims are visually separated.",
          evidenceFiles: [{ path: "consent.png", description: "Consent review screenshot" }],
          reviewedBy: "reviewer",
          reviewedOn: "2026-09-18",
          status: "evidenced",
        },
      ],
    });
    const markdown = renderMarkdown(report);
    assert.equal(report.reviewEvidence.length, 1);
    assert.equal(report.summary.notTestedRequirements.includes("AS-7"), true);
    assert.equal(report.coverage.find((coverage) => coverage.role === "authorization-server")?.tested, 0);
    assert.ok(markdown.includes("## Review evidence"));
    assert.ok(markdown.includes("do not create cases, change coverage, or count as tested"));
  });
  it("does not leave the newly observable client-capture MUST clauses unregistered", () => {
    // Scoped to v0.1: the count is a fact about the adopted revision's clause
    // set, and a v0.2 entry added later must not make this test fail for a
    // reason that has nothing to do with the client channel it protects.
    const clientCaptureMusts = clausesForVersion("0.1").filter(
      (clause) => clause.level === "must" && clause.observable === "client-capture"
    );
    assert.equal(clientCaptureMusts.length, 11, "Batch 19 must account for all eleven client-capture MUST clauses.");
    for (const clause of clientCaptureMusts) {
      assert.ok(clause.caseIds.length > 0, `Client-capture MUST ${clause.clauseId} has no registered case.`);
    }
  });

  it("keeps the full Section 9 catalogue as the denominator, not the executed cases", async () => {
    const report = await runSuite(new ReferenceTargetAdapter());

    // Every catalogue requirement for a scoped role appears in the report, so a
    // requirement with no case is visible as not-tested rather than absent.
    const scoped = new Set(report.target.roles);
    const expected = REQUIREMENTS.filter((r) => scoped.has(r.role)).map((r) => r.id);
    const actual = report.requirements.map((r) => r.requirement.id);
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      "The report's requirement list must be the catalogue filtered to scoped roles."
    );

    // The suite does not cover everything, and the report must say so.
    const covered = new Set(coveredRequirementIds());
    const uncovered = expected.filter((id) => !covered.has(id));
    assert.ok(uncovered.length > 0, "Fixture expectation: this suite version does not yet cover every requirement.");
    for (const id of uncovered) {
      assert.ok(
        report.summary.notTestedRequirements.includes(id),
        `Requirement ${id} has no case but is absent from notTestedRequirements.`
      );
    }
  });

  it("does not report all-musts-passed while applicable requirements are untested", async () => {
    const report = await runSuite(new ReferenceTargetAdapter());

    // The property under test is the SECOND assertion: a run with no failures
    // but incomplete coverage must not report all-musts-passed. That is the
    // honesty rule, and it is the one a regression would break.
    //
    // This case previously also asserted `failedRequirements` equalled
    // ["RS-8"], which pinned a real defect in the reference target as an
    // expectation: the fixture seeds a `mutable_state` stream and served no
    // `next_changes_since`, so RS-8 genuinely failed. The target now implements
    // `changes_since` and tombstones, so that failure is gone — and an
    // assertion that a specific requirement FAILS would have to be edited every
    // time the target is fixed, which makes it a record of current behaviour
    // rather than a check on anything.
    assert.deepEqual(
      report.summary.failedRequirements,
      [],
      "The reference target is expected to pass every requirement it is applicable for; a failure here is a real defect in it."
    );
    assert.equal(
      report.summary.allApplicableMustsTestedAndPassed,
      false,
      "Coverage is incomplete (requirements remain not-tested), so allApplicableMustsTestedAndPassed must stay false even with zero failures. This is the flag's whole point: a clean run with partial coverage is not a pass."
    );
  });

  it("never counts unsupported or not-tested requirements as passes", async () => {
    const report = await runSuite(new ReferenceTargetAdapter());
    for (const coverage of report.coverage) {
      assert.equal(
        coverage.passed + coverage.failed + coverage.skipped + coverage.unsupported + coverage.notTested,
        coverage.total,
        `Role ${coverage.role}: outcome counts must partition the requirement total.`
      );
      assert.equal(
        coverage.applicable,
        coverage.total - coverage.unsupported,
        `Role ${coverage.role}: unsupported requirements must leave the applicable denominator.`
      );
      assert.ok(coverage.tested <= coverage.applicable, `Role ${coverage.role}: tested cannot exceed applicable.`);
    }
  });

  it("confers no status and states coverage before any pass count stands alone", async () => {
    const report = await runSuite(new ReferenceTargetAdapter());
    const markdown = renderMarkdown(report);

    for (const forbidden of ["certified", "certification", "Verified Operator"]) {
      assert.ok(
        !markdown.toLowerCase().includes(forbidden.toLowerCase()),
        `The rendered report must not use the word "${forbidden}": conferring status is the technical committee's act under GOVERNANCE.md Section 5.`
      );
    }
    assert.ok(markdown.includes("Coverage (tested/applicable)"), "The report must state coverage explicitly.");
    assert.ok(
      markdown.indexOf("Coverage (tested/applicable)") < markdown.indexOf("## Failures"),
      "Coverage must appear before the failures section so a skim cannot reach a pass count first."
    );
  });

  it("has no case referencing a requirement outside the catalogue", () => {
    const known = new Set(REQUIREMENTS.map((r) => r.id));
    for (const conformanceCase of ALL_CASES) {
      assert.ok(
        known.has(conformanceCase.requirementId),
        `Case ${conformanceCase.caseId} references unknown requirement ${conformanceCase.requirementId}.`
      );
    }
  });
});

describe("the CLI exit code distinguishes a partial run from a complete pass", () => {
  it("exits 2 when nothing failed but coverage is incomplete", async () => {
    // Exit 0 here would let a CI gate treat 30% coverage as conformance, which
    // is precisely the misreading the three-valued contract exists to prevent.
    //
    // This uses an append-only-only fixture module, not `--target reference`:
    // the in-repo reference target seeds a `mutable_state` stream and does
    // not implement `changes_since`, so it now genuinely fails RS-8 (see
    // report-honesty's "does not report all-musts-passed..." case above) and
    // can no longer stand in for the "zero failures" half of this scenario.
    const cli = path.join(here, "..", "src", "cli.ts");
    const fixtureTarget = path.join(here, "fixtures", "append-only-only-target.ts");
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cli, "--target", fixtureTarget, "--quiet"],
      { env: { ...process.env, SOURCE_DATE_EPOCH: "1758153600" } }
    ).then(
      () => ({ code: 0 }),
      (error: { code?: number }) => ({ code: error.code ?? -1 })
    );
    assert.equal(result.code, 2, "A run with no failures but untested applicable requirements must exit 2, not 0.");
  });
});

describe("SHOULD-level observations are never reported as failed MUSTs", () => {
  // Protected risk: overstating a finding. Reporting an RFC "SHOULD NOT" as a
  // conformance failure tells an implementer their conforming server is
  // non-conformant — the most damaging error a conformance suite can make,
  // because the reader has no way to check the citation. A root review caught
  // exactly this: RFC 7662 Section 2.2 says an AS SHOULD NOT disclose extra
  // information about an inactive token, and Core does not raise it to a MUST,
  // but the suite was reporting it as a failed MUST.
  //
  // The oracle: an advisory case must keep its requirement out of the failed set
  // while still appearing in the summary, and must not block the all-MUSTs gate.
  it("counts an advisory case as passing its MUSTs but still surfaces it", () => {
    const report = buildReport({
      suite: { name: "t", version: "0" },
      target: {
        id: "t",
        version: "0",
        baseUrl: "http://127.0.0.1:1",
        roles: ["authorization-server"],
      },
      run: { startedAt: "", finishedAt: "", reproducible: true },
      cases: [
        {
          caseId: "AS-8/advisory-case",
          requirementId: "AS-8",
          outcome: "advisory",
          assertion: "MUST met; SHOULD-level observation recorded.",
          detail: "RFC SHOULD NOT, not strengthened by Core.",
        },
      ],
    });

    assert.ok(
      !report.summary.failedRequirements.includes("AS-8"),
      "A SHOULD-level observation must not appear as a failed MUST."
    );
    assert.ok(
      !report.summary.failedShouldRequirements.includes("AS-8"),
      "An advisory is not a failed SHOULD-level requirement either; the MUSTs passed."
    );
    assert.ok(
      report.summary.advisoryRequirements.includes("AS-8"),
      "The observation must still be visible rather than silently dropped."
    );

    const coverage = report.coverage.find((c) => c.role === "authorization-server");
    assert.equal(coverage?.failed, 0, "An advisory must not increment the failed count.");
    assert.equal(coverage?.advisory, 1, "An advisory must be counted as such.");
  });

  it("keeps an advisory visible when a sibling case on the same requirement passes", () => {
    // The roll-up for AS-8 here is `pass`, so a summary built from roll-ups alone
    // would lose the observation entirely.
    const report = buildReport({
      suite: { name: "t", version: "0" },
      target: {
        id: "t",
        version: "0",
        baseUrl: "http://127.0.0.1:1",
        roles: ["authorization-server"],
      },
      run: { startedAt: "", finishedAt: "", reproducible: true },
      cases: [
        {
          caseId: "AS-8/passing-sibling",
          requirementId: "AS-8",
          outcome: "pass",
          assertion: "Revocation reflected.",
        },
        {
          caseId: "AS-8/advisory-case",
          requirementId: "AS-8",
          outcome: "advisory",
          assertion: "SHOULD-level observation.",
          detail: "Extra disclosure on the inactive response.",
        },
      ],
    });
    assert.ok(
      report.summary.advisoryRequirements.includes("AS-8"),
      "An advisory case must surface even when a sibling case passes."
    );
    assert.ok(!report.summary.failedRequirements.includes("AS-8"));
  });

  it("renders advisory case detail in markdown, separately from MUST failures", () => {
    // Protected risk: the JSON report already carries advisoryRequirements (see
    // the two cases above), but the markdown renderer had no legend entry or
    // detail section for `advisory` outcomes — a human reading the rendered
    // report, rather than the JSON, had no way to see which case produced the
    // observation or why. The plausible defect is the inverse too: an advisory
    // case leaking into the "## Failures" section, which would overstate a
    // conforming implementation as non-conformant (the exact harm this
    // describe block exists to prevent).
    const report = buildReport({
      suite: { name: "t", version: "0" },
      target: {
        id: "t",
        version: "0",
        baseUrl: "http://127.0.0.1:1",
        roles: ["authorization-server"],
      },
      run: { startedAt: "", finishedAt: "", reproducible: true },
      cases: [
        {
          caseId: "AS-8/advisory-case",
          requirementId: "AS-8",
          outcome: "advisory",
          assertion: "MUST met; SHOULD-level observation recorded.",
          detail: "RFC SHOULD NOT, not strengthened by Core.",
        },
      ],
    });

    const markdown = renderMarkdown(report);

    const advisoriesSection = markdown.slice(markdown.indexOf("## Advisories"), markdown.indexOf("## Not tested"));
    assert.ok(
      advisoriesSection.includes("AS-8"),
      "The Advisories section must name the requirement carrying the observation."
    );
    assert.ok(advisoriesSection.includes("AS-8/advisory-case"), "The Advisories section must show the case ID.");
    assert.ok(
      advisoriesSection.includes("RFC SHOULD NOT, not strengthened by Core."),
      "The Advisories section must show the case detail, not just the requirement ID."
    );

    const failuresSection = markdown.slice(markdown.indexOf("## Failures"), markdown.indexOf("## Advisories"));
    assert.ok(!failuresSection.includes("AS-8"), "An advisory-only requirement must not appear under Failures.");
    assert.ok(
      failuresSection.includes("No failed requirements in this run."),
      "MUST-failure rendering must be unchanged: zero fails still reports as none."
    );
  });
});

describe("a version-aware report states which revision it measured against", () => {
  // WHAT THIS PROTECTS. Making the report version-aware creates a new way to
  // overclaim, and it is subtler than the ones the suite already guards. The
  // same target, the same cases and the same suite version produce DIFFERENT
  // clause denominators at v0.1 and v0.2, because v0.2 adds obligations v0.1
  // does not have. A report that carried clause numbers without naming the
  // revision would be unreadable-but-plausible: a reader would compare a v0.1
  // number against a v0.2 number and conclude coverage had changed when only
  // the denominator moved.
  //
  // THE PLAUSIBLE DEFECT is a caller that threads the version into the clause
  // selection but not into the report, or the reverse. Both leave a report that
  // renders cleanly and states a number about the wrong revision.
  const target = {
    id: "t",
    version: "0",
    baseUrl: "http://127.0.0.1:1",
    roles: ["authorization-server"] as const,
  };
  const run = { startedAt: "", finishedAt: "", reproducible: true };

  it("defaults to the adopted revision when no version is asked for", () => {
    const report = buildReport({ suite: { name: "t", version: "0" }, target, run, cases: [] });
    assert.equal(
      report.specVersion,
      "0.1",
      "A caller that names no revision must be reported against adopted text, never a proposal."
    );
    assert.equal(report.clauseCoverage.specVersion, "0.1");
  });

  it("measures against a larger MUST denominator at v0.2 than at v0.1", () => {
    const v01 = buildReport({ suite: { name: "t", version: "0" }, target, run, cases: [], specVersion: "0.1" });
    const v02 = buildReport({ suite: { name: "t", version: "0" }, target, run, cases: [], specVersion: "0.2" });

    assert.ok(
      v02.clauseCoverage.mustTotal > v01.clauseCoverage.mustTotal,
      "This batch transcribes v0.2 MUST clauses with no v0.1 counterpart, so the " +
        "v0.2 denominator must be strictly larger. Equal totals mean the version " +
        "never reached the clause selection."
    );
    assert.ok(
      v02.clauseCoverage.mustCovered < v01.clauseCoverage.mustCovered,
      "Moving to v0.2 must LOSE covered MUSTs, not gain them. No case sends the " +
        "v0.2 `authorization_details` type, so no v0.2 clause gains evidence — and " +
        "a v0.2 clause that supersedes a COVERED v0.1 clause retires that clause's " +
        "cases along with it, because they are evidence about the text v0.2 " +
        "replaced. A rise here is coverage invented by a version flag; even holding " +
        "steady would mean a supersession quietly inherited evidence it never earned."
    );
    assert.ok(
      v02.clauseCoverage.mustUncovered > v01.clauseCoverage.mustUncovered,
      "The v0.2 gap must be visibly larger, which is the honest reading of a " +
        "revision whose obligations no case reaches yet."
    );
  });

  it("names the revision in the rendered report, next to the clause numbers", () => {
    for (const specVersion of ["0.1", "0.2"] as const) {
      const report = buildReport({ suite: { name: "t", version: "0" }, target, run, cases: [], specVersion });
      const markdown = renderMarkdown(report);
      assert.ok(
        markdown.includes(`Clause inventory: spec revision v${specVersion}`),
        `The v${specVersion} report must name its revision in the header.`
      );
      assert.ok(
        markdown.includes(`Clause coverage at v${specVersion}:`),
        `The v${specVersion} report must attach the revision to the clause numbers themselves, ` +
          "so a number cannot be quoted without it."
      );
    }
  });

  it("warns in the v0.2 report that the revision is not adopted", () => {
    const markdown = renderMarkdown(
      buildReport({ suite: { name: "t", version: "0" }, target, run, cases: [], specVersion: "0.2" })
    );
    assert.ok(
      markdown.includes("not an adopted revision"),
      "A v0.2 report states behaviour against a proposal. A reader who misses that " +
        "would treat it as a conformance result against agreed text."
    );
  });

  it("hides a superseded v0.1 clause from a v0.2 requirement roll-up", () => {
    // The report-side half of the supersession rule. matrix.ts's own tests prove
    // the view excludes the superseded id; this proves the exclusion survives the
    // trip through buildReport, where a requirement's clause list is rebuilt.
    const superseding = CLAUSE_MATRIX.find((c) => c.specVersion === "0.2" && c.supersedes);
    assert.ok(superseding?.supersedes, "This batch registers at least one supersession.");
    const [requirementId] = superseding.requirementIds;
    assert.ok(requirementId, "The superseding clause must roll up to a Section 9 item to be visible here.");

    const v02 = buildReport({ suite: { name: "t", version: "0" }, target, run, cases: [], specVersion: "0.2" });
    const result = v02.requirements.find((r) => r.requirement.id === requirementId);
    assert.ok(result, `${requirementId} must appear in the report.`);
    assert.ok(
      !result.clauseIds.includes(superseding.supersedes),
      `${requirementId} still lists ${superseding.supersedes}, which ${superseding.clauseId} replaces. ` +
        "The same obligation would be reported twice under two ids."
    );
    assert.ok(
      result.clauseIds.includes(superseding.clauseId),
      `${requirementId} must list the replacing clause ${superseding.clauseId}.`
    );
  });

  it("discloses every v0.2 MUST as an uncovered gap with a named blocker", () => {
    // The batch's central claim, asserted rather than trusted: mechanics landed,
    // cases did not. A v0.2 MUST reaching the report without a gap note would
    // read as an oversight instead of a recorded limit.
    const v02 = buildReport({ suite: { name: "t", version: "0" }, target, run, cases: [], specVersion: "0.2" });
    const disclosed = new Map(
      v02.requirements.flatMap((r) => r.uncoveredMustClauses.map((c) => [c.clauseId, c.gapNote] as const))
    );
    const v02Musts = CLAUSE_MATRIX.filter(
      (c) => c.specVersion === "0.2" && c.level === "must" && c.requirementIds.length > 0
    );
    assert.ok(v02Musts.length > 0, "Fixture expectation: this batch transcribes mapped v0.2 MUST clauses.");
    for (const clause of v02Musts) {
      const note = disclosed.get(clause.clauseId);
      assert.ok(note, `v0.2 MUST ${clause.clauseId} never reached the report's uncovered list.`);
      assert.ok(note.length > 0, `v0.2 MUST ${clause.clauseId} reached the report with an empty gap note.`);
    }
  });
});

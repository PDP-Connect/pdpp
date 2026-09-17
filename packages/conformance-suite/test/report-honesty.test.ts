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
import { REQUIREMENTS } from "../src/requirements/catalog.ts";
import { ALL_CASES, coveredRequirementIds, runSuite } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

describe("the report cannot present a partial run as complete", () => {
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
    assert.equal(
      report.summary.failedRequirements.length,
      0,
      "Fixture expectation: the clean reference target fails nothing."
    );
    assert.equal(
      report.summary.allApplicableMustsTestedAndPassed,
      false,
      "Zero failures plus incomplete coverage must not set allApplicableMustsTestedAndPassed."
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
    const cli = path.join(here, "..", "src", "cli.ts");
    const result = await execFileAsync(process.execPath, ["--import", "tsx", cli, "--target", "reference", "--quiet"], {
      env: { ...process.env, SOURCE_DATE_EPOCH: "1758153600" },
    }).then(
      () => ({ code: 0 }),
      (error: { code?: number }) => ({ code: error.code ?? -1 })
    );
    assert.equal(result.code, 2, "A run with no failures but untested applicable requirements must exit 2, not 0.");
  });
});

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
    // Fixture expectation: the reference target seeds a `mutable_state`
    // stream ("conversations") but implements no `changes_since` handling,
    // so RS-8's terminal-page obligation is a genuine, honestly-reported
    // failure here — the fix that made RS-7/RS-8 applicability track seeded
    // stream semantics rather than the target's own (previously false)
    // `incrementalSync` declaration surfaced this real gap. Asserting zero
    // failures would require silently exempting the reference target from a
    // requirement its own seeded data obligates.
    assert.deepEqual(
      report.summary.failedRequirements,
      ["RS-8"],
      "Fixture expectation: the reference target serves a mutable_state stream but does not implement " +
        "changes_since, so RS-8 is its only genuine failure."
    );
    assert.equal(
      report.summary.allApplicableMustsTestedAndPassed,
      false,
      "A real failure plus incomplete coverage must not set allApplicableMustsTestedAndPassed."
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

    const advisoriesSection = markdown.slice(
      markdown.indexOf("## Advisories"),
      markdown.indexOf("## Not tested")
    );
    assert.ok(
      advisoriesSection.includes("AS-8"),
      "The Advisories section must name the requirement carrying the observation."
    );
    assert.ok(
      advisoriesSection.includes("AS-8/advisory-case"),
      "The Advisories section must show the case ID."
    );
    assert.ok(
      advisoriesSection.includes("RFC SHOULD NOT, not strengthened by Core."),
      "The Advisories section must show the case detail, not just the requirement ID."
    );

    const failuresSection = markdown.slice(
      markdown.indexOf("## Failures"),
      markdown.indexOf("## Advisories")
    );
    assert.ok(
      !failuresSection.includes("AS-8"),
      "An advisory-only requirement must not appear under Failures."
    );
    assert.ok(
      failuresSection.includes("No failed requirements in this run."),
      "MUST-failure rendering must be unchanged: zero fails still reports as none."
    );
  });
});

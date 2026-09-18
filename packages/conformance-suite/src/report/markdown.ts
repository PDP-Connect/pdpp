// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Renders a ConformanceReport as GitHub-flavored markdown for a human reader.
//
// The rendering rules exist to make a partial run impossible to mistake for a
// clean one. Coverage sits next to pass counts in the header, never below the
// fold. All five outcomes get distinct markers and a legend explaining that
// three of them are absence of evidence, not a pass. Failures are split by
// normative level because a failed MUST and a failed SHOULD are different
// claims. Not-tested requirements are listed by ID so a gap in the run is
// visible rather than implied by omission. This module holds no opinion on
// conformance status: it states what a `ConformanceReport` already recorded.

import type {
	ConformanceReport,
	Outcome,
	RequirementResult,
	RoleCoverage,
} from "./result.ts";

const OUTCOME_MARKER: Record<Outcome, string> = {
  advisory: "ADVISORY",
	pass: "PASS",
	fail: "FAIL",
	unsupported: "UNSUPPORTED",
	skip: "SKIP",
	"not-tested": "NOT TESTED",
};

const DISCLAIMER =
	"This report records observed behaviour only. It does not confer any " +
	"status on the target. Conferring status is the technical committee's " +
	"act under GOVERNANCE.md Section 5, and no output of this suite " +
	"substitutes for it.";

function formatPercent(numerator: number, denominator: number): string {
	if (denominator === 0) {
		return "n/a";
	}
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function renderHeader(report: ConformanceReport): string {
	const totalApplicable = report.coverage.reduce((sum, c) => sum + c.applicable, 0);
	const totalTested = report.coverage.reduce((sum, c) => sum + c.tested, 0);
	const totalPassed = report.coverage.reduce((sum, c) => sum + c.passed, 0);
	const totalFailed = report.coverage.reduce((sum, c) => sum + c.failed, 0);
	const roles = report.target.roles.join(", ");

	const lines = [
		`# Conformance report: ${report.target.id}`,
		"",
		`Suite: ${report.suite.name} v${report.suite.version}`,
		`Spec: ${report.spec.document} ${report.spec.version}, Section ${report.spec.section} (${report.spec.path})`,
		`Clause inventory: spec revision v${report.specVersion}` +
			(report.specVersion === "0.1"
				? " (the adopted draft)"
				: " (the private normative proposal in vana-com/pdpp PR #1, not an adopted revision)"),
		`Target: ${report.target.id} v${report.target.version} at ${report.target.baseUrl} (roles: ${roles})`,
		`Run: started ${report.run.startedAt}, finished ${report.run.finishedAt}` +
			(report.run.reproducible ? " (reproducible)" : ""),
		"",
		"## Coverage",
		"",
		`Coverage (tested/applicable): ${totalTested}/${totalApplicable} (${formatPercent(totalTested, totalApplicable)})`,
		`Passed/tested: ${totalPassed}/${totalTested}`,
		`Failed: ${totalFailed}`,
		"",
		"A pass count alone does not describe this run. Read coverage first: a " +
			"suite that tested a third of applicable requirements and passed all " +
			"of them is not equivalent to a complete run.",
		"",
		`Clause coverage at v${report.specVersion}: ` +
			`${report.clauseCoverage.mustCovered}/${report.clauseCoverage.mustTotal} MUST-level clauses ` +
			`have at least one case (${formatPercent(report.clauseCoverage.mustCovered, report.clauseCoverage.mustTotal)}), ` +
			`out of ${report.clauseCoverage.total} clauses in force at this revision.`,
		"",
		"The two numbers above measure different things. Requirement coverage " +
			"counts Section 9 items, which are one-line summaries; clause coverage " +
			"counts the normative sentences behind them. The second is always the " +
			"harder number, and changing the spec revision changes its denominator.",
	];
	return lines.join("\n");
}

function renderDisclaimer(): string {
	return ["## Disclaimer", "", DISCLAIMER].join("\n");
}

function renderLegend(): string {
	const lines = [
		"## Legend",
		"",
		"| Marker | Meaning |",
		"| --- | --- |",
		"| `PASS` | The target demonstrated the required behaviour. |",
		"| `ADVISORY` | The target met every MUST the case checks, but did not follow a SHOULD-level recommendation. Not a conformance failure; see Advisories below. |",
		"| `FAIL` | The target demonstrated a violation. |",
		"| `UNSUPPORTED` | The target declares the optional capability absent; the requirement does not apply. Not a pass. |",
		"| `SKIP` | The case could not run for an environmental reason. Absence of evidence, not a pass. |",
		"| `NOT TESTED` | No case exists in this suite version for the requirement. Absence of evidence, not a pass. |",
		"",
		"`UNSUPPORTED`, `SKIP`, and `NOT TESTED` all mean the suite has no " +
			"evidence for that requirement. None of them may be read as a pass.",
	];
	return lines.join("\n");
}

function renderCoverageTable(coverage: readonly RoleCoverage[]): string {
	const lines = [
		"## Coverage by role",
		"",
		"| Role | Total | Applicable | Tested | Passed | Failed | Skipped | Unsupported | Not tested |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const c of coverage) {
		lines.push(
			`| ${c.role} | ${c.total} | ${c.applicable} | ${c.tested} | ${c.passed} | ${c.failed} | ${c.skipped} | ${c.unsupported} | ${c.notTested} |`,
		);
	}
	return lines.join("\n");
}

function renderFailureEntry(result: RequirementResult): string {
	const lines = [
		`### ${result.requirement.id} (${result.requirement.specAnchor})`,
		"",
	];
	const failedCases = result.cases.filter((c) => c.outcome === "fail");
	for (const c of failedCases) {
		lines.push(`- Case \`${c.caseId}\``);
		lines.push(`  - Assertion: ${c.assertion}`);
		lines.push(`  - Detail: ${c.detail ?? "(no detail recorded)"}`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderFailures(requirements: readonly RequirementResult[]): string {
	const failed = requirements.filter((r) => r.outcome === "fail");
	const mustFailures = failed.filter((r) => r.requirement.level === "must");
	const shouldFailures = failed.filter((r) => r.requirement.level === "should");

	const lines = ["## Failures", ""];

	if (failed.length === 0) {
		lines.push("No failed requirements in this run.", "");
		return lines.join("\n");
	}

	lines.push("### Failed MUSTs", "");
	if (mustFailures.length === 0) {
		lines.push("None.", "");
	} else {
		for (const r of mustFailures) {
			lines.push(renderFailureEntry(r));
		}
	}

	lines.push("### Failed SHOULDs", "");
	if (shouldFailures.length === 0) {
		lines.push("None.", "");
	} else {
		for (const r of shouldFailures) {
			lines.push(renderFailureEntry(r));
		}
	}

	return lines.join("\n");
}

function renderAdvisoryEntry(result: RequirementResult): string {
	const lines = [
		`### ${result.requirement.id} (${result.requirement.specAnchor})`,
		"",
	];
	const advisoryCases = result.cases.filter((c) => c.outcome === "advisory");
	for (const c of advisoryCases) {
		lines.push(`- Case \`${c.caseId}\``);
		lines.push(`  - Assertion: ${c.assertion}`);
		lines.push(`  - Detail: ${c.detail ?? "(no detail recorded)"}`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderAdvisories(requirements: readonly RequirementResult[]): string {
	const advisoryRequirements = requirements.filter(
		(r) => r.cases.some((c) => c.outcome === "advisory"),
	);

	const lines = [
		"## Advisories",
		"",
		"These cases record SHOULD-level observations. Other cases for the same " +
			"requirement may fail; those appear under Failures.",
		"",
	];

	if (advisoryRequirements.length === 0) {
		lines.push("No advisory observations in this run.", "");
		return lines.join("\n");
	}

	for (const r of advisoryRequirements) {
		lines.push(renderAdvisoryEntry(r));
	}

	return lines.join("\n");
}

function renderNotTested(requirements: readonly RequirementResult[]): string {
	const notTested = requirements.filter((r) => r.outcome === "not-tested");
	const lines = [
		"## Not tested",
		"",
		"Requirements below have no case in this suite version. The gap is " +
			"listed here rather than left implicit.",
		"",
	];
	if (notTested.length === 0) {
		lines.push("None. Every applicable requirement has at least one case.");
		return lines.join("\n");
	}
	lines.push("| Requirement | Role | Level | Spec anchor |", "| --- | --- | --- | --- |");
	for (const r of notTested) {
		lines.push(
			`| ${r.requirement.id} | ${r.requirement.role} | ${r.requirement.level} | ${r.requirement.specAnchor} |`,
		);
	}
	return lines.join("\n");
}

function renderAllResults(requirements: readonly RequirementResult[]): string {
	const lines = [
		"## All requirements",
		"",
		"| Requirement | Role | Level | Outcome | Spec anchor |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const r of requirements) {
		lines.push(
			`| ${r.requirement.id} | ${r.requirement.role} | ${r.requirement.level} | ${OUTCOME_MARKER[r.outcome]} | ${r.requirement.specAnchor} |`,
		);
	}
	return lines.join("\n");
}

/**
 * Per-requirement clause inventory.
 *
 * This is the section that stops a green requirement from overclaiming. A
 * requirement rolls up from its cases, but the Section 9 item it names is a
 * summary of several clauses; where cases reach some of them and not others, a
 * `PASS` marker alone invites the reader to assume the whole item was
 * exercised. Listing the clause IDs, and naming every uncovered MUST with the
 * gap that blocks it, makes the unexercised remainder as visible as the result.
 */
function renderClauseInventory(report: ConformanceReport): string {
	const { requirements, specVersion } = report;
	// The generator writes one file per revision, so a pointer that ignored the
	// revision would send a v0.2 reader to the v0.1 inventory — a document that
	// does not contain the clause ids listed right above it.
	const inventoryFile =
		specVersion === "0.1"
			? "conformance-normative-matrix.md"
			: `conformance-normative-matrix-v${specVersion}.md`;
	const lines = [
		"## Clause coverage",
		"",
		"Each Section 9 item summarizes normative clauses in Core sections 4-8 and " +
			"10. The clauses behind each item are listed here, and any MUST-level " +
			"clause with no case is named with the gap that blocks it. A requirement " +
			"marked `PASS` may still have uncovered clauses: the marker describes the " +
			"cases that ran, not the whole item.",
		"",
		`Full inventory at this revision: \`docs/reference/${inventoryFile}\`.`,
		"",
	];
	for (const r of requirements) {
		lines.push(`### ${r.requirement.id} (${OUTCOME_MARKER[r.outcome]})`, "");
		if (r.clauseIds.length === 0) {
			lines.push("No clause in sections 4-8 or 10 maps to this item.", "");
			continue;
		}
		lines.push(`Clauses: ${r.clauseIds.map((id) => `\`${id}\``).join(", ")}`, "");
		if (r.uncoveredMustClauses.length === 0) {
			lines.push("Every MUST-level clause under this item has at least one case.", "");
			continue;
		}
		lines.push("Uncovered MUST clauses:", "");
		for (const clause of r.uncoveredMustClauses) {
			lines.push(`- \`${clause.clauseId}\`: ${clause.gapNote}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function renderReviewEvidence(report: ConformanceReport): string {
	const lines = [
		"## Review evidence",
		"",
		"These packets are human-review evidence for clauses the executable suite cannot observe. They do not create cases, change coverage, or count as tested.",
		"",
		"| Clause | Status | Claim | Evidence files | Reviewed by | Date |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	if (report.reviewEvidence.length === 0) {
		lines.push("| — | — | No review evidence attached. | — | — | — |");
		return lines.join("\n");
	}
	for (const packet of report.reviewEvidence) {
		const files = packet.evidenceFiles.map((file) => `\`${file.path}\` — ${file.description}`).join("<br>");
		lines.push(`| \`${packet.clauseId}\` | ${packet.status.toUpperCase()} | ${packet.claim} | ${files} | ${packet.reviewedBy} | ${packet.reviewedOn} |`);
	}
	return lines.join("\n");
}

/**
 * Render a ConformanceReport as GitHub-flavored markdown.
 *
 * Pure function: no file I/O, no console output. Section order is deliberate —
 * coverage and the disclaimer appear before anything that could read as good
 * news, so a reader cannot reach a pass count without first seeing how much of
 * the catalogue it covers.
 */
export function renderMarkdown(report: ConformanceReport): string {
	const sections = [
		renderHeader(report),
		renderDisclaimer(),
		renderLegend(),
		renderCoverageTable(report.coverage),
		renderFailures(report.requirements),
		renderAdvisories(report.requirements),
		renderNotTested(report.requirements),
		renderAllResults(report.requirements),
		renderClauseInventory(report),
		renderReviewEvidence(report),
	];
	return `${sections.join("\n\n")}\n`;
}

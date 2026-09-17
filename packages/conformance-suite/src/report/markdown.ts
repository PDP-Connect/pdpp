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
		renderNotTested(report.requirements),
		renderAllResults(report.requirements),
	];
	return `${sections.join("\n\n")}\n`;
}

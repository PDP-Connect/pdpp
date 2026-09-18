// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The result model and the machine-readable report.
//
// The central design constraint: a partial pass must never read as "conformant".
// Three separate mechanisms enforce that, because any one alone can be defeated
// by a reader skimming a summary line.
//
//  1. Five outcomes, not two. `pass`/`fail` are the only judgments; `skip`,
//     `unsupported` and `not-tested` record an ABSENCE of evidence. They are
//     never folded into a numerator.
//  2. The denominator is the requirement catalogue, not the executed tests. A
//     requirement with no case at all appears as `not-tested`. Coverage is
//     stated as tested/applicable, so a suite that exercises six of sixteen RS
//     requirements reports 37.5% coverage rather than "all tests passed".
//  3. No `certified` field exists, at any level. The report states what was
//     observed. Conferring status is the technical committee's act under
//     GOVERNANCE.md Section 5, and no output of this suite substitutes for it.

import {
	REQUIREMENTS,
	type Requirement,
	type Role,
	SPEC_SOURCE,
	requirementById,
} from "../requirements/catalog.ts";
import {
	clausesForRequirement,
	clausesForVersion,
	DEFAULT_SPEC_VERSION,
	type SpecVersion,
} from "../requirements/matrix.ts";
import { validateReviewEvidence, type ReviewEvidence } from "./review-evidence.ts";

/**
 * The outcome of a single conformance case.
 *
 * - `pass`: the target demonstrated the required behaviour.
 * - `fail`: the target violated a MUST-level requirement. Always carries evidence.
 * - `advisory`: the target met every MUST the case checks, but did not follow a
 *   SHOULD-level recommendation the case also observed. NOT a conformance
 *   failure and never counted as one. It exists because collapsing a SHOULD into
 *   `fail` overstates the finding — a reader acting on it would report a
 *   conforming implementation as non-conformant — while collapsing it into
 *   `pass` discards a real observation. RFC 2119 separates the two levels, and
 *   so does this report.
 * - `unsupported`: the target declares the underlying optional capability
 *   absent, so the requirement does not apply. Not a defect, not a pass.
 * - `skip`: the case could not run for an environmental reason (a precondition
 *   could not be arranged). Evidence of nothing; distinct from `unsupported`
 *   because it signals an incomplete run rather than a target choice.
 * - `not-tested`: no case exists in this suite version for the requirement.
 *   Generated from the catalogue, never written by a test.
 */
export type Outcome =
	| "pass"
	| "fail"
	| "advisory"
	| "unsupported"
	| "skip"
	| "not-tested";

/**
 * A captured HTTP exchange backing a result. Every `fail` carries at least one,
 * so a disputed finding can be re-examined without re-running the suite.
 */
export type Evidence = {
	readonly request: {
		readonly method: string;
		readonly url: string;
		/** Authorization values are redacted before capture. */
		readonly headers: Readonly<Record<string, string>>;
	};
	readonly response: {
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
		/** Truncated to keep reports reviewable; see EVIDENCE_BODY_LIMIT. */
		readonly body: string;
	};
};

export type CaseResult = {
	/** Stable case identifier, e.g. "RS-2/stream-not-in-grant". */
	readonly caseId: string;
	readonly requirementId: string;
	readonly outcome: Outcome;
	/** What the case asserted, in one line. */
	readonly assertion: string;
	/** Why the outcome is what it is. Required for fail/skip/unsupported. */
	readonly detail?: string;
	readonly evidence?: readonly Evidence[];
	readonly durationMs?: number;
};

/**
 * A MUST-level clause under a requirement that no case exercises.
 *
 * Carried in the report so a reader of a PASSING requirement sees what that pass
 * does NOT establish. A requirement rolls up to `pass` on the strength of its
 * cases; if those cases reach three of the seven clauses the item summarizes,
 * the other four are absence of evidence hiding inside a green result. Listing
 * them is the clause-level analogue of reporting `not-tested` requirements.
 */
export type UncoveredClause = {
	readonly clauseId: string;
	/** The missing hook, fixture, or capability. Never empty for a MUST. */
	readonly gapNote: string;
};

/** Per-requirement roll-up: the worst outcome across its cases. */
export type RequirementResult = {
	readonly requirement: Requirement;
	readonly outcome: Outcome;
	readonly cases: readonly CaseResult[];
	/**
	 * Every clause in sections 4-8/10 this requirement summarizes, in matrix
	 * order. Added, never replacing anything: the JSON report's existing fields
	 * keep their shape and meaning.
	 */
	readonly clauseIds: readonly string[];
	/** The subset of `clauseIds` that are MUST-level with no case. */
	readonly uncoveredMustClauses: readonly UncoveredClause[];
};

export type RoleCoverage = {
	readonly role: Role;
	/** Requirements defined for the role in the catalogue. */
	readonly total: number;
	/** Requirements that apply to this target (total minus `unsupported`). */
	readonly applicable: number;
	/** Applicable requirements with at least one case that ran. */
	readonly tested: number;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly unsupported: number;
	readonly notTested: number;
	/** Requirements whose MUSTs passed but that carry a SHOULD-level observation. */
	readonly advisory: number;
};

/**
 * Clause counts at the revision the run reported against.
 *
 * Separate from `RoleCoverage` because the two answer different questions and
 * conflating them is the overclaim this suite exists to prevent. Role coverage
 * counts Section 9 ITEMS, which are one-line precis; this counts the normative
 * CLAUSES behind them. A run can test every applicable item and still have
 * reached a minority of the clauses those items summarize, and only this number
 * says so.
 *
 * It is stated per revision because the denominator itself moves: v0.2 adds
 * obligations v0.1 does not have, so "12 of 40 MUSTs covered" is not a claim
 * until the revision is named.
 */
export type ClauseCoverage = {
	readonly specVersion: SpecVersion;
	/** Clauses in force at this revision, after supersession. */
	readonly total: number;
	readonly mustTotal: number;
	/** MUST-level clauses with at least one registered case. */
	readonly mustCovered: number;
	/** MUST-level clauses with no case at all. */
	readonly mustUncovered: number;
};

export type ConformanceReport = {
	readonly reportVersion: "1";
	readonly suite: { readonly name: string; readonly version: string };
	readonly spec: typeof SPEC_SOURCE;
	/**
	 * The spec revision this report's clause inventory was selected at. Named
	 * explicitly because every clause count below is meaningless without it: the
	 * same target, same cases and same suite version produce different
	 * denominators at v0.1 and v0.2.
	 */
	readonly specVersion: SpecVersion;
	/** Clause-level counts at `specVersion`. */
	readonly clauseCoverage: ClauseCoverage;
	/**
	 * MUST-level clauses with no case that ALSO roll up to no Section 9 item, so
	 * no `RequirementResult` lists them.
	 *
	 * Without this field those clauses count in `clauseCoverage.mustUncovered`
	 * and then appear nowhere: the reader sees the denominator grow and cannot
	 * find out which obligations moved it, and the `gapNote` naming the missing
	 * hook is unreachable. That is the whole v0.2 inventory today — the batch 26
	 * transcription maps no v0.2 clause to a Section 9 item, because Section 9
	 * is v0.1's conformance list and inventing a mapping would be a guess — so
	 * the gap this field closes is 149 clauses wide, not an edge case.
	 */
	readonly unmappedMustClauses: readonly UncoveredClause[];
	readonly target: {
		readonly id: string;
		readonly version: string;
		readonly baseUrl: string;
		readonly roles: readonly Role[];
	};
	readonly run: {
		readonly startedAt: string;
		readonly finishedAt: string;
		/** Set from SOURCE_DATE_EPOCH when present, for reproducible reports. */
		readonly reproducible: boolean;
	};
	readonly coverage: readonly RoleCoverage[];
	readonly requirements: readonly RequirementResult[];
	/** Human-review evidence, kept separate from executable case results. */
	readonly reviewEvidence: readonly ReviewEvidence[];
	/**
	 * The one-line honest summary. Deliberately NOT a boolean: a caller asking
	 * "did it pass" must confront coverage, because a run with zero failures and
	 * 30% coverage is not the same claim as a complete run.
	 */
	readonly summary: {
		readonly failedRequirements: readonly string[];
		readonly failedShouldRequirements: readonly string[];
		/** Requirements conformant on every MUST but carrying a SHOULD observation. */
		readonly advisoryRequirements: readonly string[];
		readonly notTestedRequirements: readonly string[];
		/** True only when every applicable MUST was tested and passed. */
		readonly allApplicableMustsTestedAndPassed: boolean;
	};
};

export const EVIDENCE_BODY_LIMIT = 4096;

/**
 * Roll a requirement's cases up to one outcome, worst-first.
 *
 * Order matters and encodes the honesty rule: a single `fail` dominates any
 * number of passes, and an untested-but-applicable requirement outranks a pass
 * so that a half-exercised requirement cannot read as satisfied.
 */
const OUTCOME_SEVERITY: Record<Outcome, number> = {
	fail: 6,
	"not-tested": 5,
	skip: 4,
	// Above `pass` so a requirement with one advisory case does not read as a clean
	// pass, but below `skip` because the MUSTs were actually exercised and met.
	advisory: 3,
	pass: 2,
	unsupported: 1,
};

export function rollUpOutcome(cases: readonly CaseResult[]): Outcome {
	if (cases.length === 0) {
		return "not-tested";
	}
	let worst: Outcome = "unsupported";
	for (const c of cases) {
		if (OUTCOME_SEVERITY[c.outcome] > OUTCOME_SEVERITY[worst]) {
			worst = c.outcome;
		}
	}
	return worst;
}

function coverageForRole(
	role: Role,
	results: readonly RequirementResult[],
): RoleCoverage {
	const forRole = results.filter((r) => r.requirement.role === role);
	const count = (o: Outcome) => forRole.filter((r) => r.outcome === o).length;
	const unsupported = count("unsupported");
	const notTested = count("not-tested");
	const skipped = count("skip");
	const applicable = forRole.length - unsupported;
	return {
		role,
		total: forRole.length,
		applicable,
		tested: applicable - notTested - skipped,
		// An advisory requirement met its MUSTs, so it counts as passed for
		// conformance purposes and is additionally surfaced under `advisory`.
		passed: count("pass") + count("advisory"),
		failed: count("fail"),
		advisory: count("advisory"),
		skipped,
		unsupported,
		notTested,
	};
}

/**
 * Build the report from the cases a run produced.
 *
 * Requirements absent from `cases` are materialised as `not-tested` here rather
 * than omitted: that is mechanism (2) above, and it is why the denominator
 * cannot drift when someone deletes a test.
 */
export function buildReport(input: {
	readonly suite: { readonly name: string; readonly version: string };
	readonly target: ConformanceReport["target"];
	readonly run: ConformanceReport["run"];
	readonly cases: readonly CaseResult[];
	readonly reviewEvidence?: readonly ReviewEvidence[];
	/** Defaults to the adopted revision, so an existing caller is unaffected. */
	readonly specVersion?: SpecVersion;
}): ConformanceReport {
	const specVersion = input.specVersion ?? DEFAULT_SPEC_VERSION;
	const reviewEvidence = input.reviewEvidence ?? [];
	validateReviewEvidence(reviewEvidence);
	const byRequirement = new Map<string, CaseResult[]>();
	for (const c of input.cases) {
		const list = byRequirement.get(c.requirementId);
		if (list) {
			list.push(c);
		} else {
			byRequirement.set(c.requirementId, [c]);
		}
	}

	const scopedRoles = new Set<Role>(input.target.roles);
	const requirements: RequirementResult[] = REQUIREMENTS.filter((r) =>
		scopedRoles.has(r.role),
	).map((requirement) => {
		const cases = byRequirement.get(requirement.id) ?? [];
		const clauses = clausesForRequirement(requirement.id, specVersion);
		return {
			requirement,
			outcome: rollUpOutcome(cases),
			cases,
			clauseIds: clauses.map((c) => c.clauseId),
			uncoveredMustClauses: clauses
				.filter((c) => c.level === "must" && c.caseIds.length === 0)
				.map((c) => ({ clauseId: c.clauseId, gapNote: c.gapNote ?? "" })),
		};
	});

	const coverage = [...scopedRoles].map((role) =>
		coverageForRole(role, requirements),
	);

	const failed = requirements.filter((r) => r.outcome === "fail");
	const notTested = requirements.filter(
		(r) => r.outcome === "not-tested" || r.outcome === "skip",
	);
	const applicableMusts = requirements.filter(
		(r) => r.requirement.level === "must" && r.outcome !== "unsupported",
	);
	// Collected from CASES, not from requirement roll-ups: a requirement with one
	// advisory case and one passing case rolls up to `pass`, and the observation
	// would otherwise vanish from the summary entirely.
	const advisoryCases = input.cases.filter((c) => c.outcome === "advisory");

	// Counted over the whole revision, not over the roles in scope: the question
	// "how much of the spec does this suite reach" is about the suite, and
	// scoping it to the target's roles would let a single-role run report a
	// flattering clause number that says nothing about the suite's reach.
	const clausesInForce = clausesForVersion(specVersion);
	const mustClauses = clausesInForce.filter((c) => c.level === "must");
	const mustCovered = mustClauses.filter((c) => c.caseIds.length > 0).length;

	// Uncovered MUSTs that no requirement roll-up will list, because they
	// summarize to no Section 9 item. Reported here so a growing denominator is
	// always traceable to named clauses carrying their own gap notes.
	const unmappedMustClauses = mustClauses
		.filter((c) => c.caseIds.length === 0 && c.requirementIds.length === 0)
		.map((c) => ({ clauseId: c.clauseId, gapNote: c.gapNote ?? "" }));

	return {
		reportVersion: "1",
		suite: input.suite,
		spec: SPEC_SOURCE,
		specVersion,
		clauseCoverage: {
			specVersion,
			total: clausesInForce.length,
			mustTotal: mustClauses.length,
			mustCovered,
			mustUncovered: mustClauses.length - mustCovered,
		},
		unmappedMustClauses,
		target: input.target,
		run: input.run,
		coverage,
		requirements,
		reviewEvidence,
		summary: {
			failedRequirements: failed
				.filter((r) => r.requirement.level === "must")
				.map((r) => r.requirement.id),
			failedShouldRequirements: failed
				.filter((r) => r.requirement.level === "should")
				.map((r) => r.requirement.id),
			advisoryRequirements: [...new Set(advisoryCases.map((c) => c.requirementId))],
			notTestedRequirements: notTested.map((r) => r.requirement.id),
			allApplicableMustsTestedAndPassed: applicableMusts.every(
				(r) => r.outcome === "pass" || r.outcome === "advisory",
			),
		},
	};
}

/** Look up the requirement a case names, failing loudly on a typo'd ID. */
export function assertRequirementExists(requirementId: string): Requirement {
	const requirement = requirementById(requirementId);
	if (!requirement) {
		throw new Error(
			`Case references unknown requirement "${requirementId}". Requirement IDs must exist in the Core Section 9 catalogue.`,
		);
	}
	return requirement;
}

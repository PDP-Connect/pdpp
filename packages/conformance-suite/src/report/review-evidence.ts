// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { clauseById } from "../requirements/matrix.ts";

/** A file or capture supplied for human review, not an executed test oracle. */
export type ReviewEvidenceFile = {
	readonly path: string;
	readonly description: string;
};

/** A small, portable packet for evidence that the black-box suite cannot judge. */
export type ReviewEvidence = {
	readonly clauseId: string;
	readonly claim: string;
	readonly evidenceFiles: readonly ReviewEvidenceFile[];
	readonly reviewedBy: string;
	readonly reviewedOn: string;
	readonly status: "evidenced" | "pending";
};

export function validateReviewEvidence(packets: readonly ReviewEvidence[]): void {
	const seen = new Set<string>();
	for (const packet of packets) {
		if (seen.has(packet.clauseId)) {
			throw new Error(`Review evidence contains duplicate clause "${packet.clauseId}".`);
		}
		seen.add(packet.clauseId);

		const clause = clauseById(packet.clauseId);
		if (!clause || clause.level !== "must" || clause.observable !== "review-only") {
			throw new Error(
				`Review evidence clause "${packet.clauseId}" must name a review-only MUST clause.`,
			);
		}
		if (!packet.claim.trim() || !packet.reviewedBy.trim()) {
			throw new Error(`Review evidence "${packet.clauseId}" requires a claim and reviewer.`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(packet.reviewedOn)) {
			throw new Error(`Review evidence "${packet.clauseId}" reviewedOn must be YYYY-MM-DD.`);
		}
		if (packet.evidenceFiles.length === 0) {
			throw new Error(`Review evidence "${packet.clauseId}" requires an evidence file description.`);
		}
	}
}

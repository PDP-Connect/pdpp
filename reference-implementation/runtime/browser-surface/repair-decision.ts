// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** A non-secret provider proof is the only route to the existing repair. */
export interface ProviderInvalidationProof {
  readonly connection_id: string;
  readonly evidence_id: string;
  readonly kind: "provider_invalidation_proof";
  readonly observed_at: string;
  readonly provider: string;
  readonly verified: true;
}

export type BrowserSurfaceRepairEvidence =
  | ProviderInvalidationProof
  | { readonly kind: "ambiguous_dom_profile_evidence" }
  | { readonly kind: "replacement_verification_pending" }
  | { readonly kind: "session_probe_false" }
  | { readonly kind: "session_probe_indeterminate" };

export interface BrowserSurfaceRepairDecisionInput {
  readonly connection_id: string;
  readonly evidence: BrowserSurfaceRepairEvidence;
  /** Durable/explicit dedupe evidence, keyed by connection and proof identity. */
  readonly repaired_proof_keys?: ReadonlySet<string> | readonly string[];
}

export interface BrowserSurfaceRepairDecision {
  readonly action: "none" | "repair";
  readonly dedupe_key: string | null;
  readonly reason: "ambiguous_evidence" | "already_repaired" | "provider_invalidation_proven";
}

function proofKey(proof: ProviderInvalidationProof): string {
  return `${proof.connection_id}\n${proof.provider}\n${proof.evidence_id}`;
}

function hasRecordedRepair(input: BrowserSurfaceRepairDecisionInput, key: string): boolean {
  const keys = input.repaired_proof_keys;
  if (!keys) {
    return false;
  }
  return "has" in keys ? keys.has(key) : keys.includes(key);
}

function isProviderInvalidationProof(
  connectionId: string,
  evidence: BrowserSurfaceRepairEvidence
): evidence is ProviderInvalidationProof {
  return (
    evidence.kind === "provider_invalidation_proof" &&
    evidence.connection_id === connectionId &&
    evidence.verified === true &&
    evidence.provider.length > 0 &&
    evidence.evidence_id.length > 0 &&
    Number.isFinite(Date.parse(evidence.observed_at))
  );
}

/**
 * Pure decision seam: it neither persists dedupe state nor creates a repair.
 * The existing connection-scoped repair owner must record `dedupe_key` after
 * acting, then provide it on a later call.
 */
export function decideBrowserSurfaceRepair(input: BrowserSurfaceRepairDecisionInput): BrowserSurfaceRepairDecision {
  if (!input.evidence || typeof input.evidence !== "object") {
    throw new TypeError("browser-surface repair evidence must be typed");
  }
  if (!isProviderInvalidationProof(input.connection_id, input.evidence)) {
    return { action: "none", dedupe_key: null, reason: "ambiguous_evidence" };
  }
  const dedupeKey = proofKey(input.evidence);
  if (hasRecordedRepair(input, dedupeKey)) {
    return { action: "none", dedupe_key: dedupeKey, reason: "already_repaired" };
  }
  return { action: "repair", dedupe_key: dedupeKey, reason: "provider_invalidation_proven" };
}

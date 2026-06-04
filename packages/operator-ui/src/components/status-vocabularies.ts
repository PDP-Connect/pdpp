/**
 * Status-badge vocabularies live in this sibling module (not primitives.tsx) so
 * that primitives.tsx exports *only* components — a requirement for React Fast
 * Refresh, which disables itself for any module that mixes component and
 * non-component exports. The StatusBadge component (primitives.tsx) imports the
 * default vocabulary from here; callers that need a domain-specific vocabulary
 * import it from "@pdpp/operator-ui/components/status-vocabularies".
 *
 * One primitive (the chip), many vocabularies (one per domain). Vocabularies are
 * domain-bound — don't conflate run lifecycle ("started") with artifact
 * authoring states ("in-progress").
 */

export type StatusTone = "success" | "danger" | "warning" | "neutral";

export interface StatusVocabularyEntry {
  label: string;
  tone: StatusTone;
}

export type StatusVocabulary = Record<string, StatusVocabularyEntry>;

// Run/grant lifecycle: event states of transient operations.
export const RUN_LIFECYCLE_VOCABULARY: StatusVocabulary = {
  failed: { label: "failed", tone: "danger" },
  rejected: { label: "rejected", tone: "danger" },
  denied: { label: "denied", tone: "danger" },
  revoked: { label: "revoked", tone: "danger" },
  cancelled: { label: "cancelled", tone: "danger" },
  succeeded: { label: "succeeded", tone: "success" },
  issued: { label: "issued", tone: "success" },
  token_issued: { label: "token issued", tone: "success" },
  approved: { label: "approved", tone: "success" },
  started: { label: "started", tone: "warning" },
  pending: { label: "pending", tone: "warning" },
  staged: { label: "staged", tone: "warning" },
  verification_pending: { label: "verification pending", tone: "warning" },
  succeeded_with_gaps: { label: "partial", tone: "warning" },
};

// Change/spec authoring lifecycle: maturity states of durable artifacts.
export const ARTIFACT_LIFECYCLE_VOCABULARY: StatusVocabulary = {
  "in-progress": { label: "in progress", tone: "warning" },
  complete: { label: "complete", tone: "success" },
  unknown: { label: "no tasks", tone: "neutral" },
};

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

/**
 * Grant lifecycle vocabulary — the durable authorization state of a grant
 * record, not the transient run/trace event state.
 *
 * Key mapping: the correlation spine stores `succeeded` for grants that
 * completed the authorization flow and became active; display that as
 * "active" so the badge reads the grant's current state, not the flow's
 * terminal event.
 */
export const GRANT_LIFECYCLE_VOCABULARY: StatusVocabulary = {
  succeeded: { label: "active", tone: "success" },
  issued: { label: "active", tone: "success" },
  token_issued: { label: "active", tone: "success" },
  approved: { label: "active", tone: "success" },
  active: { label: "active", tone: "success" },
  revoked: { label: "revoked", tone: "danger" },
  denied: { label: "denied", tone: "danger" },
  rejected: { label: "denied", tone: "danger" },
  failed: { label: "failed", tone: "danger" },
  cancelled: { label: "cancelled", tone: "danger" },
  pending: { label: "pending", tone: "warning" },
  staged: { label: "pending", tone: "warning" },
};

// Change/spec authoring lifecycle: maturity states of durable artifacts.
export const ARTIFACT_LIFECYCLE_VOCABULARY: StatusVocabulary = {
  "in-progress": { label: "in progress", tone: "warning" },
  complete: { label: "complete", tone: "success" },
  unknown: { label: "no tasks", tone: "neutral" },
};

/**
 * Connection health vocabulary — keyed on raw API `state` strings from
 * `RefConnectionHealthSnapshot.state` (e.g. "healthy", "blocked").
 *
 * Used with `StatusBadge` on the connection-detail diagnostics surface and the
 * Sources list row to render every health state as a consistent chip. "idle"
 * and "unknown" map to neutral tone. "running" / syncing states are not raw
 * API states but derived display states; those use "warning" tone here.
 *
 * Tone mapping mirrors `deriveConnectionStatusDisplay`:
 *   success  → healthy (with durable progress)
 *   warning  → needs_attention, cooling_off, degraded, idle/syncing
 *   danger   → blocked
 *   neutral  → healthy (no data), idle, unknown
 */
export const CONNECTION_HEALTH_VOCABULARY: StatusVocabulary = {
  healthy: { label: "healthy", tone: "success" },
  needs_attention: { label: "needs attention", tone: "warning" },
  cooling_off: { label: "cooling off", tone: "warning" },
  blocked: { label: "blocked", tone: "danger" },
  degraded: { label: "degraded", tone: "warning" },
  idle: { label: "idle", tone: "neutral" },
  unknown: { label: "unknown", tone: "neutral" },
};

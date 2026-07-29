// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  approved: { label: "approved", tone: "success" },
  cancelled: { label: "cancelled", tone: "danger" },
  denied: { label: "denied", tone: "danger" },
  failed: { label: "failed", tone: "danger" },
  issued: { label: "issued", tone: "success" },
  pending: { label: "pending", tone: "warning" },
  rejected: { label: "rejected", tone: "danger" },
  revoked: { label: "revoked", tone: "danger" },
  staged: { label: "staged", tone: "warning" },
  started: { label: "started", tone: "warning" },
  succeeded: { label: "succeeded", tone: "success" },
  succeeded_with_gaps: { label: "partial", tone: "warning" },
  token_issued: { label: "token issued", tone: "success" },
  verification_pending: { label: "verification pending", tone: "warning" },
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
  active: { label: "active", tone: "success" },
  approved: { label: "active", tone: "success" },
  cancelled: { label: "cancelled", tone: "danger" },
  denied: { label: "denied", tone: "danger" },
  failed: { label: "failed", tone: "danger" },
  issued: { label: "active", tone: "success" },
  pending: { label: "pending", tone: "warning" },
  rejected: { label: "denied", tone: "danger" },
  revoked: { label: "revoked", tone: "danger" },
  staged: { label: "pending", tone: "warning" },
  succeeded: { label: "active", tone: "success" },
  token_issued: { label: "active", tone: "success" },
  // An indeterminate grant state reads neutral, never the `active`/success
  // tone. Pinned explicitly so unknown can never be folded into a definite
  // live state (PDPP honesty: unknown reads unknown).
  unknown: { label: "unknown", tone: "neutral" },
};

// Schedule state: the durable refresh-cadence row's posture.
export const SCHEDULE_STATE_VOCABULARY: StatusVocabulary = {
  active: { label: "active", tone: "success" },
  not_runnable: { label: "not runnable", tone: "warning" },
  paused: { label: "paused", tone: "neutral" },
  unscheduled: { label: "unscheduled", tone: "neutral" },
};

// Change/spec authoring lifecycle: maturity states of durable artifacts.
export const ARTIFACT_LIFECYCLE_VOCABULARY: StatusVocabulary = {
  complete: { label: "complete", tone: "success" },
  "in-progress": { label: "in progress", tone: "warning" },
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
  blocked: { label: "blocked", tone: "danger" },
  cooling_off: { label: "cooling off", tone: "warning" },
  degraded: { label: "degraded", tone: "warning" },
  healthy: { label: "healthy", tone: "success" },
  idle: { label: "idle", tone: "neutral" },
  needs_attention: { label: "needs attention", tone: "warning" },
  unknown: { label: "unknown", tone: "neutral" },
};

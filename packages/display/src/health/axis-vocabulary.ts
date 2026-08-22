// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner-facing vocabulary for the reference's connection-health axes.
 *
 * This module is the SINGLE source of the words an owner reads for a
 * coverage / freshness / outbox / attention axis. It lives in
 * `@pdpp/display` — not in the console app — because more than one surface
 * must say the same thing about the same evidence:
 *
 *   - the console `/sources` page and its source-detail subpages, and
 *   - `pdpp ref sources`, the headless CLI that exists so an agent and the
 *     owner can read the SAME rendered verdict rather than the agent reading
 *     raw `connector_summary_evidence` rows (the INPUTS) while the owner reads
 *     the rendered UI (the OUTPUT). Those two diverged badly enough to cause
 *     repeated miscommunication; a second copy of these strings would
 *     reintroduce exactly that drift.
 *
 * Nothing here reads the network, touches React, or depends on a framework.
 * The axis KEYS are the reference server's durable wire contract; the
 * `value`/`title` text is owner-facing copy this module owns. Where the two
 * deliberately diverge (`deferred`, `terminal_gap`) the reason is commented
 * inline — do not "fix" the mismatch by renaming a wire key.
 */

export type EvidenceTone = "neutral" | "success" | "warning" | "danger";

export interface AxisChip {
  /** The axis name (e.g. "Coverage", "Freshness"). Rendered muted. */
  dimension: string;
  /** Short owner-facing label (e.g. "Coverage · gaps"). Kept for backward compat/tooltips. */
  label: string;
  /** Long-form hover/tooltip — describes what the chip means. */
  title: string;
  tone: EvidenceTone;
  /** The axis state value (e.g. "gaps", "fresh"). Rendered prominent. */
  value: string;
}

/** The reference's `connection_health.axes.coverage` domain. */
export type CoverageAxis =
  | "complete"
  | "deferred"
  | "gaps"
  | "inventory_only"
  | "partial"
  | "retryable_gap"
  | "terminal_gap"
  | "unavailable"
  | "unknown"
  | "unsupported";

/** The reference's `connection_health.axes.freshness` domain. */
export type FreshnessAxis = "fresh" | "stale" | "unknown";

/** The reference's `connection_health.axes.outbox` domain. */
export type OutboxAxis = "active" | "idle" | "stalled" | "unknown";

/** The reference's `connection_health.axes.attention` domain. */
export type AttentionAxis = "acknowledged" | "in_progress" | "none" | "open";

const COVERAGE_LABELS: Record<CoverageAxis, AxisChip> = {
  complete: {
    dimension: "Coverage",
    label: "Coverage · complete",
    title: "All required streams have durable evidence of complete coverage.",
    tone: "success",
    value: "complete",
  },
  deferred: {
    dimension: "Coverage",
    label: "Coverage · optional, not collected",
    title:
      "The manifest declares this coverage out of scope. This is an accepted, settled state — not a queued task — and does not block connection health.",
    tone: "neutral",
    // The underlying axis key stays "deferred" (durable manifest/runtime
    // contract — see AcceptedCoveragePolicy in connector-coverage-policy.ts).
    // "Deferred" read as queued/pending work to owners, contradicting the
    // settled, non-degrading semantics this axis actually carries. The
    // visible value/label now say plainly that this stream is optional and
    // not collected; the manifest-declaration detail moves to the title.
    value: "optional, not collected",
  },
  gaps: {
    dimension: "Coverage",
    label: "Coverage · gaps",
    title: "Required coverage has known retryable or terminal gaps.",
    tone: "warning",
    value: "gaps",
  },
  inventory_only: {
    dimension: "Coverage",
    label: "Coverage · inventory only",
    title:
      "The manifest declares that only inventory/discovery evidence is ever required here, not full detail. This is a settled, complete state for this stream — not partial progress.",
    tone: "neutral",
    value: "inventory only",
  },
  partial: {
    dimension: "Coverage",
    label: "Coverage · partial",
    title: "Some required streams collected only partial data.",
    tone: "warning",
    value: "partial",
  },
  retryable_gap: {
    dimension: "Coverage",
    label: "Coverage · retryable gap",
    title:
      "Some required detail is missing, but the runtime expects to fill it on a later run. Records already collected stay valid; no owner action is needed yet.",
    tone: "warning",
    value: "retryable gap",
  },
  terminal_gap: {
    dimension: "Coverage",
    label: "Coverage · won't backfill",
    title:
      "Some required detail will not backfill on its own — the connector or source cannot recover it without a change. Records already collected stay valid and usable; this is not current data loss. Open the connection's latest run to see which streams are affected and the recovery step.",
    tone: "danger",
    // "terminal gap" is jargon. The value stays short for the chip; the title
    // carries the three things the owner actually needs (per design-notes/
    // dashboard-health-semantics-and-reliability-2026-06-01.md): what state this
    // is, whether current records are safe, and what can recover coverage. The
    // reference's coverage condition carries a `Review source coverage gaps`
    // remediation but not the specific cause/stream/time — that contract gap is
    // noted in the workstream report; the per-stream detail lives in the latest
    // run's known_gaps, which the connection detail page links to.
    value: "won't backfill",
  },
  unavailable: {
    dimension: "Coverage",
    label: "Coverage · unavailable",
    title:
      "The manifest accepts that the source does not expose this coverage. This is a settled state, not a temporary gap awaiting a retry.",
    tone: "neutral",
    value: "unavailable",
  },
  unknown: {
    dimension: "Coverage",
    label: "Coverage · unknown",
    title: "No durable coverage evidence is available yet.",
    tone: "neutral",
    value: "unknown",
  },
  unsupported: {
    dimension: "Coverage",
    label: "Coverage · unsupported",
    title:
      "The manifest accepts that the connector cannot collect this coverage. This is a settled state, not a temporary gap awaiting a retry.",
    tone: "neutral",
    value: "unsupported",
  },
};

const FRESHNESS_LABELS: Record<FreshnessAxis, AxisChip> = {
  fresh: {
    dimension: "Freshness",
    label: "Freshness · fresh",
    title: "The last successful run is within policy.",
    tone: "success",
    value: "fresh",
  },
  stale: {
    dimension: "Freshness",
    label: "Freshness · stale",
    title: "The last successful run is outside the configured freshness window.",
    tone: "warning",
    value: "stale",
  },
  unknown: {
    dimension: "Freshness",
    label: "Freshness · unknown",
    title: "Freshness cannot be derived from current evidence.",
    tone: "neutral",
    value: "unknown",
  },
};

const OUTBOX_LABELS: Record<OutboxAxis, AxisChip> = {
  active: {
    dimension: "Outbox",
    label: "Outbox · active",
    title: "Outbound work is making progress.",
    // `active` means the local-device outbox is draining — a healthy,
    // progressing state. It previously shared `neutral` (muted grey) with
    // `unknown`, so an operator could not tell a draining outbox from one
    // whose evidence we could not read. `success` gives it a distinct,
    // non-alarming colour (the same green as `idle`); the value text
    // ("active" vs "idle") carries the finer distinction, and the row-level
    // pill still escalates an actively-draining outbox to a "Syncing" badge.
    tone: "success",
    value: "active",
  },
  idle: {
    dimension: "Outbox",
    label: "Outbox · idle",
    title: "No retryable outbound work is pending.",
    tone: "success",
    value: "idle",
  },
  stalled: {
    dimension: "Outbox",
    label: "Outbox · stalled",
    title: "Retryable outbound work is stalled and not progressing.",
    tone: "danger",
    value: "stalled",
  },
  unknown: {
    dimension: "Outbox",
    label: "Outbox · unknown",
    title: "Outbox state cannot be read from durable evidence.",
    tone: "neutral",
    value: "unknown",
  },
};

const ATTENTION_LABELS: Record<AttentionAxis, AxisChip | null> = {
  acknowledged: {
    dimension: "Attention",
    label: "Attention · acknowledged",
    title: "Owner action is acknowledged but not yet resolved.",
    tone: "warning",
    value: "acknowledged",
  },
  in_progress: {
    dimension: "Attention",
    label: "Attention · in progress",
    title: "Owner action is in progress.",
    tone: "warning",
    value: "in progress",
  },
  none: null,
  open: {
    dimension: "Attention",
    label: "Attention · open",
    title: "Owner action is open.",
    tone: "warning",
    value: "open",
  },
};

export function formatCoverageAxis(axis: CoverageAxis | null | string | undefined): AxisChip {
  return formatKnownAxis(COVERAGE_LABELS, axis, "unknown", "Coverage");
}

export function formatFreshnessAxis(axis: FreshnessAxis | null | string | undefined): AxisChip {
  return formatKnownAxis(FRESHNESS_LABELS, axis, "unknown", "Freshness");
}

export function formatOutboxAxis(axis: OutboxAxis | null | string | undefined): AxisChip {
  return formatKnownAxis(OUTBOX_LABELS, axis, "unknown", "Outbox");
}

export function formatAttentionAxis(axis: AttentionAxis | null | string | undefined): AxisChip | null {
  if (axis === null) {
    return null;
  }
  if (axis !== undefined && Object.hasOwn(ATTENTION_LABELS, axis)) {
    return ATTENTION_LABELS[axis as AttentionAxis];
  }
  return {
    dimension: "Attention",
    label: "Attention · unknown",
    title: `Unknown attention axis "${axis}" from the reference server.`,
    tone: "neutral",
    value: "unknown",
  };
}

function formatKnownAxis<T extends string>(
  labels: Record<T, AxisChip>,
  axis: T | null | string | undefined,
  fallback: T,
  labelPrefix: string
): AxisChip {
  if (axis !== null && axis !== undefined && Object.hasOwn(labels, axis)) {
    return labels[axis as T];
  }
  const fallbackChip = labels[fallback];
  if (axis === null) {
    return fallbackChip;
  }
  return {
    ...fallbackChip,
    dimension: labelPrefix,
    title: `Unknown ${labelPrefix.toLowerCase()} axis "${axis}" from the reference server.`,
    value: "unknown",
  };
}

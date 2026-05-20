/**
 * Pure formatting helpers that turn the reference's projected
 * `connection_health` snapshot plus auxiliary evidence (last run, last
 * successful run, schedule, structured next_action) into the small set
 * of owner-facing strings the dashboard renders.
 *
 * The dashboard MUST NOT invent state. These helpers:
 *   - never label coverage `complete` when the axis is `unknown`;
 *   - never render `0` records when evidence collection failed;
 *   - never render green/healthy when the projection itself is `unknown`;
 *   - surface a "projection unreliable" caveat when the spine told us
 *     evidence was missing or stale.
 *
 * Side-effect-free and pure so the row stays thin and is testable
 * without a browser harness.
 */

import type { RefConnectionHealthSnapshot, RefSchedule } from "./ref-client.ts";
import type { ConnectorOverview, ConnectorRunRef } from "./rs-client.ts";

export type EvidenceTone = "neutral" | "success" | "warning" | "danger";

export interface AxisChip {
  /** Short owner-facing label (e.g. "Coverage: gaps"). */
  label: string;
  /** Long-form hover/tooltip — describes what the chip means. */
  title: string;
  tone: EvidenceTone;
}

const COVERAGE_LABELS: Record<RefConnectionHealthSnapshot["axes"]["coverage"], AxisChip> = {
  complete: {
    label: "Coverage · complete",
    title: "All required streams have durable evidence of complete coverage.",
    tone: "success",
  },
  partial: {
    label: "Coverage · partial",
    title: "Some required streams collected only partial data.",
    tone: "warning",
  },
  gaps: {
    label: "Coverage · gaps",
    title: "Required coverage has known retryable or terminal gaps.",
    tone: "warning",
  },
  unknown: {
    label: "Coverage · unknown",
    title: "No durable coverage evidence is available yet.",
    tone: "neutral",
  },
};

const FRESHNESS_LABELS: Record<RefConnectionHealthSnapshot["axes"]["freshness"], AxisChip> = {
  fresh: {
    label: "Freshness · fresh",
    title: "The last successful run is within policy.",
    tone: "success",
  },
  stale: {
    label: "Freshness · stale",
    title: "The last successful run is outside the configured freshness window.",
    tone: "warning",
  },
  unknown: {
    label: "Freshness · unknown",
    title: "Freshness cannot be derived from current evidence.",
    tone: "neutral",
  },
};

const OUTBOX_LABELS: Record<RefConnectionHealthSnapshot["axes"]["outbox"], AxisChip> = {
  idle: {
    label: "Outbox · idle",
    title: "No retryable outbound work is pending.",
    tone: "success",
  },
  active: {
    label: "Outbox · active",
    title: "Outbound work is making progress.",
    tone: "neutral",
  },
  stalled: {
    label: "Outbox · stalled",
    title: "Retryable outbound work is stalled and not progressing.",
    tone: "danger",
  },
  unknown: {
    label: "Outbox · unknown",
    title: "Outbox state cannot be read from durable evidence.",
    tone: "neutral",
  },
};

const ATTENTION_LABELS: Record<RefConnectionHealthSnapshot["axes"]["attention"], AxisChip | null> = {
  none: null,
  open: {
    label: "Attention · open",
    title: "Owner action is open.",
    tone: "warning",
  },
  acknowledged: {
    label: "Attention · acknowledged",
    title: "Owner action is acknowledged but not yet resolved.",
    tone: "warning",
  },
  in_progress: {
    label: "Attention · in progress",
    title: "Owner action is in progress.",
    tone: "warning",
  },
};

export function formatCoverageAxis(axis: RefConnectionHealthSnapshot["axes"]["coverage"]): AxisChip {
  return COVERAGE_LABELS[axis];
}

export function formatFreshnessAxis(axis: RefConnectionHealthSnapshot["axes"]["freshness"]): AxisChip {
  return FRESHNESS_LABELS[axis];
}

export function formatOutboxAxis(axis: RefConnectionHealthSnapshot["axes"]["outbox"]): AxisChip {
  return OUTBOX_LABELS[axis];
}

export function formatAttentionAxis(axis: RefConnectionHealthSnapshot["axes"]["attention"]): AxisChip | null {
  return ATTENTION_LABELS[axis];
}

/**
 * Axes that meaningfully refine the headline pill. Order is the order
 * the chips render in. `attention=none` is omitted because the next-action
 * pill already carries that signal.
 */
export function summarizeAxisChips(axes: RefConnectionHealthSnapshot["axes"] | undefined | null): AxisChip[] {
  if (!axes) {
    return [];
  }
  const out: AxisChip[] = [formatCoverageAxis(axes.coverage), formatFreshnessAxis(axes.freshness)];
  const attention = formatAttentionAxis(axes.attention);
  if (attention) {
    out.push(attention);
  }
  // Outbox is a meaningful signal when it's stalled, or when it diverges
  // from the headline. We always show it so operators can see "why" the
  // pill is yellow.
  out.push(formatOutboxAxis(axes.outbox));
  return out;
}

export interface ProjectionFreshness {
  /** Hover/title text listing the unknown reasons. */
  detail: string;
  reasons: readonly string[];
  /** True when the spine told us evidence was missing or stale. */
  unreliable: boolean;
}

/**
 * Whether the projection itself is unreliable. The reference signals
 * this by setting `state === "unknown"` AND populating
 * `unknown_reasons`. We separate the two so the dashboard can warn
 * about partial unreliability (e.g. a schedule read failed) even when
 * the projection is otherwise usable.
 */
export function formatProjectionFreshness(
  snapshot: RefConnectionHealthSnapshot | null | undefined
): ProjectionFreshness {
  const reasons = snapshot?.unknown_reasons ?? [];
  if (reasons.length === 0) {
    return { unreliable: false, reasons: [], detail: "" };
  }
  const humanized = reasons.map(humanizeReason);
  return {
    unreliable: true,
    reasons: humanized,
    detail: `Projection evidence missing: ${humanized.join(", ")}.`,
  };
}

function humanizeReason(reason: string): string {
  const cleaned = reason.trim();
  if (cleaned.length === 0) {
    return reason;
  }
  return cleaned.replace(/[_-]+/g, " ");
}

export interface LastDurableProgress {
  /** When set, owner-facing label describing the last durable progress. */
  label: string;
  /**
   * True when we cannot honestly show progress (e.g. evidence collection
   * failed). Callers should render this as `—` / "Unavailable" rather
   * than substituting 0.
   */
  unavailable: boolean;
}

/**
 * Owner-facing label for the most recent durable progress.
 *
 * The rule:
 *   - if evidence collection failed (`hasError`), say "Unavailable";
 *   - else if there is a successful run, summarize its end time + event count;
 *   - else if there is any run, summarize the attempt + status;
 *   - else if records exist without run history, surface that explicitly;
 *   - else "Never run".
 *
 * Never returns `0` for event counts unless that count was actually observed.
 */
export function formatLastDurableProgress(input: {
  hasError: boolean;
  lastRun: ConnectorRunRef | null;
  lastSuccessfulRun: ConnectorRunRef | null;
  totalRecords: number;
}): LastDurableProgress {
  if (input.hasError) {
    return { label: "Last progress unavailable", unavailable: true };
  }
  if (input.lastSuccessfulRun) {
    const evt = input.lastSuccessfulRun.event_count;
    return {
      label: `Last success · ${evt.toLocaleString()} event${evt === 1 ? "" : "s"}`,
      unavailable: false,
    };
  }
  if (input.lastRun) {
    return {
      label: `Last attempt · ${input.lastRun.status.replace(/_/g, " ")}`,
      unavailable: false,
    };
  }
  if (input.totalRecords > 0) {
    return { label: "Records present · no run history", unavailable: false };
  }
  return { label: "Never run", unavailable: false };
}

export interface PendingWorkSummary {
  detail: string;
  pendingCount: number;
  /** Whether the row reports unreliable evidence for the count. */
  unreliable: boolean;
}

/**
 * Summarize pending work for an overview by reading the outbox axis.
 *
 * The reference's connector-summary projection does not currently expose
 * a numeric backlog at this level — the precise count lives in
 * device-exporter diagnostics. We therefore report a qualitative summary
 * here and reserve numeric pending counts for the per-source detail.
 */
export function summarizeOutboxForRow(
  snapshot: RefConnectionHealthSnapshot | null | undefined
): { label: string; tone: EvidenceTone } | null {
  if (!snapshot) {
    return null;
  }
  switch (snapshot.axes.outbox) {
    case "stalled":
      return { label: "Outbox stalled", tone: "danger" };
    case "active":
      return { label: "Outbox active", tone: "neutral" };
    case "unknown":
      return { label: "Outbox unknown", tone: "neutral" };
    case "idle":
      return null;
  }
}

export interface ScheduleSummary {
  /** Concise backoff blurb (only set when scheduler_backoff applies). */
  backoffLabel: string | null;
  enabled: boolean;
  /** Ineligibility reason if the schedule is enabled but ineligible. */
  ineligibilityReason: string | null;
  /** Effective mode (automatic | manual | paused). */
  mode: RefSchedule["effective_mode"];
  /** Concise next-attempt blurb, e.g. "Next attempt 3 min from now". */
  nextAttemptLabel: string | null;
}

export function summarizeSchedule(schedule: RefSchedule | null | undefined): ScheduleSummary | null {
  if (!schedule) {
    return null;
  }
  const backoff = schedule.scheduler_backoff;
  let backoffLabel: string | null = null;
  if (backoff?.backoff_applied) {
    const reason = backoff.reason_class ? ` (${backoff.reason_class.replace(/[_-]+/g, " ")})` : "";
    const failures = backoff.consecutive_failures;
    backoffLabel = `Backoff applied${reason} · ${failures} consecutive failure${failures === 1 ? "" : "s"}`;
  }
  return {
    enabled: schedule.enabled,
    nextAttemptLabel: schedule.next_due_at ? `Next attempt ${schedule.next_due_at}` : null,
    backoffLabel,
    ineligibilityReason: schedule.ineligibility_reason,
    mode: schedule.effective_mode,
  };
}

export interface RecordCountDisplay {
  /** What to render in the row. `null` = render an em-dash placeholder. */
  label: string | null;
  /** True when the underlying count is honest. */
  reliable: boolean;
  title: string;
}

/**
 * Resolve how to display the records count for a connector row.
 *
 * The crucial honest-by-default rule: when the overview reports an
 * evidence-collection error, do NOT render `0`. Render a placeholder
 * and a hover tooltip explaining why.
 *
 * Also: when the connection projection is `unknown`, the records count
 * we see may not yet be consistent with the spine. Surface that as a
 * tooltip but still render the numeric count (records-in-store is
 * canonical evidence, not a projection).
 */
export function resolveRecordCountDisplay(overview: ConnectorOverview): RecordCountDisplay {
  if (overview.error) {
    return {
      label: null,
      reliable: false,
      title: `Records count unavailable: ${overview.error}`,
    };
  }
  return {
    label: overview.totalRecords.toLocaleString(),
    reliable: true,
    title: `${overview.totalRecords.toLocaleString()} records ingested`,
  };
}

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

import type {
  DeviceSourceInstance,
  RefConnectionHealthSnapshot,
  RefLocalDeviceProgress,
  RefSchedule,
} from "./ref-client.ts";
import type { ConnectorOverview, ConnectorRunRef } from "./rs-client.ts";

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

const COVERAGE_LABELS: Record<RefConnectionHealthSnapshot["axes"]["coverage"], AxisChip> = {
  complete: {
    dimension: "Coverage",
    value: "complete",
    label: "Coverage · complete",
    title: "All required streams have durable evidence of complete coverage.",
    tone: "success",
  },
  deferred: {
    dimension: "Coverage",
    value: "deferred",
    label: "Coverage · deferred",
    title: "The manifest intentionally defers this coverage; no detail collection is owed yet.",
    tone: "neutral",
  },
  partial: {
    dimension: "Coverage",
    value: "partial",
    label: "Coverage · partial",
    title: "Some required streams collected only partial data.",
    tone: "warning",
  },
  gaps: {
    dimension: "Coverage",
    value: "gaps",
    label: "Coverage · gaps",
    title: "Required coverage has known retryable or terminal gaps.",
    tone: "warning",
  },
  inventory_only: {
    dimension: "Coverage",
    value: "inventory only",
    label: "Coverage · inventory only",
    title: "The manifest only requires discovery/inventory evidence for this source.",
    tone: "neutral",
  },
  retryable_gap: {
    dimension: "Coverage",
    value: "retryable gap",
    label: "Coverage · retryable gap",
    title: "Required detail has a pending gap that should be retried.",
    tone: "warning",
  },
  terminal_gap: {
    dimension: "Coverage",
    value: "terminal gap",
    label: "Coverage · terminal gap",
    title: "Required detail has a known terminal gap until connector or source support changes.",
    tone: "danger",
  },
  unavailable: {
    dimension: "Coverage",
    value: "unavailable",
    label: "Coverage · unavailable",
    title: "The manifest accepts that this coverage is unavailable from the source.",
    tone: "neutral",
  },
  unknown: {
    dimension: "Coverage",
    value: "unknown",
    label: "Coverage · unknown",
    title: "No durable coverage evidence is available yet.",
    tone: "neutral",
  },
  unsupported: {
    dimension: "Coverage",
    value: "unsupported",
    label: "Coverage · unsupported",
    title: "The manifest accepts that this coverage is not supported by the source or connector.",
    tone: "neutral",
  },
};

const FRESHNESS_LABELS: Record<RefConnectionHealthSnapshot["axes"]["freshness"], AxisChip> = {
  fresh: {
    dimension: "Freshness",
    value: "fresh",
    label: "Freshness · fresh",
    title: "The last successful run is within policy.",
    tone: "success",
  },
  stale: {
    dimension: "Freshness",
    value: "stale",
    label: "Freshness · stale",
    title: "The last successful run is outside the configured freshness window.",
    tone: "warning",
  },
  unknown: {
    dimension: "Freshness",
    value: "unknown",
    label: "Freshness · unknown",
    title: "Freshness cannot be derived from current evidence.",
    tone: "neutral",
  },
};

const OUTBOX_LABELS: Record<RefConnectionHealthSnapshot["axes"]["outbox"], AxisChip> = {
  idle: {
    dimension: "Outbox",
    value: "idle",
    label: "Outbox · idle",
    title: "No retryable outbound work is pending.",
    tone: "success",
  },
  active: {
    dimension: "Outbox",
    value: "active",
    label: "Outbox · active",
    title: "Outbound work is making progress.",
    tone: "neutral",
  },
  stalled: {
    dimension: "Outbox",
    value: "stalled",
    label: "Outbox · stalled",
    title: "Retryable outbound work is stalled and not progressing.",
    tone: "danger",
  },
  unknown: {
    dimension: "Outbox",
    value: "unknown",
    label: "Outbox · unknown",
    title: "Outbox state cannot be read from durable evidence.",
    tone: "neutral",
  },
};

const ATTENTION_LABELS: Record<RefConnectionHealthSnapshot["axes"]["attention"], AxisChip | null> = {
  none: null,
  open: {
    dimension: "Attention",
    value: "open",
    label: "Attention · open",
    title: "Owner action is open.",
    tone: "warning",
  },
  acknowledged: {
    dimension: "Attention",
    value: "acknowledged",
    label: "Attention · acknowledged",
    title: "Owner action is acknowledged but not yet resolved.",
    tone: "warning",
  },
  in_progress: {
    dimension: "Attention",
    value: "in progress",
    label: "Attention · in progress",
    title: "Owner action is in progress.",
    tone: "warning",
  },
};

export function formatCoverageAxis(
  axis: RefConnectionHealthSnapshot["axes"]["coverage"] | null | string | undefined
): AxisChip {
  return formatKnownAxis(COVERAGE_LABELS, axis, "unknown", "Coverage");
}

export function formatFreshnessAxis(
  axis: RefConnectionHealthSnapshot["axes"]["freshness"] | null | string | undefined
): AxisChip {
  return formatKnownAxis(FRESHNESS_LABELS, axis, "unknown", "Freshness");
}

export function formatOutboxAxis(
  axis: RefConnectionHealthSnapshot["axes"]["outbox"] | null | string | undefined
): AxisChip {
  return formatKnownAxis(OUTBOX_LABELS, axis, "unknown", "Outbox");
}

export function formatAttentionAxis(
  axis: RefConnectionHealthSnapshot["axes"]["attention"] | null | string | undefined
): AxisChip | null {
  if (axis == null) {
    return null;
  }
  if (Object.hasOwn(ATTENTION_LABELS, axis)) {
    return ATTENTION_LABELS[axis as RefConnectionHealthSnapshot["axes"]["attention"]];
  }
  return {
    dimension: "Attention",
    value: "unknown",
    label: "Attention · unknown",
    title: `Unknown attention axis "${axis}" from the reference server.`,
    tone: "neutral",
  };
}

function formatKnownAxis<T extends string>(
  labels: Record<T, AxisChip>,
  axis: T | null | string | undefined,
  fallback: T,
  labelPrefix: string
): AxisChip {
  if (axis != null && Object.hasOwn(labels, axis)) {
    return labels[axis as T];
  }
  const fallbackChip = labels[fallback];
  if (axis == null) {
    return fallbackChip;
  }
  return {
    ...fallbackChip,
    dimension: labelPrefix,
    value: "unknown",
    title: `Unknown ${labelPrefix.toLowerCase()} axis "${axis}" from the reference server.`,
  };
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

export interface DominantConditionSummary {
  label: string;
  title: string;
  tone: EvidenceTone;
}

export function formatDominantCondition(
  snapshot: RefConnectionHealthSnapshot | null | undefined
): DominantConditionSummary | null {
  const condition = dominantCondition(snapshot);
  if (!condition || condition.status !== "false") {
    return null;
  }
  const remediation = condition.remediation?.label ? ` ${condition.remediation.label}.` : "";
  return {
    label: condition.message,
    title: `${humanizeReason(condition.reason)}. ${condition.message}.${remediation}`.trim(),
    tone: toneForConditionSeverity(condition.severity),
  };
}

function dominantCondition(snapshot: RefConnectionHealthSnapshot | null | undefined) {
  const conditions = snapshot?.conditions ?? [];
  const dominantId = snapshot?.dominant_condition_id ?? null;
  if (dominantId) {
    const found = conditions.find((condition) => condition.id === dominantId);
    if (found) {
      return found;
    }
  }
  return conditions.find((condition) => condition.status === "false") ?? null;
}

function toneForConditionSeverity(severity: string): EvidenceTone {
  if (severity === "blocked" || severity === "error") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "neutral";
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
 *   - else if a local-device exporter has reported a durable ingest or
 *     heartbeat, surface that (push-mode collectors bypass
 *     `scheduler_run_history` and land here);
 *   - else if records exist with no other evidence, say so explicitly;
 *   - else "Never run".
 *
 * Never returns `0` for event counts unless that count was actually observed.
 */
export function formatLastDurableProgress(input: {
  hasError: boolean;
  lastRun: ConnectorRunRef | null;
  lastSuccessfulRun: ConnectorRunRef | null;
  localDeviceProgress?: RefLocalDeviceProgress | null;
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
  // Push-mode local-device exporters: any trusted heartbeat / ingest is
  // durable progress, even without a scheduler-managed run.
  const lastIngestAt = input.localDeviceProgress?.last_ingest_at ?? null;
  const lastHeartbeatAt = input.localDeviceProgress?.last_heartbeat_at ?? null;
  if (lastIngestAt) {
    return { label: `Last ingest · ${lastIngestAt}`, unavailable: false };
  }
  if (lastHeartbeatAt) {
    return { label: `Last checked · ${lastHeartbeatAt}`, unavailable: false };
  }
  if (input.totalRecords > 0) {
    // Records exist without a scheduler-managed run and without a trusted
    // heartbeat — honest but non-specific.
    return { label: "Records present · no scheduler run yet", unavailable: false };
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
    default:
      return null;
  }
}

export function formatSourceOutboxState(
  source: Pick<DeviceSourceInstance, "outbox_diagnostics" | "outbox_state">
): AxisChip {
  const state = source.outbox_state ?? "unknown";
  const diagnostics = source.outbox_diagnostics ?? null;
  const counts = diagnostics
    ? [
        `pending ${diagnostics.pending ?? 0}`,
        `retrying ${diagnostics.retrying ?? 0}`,
        `stale ${diagnostics.stale_leases ?? 0}`,
        `dead-letter ${diagnostics.dead_letter ?? 0}`,
        `backlog ${diagnostics.backlog_open ?? 0}`,
      ].join(" · ")
    : "no granular outbox diagnostics reported";

  switch (state) {
    case "dead_letter":
      return {
        dimension: "Outbox",
        value: "dead-letter",
        label: "Outbox · dead-letter",
        title: counts,
        tone: "danger",
      };
    case "stale":
      return {
        dimension: "Outbox",
        value: "stale lease",
        label: "Outbox · stale lease",
        title: counts,
        tone: "danger",
      };
    case "retrying":
      return { dimension: "Outbox", value: "retrying", label: "Outbox · retrying", title: counts, tone: "warning" };
    case "pending":
      return { dimension: "Outbox", value: "pending", label: "Outbox · pending", title: counts, tone: "neutral" };
    case "backlog":
      return { dimension: "Outbox", value: "backlog", label: "Outbox · backlog", title: counts, tone: "warning" };
    case "drained":
      return { dimension: "Outbox", value: "drained", label: "Outbox · drained", title: counts, tone: "success" };
    case "unknown":
      return { dimension: "Outbox", value: "unknown", label: "Outbox · unknown", title: counts, tone: "neutral" };
    default:
      return { dimension: "Outbox", value: "unknown", label: "Outbox · unknown", title: counts, tone: "neutral" };
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

/**
 * Owner-facing pill for the records row.
 *
 * The reference server projects a single connection-health `state` over a
 * deliberately decomplected evidence model: readiness, freshness,
 * coverage, attention, scheduler backoff, outbox state, and projection
 * reliability are separate axes/conditions, and the projection chooses
 * one dominant verdict. The dashboard SHOULD NOT recomplect them into a
 * UX that contradicts the model. In particular:
 *
 * - "Healthy" is a health verdict. The spine emits it only when coverage
 *   is complete, freshness is fresh, backlog is clear, and projection
 *   evidence is current.
 * - The spine's `idle` is NOT a health verdict: it means "no terminal
 *   collection verdict yet, and nothing stronger is wrong." Surfacing it
 *   as "Idle" alongside "Healthy" reads as a comparable health state
 *   and misleads operators. We translate it to "Awaiting first sync"
 *   (no durable progress) or "Ready" (durable progress exists) so the
 *   operator reads it as a readiness statement, not a data-health or
 *   activity statement.
 * - Push-mode local collectors land in spine `idle` when there is no
 *   terminal scheduler run, even when device ingest exists. The headline
 *   stays readiness-oriented ("Ready") and the row's progress line shows
 *   last checked / last ingest timing. Only an actively-draining outbox
 *   becomes "Syncing".
 * - Failures, blocked, cooling_off, degraded, and needs_attention pass
 *   through with strong vocabulary so the operator can see why.
 *
 * The shape of the return is intentionally narrow: label, tooltip,
 * tone, and shape — everything the row needs to render the pill. Tests
 * exercise this function directly without a JSX harness.
 */
export interface ConnectionStatusDisplay {
  label: string;
  shape?: "circle" | "diamond" | "triangle";
  title: string;
  tone: "danger" | "neutral" | "running" | "success" | "warning";
}

export function deriveConnectionStatusDisplay(input: {
  hasDurableProgress: boolean;
  health: RefConnectionHealthSnapshot;
  localDeviceProgress?: RefLocalDeviceProgress | null;
}): ConnectionStatusDisplay {
  const { hasDurableProgress, health, localDeviceProgress } = input;
  const reason = health.reason_code ? ` · ${health.reason_code}` : "";
  const dominant = dominantConditionTitle(health);
  switch (health.state) {
    case "healthy":
      if (!hasDurableProgress) {
        return {
          label: "Ready",
          title: "Readiness checks pass, but this connection has no retained records yet.",
          tone: "neutral",
        };
      }
      return { label: "Healthy", title: "Required coverage is current and complete.", tone: "success" };
    case "needs_attention":
      return {
        label: "Needs attention",
        shape: "diamond",
        title: dominant ?? `Owner action required${reason}.`,
        tone: "warning",
      };
    case "cooling_off":
      return {
        label: "Cooling off",
        shape: "diamond",
        title: dominant ?? `Waiting before the next retry${reason}.`,
        tone: "warning",
      };
    case "blocked":
      return {
        label: "Blocked",
        shape: "triangle",
        title: dominant ?? `Cannot make progress${reason}.`,
        tone: "danger",
      };
    case "degraded": {
      const partial = health.axes.coverage === "gaps" || health.axes.coverage === "partial";
      return {
        label: partial ? "Partial" : "Degraded",
        shape: "diamond",
        title: dominant ?? `Useful data may exist, but coverage or freshness is incomplete${reason}.`,
        tone: "warning",
      };
    }
    case "idle":
      return idleDisplay({ hasDurableProgress, health, localDeviceProgress });
    case "unknown":
      return {
        label: "Unknown",
        title:
          health.unknown_reasons.length > 0
            ? `Projection evidence missing: ${health.unknown_reasons.join(", ")}.`
            : "Projection evidence is incomplete.",
        tone: "neutral",
      };
    default:
      return {
        label: "Unknown",
        title: "Projection evidence is incomplete.",
        tone: "neutral",
      };
  }
}

function idleDisplay(input: {
  hasDurableProgress: boolean;
  health: RefConnectionHealthSnapshot;
  localDeviceProgress?: RefLocalDeviceProgress | null;
}): ConnectionStatusDisplay {
  const { hasDurableProgress, health, localDeviceProgress } = input;
  // The spine projects `idle` for two distinct shapes:
  //   1. an intentionally paused schedule (`ScheduleEligible=false`), and
  //   2. "no terminal collection verdict yet, nothing wrong" — the
  //      common case for push-mode local collectors that have not run
  //      under the scheduler, and for fresh connections before their
  //      first run finishes.
  // The pill should describe readiness, not activity or health, in this
  // branch — labeling it "Idle" alongside "Healthy" misleads operators
  // into reading it as a comparable health verdict.
  if (health.axes.outbox === "active") {
    return {
      label: "Syncing",
      title: "The local-device outbox is draining. This connection is actively receiving work from the device.",
      tone: "running",
    };
  }
  if (hasDurableProgress) {
    if (localDeviceProgress?.last_heartbeat_status === "healthy" || localDeviceProgress?.last_heartbeat_at) {
      return {
        label: "Ready",
        title: "The local collector has checked in. Last ingest and device activity are shown on the progress line.",
        tone: "neutral",
      };
    }
    return {
      label: "Ready",
      title:
        "Records exist for this connection, and no active collection issue is known. The progress line shows the latest durable evidence.",
      tone: "neutral",
    };
  }
  return {
    label: "Awaiting first sync",
    title: "No durable progress yet for this connection. Trigger a sync to populate it.",
    tone: "neutral",
  };
}

function dominantConditionTitle(snapshot: RefConnectionHealthSnapshot): string | null {
  const summary = formatDominantCondition(snapshot);
  return summary?.title ?? null;
}

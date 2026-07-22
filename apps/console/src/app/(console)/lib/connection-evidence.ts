// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { formatTotalRecordsLabel, isTotalRecordsAuthoritative } from "../sources/sources-view-model.ts";
import type {
  DeviceSourceInstance,
  RefCollectionRateSnapshot,
  RefConnectionHealthSnapshot,
  RefDetailGapBacklog,
  RefForwardDisposition,
  RefLocalDeviceProgress,
  RefRenderedVerdict,
  RefRequiredAction,
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

const FRESHNESS_LABELS: Record<RefConnectionHealthSnapshot["axes"]["freshness"], AxisChip> = {
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

const OUTBOX_LABELS: Record<RefConnectionHealthSnapshot["axes"]["outbox"], AxisChip> = {
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

const ATTENTION_LABELS: Record<RefConnectionHealthSnapshot["axes"]["attention"], AxisChip | null> = {
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
    title: `Unknown ${labelPrefix.toLowerCase()} axis "${axis}" from the reference server.`,
    value: "unknown",
  };
}

/**
 * Whether the outbox axis is meaningful for this connection.
 *
 * The reference computes the outbox axis ONLY from local-device exporter
 * heartbeats (`getConnectorOutboxAxis` → `projectConnectorOutboxAxisFrom
 * heartbeats`). A connector with no device-exporter rows — every API/OAuth and
 * browser-bound connection — has no heartbeats, so the reference projects
 * `outbox: "unknown"` as a *default of absence*, not a real signal. Rendering
 * that as an "Outbox · unknown" chip on, say, a Gmail or Chase connection is the
 * mysterious axis owners reported on 2026-06-01.
 *
 * The honest rule (per design-notes/dashboard-health-semantics-and-reliability-
 * 2026-06-01.md): show the outbox axis only for local/device-backed
 * connections. The console's available signal is the connection-summary
 * `local_device_progress` row, which the reference populates exactly when
 * `instance.sourceKind === "local_device"`. We also keep the axis when it
 * carries a real verdict (`stalled` / `active` / `idle`) regardless of that
 * signal, so a genuine local-collector state is never hidden — only the
 * absence-default `unknown` is suppressed for non-local connections.
 */
export function outboxAxisIsApplicable(
  axis: RefConnectionHealthSnapshot["axes"]["outbox"] | null | string | undefined,
  isLocalDeviceBacked: boolean
): boolean {
  // A concrete outbox verdict is always worth showing.
  if (axis === "stalled" || axis === "active" || axis === "idle") {
    return true;
  }
  // `unknown` (or any absence-default) is only meaningful for a connection that
  // actually has a local-device outbox whose evidence we could not read.
  return isLocalDeviceBacked;
}

/**
 * Axes that meaningfully refine the headline pill. Order is the order
 * the chips render in. `attention=none` is omitted because the next-action
 * pill already carries that signal.
 *
 * `isLocalDeviceBacked` gates the outbox axis: pass `true` when the connection
 * has a `local_device_progress` row (or is otherwise known to be a
 * local/device-backed collector). When `false`, an absence-default
 * `outbox: "unknown"` is omitted so non-local connections never render a
 * mysterious unknown outbox axis. Defaults to `false` (the common,
 * non-local case) so callers that do not yet thread the signal stay honest.
 */
export function summarizeAxisChips(
  axes: RefConnectionHealthSnapshot["axes"] | undefined | null,
  options: { isLocalDeviceBacked?: boolean } = {}
): AxisChip[] {
  if (!axes) {
    return [];
  }
  const out: AxisChip[] = [formatCoverageAxis(axes.coverage), formatFreshnessAxis(axes.freshness)];
  const attention = formatAttentionAxis(axes.attention);
  if (attention) {
    out.push(attention);
  }
  // Outbox is meaningful only for local/device-backed connections (and whenever
  // it carries a concrete verdict). For everything else the reference defaults
  // it to `unknown` simply because there are no heartbeats — we omit that rather
  // than show a mysterious axis.
  if (outboxAxisIsApplicable(axes.outbox, options.isLocalDeviceBacked ?? false)) {
    const outbox = formatOutboxAxis(axes.outbox);
    // Sharpen the copy for the one case that survives the gate as `unknown`: a
    // local-device connection whose outbox evidence failed to load. The bare
    // "Outbox state cannot be read from durable evidence" is right, but a
    // local-backed operator benefits from the "evidence unavailable" framing.
    if (axes.outbox === "unknown") {
      out.push({
        ...outbox,
        label: "Outbox · evidence unavailable",
        title:
          "This local collector's outbox evidence could not be read right now. It is not a current data-loss signal; retry, or open the connection's diagnostics for the device state.",
        value: "evidence unavailable",
      });
    } else {
      out.push(outbox);
    }
  }
  return out;
}

/**
 * Owner-facing copy for the connection-level forward disposition — the
 * reference's single answer to "what is the next run expected to do?". This is
 * deliberately NOT another axis chip: coverage / freshness / outbox / attention
 * each describe one dimension of the *current* state, whereas the disposition
 * fuses them into a forward statement. The dashboard renders it as one short
 * line so the two never blur together.
 *
 * Wording stays protocol/reference-accurate: the reference describes what a
 * run on the owner's own instance is expected to do. It never promises a
 * hosted sync service ("we'll refresh nightly"), and the label is connector-
 * agnostic — the same disposition values mean the same thing for every connector.
 */
export interface ForwardDispositionSummary {
  /**
   * Short bare label for the line, e.g. "nothing owed". The renderer supplies
   * the "Next run:" lead-in, so the label stays free of it.
   */
  label: string;
  /** Whether the owner must act before a run can make progress. */
  ownerActionNeeded: boolean;
  /** Long-form hover/title describing what the next run does. */
  title: string;
  tone: EvidenceTone;
  /** The bare disposition value, kept for data-attributes and tooltips. */
  value: RefForwardDisposition;
}

const FORWARD_DISPOSITION_LABELS: Record<RefForwardDisposition, ForwardDispositionSummary> = {
  awaiting_owner: {
    label: "blocked on you",
    ownerActionNeeded: true,
    title:
      "A coverage gap is blocked on open owner attention (such as re-auth or a prompt). A run cannot make progress until you act; open the connection's attention to resolve it.",
    tone: "warning",
    value: "awaiting_owner",
  },
  checking: {
    label: "checking coverage",
    ownerActionNeeded: false,
    title:
      "Active work is expected to produce coverage evidence. This is a checking state, not an owner-action prompt.",
    tone: "neutral",
    value: "checking",
  },
  complete: {
    label: "nothing owed",
    ownerActionNeeded: false,
    title:
      "Coverage is established and fresh. A future run re-checks the source but is not expected to collect anything new or fill a gap.",
    tone: "success",
    value: "complete",
  },
  owner_refresh_due: {
    label: "refresh due",
    ownerActionNeeded: true,
    title:
      "Coverage is complete but the retained data has gone stale, and this connection needs an owner-initiated run to refresh — either because it refreshes only when you run it, or because it refreshes on schedule but may need your bounded help to catch up. Start a run on your instance to bring it current. This is aged data, not missing data.",
    tone: "warning",
    value: "owner_refresh_due",
  },
  resumable: {
    label: "resumes collection",
    ownerActionNeeded: false,
    title:
      "There is outstanding work an ordinary future run is expected to pick up — an open boundary or retryable gap. Records already collected stay valid; no owner action is needed.",
    tone: "warning",
    value: "resumable",
  },
  terminal: {
    label: "won't backfill",
    ownerActionNeeded: false,
    title:
      "An outstanding gap will not backfill on its own — the source or connector cannot recover it without a change. Records already collected stay valid and usable; open the latest run to see which streams are affected.",
    tone: "danger",
    value: "terminal",
  },
  unmeasured: {
    label: "not measured",
    ownerActionNeeded: false,
    title:
      "Coverage evidence is not available in the latest report. This is not an owner-action prompt and not an active checking state.",
    tone: "neutral",
    value: "unmeasured",
  },
};

/**
 * Format the connection-level forward disposition for display. Returns `null`
 * when the reference did not supply the field (e.g. a reference predating
 * `define-connector-progress-evidence-contract`), so the console renders nothing
 * rather than inventing a disposition. An unrecognized value is surfaced
 * honestly as a neutral "unknown to this console" line rather than dropped.
 */
export function formatForwardDisposition(
  disposition: RefForwardDisposition | null | string | undefined
): ForwardDispositionSummary | null {
  if (disposition == null) {
    return null;
  }
  if (Object.hasOwn(FORWARD_DISPOSITION_LABELS, disposition)) {
    return FORWARD_DISPOSITION_LABELS[disposition as RefForwardDisposition];
  }
  return {
    label: "unknown",
    ownerActionNeeded: false,
    title: `The reference reported a forward disposition "${disposition}" this console does not recognize.`,
    tone: "neutral",
    value: disposition as RefForwardDisposition,
  };
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
    return { detail: "", reasons: [], unreliable: false };
  }
  const humanized = reasons.map(humanizeReason);
  return {
    detail: `Projection evidence missing: ${humanized.join(", ")}.`,
    reasons: humanized,
    unreliable: true,
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

/**
 * Operator remediation for a stalled local-device outbox.
 *
 * The reference projects `outbox === "stalled"` and a `clear_backlog`
 * condition (with a `remediation.label`) when retryable outbound work on a
 * local collector host is no longer progressing. The dashboard cannot fix a
 * device-local outbox remotely — only the operator, on the host, can. So this
 * helper turns that projection into a *visible* next step:
 *
 *   - the reference's own `remediation.label` as readable copy (today it only
 *     appears in hover/title text), and
 *   - a deterministic, non-secret local command the operator runs on the host.
 *
 * It returns `null` for healthy / idle / active / unknown outboxes so we never
 * add remediation noise to a connection that is fine or whose state we cannot
 * read. The trigger is intentionally narrow: a stalled outbox axis, or a
 * current `clear_backlog` remediation that the projection surfaced as a
 * blocking condition.
 */
export interface OutboxStallRemediation {
  /** The reference-authored operator copy, e.g. "Inspect the local collector backlog". */
  label: string;
  /**
   * The condition reason backing the remediation, humanized for a tooltip.
   * Null when the trigger was the outbox axis alone (no matching condition).
   */
  reason: string | null;
  /**
   * Count-backed scale of the stuck work, when the connection summary
   * carries a rollup of the device-reported outbox diagnostics. `null` when
   * no counts are available, so the panel never renders a misleading "0
   * records" or implies precision the reference did not provide.
   */
  scale: string | null;
}

/**
 * Render the device-reported outbox count rollup as one short operator line,
 * e.g. "12 pending · 2 failed uploads · 1 stale lease". Only the
 * decision-relevant, non-zero categories are shown so a healthy-but-counted
 * rollup does not read as alarming. Returns `null` when the rollup is absent
 * or carries no positive counts.
 */
function formatOutboxCountScale(counts: RefLocalDeviceProgress["outbox_counts"] | null | undefined): string | null {
  if (!counts) {
    return null;
  }
  const parts: string[] = [];
  const pending = counts.pending ?? 0;
  const retrying = counts.retrying ?? 0;
  const staleLeases = counts.stale_leases ?? 0;
  const deadLetter = counts.dead_letter ?? 0;
  const backlog = counts.backlog_open ?? 0;
  if (pending > 0) {
    parts.push(`${pending.toLocaleString()} pending`);
  }
  if (retrying > 0) {
    parts.push(`${retrying.toLocaleString()} retrying`);
  }
  if (staleLeases > 0) {
    parts.push(`${staleLeases.toLocaleString()} stale lease${staleLeases === 1 ? "" : "s"}`);
  }
  if (deadLetter > 0) {
    parts.push(`${deadLetter.toLocaleString()} failed upload${deadLetter === 1 ? "" : "s"}`);
  }
  if (backlog > 0) {
    parts.push(`${backlog.toLocaleString()} backlog`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Render the reference's source-pressure detail-gap backlog rollup
 * ({@link RefDetailGapBacklog}) as one short, honest operator line for the
 * scheduler-managed `cooling_off` / `retryable_gap` paths. It is the
 * scheduler-side analogue of {@link formatOutboxCountScale}, and obeys the same
 * "never invent precision" discipline plus the backlog's own honesty contract:
 *
 *   - `null`/absent backlog → `null`. The reference could not read the durable
 *     gap store, so we say nothing rather than fabricate "0 left".
 *   - `pending > 0` → a count, made a floor ("at least N") when
 *     `pending_is_floor` is set, because the durable read was bounded. The
 *     `next_attempt_at` retry floor is appended as a resume time, framed as
 *     "resumes after …" so it never overpromises automatic completion.
 *   - `pending === 0` with `pending_other > 0` → do not say "caught up";
 *     source-pressure gaps may be clear, but budget/cap-deferred detail work
 *     remains pending.
 *   - `pending === 0` with a positive `recovered` → reads as drained/caught up
 *     ("caught up — N recovered"), not broken.
 *   - `pending === 0` with no recovered aggregate → "caught up" (the readable-
 *     but-drained `0`, distinct from the `null` "unmeasured" case above).
 *
 * Returns the line, or `null` to render no backlog cue.
 */
function positiveInteger(value: unknown): number {
  return typeof value === "number" && value > 0 ? Math.floor(value) : 0;
}

function backlogCount(count: number, noun: string, isFloor: boolean | null | undefined): string {
  return isFloor ? `at least ${count.toLocaleString()} ${noun}` : `${count.toLocaleString()} ${noun}`;
}

function formatPendingSourcePressureBacklog(backlog: RefDetailGapBacklog): string | null {
  const pending = positiveInteger(backlog.pending);
  if (pending === 0) {
    return null;
  }
  const noun = pending === 1 ? "detail item" : "detail items";
  const line = `${backlogCount(pending, noun, backlog.pending_is_floor)} to catch up`;
  // The backlog's own `next_attempt_at` is its retry floor (Retry-After /
  // cooldown), set even for manual connectors whose scheduler dispatch is null.
  // Frame it as a resume floor, never a completion promise.
  return backlog.next_attempt_at ? `${line} · resumes after ${backlog.next_attempt_at}` : line;
}

function formatOtherPendingBacklog(backlog: RefDetailGapBacklog): string | null {
  const pendingOther = positiveInteger(backlog.pending_other);
  if (pendingOther === 0) {
    return null;
  }
  const noun = pendingOther === 1 ? "other detail item" : "other detail items";
  return `${backlogCount(pendingOther, noun, backlog.pending_other_is_floor)} still pending`;
}

function formatTerminalBacklog(backlog: RefDetailGapBacklog): string | null {
  // §6.3 (corrected by red-team §10-A): "done" requires terminal===0. If the
  // reference reports terminal gaps, the honest copy is NOT "caught up" but
  // "recovered everything still available; N items no longer retrievable."
  // Older projections omit the field — treat absence/null as zero so we never
  // emit a false caveat against servers that don't yet track terminal gaps.
  const terminalCount = positiveInteger(backlog.terminal);
  if (terminalCount === 0) {
    return null;
  }
  const noun = terminalCount === 1 ? "item is" : "items are";
  const recovered = positiveInteger(backlog.recovered);
  const recoveredClause = recovered > 0 ? ` (${recovered.toLocaleString()} recovered)` : "";
  return `recovered all still-available${recoveredClause} — ${terminalCount.toLocaleString()} ${noun} no longer retrievable at the source`;
}

function formatSourcePressureBacklogScale(backlog: RefDetailGapBacklog | null | undefined): string | null {
  // `null`/absent means the durable gap store was unreadable (unmeasured). Never
  // invent a count: stay silent and let the surrounding copy carry the state.
  if (!backlog) {
    return null;
  }
  const activeBacklog =
    formatPendingSourcePressureBacklog(backlog) ?? formatOtherPendingBacklog(backlog) ?? formatTerminalBacklog(backlog);
  if (activeBacklog) {
    return activeBacklog;
  }
  // A readable, drained backlog (real `0`, terminal===0). When the reference
  // also produced a recovered count, surface it so the drained state reads as
  // caught-up progress rather than an empty / broken cue.
  const recovered = positiveInteger(backlog.recovered);
  if (recovered > 0) {
    return `caught up — ${recovered.toLocaleString()} recovered`;
  }
  return "caught up";
}

export function summarizeOutboxStallRemediation(
  snapshot: RefConnectionHealthSnapshot | null | undefined,
  localDeviceProgress?: RefLocalDeviceProgress | null
): OutboxStallRemediation | null {
  if (!snapshot) {
    return null;
  }
  const backlogCondition = (snapshot.conditions ?? []).find(
    (condition) => condition.status === "false" && condition.remediation?.action === "clear_backlog"
  );
  if (!backlogCondition) {
    return null;
  }

  // Render recovery only from the server-owned control action. A raw stalled
  // axis can lag terminal reconciliation and should not create a recovery loop.
  const label = backlogCondition.remediation?.label ?? "Inspect the local collector backlog";
  return {
    label,
    reason: humanizeReason(backlogCondition.reason),
    // Count-backed scale is only ever attached to the stalled-remediation
    // path. Healthy / idle / active / unknown outboxes return `null` above, so
    // counts never appear on a quiet connection.
    scale: formatOutboxCountScale(localDeviceProgress?.outbox_counts),
  };
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
        `failed upload ${diagnostics.dead_letter ?? 0}`,
        `backlog ${diagnostics.backlog_open ?? 0}`,
      ].join(" · ")
    : "no granular outbox diagnostics reported";

  switch (state) {
    case "dead_letter":
      return {
        dimension: "Outbox",
        label: "Outbox · failed uploads",
        title: counts,
        tone: "danger",
        value: "failed uploads",
      };
    case "stale":
      return {
        dimension: "Outbox",
        label: "Outbox · stale lease",
        title: counts,
        tone: "danger",
        value: "stale lease",
      };
    case "retrying":
      return { dimension: "Outbox", label: "Outbox · retrying", title: counts, tone: "warning", value: "retrying" };
    case "pending":
      return { dimension: "Outbox", label: "Outbox · pending", title: counts, tone: "neutral", value: "pending" };
    case "backlog":
      return { dimension: "Outbox", label: "Outbox · backlog", title: counts, tone: "warning", value: "backlog" };
    case "drained":
      return { dimension: "Outbox", label: "Outbox · drained", title: counts, tone: "success", value: "drained" };
    case "unknown":
      return { dimension: "Outbox", label: "Outbox · unknown", title: counts, tone: "neutral", value: "unknown" };
    default:
      return { dimension: "Outbox", label: "Outbox · unknown", title: counts, tone: "neutral", value: "unknown" };
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
    if (backoff.reason_class === "source_pressure") {
      // A cross-run source-pressure cooldown is not a failure streak: the run
      // succeeded and deferred the rest as resumable gaps under upstream
      // throttling. Naming "N consecutive failures" here (which is 0) would be
      // misleading. Describe the cooldown honestly instead.
      backoffLabel = "Cooling off under source pressure · captured progress retained";
    } else {
      const reason = backoff.reason_class ? ` (${backoff.reason_class.replace(/[_-]+/g, " ")})` : "";
      const failures = backoff.consecutive_failures;
      backoffLabel = `Backoff applied${reason} · ${failures} consecutive failure${failures === 1 ? "" : "s"}`;
    }
  }
  return {
    backoffLabel,
    enabled: schedule.enabled,
    ineligibilityReason: schedule.ineligibility_reason,
    mode: schedule.effective_mode,
    nextAttemptLabel: schedule.next_due_at ? `Next attempt ${schedule.next_due_at}` : null,
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
 * and a hover tooltip explaining why. Sol fourth-verdict P1.3: the same
 * rule applies when `totalRecordsState` reports a non-authoritative
 * (`stale`/`unobserved`/`unknown`) snapshot — a carried-over number,
 * including a carried-over ZERO, must never render as `reliable: true`.
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
  if (!isTotalRecordsAuthoritative(overview.totalRecordsState)) {
    return {
      label: formatTotalRecordsLabel(overview.totalRecords, overview.totalRecordsState, "records"),
      reliable: false,
      title: `Records count unverified: the latest snapshot is ${overview.totalRecordsState}`,
    };
  }
  return {
    label: overview.totalRecords.toLocaleString(),
    reliable: true,
    title: `${overview.totalRecords.toLocaleString()} records ingested`,
  };
}

/**
 * The reason code the reference projects onto a `cooling_off` connection when
 * the pause is a cross-run **source-pressure cooldown** (the scheduler is
 * deferring the next automatic attempt because the connection still has pending
 * retryable source-pressure detail gaps), not a failure streak. It is the
 * `reason_class` the reference's `mergeBackoffAndCooldown` stamps when the
 * cooldown governor — not failure back-off — is the sole driver. Connector-
 * agnostic: any connector that defers work under upstream pressure surfaces it.
 */
const SOURCE_PRESSURE_REASON_CODE = "source_pressure";

/**
 * The owner-facing one-line coverage statement for a `healthy` connection.
 *
 * Honesty fix: a `healthy` connection is NOT necessarily fresh. The prerequisite
 * `stale_assisted_refresh` advisory (commit 18fed97f) projects an assisted
 * scheduled connector as healthy/idle while its freshness axis is `stale` —
 * awaiting a scheduled refresh, not broken. The previous copy hardcoded
 * "Required coverage is current and complete", which lies for that case (it is
 * not *current*). We keep the complete-coverage claim (the healthy state earns
 * it) but make currency conditional on the freshness axis, so a stale-but-healthy
 * connection reads as awaiting refresh instead of claiming it is up to date.
 */
function healthyCoverageStatement(health: RefConnectionHealthSnapshot): string {
  if (health.axes.freshness === "stale") {
    return "Required coverage is complete, but the latest data is outside the freshness window — a refresh is due.";
  }
  if (health.axes.freshness === "unknown") {
    return "Required coverage is complete; freshness could not be determined from the available evidence.";
  }
  return "Required coverage is current and complete.";
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
 * - "Healthy" is a health verdict: coverage is complete, backlog is clear,
 *   and projection evidence is current. It does NOT guarantee freshness —
 *   an assisted scheduled connector can be healthy while stale (awaiting a
 *   scheduled refresh; see `stale_assisted_refresh`), so the healthy headline
 *   copy is freshness-aware (see `healthyCoverageStatement`) rather than
 *   claiming the data is current unconditionally.
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
  const dominant = formatDominantCondition(health)?.title ?? null;
  switch (health.state) {
    case "healthy":
      if (!hasDurableProgress) {
        return {
          label: "Ready",
          title: "Readiness checks pass, but this connection has no retained records yet.",
          tone: "neutral",
        };
      }
      return { label: "Healthy", title: healthyCoverageStatement(health), tone: "success" };
    case "needs_attention":
      return {
        label: "Needs attention",
        shape: "diamond",
        title: dominant ?? `Owner action required${reason}.`,
        tone: "warning",
      };
    case "cooling_off": {
      // A source-pressure cooldown is not a retry of a failed run: the run
      // succeeded and is catching up under throttling. Keep the raw
      // `source_pressure` token out of the tooltip and frame it as catch-up,
      // not failure. Failure-backoff cooling-off keeps its existing copy.
      const coolingTitle =
        health.reason_code === SOURCE_PRESSURE_REASON_CODE
          ? "Catching up under source pressure — captured progress is retained and the next attempt is spaced out."
          : `Waiting before the next retry${reason}.`;
      return {
        label: "Cooling off",
        shape: "diamond",
        title: dominant ?? coolingTitle,
        tone: "warning",
      };
    }
    case "blocked":
      return {
        label: "Blocked",
        shape: "triangle",
        title: dominant ?? `Cannot make progress${reason}.`,
        tone: "danger",
      };
    case "degraded": {
      if (health.axes.coverage === "retryable_gap") {
        return {
          label: "Resuming",
          shape: "diamond",
          title:
            dominant ??
            `Some required detail is still outstanding, but it is recoverable — an ordinary run can fill it and the records already collected stay valid${reason}.`,
          tone: "warning",
        };
      }
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

/**
 * Whether this snapshot's root cause is a self-resolving source-pressure
 * cooldown. Still load-bearing: `deriveFailureSummary`'s `blocked` branch
 * (below) reuses this guard so a source-pressure `blocked` never carries a
 * dead-end Reconnect CTA.
 *
 * The client-side `badgeState`/`synthesizeConnectionVerdict` single-voice
 * badge synthesizer this guard used to feed was deleted (Wave 10a/10b,
 * 2026-07-09 state-model convergence): the server-owned `RenderedVerdict.pill`
 * (via `deriveRenderedSourceStatus` in `source-actionability.ts`) is the one
 * badge every owner surface renders; the console no longer re-derives a
 * second badge state from raw connection-health `state`.
 */
function isSourcePressureCooldown(health: RefConnectionHealthSnapshot): boolean {
  if (health.reason_code === SOURCE_PRESSURE_REASON_CODE) {
    return true;
  }
  // A `blocked`/`cooling_off` state that still carries a scheduled next attempt
  // and a pending source-pressure backlog is a deferral, not a terminal stop —
  // the scheduler is spacing attempts, not giving up.
  const backlog = health.detail_gap_backlog;
  const hasPendingBacklog = Boolean(backlog && ((backlog.pending ?? 0) > 0 || (backlog.pending_other ?? 0) > 0));
  return hasPendingBacklog && Boolean(health.next_attempt_at);
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

/**
 * Owner-facing "what you can do next" guidance for a connection-health state.
 *
 * The reference projects a structured `next_action` only when a durable
 * attention record (or a schedule fallback) exists — typically the
 * `needs_attention` path with an explicit prompt. But several non-green states
 * (`stale`, `cooling_off`, `degraded`, `blocked`, and an attention state with
 * no structured prompt) leave the operator looking at a coloured pill with no
 * concrete next step. This helper closes that gap.
 *
 * Design rules, matching the rest of this module:
 *   - It NEVER fires when a structured `next_action` already carries the CTA
 *     (`hasStructuredNextAction`), so the row shows exactly one next step.
 *   - It NEVER invents a remote action the dashboard cannot perform. For a
 *     stalled local-collector outbox it points at the host, not a button.
 *   - It only suggests "Sync now" when the connector actually supports an
 *     owner-triggered pull; push-mode (local-collector) connections are told to
 *     check the device instead.
 *   - It returns `null` for `healthy` / `idle` / `unknown` — there is no
 *     honest, specific action to recommend there, and a generic nudge would be
 *     noise.
 *
 * The returned object is intentionally narrow (a short label, a one-line
 * detail, and a tone) so the JSX row stays thin and this stays unit-testable
 * without a browser harness.
 */
export interface NextStepGuidance {
  /**
   * Count-backed scale of the *source-pressure detail-gap backlog*, e.g. "at
   * least 100 detail items to catch up · resumes after 2026-05-19T13:00:00Z" or
   * "caught up — 12 recovered". Set only on the scheduler-managed source-pressure
   * paths (`cooling_off` under `source_pressure`, and `degraded` +
   * `retryable_gap`) when the reference attached a readable
   * `detail_gap_backlog` rollup. `null` when the rollup is absent/unreadable, so
   * the row never invents a count. Distinct from {@link scale}: this is the
   * scheduler-side analogue of the device outbox scale and renders backlog copy,
   * not device copy.
   */
  backlogScale: string | null;
  /** One-line operator detail expanding on the label. */
  detail: string;
  /** Short imperative label, e.g. "Sync now" or "Check the collector host". */
  label: string;
  /**
   * Count-backed scale of stuck work, e.g. "12 pending · 2 failed uploads". Set
   * only on the stalled-outbox guidance when the connection summary carries a
   * non-null `outbox_counts` rollup with at least one positive stuck-work
   * category. `null` for every other guidance — and for a stalled outbox with
   * no counts — so a quiet or healthy row never grows a numeric cue. The
   * companion `detailHref` row links the owner to the detail remediation panel
   * for the exact host command; this cue only states how much is stuck.
   */
  scale: string | null;
  tone: EvidenceTone;
}

/**
 * Guidance for a connection whose last successful sync is outside the freshness
 * window. An owner-syncable connector gets a direct "Sync now"; a push-mode
 * local-collector connection is told to check the host (the dashboard cannot
 * pull it). Shared by the `degraded` and `healthy`/idle stale paths.
 */
function staleFreshnessGuidance(supportsOwnerSync: boolean): NextStepGuidance {
  if (supportsOwnerSync) {
    return {
      backlogScale: null,
      detail: "The last successful sync is outside the freshness window. Sync now to refresh this connection.",
      label: "Sync now",
      scale: null,
      tone: "warning",
    };
  }
  return {
    backlogScale: null,
    detail:
      "The last successful sync is outside the freshness window. This connection fills in when its local-collector device pushes — confirm the collector is running on the host.",
    label: "Check the collector",
    scale: null,
    tone: "warning",
  };
}

/**
 * Guidance for the `cooling_off` state.
 *
 * Two different governors can put a connection in `cooling_off`:
 *   1. failure back-off after one or more failed runs, and
 *   2. the cross-run source-pressure cooldown — a run that *succeeded* but
 *      deferred the remaining work as resumable gaps under upstream throttling
 *      (e.g. a large ChatGPT history being caught up slowly).
 *
 * These read very differently to an owner. Calling a source-pressure pause
 * "scheduler backoff after recent failures" is misleading: nothing failed, the
 * captured progress is retained, and the connection will resume on its own. The
 * reference distinguishes the two via `reason_code`, so the copy honours that —
 * source pressure reads as "cooling off, will resume, progress retained," not
 * "broken." Pure and JSX-free so it stays unit-testable without a browser.
 */
function coolingOffGuidance(health: RefConnectionHealthSnapshot): NextStepGuidance {
  if (health.reason_code === SOURCE_PRESSURE_REASON_CODE) {
    // The reference's source-pressure backlog rollup turns the vague "see how
    // much is left" into a concrete, honest cue. When it is readable we attach
    // the count via `backlogScale` and drop the unkeepable promise from the
    // detail copy; when it is `null` (unmeasured) we keep the qualitative copy.
    const backlogScale = formatSourcePressureBacklogScale(health.detail_gap_backlog);
    return {
      backlogScale,
      detail: health.next_attempt_at
        ? `The source is throttling this connection, so the scheduler is spacing out automatic attempts; the captured progress is retained and it resumes at ${health.next_attempt_at}.`
        : "The source is throttling this connection, so the scheduler is spacing out automatic attempts. The captured progress is retained and it resumes on the next scheduled attempt.",
      label: "Catching up — cooling off",
      scale: null,
      tone: "warning",
    };
  }
  return {
    backlogScale: null,
    detail: health.next_attempt_at
      ? `In scheduler backoff after recent failures; the next automatic attempt is at ${health.next_attempt_at}. Open the connection to see the failure detail.`
      : "In scheduler backoff after recent failures. Open the connection to see the failure detail and the next attempt time.",
    label: "Wait for the next retry",
    scale: null,
    tone: "warning",
  };
}

/** Guidance for the `degraded` state, split by which axis is degraded. */
function degradedGuidance(health: RefConnectionHealthSnapshot, supportsOwnerSync: boolean): NextStepGuidance | null {
  if (health.axes.coverage === "retryable_gap") {
    if (health.next_attempt_at) {
      return null;
    }
    // A retryable source-pressure gap is the backlog rollup's other home: this is
    // the manual path (no scheduled automatic attempt), so the count tells the
    // owner how much an ordinary run still has to catch up. `null` rollup → no
    // cue (we never invent a count).
    const backlogScale = formatSourcePressureBacklogScale(health.detail_gap_backlog);
    if (supportsOwnerSync) {
      return {
        backlogScale,
        detail:
          "Some required detail is still outstanding. The records already collected stay valid; sync this connection when you're ready and an ordinary run fills the rest.",
        label: "Continue the sync",
        scale: null,
        tone: "warning",
      };
    }
    return {
      backlogScale,
      detail:
        "Some required detail is still outstanding. The records already collected stay valid; this connection fills in when its local-collector device pushes the rest — confirm the collector is running on the host.",
      label: "Check the collector",
      scale: null,
      tone: "warning",
    };
  }
  if (health.axes.coverage === "gaps" || health.axes.coverage === "partial") {
    return {
      backlogScale: null,
      detail:
        "Useful data exists, but some required streams have gaps. Open the connection's latest run to see which streams are incomplete.",
      label: "Review partial coverage",
      scale: null,
      tone: "warning",
    };
  }
  if (health.axes.freshness === "stale") {
    return staleFreshnessGuidance(supportsOwnerSync);
  }
  return {
    backlogScale: null,
    detail: "Coverage or freshness is incomplete. Open the connection to see which axis is degraded.",
    label: "Open the connection",
    scale: null,
    tone: "warning",
  };
}

export function deriveConnectionNextStep(input: {
  /**
   * True when a `DominantConditionNotice` is already rendered for this row.
   * When set, the generic "open the connection" fallbacks for blocked /
   * needs_attention are suppressed: the condition notice already explains the
   * situation and carries its own remediation, so a second generic row would be
   * noise. Action-bearing guidance (outbox host, retry timing, partial
   * coverage, stale sync) is still surfaced — it adds a concrete next step the
   * condition message does not.
   */
  hasDominantCondition: boolean;
  /** True when a structured `next_action` is already rendered for this row. */
  hasStructuredNextAction: boolean;
  health: RefConnectionHealthSnapshot | null | undefined;
  /**
   * Connection-summary local-device progress, including the count-backed
   * `outbox_counts` rollup. Used to attach a compact count-backed scale to the
   * stalled-outbox guidance only. Omitted / `null` for scheduler-managed
   * connections; a stalled outbox with no counts still gets host guidance with
   * `scale: null`, so the cue never reads as a misleading "0".
   */
  localDeviceProgress?: RefLocalDeviceProgress | null;
  /** True when this connector exposes an owner-triggerable Sync now. */
  supportsOwnerSync: boolean;
}): NextStepGuidance | null {
  const { hasDominantCondition, hasStructuredNextAction, health, localDeviceProgress, supportsOwnerSync } = input;
  if (!health || hasStructuredNextAction) {
    return null;
  }

  // A stalled local-device outbox is host-local: surface the same "go to the
  // host" guidance the detail page renders, never a remote button. This is the
  // ONLY branch that carries a count-backed scale — the cue is scoped to stuck
  // work on a connection the owner can actually remediate on the host, and is
  // omitted (null) when the summary reports no counts.
  if (health.axes.outbox === "stalled") {
    return {
      backlogScale: null,
      detail:
        "Retryable work on the local collector is not draining. Open the connection for the exact command to run on the host that holds the data.",
      label: "Check the collector host",
      scale: formatOutboxCountScale(localDeviceProgress?.outbox_counts),
      tone: "danger",
    };
  }

  switch (health.state) {
    case "blocked":
      // The dominant-condition notice (when present) already names the blocker
      // and its remediation; don't add a generic "open the connection" row.
      return hasDominantCondition
        ? null
        : {
            backlogScale: null,
            detail: "This connection cannot make progress. Open it to read the blocking condition and how to clear it.",
            label: "Open the connection",
            scale: null,
            tone: "danger",
          };
    case "needs_attention":
      // Reached only when no structured prompt accompanied the attention
      // state. If a dominant condition already explains it, stay quiet.
      return hasDominantCondition
        ? null
        : {
            backlogScale: null,
            detail: "Owner action is required. Open the connection to see exactly what's needed.",
            label: "Open the connection",
            scale: null,
            tone: "warning",
          };
    case "cooling_off":
      return coolingOffGuidance(health);
    case "degraded":
      return degradedGuidance(health, supportsOwnerSync);
    default:
      // healthy / idle / unknown — no honest, specific action to recommend,
      // except a stale-but-otherwise-healthy connection is worth a nudge.
      return health.axes.freshness === "stale" ? staleFreshnessGuidance(supportsOwnerSync) : null;
  }
}

/**
 * The honest primary action for a records row.
 *
 * The owner-triggered sync action starts an owner-controlled connector run.
 * Existing browser-bound connections are owner-runnable: if they need browser
 * assistance, the run timeline surfaces that after start. The class that remains
 * non-clickable here is push-mode / local-collector connections (those with
 * `localDeviceProgress`): they fill in when their local-collector device pushes
 * a batch, and there is no remote pull to start.
 *
 * Everything else keeps the clickable sync action; the visible label may read
 * `Retry sync` when the most recent attempt failed or was cancelled.
 *
 * Pure and JSX-free so the row stays thin and this is unit-testable without a
 * browser harness.
 */
export type PrimaryRowAction =
  | { kind: "sync" }
  | { kind: "cooldown_wait"; detail: string; label: string }
  | { kind: "device_wait"; detail: string; label: string };

export type SyncActionIdleLabel = "Retry sync" | "Sync now";

/**
 * Owner-facing label for the owner-triggered sync action while no run is
 * active. A failed/cancelled last attempt should read as recovery, not as a
 * fresh first-time action; the underlying endpoint is the same.
 */
export function syncActionIdleLabel(lastRunStatus: string | null | undefined): SyncActionIdleLabel {
  if (lastRunStatus === "failed" || lastRunStatus === "cancelled" || lastRunStatus === "canceled") {
    return "Retry sync";
  }
  return "Sync now";
}

/**
 * Owner-facing lead sentence for a failed `Sync now`, keyed on whether the
 * run-start request reached the reference server.
 *
 * `before_server` — the request never reached the server (network / deployment
 * down): the run definitely did not start; the owner should check their
 * deployment. `after_server` — the server responded with an error: the run
 * did not start, but the cause is the server's (the full message carries its
 * reason). Keeping this pure and JSX-free lets both the records row and the
 * connection detail page render identical, tested copy without a browser
 * harness, and keeps a run-start failure a row-local toast — never a fall
 * through to the dashboard error boundary.
 */
export function syncStartFailureLead(phase: "before_server" | "after_server"): string {
  if (phase === "before_server") {
    return "Couldn't reach the reference server, so the sync did not start.";
  }
  return "The reference server rejected the sync, so it did not start.";
}

// ─── What's wrong? expander ───────────────────────────────────────────────────

/**
 * Structured failure summary for the "What's wrong?" expander on the
 * connector detail page.
 *
 * Shown only when health is degraded, cooling_off, blocked, or needs_attention.
 * The expander's trigger label follows design decision 9 in the mocks:
 * `degraded` opens "What's missing?"; everything else opens "What's wrong?".
 *
 * Pure and JSX-free so it can be unit-tested without a browser harness.
 */
export interface FailureSummary {
  /** Label for the primary CTA/status line. Current references source this from `RenderedVerdict.required_actions[0].cta`. */
  actionLabel: string | null;
  /**
   * Primary remediation CTA.
   * - `connection_detail` → link to the connection detail page using `actionLabel`
   * - `reconnect` → legacy link to the connection detail page (credential/browser failures)
   * - `view_runs` → link to the runs list (protocol failures, gaps)
   * - `wait` → informational, no link (cooling_off in back-off)
   */
  cta: "connection_detail" | "reconnect" | "view_runs" | "wait";
  /** ISO timestamp of the last known success. */
  lastSuccessAt: string | null;
  /** next_attempt_at from the health snapshot — when the next retry fires. */
  nextAttemptAt: string | null;
  /** True only when the owner is the sole resolution and the card should count under "need your hand". */
  ownerActionRequired: boolean;
  /**
   * One or two prose sentences the operator reads first. Plain English, no
   * codes. Current references source this from `RenderedVerdict.forward_statement`.
   */
  prose: string;
  /** reason_code to show in the fact box, or null when absent. */
  reasonCode: string | null;
  /** Button label for the collapsed expander. */
  triggerLabel: "What's missing?" | "What's wrong?";
}

function renderedActionIsOwnerSatisfiable(action: RefRequiredAction | null): boolean {
  return Boolean(action && action.audience === "owner" && action.satisfied_when.kind !== "none");
}

function triggerLabelFromRenderedVerdict(verdict: RefRenderedVerdict): FailureSummary["triggerLabel"] {
  return verdict.channel === "attention" || verdict.pill.tone === "red" ? "What's wrong?" : "What's missing?";
}

function deriveRenderedFailureSummary(
  health: RefConnectionHealthSnapshot,
  verdict: RefRenderedVerdict
): FailureSummary | null {
  const primaryAction = verdict.required_actions[0] ?? null;
  const ownerAction = renderedActionIsOwnerSatisfiable(primaryAction);
  const statusAction = primaryAction != null && !ownerAction && primaryAction.kind !== "wait";

  if (verdict.channel === "calm" && !ownerAction && !statusAction) {
    return null;
  }

  let cta: FailureSummary["cta"] = "view_runs";
  if (ownerAction) {
    cta = "connection_detail";
  } else if (statusAction || primaryAction?.kind === "wait") {
    cta = "wait";
  }

  // A device-local recovery (stalled outbox: the owner runs commands on the host
  // that holds the data) is NOT performed by clicking — the button only NAVIGATES
  // to where the commands are shown. Restating the device-local recovery action
  // on a navigating button makes the owner click it expecting it to act, which
  // just routes them in a circle. So when the action
  // is device-local, the navigable label is an honest "See recovery steps", and
  // it routes to the connection detail page where the commands live.
  const isDeviceLocalRecovery = primaryAction?.remediation?.target.kind === "local_device";
  if (isDeviceLocalRecovery && cta === "connection_detail") {
    return {
      actionLabel: "See recovery steps",
      cta,
      lastSuccessAt: health.last_success_at,
      nextAttemptAt: health.next_attempt_at,
      ownerActionRequired: verdict.channel === "attention",
      prose: verdict.forward_statement,
      reasonCode: health.reason_code,
      triggerLabel: triggerLabelFromRenderedVerdict(verdict),
    };
  }

  return {
    actionLabel: primaryAction?.cta ?? (cta === "view_runs" ? "View runs" : null),
    cta,
    lastSuccessAt: health.last_success_at,
    nextAttemptAt: health.next_attempt_at,
    ownerActionRequired: ownerAction && verdict.channel === "attention",
    prose: verdict.forward_statement,
    reasonCode: health.reason_code,
    triggerLabel: triggerLabelFromRenderedVerdict(verdict),
  };
}

/**
 * Derive a `FailureSummary` from the server-owned rendered verdict, with a
 * legacy health-snapshot fallback for older references that predate
 * `rendered_verdict`.
 *
 * Returns `null` for states that do not warrant an expander (`healthy`,
 * `idle`, `unknown`).
 */
export function deriveFailureSummary(
  health: RefConnectionHealthSnapshot | null | undefined,
  renderedVerdict?: RefRenderedVerdict | null
): FailureSummary | null {
  if (!health) {
    return null;
  }
  if (renderedVerdict) {
    return deriveRenderedFailureSummary(health, renderedVerdict);
  }
  const { state, reason_code, next_attempt_at, last_success_at } = health;

  switch (state) {
    case "degraded": {
      const hasCoverageGaps =
        health.axes.coverage === "gaps" ||
        health.axes.coverage === "partial" ||
        health.axes.coverage === "terminal_gap";
      return {
        actionLabel: "View runs",
        cta: "view_runs",
        lastSuccessAt: last_success_at,
        nextAttemptAt: next_attempt_at,
        ownerActionRequired: false,
        prose: hasCoverageGaps
          ? "Some streams have a collection gap from the last run. Data already collected is retained; review the run detail for the recovery path."
          : "The connection ran, but coverage or freshness is incomplete. Existing records are retained; review the source detail for the next step.",
        reasonCode: reason_code,
        triggerLabel: "What's missing?",
      };
    }
    case "cooling_off": {
      const isSourcePressure = reason_code === SOURCE_PRESSURE_REASON_CODE;
      return {
        actionLabel: "No action needed",
        cta: "wait",
        lastSuccessAt: last_success_at,
        nextAttemptAt: next_attempt_at,
        ownerActionRequired: false,
        prose: isSourcePressure
          ? "The source is throttling this connection, so the scheduler is spacing out automatic attempts. Captured progress is retained and collection resumes on the next scheduled attempt."
          : "The scheduler entered back-off after one or more failed runs. It will retry automatically; captured progress is retained.",
        reasonCode: reason_code,
        triggerLabel: "What's wrong?",
      };
    }
    case "blocked": {
      // §6.2: A source-pressure cooldown whose raw state happens to be
      // `blocked` is self-resolving — it must never carry a Reconnect CTA
      // that directs the owner to manual action. Apply the shared
      // isSourcePressureCooldown guard here; its `cooling_off` branch above
      // already does this.
      if (isSourcePressureCooldown(health)) {
        return {
          actionLabel: "No action needed",
          cta: "wait",
          lastSuccessAt: last_success_at,
          nextAttemptAt: next_attempt_at,
          ownerActionRequired: false,
          prose:
            "The source is throttling this connection, so the scheduler is spacing out automatic attempts. Captured progress is retained and collection resumes on the next scheduled attempt.",
          reasonCode: reason_code,
          triggerLabel: "What's wrong?",
        };
      }
      return {
        actionLabel: "Reconnect",
        cta: "reconnect",
        lastSuccessAt: last_success_at,
        nextAttemptAt: next_attempt_at,
        ownerActionRequired: true,
        prose:
          "The connection has stopped making progress and automatic retries are paused. This usually means the credentials expired or the provider blocked the session. Reconnect to start a fresh setup, or try a manual run to see if the issue cleared on its own.",
        reasonCode: reason_code,
        triggerLabel: "What's wrong?",
      };
    }
    case "needs_attention": {
      const dominantSummary = formatDominantCondition(health);
      return {
        actionLabel: "Reconnect",
        cta: "reconnect",
        lastSuccessAt: last_success_at,
        nextAttemptAt: next_attempt_at,
        ownerActionRequired: true,
        prose: dominantSummary
          ? dominantSummary.label
          : "Owner action is required before this connection can make progress. Open the run detail for the exact step.",
        reasonCode: reason_code,
        triggerLabel: "What's wrong?",
      };
    }
    default:
      return null;
  }
}

// ─── 14-day streak strip ──────────────────────────────────────────────────────

/** Symbol and tone for one run in the streak strip. */
export interface StreakDot {
  /** ISO timestamp used for the title tooltip. */
  at: string;
  /** Human-readable status for the title tooltip. */
  statusLabel: string;
  /** Unicode symbol for the dot. */
  symbol: "✓" | "⚠" | "✕" | "⊘" | "⏸";
  tone: "success" | "warning" | "danger" | "neutral";
}

/**
 * Derive streak dots from an array of run summaries (newest-first).
 *
 * Symbols follow design decision 8 in the mocks: `✓ ⚠ ✕ ⊘ ⏸`.
 * Limited to the most recent 14 runs to keep the strip compact.
 *
 * Pure and JSX-free so it can be unit-tested without a browser harness.
 */
export function deriveStreakDots(
  runs: readonly { status: string; first_at: string; failure_reason?: string | null }[]
): StreakDot[] {
  return runs.slice(0, 14).map((r): StreakDot => {
    const s = r.status;
    if (s === "succeeded_with_gaps") {
      return { at: r.first_at, statusLabel: "Succeeded with gaps", symbol: "⚠", tone: "warning" };
    }
    if (s === "succeeded" || s === "success" || s === "completed") {
      return { at: r.first_at, statusLabel: "Succeeded", symbol: "✓", tone: "success" };
    }
    if (s === "failed" || s === "error") {
      return { at: r.first_at, statusLabel: r.failure_reason ?? "Failed", symbol: "✕", tone: "danger" };
    }
    if (s === "cancelled" || s === "canceled") {
      return { at: r.first_at, statusLabel: "Cancelled", symbol: "⊘", tone: "neutral" };
    }
    if (s === "paused" || s === "skipped") {
      return { at: r.first_at, statusLabel: "Skipped", symbol: "⏸", tone: "neutral" };
    }
    if (s === "degraded" || s === "partial") {
      return { at: r.first_at, statusLabel: "Partial", symbol: "⚠", tone: "warning" };
    }
    // in_progress / started — not shown in a historical strip but included
    // defensively so the map never throws.
    return { at: r.first_at, statusLabel: s.replace(/_/g, " "), symbol: "⚠", tone: "neutral" };
  });
}

export function summarizeStreakDots(dots: readonly StreakDot[]): string {
  const failureCount = dots.filter((d) => d.tone === "danger").length;
  const partialCount = dots.filter((d) => d.tone === "warning").length;
  const parts: string[] = [];
  if (failureCount > 0) {
    parts.push(`${failureCount} failure${failureCount === 1 ? "" : "s"}`);
  }
  if (partialCount > 0) {
    parts.push(`${partialCount} with gaps`);
  }
  return parts.length > 0 ? parts.join(" · ") : "0 failures";
}

// ─── Auto-paused banner ───────────────────────────────────────────────────────

/**
 * Derive the auto-paused banner data from the schedule's backoff field.
 *
 * Returns `null` when no backoff is active, so callers can conditionally
 * render the banner without duplicating the predicate.
 *
 * Pure and JSX-free so it can be unit-tested without a browser harness.
 */
export interface AutoPausedBanner {
  /** Number of consecutive failures that triggered the back-off. */
  consecutiveFailures: number;
  /**
   * Whether the recommended_health_state says `blocked` (gave up / terminal)
   * vs `cooling_off` (back-off, will retry).
   */
  isTerminal: boolean;
  /** ISO timestamp for when the next attempt will fire, or null. */
  nextRunAt: string | null;
  /** reason_class from the backoff, humanized for display. */
  reasonLabel: string | null;
}

export function deriveAutoPausedBanner(
  schedule:
    | {
        scheduler_backoff: {
          backoff_applied: boolean;
          consecutive_failures: number;
          next_run_at: string | null;
          reason_class: string | null;
          recommended_health_state: "blocked" | "cooling_off" | null;
        } | null;
      }
    | null
    | undefined
): AutoPausedBanner | null {
  const backoff = schedule?.scheduler_backoff;
  if (!backoff?.backoff_applied) {
    return null;
  }
  return {
    consecutiveFailures: backoff.consecutive_failures,
    isTerminal: backoff.recommended_health_state === "blocked",
    nextRunAt: backoff.next_run_at,
    reasonLabel: backoff.reason_class ? backoff.reason_class.replace(/[_-]+/g, " ") : null,
  };
}

export function derivePrimaryRowAction(input: {
  connectorId: string | null | undefined;
  health?: RefConnectionHealthSnapshot | null;
  /** True when the reference has a push-mode local-device progress row for this connection. */
  hasLocalDeviceProgress: boolean;
}): PrimaryRowAction {
  const { hasLocalDeviceProgress, health } = input;
  if (hasLocalDeviceProgress) {
    return {
      detail:
        "This connection fills in when its local-collector device pushes new data — the dashboard cannot start a run. Confirm the collector is running on the host that holds the data.",
      kind: "device_wait",
      label: "Waiting for the local device",
    };
  }

  if (health?.state === "cooling_off" && health.reason_code === SOURCE_PRESSURE_REASON_CODE) {
    return {
      detail: health.next_attempt_at
        ? `This source is throttling PDPP, so the next ordinary sync waits until ${health.next_attempt_at}. Captured progress is retained.`
        : "This source is throttling PDPP, so ordinary sync is paused until the next scheduled retry. Captured progress is retained.",
      kind: "cooldown_wait",
      label: "Cooling off",
    };
  }

  const sourcePressureBacklog = health?.detail_gap_backlog;
  if (sourcePressureBacklog && sourcePressureBacklog.pending > 0) {
    const pending = `${sourcePressureBacklog.pending_is_floor ? "at least " : ""}${sourcePressureBacklog.pending.toLocaleString()}`;
    return {
      detail: `This connection has ${pending} pending provider-pressure gap${
        sourcePressureBacklog.pending === 1 ? "" : "s"
      }, so ordinary sync may be rejected by the provider-pressure cooldown. Captured progress is retained.`,
      kind: "cooldown_wait",
      label: "Cooling off",
    };
  }

  return { kind: "sync" };
}

export interface CollectionRateReadout {
  /** "last backed off to Xms (reason)" or null when no back-off has fired. */
  backoffLabel: string | null;
  /** "ceiling N/min" sub-line. */
  ceilingLabel: string;
  /** "current N/min" headline. */
  currentLabel: string;
}

/**
 * Format the adaptive collection rate controller's state into the small
 * operator-facing readout the diagnostics panel renders. Returns null when no
 * controller state is available — the caller then shows an explicit unknown,
 * never a false zero or a false green (honest-by-default).
 */
export function formatCollectionRateReadout(
  rate: RefCollectionRateSnapshot | null | undefined
): CollectionRateReadout | null {
  if (!rate || typeof rate.effective_rate_per_min !== "number") {
    return null;
  }
  const backoffLabel = rate.last_backoff
    ? `last backed off to ${rate.last_backoff.at_interval_ms.toLocaleString()}ms (${rate.last_backoff.reason})`
    : null;
  return {
    backoffLabel,
    ceilingLabel: `ceiling ${rate.ceiling_rate_per_min.toLocaleString()}/min · interval ${rate.ceiling_interval_ms.toLocaleString()}ms`,
    currentLabel: `${rate.effective_rate_per_min.toLocaleString()}/min · interval ${rate.current_interval_ms.toLocaleString()}ms`,
  };
}

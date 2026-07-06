import { deriveFailureSummary, type FailureSummary } from "./connection-evidence.ts";
import type { FormattedNextAction } from "./next-action.ts";
import type {
  RefActionRemediation,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  RefVerdictTone,
} from "./ref-client.ts";
import {
  deriveRecoveryStep,
  hasRecoverableWork,
  type RecoveryStep,
  recoveryStateGroup,
} from "./source-recovery-state.ts";

export type SourceWorkGroupId = "needsOwner" | "notMeasured" | "review" | "systemIssue" | "working";

export type SourceStatusKind = "blocked" | "degraded" | "healthy" | "revoked" | "unknown";

export type SourceStatusTone = "destructive" | "muted" | "success" | "warning";

export interface SourceStatusFlag {
  dot: string;
  freshnessNote: string | null;
  kind: SourceStatusKind;
  label: string;
  tone: SourceStatusTone;
}

export interface SourcePrimaryVerdictAction {
  audience: RefRequiredAction["audience"];
  channel: RefRenderedVerdict["channel"];
  cta: string;
  kind: RefRequiredAction["kind"];
  ownerRunnable: boolean;
  satisfiedWhenKind: RefRequiredAction["satisfied_when"]["kind"];
  terminal: boolean;
}

export interface SourceOwnerActionCue {
  label: string;
}

export type SourceStreamOwnerActionAvailability = Readonly<Record<string, boolean>>;

export interface SourceWorkItem {
  actionLabel: string | null;
  connectorKey: string;
  deviceLocal: boolean;
  group: SourceWorkGroupId;
  id: string;
  label: string;
  routeId: string;
  statusLabel: string;
  what: string;
}

export interface SourceWorkGroups {
  needsOwner: SourceWorkItem[];
  notMeasured: SourceWorkItem[];
  review: SourceWorkItem[];
  systemIssues: SourceWorkItem[];
  working: SourceWorkItem[];
}

export interface SourceActionabilityProjection {
  failureSummary: FailureSummary | null;
  label: string;
  nextAction: FormattedNextAction | null;
  ownerActionByStream: SourceStreamOwnerActionAvailability;
  ownerActionCue: SourceOwnerActionCue | null;
  primaryAction: RefRequiredAction | null;
  primaryVerdictAction: SourcePrimaryVerdictAction | null;
  renderedStatus: SourceStatusFlag;
  revoked: boolean;
  routeId: string;
  work: SourceWorkItem | null;
}

export const EMPTY_SOURCE_WORK_GROUPS: SourceWorkGroups = {
  needsOwner: [],
  notMeasured: [],
  review: [],
  systemIssues: [],
  working: [],
};

/**
 * The single owner-facing label + one-line note for each source-attention work
 * group. Both the dashboard standing view and the Runs/Syncs view consume THIS
 * map so the four categories read identically everywhere and the axis that
 * separates them — who must act, and how urgent — is stated once, to the owner.
 * Do not re-author these per surface (that drift is exactly what the owner
 * flagged as "hard to distinguish"). See `reference-connection-health`:
 * "Owner Surfaces SHALL Share One Projection Contract".
 */
export const SOURCE_WORK_GROUP_COPY: Record<SourceWorkGroupId, { label: string; note: string }> = {
  needsOwner: {
    label: "Needs you",
    note: "Requires your input before collection can continue.",
  },
  review: {
    label: "Available actions",
    note: "Optional refreshes and retries you can start.",
  },
  systemIssue: {
    label: "System or connector issue",
    note: "PDPP needs to fix or retry this; no account action is needed from you.",
  },
  working: {
    label: "PDPP is working",
    note: "Collection, recovery, or a bounded check is active.",
  },
  notMeasured: {
    label: "Not measured",
    note: "Evidence is missing and no active check is running.",
  },
};

/** The one owner-facing meaning of the headline "needs you" attention number. */
export interface SourceAttentionHeadline {
  /** Count of sources genuinely blocked on the owner's action (the needs-you group). */
  needsYou: number;
}

/**
 * The single derivation of the headline "how many sources need YOUR action"
 * number. The dashboard hero and the Runs band both call this so they cannot
 * diverge. It counts ONLY the owner-required (needs-you) group; the review,
 * system-issue, and checking groups are secondary and are never summed into
 * this headline (owner decision 2026-07-02).
 */
export function sourceAttentionHeadline(groups: SourceWorkGroups): SourceAttentionHeadline {
  return { needsYou: groups.needsOwner.length };
}

const UNDERSCORE_RE = /_/g;

const VERDICT_TONE_STATUS: Record<RefVerdictTone, Pick<SourceStatusFlag, "dot" | "kind" | "tone">> = {
  green: { kind: "healthy", dot: "●", tone: "success" },
  amber: { kind: "degraded", dot: "◐", tone: "warning" },
  red: { kind: "blocked", dot: "⊘", tone: "destructive" },
  grey: { kind: "unknown", dot: "○", tone: "muted" },
};

function readableConnectorId(connectorId: string): string {
  return connectorId.replace(UNDERSCORE_RE, " ").trim() || connectorId;
}

function connectionRouteId(connector: RefConnectorSummary): string {
  return connector.connector_instance_id ?? connector.connection_id;
}

function connectorLabel(connector: RefConnectorSummary): string {
  return (
    connector.display_name?.trim() ||
    connector.connector_display_name?.trim() ||
    readableConnectorId(connector.connector_id)
  );
}

export function isRevokedConnector(connector: RefConnectorSummary): boolean {
  return connector.status === "revoked" || Boolean(connector.revoked_at);
}

export function isOwnerSatisfiableAction(action: RefRequiredAction | null | undefined): action is RefRequiredAction {
  return Boolean(action && action.audience === "owner" && action.satisfied_when.kind !== "none");
}

export function primaryRequiredAction(verdict: RefRenderedVerdict | null | undefined): RefRequiredAction | null {
  return verdict?.required_actions[0] ?? null;
}

export function primaryOwnerSatisfiableAction(
  verdict: RefRenderedVerdict | null | undefined
): RefRequiredAction | null {
  const primary = primaryRequiredAction(verdict);
  return isOwnerSatisfiableAction(primary) ? primary : null;
}

export function primaryOwnerActionRemediation(
  verdict: RefRenderedVerdict | null | undefined
): RefActionRemediation | null {
  return primaryOwnerSatisfiableAction(verdict)?.remediation ?? null;
}

export function hasPrimaryOwnerLocalDeviceRemediation(verdict: RefRenderedVerdict | null | undefined): boolean {
  return primaryOwnerActionRemediation(verdict)?.target.kind === "local_device";
}

export function verdictRequiresOwnerNow(verdict: RefRenderedVerdict | null | undefined): boolean {
  return verdict?.channel === "attention" && primaryOwnerSatisfiableAction(verdict) !== null;
}

function freshnessNoteFromVerdict(verdict: RefRenderedVerdict): string | null {
  return verdict.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? null;
}

function labelWithFreshness(base: string, note: string | null): string {
  return note ? `${base} · ${note}` : base;
}

export function deriveRenderedSourceStatus(
  verdict: RefRenderedVerdict | null | undefined,
  revoked: boolean
): SourceStatusFlag {
  if (revoked) {
    return { kind: "revoked", dot: "⊘", tone: "muted", label: "Revoked", freshnessNote: null };
  }
  if (!verdict) {
    return {
      kind: "unknown",
      dot: "○",
      tone: "muted",
      label: "Verdict unavailable",
      freshnessNote: null,
    };
  }
  const status = VERDICT_TONE_STATUS[verdict.pill.tone];
  const freshnessNote = freshnessNoteFromVerdict(verdict);
  return {
    ...status,
    label: labelWithFreshness(verdict.pill.label, freshnessNote),
    freshnessNote,
  };
}

export function formatRenderedRequiredAction(
  verdict: RefRenderedVerdict | null | undefined
): FormattedNextAction | null {
  const action = primaryRequiredAction(verdict);
  if (!isOwnerSatisfiableAction(action)) {
    return null;
  }
  return {
    actionTarget: "connection_detail",
    caveat: null,
    label: action.cta,
    notificationHint: null,
    variant: "structured",
  };
}

export function formatPrimaryVerdictAction(
  verdict: RefRenderedVerdict | null | undefined
): SourcePrimaryVerdictAction | null {
  if (!verdict) {
    return null;
  }
  const action = primaryRequiredAction(verdict);
  if (!action) {
    return null;
  }
  return {
    audience: action.audience,
    channel: verdict.channel,
    cta: action.cta,
    kind: action.kind,
    ownerRunnable: isOwnerSatisfiableAction(action),
    satisfiedWhenKind: action.satisfied_when.kind,
    terminal: action.terminal,
  };
}

export function ownerActionCueFromVerdictAction(
  action: SourcePrimaryVerdictAction | null
): SourceOwnerActionCue | null {
  if (!action?.ownerRunnable) {
    return null;
  }
  return { label: action.cta };
}

export function ownerActionAvailabilityByStream(
  verdict: RefRenderedVerdict | null | undefined
): SourceStreamOwnerActionAvailability {
  const out: Record<string, boolean> = {};
  if (!verdict) {
    return out;
  }
  for (const row of verdict.streams ?? []) {
    const action = row.action_ref === null ? null : (verdict.required_actions[row.action_ref] ?? null);
    out[row.stream_id] = isOwnerSatisfiableAction(action);
  }
  return out;
}

function sourceIssueStatus(verdict: NonNullable<RefConnectorSummary["rendered_verdict"]>): string | null {
  if (verdict.pill.tone === "red" || verdict.pill.label === "Can't collect") {
    return "can't collect";
  }
  if (verdict.pill.tone === "amber" || verdict.pill.label === "Degraded") {
    return "is degraded";
  }
  if (verdict.channel === "attention") {
    return "needs review";
  }
  return null;
}

function isWorking(verdict: NonNullable<RefConnectorSummary["rendered_verdict"]>): boolean {
  return verdict.pill.label === "Checking";
}

function isNotMeasured(verdict: NonNullable<RefConnectorSummary["rendered_verdict"]>): boolean {
  return verdict.pill.tone === "grey" || verdict.pill.label === "Not measured";
}

const RECOVERY_STATUS_LABEL: Partial<Record<RecoveryStep, string>> = {
  active: "is syncing details",
  queued: "is catching up",
  cooling: "is waiting to retry",
  stalled: "recovery is stalled",
};

const RECOVERY_WHAT: Partial<Record<RecoveryStep, string>> = {
  active: "Syncing details now.",
  queued: "Catching up details when it is safe to retry.",
  cooling: "Waiting until it is safe to retry details.",
  stalled: "Recovery has stopped making progress and needs a look.",
};

/**
 * Route durable recoverable detail work through the typed recovery step. Returns
 * a passive-progress ("PDPP is working") item for active/queued/cooling recovery
 * and a system-issue item for a stalled queue. Returns `null` when there is no
 * recoverable-work evidence, when the verdict is already interrupting the owner
 * (`attention` channel — handled by the needs-you branch), or when the step is
 * not one of the recovery-owned passive/stalled states (owner_required/eligible/
 * system_issue/none are covered by the surrounding branches). Never emits a
 * "Checking" label for an inactive queue.
 */
function recoveryWorkItem(connector: RefConnectorSummary, verdict: RefRenderedVerdict): SourceWorkItem | null {
  if (verdict.channel === "attention" || !hasRecoverableWork(connector.connection_health.detail_gap_backlog)) {
    return null;
  }
  const step = deriveRecoveryStep(verdict, connector.connection_health);
  const group = recoveryStateGroup(step);
  if (group !== "working" && group !== "systemIssue") {
    return null;
  }
  const statusLabel = RECOVERY_STATUS_LABEL[step];
  if (!statusLabel) {
    return null;
  }
  return itemFromConnector(connector, group === "working" ? "working" : "systemIssue", {
    statusLabel,
    what: RECOVERY_WHAT[step] ?? verdict.forward_statement,
  });
}

function itemFromConnector(
  connector: RefConnectorSummary,
  group: SourceWorkGroupId,
  input: {
    actionLabel?: string | null;
    deviceLocal?: boolean;
    statusLabel: string;
    what: string;
  }
): SourceWorkItem {
  const routeId = connectionRouteId(connector);
  return {
    actionLabel: input.actionLabel ?? null,
    connectorKey: connector.connector_id,
    deviceLocal: Boolean(input.deviceLocal),
    group,
    id: `${group}:${routeId}`,
    label: connectorLabel(connector),
    routeId,
    statusLabel: input.statusLabel,
    what: input.what,
  };
}

export function sourceWorkItemFromConnector(connector: RefConnectorSummary): SourceWorkItem | null {
  if (isRevokedConnector(connector)) {
    return null;
  }

  const verdict = connector.rendered_verdict;
  if (!verdict) {
    const summary = deriveFailureSummary(connector.connection_health, null);
    if (!summary) {
      return null;
    }
    if (summary.ownerActionRequired) {
      return itemFromConnector(connector, "needsOwner", {
        actionLabel: summary.actionLabel ?? "Review source",
        statusLabel: "needs you",
        what: summary.prose,
      });
    }
    return itemFromConnector(connector, "systemIssue", {
      statusLabel: "is degraded",
      what: summary.prose,
    });
  }

  const ownerAction = primaryOwnerSatisfiableAction(verdict);
  if (verdict.channel === "attention" && ownerAction) {
    return itemFromConnector(connector, "needsOwner", {
      actionLabel: ownerAction.cta,
      deviceLocal: ownerAction.remediation?.target.kind === "local_device",
      statusLabel: "needs you",
      what: verdict.forward_statement,
    });
  }

  if (ownerAction) {
    return itemFromConnector(connector, "review", {
      actionLabel: ownerAction.cta,
      deviceLocal: ownerAction.remediation?.target.kind === "local_device",
      // The concrete CTA (`ownerAction.cta`, e.g. "Refresh now" / "Retry now")
      // carries the row copy; the statusLabel is a neutral fallback, never the
      // "ready for review" taxonomy phrasing.
      statusLabel: ownerAction.cta,
      what: verdict.forward_statement,
    });
  }

  // Durable recoverable detail work the recovery governor owns. This is passive
  // progress the system continues on cadence — route queued/cooling recovery to
  // "PDPP is working" (never "is degraded" or "Checking") and a stalled queue to
  // a system issue, BEFORE the generic amber→system-issue fallthrough below so
  // an inactive backlog does not read as a broken connection. Needs-you and
  // owner-runnable recovery are already handled by the branches above.
  const recovery = recoveryWorkItem(connector, verdict);
  if (recovery) {
    return recovery;
  }

  const statusLabel = sourceIssueStatus(verdict);
  if (statusLabel) {
    return itemFromConnector(connector, "systemIssue", {
      statusLabel,
      what: verdict.forward_statement,
    });
  }

  if (isWorking(verdict)) {
    return itemFromConnector(connector, "working", {
      statusLabel: "is working",
      what: verdict.forward_statement,
    });
  }

  if (isNotMeasured(verdict)) {
    return itemFromConnector(connector, "notMeasured", {
      statusLabel: "is not measured",
      what: verdict.forward_statement,
    });
  }

  return null;
}

export function projectSourceActionability(connector: RefConnectorSummary): SourceActionabilityProjection {
  const routeId = connectionRouteId(connector);
  const label = connectorLabel(connector);
  const revoked = isRevokedConnector(connector);
  const primaryAction = primaryRequiredAction(connector.rendered_verdict);
  const primaryVerdictAction = formatPrimaryVerdictAction(connector.rendered_verdict);
  return {
    failureSummary: deriveFailureSummary(connector.connection_health, connector.rendered_verdict ?? null),
    label,
    nextAction: formatRenderedRequiredAction(connector.rendered_verdict),
    ownerActionByStream: ownerActionAvailabilityByStream(connector.rendered_verdict ?? null),
    ownerActionCue: ownerActionCueFromVerdictAction(primaryVerdictAction),
    primaryAction,
    primaryVerdictAction,
    renderedStatus: deriveRenderedSourceStatus(connector.rendered_verdict, revoked),
    revoked,
    routeId,
    work: sourceWorkItemFromConnector(connector),
  };
}

export function sourceWorkFromConnectors(connectors: readonly RefConnectorSummary[]): SourceWorkGroups {
  const groups: SourceWorkGroups = {
    needsOwner: [],
    notMeasured: [],
    review: [],
    systemIssues: [],
    working: [],
  };
  const seen = new Set<string>();

  for (const connector of connectors) {
    const item = projectSourceActionability(connector).work;
    if (!item || seen.has(item.routeId)) {
      continue;
    }
    seen.add(item.routeId);
    switch (item.group) {
      case "needsOwner":
        groups.needsOwner.push(item);
        break;
      case "review":
        groups.review.push(item);
        break;
      case "systemIssue":
        groups.systemIssues.push(item);
        break;
      case "working":
        groups.working.push(item);
        break;
      case "notMeasured":
        groups.notMeasured.push(item);
        break;
      default: {
        const _exhaustive: never = item.group;
        throw new Error(`Unhandled source work group ${_exhaustive}`);
      }
    }
  }

  return groups;
}

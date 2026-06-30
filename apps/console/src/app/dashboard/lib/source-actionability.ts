import { deriveFailureSummary, type FailureSummary } from "./connection-evidence.ts";
import type { FormattedNextAction } from "./next-action.ts";
import type {
  RefActionRemediation,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  RefVerdictTone,
} from "./ref-client.ts";

export type SourceWorkGroupId = "checking" | "needsOwner" | "review" | "systemIssue";

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
  checking: SourceWorkItem[];
  needsOwner: SourceWorkItem[];
  review: SourceWorkItem[];
  systemIssues: SourceWorkItem[];
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
  checking: [],
  needsOwner: [],
  review: [],
  systemIssues: [],
};

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

function isChecking(verdict: NonNullable<RefConnectorSummary["rendered_verdict"]>): boolean {
  return verdict.pill.tone === "grey" || verdict.pill.label === "Checking";
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
      statusLabel: "is ready for review",
      what: verdict.forward_statement,
    });
  }

  const statusLabel = sourceIssueStatus(verdict);
  if (statusLabel) {
    return itemFromConnector(connector, "systemIssue", {
      statusLabel,
      what: verdict.forward_statement,
    });
  }

  if (isChecking(verdict)) {
    return itemFromConnector(connector, "checking", {
      statusLabel: "is checking",
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
    checking: [],
    needsOwner: [],
    review: [],
    systemIssues: [],
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
      case "checking":
        groups.checking.push(item);
        break;
      default: {
        const _exhaustive: never = item.group;
        throw new Error(`Unhandled source work group ${_exhaustive}`);
      }
    }
  }

  return groups;
}

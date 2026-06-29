import { deriveFailureSummary } from "./connection-evidence.ts";
import type { RefConnectorSummary, RefRenderedVerdict, RefRequiredAction } from "./ref-client.ts";

export type SourceWorkGroupId = "checking" | "needsOwner" | "review" | "systemIssue";

export interface SourceWorkItem {
  actionLabel: string | null;
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

export const EMPTY_SOURCE_WORK_GROUPS: SourceWorkGroups = {
  checking: [],
  needsOwner: [],
  review: [],
  systemIssues: [],
};

const UNDERSCORE_RE = /_/g;

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

export function isOwnerSatisfiableAction(action: RefRequiredAction | null | undefined): action is RefRequiredAction {
  return Boolean(action && action.audience === "owner" && action.satisfied_when.kind !== "none");
}

export function primaryOwnerSatisfiableAction(
  verdict: RefRenderedVerdict | null | undefined
): RefRequiredAction | null {
  const primary = verdict?.required_actions[0] ?? null;
  return isOwnerSatisfiableAction(primary) ? primary : null;
}

export function verdictRequiresOwnerNow(verdict: RefRenderedVerdict | null | undefined): boolean {
  return verdict?.channel === "attention" && primaryOwnerSatisfiableAction(verdict) !== null;
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
    deviceLocal: Boolean(input.deviceLocal),
    group,
    id: `${group}:${routeId}`,
    label: connectorLabel(connector),
    routeId,
    statusLabel: input.statusLabel,
    what: input.what,
  };
}

function classifySourceWork(connector: RefConnectorSummary): SourceWorkItem | null {
  if (connector.revoked_at) {
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

export function sourceWorkFromConnectors(connectors: readonly RefConnectorSummary[]): SourceWorkGroups {
  const groups: SourceWorkGroups = {
    checking: [],
    needsOwner: [],
    review: [],
    systemIssues: [],
  };
  const seen = new Set<string>();

  for (const connector of connectors) {
    const item = classifySourceWork(connector);
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

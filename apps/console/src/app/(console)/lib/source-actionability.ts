// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The source status derivation itself lives in `@pdpp/display` so this page and
 * the `sources-report` CLI read one producer rather than two hand-synced
 * copies. See `packages/display/src/source/source-status.ts` for why: the CLI's
 * partial copy never learned the `setup_failed` branch and printed "Revoked"
 * where this page printed "Setup never completed".
 *
 * This module keeps what is genuinely console-only: work grouping, CTA copy,
 * and route ids.
 */
import type { FusedSourceStatus, SourceStatusFlag } from "@pdpp/display";
import {
  isArchivedSource,
  isPausedSource,
  isRevokedSource,
  isSetupFailedSource,
  isSetupInProgressSource,
  projectSourceVerdict,
  TERMINAL_SETUP_DISPOSITION_COPY,
} from "@pdpp/display";
import { deriveFailureSummary, type FailureSummary } from "./connection-evidence.ts";
import type { FormattedNextAction } from "./next-action.ts";
import type {
  RefActionRemediation,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  RefSourceWorkGroup,
  RefTerminalSetupDisposition,
} from "./ref-client.ts";

export type {
  FusedSourceStatus,
  SourceStatusFlag,
  SourceStatusKind,
  SourceStatusTone,
  TerminalSetupDispositionCopy,
} from "@pdpp/display";
// biome-ignore lint/performance/noBarrelFile: these are the extracted derivation's console-facing names; re-exporting keeps existing call sites pointed at one producer.
export {
  deriveRenderedSourceStatus,
  deriveSourceVerdictStatus,
  fuseSourceStatus,
  TERMINAL_SETUP_DISPOSITION_COPY,
} from "@pdpp/display";

export type SourceWorkGroupId = "needsOwner" | "notMeasured" | "review" | "systemIssue" | "unavailable" | "working";

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
  unavailable: SourceWorkItem[];
  working: SourceWorkItem[];
}

export interface SourceActionabilityProjection {
  failureSummary: FailureSummary | null;
  /**
   * The single owner-facing status line: state, freshness, and activity fused
   * under the worst-honest-axis rule. See `fused-source-status.ts`.
   */
  fusedStatus: FusedSourceStatus;
  label: string;
  nextAction: FormattedNextAction | null;
  ownerActionByStream: SourceStreamOwnerActionAvailability;
  ownerActionCue: SourceOwnerActionCue | null;
  /** Collection is stopped but fully reversible. Never true when `revoked`. */
  paused: boolean;
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
  unavailable: [],
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
  notMeasured: {
    label: "Not measured",
    note: "Evidence is missing and no active check is running.",
  },
  review: {
    label: "Available actions",
    note: "Optional refreshes and retries you can start.",
  },
  systemIssue: {
    label: "System or connector issue",
    note: "PDPP needs to fix or retry this; no account action is needed from you.",
  },
  unavailable: {
    label: "Status unavailable",
    note: "This source is still listed, but its server-owned work status could not be read.",
  },
  working: {
    label: "PDPP is working",
    note: "Collection, recovery, or a bounded check is active.",
  },
};

/** The one owner-facing meaning of the headline "needs you" attention number. */
export interface SourceAttentionHeadline {
  /** Count of sources genuinely blocked on the owner's action (the needs-you group). */
  needsYou: number;
}

/**
 * The single derivation of the headline "how many sources need YOUR action"
 * number used by source-row and Runs triage. It counts ONLY the owner-required
 * (needs-you) group; the review, system-issue, and checking groups are
 * secondary and are never summed into this headline (owner decision
 * 2026-07-02). The aggregate dashboard hero intentionally follows the server
 * fleet verdict.
 */
export function sourceAttentionHeadline(groups: SourceWorkGroups): SourceAttentionHeadline {
  return { needsYou: groups.needsOwner.length };
}

const UNDERSCORE_RE = /_/g;

const UI_GROUP_BY_SERVER_GROUP: Readonly<Record<RefSourceWorkGroup, SourceWorkGroupId | null>> = {
  needs_owner: "needsOwner",
  not_measured: "notMeasured",
  none: null,
  review: "review",
  system_issue: "systemIssue",
  working: "working",
};

function sourceWorkGroupFromServerValue(value: unknown): SourceWorkGroupId {
  if (typeof value !== "string" || !Object.hasOwn(UI_GROUP_BY_SERVER_GROUP, value)) {
    return "unavailable";
  }
  return UI_GROUP_BY_SERVER_GROUP[value as RefSourceWorkGroup] ?? "unavailable";
}

const SERVER_GROUP_STATUS_LABEL: Readonly<Record<Exclude<RefSourceWorkGroup, "none">, string>> = {
  needs_owner: "needs you",
  not_measured: "is not measured",
  review: "needs review",
  system_issue: "needs attention",
  working: "is working",
};

function readableConnectorId(connectorId: string): string {
  return connectorId.replace(UNDERSCORE_RE, " ").trim() || connectorId;
}

function connectionRouteId(connector: RefConnectorSummary): string {
  return connector.connector_instance_id ?? connector.connection_id;
}

function connectorLabel(connector: RefConnectorSummary): string {
  return (
    connector.display_name.trim() ||
    connector.connector_display_name?.trim() ||
    readableConnectorId(connector.connector_id)
  );
}

/**
 * The lifecycle predicates below keep their console-facing `*Connector` names
 * (dozens of call sites read them) but delegate to `@pdpp/display`, so the
 * console and the `sources-report` CLI branch on the SAME definition of
 * revoked/paused/draft/archived/setup-failed.
 */
export function isRevokedConnector(connector: RefConnectorSummary): boolean {
  return isRevokedSource(connector);
}

export function isPausedConnector(connector: RefConnectorSummary): boolean {
  return isPausedSource(connector);
}

export function isSetupInProgressConnector(connector: RefConnectorSummary): boolean {
  return isSetupInProgressSource(connector);
}

export function isOwnerSatisfiableAction(action: RefRequiredAction | null | undefined): action is RefRequiredAction {
  return Boolean(action && action.audience === "owner" && action.satisfied_when.kind !== "none");
}

export function primaryRequiredAction(verdict: RefRenderedVerdict | null | undefined): RefRequiredAction | null {
  const action = verdict?.required_actions[0] ?? null;
  if (action?.kind === "wait" && action.audience === "none" && action.satisfied_when.kind === "none") {
    return null;
  }
  return action;
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
  // biome-ignore lint/suspicious/noUnnecessaryConditions: primaryOwnerActionRemediation returns RefActionRemediation | null; tsc rejects removing this guard.
  return primaryOwnerActionRemediation(verdict)?.target.kind === "local_device";
}

export function verdictRequiresOwnerNow(verdict: RefRenderedVerdict | null | undefined): boolean {
  return verdict?.channel === "attention" && primaryOwnerSatisfiableAction(verdict) !== null;
}

/** The one owner-facing CTA label for a draft, not-yet-ingested connection. */
export const SETUP_IN_PROGRESS_CTA_LABEL = "Continue setup";

/**
 * A draft connection's `rendered_verdict` carries no lifecycle concept (see
 * {@link isSetupInProgressConnector}), so it never contains a "continue
 * setup" required action — this synthesizes the one honest CTA for that
 * state instead of reading it out of the verdict. The link target is the
 * SAME `detailHref` every other next-action CTA uses; `sources-view-model.ts`
 * routes `detailHref` to the durable `/connect/status/:id` page for a draft,
 * so this action, the Sources row, and the Syncs pending-setup card all
 * resolve to one place.
 */
export function formatRenderedRequiredAction(
  verdict: RefRenderedVerdict | null | undefined,
  pending = false,
  terminalSetupDisposition: RefTerminalSetupDisposition | null = null
): FormattedNextAction | null {
  if (terminalSetupDisposition) {
    return {
      actionTarget: "connection_detail",
      caveat: null,
      label: TERMINAL_SETUP_DISPOSITION_COPY[terminalSetupDisposition].actionLabel,
      notificationHint: null,
      variant: "structured",
    };
  }
  if (pending) {
    return {
      actionTarget: "connection_detail",
      caveat: null,
      label: SETUP_IN_PROGRESS_CTA_LABEL,
      notificationHint: null,
      variant: "structured",
    };
  }
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

/**
 * Synthesizes the same "Continue setup" action as
 * {@link formatRenderedRequiredAction}, in the passport-foot shape. Marked
 * `ownerRunnable` (not a `refresh_now`/`retry_gap` kind) so
 * `CollectionRunAction` renders it as a Link to `detailHref` rather than
 * falling through to the live "Sync now" button — a draft has no usable
 * credential/session yet, so offering to sync it now would be dishonest.
 */
function setupInProgressPrimaryVerdictAction(): SourcePrimaryVerdictAction {
  return {
    audience: "owner",
    channel: "attention",
    cta: SETUP_IN_PROGRESS_CTA_LABEL,
    kind: "reauth",
    ownerRunnable: true,
    satisfiedWhenKind: "credential_present_and_unrejected",
    terminal: false,
  };
}

function terminalSetupPrimaryVerdictAction(disposition: RefTerminalSetupDisposition): SourcePrimaryVerdictAction {
  return {
    audience: "owner",
    channel: "attention",
    cta: TERMINAL_SETUP_DISPOSITION_COPY[disposition].actionLabel,
    kind: "reauth",
    ownerRunnable: true,
    satisfiedWhenKind: "attention_resolved",
    terminal: true,
  };
}

export function formatPrimaryVerdictAction(
  verdict: RefRenderedVerdict | null | undefined,
  pending = false,
  terminalSetupDisposition: RefTerminalSetupDisposition | null = null
): SourcePrimaryVerdictAction | null {
  if (terminalSetupDisposition) {
    return terminalSetupPrimaryVerdictAction(terminalSetupDisposition);
  }
  if (pending) {
    return setupInProgressPrimaryVerdictAction();
  }
  if (!verdict) {
    return null;
  }
  const action = verdict.required_actions[0] ?? null;
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

/**
 * An ARCHIVED source: preserved records, no collection, never resuming.
 * Server-derived in `deriveSourceVisibility` (`ref-control.ts`) as
 * `source_visibility: "archived"`.
 *
 * `"hidden_from_sources"` is the retired spelling, still accepted so a
 * console deployed ahead of its reference keeps treating those rows as
 * archived rather than as live sources — failing toward the safe reading,
 * since the dangerous error is showing a dead source as collecting.
 *
 * Such a source must never generate owner-facing work. Its ONLY durable
 * content is records from past runs; it has no schedule, no stored
 * credential, and the owner has already acted on it (by deleting the
 * connection it came from). A "Reconnect this account and collection
 * resumes" prompt built from its `CredentialsValid: false` condition is
 * technically correct (no credential exists) but not actionable in the way
 * the copy implies — reconnecting does not "resume" anything, because
 * nothing here was ever a live collection the owner intends to continue.
 *
 * The Sources list now RENDERS these rows (in a distinct Archived group)
 * rather than dropping them, but the no-work rule is unchanged and applies
 * to every owner-facing work surface (`/syncs`, the dashboard "Needs you"
 * section) that reads `sourceWorkFromConnectors`.
 *
 * A SETUP-FAILED source is the sibling case: a revoked retired-setup-shell
 * binding that never had a successful run. It holds zero records by
 * construction and must never generate owner-facing work either — an archived
 * source once collected and is now terminal; a setup-failed source never
 * collected at all.
 *
 * Both predicates are `@pdpp/display`'s, re-exported here so the console and
 * the `sources-report` CLI classify these rows identically.
 */
export { isArchivedSource, isSetupFailedSource } from "@pdpp/display";

/** The one owner-facing CTA label for resuming a paused connection. */
export const RESUME_PAUSED_CTA_LABEL = "Resume";

export function sourceWorkItemFromConnector(connector: RefConnectorSummary): SourceWorkItem | null {
  if (isRevokedConnector(connector) || isArchivedSource(connector) || isSetupFailedSource(connector)) {
    return null;
  }

  // A paused source is surfaced in `review` ("Available actions"), never in
  // `needsOwner`. Nothing is broken and nothing is waiting on the owner — the
  // owner already decided to stop collecting — so counting it as "needs you"
  // would inflate the one number that is supposed to mean "you are blocking
  // something" (see `sourceAttentionHeadline`). But it must not vanish either:
  // a paused row that produced no work item at all (the `revoked` treatment)
  // would leave collection silently stopped with no path back on any list
  // surface. `review` is exactly the group for an optional action the owner
  // may take, so the source stays visible and carries its own way out.
  //
  // Checked before the verdict for the same reason `deriveRenderedSourceStatus`
  // ranks paused early: a paused row's verdict describes collection that has
  // stopped.
  if (isPausedConnector(connector)) {
    return itemFromConnector(connector, "review", {
      actionLabel: RESUME_PAUSED_CTA_LABEL,
      statusLabel: "is paused",
      what: "Collection is paused. Your existing records, schedule, and sign-in are kept — resume to start collecting again.",
    });
  }

  const terminalSetupDisposition = connector.terminal_setup_disposition ?? null;
  if (isSetupInProgressConnector(connector) && terminalSetupDisposition) {
    const copy = TERMINAL_SETUP_DISPOSITION_COPY[terminalSetupDisposition];
    return itemFromConnector(connector, "needsOwner", {
      actionLabel: copy.actionLabel,
      statusLabel: copy.statusLabel,
      what: copy.what,
    });
  }

  // Setup-in-progress outranks the verdict (see `isSetupInProgressConnector`):
  // a draft has no health/coverage evidence to derive work from, and the
  // owner genuinely has something to finish, so it always surfaces in the
  // needs-you group with the same "Continue setup" CTA every other draft
  // surface uses.
  if (isSetupInProgressConnector(connector)) {
    return itemFromConnector(connector, "needsOwner", {
      actionLabel: SETUP_IN_PROGRESS_CTA_LABEL,
      statusLabel: "needs you",
      what: "Finish connecting this source to start its first sync.",
    });
  }

  const verdict = connector.rendered_verdict;
  const ownerAction = primaryOwnerSatisfiableAction(verdict);
  const serverGroup = connector.source_work;
  const group = sourceWorkGroupFromServerValue(serverGroup);
  if (serverGroup === "none") {
    return null;
  }
  if (group === "unavailable") {
    return itemFromConnector(connector, group, {
      statusLabel: "is unavailable",
      what: "Source-work status is unavailable. Open source details to inspect this connection.",
    });
  }
  const actionLabel = ownerAction ? ownerAction.cta : null;
  const deviceLocal = Boolean(ownerAction?.remediation && ownerAction.remediation.target.kind === "local_device");
  const what = verdict ? verdict.forward_statement : SOURCE_WORK_GROUP_COPY[group].note;
  return itemFromConnector(connector, group, {
    actionLabel,
    deviceLocal,
    statusLabel: SERVER_GROUP_STATUS_LABEL[serverGroup as Exclude<RefSourceWorkGroup, "none">],
    what,
  });
}

export function projectSourceActionability(connector: RefConnectorSummary): SourceActionabilityProjection {
  const routeId = connectionRouteId(connector);
  const label = connectorLabel(connector);
  // ONE producer for the status the owner reads. `projectSourceVerdict`
  // (@pdpp/display) derives the lifecycle facts, the single-slot
  // `renderedStatus`, and the fused line together, so this page and the
  // `sources-report` CLI cannot rank the same connection differently.
  const verdict = projectSourceVerdict(connector);
  const { archived, paused, pending, revoked, setupFailed, terminalSetupDisposition } = verdict.facts;
  // An archived or setup-failed source offers NO action ON THIS ROW. An
  // archived source's stored verdict still carries the required actions from
  // when it was live — typically "Reconnect this account and collection
  // resumes", which leads nowhere: reconnecting mints a new connection and
  // resumes nothing here. A setup-failed source never had a credential or
  // schedule to begin with, so its detail page has nothing actionable either
  // — `NextActionCta` (`sources-view.tsx`) always links to THIS row's detail
  // page, and that would be a dead end. The honest next step for both is a
  // fresh attempt, which the page's own "add a source" link already offers.
  // Suppressing at the projection root keeps every surface (list cue,
  // passport foot, /syncs) consistent, the same intent `dfbbb8843`
  // established for archived rows.
  const noVerdictAction = archived || setupFailed;
  const primaryAction = pending || noVerdictAction ? null : primaryRequiredAction(connector.rendered_verdict);
  const primaryVerdictAction = noVerdictAction
    ? null
    : formatPrimaryVerdictAction(connector.rendered_verdict, pending, terminalSetupDisposition);
  return {
    // A failure summary is display formatting for a server verdict. Never use
    // the raw health snapshot as a classifier when the verdict is absent.
    failureSummary:
      pending || noVerdictAction || !connector.rendered_verdict
        ? null
        : deriveFailureSummary(connector.connection_health, connector.rendered_verdict),
    label,
    nextAction: noVerdictAction
      ? null
      : formatRenderedRequiredAction(connector.rendered_verdict, pending, terminalSetupDisposition),
    ownerActionByStream: pending ? {} : ownerActionAvailabilityByStream(connector.rendered_verdict ?? null),
    ownerActionCue: ownerActionCueFromVerdictAction(primaryVerdictAction),
    paused,
    primaryAction,
    primaryVerdictAction,
    fusedStatus: verdict.fusedStatus,
    renderedStatus: verdict.renderedStatus,
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
    unavailable: [],
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
      case "unavailable":
        groups.unavailable.push(item);
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

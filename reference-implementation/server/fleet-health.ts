// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Pure owner-fleet health composition over already-read typed evidence. */

import type {
  AttentionAxis,
  ConnectionHealthSnapshot,
  ConnectionHealthState,
  CoverageAxis,
  ForwardDisposition,
  FreshnessAxis,
  OutboxAxis,
  RemoteSurfaceAxis,
} from "../runtime/connection-health.ts";
import type { OwnerStateResolver } from "../runtime/owner-state.ts";
import type { RenderedVerdict } from "../runtime/rendered-verdict.ts";
import type { ConnectorSummary } from "./ref-control.ts";

export type FleetCoverageAuditState = "fail" | "inconclusive" | "pass";
export type FleetHealthState = "healthy" | "healthy_with_advisories" | "indeterminate" | "unhealthy";
export type FleetRuntimeState = "healthy" | "unhealthy" | "unknown";

export interface FleetConfiguredConnection {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly displayName: string;
  readonly revokedAt: string | null;
  readonly status: string;
}

export type FleetSummary = Pick<
  ConnectorSummary,
  | "connection_health"
  | "connection_id"
  | "connector_id"
  | "connector_instance_id"
  | "display_name"
  | "owner_state"
  | "rendered_verdict"
  | "schedule"
>;

export interface FleetConnectionReference {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly display_name: string;
}

export interface FleetHealthVerdict {
  readonly dimensions: {
    readonly active_work: readonly FleetConnectionReference[];
    readonly attention: { readonly needs_owner: readonly FleetConnectionReference[] };
    readonly coverage_audit: FleetCoverageAuditState;
    readonly freshness_advisories: readonly FleetConnectionReference[];
    readonly intentional_policy: {
      readonly manual: readonly FleetConnectionReference[];
      readonly paused: readonly FleetConnectionReference[];
    };
    readonly recovery: {
      readonly retryable: readonly FleetConnectionReference[];
      readonly terminal: readonly FleetConnectionReference[];
    };
    readonly runtime: FleetRuntimeState;
    readonly stalled_work: readonly FleetConnectionReference[];
    readonly system: { readonly degraded_or_broken: readonly FleetConnectionReference[] };
    readonly unknown_evidence: readonly FleetConnectionReference[];
  };
  readonly fully_healthy: boolean;
  readonly scope: {
    readonly assessed: readonly FleetConnectionReference[];
    readonly configured: number;
    readonly intentional_exclusions: readonly FleetConnectionReference[];
    readonly setup_pending: readonly FleetConnectionReference[];
    readonly unassessed: readonly FleetConnectionReference[];
  };
  readonly state: FleetHealthState;
}

type EvidenceState =
  | "active"
  | "advisory"
  | "healthy"
  | "needs_owner"
  | "retryable"
  | "terminal"
  | "unhealthy"
  | "unknown";
type InventoryScope = "excluded" | "operational" | "setup_pending" | "unknown";

// These closed tables are the fleet policy over the typed connection-health
// projection. A new upstream member cannot silently become green: TypeScript
// requires it to be classified here before this module can compile.
const HEADLINE_EVIDENCE = {
  blocked: "unhealthy",
  cooling_off: "unhealthy",
  degraded: "unhealthy",
  healthy: "healthy",
  idle: "healthy",
  needs_attention: "unhealthy",
  unknown: "unknown",
} as const satisfies Readonly<Record<ConnectionHealthState, EvidenceState>>;

const OWNER_RESOLVER_EVIDENCE = {
  blocked_maintainer: "unhealthy",
  collecting: "active",
  healthy: "healthy",
  needs_owner: "needs_owner",
  not_measured: "unknown",
  owner_paused: "healthy",
  refresh_due: "advisory",
  retired: "unknown",
  setup_in_progress: "unknown",
  system_degraded: "unhealthy",
} as const satisfies Readonly<Record<OwnerStateResolver, EvidenceState>>;

const ATTENTION_EVIDENCE = {
  acknowledged: "needs_owner",
  in_progress: "needs_owner",
  none: "healthy",
  open: "needs_owner",
} as const satisfies Readonly<Record<AttentionAxis, EvidenceState>>;

const COVERAGE_EVIDENCE = {
  complete: "healthy",
  deferred: "healthy",
  gaps: "unhealthy",
  inventory_only: "healthy",
  partial: "unhealthy",
  retryable_gap: "retryable",
  terminal_gap: "terminal",
  unavailable: "healthy",
  unknown: "unknown",
  unsupported: "healthy",
} as const satisfies Readonly<Record<CoverageAxis, EvidenceState>>;

const FRESHNESS_EVIDENCE = {
  fresh: "healthy",
  stale: "advisory",
  unknown: "unknown",
} as const satisfies Readonly<Record<FreshnessAxis, EvidenceState>>;

const OUTBOX_EVIDENCE = {
  active: "active",
  idle: "healthy",
  stalled: "unhealthy",
  unknown: "unknown",
} as const satisfies Readonly<Record<OutboxAxis, EvidenceState>>;

const REMOTE_SURFACE_EVIDENCE = {
  failed: "unhealthy",
  idle: "healthy",
  leased: "healthy",
  none: "healthy",
  unknown: "unknown",
  waiting: "healthy",
} as const satisfies Readonly<Record<RemoteSurfaceAxis, EvidenceState>>;

const FORWARD_DISPOSITION_EVIDENCE = {
  awaiting_owner: "needs_owner",
  checking: "active",
  complete: "healthy",
  owner_refresh_due: "advisory",
  resumable: "retryable",
  terminal: "terminal",
  unmeasured: "unknown",
} as const satisfies Readonly<Record<ForwardDisposition, EvidenceState>>;

/** Preserve fail-closed behavior if an untyped transport bypasses its schema. */
function evidenceFor<T extends string>(table: Readonly<Record<T, EvidenceState>>, value: T): EvidenceState {
  return table[value] ?? "unknown";
}

interface MutableFleetEvidence {
  readonly activeWork: FleetConnectionReference[];
  readonly degradedOrBroken: FleetConnectionReference[];
  readonly freshnessAdvisories: FleetConnectionReference[];
  readonly manual: FleetConnectionReference[];
  readonly needsOwner: FleetConnectionReference[];
  readonly paused: FleetConnectionReference[];
  readonly retryable: FleetConnectionReference[];
  readonly stalledWork: FleetConnectionReference[];
  readonly terminal: FleetConnectionReference[];
  readonly unknownEvidence: FleetConnectionReference[];
}

interface ReconciledFleetScope {
  readonly assessed: FleetConnectionReference[];
  readonly intentionalExclusions: FleetConnectionReference[];
  readonly operationalSummaries: FleetSummary[];
  readonly setupPending: FleetConnectionReference[];
  readonly unassessed: FleetConnectionReference[];
}

function inventoryReference(connection: FleetConfiguredConnection): FleetConnectionReference {
  return {
    connection_id: connection.connectorInstanceId,
    connector_id: connection.connectorId,
    connector_instance_id: connection.connectorInstanceId,
    display_name: connection.displayName,
  };
}

function summaryReference(summary: FleetSummary): FleetConnectionReference {
  return {
    connection_id: summary.connection_id,
    connector_id: summary.connector_id,
    connector_instance_id: summary.connector_instance_id,
    display_name: summary.display_name,
  };
}

function inventoryScope(connection: FleetConfiguredConnection): InventoryScope {
  if (connection.revokedAt !== null) {
    return "excluded";
  }
  switch (connection.status) {
    case "active":
    case "paused":
      return "operational";
    case "draft":
    case "setup_in_progress":
      return "setup_pending";
    case "revoked":
      return "excluded";
    default:
      return "unknown";
  }
}

function hasMaintainerCodeFix(verdict: RenderedVerdict): boolean {
  return verdict.required_actions.some((action) => action.audience === "maintainer" && action.kind === "code_fix");
}

function hasOwnerBlockingAction(verdict: RenderedVerdict): boolean {
  // `channel` is the typed owner-interruption decision: advisory actions are
  // optional accelerants, while attention means the owner is the sole resolver.
  return (
    verdict.channel === "attention" &&
    verdict.required_actions.some((action) => action.audience === "owner" && action.satisfied_when.kind !== "none")
  );
}

function hasCurrentCondition(
  snapshot: ConnectionHealthSnapshot,
  type: "AttentionClear" | "RemoteSurfaceAvailable" | "RuntimeAvailable"
): boolean {
  return snapshot.conditions.some(
    (condition) => condition.current && condition.type === type && condition.status === "false"
  );
}

function isActiveWork(summary: FleetSummary): boolean {
  const { connection_health: health, owner_state: ownerState } = summary;
  return (
    health.badges.syncing ||
    evidenceFor(OUTBOX_EVIDENCE, health.axes.outbox) === "active" ||
    evidenceFor(FORWARD_DISPOSITION_EVIDENCE, health.forward_disposition) === "active" ||
    evidenceFor(OWNER_RESOLVER_EVIDENCE, ownerState.resolver) === "active"
  );
}

function hasUnknownEvidence(summary: FleetSummary): boolean {
  const { connection_health: health, owner_state: ownerState } = summary;
  return (
    // `connection_health.state` is the canonical composition of whether an
    // axis applies. In particular, a normal server connection can carry an
    // intentionally inapplicable raw `outbox: "unknown"` while remaining
    // healthy. Do not recompose raw axes here.
    evidenceFor(HEADLINE_EVIDENCE, health.state) === "unknown" ||
    health.unknown_reasons.length > 0 ||
    // These are independent composed dispositions, not raw axes. Keep their
    // fail-closed behavior until their owning projections fold them into the
    // headline state.
    evidenceFor(OWNER_RESOLVER_EVIDENCE, ownerState.resolver) === "unknown" ||
    evidenceFor(FORWARD_DISPOSITION_EVIDENCE, health.forward_disposition) === "unknown"
  );
}

function runtimeState(runtime: { readonly ok?: boolean } | null | undefined): FleetRuntimeState {
  if (runtime?.ok === true) {
    return "healthy";
  }
  if (runtime?.ok === false) {
    return "unhealthy";
  }
  return "unknown";
}

function pushIf(items: FleetConnectionReference[], condition: boolean, ref: FleetConnectionReference): void {
  if (condition) {
    items.push(ref);
  }
}

function reconcileFleetScope(
  inventory: readonly FleetConfiguredConnection[],
  summaries: readonly FleetSummary[]
): ReconciledFleetScope {
  const summariesByConnectionId = new Map(summaries.map((summary) => [summary.connection_id, summary]));
  const inventoryByConnectionId = new Map(inventory.map((connection) => [connection.connectorInstanceId, connection]));
  const assessed: FleetConnectionReference[] = [];
  const intentionalExclusions: FleetConnectionReference[] = [];
  const operationalSummaries: FleetSummary[] = [];
  const setupPending: FleetConnectionReference[] = [];
  const unassessed: FleetConnectionReference[] = [];

  for (const connection of inventory) {
    const ref = inventoryReference(connection);
    const scope = inventoryScope(connection);
    if (scope === "excluded") {
      intentionalExclusions.push(ref);
      continue;
    }
    if (scope === "setup_pending") {
      setupPending.push(ref);
      continue;
    }
    const summary = summariesByConnectionId.get(connection.connectorInstanceId);
    if (scope !== "operational" || !summary) {
      unassessed.push(ref);
      continue;
    }
    assessed.push(ref);
    operationalSummaries.push(summary);
  }

  for (const summary of summaries) {
    if (!inventoryByConnectionId.has(summary.connection_id)) {
      unassessed.push(summaryReference(summary));
    }
  }
  return { assessed, intentionalExclusions, operationalSummaries, setupPending, unassessed };
}

function collectSummaryEvidence(summary: FleetSummary, evidence: MutableFleetEvidence): void {
  const ref = summaryReference(summary);
  const { connection_health: health, owner_state: ownerState, rendered_verdict: verdict } = summary;
  const headlineEvidence = evidenceFor(HEADLINE_EVIDENCE, health.state);
  const ownerStateEvidence = evidenceFor(OWNER_RESOLVER_EVIDENCE, ownerState.resolver);
  const attentionEvidence = evidenceFor(ATTENTION_EVIDENCE, health.axes.attention);
  const coverageEvidence = evidenceFor(COVERAGE_EVIDENCE, health.axes.coverage);
  const freshnessEvidence = evidenceFor(FRESHNESS_EVIDENCE, health.axes.freshness);
  const outboxEvidence = evidenceFor(OUTBOX_EVIDENCE, health.axes.outbox);
  const remoteSurfaceEvidence = evidenceFor(REMOTE_SURFACE_EVIDENCE, health.axes.remote_surface);
  const forwardDispositionEvidence = evidenceFor(FORWARD_DISPOSITION_EVIDENCE, health.forward_disposition);
  pushIf(
    evidence.needsOwner,
    hasOwnerBlockingAction(verdict) ||
      hasCurrentCondition(health, "AttentionClear") ||
      attentionEvidence === "needs_owner" ||
      ownerStateEvidence === "needs_owner" ||
      forwardDispositionEvidence === "needs_owner",
    ref
  );
  pushIf(
    evidence.degradedOrBroken,
    headlineEvidence === "unhealthy" ||
      ownerStateEvidence === "unhealthy" ||
      coverageEvidence === "unhealthy" ||
      remoteSurfaceEvidence === "unhealthy" ||
      outboxEvidence === "unhealthy" ||
      hasMaintainerCodeFix(verdict) ||
      hasCurrentCondition(health, "RemoteSurfaceAvailable") ||
      hasCurrentCondition(health, "RuntimeAvailable"),
    ref
  );
  pushIf(evidence.retryable, coverageEvidence === "retryable" || forwardDispositionEvidence === "retryable", ref);
  pushIf(evidence.terminal, coverageEvidence === "terminal" || forwardDispositionEvidence === "terminal", ref);
  pushIf(evidence.stalledWork, outboxEvidence === "unhealthy", ref);
  pushIf(evidence.activeWork, isActiveWork(summary), ref);
  pushIf(
    evidence.freshnessAdvisories,
    freshnessEvidence === "advisory" || forwardDispositionEvidence === "advisory" || ownerStateEvidence === "advisory",
    ref
  );
  pushIf(evidence.manual, summary.schedule === null, ref);
  pushIf(evidence.paused, ownerState.resolver === "owner_paused", ref);
  pushIf(evidence.unknownEvidence, hasUnknownEvidence(summary), ref);
}

function collectFleetEvidence(summaries: readonly FleetSummary[]): MutableFleetEvidence {
  const evidence: MutableFleetEvidence = {
    activeWork: [],
    degradedOrBroken: [],
    freshnessAdvisories: [],
    manual: [],
    needsOwner: [],
    paused: [],
    retryable: [],
    stalledWork: [],
    terminal: [],
    unknownEvidence: [],
  };
  for (const summary of summaries) {
    collectSummaryEvidence(summary, evidence);
  }
  return evidence;
}

function fleetState(input: {
  readonly freshnessAdvisories: readonly FleetConnectionReference[];
  readonly indeterminate: boolean;
  readonly unhealthy: boolean;
}): FleetHealthState {
  if (input.unhealthy) {
    return "unhealthy";
  }
  if (input.indeterminate) {
    return "indeterminate";
  }
  if (input.freshnessAdvisories.length > 0) {
    return "healthy_with_advisories";
  }
  return "healthy";
}

/** Compose a strict fleet verdict from already-read, typed evidence. */
export function composeFleetHealthVerdict(input: {
  readonly coverageAudit: { readonly status: FleetCoverageAuditState };
  readonly inventory: readonly FleetConfiguredConnection[];
  readonly runtime: { readonly ok?: boolean } | null | undefined;
  readonly summaries: readonly FleetSummary[];
}): FleetHealthVerdict {
  const scope = reconcileFleetScope(input.inventory, input.summaries);
  const evidence = collectFleetEvidence(scope.operationalSummaries);
  const runtime = runtimeState(input.runtime);
  const unhealthy =
    runtime === "unhealthy" ||
    input.coverageAudit.status === "fail" ||
    evidence.needsOwner.length > 0 ||
    evidence.degradedOrBroken.length > 0 ||
    evidence.retryable.length > 0 ||
    evidence.terminal.length > 0 ||
    evidence.stalledWork.length > 0;
  const indeterminate =
    runtime === "unknown" ||
    input.coverageAudit.status === "inconclusive" ||
    scope.setupPending.length > 0 ||
    scope.unassessed.length > 0 ||
    evidence.activeWork.length > 0 ||
    evidence.unknownEvidence.length > 0;
  const state = fleetState({ freshnessAdvisories: evidence.freshnessAdvisories, indeterminate, unhealthy });

  return {
    dimensions: {
      active_work: evidence.activeWork,
      attention: { needs_owner: evidence.needsOwner },
      coverage_audit: input.coverageAudit.status,
      freshness_advisories: evidence.freshnessAdvisories,
      intentional_policy: { manual: evidence.manual, paused: evidence.paused },
      recovery: { retryable: evidence.retryable, terminal: evidence.terminal },
      runtime,
      stalled_work: evidence.stalledWork,
      system: { degraded_or_broken: evidence.degradedOrBroken },
      unknown_evidence: evidence.unknownEvidence,
    },
    fully_healthy: state === "healthy",
    scope: {
      assessed: scope.assessed,
      configured: input.inventory.length,
      intentional_exclusions: scope.intentionalExclusions,
      setup_pending: scope.setupPending,
      unassessed: scope.unassessed,
    },
    state,
  };
}

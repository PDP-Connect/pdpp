// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Pure owner-fleet health composition over already-read typed evidence. */

import type { StreamHealthAuthorityResult } from "../../scripts/stream-health-audit/authority.ts";
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
import {
  hasMaintainerCodeFix,
  hasOwnerBlockingAction,
  isPassiveScheduledRecovery,
  cadenceLatenessIsSoleDegradation,
} from "../runtime/rendered-verdict.ts";
import type { ConnectorSummary } from "./ref-control.ts";

export type FleetCoverageAuditState = StreamHealthAuthorityResult["status"];
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
  /**
   * Whether the owner-facing GLOBAL banner should fire. This is
   * DELIBERATELY NARROWER than `state !== "healthy"`: `state` is a rich
   * diagnostic signal (it also reports `indeterminate` for in-progress work
   * or reconciliation gaps, and `healthy_with_advisories` for any freshness
   * advisory) that remains useful for operator tooling and the strict
   * stream audit, but is NOT itself an actionability claim.
   *
   * The banner is a scarce, alarm-toned owner surface — per
   * `openspec/specs/reference-connection-health/spec.md`'s verdict-channel
   * requirement ("`attention` requires an owner-satisfiable required
   * action") applied at fleet scope: it fires ONLY when at least one
   * assessed connection is in a PROVEN `needs_owner` state (a real,
   * owner-satisfiable required action) or a materially `blocked` state (a
   * real unhealthy/degraded headline, a maintainer code-fix, or a
   * non-retryable terminal coverage gap — never a `retryable_gap`, which is
   * background retry with no owner action). It does NOT fire for: ordinary
   * cadence-relative lateness (`freshness_advisories`), in-progress/active
   * work, unassessed/setup-pending scope, unknown evidence, or a
   * provider-confirmed coverage-horizon disclosure (which never reaches
   * this composer at all — see `coverage-horizon.ts`). Every dimension
   * below is preserved unchanged; only banner-firing changed.
   */
  readonly banner_warranted: boolean;
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
  cooling_off: "advisory",
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
  /**
   * The subset of `degradedOrBroken` that is materially blocked for a
   * BANNER-WARRANTING reason — i.e. NOT solely because the connection's
   * headline state is `degraded` on account of an auto-retried
   * `retryable_gap` coverage axis. `degradedOrBroken` intentionally stays
   * broad (any `unhealthy`-mapped headline/coverage/remote-surface/outbox
   * evidence, matching the shipped `state`/`fully_healthy` semantics); this
   * bucket exists ONLY to feed `banner_warranted`, so a background-retried
   * gap that happens to also carry the generic `degraded` headline state
   * does not, by itself, light the global banner. See `banner_warranted`'s
   * doc comment on `FleetHealthVerdict`.
   */
  readonly materiallyBlocked: FleetConnectionReference[];
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
  /**
   * Connections excluded because their LIFECYCLE is `paused`.
   *
   * Read from inventory rather than from summary evidence: a paused row is
   * scoped `excluded` and never reaches `collectSummaryEvidence`, so the
   * `owner_paused` RESOLVER can no longer be the only producer of
   * `intentional_policy.paused`. Those are two different facts — the resolver
   * additionally requires `schedule_mode === "scheduled-disabled"` — and the
   * dimension is named for the lifecycle one.
   */
  readonly pausedLifecycle: FleetConnectionReference[];
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
      return "operational";
    // A paused connection is an INTENTIONAL archive, not a broken one. It is
    // not scheduled, so it cannot collect, so its evidence can only ever go
    // stale — grading it against the active fleet reports a self-inflicted
    // "degraded" that no owner action can clear, and keeps the banner red for
    // a connection nobody asked to run.
    //
    // `excluded` is the right scope rather than a new one: it routes to
    // `intentionalExclusions`, which stays VISIBLE in the response while
    // leaving the active-health denominator. That is exactly the contract
    // BANNER-ZERO-PLAN states — "archived and revoked setup history remains
    // visible where useful but never enters the active-health denominator"
    // and "the three archived rows remain visible and neutral".
    case "paused":
      return "excluded";
    case "draft":
    case "setup_in_progress":
      return "setup_pending";
    case "revoked":
      return "excluded";
    default:
      return "unknown";
  }
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
  const pausedLifecycle: FleetConnectionReference[] = [];
  const intentionalExclusions: FleetConnectionReference[] = [];
  const operationalSummaries: FleetSummary[] = [];
  const setupPending: FleetConnectionReference[] = [];
  const unassessed: FleetConnectionReference[] = [];

  for (const connection of inventory) {
    const ref = inventoryReference(connection);
    const scope = inventoryScope(connection);
    if (scope === "excluded") {
      intentionalExclusions.push(ref);
      if (connection.status === "paused") {
        pausedLifecycle.push(ref);
      }
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
  return { assessed, intentionalExclusions, operationalSummaries, pausedLifecycle, setupPending, unassessed };
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
  const passiveScheduledRecovery = isPassiveScheduledRecovery(health, verdict);
  const coolingOffWithoutPassiveEvidence = health.state === "cooling_off" && !passiveScheduledRecovery;
  pushIf(
    evidence.needsOwner,
    [
      hasOwnerBlockingAction(verdict),
      hasCurrentCondition(health, "AttentionClear"),
      attentionEvidence === "needs_owner",
      ownerStateEvidence === "needs_owner",
      forwardDispositionEvidence === "needs_owner",
    ].some(Boolean),
    ref
  );
  // Cadence-only lateness is excluded from `degradedOrBroken` itself, not just
  // from `materiallyBlocked`. Excluding it only downstream left the Sources
  // grouping quiet while the fleet STATE and its dimensions still called the
  // same row unhealthy — two surfaces disagreeing about one source, which is
  // the whole failure this workstream exists to end. A merely-late source
  // belongs in `freshness_advisories`; genuinely unrelated degradation still
  // reaches here through every other member below, pinned by the negative
  // controls in cadence-lateness-cross-surface.test.ts.
  const cadenceLateOnly = cadenceLatenessIsSoleDegradation(health);
  pushIf(
    evidence.degradedOrBroken,
    [
      headlineEvidence === "unhealthy" && !cadenceLateOnly,
      coolingOffWithoutPassiveEvidence,
      ownerStateEvidence === "unhealthy",
      coverageEvidence === "unhealthy",
      remoteSurfaceEvidence === "unhealthy",
      outboxEvidence === "unhealthy",
      hasMaintainerCodeFix(verdict),
      hasCurrentCondition(health, "RemoteSurfaceAvailable"),
      hasCurrentCondition(health, "RuntimeAvailable"),
    ].some(Boolean),
    ref
  );
  // Same set as `degradedOrBroken` MINUS two shapes: a `degraded`/`unhealthy`
  // headline explained ENTIRELY by a `retryable_gap` coverage axis with no
  // other unhealthy evidence (background retry, not a material block), and one
  // explained ENTIRELY by cadence lateness.
  //
  // The cadence exclusion is `cadenceLatenessIsSoleDegradation` — the SAME
  // shared predicate `owner-state.ts` uses for its resolver, so the banner and
  // the Sources grouping cannot disagree about whether a late source is a
  // system fault. It keys on the explicit `snapshot.lateness` FACT.
  //
  // NOT `staleFreshnessIsSoleDegradation`: that one is the broader
  // label-selection reading, and using it here would let ANY staleness-only
  // degradation suppress a material block on rendered tone alone — the
  // tone-as-evidence interpretation this predicate exists to replace. Every
  // other reason `degradedOrBroken` fires (owner state, remote-surface
  // failure, outbox failure, a maintainer code-fix, a real runtime/binding
  // condition failure) is unaffected and still material.

  pushIf(
    evidence.materiallyBlocked,
    [
      coolingOffWithoutPassiveEvidence,
      ownerStateEvidence === "unhealthy",
      coverageEvidence === "unhealthy",
      remoteSurfaceEvidence === "unhealthy",
      outboxEvidence === "unhealthy",
      hasMaintainerCodeFix(verdict),
      hasCurrentCondition(health, "RemoteSurfaceAvailable"),
      hasCurrentCondition(health, "RuntimeAvailable"),
      headlineEvidence === "unhealthy" && coverageEvidence !== "retryable" && !cadenceLateOnly,
    ].some(Boolean),
    ref
  );
  pushIf(evidence.retryable, coverageEvidence === "retryable" || forwardDispositionEvidence === "retryable", ref);
  pushIf(evidence.terminal, coverageEvidence === "terminal" || forwardDispositionEvidence === "terminal", ref);
  pushIf(evidence.stalledWork, outboxEvidence === "unhealthy", ref);
  pushIf(evidence.activeWork, isActiveWork(summary), ref);
  const otherAdvisory =
    health.state !== "cooling_off" &&
    [
      freshnessEvidence === "advisory",
      forwardDispositionEvidence === "advisory",
      ownerStateEvidence === "advisory",
    ].some(Boolean);
  pushIf(evidence.freshnessAdvisories, passiveScheduledRecovery || otherAdvisory, ref);
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
    materiallyBlocked: [],
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

/**
 * Stream-health classes whose `fail` is caused by the OWNER still owing an
 * action, not by the system being broken.
 *
 * Deliberately narrow. Everything absent from this set — `failed`, `stale`,
 * `unobserved`, `projection_disagreement`, `manifest_unavailable` — stays a
 * system signal and still fires the banner.
 */
const OWNER_CAUSED_STREAM_HEALTH_CLASSES = ["owner_interaction", "provider_config_blocked"] as const;

/**
 * The classes that can actually PRODUCE `status: "fail"` — mirrors
 * `resultStatus`'s `hardClasses` in `scripts/stream-health-audit/authority.ts`.
 *
 * Keying on this rather than "every class in `classCounts`" is essential:
 * `classCounts` also carries benign classes (`green`, `optional_unsupported`,
 * `revoked`, ...). Testing those would find a non-owner class with a non-zero
 * count on any fleet containing a single healthy stream, and the check would
 * silently never fire.
 */
const FAIL_PRODUCING_STREAM_HEALTH_CLASSES = [
  "owner_interaction",
  "provider_config_blocked",
  "unobserved",
  "failed",
  "stale",
  "projection_disagreement",
  "manifest_unavailable",
] as const;

/**
 * Does a `fail` from the stream audit indicate a SYSTEM defect?
 *
 * The audit is right to return `fail` for an active connection whose owner
 * owes an OTP or a captcha: that stream genuinely is not collecting, and
 * softening the audit to say otherwise would be exactly the "weaken audit
 * truth" move this must not make. The audit stays untouched.
 *
 * What is wrong is routing that verdict into the SYSTEM banner. A row waiting
 * on the owner already surfaces through `attention.needs_owner`; counting it
 * again as a system fault tells the owner the software is broken when the
 * software is working and waiting for them. It also makes the banner
 * unclearable by any amount of engineering, which is what keeps it red after
 * every real defect is closed.
 *
 * So: a `fail` warrants the banner unless EVERY failing class is owner-caused.
 * A mixed result — one owner row plus one genuinely broken stream — still
 * fires, because the broken stream is still a system defect.
 */
function streamHealthFailIsSystemCaused(
  streamHealth: Pick<StreamHealthAuthorityResult, "status"> &
    Partial<Pick<StreamHealthAuthorityResult, "classCounts">>
): boolean {
  if (streamHealth.status !== "fail") {
    return false;
  }
  const counts = streamHealth.classCounts;
  if (!counts || typeof counts !== "object") {
    // No breakdown to reason from: fail closed and keep the banner. An
    // unexplained audit failure is a system signal until proven otherwise.
    return true;
  }
  const ownerCaused = new Set<string>(OWNER_CAUSED_STREAM_HEALTH_CLASSES);
  const nonZero = (className: string): boolean => Number(counts[className as keyof typeof counts] ?? 0) > 0;

  // Suppress the banner ONLY when the breakdown positively EXPLAINS the fail
  // as owner-owed. An audit that says `fail` while naming no fail-producing
  // class at all — an empty `classCounts`, all-zero counts, or only benign
  // classes like `green`/`revoked` — is unexplained, and an unexplained fail
  // is a system signal until proven otherwise. Without this, a `fail` whose
  // cause the composer cannot see would silently go QUIET, which is strictly
  // worse than the over-firing this change exists to fix: it hides a real
  // defect from the owner instead of merely nagging about an owner-owed one.
  const ownerCausedFail = FAIL_PRODUCING_STREAM_HEALTH_CLASSES.some(
    (className) => ownerCaused.has(className) && nonZero(className)
  );
  if (!ownerCausedFail) {
    return true;
  }
  return FAIL_PRODUCING_STREAM_HEALTH_CLASSES.some((className) => !ownerCaused.has(className) && nonZero(className));
}

/** Compose a strict fleet verdict from already-read, typed evidence. */
export function composeFleetHealthVerdict(input: {
  readonly streamHealth: Pick<StreamHealthAuthorityResult, "status"> &
    Partial<Pick<StreamHealthAuthorityResult, "classCounts">>;
  readonly inventory: readonly FleetConfiguredConnection[];
  readonly runtime: { readonly ok?: boolean } | null | undefined;
  readonly summaries: readonly FleetSummary[];
}): FleetHealthVerdict {
  const scope = reconcileFleetScope(input.inventory, input.summaries);
  const evidence = collectFleetEvidence(scope.operationalSummaries);
  const runtime = runtimeState(input.runtime);
  const unhealthy =
    runtime === "unhealthy" ||
    input.streamHealth.status === "fail" ||
    evidence.needsOwner.length > 0 ||
    evidence.degradedOrBroken.length > 0 ||
    evidence.retryable.length > 0 ||
    evidence.terminal.length > 0 ||
    evidence.stalledWork.length > 0;
  const indeterminate =
    runtime === "unknown" ||
    input.streamHealth.status === "inconclusive" ||
    scope.setupPending.length > 0 ||
    scope.unassessed.length > 0 ||
    evidence.activeWork.length > 0 ||
    evidence.unknownEvidence.length > 0;

  // `intentional_policy.paused` reports every DELIBERATELY paused connection.
  //
  // Two disjoint sources, and they cannot overlap: a `status: "paused"` row is
  // scoped `excluded` and never enters `operationalSummaries`, so it can never
  // also appear via `evidence.paused` — which is populated only while walking
  // those summaries. No dedupe is needed, and adding one would be unreachable
  // code that no test could kill.
  //   - lifecycle `status: "paused"`  -> `scope.pausedLifecycle`
  //   - `owner_paused` RESOLVER on a still-ACTIVE row whose schedule the owner
  //     disabled (`schedule_mode === "scheduled-disabled"`) -> `evidence.paused`
  // Before this, only the resolver fed the dimension, so it was structurally
  // empty for exactly the archived rows it is named after.
  const pausedPolicy: FleetConnectionReference[] = [...scope.pausedLifecycle, ...evidence.paused];
  const state = fleetState({ freshnessAdvisories: evidence.freshnessAdvisories, indeterminate, unhealthy });
  // Actionability-only gate for the global banner: a proven owner action, or
  // a materially blocked connection (real unhealthy headline/coverage/
  // remote-surface/outbox, a maintainer code-fix, or a non-retryable
  // terminal coverage gap). Deliberately excludes `evidence.retryable`
  // (background retry, no owner action) and everything that only drives
  // `indeterminate`/`healthy_with_advisories` (active work, unassessed
  // scope, unknown evidence, freshness advisories, runtime/stream-health
  // "unknown"/"inconclusive"). See `banner_warranted`'s doc comment above.
  const bannerWarranted =
    runtime === "unhealthy" ||
    streamHealthFailIsSystemCaused(input.streamHealth) ||
    evidence.needsOwner.length > 0 ||
    evidence.materiallyBlocked.length > 0 ||
    evidence.terminal.length > 0 ||
    evidence.stalledWork.length > 0;

  return {
    banner_warranted: bannerWarranted,
    dimensions: {
      active_work: evidence.activeWork,
      attention: { needs_owner: evidence.needsOwner },
      coverage_audit: input.streamHealth.status,
      freshness_advisories: evidence.freshnessAdvisories,
      intentional_policy: { manual: evidence.manual, paused: pausedPolicy },
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

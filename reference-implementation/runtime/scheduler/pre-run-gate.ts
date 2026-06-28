/**
 * Pre-run gate cascade for the scheduler.
 *
 * Encapsulates the pre-launch gate sequence that `executeRun` runs before
 * dispatching a connector. The cascade order is the invariant:
 *   durable attention → automation policy → readiness → needs-human → grant state.
 *
 * Extracted from `createScheduler` in scheduler.ts as a narrow factory so
 * the gate logic can be read and tested without owning the full scheduler closure.
 */

import {
  type AutomationRefreshPolicy,
  projectRunAutomationPolicy,
} from "../run-automation-policy.ts";
import type {
  ConnectorSchedule,
  GrantAccessMode,
  HasUnresolvedAttentionHandler,
  HumanRequiredStateEscalationHandler,
  IsNeedsHumanHandler,
  RunRecord,
  RunSource,
  SchedulerManifest,
  SchedulerReadinessChecker,
  TerminalGrantFailureReason,
  UnresolvedAttentionEvidence,
} from "../scheduler.ts";

// ─── Dep types ───────────────────────────────────────────────────────────────

/**
 * Runtime state cells the gate functions read and mutate.
 * Passed by reference so mutations take effect in the shared runtime.
 */
export interface PreRunGateRuntimeState {
  readonly disabledGrantFailures: Map<string, TerminalGrantFailureReason>;
  readonly exhaustedGrants: Set<string>;
  readonly notifiedAttentionSkips: Map<string, string>;
  readonly notifiedDisabledGrantFailures: Set<string>;
  readonly notifiedNeedsHumanSkips: Set<string>;
  readonly notifiedNotReadySkips: Map<string, string>;
}

export interface PreRunGateDeps {
  hasUnresolvedAttention: HasUnresolvedAttentionHandler;
  isNeedsHuman: IsNeedsHumanHandler;
  onHumanRequiredStateEscalation: HumanRequiredStateEscalationHandler;
  readinessChecker: SchedulerReadinessChecker;
  runtime: PreRunGateRuntimeState;
  recordAndNotify: (record: RunRecord) => RunRecord;
}

// ─── Gate outcome type ───────────────────────────────────────────────────────

/**
 * Outcome of a pre-run gate check.
 * `"proceed"` means the gate is clear; any other value is the value
 * `executeRun` must return immediately (a recorded skip or `null` for silent).
 */
export type GateOutcome = "proceed" | RunRecord | null;

// ─── Local helpers (mirrored from scheduler.ts; kept in sync by extraction) ──

function buildScheduledRunSource(connectorId: string): RunSource {
  return { kind: "connector", id: connectorId };
}

function runtimeKey(schedule: Pick<ConnectorSchedule, "connectorId" | "connectorInstanceId">): string {
  return schedule.connectorInstanceId || schedule.connectorId;
}

function getManifestRefreshPolicy(manifest: SchedulerManifest | null | undefined): AutomationRefreshPolicy | null {
  const capabilities =
    manifest && typeof manifest === "object" ? (manifest as { capabilities?: unknown }).capabilities : null;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  const policy = (capabilities as { refresh_policy?: unknown }).refresh_policy;
  return policy && typeof policy === "object" && !Array.isArray(policy) ? (policy as AutomationRefreshPolicy) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildSingleUseExhaustedSkip(connectorId: string, connectorInstanceId?: string): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: "single_use grant already consumed",
    attempt: 0,
  };
}

function buildDisabledGrantSkip(
  connectorId: string,
  terminalReason: TerminalGrantFailureReason,
  connectorInstanceId?: string
): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    terminalReason,
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `${terminalReason} grant no longer usable`,
    attempt: 0,
  };
}

function buildUnresolvedAttentionSkip(
  connectorId: string,
  evidence: UnresolvedAttentionEvidence,
  connectorInstanceId?: string
): RunRecord {
  const tail = evidence.reason ? `: ${evidence.reason} (${evidence.key})` : `: ${evidence.key}`;
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `attention_unresolved${tail}`,
    attempt: 0,
  };
}

function buildNeedsHumanSkip(connectorId: string, connectorInstanceId?: string): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: "needs_human_attention: automatic run skipped until owner provides input",
    attempt: 0,
  };
}

function buildNotReadySkip(connectorId: string, reason: string, connectorInstanceId?: string): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `not_ready: ${reason}`,
    attempt: 0,
  };
}

function buildAutomationPolicySkip(
  connectorId: string,
  reason: string | null,
  connectorInstanceId?: string
): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `automation_policy_blocked: ${reason || "automatic run is not allowed by connector policy"}`,
    attempt: 0,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface PreRunGate {
  probeUnresolvedAttention(
    connectorId: string,
    connectorInstanceId: string
  ): Promise<UnresolvedAttentionEvidence | null>;
  gateAttention(connectorId: string, connectorInstanceId: string, key: string): Promise<GateOutcome>;
  gateAutomationPolicy(
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    policy: ReturnType<typeof projectRunAutomationPolicy>
  ): GateOutcome;
  decideNotReady(schedule: ConnectorSchedule): Promise<"proceed" | "silent-skip" | RunRecord>;
  gateNeedsHuman(connectorId: string, connectorInstanceId: string, key: string): GateOutcome;
  maybeSkipSingleUseExhausted(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: GrantAccessMode
  ): RunRecord | null;
  decideDisabledGrant(
    connectorId: string,
    connectorInstanceId: string
  ): "proceed" | "silent-skip" | RunRecord;
  gateGrantState(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: NonNullable<ConnectorSchedule["grantAccessMode"]>
  ): GateOutcome;
  runAutomaticPreflight(
    schedule: ConnectorSchedule,
    key: string,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>
  ): Promise<GateOutcome>;
}

export function createPreRunGate(deps: PreRunGateDeps): PreRunGate {
  const {
    hasUnresolvedAttention,
    isNeedsHuman,
    onHumanRequiredStateEscalation,
    readinessChecker,
    runtime,
    recordAndNotify,
  } = deps;

  async function probeUnresolvedAttention(
    connectorId: string,
    connectorInstanceId: string
  ): Promise<UnresolvedAttentionEvidence | null> {
    try {
      const observed = await hasUnresolvedAttention(connectorId, connectorInstanceId);
      return observed ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] attention probe failed for ${connectorId}: ${message}`);
      return null;
    }
  }

  function maybeSkipSingleUseExhausted(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: GrantAccessMode
  ): RunRecord | null {
    if (grantAccessMode !== "single_use" || !runtime.exhaustedGrants.has(connectorInstanceId)) {
      return null;
    }
    return recordAndNotify(buildSingleUseExhaustedSkip(connectorId, connectorInstanceId));
  }

  type NotReadyDecision = "proceed" | "silent-skip" | RunRecord;

  async function decideNotReady(schedule: ConnectorSchedule): Promise<NotReadyDecision> {
    const readiness = await readinessChecker(schedule);
    const key = runtimeKey(schedule);
    if (!readiness || readiness.ready) {
      runtime.notifiedNotReadySkips.delete(key);
      return "proceed";
    }
    const projection = projectRunAutomationPolicy({
      triggerKind: "scheduled",
      refreshPolicy: getManifestRefreshPolicy(schedule.manifest),
      deploymentReadiness: {
        ready: false,
        reason: readiness.reason || "scheduled connector runtime prerequisites are not currently satisfied",
      },
    });
    const reason = projection.reason || "scheduled connector runtime prerequisites are not currently satisfied";
    if (runtime.notifiedNotReadySkips.get(key) === reason) {
      return "silent-skip";
    }
    runtime.notifiedNotReadySkips.set(key, reason);
    return recordAndNotify(buildNotReadySkip(schedule.connectorId, reason, schedule.connectorInstanceId));
  }

  type DisabledGrantDecision = "proceed" | "silent-skip" | RunRecord;

  function decideDisabledGrant(connectorId: string, connectorInstanceId: string): DisabledGrantDecision {
    if (!runtime.disabledGrantFailures.has(connectorInstanceId)) {
      return "proceed";
    }
    if (runtime.notifiedDisabledGrantFailures.has(connectorInstanceId)) {
      return "silent-skip";
    }
    const terminalReason = runtime.disabledGrantFailures.get(connectorInstanceId);
    if (!terminalReason) {
      return "proceed";
    }
    runtime.notifiedDisabledGrantFailures.add(connectorInstanceId);
    return recordAndNotify(buildDisabledGrantSkip(connectorId, terminalReason, connectorInstanceId));
  }

  async function gateAttention(connectorId: string, connectorInstanceId: string, key: string): Promise<GateOutcome> {
    const attentionEvidence = await probeUnresolvedAttention(connectorId, connectorInstanceId);
    if (attentionEvidence?.key) {
      if (runtime.notifiedAttentionSkips.get(key) === attentionEvidence.key) {
        return null;
      }
      runtime.notifiedAttentionSkips.set(key, attentionEvidence.key);
      return recordAndNotify(buildUnresolvedAttentionSkip(connectorId, attentionEvidence, connectorInstanceId));
    }
    runtime.notifiedAttentionSkips.delete(key);
    return "proceed";
  }

  function gateAutomationPolicy(
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    policy: ReturnType<typeof projectRunAutomationPolicy>
  ): GateOutcome {
    if (policy.allowed_to_start) {
      return "proceed";
    }
    const reason = policy.reason || "automatic run is not allowed by connector policy";
    const dedupeReason = `automation_policy_blocked:${reason}`;
    if (runtime.notifiedNotReadySkips.get(key) === dedupeReason) {
      return null;
    }
    runtime.notifiedNotReadySkips.set(key, dedupeReason);
    return recordAndNotify(buildAutomationPolicySkip(connectorId, reason, connectorInstanceId));
  }

  function gateNeedsHuman(connectorId: string, connectorInstanceId: string, key: string): GateOutcome {
    if (!isNeedsHuman(connectorId, connectorInstanceId)) {
      runtime.notifiedNeedsHumanSkips.delete(key);
      return "proceed";
    }
    if (runtime.notifiedNeedsHumanSkips.has(key)) {
      return null;
    }
    runtime.notifiedNeedsHumanSkips.add(key);
    Promise.resolve(
      onHumanRequiredStateEscalation({
        connectorId,
        connectorInstanceId,
        reason: "needs_attention",
      })
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] §10-F needs_attention escalation callback failed for ${connectorId}: ${message}`);
    });
    return recordAndNotify(buildNeedsHumanSkip(connectorId, connectorInstanceId));
  }

  async function runAutomaticPreflight(
    schedule: ConnectorSchedule,
    key: string,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>
  ): Promise<GateOutcome> {
    const { connectorId, connectorInstanceId = connectorId } = schedule;

    const attention = await gateAttention(connectorId, connectorInstanceId, key);
    if (attention !== "proceed") {
      return attention;
    }
    const policyDecision = gateAutomationPolicy(connectorId, connectorInstanceId, key, automationPolicy);
    if (policyDecision !== "proceed") {
      return policyDecision;
    }
    const notReadyDecision = await decideNotReady(schedule);
    if (notReadyDecision === "silent-skip") {
      return null;
    }
    if (notReadyDecision !== "proceed") {
      return notReadyDecision;
    }
    return gateNeedsHuman(connectorId, connectorInstanceId, key);
  }

  function gateGrantState(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: NonNullable<ConnectorSchedule["grantAccessMode"]>
  ): GateOutcome {
    const singleUseSkip = maybeSkipSingleUseExhausted(connectorId, connectorInstanceId, grantAccessMode);
    if (singleUseSkip) {
      return singleUseSkip;
    }
    const disabledDecision = decideDisabledGrant(connectorId, connectorInstanceId);
    if (disabledDecision === "silent-skip") {
      return null;
    }
    return disabledDecision;
  }

  return {
    probeUnresolvedAttention,
    gateAttention,
    gateAutomationPolicy,
    decideNotReady,
    gateNeedsHuman,
    maybeSkipSingleUseExhausted,
    decideDisabledGrant,
    gateGrantState,
    runAutomaticPreflight,
  };
}

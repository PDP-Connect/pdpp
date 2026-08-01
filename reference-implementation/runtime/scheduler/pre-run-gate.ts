// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { type AutomationRefreshPolicy, projectRunAutomationPolicy } from "../run-automation-policy.ts";
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
} from "../scheduler-domain-types.ts";
import {
  decideSynthesizedRevalidation,
  SYNTHESIZED_REVALIDATION_PENDING_MARKER,
  type SynthesizedRevalidationOptions,
} from "./synthesized-attention-revalidation.ts";

// ─── Dep types ───────────────────────────────────────────────────────────────

/**
 * Runtime state cells the gate functions read and mutate.
 * Passed by reference so mutations take effect in the shared runtime.
 */
export interface PreRunGateRuntimeState {
  readonly disabledGrantFailures: Map<string, TerminalGrantFailureReason>;
  readonly exhaustedGrants: Set<string>;
  /**
   * Durable run history (hydrated from `run_history` on restart, same object
   * the dispatch governor filters). `gateAttention` reads it — never
   * writes — to compute `decideSynthesizedRevalidation`'s cadence for
   * synthesized owner-action evidence.
   */
  readonly history: readonly RunRecord[];
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
  recordAndNotify: (record: RunRecord) => RunRecord;
  runtime: PreRunGateRuntimeState;
  /**
   * Optional tuning for `decideSynthesizedRevalidation` (initial delay,
   * backoff exponent cap, max delay). Defaults to production constants when
   * omitted — tests use this to avoid waiting on real wall-clock cooldowns.
   */
  synthesizedRevalidationOptions?: SynthesizedRevalidationOptions;
}

// ─── Gate outcome type ───────────────────────────────────────────────────────

/**
 * Outcome of a pre-run gate check.
 * `"proceed"` means the gate is clear; any other value is the value
 * `executeRun` must return immediately (a recorded skip or `null` for silent).
 */
export type GateOutcome = "proceed" | RunRecord | null;

/**
 * Outcome of `gateAttention` specifically: adds `"proceed-revalidation-only"`
 * to `GateOutcome` — the gate is clear, but ONLY for the bounded,
 * non-interactive confirming run `decideSynthesizedRevalidation` admitted for
 * stale SYNTHESIZED evidence (never for durable evidence, which still blocks
 * unconditionally like `"proceed"`'s durable-clear case). `executeRun` must
 * dispatch with `triggerKind: "revalidation"` rather than the ordinary
 * scheduled trigger kind when it sees this value.
 */
export type AttentionGateOutcome = GateOutcome | "proceed-revalidation-only";

// ─── Local helpers (mirrored from scheduler.ts; kept in sync by extraction) ──

function buildScheduledRunSource(connectorId: string): RunSource {
  return { id: connectorId, kind: "connector" };
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
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: "single_use grant already consumed",
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildDisabledGrantSkip(
  connectorId: string,
  terminalReason: TerminalGrantFailureReason,
  connectorInstanceId?: string
): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `${terminalReason} grant no longer usable`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
    terminalReason,
  };
}

function buildUnresolvedAttentionSkip(
  connectorId: string,
  evidence: UnresolvedAttentionEvidence,
  connectorInstanceId?: string
): RunRecord {
  const tail = evidence.reason ? `: ${evidence.reason} (${evidence.key})` : `: ${evidence.key}`;
  // The `SYNTHESIZED_REVALIDATION_PENDING_MARKER` prefix is added ONLY for
  // synthesized evidence (`evidence.source === "synthesized"`) — it is the
  // stable, server-owned discriminant `decideSynthesizedRevalidation` uses
  // to find this connector instance's revalidation cooldown anchor in
  // `history`. Durable evidence's `error` stays byte-identical to before
  // (still starts with `attention_unresolved:`) since durable evidence is
  // never eligible for revalidation and must keep blocking unconditionally.
  const prefix = evidence.source === "synthesized" ? `${SYNTHESIZED_REVALIDATION_PENDING_MARKER}:` : "";
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `${prefix}attention_unresolved${tail}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildNeedsHumanSkip(connectorId: string, connectorInstanceId?: string): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: "needs_human_attention: automatic run skipped until owner provides input",
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildNotReadySkip(connectorId: string, reason: string, connectorInstanceId?: string): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `not_ready: ${reason}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildAutomationPolicySkip(
  connectorId: string,
  reason: string | null,
  connectorInstanceId?: string
): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `automation_policy_blocked: ${reason || "automatic run is not allowed by connector policy"}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface PreRunGate {
  decideDisabledGrant: (connectorId: string, connectorInstanceId: string) => "proceed" | "silent-skip" | RunRecord;
  decideNotReady: (schedule: ConnectorSchedule) => Promise<"proceed" | "silent-skip" | RunRecord>;
  gateAttention: (connectorId: string, connectorInstanceId: string, key: string) => Promise<AttentionGateOutcome>;
  gateAutomationPolicy: (
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    policy: ReturnType<typeof projectRunAutomationPolicy>
  ) => GateOutcome;
  gateGrantState: (
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: NonNullable<ConnectorSchedule["grantAccessMode"]>
  ) => GateOutcome;
  gateNeedsHuman: (connectorId: string, connectorInstanceId: string, key: string) => GateOutcome;
  maybeSkipSingleUseExhausted: (
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: GrantAccessMode
  ) => RunRecord | null;
  probeUnresolvedAttention: (
    connectorId: string,
    connectorInstanceId: string
  ) => Promise<UnresolvedAttentionEvidence | null>;
  runAutomaticPreflight: (
    schedule: ConnectorSchedule,
    key: string,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>
  ) => Promise<AttentionGateOutcome>;
}

export function createPreRunGate(deps: PreRunGateDeps): PreRunGate {
  const {
    hasUnresolvedAttention,
    isNeedsHuman,
    onHumanRequiredStateEscalation,
    readinessChecker,
    runtime,
    recordAndNotify,
    synthesizedRevalidationOptions = {},
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
      deploymentReadiness: {
        ready: false,
        reason: readiness.reason || "scheduled connector runtime prerequisites are not currently satisfied",
      },
      refreshPolicy: getManifestRefreshPolicy(schedule.manifest),
      triggerKind: "scheduled",
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

  async function gateAttention(
    connectorId: string,
    connectorInstanceId: string,
    key: string
  ): Promise<AttentionGateOutcome> {
    const attentionEvidence = await probeUnresolvedAttention(connectorId, connectorInstanceId);
    if (!attentionEvidence?.key) {
      runtime.notifiedAttentionSkips.delete(key);
      return "proceed";
    }

    // Durable evidence (real ASSISTANCE/INTERACTION protocol records, their
    // own lifecycle/expiry) blocks unconditionally, byte-identical to before
    // this fix: never revalidated by the scheduler, only by the record's own
    // lifecycle resolving or expiring.
    if (attentionEvidence.source === "durable") {
      if (runtime.notifiedAttentionSkips.get(key) === attentionEvidence.key) {
        return null;
      }
      runtime.notifiedAttentionSkips.set(key, attentionEvidence.key);
      return recordAndNotify(buildUnresolvedAttentionSkip(connectorId, attentionEvidence, connectorInstanceId));
    }

    // Synthesized evidence: re-derived fresh from the last terminal run's
    // reason every probe, no expiry of its own. Eligible for a bounded,
    // non-interactive confirming run once `decideSynthesizedRevalidation`
    // says it is due — computed from durable `history`, so this MUST be
    // evaluated every tick (not short-circuited by a dedup return below), or
    // a due revalidation would never be observed.
    const connectorHistory = runtime.history.filter(
      (record) => (record.connectorInstanceId || record.connectorId) === key
    );
    const revalidation = decideSynthesizedRevalidation(connectorHistory, Date.now(), synthesizedRevalidationOptions);
    if (revalidation.admit) {
      return "proceed-revalidation-only";
    }
    // Dedup by whether a revalidation-pending ANCHOR already exists in
    // history for this connector instance — NOT by `attentionEvidence.key`
    // (which embeds `reason` and can churn on every probe, e.g. alternating
    // session_required/session_expired). Once a pending-skip record already
    // exists, this connector instance already has its cooldown anchor and
    // must not accumulate a fresh skip on every reason change — that would
    // corrupt the cadence math into reading "now" as the anchor on every
    // tick, defeating the doubling backoff under reason churn (the exact
    // shape of the P1 the rejected v1 attempt failed on, there via a
    // different mechanism — an in-memory Map keyed by the full evidence key).
    const alreadyAnchored = connectorHistory.some((record) =>
      (record.error ?? "").startsWith(SYNTHESIZED_REVALIDATION_PENDING_MARKER)
    );
    if (alreadyAnchored) {
      return null;
    }
    return recordAndNotify(buildUnresolvedAttentionSkip(connectorId, attentionEvidence, connectorInstanceId));
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
  ): Promise<AttentionGateOutcome> {
    const { connectorId, connectorInstanceId = connectorId } = schedule;

    const attention = await gateAttention(connectorId, connectorInstanceId, key);
    if (attention === "proceed-revalidation-only") {
      // The bounded confirming run bypasses the ordinary automation-policy /
      // readiness / needs-human gates below: those decide whether an
      // ORDINARY scheduled run should proceed, and may themselves be
      // derived from the same stale state the probe exists to re-verify.
      // The probe is narrow and bounded by construction (noninteractive,
      // cadence-limited) — it does not need those additional gates.
      return attention;
    }
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
    decideDisabledGrant,
    decideNotReady,
    gateAttention,
    gateAutomationPolicy,
    gateGrantState,
    gateNeedsHuman,
    maybeSkipSingleUseExhausted,
    probeUnresolvedAttention,
    runAutomaticPreflight,
  };
}

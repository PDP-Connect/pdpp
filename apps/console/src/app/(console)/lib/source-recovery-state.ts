// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed owner-facing recovery state, derived PURELY from evidence the connection
 * summary already carries on the wire: the server-owned `RefRenderedVerdict` and
 * the `RefConnectionHealthSnapshot` (state, badges, `next_attempt_at`, and the
 * `detail_gap_backlog` rollup). This module reads no clock and performs no I/O;
 * the same inputs always produce the same state.
 *
 * It is the console-side answer to `reference-connection-health`:
 *   - "Owner projection SHALL represent recovery state explicitly"
 *   - "Checking SHALL be time-bounded and evidence-backed"
 *   - "Source actionability groups SHALL route recovery states without vague taxonomy"
 *   - "Owner source detail SHALL expose recovery evidence progressively"
 *   - "Stalled recovery SHALL surface as a system condition"
 *
 * It does NOT introduce a second state machine over the verdict. The rendered
 * verdict remains the sole owner of tone/channel/required-actions; this module
 * only names the recovery *kind* implied by the verdict plus the durable backlog
 * rollup, so the shared actionability grouping and the source-detail recovery
 * panel can route and explain it without re-deriving mechanistic evidence per
 * surface (the drift the owner flagged as "hard to distinguish").
 *
 * Every count surfaced here honours the backlog honesty contract: a bounded read
 * is a floor ("at least N"), a `null` backlog is unmeasured (never a fabricated
 * zero), and terminal gaps are never folded into "caught up".
 */

import type {
  RefConnectionHealthSnapshot,
  RefDetailGapBacklog,
  RefRenderedVerdict,
  RefRequiredAction,
} from "./ref-client.ts";

// Inlined to keep this module free of a cycle with `source-actionability.ts`
// (which imports the recovery derivation). These mirror the shared predicates.
function primaryRequiredAction(verdict: RefRenderedVerdict | null | undefined): RefRequiredAction | null {
  return verdict?.required_actions[0] ?? null;
}

function isOwnerSatisfiableAction(action: RefRequiredAction | null | undefined): action is RefRequiredAction {
  return Boolean(action && action.audience === "owner" && action.satisfied_when.kind !== "none");
}

/**
 * The typed recovery step an owner surface renders. Each maps to exactly one
 * owner-action group (see {@link recoveryStateGroup}) and one product sentence.
 *
 *   - `active`         : a run or durable work item is in flight — recovery is
 *                        happening now. Named work ("Syncing order details"),
 *                        never a bare "Checking".
 *   - `queued`         : recoverable work remains and the system will attempt it
 *                        on cadence. Passive progress; no owner action.
 *   - `cooling`        : a provider cooldown / retry floor gates the next attempt.
 *                        Passive progress with a resume time; no normal retry CTA.
 *   - `eligible`       : recoverable work the owner can safely accelerate now
 *                        (the verdict exposes an owner-satisfiable action).
 *   - `owner_required` : the owner is the sole resolver (reauth / add info).
 *   - `system_issue`   : a connector defect or terminal no-progress. No retry CTA.
 *   - `stalled`        : eligible/queued work with no attempt past the cadence
 *                        window — surfaced as a system condition, not passive
 *                        "catching up" forever.
 *   - `none`           : no recoverable work state applies.
 */
export type RecoveryStep =
  | "active"
  | "cooling"
  | "eligible"
  | "none"
  | "owner_required"
  | "queued"
  | "stalled"
  | "system_issue";

/**
 * The default cadence window an owner surface uses to arm the stall watchdog:
 * eligible/queued recovery work whose latest attempt floor is older than this,
 * with no active run and no live cooldown, is a detectable stall (design D8).
 *
 * Six hours is deliberately generous relative to normal recovery cadence — it
 * exists to catch silent queue rot (the live "51 stale pressure rows hold 942
 * gaps" class), not to flag a queue that is simply pacing itself. A surface that
 * has stronger cadence evidence MAY pass its own `cadenceWindowMs`; this is the
 * conservative default so the watchdog never cries wolf on a healthy queue.
 */
export const RECOVERY_STALL_CADENCE_MS = 6 * 60 * 60 * 1000;

/**
 * A concrete, bounded progress count for the recovery panel. `isFloor` carries
 * the backlog's floor semantics so a surface renders "at least N", never a
 * bounded read as exact.
 */
export interface RecoveryProgressCount {
  readonly isFloor: boolean;
  readonly value: number;
}

/**
 * Progress floor counts for the source-detail recovery panel. Each field is
 * `null` when the reference did not supply the evidence (unmeasured), never a
 * fabricated zero.
 */
export interface RecoveryProgress {
  /** Pending source-pressure detail items still queued. Floor when bounded. */
  readonly pending: RecoveryProgressCount | null;
  /** Pending non-source-pressure detail items (cap/budget deferred). */
  readonly pendingOther: RecoveryProgressCount | null;
  /** Recovered detail items, when a count-by-status aggregate was available. */
  readonly recovered: number | null;
  /** Permanently-unfillable items (§10-A). Never folded into "caught up". */
  readonly terminal: number | null;
}

/**
 * The source-detail recovery panel view-model. A PURE projection the detail page
 * renders verbatim. It answers, in order: what step is happening, how much
 * progress, when the next attempt is eligible, why work is not running now, and
 * what recent non-secret evidence supports the answer. It exposes NO credentials,
 * payloads, record content, provider URLs, or selectors.
 */
export interface RecoveryPanelViewModel {
  /**
   * Why work is not running now, when applicable: cooldown, budget, owner
   * repair, connector/system issue, or unmeasured coverage. `null` when work is
   * actively running or nothing blocks it.
   */
  readonly blocker: string | null;
  /** Bounded, non-secret evidence lines (last attempt floor, resume time, etc.). */
  readonly evidence: readonly string[];
  /** The next eligible attempt time (ISO-8601 from the backlog retry floor). */
  readonly nextEligibleAt: string | null;
  /** One-line owner-facing sentence for the current step. */
  readonly primarySentence: string;
  readonly progress: RecoveryProgress;
  readonly step: RecoveryStep;
}

/** Where {@link RecoveryStep} routes in the shared source-actionability grouping. */
export type RecoveryGroupRouting = "needsOwner" | "notMeasured" | "review" | "systemIssue" | "working";

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function progressCount(value: number, isFloor: boolean | null | undefined): RecoveryProgressCount | null {
  const count = positiveInt(value);
  if (count === 0) {
    return null;
  }
  return { isFloor: Boolean(isFloor), value: count };
}

/**
 * True when the connection has durable recoverable detail work the recovery
 * governor owns — pending source-pressure gaps, cap/budget-deferred gaps, or a
 * live retry floor. A `null` backlog is unmeasured (not recoverable-work
 * evidence); a fully drained backlog with only terminal/recovered counts is not
 * outstanding recoverable work.
 */
export function hasRecoverableWork(backlog: RefDetailGapBacklog | null | undefined): boolean {
  if (!backlog) {
    return false;
  }
  return positiveInt(backlog.pending) > 0 || positiveInt(backlog.pending_other) > 0 || Boolean(backlog.next_attempt_at);
}

/**
 * The evidence the step derivation reads. Kept as a small explicit record so the
 * derivation is trivially testable without constructing a whole verdict.
 */
interface RecoveryEvidence {
  readonly backlog: RefDetailGapBacklog | null;
  readonly cooling: boolean;
  readonly eligibleOwnerAction: boolean;
  readonly nextAttemptAt: string | null;
  readonly ownerRequired: boolean;
  readonly recoverableWork: boolean;
  readonly syncing: boolean;
  readonly systemIssue: boolean;
}

function readEvidence(
  verdict: RefRenderedVerdict | null | undefined,
  health: RefConnectionHealthSnapshot | null | undefined
): RecoveryEvidence {
  const backlog = health?.detail_gap_backlog ?? null;
  const primary = primaryRequiredAction(verdict);
  const ownerSatisfiable = isOwnerSatisfiableAction(primary);
  // The verdict's channel already encodes owner-sole-resolution: an `attention`
  // channel with an owner-satisfiable action is a needs-you condition; a
  // non-attention owner-satisfiable action is an optional accelerant.
  const ownerRequired = verdict?.channel === "attention" && ownerSatisfiable;
  const eligibleOwnerAction = ownerSatisfiable && !ownerRequired;
  // A connector defect / terminal no-progress. `code_fix` (maintainer) primary
  // action or a red terminal verdict with no owner path is a system issue.
  const systemIssue =
    primary?.kind === "code_fix" ||
    // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime value, TS type is optimistic
    (verdict?.pill.tone === "red" && !ownerSatisfiable && verdict.channel !== "attention");
  const backlogFloor = backlog?.next_attempt_at ?? null;
  const nextAttemptAt = backlogFloor ?? health?.next_attempt_at ?? null;
  return {
    backlog,
    cooling: health?.state === "cooling_off" || Boolean(backlogFloor),
    eligibleOwnerAction,
    nextAttemptAt,
    ownerRequired,
    recoverableWork: hasRecoverableWork(backlog),
    // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime value, TS type is optimistic
    syncing: Boolean(health?.badges.syncing),
    systemIssue: Boolean(systemIssue),
  };
}

/**
 * Derive the typed recovery step. Precedence is owner-first (a needs-you or
 * system issue never hides behind passive progress), then active work, then the
 * cadence/cooldown states, then eligibility.
 *
 * `now` and `cadenceWindowMs`, when supplied, enable the stall watchdog: eligible
 * or queued work whose latest attempt floor is older than the cadence window with
 * no active run is a system condition (`stalled`), not passive progress. When
 * `now` is omitted the derivation is time-free and never reports `stalled`.
 */
export function deriveRecoveryStep(
  verdict: RefRenderedVerdict | null | undefined,
  health: RefConnectionHealthSnapshot | null | undefined,
  options: { readonly cadenceWindowMs?: number; readonly now?: string | null } = {}
): RecoveryStep {
  const evidence = readEvidence(verdict, health);

  // Owner-sole-resolution and connector defect win over any passive-progress
  // reading: a needs-you account or a broken connector must never render as
  // "catching up".
  if (evidence.ownerRequired) {
    return "owner_required";
  }
  if (evidence.systemIssue) {
    return "system_issue";
  }

  // An in-flight run is active recovery — named work, never a bare "Checking".
  if (evidence.syncing && evidence.recoverableWork) {
    return "active";
  }

  if (!evidence.recoverableWork) {
    return "none";
  }

  // Stall watchdog: eligible/queued work with no fresh attempt beyond the cadence
  // window and no active run is a system condition, not endless passive progress.
  if (isStalled(evidence, options)) {
    return "stalled";
  }

  // A provider cooldown / retry floor gates the next attempt.
  if (evidence.cooling) {
    return "cooling";
  }

  // Owner can safely accelerate eligible work now.
  if (evidence.eligibleOwnerAction) {
    return "eligible";
  }

  // Recoverable work the system will attempt on cadence.
  return "queued";
}

function isStalled(
  evidence: RecoveryEvidence,
  options: { readonly cadenceWindowMs?: number; readonly now?: string | null }
): boolean {
  const { now, cadenceWindowMs } = options;
  if (evidence.syncing || !now || !cadenceWindowMs || cadenceWindowMs <= 0) {
    return false;
  }
  // The backlog retry floor is the most recent authored attempt boundary. When
  // it is in the PAST by more than the cadence window and nothing is running,
  // eligible work has stopped receiving attempts — a detectable stall. A future
  // floor is a live cooldown, not a stall.
  const floor = evidence.backlog?.next_attempt_at ?? null;
  if (!floor) {
    return false;
  }
  const floorMs = Date.parse(floor);
  const nowMs = Date.parse(now);
  if (!(Number.isFinite(floorMs) && Number.isFinite(nowMs))) {
    return false;
  }
  return nowMs - floorMs > cadenceWindowMs;
}

const STEP_GROUP: Record<RecoveryStep, RecoveryGroupRouting | null> = {
  active: "working",
  cooling: "working",
  eligible: "review",
  none: null,
  owner_required: "needsOwner",
  queued: "working",
  stalled: "systemIssue",
  system_issue: "systemIssue",
};

/**
 * Route a recovery step to its shared source-actionability group. `null` means
 * the step contributes no recovery-specific routing (the connector's other
 * verdict evidence decides the group). Queued and cooling recovery are passive
 * progress ("PDPP is working"); eligible recovery is owner-runnable; connector
 * defects and stalls are system issues.
 */
export function recoveryStateGroup(step: RecoveryStep): RecoveryGroupRouting | null {
  return STEP_GROUP[step];
}

function progressFrom(backlog: RefDetailGapBacklog | null): RecoveryProgress {
  if (!backlog) {
    return { pending: null, pendingOther: null, recovered: null, terminal: null };
  }
  return {
    pending: progressCount(backlog.pending, backlog.pending_is_floor),
    pendingOther: progressCount(backlog.pending_other ?? 0, backlog.pending_other_is_floor),
    recovered: typeof backlog.recovered === "number" && backlog.recovered >= 0 ? Math.floor(backlog.recovered) : null,
    terminal: positiveInt(backlog.terminal) > 0 ? positiveInt(backlog.terminal) : null,
  };
}

function countPhrase(count: RecoveryProgressCount, noun: string): string {
  const plural = count.value === 1 ? noun : `${noun}s`;
  return count.isFloor
    ? `at least ${count.value.toLocaleString()} ${plural}`
    : `${count.value.toLocaleString()} ${plural}`;
}

function progressEvidence(progress: RecoveryProgress): string[] {
  const lines: string[] = [];
  if (progress.recovered !== null && progress.recovered > 0) {
    lines.push(`${progress.recovered.toLocaleString()} recovered`);
  }
  if (progress.pending) {
    lines.push(`${countPhrase(progress.pending, "item")} still queued`);
  }
  if (progress.pendingOther) {
    lines.push(`${countPhrase(progress.pendingOther, "other item")} deferred`);
  }
  if (progress.terminal !== null && progress.terminal > 0) {
    lines.push(`${progress.terminal.toLocaleString()} no longer retrievable at the source`);
  }
  return lines;
}

const PRIMARY_SENTENCE: Record<RecoveryStep, string> = {
  active: "Syncing details now.",
  cooling: "Waiting until it is safe to retry details.",
  eligible: "Recoverable details are ready for another run.",
  none: "No recovery work is queued.",
  owner_required: "Waiting on you before recovery can continue.",
  queued: "Catching up details when it is safe to retry.",
  stalled: "Recovery has stopped making progress and needs a look.",
  system_issue: "This connector needs a fix before it can recover this.",
};

/**
 * Build the source-detail recovery panel view-model. Pure — it reads only the
 * verdict, the health snapshot, and the caller-supplied observation instant.
 * When `now`/`cadenceWindowMs` are supplied it will surface a `stalled` step.
 */
export function buildRecoveryPanelViewModel(
  verdict: RefRenderedVerdict | null | undefined,
  health: RefConnectionHealthSnapshot | null | undefined,
  options: { readonly cadenceWindowMs?: number; readonly now?: string | null } = {}
): RecoveryPanelViewModel {
  const step = deriveRecoveryStep(verdict, health, options);
  const backlog = health?.detail_gap_backlog ?? null;
  const progress = progressFrom(backlog);
  const nextEligibleAt = backlog?.next_attempt_at ?? health?.next_attempt_at ?? null;

  const evidence = progressEvidence(progress);
  if (nextEligibleAt && (step === "cooling" || step === "queued")) {
    evidence.push(`Next eligible retry ${nextEligibleAt}`);
  }

  return {
    blocker: blockerFor(step, nextEligibleAt),
    evidence,
    nextEligibleAt: step === "active" ? null : nextEligibleAt,
    primarySentence: PRIMARY_SENTENCE[step],
    progress,
    step,
  };
}

function blockerFor(step: RecoveryStep, nextEligibleAt: string | null): string | null {
  switch (step) {
    case "cooling":
      return nextEligibleAt
        ? `Provider cooldown — next eligible retry ${nextEligibleAt}.`
        : "Provider cooldown is active.";
    case "owner_required":
      return "Owner action is required before recovery can continue.";
    case "system_issue":
      return "A connector or system issue is blocking recovery.";
    case "stalled":
      return "Eligible recovery work has received no attempt within the expected window.";
    case "queued":
      return "Waiting for the next recovery attempt on cadence.";
    default:
      return null;
  }
}

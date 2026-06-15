import type { ConnectionHealthCondition, ConnectionHealthSnapshot } from "./connection-health.ts";
import type { RenderedVerdict, RequiredAction, SatisfactionContract } from "./rendered-verdict.ts";

export interface SatisfactionRunEvidence {
  readonly failure_reason?: string | null;
  readonly status?: string | null;
}

export interface SatisfactionScheduleEvidence {
  readonly enabled?: boolean | null;
  readonly next_run_at?: string | null;
}

export interface SatisfactionCredentialEvidence {
  readonly present?: boolean | null;
  readonly rejected?: boolean | null;
  readonly status?: string | null;
}

export interface SatisfactionStreamEvidence {
  readonly coverage?: string | null;
  readonly stream_id?: string | null;
}

/**
 * The durable evidence bag the controller-side watcher reads. Every field is a
 * projection input that the connection-health/verdict path already knows about;
 * this helper deliberately does not fetch provider state or inspect UI state.
 */
export interface SatisfactionEvidenceBag {
  readonly backfillWindowCovered?: boolean | null;
  readonly conditions?: ConnectionHealthSnapshot["conditions"];
  readonly credential?: SatisfactionCredentialEvidence | null;
  readonly detailGapBacklog?: ConnectionHealthSnapshot["detail_gap_backlog"];
  readonly lastRun?: SatisfactionRunEvidence | null;
  readonly schedule?: SatisfactionScheduleEvidence | null;
  readonly streams?: readonly SatisfactionStreamEvidence[];
}

function credentialIsPresentAndUnrejected(credential: SatisfactionCredentialEvidence | null | undefined): boolean {
  if (!credential) {
    return false;
  }
  if (credential.present !== true) {
    return false;
  }
  if (credential.rejected === true) {
    return false;
  }
  return credential.status === undefined || credential.status === null || credential.status === "active";
}

function conditionIsOpenOwnerAttention(condition: ConnectionHealthCondition): boolean {
  return (
    condition.current === true &&
    condition.sensitivity === "owner" &&
    condition.status !== "true" &&
    condition.severity !== "info"
  );
}

function attentionResolved(conditions: ConnectionHealthSnapshot["conditions"] | undefined): boolean {
  return !(conditions ?? []).some(conditionIsOpenOwnerAttention);
}

function runSucceeded(run: SatisfactionRunEvidence | null | undefined): boolean {
  return run?.status === "succeeded" || run?.status === "completed" || run?.status === "success";
}

function scheduleAttachedAndEnabled(schedule: SatisfactionScheduleEvidence | null | undefined): boolean {
  return schedule?.enabled === true;
}

function isRecoveredCoverage(coverage: string | null | undefined): boolean {
  return coverage === "complete" || coverage === "accepted_absence" || coverage === "optional";
}

function affectedStreamsRecovered(
  action: RequiredAction,
  streams: readonly SatisfactionStreamEvidence[] | undefined
): boolean | null {
  if (action.affects.length === 0 || !streams || streams.length === 0) {
    return null;
  }
  const byId = new Map(streams.map((stream) => [stream.stream_id ?? "", stream.coverage ?? null]));
  return action.affects.every((streamId) => isRecoveredCoverage(byId.get(streamId)));
}

function gapRecovered(action: RequiredAction, evidence: SatisfactionEvidenceBag): boolean {
  const streamRecovery = affectedStreamsRecovered(action, evidence.streams);
  if (streamRecovery !== null) {
    return streamRecovery;
  }
  const backlog = evidence.detailGapBacklog;
  return backlog !== null && backlog !== undefined && backlog.pending === 0;
}

function backfillWindowCovered(action: RequiredAction, evidence: SatisfactionEvidenceBag): boolean {
  if (evidence.backfillWindowCovered === true) {
    return true;
  }
  const streamRecovery = affectedStreamsRecovered(action, evidence.streams);
  return streamRecovery === true;
}

export function evaluateSatisfactionContract(action: RequiredAction, evidence: SatisfactionEvidenceBag): boolean {
  const contract: SatisfactionContract = action.satisfied_when;
  switch (contract.kind) {
    case "attention_resolved":
      return attentionResolved(evidence.conditions);
    case "backfill_window_covered":
      return backfillWindowCovered(action, evidence);
    case "confirming_run_succeeded":
      return runSucceeded(evidence.lastRun);
    case "credential_present_and_unrejected":
      return credentialIsPresentAndUnrejected(evidence.credential);
    case "gap_recovered":
      return gapRecovered(action, evidence);
    case "none":
      return true;
    case "schedule_attached_and_enabled":
      return scheduleAttachedAndEnabled(evidence.schedule);
  }
}

function isActionArray(value: RenderedVerdict | readonly RequiredAction[]): value is readonly RequiredAction[] {
  return Array.isArray(value);
}

export function satisfiedActions(
  verdictOrActions: RenderedVerdict | readonly RequiredAction[],
  evidence: SatisfactionEvidenceBag
): RequiredAction[] {
  const actions = isActionArray(verdictOrActions) ? verdictOrActions : verdictOrActions.required_actions;
  return actions.filter((action) => evaluateSatisfactionContract(action, evidence));
}

export function ownerSatisfiableActions(actions: readonly RequiredAction[]): RequiredAction[] {
  return actions.filter(
    (action) => action.audience === "owner" && action.satisfied_when.kind !== "none" && action.terminal !== true
  );
}

export function satisfiedOwnerActions(
  verdictOrActions: RenderedVerdict | readonly RequiredAction[],
  evidence: SatisfactionEvidenceBag
): RequiredAction[] {
  return ownerSatisfiableActions(satisfiedActions(verdictOrActions, evidence));
}

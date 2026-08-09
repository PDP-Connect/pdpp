// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Human labels for the raw internal enum strings this page otherwise renders
 * verbatim (`blocked · provide_value · response_required`, `staged` /
 * `advanced` / `commit_failed`, snake_case stat-row field names). Same
 * discipline as `describeRecentSyncOutcome` in `syncs-model.ts`: an exhaustive
 * switch that throws on an unhandled value rather than silently leaking a raw
 * string through a default case.
 */

import type {
  AssistanceOwnerAction,
  AssistanceProgressPosture,
  AssistanceResponseContract,
} from "../../lib/run-assistance.ts";
import type { TerminalRunStatus } from "./run-terminal-status.ts";

export function describeAssistanceProgressPosture(posture: AssistanceProgressPosture): string {
  switch (posture) {
    case "blocked":
      return "Blocked";
    case "running":
      return "Running";
    case "waiting_retry":
      return "Waiting to retry";
    default: {
      const _exhaustive: never = posture;
      throw new Error(`Unhandled assistance progress posture ${_exhaustive}`);
    }
  }
}

export function describeAssistanceOwnerAction(action: AssistanceOwnerAction): string {
  switch (action) {
    case "provide_value":
      return "Needs a value from you";
    case "operate_attachment":
      return "Needs you to complete a step";
    case "act_elsewhere":
      return "Approve outside this dashboard";
    case "none":
      return "No action needed";
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled assistance owner action ${_exhaustive}`);
    }
  }
}

export function describeAssistanceResponseContract(contract: AssistanceResponseContract): string {
  switch (contract) {
    case "response_required":
      return "Response required";
    case "none":
      return "No response required";
    default: {
      const _exhaustive: never = contract;
      throw new Error(`Unhandled assistance response contract ${_exhaustive}`);
    }
  }
}

/**
 * Human label for a terminal run status, as rendered in the run-state
 * `MetaPill`. `getRunStateValue` already writes its own English for the
 * active-run branches ("running", "awaiting input", "waiting retry"); only
 * the terminal-status pass-through (`terminalStatus` verbatim) needs
 * humanizing — `succeeded_with_gaps` is the raw enum value the audit called
 * out landing straight in the page header.
 */
export function describeTerminalRunStatus(status: NonNullable<TerminalRunStatus>): string {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "succeeded_with_gaps":
      return "succeeded with gaps";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "deferred":
      return "deferred";
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled terminal run status ${_exhaustive}`);
    }
  }
}

const CHECKPOINT_STAT_LABELS: Record<string, string> = {
  advanced: "Advanced",
  commit_failed: "Failed to commit",
  staged: "Staged",
};

export function describeCheckpointStatLabel(key: string): string {
  return CHECKPOINT_STAT_LABELS[key] ?? key;
}

const PROGRESS_STAT_LABELS: Record<string, string> = {
  last_count: "Last count",
  last_message: "Last message",
  last_total: "Last total",
  reports: "Reports",
  // One `run.stream_skipped` event per SKIP_RESULT, and a connector may emit
  // one per dropped record — so this counts items, not streams. Say which.
  skipped: "Skipped items",
};

export function describeProgressStatLabel(key: string): string {
  return PROGRESS_STAT_LABELS[key] ?? key;
}

const INTERACTION_STAT_LABELS: Record<string, string> = {
  completed: "Completed",
  required: "Required",
};

export function describeInteractionStatLabel(key: string): string {
  return INTERACTION_STAT_LABELS[key] ?? key;
}

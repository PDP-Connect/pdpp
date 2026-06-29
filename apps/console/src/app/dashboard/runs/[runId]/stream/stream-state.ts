import type { RunHandleStatus, TimelineEnvelope } from "../../../lib/ref-client.ts";

export type NoAssistanceStreamState = "ended" | "resolved" | "running";

export function selectNoAssistanceStreamState({
  runHandleStatus,
  terminalStatus,
}: {
  runHandleStatus?: RunHandleStatus | null;
  terminalStatus: TimelineEnvelope["terminal_status"];
}): NoAssistanceStreamState {
  if (terminalStatus === "completed") {
    return "resolved";
  }
  if (terminalStatus === "failed" || terminalStatus === "cancelled" || terminalStatus === "abandoned") {
    return "ended";
  }
  if (runHandleStatus === "completed") {
    return "resolved";
  }
  if (
    runHandleStatus === "failed" ||
    runHandleStatus === "cancelled" ||
    runHandleStatus === "abandoned" ||
    runHandleStatus === "deferred" ||
    runHandleStatus === "expired" ||
    runHandleStatus === "released" ||
    runHandleStatus === "surface_failed"
  ) {
    return "ended";
  }
  return "running";
}

export function resolveNoAssistanceEndedTerminalStatus({
  runHandleStatus,
  terminalStatus,
}: {
  runHandleStatus?: RunHandleStatus | null;
  terminalStatus: TimelineEnvelope["terminal_status"];
}): TimelineEnvelope["terminal_status"] {
  if (terminalStatus === "cancelled" || terminalStatus === "abandoned" || terminalStatus === "failed") {
    return terminalStatus;
  }
  if (runHandleStatus === "cancelled") {
    return "cancelled";
  }
  if (runHandleStatus === "abandoned") {
    return "abandoned";
  }
  return "failed";
}

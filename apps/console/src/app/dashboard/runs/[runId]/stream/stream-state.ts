import type { TimelineEnvelope } from "../../../lib/ref-client.ts";

export type NoAssistanceStreamState = "ended" | "resolved" | "running";

export function selectNoAssistanceStreamState(
  terminalStatus: TimelineEnvelope["terminal_status"]
): NoAssistanceStreamState {
  if (terminalStatus === "completed") {
    return "resolved";
  }
  if (terminalStatus === "failed" || terminalStatus === "cancelled" || terminalStatus === "abandoned") {
    return "ended";
  }
  return "running";
}

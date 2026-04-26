/**
 * Pure helper: detect `host_browser_bridge_unavailable` in a run.failed event.
 *
 * Wire path (verified against reference-implementation/runtime/index.js):
 *   HostBrowserBridgeUnavailableError
 *     → TerminalError("[host_browser_bridge_unavailable] <msg>", false)
 *     → connector DONE { status:"failed", error:{ message:"[code] ...", retryable:false } }
 *     → run.failed data {
 *         reason: "connector_reported_failed",          ← never contains the code
 *         connector_error_message: "[code] ...",        ← PRIMARY: always present
 *         connector_error_retryable: false,
 *       }
 *
 * data.reason is always "connector_reported_failed" for connector-reported
 * failures; the stable code only appears in connector_error_message. We also
 * check reason/failure_reason as fallbacks (e.g. if a future runtime path
 * writes the code there directly) and any connector_error_code/code field.
 */

import type { SpineEvent } from "../../lib/ref-client.ts";

export const HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE = "host_browser_bridge_unavailable";

export interface BridgeUnavailableInfo {
  cause: string;
  url: string | null;
}

// WS URL pattern used by hostBrowserBridgeUnavailableMessage:
//   "Host browser bridge unavailable at ws://...: ..."
const WS_URL_RE = /\b(wss?:\/\/[^\s:,]+(?::\d+)?)/i;

/**
 * Returns true when any of the run.failed data fields carries the stable
 * `host_browser_bridge_unavailable` error code.
 *
 * Exported as a pure function so it can be unit-tested independently of React.
 */
export function hasBridgeUnavailableCode(data: Record<string, unknown>): boolean {
  const candidates = [
    data.connector_error_message,
    data.reason,
    data.failure_reason,
    data.connector_error_code,
    data.code,
  ];
  return candidates.some((v) => typeof v === "string" && v.includes(HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE));
}

/**
 * Extract bridge-unavailable info from a run.failed SpineEvent, or return null
 * if the event does not represent this failure class.
 */
export function extractBridgeUnavailable(failure: SpineEvent | undefined): BridgeUnavailableInfo | null {
  if (!failure) {
    return null;
  }
  const data = failure.data ?? {};
  if (!hasBridgeUnavailableCode(data)) {
    return null;
  }
  // Use connector_error_message as the primary cause string since it contains
  // the full human-readable message. Fall back to reason for older shapes.
  const cause = String(
    data.connector_error_message ?? data.reason ?? data.failure_reason ?? HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE
  );
  // Try to extract the WS URL from the message for display.
  const urlMatch = WS_URL_RE.exec(cause);
  const url = urlMatch?.[1] ?? (typeof data.bridge_url === "string" ? data.bridge_url : null);
  return { cause, url };
}

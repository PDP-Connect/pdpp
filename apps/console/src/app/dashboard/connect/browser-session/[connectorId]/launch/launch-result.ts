export interface BrowserSessionRunStartResult {
  readonly browser_surface?: {
    readonly browser_surface_status?: string | null;
    readonly browser_surface_wait_reason?: string | null;
  } | null;
  readonly run_id?: string | null;
  readonly status?: string | null;
}

export type BrowserSessionLaunchResult =
  | {
      readonly href: string;
      readonly ok: true;
      readonly run_id: string;
    }
  | {
      readonly message: string;
      readonly ok: false;
      readonly status: number;
      readonly run_status?: string;
    };

function messageForNotStartedRun(result: BrowserSessionRunStartResult): string {
  const status = result.status ?? result.browser_surface?.browser_surface_status ?? "not_started";
  const waitReason = result.browser_surface?.browser_surface_wait_reason;

  if (status === "waiting_for_browser_surface" || status === "deferred" || status === "run_browser_surface_queued") {
    return waitReason
      ? `The secure browser is busy (${waitReason}). Try again in a moment.`
      : "The secure browser is busy. Try again in a moment.";
  }

  if (status === "surface_failed" || status === "browser_surface_probe_failed" || status === "browser_surface_lost") {
    return (
      "PDPP could not get the secure browser ready. " +
      "Try again; if it keeps failing, open Runs to inspect the latest browser-start attempt."
    );
  }

  return `The secure browser did not start (${status}). Try again, or open Runs to inspect the latest attempt.`;
}

export function classifyBrowserSessionLaunchResult(result: BrowserSessionRunStartResult): BrowserSessionLaunchResult {
  const runId = result.run_id?.trim() ?? "";
  if (!runId) {
    return {
      message: "PDPP tried to start the browser session, but no run id was returned.",
      ok: false,
      status: 502,
    };
  }

  if (result.status && result.status !== "started") {
    return {
      message: messageForNotStartedRun(result),
      ok: false,
      run_status: result.status,
      status:
        result.status === "waiting_for_browser_surface" || result.status === "run_browser_surface_queued" ? 409 : 503,
    };
  }

  return {
    href: `/dashboard/runs/${encodeURIComponent(runId)}/stream`,
    ok: true,
    run_id: runId,
  };
}

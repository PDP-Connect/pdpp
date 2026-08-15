// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RunNowOptions } from "../../../lib/operator-runs.ts";

export interface StaticSecretCaptureStartResult {
  auto_resume?: {
    confirming_run: { run_id?: string } | null;
    status?: string | null;
  } | null;
}

export type StartConnectionRun = (
  connectionId: string,
  options?: Pick<RunNowOptions, "runAdmission">
) => Promise<unknown>;

export class FirstSyncStartError extends Error {
  readonly code: "auto_resume_unconfirmed" | "run_start_failed" | "run_start_unconfirmed";

  constructor(code: FirstSyncStartError["code"], options?: ErrorOptions) {
    super(code, options);
    this.name = "FirstSyncStartError";
    this.code = code;
  }
}

function autoResumeRunId(capture: StaticSecretCaptureStartResult): string | null {
  const runId = capture.auto_resume?.confirming_run?.run_id;
  return typeof runId === "string" && runId.trim().length > 0 ? runId : null;
}

/**
 * Capture completion must always produce a run identifier. A blocked
 * auto-resume is retried through the connection control route; an unconfirmed
 * or failed start becomes a terminal action error instead of a pending status
 * page with no run to observe.
 */
export async function runIdAfterCapture(
  connectionId: string,
  capture: StaticSecretCaptureStartResult,
  startRun: StartConnectionRun
): Promise<string> {
  const autoRunId = autoResumeRunId(capture);
  if (autoRunId) {
    return autoRunId;
  }

  const autoResumeStatus = capture.auto_resume?.status;
  if (
    autoResumeStatus !== undefined &&
    autoResumeStatus !== null &&
    autoResumeStatus !== "no_satisfied_action" &&
    autoResumeStatus !== "blocked"
  ) {
    throw new FirstSyncStartError("auto_resume_unconfirmed");
  }

  let started: unknown;
  try {
    started = await startRun(connectionId, { runAdmission: "setup" });
  } catch (error) {
    throw new FirstSyncStartError("run_start_failed", { cause: error });
  }
  const runId =
    typeof started === "object" && started !== null && "run_id" in started && typeof started.run_id === "string"
      ? started.run_id.trim()
      : "";
  if (!runId) {
    throw new FirstSyncStartError("run_start_unconfirmed");
  }
  return runId;
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describeError } from "./describe-error.ts";

/**
 * Pure mapping for `POST /_ref/runs/:runId/cancel` responses, factored out of
 * `operator-runs.ts` so it can be unit tested directly under `node --test`
 * without pulling in the server-only fetch helpers (`owner-token.ts` imports
 * `server-only`, which throws outside the React Server runtime).
 *
 * The reference cancel route (shipped with `add-owner-run-cancellation-control`)
 * has three documented outcomes; everything else is an error:
 *   - `202` → `cancel_requested`
 *   - `404 no_active_run` → `no_active_run`
 *   - `409 run_already_terminal` → `run_already_terminal`
 */
export type CancelRunOutcome = "cancel_requested" | "no_active_run" | "run_already_terminal";

export interface CancelRunResult {
  status: CancelRunOutcome;
}

/** Extract the reference error envelope's `error.code`, if present. */
export function cancelRunErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const { error } = (body as { error?: unknown });
  if (!error || typeof error !== "object") {
    return null;
  }
  const { code } = (error as { code?: unknown });
  return typeof code === "string" ? code : null;
}

/**
 * Map a cancel response `(status, body, errorCode)` to a typed outcome, or
 * throw a described error for any status that is not one of the three
 * documented cancellation outcomes.
 */
export function classifyCancelRunResponse(status: number, body: unknown, errorCode: string | null): CancelRunResult {
  if (status === 202) {
    return { status: "cancel_requested" };
  }
  if (status === 404 && errorCode === "no_active_run") {
    return { status: "no_active_run" };
  }
  if (status === 409 && errorCode === "run_already_terminal") {
    return { status: "run_already_terminal" };
  }
  throw new Error(describeError(body, `run cancel failed (${status})`));
}

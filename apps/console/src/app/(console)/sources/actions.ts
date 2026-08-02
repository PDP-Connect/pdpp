"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { runConnectionNow, runConnectorNow } from "../lib/operator-runs.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  RUN_NOW_ALREADY_ACTIVE_MESSAGE,
  RUN_NOW_UNEXPECTED_MESSAGE,
  RUN_NOW_UNREACHABLE_MESSAGE,
  RunNowRequestError,
  runNowFailureMessage,
} from "../lib/run-now-result.ts";

/**
 * Where a failed run-start stopped.
 *
 * - `before_server`: the request never reached the reference server (DNS /
 *   connection failure). The run definitely did not start; a plain retry is
 *   safe and the deployment may be down.
 * - `after_server`: the reference server responded with an error. The run
 *   probably did not start, but the failure is the server's, not the network's
 *   — the typed status/code carries the safe reason.
 *
 * The dashboard renders different copy per phase so the owner knows whether to
 * check their deployment (before) or act on the typed server result (after),
 * instead of a single opaque "error".
 */
export type RunStartFailurePhase = "before_server" | "after_server";

export type RunNowResult =
  | { ok: true; run_id: string; trace_id: string }
  | { ok: false; reason: "already_running"; run_id?: string; message: string }
  | {
      ok: false;
      reason: "error";
      phase: RunStartFailurePhase;
      reached_server: boolean;
      status?: number;
      code?: string;
      message: string;
    };

interface RunConnectorNowOptions {
  force?: boolean;
}

/** Server action: start a connector run. Designed to never throw — the UI
 *  uses the discriminated-union return to render a toast/badge.
 *
 *  Crucially, this preserves connection context (the caller still holds the
 *  connector/connection id and its row) and reports *whether the request
 *  reached the server*. A run-start failure must surface as a row-local toast,
 *  never fall through to the dashboard route error boundary. */
export async function runConnectorNowAction(
  connectorId: string,
  connectionId?: string | null,
  options: RunConnectorNowOptions = {}
): Promise<RunNowResult> {
  try {
    const runOptions = { force: options.force === true };
    const body = (await (connectionId
      ? runConnectionNow(connectionId, runOptions)
      : runConnectorNow(connectorId, runOptions))) as {
      run_id?: string;
      trace_id?: string;
    };
    revalidatePath("/sources");
    revalidatePath(`/sources/${encodeURIComponent(connectionId ?? connectorId)}`);
    return {
      ok: true,
      run_id: body.run_id ?? "",
      trace_id: body.trace_id ?? body.run_id ?? "",
    };
  } catch (err) {
    // Transport failure: the fetch never completed, so the reference server
    // never saw the request. Report it as such (the run was not started) and
    // give a deployment-status / retry hint instead of a raw network string.
    if (err instanceof ReferenceServerUnreachableError) {
      return {
        message: RUN_NOW_UNREACHABLE_MESSAGE,
        ok: false,
        phase: "before_server",
        reached_server: false,
        reason: "error",
      };
    }
    if (err instanceof RunNowRequestError && err.status === 409 && err.code === "run_already_active") {
      return {
        message: RUN_NOW_ALREADY_ACTIVE_MESSAGE,
        ok: false,
        reason: "already_running",
        ...(err.runId ? { run_id: err.runId } : {}),
      };
    }
    if (err instanceof RunNowRequestError) {
      return {
        code: err.code ?? undefined,
        message: runNowFailureMessage(err),
        ok: false,
        phase: "after_server",
        reached_server: true,
        reason: "error",
        status: err.status,
      };
    }
    return {
      message: RUN_NOW_UNEXPECTED_MESSAGE,
      ok: false,
      phase: "after_server",
      reached_server: true,
      reason: "error",
    };
  }
}

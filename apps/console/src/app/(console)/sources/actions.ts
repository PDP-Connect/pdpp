// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use server";

import { revalidatePath } from "next/cache";
import { runConnectionNow, runConnectorNow } from "../lib/operator-runs.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";

/**
 * Where a failed run-start stopped.
 *
 * - `before_server`: the request never reached the reference server (DNS /
 *   connection failure). The run definitely did not start; a plain retry is
 *   safe and the deployment may be down.
 * - `after_server`: the reference server responded with an error. The run
 *   probably did not start, but the failure is the server's, not the network's
 *   — the message carries the server's own reason.
 *
 * The dashboard renders different copy per phase so the owner knows whether to
 * check their deployment (before) or read the server's reason (after), instead
 * of a single opaque "error".
 */
export type RunStartFailurePhase = "before_server" | "after_server";

export type RunNowResult =
  | { ok: true; run_id: string; trace_id: string }
  | { ok: false; reason: "already_running"; run_id?: string; message: string }
  | { ok: false; reason: "error"; phase: RunStartFailurePhase; reached_server: boolean; message: string };

interface RunConnectorNowOptions {
  force?: boolean;
}

const ALREADY_ACTIVE_RE = /already.*active/i;
const RUN_ALREADY_ACTIVE_RE = /run_already_active/i;
const RUN_ID_MATCH_RE = /\brun[_:][A-Za-z0-9]+/;

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
        ok: false,
        reason: "error",
        phase: "before_server",
        reached_server: false,
        message:
          "Couldn't reach the reference server, so the sync was not started. Check the deployment is running, then retry.",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    // The controller's 409 surfaces as a thrown Error with message like
    // "Connector already has an active run: run_123…".
    if (ALREADY_ACTIVE_RE.test(message) || RUN_ALREADY_ACTIVE_RE.test(message)) {
      const match = message.match(RUN_ID_MATCH_RE);
      return {
        ok: false,
        reason: "already_running",
        run_id: match?.[0],
        message: "Sync already in progress.",
      };
    }
    // Everything after the transport-failure branch came from the reference
    // server. Keep the server envelope text and mark it separately from a
    // before-server failure so the row can stay local and tell the owner where
    // the failure occurred.
    return { ok: false, reason: "error", phase: "after_server", reached_server: true, message };
  }
}

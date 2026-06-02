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
  | { ok: false; reason: "error"; phase: RunStartFailurePhase; message: string };

const ALREADY_ACTIVE_RE = /already.*active/i;
const RUN_ALREADY_ACTIVE_RE = /run_already_active/i;
const RUN_ID_MATCH_RE = /run[_:]?([A-Za-z0-9]+)/;

/** Server action: start a connector run. Designed to never throw — the UI
 *  uses the discriminated-union return to render a toast/badge.
 *
 *  Crucially, this preserves connection context (the caller still holds the
 *  connector/connection id and its row) and reports *whether the request
 *  reached the server*. A run-start failure must surface as a row-local toast,
 *  never fall through to the dashboard route error boundary. */
export async function runConnectorNowAction(connectorId: string, connectionId?: string | null): Promise<RunNowResult> {
  try {
    const body = (await (connectionId ? runConnectionNow(connectionId) : runConnectorNow(connectorId))) as {
      run_id?: string;
      trace_id?: string;
    };
    revalidatePath("/dashboard/records");
    revalidatePath(`/dashboard/records/${encodeURIComponent(connectionId ?? connectorId)}`);
    return {
      ok: true,
      run_id: body.run_id ?? "",
      trace_id: body.trace_id ?? body.run_id ?? "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The controller's 409 surfaces as a thrown Error with message like
    // "Connector already has an active run: run_123…".
    if (ALREADY_ACTIVE_RE.test(message) || RUN_ALREADY_ACTIVE_RE.test(message)) {
      const match = message.match(RUN_ID_MATCH_RE);
      return {
        ok: false,
        reason: "already_running",
        run_id: match?.[1],
        message: "Sync already in progress.",
      };
    }
    // A connection failure to the AS is thrown as ReferenceServerUnreachableError
    // by `fetchAs`; everything else is a server-origin error (HTTP non-2xx whose
    // envelope message we already extracted). Distinguishing the two lets the row
    // tell the owner whether to check the deployment or read the server's reason.
    const phase: RunStartFailurePhase =
      err instanceof ReferenceServerUnreachableError ? "before_server" : "after_server";
    return { ok: false, reason: "error", phase, message };
  }
}

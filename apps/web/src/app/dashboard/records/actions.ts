"use server";

import { revalidatePath } from "next/cache";
import { runConnectorNow } from "../lib/operator-runs.ts";

export type RunNowResult =
  | { ok: true; run_id: string; trace_id: string }
  | { ok: false; reason: "already_running"; run_id?: string; message: string }
  | { ok: false; reason: "error"; message: string };

/** Server action: start a connector run. Designed to never throw — the UI
 *  uses the discriminated-union return to render a toast/badge. */
export async function runConnectorNowAction(connectorId: string): Promise<RunNowResult> {
  try {
    const body = (await runConnectorNow(connectorId)) as {
      run_id?: string;
      trace_id?: string;
    };
    revalidatePath("/dashboard/records");
    revalidatePath(`/dashboard/records/${encodeURIComponent(connectorId)}`);
    return {
      ok: true,
      run_id: body.run_id ?? "",
      trace_id: body.trace_id ?? body.run_id ?? "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The controller's 409 surfaces as a thrown Error with message like
    // "Connector already has an active run: run_123…".
    if (/already.*active/i.test(message) || /run_already_active/i.test(message)) {
      const match = message.match(/run[_:]?([A-Za-z0-9]+)/);
      return {
        ok: false,
        reason: "already_running",
        run_id: match?.[1],
        message: "Sync already in progress.",
      };
    }
    return { ok: false, reason: "error", message };
  }
}

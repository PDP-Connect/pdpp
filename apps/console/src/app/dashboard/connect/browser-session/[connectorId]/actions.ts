"use server";

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../lib/operator-runs.ts";
import { abandonBrowserEnrollmentShell, createBrowserEnrollmentShell } from "../../../lib/ref-client.ts";

const CONNECT_PATH = "/dashboard/connect";

function errorHref(connectorId: string, message: string): string {
  return `/dashboard/connect/browser-session/${encodeURIComponent(connectorId)}?error=${encodeURIComponent(message)}`;
}

/** Start a run against an existing connection (repair mode). */
async function runRepair(connectorId: string, connectionId: string): Promise<never> {
  let runId: string;
  try {
    const result = (await runConnectionNow(connectionId)) as { run_id?: string };
    runId = result.run_id ?? "";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start enrollment run";
    redirect(errorHref(connectorId, message));
  }
  if (!runId) {
    redirect(errorHref(connectorId, "Run started but no run_id returned"));
  }
  redirect(`/dashboard/runs/${encodeURIComponent(runId)}/stream`);
}

/** Create a new enrollment shell and start a run (setup mode). */
async function runSetup(connectorId: string): Promise<never> {
  let connectionId: string;
  try {
    const shell = await createBrowserEnrollmentShell(connectorId);
    connectionId = shell.connection_id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create enrollment shell";
    redirect(errorHref(connectorId, message));
  }

  let runId: string;
  try {
    const result = (await runConnectionNow(connectionId)) as { run_id?: string };
    runId = result.run_id ?? "";
  } catch (err) {
    // Try to abandon the shell so it doesn't sit as an orphaned draft.
    try {
      await abandonBrowserEnrollmentShell(connectionId);
    } catch {
      // Best effort; TTL retirement will clean it up.
    }
    const message = err instanceof Error ? err.message : "Failed to start enrollment run";
    redirect(errorHref(connectorId, message));
  }

  if (!runId) {
    redirect(errorHref(connectorId, "Run started but no run_id returned"));
  }
  redirect(`/dashboard/runs/${encodeURIComponent(runId)}/stream`);
}

/**
 * Create a browser-enrollment shell for the given browser-bound connector and
 * immediately start a bounded enrollment run for it. Redirects to the run's
 * stream page so the owner sees the embedded neko browser surface.
 *
 * This is the server-action counterpart to the browser-session connect page's
 * "Start session" button. Two steps in one action so the owner sees the stream
 * page immediately without a second round-trip.
 *
 * Repair mode: if `connectionId` is provided the shell creation step is
 * skipped and the run starts against the existing connection (Plaid update-mode
 * equivalent). The existing connection_id, history, records, and schedule are
 * all preserved.
 */
export async function startBrowserEnrollmentAction(formData: FormData): Promise<void> {
  const connectorId = String(formData.get("connector_id") ?? "").trim();
  const existingConnectionId = String(formData.get("connection_id") ?? "").trim() || null;

  if (!connectorId) {
    redirect(`${CONNECT_PATH}?error=${encodeURIComponent("connector_id is required")}`);
  }

  await requireDashboardAccess(`/dashboard/connect/browser-session/${encodeURIComponent(connectorId)}`);

  if (existingConnectionId) {
    await runRepair(connectorId, existingConnectionId);
  } else {
    await runSetup(connectorId);
  }
}

import { NextResponse } from "next/server";
import { isBrowserBoundConnector } from "../../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../../lib/operator-runs.ts";
import { abandonBrowserEnrollmentShell, createBrowserEnrollmentShell } from "../../../../lib/ref-client.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  connectorId: string;
}

function pagePath(connectorId: string): string {
  return `/dashboard/connect/browser-session/${encodeURIComponent(connectorId)}`;
}

function errorPath(connectorId: string, message: string): string {
  return `${pagePath(connectorId)}?error=${encodeURIComponent(message)}`;
}

function redirectTo(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), 303);
}

async function startRepair(connectionId: string): Promise<string> {
  const result = (await runConnectionNow(connectionId)) as { run_id?: string };
  const runId = result.run_id ?? "";
  if (!runId) {
    throw new Error("Run started but no run_id returned");
  }
  return runId;
}

async function startSetup(connectorId: string): Promise<string> {
  const shell = await createBrowserEnrollmentShell(connectorId);
  try {
    return await startRepair(shell.connection_id);
  } catch (err) {
    try {
      await abandonBrowserEnrollmentShell(shell.connection_id);
    } catch {
      // Best effort; TTL retirement will clean up any orphaned draft.
    }
    throw err;
  }
}

export async function POST(request: Request, { params }: { params: Promise<RouteParams> }): Promise<NextResponse> {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  await requireDashboardAccess(pagePath(connectorId));

  if (!isBrowserBoundConnector(connectorId)) {
    return redirectTo(
      request,
      `/dashboard/records/add?error=${encodeURIComponent("This source does not use browser setup.")}`
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    formData = new FormData();
  }

  const existingConnectionId = String(formData.get("connection_id") ?? "").trim();

  try {
    const runId = existingConnectionId ? await startRepair(existingConnectionId) : await startSetup(connectorId);
    return redirectTo(request, `/dashboard/runs/${encodeURIComponent(runId)}/stream`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start browser session";
    return redirectTo(request, errorPath(connectorId, message));
  }
}

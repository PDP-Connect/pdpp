import { NextResponse } from "next/server";
import { isBrowserBoundConnector } from "../../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../../lib/dashboard-access.ts";
import { createBrowserEnrollmentShell } from "../../../../lib/ref-client.ts";

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

function originMatchesHost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  const host = request.headers.get("host");
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readOptionalStringField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function createSetupShell(connectorId: string): Promise<string> {
  const shell = await createBrowserEnrollmentShell(connectorId);
  return shell.connection_id;
}

export async function POST(request: Request, { params }: { params: Promise<RouteParams> }): Promise<NextResponse> {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  await requireDashboardAccess(pagePath(connectorId));

  if (!originMatchesHost(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

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

  let existingConnectionId: string | null;
  try {
    existingConnectionId = readOptionalStringField(formData, "connection_id");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid browser-session form";
    return redirectTo(request, errorPath(connectorId, message));
  }

  try {
    const connectionId = existingConnectionId ?? (await createSetupShell(connectorId));
    const params = new URLSearchParams({
      connection_id: connectionId,
      draft: existingConnectionId ? "0" : "1",
    });
    return redirectTo(request, `${pagePath(connectorId)}/launch?${params.toString()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start browser session";
    return redirectTo(request, errorPath(connectorId, message));
  }
}
